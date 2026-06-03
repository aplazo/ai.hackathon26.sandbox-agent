#!/usr/bin/env bash
# Bootstrap SandboxAgent secrets into AWS Secrets Manager.
#
# One-time migration off the single-laptop `/tmp/sandboxagent-*.txt` files.
# After this runs, `deploy-direct.sh` (and CI) read secrets from Secrets Manager
# instead of /tmp, removing the bus-factor + unblocking GitHub Actions.
#
# Idempotent: re-runs update the secret value in place (create if absent).
#
# Usage:
#   ./bootstrap-secrets.sh                       # read values from /tmp files
#   BACKEND_TOKEN=... ANTHROPIC_API_KEY=... ./bootstrap-secrets.sh   # explicit
#
# Env: PROFILE (default hackathon-poc), REGION (default us-east-1)

set -euo pipefail

PROFILE="${PROFILE:-hackathon-poc}"
REGION="${REGION:-us-east-1}"

SECRET_BACKEND_TOKEN="sandboxagent/backend-token"
SECRET_ANTHROPIC_KEY="sandboxagent/anthropic-key"

# Mandatory 6 tags. NOTE: unlike the per-sandbox infra (which the reaper deletes
# via expires=), these secrets are long-lived — so we set a FUTURE expires so the
# reaper never eats our credentials. (This is the stale-tag bug fixed for secrets;
# deploy-direct.sh / tags.js still carry the old past-dated defaults — see backlog.)
OWNER="${SECRET_OWNER:-argel.bejarano@aplazo.mx}"
EXPIRES="${SECRET_EXPIRES:-2026-12-31}"
SQUAD="${SECRET_SQUAD:-developer-experience}"
TAGS="Key=project,Value=sandboxagent Key=team,Value=sandboxagent Key=squad,Value=${SQUAD} Key=owner,Value=${OWNER} Key=expires,Value=${EXPIRES} Key=environment,Value=hackathon26"

aw() { if [[ -n "$PROFILE" ]]; then aws --profile "$PROFILE" --region "$REGION" "$@"; else aws --region "$REGION" "$@"; fi; }
log() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()  { printf '   \033[1;32m✓\033[0m %s\n' "$*"; }
fail(){ printf '   \033[1;31m✗\033[0m %s\n' "$*"; exit 1; }

# Resolve a secret value: explicit env var wins, else the legacy /tmp file.
resolve() {
  local env_name="$1" tmp_path="$2"
  local val="${!env_name:-}"
  if [[ -n "$val" ]]; then printf '%s' "$val"; return; fi
  if [[ -f "$tmp_path" ]]; then cat "$tmp_path"; return; fi
  printf ''
}

put_secret() {
  local id="$1" value="$2" desc="$3"
  if [[ -z "$value" ]]; then
    fail "no value for $id (set the env var or provide the /tmp file)"
  fi
  if aw secretsmanager describe-secret --secret-id "$id" >/dev/null 2>&1; then
    aw secretsmanager put-secret-value --secret-id "$id" --secret-string "$value" --output json >/dev/null
    ok "updated $id"
  else
    aw secretsmanager create-secret \
      --name "$id" \
      --description "$desc" \
      --secret-string "$value" \
      --tags $TAGS \
      --output json >/dev/null
    ok "created $id"
  fi
}

log "Bootstrapping secrets into Secrets Manager ($REGION)"

BACKEND_TOKEN_VAL="$(resolve BACKEND_TOKEN /tmp/sandboxagent-backend-token.txt)"
ANTHROPIC_KEY_VAL="$(resolve ANTHROPIC_API_KEY /tmp/sandboxagent-anthropic-key.txt)"

put_secret "$SECRET_BACKEND_TOKEN" "$BACKEND_TOKEN_VAL" "SandboxAgent backend Bearer token (all Lambdas)"
put_secret "$SECRET_ANTHROPIC_KEY" "$ANTHROPIC_KEY_VAL" "Anthropic API key (fetch_config Lambda)"

log "Done"
echo
echo "  Secrets:"
echo "    $SECRET_BACKEND_TOKEN"
echo "    $SECRET_ANTHROPIC_KEY"
echo
echo "Next:"
echo "  1. Re-run ./deploy-direct.sh — it now sources these from Secrets Manager."
echo "  2. Once verified, delete the legacy files:"
echo "       rm -f /tmp/sandboxagent-backend-token.txt /tmp/sandboxagent-anthropic-key.txt"
echo "  3. To rotate: re-run with a new value, then re-run deploy-direct.sh."
