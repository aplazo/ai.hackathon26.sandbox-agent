# ai.hackathon26.sandbox-agent

**SandboxAgent — On-Demand Merchant Sandbox Configurator**
APLAZO Hackathon 2026 · Developer Experience & Internal Tooling track · PRD v1.6.

AI-driven AWS provisioning agent. A merchant types what they need; the agent calls 8 tools in sequence to provision (or simulate) an isolated staging sandbox, ending with a real Aplazo checkout URL.

> **New here?** Skip to [Local setup](#local-setup). For a deep dive into pending work + decisions, read [`HANDOFF.md`](./HANDOFF.md).

## Status

| | |
| :-- | :-- |
| Backend | 8 Lambdas deployed in POC `332730082760` / us-east-1 |
| API URL | `https://f0ndmxurpk.execute-api.us-east-1.amazonaws.com/sandbox/sandbox` |
| Frontend | Published at `https://www.aplazo.ai/engineering/sandboxagent-demo-may2026.html` via Aplazo HTML Publisher |
| Auth | Google Sign In With Google (`hd=aplazo.mx`) + backend-side `tokeninfo` verification + Bearer token gate |
| Data plane | **All real.** Each sandbox = Aurora PG 15.15 cluster + ECS Fargate + ALB rule, restored from real staging snapshot `apzdbstg-hackathon-local` |

## Architecture

```
Browser (sandboxagent-demo-may2026.html)
  ├── Google Sign In With Google (@aplazo.mx only)
  ├── POST /sandbox/config  (returns Anthropic key + BackendToken to verified users)
  ├── Anthropic API direct call (claude-sonnet-4-20250514, ReAct loop)
  └── 7 tool calls → API Gateway → Lambdas
                        │
                        ▼
                  POC us-east-1 (all in one region — SCP-friendly)
                  ├── HTTP API + 8 routes
                  ├── 8 Lambdas (Node.js 24, arm64)
                  ├── DynamoDB sandboxagent-sessions (TTL)
                  └── IAM role sandboxagent-lambda-role
                        │
                        │  per-sandbox provisioning (REAL)
                        ▼
                  POC us-east-1 data plane
                  ├── Aurora PostgreSQL 15.15 cluster (restored from staging snapshot)
                  ├── Aurora db.t3.medium instance
                  ├── ECS Fargate service in poc-hackaton-cluster
                  ├── ALB target group + listener rule in apz-poc-hackaton
                  └── Mini-app container (sandboxagent/checkout in POC ECR)

      + real cross-account HTTPS (not AWS API):
        ├── Merchant Creation Lambda in us-west-1 (creates real merchants)
        └── api.aplazo.net /auth + /loan (creates real loans)
```

## Repo layout

```
.
├── HANDOFF.md ............................. handoff doc for the next dev
├── STATUS.md .............................. team-facing project brief
├── README.md .............................. this file
├── .gitignore
├── frontend/
│   └── sandboxagent-demo-may2026.html ..... single-file UI + ReAct loop
├── checkout-app/                           per-sandbox container (Node.js 24)
│   ├── Dockerfile                          arm64 image based on public.ecr.aws/docker/library/node:24-alpine
│   ├── index.js                            zero-dep HTTP server, renders HTML w/ env-var-injected sandbox info
│   └── package.json
├── backend/
│   ├── package.json
│   └── lambdas/
│       ├── shared/                          auth, response, ids, mock-data, tags, aws (STS helper)
│       ├── resolve_snapshot_config/         tool 1 — auto-detect Aurora vs RDS snapshot, return ARN
│       ├── restore_rds_snapshot/            tool 2 — RestoreDBClusterFromSnapshot + CreateDBInstance (Aurora) or RestoreDBInstanceFromDBSnapshot (regular)
│       ├── create_merchant/                 tool 3 — real call to us-west-1 merchant Lambda
│       ├── deploy_ecs_services/             tool 4 — real Fargate service + ALB target group + listener rule
│       ├── configure_merchant/              tool 5 — polls ECS, generates syntheticUserId
│       ├── validate_sandbox/                tool 6 — real /auth + /loan against api.aplazo.net
│       ├── save_session/                    tool 7 — real DynamoDB put
│       └── fetch_config/                    auth-gated runtime config endpoint
└── infra/
    ├── template.yaml ...................... SAM template (kept for reference, NOT used — SCP blocks S3)
    ├── samconfig.toml.example
    ├── data-plane-config.env                ARNs for the shared data plane (VPC, subnets, SGs, ALB, ECR, snapshot)
    ├── policies/
    │   ├── lambda-trust-policy.json
    │   └── lambda-execution-policy.json    perms for RDS Aurora + ECS + ELB + EC2 + DynamoDB + STS + KMS
    ├── scripts/
    │   ├── create-staging-reader-role.sh    legacy cross-account role script (not needed anymore — see HANDOFF §0.1)
    │   └── deploy-direct.sh                 THE deploy script (idempotent, sources data-plane-config.env)
    ├── sql/
    │   └── sandbox-seed.sql                 reference schema for legacy golden snapshot (not loaded now)
    └── README.md
```

## Local setup

These steps are everything a new dev needs to clone, run, and deploy from scratch.

### Prerequisites

| Tool | Version | Install (macOS) |
| :-- | :-- | :-- |
| AWS CLI v2 | latest | `brew install awscli` |
| Node.js | ≥ 24 | `brew install node@24` (or via [nvm](https://github.com/nvm-sh/nvm)) |
| Python 3 | any | `brew install python` (only used to run a local HTTP server) |
| Git | any | `xcode-select --install` |

You also need:

- **An `@aplazo.mx` Google account** — required to log in to the frontend (the app rejects everything else)
- **AWS SSO access to the Hackathon POC account** `332730082760` with the `Hackathon2026` role. If you don't have it, ask in `#hackathon-support-2026`.

### 1. Clone the repo

```bash
git clone git@github.com:aplazo/ai.hackathon26.sandbox-agent.git
cd ai.hackathon26.sandbox-agent
```

### 2. Install backend dependencies

```bash
cd backend
npm install
cd ..
```

This installs `@aws-sdk/*` packages used during local testing (`node --check` etc.). They are **not bundled** into the deployed Lambda zips — the `nodejs24.x` runtime provides them.

### 3. Configure AWS SSO profile

You need an AWS SSO profile named **exactly** `hackathon-poc` (the deploy script and all docs hardcode that name).

**Option A — interactive setup:**

```bash
aws configure sso
```

When prompted:

| Prompt | Value |
| :-- | :-- |
| SSO session name | `aplazo` (or any name you've used for Aplazo SSO before) |
| SSO start URL | `https://identitycenter.amazonaws.com/ssoins-7223ad900089de27` |
| SSO region | `us-east-1` |
| SSO registration scopes | press Enter (default `sso:account:access`) |
| (Browser opens, sign in with @aplazo.mx) | — |
| Default client region | `us-east-1` |
| Default output format | `json` |
| Profile name | `hackathon-poc` (must match exactly) |

In the account/role picker:
- Account: `332730082760` ("Hackathon 2026")
- Role: `Hackathon2026`

**Option B — manual, append to `~/.aws/config`:**

```ini
[profile hackathon-poc]
sso_start_url = https://identitycenter.amazonaws.com/ssoins-7223ad900089de27
sso_region = us-east-1
sso_account_id = 332730082760
sso_role_name = Hackathon2026
region = us-east-1
output = json
```

Then:

```bash
aws sso login --profile hackathon-poc
```

**Verify:**

```bash
aws sts get-caller-identity --profile hackathon-poc
# Expected: "Account": "332730082760"
```

When the SSO session expires (~8h), re-run `aws sso login --profile hackathon-poc`.

### 4. Get the secrets

Two secrets are needed for the deploy script. Both are **never committed**:

| Secret | Where to put it | How to get it |
| :-- | :-- | :-- |
| `BACKEND_TOKEN` | `/tmp/sandboxagent-backend-token.txt` | Either generate one fresh (`openssl rand -hex 32`) or ask Francisco / DevOps for the current value (it's already in the deployed Lambdas — regenerating means rotating everywhere) |
| `ANTHROPIC_API_KEY` | `/tmp/sandboxagent-anthropic-key.txt` | Get from IT (`#hackathon-support-2026` → Jorge / Vero, via 1Password). Format: `sk-ant-api03-...` |

Quick setup if you just want to test against the existing deployed backend (NOT redeploy):

```bash
# Ask Francisco for the current BackendToken, then:
echo "<the-token>" > /tmp/sandboxagent-backend-token.txt
chmod 600 /tmp/sandboxagent-backend-token.txt
```

If you intend to redeploy, also set the Anthropic key:

```bash
echo "<your-anthropic-key>" > /tmp/sandboxagent-anthropic-key.txt
chmod 600 /tmp/sandboxagent-anthropic-key.txt
```

### 5. Deploy / redeploy the backend (idempotent)

```bash
cd infra
./scripts/deploy-direct.sh
```

The script creates (or updates) the IAM role, DynamoDB table, 8 Lambdas, HTTP API, integrations, routes, invoke permissions — all with mandatory tags. Re-running it is safe.

> Note: do **not** use `sam build` / `sam deploy`. SAM requires S3 bucket creation, which the POC account's SCP blocks. The direct script bypasses S3 by uploading Lambda code inline via `--zip-file` (50 MB limit).

After deploy, the script prints the API URL + role ARNs. The URL is already hardcoded in `CONFIG.backendUrl` in the HTML — if it changes (new stack), update the HTML.

### 6. Run the frontend locally

The published version on `aplazo.ai` is gated by Aplazo Cognito SSO and only updates when you re-publish via the HTML Publisher. For local dev:

```bash
cd frontend
python3 -m http.server 8080
```

Then open:

```
http://localhost:8080/sandboxagent-demo-may2026.html
```

> **Important — Google OAuth requires the exact origin to be whitelisted in the OAuth Client ID.** `http://localhost:8080` is already added. Other ports won't work without updating the Client ID in [GCP Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
>
> **Never open the HTML with `file://`** — Google explicitly rejects that origin scheme.

### 7. Test end-to-end

1. Open `http://localhost:8080/sandboxagent-demo-may2026.html`
2. Sign in with your `@aplazo.mx` Google account
3. The HTML POSTs your id_token to `/sandbox/config` → backend verifies via Google `tokeninfo` → returns the Anthropic key + BackendToken to the page (closure-scoped, not on `window` or `CONFIG`)
4. Enter a merchant ref (e.g. `walmart_mx`) and pick integration type `API` or `API_OFFLINE`
5. Click **Generate sandbox** → the stepper shows 7 tools executing
6. Summary card shows the merchant info, the real loan UUID, and a `live` checkout URL
7. Click **Open checkout** → opens the real `https://checkout.aplazo.net/main/<uuid>` (shared checkout for now — the post-hackathon work makes this a per-sandbox isolated URL)

### 8. Re-publishing to the CDN

When you change the HTML and want it live for the demo:

1. Open Claude Cowork
2. Run `/html-publisher`
3. Choose **Publish HTML**
4. Upload `frontend/sandboxagent-demo-may2026.html`
5. Choose team **Engineering**
6. The publisher's secret scanner inspects the file. Since wave 3, the HTML has **no secrets** in source (only `backendUrl`, `googleClientId`, `allowedDomain` — all public). The scanner should not blank anything.

## CONFIG block (frontend)

Only public values:

```js
const CONFIG = {
  backendUrl:     'https://f0ndmxurpk.execute-api.us-east-1.amazonaws.com/sandbox/sandbox',
  googleClientId: '627677728138-b4b39v4ie3dn3qa0lm6lg01mtcao7otv.apps.googleusercontent.com',
  allowedDomain:  'aplazo.mx',
};
```

`apiKey` and `backendToken` are **deliberately absent** — they are fetched from `/sandbox/config` after Google login and held in a closure variable, never written to `window` or `CONFIG`.

## The 8 tools (current behavior — all real)

| # | Tool | Mode | What it does |
| :-: | :-- | :-: | :-- |
| 1 | `resolve_snapshot_config` | ✅ real | Describes Aurora cluster snapshot `apzdbstg-hackathon-local` (auto-detects Aurora vs regular RDS from the ARN) |
| 2 | `restore_rds_snapshot` | ✅ real | `RestoreDBClusterFromSnapshot` + `CreateDBInstance` (Aurora path) or `RestoreDBInstanceFromDBSnapshot` (regular path). Fire-and-poll-short pattern, returns within 25s |
| 3 | `create_merchant` | ✅ real | Calls us-west-1 Merchant Creation Lambda → real `merchantId` + `apiToken`; creates branch for `API_OFFLINE` |
| 4 | `deploy_ecs_services` | ✅ real | Registers task def + creates Fargate service on `poc-hackaton-cluster` + ALB target group + listener rule with path-pattern `/sandbox-{id}/*` |
| 5 | `configure_merchant` | ✅ real | Polls ECS for `runningCount >= 1`, generates `syntheticUserId` |
| 6 | `validate_sandbox` | ✅ real | `/auth` + `/loan` against `api.aplazo.net`, returns real `checkout.aplazo.net/main/<uuid>` URL |
| 7 | `save_session` | ✅ real | `PutItem` into DynamoDB `sandboxagent-sessions` with TTL |
| — | `fetch_config` | — | Auth-gated runtime config endpoint (not in the agent loop; frontend calls it after Google login) |

## Data plane infrastructure

The per-sandbox AWS resources, all created at provision-time by the agent and tagged with `sandbox-id=<id>` for the DevOps reaper:

| Resource | Identifier pattern | Lifecycle |
| :-- | :-- | :-- |
| Aurora cluster | `sandbox-<id>-cluster` | Restored from `apzdbstg-hackathon-local` (~5 min) |
| Aurora instance | `sandbox-<id>-i1` (db.t3.medium) | Inside the cluster (~5 min more) |
| ECS task definition | `sba-<id>-td:1` | New revision per sandbox |
| ECS Fargate service | `sba-<id>-svc` in `poc-hackaton-cluster` | Runs our `sandboxagent/checkout` container |
| ALB target group | `sba-<id>-tg` | HTTP 8080 health-check `/health` |
| ALB listener rule | path-pattern `/sandbox-<id>/*` | Priority 1000-9000 (hash of sandbox_id) |
| DynamoDB record | `sess_<id>` in `sandboxagent-sessions` | TTL 10 days |
| Aplazo merchant | numeric ID in dev environment | No auto-cleanup (Aplazo side) |
| Aplazo loan | UUID in dev environment | No auto-cleanup (Aplazo side) |

The shared data plane infra (created once, used by all sandboxes):

| Resource | Purpose |
| :-- | :-- |
| ECR repo `sandboxagent/checkout` | Stores the per-sandbox checkout image |
| RDS subnet group `sandboxagent-subnet-group` | Aurora cluster placement (us-east-1a + 1c) |
| Security group `sandboxagent-rds-sg` | Postgres 5432 from VPC CIDR |
| Security group `sandboxagent-ecs-sg` | TCP 8080 from ALB SG |
| ECS task execution role `sandboxagent-ecs-task-execution-role` | Pull ECR image + push logs |
| Log group `/ecs/sandboxagent` | All Fargate task logs (pre-created — SCP blocks auto-create) |
| Aurora cluster snapshot `apzdbstg-hackathon-local` | Real staging data, shared by DevOps to POC, re-encrypted with `aws/rds` |

## Mandatory AWS tags

Applied to every resource we create:

```
project=sandboxagent
team=sandboxagent
squad=developer-experience
owner=francisco.lanuza@aplazo.mx
expires=2026-05-30
environment=hackathon26
```

The hackathon SCP enforces these at IAM creation time. The DevOps reaper deletes anything with `expires < today`. Ephemeral sandbox resources (when we wire them up real) also get `sandbox-id`, `merchant`, `integration-type` tags.

## Common gotchas

| Symptom | Cause | Fix |
| :-- | :-- | :-- |
| `ERR_NAME_NOT_RESOLVED` on `sandbox-*.aplazo.ai` | Mock URL, no DNS exists | Click **Open checkout** (the real `checkout.aplazo.net` URL) instead |
| `[GSI_LOGGER] origin not allowed for client ID` | The port / origin isn't in the OAuth Client ID's authorized list | Add it in GCP Console → APIs & Services → Credentials, or use `http://localhost:8080` |
| `tokeninfo returned 400: invalid_token` from `/sandbox/config` | id_token is malformed / expired / from wrong client | Sign out + sign in again |
| `aws: command not found` after `aws sso login` | SSO session expired | `aws sso login --profile hackathon-poc` |
| HTML Publisher blanks out `CONFIG.googleClientId` after publish | Scanner false-positive on the `*.apps.googleusercontent.com` pattern | Republish — the Client ID is public per Google's OAuth model, you can also override the scanner manually if it persists |
| `s3:CreateBucket` denied | POC SCP explicitly denies S3 | Don't use SAM. The `deploy-direct.sh` script avoids S3 entirely |
| 404 hitting `/sandbox/sandbox` with no path | That's just the base path; not an endpoint | Append a route: `/sandbox/sandbox/config`, `/sandbox/sandbox/resolve-snapshot`, etc. |

## Roadmap (post-hackathon)

- Per-sandbox checkout subdomain `sandbox-<id>.checkout.aplazo.net` instead of the shared `checkout.aplazo.net` (requires wildcard DNS + ACM cert + the real Aplazo `checkout-engine` running in our Fargate, which currently lives in us-west-1 ECR)
- Backend proxy for Anthropic API (so the key never reaches the client)
- Cognito + Google Workspace SSO for the HTML (the current GIS gate is client-side only — secrets are still gated server-side)
- Angular 20 SPA frontend (replaces single-file HTML)
- Snapshot pre-warming pool to skip the 5-7 min Aurora restore
- "Destroy sandbox" button + Step Functions for the long-running flow
- CI/CD pipeline (GitHub Actions → `deploy-direct.sh`)
- Switch `restore_rds_snapshot` to assume a cross-region role so we can read snapshots directly from main us-west-1 (currently DevOps re-encrypts and shares manually)

## References

- **HANDOFF.md** — the canonical doc for what's pending and the architectural decisions
- **PRD v1.6** — https://docs.google.com/document/d/1ik5-MMWy6xAygyAH-GNyckvfk9qgYVLSSmKjYIiiSts/
- **Pulumi infra repo** — https://github.com/aplazo/node.pulumi-infrastructure
- **Aplazo Online API docs** — https://aplazo.gitbook.io/aplazo-integrations/online-api/
- **Hackathon Slack** — `#hackathon-support-2026` (Brandom Marañon, Duvan Bedoya)
- **IT (Anthropic keys)** — Jorge / Vero

## License

Internal Aplazo project. Not for redistribution.
