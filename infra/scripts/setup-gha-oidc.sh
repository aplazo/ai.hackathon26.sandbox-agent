#!/usr/bin/env bash
# One-time setup for GitHub Actions → AWS via OIDC (no long-lived keys in GitHub).
#
# Creates (idempotently):
#   1. The GitHub OIDC identity provider in IAM (if absent).
#   2. The `gha-sandboxagent-deploy` role that .github/workflows/deploy-agent.yml
#      assumes, trusting only this repo's `hackathon-poc` GitHub Environment.
#   3. The scoped inline permissions policy on that role.
#
# The policy JSONs are templates: `__ACCOUNT_ID__` is substituted at apply time
# with the caller's account (from STS) — no account ID is hardcoded in the repo.
#
# Run once from a profile with IAM write in the POC account.
# Usage: ./setup-gha-oidc.sh
# Env:   PROFILE (default hackathon-poc), REGION (default us-east-1),
#        ACCOUNT_ID (default: derived from STS)

set -euo pipefail

PROFILE="${PROFILE:-hackathon-poc}"
REGION="${REGION:-us-east-1}"
ROLE_NAME="gha-sandboxagent-deploy"
PROVIDER_URL="token.actions.githubusercontent.com"

INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRUST="$INFRA/policies/gha-deploy-trust-policy.json"
PERMS="$INFRA/policies/gha-deploy-permissions-policy.json"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Omit --profile when PROFILE is empty (CI/OIDC uses the default credential chain).
aw() { if [[ -n "$PROFILE" ]]; then aws --profile "$PROFILE" --region "$REGION" "$@"; else aws --region "$REGION" "$@"; fi; }
log() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()  { printf '   \033[1;32m✓\033[0m %s\n' "$*"; }

# Resolve the account ID from the caller — never hardcode it.
ACCOUNT_ID="${ACCOUNT_ID:-$(aw sts get-caller-identity --query Account --output text)}"
PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${PROVIDER_URL}"

# Render a policy template (substitute __ACCOUNT_ID__) into the temp dir.
render() { sed "s/__ACCOUNT_ID__/${ACCOUNT_ID}/g" "$1" > "$2"; }
render "$TRUST" "$WORK/trust.json"
render "$PERMS" "$WORK/perms.json"

# Mandatory 6 tags (future expires — this role is long-lived, not reaper-managed).
TAGS="Key=project,Value=sandboxagent Key=team,Value=sandboxagent Key=squad,Value=developer-experience Key=owner,Value=argel.bejarano@aplazo.mx Key=expires,Value=2026-12-31 Key=environment,Value=hackathon26"

log "Account $ACCOUNT_ID"

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
    --policy-document "file://$WORK/trust.json" >/dev/null
  ok "role exists — trust policy refreshed"
else
  aw iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "file://$WORK/trust.json" \
    --description "GitHub Actions OIDC deploy role for SandboxAgent" \
    --max-session-duration 3600 \
    --tags $TAGS \
    --output json >/dev/null
  ok "role created"
fi

log "3. Permissions policy"
aw iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name "gha-sandboxagent-deploy-perms" \
  --policy-document "file://$WORK/perms.json" >/dev/null
ok "inline policy attached"

ROLE_ARN=$(aw iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
log "Done"
echo
echo "  Role ARN: $ROLE_ARN"
echo "  Set this as a GitHub repo VARIABLE named AWS_DEPLOY_ROLE_ARN"
echo "  (Settings → Secrets and variables → Actions → Variables) — the workflow reads it."
echo "  Then create a GitHub Environment named 'hackathon-poc' with required reviewers."
