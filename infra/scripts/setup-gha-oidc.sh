#!/usr/bin/env bash
# One-time setup for GitHub Actions → AWS via OIDC (no long-lived keys in GitHub).
#
# Creates (idempotently):
#   1. The GitHub OIDC identity provider in IAM (if absent).
#   2. The `gha-sandboxagent-deploy` role that .github/workflows/deploy-agent.yml
#      assumes, trusting only this repo's `hackathon-poc` GitHub Environment.
#   3. The scoped inline permissions policy on that role.
#
# Run once from a profile with IAM write in the POC account.
# Usage: ./setup-gha-oidc.sh
# Env:   PROFILE (default hackathon-poc), REGION (default us-east-1)

set -euo pipefail

PROFILE="${PROFILE:-hackathon-poc}"
REGION="${REGION:-us-east-1}"
ACCOUNT_ID="${ACCOUNT_ID:-332730082760}"
ROLE_NAME="gha-sandboxagent-deploy"
PROVIDER_URL="token.actions.githubusercontent.com"
PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${PROVIDER_URL}"

INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRUST="$INFRA/policies/gha-deploy-trust-policy.json"
PERMS="$INFRA/policies/gha-deploy-permissions-policy.json"

aw() { if [[ -n "$PROFILE" ]]; then aws --profile "$PROFILE" --region "$REGION" "$@"; else aws --region "$REGION" "$@"; fi; }
log() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()  { printf '   \033[1;32m✓\033[0m %s\n' "$*"; }

# Mandatory 6 tags (future expires — this role is long-lived, not reaper-managed).
TAGS="Key=project,Value=sandboxagent Key=team,Value=sandboxagent Key=squad,Value=developer-experience Key=owner,Value=argel.bejarano@aplazo.mx Key=expires,Value=2026-12-31 Key=environment,Value=hackathon26"

log "1. GitHub OIDC provider"
if aw iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" >/dev/null 2>&1; then
  ok "provider exists"
else
  # IAM validates GitHub's cert against its own trust store for this host, so the
  # thumbprint is effectively ignored — but the API still requires the argument.
  aw iam create-open-id-connect-provider \
    --url "https://${PROVIDER_URL}" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "6938fd4d98bba010a4a73e8e2f9e6cef97bd0a5" \
    --output json >/dev/null
  ok "provider created"
fi

log "2. Deploy role $ROLE_NAME"
if aw iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aw iam update-assume-role-policy --role-name "$ROLE_NAME" \
    --policy-document "file://$TRUST" >/dev/null
  ok "role exists — trust policy refreshed"
else
  aw iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "file://$TRUST" \
    --description "GitHub Actions OIDC deploy role for SandboxAgent" \
    --max-session-duration 3600 \
    --tags $TAGS \
    --output json >/dev/null
  ok "role created"
fi

log "3. Permissions policy"
aw iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name "gha-sandboxagent-deploy-perms" \
  --policy-document "file://$PERMS" >/dev/null
ok "inline policy attached"

ROLE_ARN=$(aw iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
log "Done"
echo
echo "  Role ARN: $ROLE_ARN"
echo "  Set this as the workflow's role-to-assume (already wired in deploy-agent.yml)."
echo "  Create a GitHub Environment named 'hackathon-poc' with required reviewers."
