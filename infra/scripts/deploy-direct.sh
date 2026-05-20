#!/usr/bin/env bash
# Direct AWS CLI deploy for the Hackathon POC account.
#
# Replaces `sam deploy` because the POC SCP denies all S3 actions for our role,
# which breaks SAM's bootstrap (it needs an S3 bucket for artifact upload).
# This script uses Lambda's inline ZipFile (50MB limit) + APIGW v2 + DynamoDB
# direct APIs, all of which work without S3.
#
# Idempotent: re-runs update existing resources instead of failing.
#
# Usage: ./deploy-direct.sh
# Env:   PROFILE (default hackathon-poc), REGION (default us-east-1)

set -euo pipefail

PROFILE="${PROFILE:-hackathon-poc}"
REGION="${REGION:-us-east-1}"
ACCOUNT_ID="${ACCOUNT_ID:-332730082760}"
STACK_PREFIX="sandboxagent"
ROLE_NAME="${STACK_PREFIX}-lambda-role"
TABLE_NAME="${STACK_PREFIX}-sessions"
API_NAME="${STACK_PREFIX}-api"
STAGE_NAME="sandbox"

# Mandatory tags (SCP enforced at creation time for IAM resources)
OWNER="francisco.lanuza@aplazo.mx"
EXPIRES="2026-05-30"
SQUAD="developer-experience"
TAGS_IAM="Key=project,Value=sandboxagent Key=team,Value=sandboxagent Key=squad,Value=${SQUAD} Key=owner,Value=${OWNER} Key=expires,Value=${EXPIRES} Key=environment,Value=hackathon26"
TAGS_LAMBDA="project=sandboxagent,team=sandboxagent,squad=${SQUAD},owner=${OWNER},expires=${EXPIRES},environment=hackathon26"
TAGS_DDB="$TAGS_IAM"

# Environment variables for all Lambdas
BACKEND_TOKEN="${BACKEND_TOKEN:-$(cat /tmp/sandboxagent-backend-token.txt 2>/dev/null || true)}"
if [[ -z "$BACKEND_TOKEN" ]]; then
  echo "ERROR: BACKEND_TOKEN not set and /tmp/sandboxagent-backend-token.txt missing"
  exit 1
fi

MOCK_MODE="${MOCK_MODE:-true}"
MERCHANT_CREATION_URL="https://jwaakdci64.execute-api.us-west-1.amazonaws.com/merchant_creation"
BRANCH_URL="https://merchant.aplazo.net/merchant/create-branch"
APLAZO_API_BASE="https://api.aplazo.net"
STAGING_REGION="us-west-1"
SANDBOX_DOMAIN="aplazo.ai"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND="$PROJECT_ROOT/backend"
INFRA="$PROJECT_ROOT/infra"
WORK="/tmp/sandboxagent-deploy"
mkdir -p "$WORK"

log() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()  { printf '   \033[1;32m✓\033[0m %s\n' "$*"; }
warn(){ printf '   \033[1;33m!\033[0m %s\n' "$*"; }
fail(){ printf '   \033[1;31m✗\033[0m %s\n' "$*"; exit 1; }
aw()  { aws --profile "$PROFILE" --region "$REGION" "$@"; }

# -------------------------------------------------------------------------
# 1. IAM execution role for all Lambdas
# -------------------------------------------------------------------------
log "1. IAM role $ROLE_NAME"

if aw iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  ok "role exists (skipping create)"
else
  aw iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "file://$INFRA/policies/lambda-trust-policy.json" \
    --description "SandboxAgent Lambda execution role" \
    --tags $TAGS_IAM \
    --output json >/dev/null
  ok "created"
fi

aw iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "${STACK_PREFIX}-execution-policy" \
  --policy-document "file://$INFRA/policies/lambda-execution-policy.json" >/dev/null
ok "inline policy attached"

ROLE_ARN=$(aw iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
ok "ARN: $ROLE_ARN"

# Wait for role propagation (IAM eventual consistency)
log "Waiting 12s for IAM role propagation..."
sleep 12
ok "ready"

# -------------------------------------------------------------------------
# 2. DynamoDB sessions table
# -------------------------------------------------------------------------
log "2. DynamoDB table $TABLE_NAME"

if aw dynamodb describe-table --table-name "$TABLE_NAME" >/dev/null 2>&1; then
  ok "table exists (skipping create)"
else
  aw dynamodb create-table \
    --table-name "$TABLE_NAME" \
    --attribute-definitions AttributeName=sessionId,AttributeType=S \
    --key-schema AttributeName=sessionId,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --tags $TAGS_DDB \
    --output json >/dev/null
  ok "create requested, waiting for ACTIVE..."
  aw dynamodb wait table-exists --table-name "$TABLE_NAME"
  ok "active"
fi

# Enable TTL (idempotent — describe + conditional update)
TTL_STATUS=$(aw dynamodb describe-time-to-live --table-name "$TABLE_NAME" --query 'TimeToLiveDescription.TimeToLiveStatus' --output text 2>/dev/null || echo "DISABLED")
if [[ "$TTL_STATUS" != "ENABLED" ]]; then
  aw dynamodb update-time-to-live \
    --table-name "$TABLE_NAME" \
    --time-to-live-specification "Enabled=true, AttributeName=ttl" \
    --output json >/dev/null
  ok "TTL enabled on attribute 'ttl'"
else
  ok "TTL already enabled"
fi

# -------------------------------------------------------------------------
# 3. Package + deploy 7 Lambdas
# -------------------------------------------------------------------------
log "3. Packaging Lambdas"

# Single shared ZIP — code is small (no node_modules; nodejs24.x runtime ships @aws-sdk)
cd "$BACKEND"
ZIP="$WORK/lambdas.zip"
rm -f "$ZIP"
zip -qr "$ZIP" lambdas package.json -x "*/node_modules/*" "*.DS_Store"
SIZE=$(du -h "$ZIP" | cut -f1)
ok "zipped backend code: $SIZE"

LAMBDAS=(
  "resolve_snapshot_config:resolve-snapshot:30"
  "restore_rds_snapshot:restore-rds:900"
  "create_merchant:create-merchant:30"
  "deploy_ecs_services:deploy-ecs:900"
  "configure_merchant:configure-merchant:60"
  "validate_sandbox:validate-sandbox:30"
  "save_session:save-session:15"
)

# Common env vars
ENV_VARS="MOCK_MODE=${MOCK_MODE},BACKEND_TOKEN=${BACKEND_TOKEN},DEFAULT_OWNER=${OWNER},RESOURCE_EXPIRES=${EXPIRES},SQUAD=${SQUAD},SESSIONS_TABLE=${TABLE_NAME},STAGING_REGION=${STAGING_REGION},STAGING_DB_NAME_PATTERNS=aplazo-staging-clean,EcrRepoPrefix=aplazo/stg-,STAGING_CLUSTER=aplazo-stg-cluster,CORE_SERVICES=checkout-api,merchant-api,payment-engine,POC_ACCOUNT_ID=${ACCOUNT_ID},MERCHANT_CREATION_URL=${MERCHANT_CREATION_URL},BRANCH_URL=${BRANCH_URL},APLAZO_API_BASE=${APLAZO_API_BASE},SANDBOX_DOMAIN=${SANDBOX_DOMAIN}"
ENV_JSON='{"Variables":{"MOCK_MODE":"'"$MOCK_MODE"'","BACKEND_TOKEN":"'"$BACKEND_TOKEN"'","DEFAULT_OWNER":"'"$OWNER"'","RESOURCE_EXPIRES":"'"$EXPIRES"'","SQUAD":"'"$SQUAD"'","SESSIONS_TABLE":"'"$TABLE_NAME"'","STAGING_REGION":"'"$STAGING_REGION"'","STAGING_DB_NAME_PATTERNS":"aplazo-staging-clean","ECR_REPO_PREFIX":"aplazo/stg-","STAGING_CLUSTER":"aplazo-stg-cluster","CORE_SERVICES":"checkout-api,merchant-api,payment-engine","POC_ACCOUNT_ID":"'"$ACCOUNT_ID"'","MERCHANT_CREATION_URL":"'"$MERCHANT_CREATION_URL"'","BRANCH_URL":"'"$BRANCH_URL"'","APLAZO_API_BASE":"'"$APLAZO_API_BASE"'","SANDBOX_DOMAIN":"'"$SANDBOX_DOMAIN"'"}}'

for entry in "${LAMBDAS[@]}"; do
  IFS=':' read -r lambda route timeout <<<"$entry"
  fn_name="${STACK_PREFIX}-${lambda//_/-}"
  handler="lambdas/${lambda}/index.handler"

  log "Lambda: $fn_name"
  if aw lambda get-function --function-name "$fn_name" >/dev/null 2>&1; then
    aw lambda update-function-code \
      --function-name "$fn_name" \
      --zip-file "fileb://$ZIP" \
      --output json >/dev/null
    aw lambda wait function-updated --function-name "$fn_name"
    aw lambda update-function-configuration \
      --function-name "$fn_name" \
      --handler "$handler" \
      --timeout "$timeout" \
      --environment "$ENV_JSON" \
      --output json >/dev/null
    aw lambda wait function-updated --function-name "$fn_name"
    ok "updated"
  else
    aw lambda create-function \
      --function-name "$fn_name" \
      --runtime nodejs24.x \
      --role "$ROLE_ARN" \
      --handler "$handler" \
      --zip-file "fileb://$ZIP" \
      --architectures arm64 \
      --timeout "$timeout" \
      --memory-size 512 \
      --environment "$ENV_JSON" \
      --tags "$TAGS_LAMBDA" \
      --output json >/dev/null
    ok "created"
  fi
done

# -------------------------------------------------------------------------
# 4. HTTP API + integrations + routes
# -------------------------------------------------------------------------
log "4. HTTP API $API_NAME"

API_ID=$(aw apigatewayv2 get-apis --query "Items[?Name=='$API_NAME'].ApiId" --output text)
if [[ -z "$API_ID" || "$API_ID" == "None" ]]; then
  API_ID=$(aw apigatewayv2 create-api \
    --name "$API_NAME" \
    --protocol-type HTTP \
    --cors-configuration "AllowOrigins=*,AllowMethods=POST,OPTIONS,AllowHeaders=content-type,authorization" \
    --tags "project=sandboxagent,team=sandboxagent,squad=${SQUAD},owner=${OWNER},expires=${EXPIRES},environment=hackathon26" \
    --query 'ApiId' --output text)
  ok "created — ApiId: $API_ID"
else
  ok "exists — ApiId: $API_ID"
fi

# Ensure stage exists with auto-deploy
if aw apigatewayv2 get-stage --api-id "$API_ID" --stage-name "$STAGE_NAME" >/dev/null 2>&1; then
  ok "stage '$STAGE_NAME' exists"
else
  aw apigatewayv2 create-stage \
    --api-id "$API_ID" \
    --stage-name "$STAGE_NAME" \
    --auto-deploy \
    --output json >/dev/null
  ok "stage '$STAGE_NAME' created"
fi

# Create integration + route per Lambda (idempotent)
for entry in "${LAMBDAS[@]}"; do
  IFS=':' read -r lambda route timeout <<<"$entry"
  fn_name="${STACK_PREFIX}-${lambda//_/-}"
  fn_arn="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${fn_name}"
  route_key="POST /sandbox/${route}"

  # Look up or create integration
  integ_id=$(aw apigatewayv2 get-integrations --api-id "$API_ID" \
    --query "Items[?IntegrationUri=='$fn_arn'].IntegrationId | [0]" --output text)
  if [[ -z "$integ_id" || "$integ_id" == "None" ]]; then
    integ_id=$(aw apigatewayv2 create-integration \
      --api-id "$API_ID" \
      --integration-type AWS_PROXY \
      --integration-uri "$fn_arn" \
      --integration-method POST \
      --payload-format-version 2.0 \
      --query 'IntegrationId' --output text)
    ok "integration created for $fn_name"
  fi

  # Look up or create route
  route_id=$(aw apigatewayv2 get-routes --api-id "$API_ID" \
    --query "Items[?RouteKey=='$route_key'].RouteId | [0]" --output text)
  if [[ -z "$route_id" || "$route_id" == "None" ]]; then
    aw apigatewayv2 create-route \
      --api-id "$API_ID" \
      --route-key "$route_key" \
      --target "integrations/$integ_id" \
      --output json >/dev/null
    ok "route created: $route_key"
  fi

  # Grant invoke permission (idempotent — remove first, then add)
  aw lambda remove-permission --function-name "$fn_name" --statement-id apigw-invoke 2>/dev/null || true
  aw lambda add-permission \
    --function-name "$fn_name" \
    --statement-id apigw-invoke \
    --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/*/sandbox/${route}" \
    --output json >/dev/null
  ok "invoke permission set for $fn_name"
done

# -------------------------------------------------------------------------
# 5. Output
# -------------------------------------------------------------------------
API_URL="https://${API_ID}.execute-api.${REGION}.amazonaws.com/${STAGE_NAME}/sandbox"

log "Deploy complete"
echo
echo "  ApiBasePath:    $API_URL"
echo "  ApiId:          $API_ID"
echo "  BackendToken:   $BACKEND_TOKEN"
echo "  Role ARN:       $ROLE_ARN"
echo "  Sessions table: $TABLE_NAME"
echo
echo "Smoke test:"
echo "  curl -X POST '$API_URL/resolve-snapshot' \\"
echo "    -H 'Authorization: Bearer $BACKEND_TOKEN' \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"merchant_id\":\"walmart_mx\"}'"
echo
echo "Next: patch frontend CONFIG with ApiBasePath + BackendToken, then test locally."
