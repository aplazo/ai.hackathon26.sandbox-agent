# ai.hackathon26.sandbox-agent

**SandboxAgent — On-Demand Merchant Sandbox Configurator**
APLAZO Hackathon 2026 · Developer Experience & Internal Tooling track · PRD v1.6.

SandboxAgent provisions an isolated staging sandbox per merchant — own RDS instance, own ECS services, freshly-generated merchant credentials — from a single natural-language prompt, in under 20 minutes.

## Repo layout

```
.
├── frontend/
│   └── sandboxagent-demo-may2026.html   ← single-file UI + Anthropic ReAct loop
├── backend/
│   ├── package.json
│   └── lambdas/
│       ├── shared/                       ← auth, response, ids, mock-data, tags, aws (STS helper)
│       ├── resolve_snapshot_config/      ← cross-account discovery in main us-west-1
│       ├── restore_rds_snapshot/         ← CopyDBSnapshot us-west-1 → us-east-1, then restore
│       ├── create_merchant/              ← calls real us-west-1 Merchant Creation Lambda
│       ├── deploy_ecs_services/          ← clones task defs from staging, deploys in POC
│       ├── configure_merchant/
│       ├── validate_sandbox/
│       └── save_session/
├── infra/
│   ├── template.yaml                     ← AWS SAM (API GW + 7 Lambdas + DynamoDB)
│   ├── samconfig.toml.example
│   ├── scripts/
│   │   └── create-staging-reader-role.sh ← one-time cross-account setup
│   └── README.md
└── README.md
```

## Architecture (after Duvan's feedback)

```
Browser (sandboxagent-demo-may2026.html)
  ├── Anthropic API  (claude-sonnet-4-20250514, tool_use loop)
  └── fetch() → API Gateway (POC, us-east-1)
                    │
                    ▼
              7 Lambdas (Node.js 24, arm64)
                    │
   ┌────────────────┼─────────────────────────────────┐
   ▼                ▼                                 ▼
 Local             Cross-account                Cross-region
 (POC)             AssumeRole                   us-west-1 → us-east-1
                    │                                 │
                    ▼                                 ▼
              Main account 159200192518          CopyDBSnapshot
              us-west-1                          RestoreDBInstanceFromDBSnapshot
              (RDS snapshots, ECR, ECS task
               definitions — Pulumi-managed)
```

**Why the split:** Per Duvan @ DevOps, Francisco has *read* across the main aplazo account (where all real services live, in us-west-1) but *write* only in the POC account (us-east-1 only, per the SCP). The SandboxAgent stack lives in POC, reads source-of-truth from main, and provisions ephemeral sandboxes in POC.

**Source-of-truth for service configs:** [`github.com/aplazo/node.pulumi-infrastructure`](https://github.com/aplazo/node.pulumi-infrastructure). Each service has a `Pulumi.{name}.{env}.yaml` declaring CPU/memory/port/ECR URL/env vars — we mirror what staging actually runs by cloning live task definitions.

## The 7 tools

| # | Tool                       | What it does                                                                                   |
| - | -------------------------- | ---------------------------------------------------------------------------------------------- |
| 1 | resolve_snapshot_config    | AssumeRole → main → DescribeDBSnapshots + DescribeRepositories                                  |
| 2 | restore_rds_snapshot       | CopyDBSnapshot us-west-1 → us-east-1, then RestoreDBInstanceFromDBSnapshot                     |
| 3 | create_merchant            | Calls the existing Merchant Creation Lambda (us-west-1) + branch for POSUI / PROSCAI           |
| 4 | deploy_ecs_services        | Clones staging task definitions cross-account, deploys Fargate in POC                          |
| 5 | configure_merchant         | Injects `MERCHANT_ID` / `API_TOKEN` into the running services                                  |
| 6 | validate_sandbox           | `POST /auth` + `POST /loan` against `api.aplazo.net` with the real merchant credentials        |
| 7 | save_session               | Persists a labeled session in DynamoDB                                                         |

## Quickstart

### 1. Deploy SAM in mock mode

```bash
cd infra
cp samconfig.toml.example samconfig.toml
# Edit: BackendToken=$(openssl rand -hex 32), PocAccountId=<your POC account id>
sam build
sam deploy --profile hackathon-poc
```

This deploys with `MockMode=true` so it works immediately — no cross-account setup required yet.

### 2. Configure the frontend

Open `frontend/sandboxagent-demo-may2026.html` and replace:

```js
const CONFIG = {
  apiKey:       'sk-ant-...',          // Anthropic key from 1Password (#hackathon-support-2026 → IT)
  model:        'claude-sonnet-4-20250514',
  backendUrl:   'https://abc123.execute-api.us-east-1.amazonaws.com/sandbox',
  backendToken: '<the BackendToken you used in samconfig.toml>',
  maxIterations: 12,
};
```

### 3. Publish

Drop the HTML into Aplazo's HTML Publisher → Engineering channel. Lives at `https://www.aplazo.ai/engineering/sandboxagent-demo-may2026.html`.

### 4. Use it

1. Enter a merchant reference (e.g. `walmart_mx`)
2. Pick an integration type from the 14 supported (`API`, `SHOPI`, `POSUI`, …)
3. Optionally pick a credit state / payment outcome
4. Click **Generate sandbox** — the stepper shows each of the 7 tools as it runs
5. Use **Copy URL** / **Visit sandbox** / **Save as…** / **Fork**

### 5. (When ready) switch to real mode

```bash
# One-time: create the cross-account reader role in the main account
cd infra
./scripts/create-staging-reader-role.sh \
  <POC_ACCOUNT_ID> \
  <ResolveSnapshotRoleArn from sam outputs> \
  <DeployEcsRoleArn from sam outputs>

# Then update samconfig.toml with the new role ARN + your POC networking, and re-deploy
sam deploy --profile hackathon-poc --parameter-overrides MockMode=false StagingReaderRoleArn=arn:aws:iam::159200192518:role/sandboxagent-staging-reader ...
```

See `infra/README.md` for the full param list.

## Mandatory tags (POC + Pulumi)

Every resource carries:

```
project=sandboxagent
team=sandboxagent
squad=developer-experience          ← Pulumi-convention mandatory tag
owner=francisco.lanuza@aplazo.mx
expires=2026-05-30
environment=hackathon26
```

The DevOps reaper deletes anything with `expires < today` after May 30, 2026. Ephemeral sandboxes (RDS, ECS) also pick up `sandbox-id`, `merchant`, `integration-type` automatically.

## Hackathon compliance checklist

- [x] Anthropic API key via 1Password (no personal keys, no hardcoded secrets in repo)
- [x] Backend token via SAM parameter (NoEcho, not in repo)
- [x] Code in `github.com/aplazo`
- [x] Deploy on approved infra (HTML Publisher + Lambda/API GW)
- [x] All resources tagged with the 6 mandatory tags (incl. Pulumi `squad`)
- [x] us-east-1 region for POC stack; cross-region copy from main us-west-1
- [x] No real customer data — only synthetic users and dev merchants
- [ ] Cognito + `@aplazo.mx` SSO — roadmap post-hackathon (Bearer token is the MVP guardrail)

## Roadmap

- Cognito SSO with `@aplazo.mx`
- Angular 20 SPA (post-hackathon migration)
- Snapshot pre-warming pool (skip CopyDBSnapshot wait)
- "Destroy sandbox" button (manual cleanup)
- Step Functions for the long-running flow
- CI/CD pipeline (GitHub Actions → SAM deploy)

## Support

- Hackathon questions: `#hackathon-support-2026`
- IT (Anthropic keys): Jorge / Vero
- DevOps reference: [`github.com/aplazo/node.pulumi-infrastructure`](https://github.com/aplazo/node.pulumi-infrastructure) — Duvan confirmed Francisco has the read permissions he needs in staging directly. No DevOps coordination required for snapshots/ECR/configs.
