# SandboxAgent Infra (AWS SAM)

Stack target: **POC account, us-east-1** (the only region we can write to per Duvan @ DevOps).
Source-of-truth state lives in the **main aplazo account `159200192518`, region `us-west-1`** — RDS snapshots, ECR images, ECS task definitions. We read those cross-account via STS `AssumeRole`.

## Account / region map

```
┌──────────────────────────────────────────────┐
│ Main account 159200192518 — us-west-1        │   ← read-only (Francisco already has it)
│ • RDS staging snapshots                      │
│ • ECR repos (aplazo/stg-*)                   │
│ • ECS task definitions                       │
│ • Secrets Manager (DB creds)                 │
└────────────┬─────────────────────────────────┘
             │ sts:AssumeRole(staging-reader)
             │ rds:CopyDBSnapshot(SourceRegion=us-west-1)
             ▼
┌──────────────────────────────────────────────┐
│ POC account — us-east-1                      │   ← we write here only
│ • SandboxAgent SAM stack                     │
│ • Sandbox RDS instances                      │
│ • Sandbox ECS clusters + Fargate services    │
│ • DynamoDB sandboxagent-sessions             │
└──────────────────────────────────────────────┘
```

> Pulumi for the real services: [`github.com/aplazo/node.pulumi-infrastructure`](https://github.com/aplazo/node.pulumi-infrastructure) — this is the source of truth for service configs, env vars, CPU/memory, ECR URLs, mandatory tags.

## Prereqs

- AWS CLI v2 + SAM CLI installed (`brew install aws-sam-cli`)
- SSO into POC: `aws sso login --profile hackathon-poc`
- SSO into main account for the one-time reader-role setup: `aws sso login --profile aplazo-main`
- Node.js 24+

## One-time: create the staging reader role (main account)

This is the cross-account bridge. Run it once from a profile that has IAM write access in the main account.

```bash
cd infra

# Step 1: deploy SAM in mock mode first (gets us the Lambda role ARNs)
cp samconfig.toml.example samconfig.toml      # edit BackendToken (openssl rand -hex 32) and PocAccountId
sam build
sam deploy --profile hackathon-poc            # MockMode=true → no AWS reads, deploy completes clean

# Step 2: read the role ARNs from the stack outputs
sam list stack-outputs --stack-name sandboxagent --profile hackathon-poc

# Step 3: create the reader role in MAIN account, trusting the POC Lambda roles
./scripts/create-staging-reader-role.sh \
  <POC_ACCOUNT_ID> \
  <ResolveSnapshotRoleArn from outputs> \
  <DeployEcsRoleArn from outputs>

# Step 4: put the resulting StagingReaderRoleArn back into samconfig.toml and re-deploy
sam deploy --profile hackathon-poc --parameter-overrides StagingReaderRoleArn=arn:aws:iam::159200192518:role/sandboxagent-staging-reader MockMode=false ...
```

## Mock vs. real mode

The `MockMode` parameter (default `true`) controls whether the Lambdas execute real AWS SDK calls.

| `MockMode` | Behavior                                                                                                                              |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------ |
| `true`     | Every Lambda returns realistic fixtures. Demo runs end-to-end in ~10s. No cross-account calls, no real provisioning.                  |
| `false`    | Real AWS SDK: `AssumeRole` into main, `CopyDBSnapshot` us-west-1 → us-east-1, `RestoreDBInstanceFromDBSnapshot`, `ECS CreateService`. |

Switch with:

```bash
sam deploy --parameter-overrides MockMode=false StagingReaderRoleArn=arn:... ...
```

## Parameters quick reference

| Parameter             | Default                              | Purpose                                                       |
| :-------------------- | :----------------------------------- | :------------------------------------------------------------ |
| MockMode              | `true`                               | Toggle real vs. mock                                          |
| BackendToken          | —                                    | Bearer token the HTML sends                                   |
| Owner                 | `francisco.lanuza@aplazo.mx`         | Mandatory POC tag                                             |
| ResourceExpires       | `2026-05-30`                         | Mandatory POC tag — DevOps reaper deletes after this date     |
| Squad                 | `developer-experience`               | Pulumi-convention mandatory tag                               |
| StagingReaderRoleArn  | `''`                                 | Role in main account the Lambdas assume                       |
| StagingRegion         | `us-west-1`                          | Where staging lives                                           |
| StagingDbNamePatterns | `aplazo-staging-clean,...`           | First match wins for snapshot lookup                          |
| EcrRepoPrefix         | `aplazo/stg-`                        | ECR repo prefix for staging images                            |
| StagingCluster        | `aplazo-stg-cluster`                 | ECS cluster we clone task definitions from                    |
| CoreServices          | `checkout-api,merchant-api,payment-engine` | Services to provision per sandbox                       |
| PocAccountId          | —                                    | POC account ID (used when sharing snapshots from main to POC) |
| SubnetIds             | `''`                                 | POC us-east-1 subnets for Fargate (real mode only)            |
| SecurityGroupIds      | `''`                                 | POC us-east-1 SGs                                             |
| TaskExecutionRoleArn  | `''`                                 | POC ecsTaskExecutionRole ARN                                  |
| TaskRoleArn           | `''`                                 | POC task role ARN                                             |

When `MockMode=false`, the POC-side networking params (`SubnetIds`, `SecurityGroupIds`, role ARNs) are required. Francisco can read these from the POC VPC himself — they're not DevOps-gated.

## Tags applied to everything

Per Pulumi convention + POC SCP:

```
project=sandboxagent
team=sandboxagent
squad=developer-experience      ← new (Pulumi mandatory tag)
owner=francisco.lanuza@aplazo.mx
expires=2026-05-30
environment=hackathon26
```

Ephemeral sandbox resources (RDS, ECS) get additional `sandbox-id`, `merchant`, `integration-type` tags from `backend/lambdas/shared/tags.js`.

## Cleanup

```bash
cd infra
sam delete --profile hackathon-poc
```

Ephemeral sandbox resources (RDS instances, ECS clusters) are not in this stack — they're created by the Lambdas at runtime. DevOps reaper handles them via the `expires=2026-05-30` tag.
