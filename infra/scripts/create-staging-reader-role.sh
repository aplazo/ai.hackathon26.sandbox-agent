#!/usr/bin/env bash
# Create the read-only role in the MAIN aplazo account (159200192518) that the
# SandboxAgent Lambdas (running in the POC account, us-east-1) assume to discover
# snapshots / ECR repos / task definitions.
#
# Run this once, from a profile with IAM write access in the main account.
#
# Usage:
#   ./create-staging-reader-role.sh <POC_ACCOUNT_ID> <POC_LAMBDA_ROLE_ARN_1> [POC_LAMBDA_ROLE_ARN_2 ...]
#
# Per Duvan's guidance (#hackathon-support-2026): Francisco already has read
# permissions in main; this is the cleanest way to grant the *Lambdas* the
# same read access without baking long-lived credentials anywhere.

set -euo pipefail

ROLE_NAME="sandboxagent-staging-reader"
PROFILE="${AWS_PROFILE:-aplazo-main}"

POC_ACCOUNT_ID="${1:-}"
shift || true
POC_LAMBDA_ROLES=("$@")

if [[ -z "$POC_ACCOUNT_ID" || ${#POC_LAMBDA_ROLES[@]} -eq 0 ]]; then
  echo "Usage: $0 <POC_ACCOUNT_ID> <POC_LAMBDA_ROLE_ARN_1> [POC_LAMBDA_ROLE_ARN_2 ...]"
  echo "       (POC lambda role ARNs come from the SAM stack outputs ResolveSnapshotRoleArn + DeployEcsRoleArn)"
  exit 1
fi

# Trust policy: the named POC Lambda roles can sts:AssumeRole into this one.
TRUST_POLICY=$(jq -n --argjson principals "$(printf '%s\n' "${POC_LAMBDA_ROLES[@]}" | jq -R . | jq -s .)" '{
  Version: "2012-10-17",
  Statement: [{
    Effect: "Allow",
    Principal: { AWS: $principals },
    Action: "sts:AssumeRole"
  }]
}')

# Read-only policy: enough to list snapshots, share them, describe ECR and ECS.
READ_POLICY=$(cat <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "rds:DescribeDBSnapshots",
        "rds:DescribeDBInstances",
        "rds:ModifyDBSnapshotAttribute",
        "rds:DescribeDBSnapshotAttributes"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:DescribeRepositories",
        "ecr:DescribeImages",
        "ecr:ListImages",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "ecr:GetAuthorizationToken"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeClusters",
        "ecs:ListServices",
        "ecs:DescribeServices",
        "ecs:DescribeTaskDefinition",
        "ecs:ListTaskDefinitions"
      ],
      "Resource": "*"
    }
  ]
}
JSON
)

if aws iam get-role --role-name "$ROLE_NAME" --profile "$PROFILE" >/dev/null 2>&1; then
  echo "→ Updating trust policy on existing role $ROLE_NAME"
  aws iam update-assume-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-document "$TRUST_POLICY" \
    --profile "$PROFILE"
else
  echo "→ Creating role $ROLE_NAME"
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "SandboxAgent cross-account read access for POC Lambdas" \
    --tags Key=project,Value=sandboxagent Key=team,Value=sandboxagent \
           Key=squad,Value=developer-experience Key=expires,Value=2026-05-30 \
           Key=environment,Value=hackathon26 \
    --profile "$PROFILE"
fi

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name sandboxagent-read \
  --policy-document "$READ_POLICY" \
  --profile "$PROFILE"

ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text --profile "$PROFILE")

echo
echo "✓ Role ready."
echo "  ARN: $ROLE_ARN"
echo
echo "Next: pass this ARN as StagingReaderRoleArn in your samconfig.toml and re-deploy."
