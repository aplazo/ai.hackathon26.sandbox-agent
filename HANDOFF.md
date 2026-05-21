# SandboxAgent — Handoff Doc

> **Audience:** the next developer (human or AI agent) picking this up.
> **Goal:** the hackathon demo is feature-complete; this doc covers the remaining polish + roadmap.
> **Repo:** https://github.com/aplazo/ai.hackathon26.sandbox-agent
> **Current branch:** `master` · last commit: `e842ff0`

> **For a high-level project brief (team-facing)** see [`STATUS.md`](./STATUS.md). For local dev setup, see [`README.md`](./README.md).

---

## 0. Permissions Reality Check (updated)

**Full AWS permissions in POC us-east-1, plus DevOps unblocks for cross-region snapshot.** The constraints we hit, ranked by friction:

| Where | What works | What's blocked |
| :-- | :-- | :-- |
| POC `332730082760` · us-east-1 | **Full write.** IAM, Lambda, APIGW v2, DynamoDB, ECS, **Aurora RDS, ECR, KMS, CloudWatch, ALB, VPC describe**. All require the 6 mandatory tags at creation. | `s3:CreateBucket` / `s3:PutObject` denied by SCP `p-4avftpkm`. Workaround: Lambda inline `ZipFile` (50MB limit) instead of `sam deploy` S3 bundling. CodeBuild + ECS tasks also need their CloudWatch log groups pre-created (same SCP). |
| Main `159200192518` · us-west-1 | Read denied for the Hackathon2026 role (SCP `p-5zv6maiv`). | Direct cross-region access. **Workaround used:** DevOps copied the staging Aurora snapshot to POC us-east-1 (re-encrypted with `aws/rds`) — see `infra/data-plane-config.env`. |
| snx `754396578028` · us-west-2 | Unknown, never used. | — |

**Rule of thumb:** when in doubt, **try the AWS call** — the error message tells you exactly what's blocked. The probes are already documented in this repo's commit history. The `deploy-direct.sh` script proves what works.

---

## 1. Mission

Provision real, isolated per-merchant sandbox infrastructure on demand from a natural-language prompt. Each sandbox = its own RDS (from staging snapshot) + ECS cluster + URL that points to that merchant's checkout. Cleanup via tag-based reaper.

PRD v1.6 (Google Doc): https://docs.google.com/document/d/1ik5-MMWy6xAygyAH-GNyckvfk9qgYVLSSmKjYIiiSts/

---

## 2. What's Already Built (don't redo)

### 2.1 Control plane (POC us-east-1, all live)

| Resource | Identifier |
| :-- | :-- |
| HTTP API | `f0ndmxurpk.execute-api.us-east-1.amazonaws.com` |
| API base path | `https://f0ndmxurpk.execute-api.us-east-1.amazonaws.com/sandbox/sandbox` |
| IAM role | `arn:aws:iam::332730082760:role/sandboxagent-lambda-role` |
| DynamoDB table | `sandboxagent-sessions` (TTL on `ttl` attr) |
| Lambdas (8) | `sandboxagent-{resolve-snapshot-config, restore-rds-snapshot, create-merchant, deploy-ecs-services, configure-merchant, validate-sandbox, save-session, fetch-config}` |
| Routes | `POST /sandbox/{resolve-snapshot, restore-rds, create-merchant, deploy-ecs, configure-merchant, validate-sandbox, save-session, config}` |

### 2.2 Authentication

- Google Sign In With Google (GIS library) gates the HTML. Restricted to `hd=aplazo.mx`.
- OAuth Client ID: `627677728138-b4b39v4ie3dn3qa0lm6lg01mtcao7otv.apps.googleusercontent.com` (public per Google's OAuth model — fine in HTML)
- Authorized JavaScript origins: `https://www.aplazo.ai`, `http://localhost:8080`
- After GIS verifies, frontend POSTs the id_token to `/sandbox/config`
- The `fetch_config` Lambda re-verifies the JWT via Google's `oauth2/tokeninfo` endpoint (checks `aud`, `email_verified`, `hd`, `exp`) and only then returns the secrets

### 2.3 Secrets

| Secret | Where it lives | How to rotate |
| :-- | :-- | :-- |
| Anthropic API key | env var `ANTHROPIC_API_KEY` of `sandboxagent-fetch-config` Lambda · local backup at `/tmp/sandboxagent-anthropic-key.txt` | `aws lambda update-function-configuration --function-name sandboxagent-fetch-config --environment 'Variables={ANTHROPIC_API_KEY=...,BACKEND_TOKEN=...,GOOGLE_CLIENT_ID=...,ALLOWED_DOMAIN=aplazo.mx,MODEL=claude-sonnet-4-20250514,MAX_ITERATIONS=12}'` |
| BackendToken (Bearer) | env var `BACKEND_TOKEN` of all 8 Lambdas · local at `/tmp/sandboxagent-backend-token.txt` · samconfig.toml | Same pattern — regenerate with `openssl rand -hex 32`, update all Lambdas + samconfig.toml |
| Google OAuth Client ID | hardcoded in HTML (public by design) + env of `fetch-config` Lambda | Regenerate in GCP Console, update both places |

The HTML source has **zero secrets** — they're fetched at runtime after Google login. This is the hackathon-compliance fix that's already shipped.

### 2.4 Mock vs. real mode per Lambda

**All 7 tool Lambdas now run with `MOCK_MODE=false` against real AWS / Aplazo APIs.**

| Lambda | Mode | What it does in real mode |
| :-- | :-- | :-- |
| `resolve_snapshot_config` | ✅ real | Auto-detects Aurora cluster snapshot vs regular RDS from the env var ARN. Uses `DescribeDBClusterSnapshots` or `DescribeDBSnapshots`. |
| `restore_rds_snapshot` | ✅ real | Aurora path: `RestoreDBClusterFromSnapshot` + `CreateDBInstance` (db.t3.medium). RDS path: `RestoreDBInstanceFromDBSnapshot` (db.t3.micro). Fire-and-poll-short pattern (≤25s polling). |
| `create_merchant` | ✅ real | HTTPS to us-west-1 Merchant Creation Lambda + branch endpoint for `API_OFFLINE`. |
| `deploy_ecs_services` | ✅ real | `RegisterTaskDefinition` + `CreateService` on `poc-hackaton-cluster` + `CreateTargetGroup` + `CreateRule` on shared `apz-poc-hackaton` ALB. |
| `configure_merchant` | ✅ real | Polls ECS service `runningCount`, generates `syntheticUserId`. |
| `validate_sandbox` | ✅ real | `/auth` + `/loan` against `api.aplazo.net` with the merchant's real credentials. Returns real `checkout.aplazo.net/main/<uuid>`. |
| `save_session` | ✅ real | `PutItem` into `sandboxagent-sessions` with TTL. |

The `data-plane-config.env` file sources the ARNs each Lambda needs (VPC, subnets, SGs, ALB, ECR, snapshot, role). Re-run `deploy-direct.sh` to push env var changes.

### 2.5 Frontend behavior

- Login screen: brand "aplazo / SandboxAgent" matches MKT Hub pattern
- After login → fetches `/sandbox/config` → stores `runtimeConfig` in closure (NOT on `CONFIG`, NOT on `window`)
- Sandbox creation form: just merchant ref + integration type (only `API` and `API_OFFLINE` are supported)
- ReAct loop calls Anthropic directly from browser with the runtime apiKey + 7 tools defined
- Stepper shows the 7 tools executing
- Summary card shows merchant info, checkout URL, validation checks
- Buttons: Copy URL, Open checkout (opens `checkout.aplazo.net/main/<uuid>` — real but shared), Save as, Fork
- Sessions saved both in localStorage (per-browser) and DynamoDB (server-side)

### 2.6 Data plane resources (shared, one-time setup, already created)

| Resource | Identifier | Where defined |
| :-- | :-- | :-- |
| ECR repo | `sandboxagent/checkout` | Created via CLI, image built via AWS CodeBuild (Docker Hub rate-limited from CodeBuild → use `public.ecr.aws/docker/library/node:24-alpine`) |
| RDS subnet group | `sandboxagent-subnet-group` | 2 subnets in us-east-1a + 1c (must match ALB AZs) |
| Security group (RDS) | `sg-01cc1bf993da25b40` (sandboxagent-rds-sg) | Ingress 5432 from VPC CIDR |
| Security group (ECS) | `sg-06fb2fd530ba87079` (sandboxagent-ecs-sg) | Ingress 8080 from ALB SG `sg-062332ad9325e549a` |
| ECS task execution role | `sandboxagent-ecs-task-execution-role` | Standard `AmazonECSTaskExecutionRolePolicy` attached |
| ECS cluster (shared) | `poc-hackaton-cluster` | Created by another hackathon team; we add services to it |
| ALB (shared) | `apz-poc-hackaton` (in 1a + 1c) | We add listener rules with path-pattern routing |
| ALB listener (HTTP:80) | `arn:.../listener/.../b3bdcabfedbacd97` | Where we add per-sandbox rules |
| Log group (ECS) | `/ecs/sandboxagent` | Pre-created (SCP blocks `awslogs-create-group=true`) |
| Aurora cluster snapshot | `apzdbstg-hackathon-local` | Real staging data, shared by DevOps to POC, re-encrypted with `aws/rds` |

### 2.7 Per-sandbox lifecycle

Every time the agent provisions a sandbox `sb<id>`:

1. RDS: `sandbox-<id>-cluster` (Aurora) + `sandbox-<id>-i1` (instance)
2. ECS task def: `sba-<id>-td:1`
3. ECS service: `sba-<id>-svc` in `poc-hackaton-cluster`
4. ALB target group: `sba-<id>-tg`
5. ALB listener rule: path-pattern `/sandbox-<id>/*` on the shared listener
6. DynamoDB session: `sess_<id>`

Tags applied: 6 mandatory + `sandbox-id=<id>` + `merchant=<merchant_ref>` + `integration-type=<type>`. The DevOps reaper handles cleanup via `expires=2026-05-30`.

---

## 3. What's Pending (post-hackathon)

The hackathon demo is feature-complete (real per-sandbox AWS isolation + real Aplazo merchant + real Aplazo loan). What's left is mostly polish for productionization.

### 3.1 The remaining narrative gap: sandbox URL + checkout URL

**Two related issues, both blocked by cross-site / cross-team permissions** — documented in detail in [`URL-STRATEGY.md`](./URL-STRATEGY.md).

**Current state:**
- Sandbox URL: `http://apz-poc-hackaton-...elb.amazonaws.com/sandbox-<id>/` (functional, served by per-sandbox Fargate, but HTTP + AWS-looking)
- Checkout URL: `https://checkout.aplazo.net/main/<uuid>` (real, shared by all sandboxes — Aplazo's checkout-engine)

**Target:**
- Both URLs unified at `https://sandbox-<id>.checkout.aplazo.net/...` — branded HTTPS subdomain, isolated per-sandbox Fargate running the real checkout-engine.

**Three blockers** (all post-hackathon by design):

1. **DNS** — `aplazo.net` Route53 zone is in main account behind SCP `p-5zv6maiv`. DevOps needs to either (a) delegate `sandbox.checkout.aplazo.net` to a Route53 zone we own in POC, or (b) add the wildcard records directly.
2. **ACM cert** — wildcard `*.sandbox.checkout.aplazo.net` needs DNS validation, which depends on #1.
3. **Checkout-engine app** — image `aplazo/stg-checkout-engine` lives in us-west-1 ECR, also blocked by `p-5zv6maiv`. DevOps needs to mirror it to POC ECR, OR we reimplement a minimal sandbox-checkout app.

**Effort post-win:** ~2 days for DNS + cert + HTTPS listener (phase 1), ~1 week to swap in the real checkout-engine (phase 2). See [`URL-STRATEGY.md`](./URL-STRATEGY.md) §6 for the full 6-step rollout.

**Demo positioning:** "AWS isolation is real and demonstrable; the URL aesthetic gap is a known cross-site permission issue — if we win, this is the first piece of post-win work."

### 3.2 Other polish items (smaller)

- **Destroy sandbox button** — manual cleanup before the reaper kicks in (`expires=2026-05-30`). Simple Lambda that deletes the cluster + service + rule + target group by sandbox-id tag.
- **Pool of pre-warmed snapshots** — current Aurora restore takes ~5-7 min. Maintain 2-3 pre-restored clusters that get assigned on demand → sub-30s provisioning.
- **Backend proxy for Anthropic API** — currently the Anthropic key reaches the browser (fetched via `/sandbox/config` after Google login). Better: proxy the Anthropic call through a Lambda so the key never leaves AWS. ~30 min refactor.
- **Cognito SSO for the HTML** — the current GIS-only gate is client-side. A real production deploy should put Cognito + Google Workspace in front of the HTML Publisher too.
- **CI/CD pipeline** — GitHub Actions on merge to `main` runs `deploy-direct.sh`. Currently it's manual.
- **Step Functions** instead of polling-inside-Lambda — the current fire-and-poll-short pattern (≤25s per tool) hits the 30s API GW limit. Step Functions would let us properly orchestrate the long-running Aurora restore.
- **Observability** — CloudWatch dashboards, cost-per-sandbox tracking via the `sandbox-id` tag, alerting on stuck/failed provisioning.
- **Frontend modernization** — current single-file HTML is fine for hackathon; Angular 20 SPA was post-hackathon item in the PRD.

### 3.3 Architecture target (current state — all in POC us-east-1)

```
══════════════════════════════════════════════════════════════════════════════
  Everything in POC account 332730082760 · us-east-1
══════════════════════════════════════════════════════════════════════════════

  CONTROL PLANE
  ┌─────────────────────────────────────────────────────────────────────┐
  │  HTTP API f0ndmxurpk (8 routes)                                     │
  │  8 Lambdas (Node.js 24, arm64)                                      │
  │  DynamoDB sandboxagent-sessions                                     │
  │  IAM role sandboxagent-lambda-role                                  │
  │  Frontend: aplazo.ai HTML Publisher + Google SSO @aplazo.mx         │
  └─────────────────────────────────────────────────────────────────────┘
                              │
                              │  per-sandbox provisioning (REAL)
                              ▼
  DATA PLANE
  ┌─────────────────────────────────────────────────────────────────────┐
  │  Shared infrastructure:                                             │
  │    ECR sandboxagent/checkout (image used by all sandboxes)          │
  │    ECS cluster poc-hackaton-cluster                                 │
  │    ALB apz-poc-hackaton (us-east-1a + 1c)                           │
  │    Aurora snapshot apzdbstg-hackathon-local (real staging data)     │
  │                                                                     │
  │  Per-sandbox (REAL, tag sandbox-id=<id>):                           │
  │    Aurora cluster sandbox-<id>-cluster + instance sandbox-<id>-i1   │
  │    ECS service sba-<id>-svc + task def sba-<id>-td:N                │
  │    ALB target group sba-<id>-tg + listener rule /sandbox-<id>/*     │
  │    DynamoDB record sess_<id>                                        │
  │                                                                     │
  │  Real Aplazo cross-region (HTTPS, no AWS API):                      │
  │    us-west-1 Merchant Creation Lambda → real merchantId + apiToken  │
  │    api.aplazo.net /auth + /loan → real loan + checkout URL          │
  └─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Repo Map

```
.
├── HANDOFF.md ............................. (this file)
├── README.md .............................. top-level overview
├── .gitignore
├── frontend/
│   └── sandboxagent-demo-may2026.html ..... single-file UI + ReAct loop
├── backend/
│   ├── package.json
│   └── lambdas/
│       ├── shared/
│       │   ├── auth.js .................... Bearer token check (skipped for fetch_config)
│       │   ├── aws.js ..................... STS AssumeRole helper for cross-account
│       │   ├── ids.js ..................... sandbox_id, session_id, syntheticUserId generators
│       │   ├── mock-data.js ............... mock responses for each tool
│       │   ├── response.js ................ API GW response helpers (ok, error, parseBody)
│       │   └── tags.js .................... mandatory POC + Pulumi tag list
│       ├── resolve_snapshot_config/
│       ├── restore_rds_snapshot/
│       ├── create_merchant/ ............... MOCK_MODE=false (HTTP to us-west-1)
│       ├── deploy_ecs_services/
│       ├── configure_merchant/
│       ├── validate_sandbox/ .............. MOCK_MODE=false (HTTP to api.aplazo.net)
│       ├── save_session/
│       └── fetch_config/ .................. auth-gated config endpoint
├── checkout-app/ .......................... per-sandbox Fargate container
│   ├── Dockerfile ......................... arm64, public.ecr.aws/docker/library/node:24-alpine
│   ├── index.js ........................... zero-dep Node HTTP server, renders sandbox-info HTML
│   └── package.json
└── infra/
    ├── template.yaml ...................... SAM template (NOT USED — SCP blocks S3, kept for reference)
    ├── samconfig.toml.example
    ├── samconfig.toml ..................... gitignored — has BackendToken + PocAccountId
    ├── data-plane-config.env .............. shared data plane ARNs (VPC, subnets, SGs, ALB, ECR, snapshot, role)
    ├── policies/
    │   ├── lambda-trust-policy.json
    │   └── lambda-execution-policy.json ... full perms (RDS Aurora + RDS + ECS + ELBv2 + EC2 + KMS + STS + DDB)
    ├── scripts/
    │   ├── create-staging-reader-role.sh .. legacy — not used now (cross-account is solved via snapshot copy)
    │   └── deploy-direct.sh ............... THE deploy script (sources data-plane-config.env, NOT sam deploy)
    ├── sql/
    │   └── sandbox-seed.sql ............... schema reference for the legacy golden snapshot (not loaded)
    └── README.md
```

---

## 5. Commands You Will Need

### 5.1 Deploy (idempotent — safe to re-run)

```bash
cd infra
./scripts/deploy-direct.sh
```

This script reads `/tmp/sandboxagent-backend-token.txt` and `/tmp/sandboxagent-anthropic-key.txt`. If either is missing, it warns. It creates IAM role, DynamoDB table, 8 Lambdas, HTTP API, integrations, routes, invoke permissions — all idempotently.

### 5.2 Update a single Lambda

```bash
cd backend
zip -qr /tmp/lambdas.zip lambdas package.json -x "*/node_modules/*"
aws lambda update-function-code --function-name sandboxagent-<name> --zip-file fileb:///tmp/lambdas.zip --profile hackathon-poc --region us-east-1
aws lambda wait function-updated --function-name sandboxagent-<name> --profile hackathon-poc --region us-east-1
```

(Or just re-run `deploy-direct.sh`.)

### 5.3 Watch logs

```bash
aws logs tail /aws/lambda/sandboxagent-<name> --follow --profile hackathon-poc --region us-east-1
```

### 5.4 Test the API directly

```bash
TOKEN=$(cat /tmp/sandboxagent-backend-token.txt)
curl -s -X POST 'https://f0ndmxurpk.execute-api.us-east-1.amazonaws.com/sandbox/sandbox/<route>' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"merchant_id":"walmart_mx"}'
```

### 5.5 Local frontend dev

```bash
cd frontend
python3 -m http.server 8080
open http://localhost:8080/sandboxagent-demo-may2026.html
```

(Google OAuth requires `http://localhost:8080` to be in the Client ID's authorized origins. Already configured.)

### 5.6 First-time AWS profile setup

You need an AWS SSO profile named **exactly** `hackathon-poc` — the deploy script and every command in this doc hardcode that name.

#### Option A — Interactive (recommended)

```bash
aws configure sso
```

When prompted, answer:

| Prompt | Value |
| :-- | :-- |
| **SSO session name** | `aplazo` (or whatever you've used for Aplazo SSO before — any name) |
| **SSO start URL** | `https://identitycenter.amazonaws.com/ssoins-7223ad900089de27` |
| **SSO region** | `us-east-1` |
| **SSO registration scopes** | press Enter (default `sso:account:access`) |
| (browser opens, authorize the device) | sign in with your `@aplazo.mx` account |
| **Default client Region** | `us-east-1` |
| **CLI default output format** | `json` |
| **Profile name** | `hackathon-poc` (this MUST match exactly) |

When the CLI shows the account picker:
- Account ID: **`332730082760`** (named "Hackathon 2026" or similar)
- Role: pick the one with Lambda / IAM / DynamoDB / APIGW write — Francisco used `Hackathon2026` (admin-equivalent in this account)

#### Option B — Manual (faster if you know what you're doing)

Append to `~/.aws/config`:

```ini
[profile hackathon-poc]
sso_start_url = https://identitycenter.amazonaws.com/ssoins-7223ad900089de27
sso_region = us-east-1
sso_account_id = 332730082760
sso_role_name = Hackathon2026
region = us-east-1
output = json
```

Then trigger the browser auth:

```bash
aws sso login --profile hackathon-poc
```

#### Verify the setup

```bash
aws sts get-caller-identity --profile hackathon-poc
```

Expected output (numbers vary per session):

```json
{
    "UserId": "AROA...:your.email@aplazo.mx",
    "Account": "332730082760",
    "Arn": "arn:aws:sts::332730082760:assumed-role/AWSReservedSSO_Hackathon2026_<hash>/your.email@aplazo.mx"
}
```

If the `Account` field is `332730082760` you're good — proceed to `./infra/scripts/deploy-direct.sh`.

#### Session lifetime

SSO sessions expire after a few hours. When you see this:

```
The SSO session associated with this profile has expired or is otherwise invalid.
```

Just re-run:

```bash
aws sso login --profile hackathon-poc
```

#### For main-account access (later, when you tackle Task A)

The cross-account provisioner role in main account `159200192518` needs to be created from a profile that has IAM write rights in that account. Two existing Aplazo SSO profiles likely qualify:

```
aplazo-apz           → account 159200192518 (main)
aplazo-apz-sandbox   → account 754396578028 (Pulumi snx)
```

Both use `sso_start_url = https://aplazo.awsapps.com/start` (different from the hackathon-poc URL above — Aplazo has its own SSO portal). If you don't see those profiles in `~/.aws/config`, ask DevOps which one has IAM write in main, then `aws sso login --profile <name>` and run the staging-reader-role script from there.

---

## 6. Constraints / Don't Break

1. **No secrets in committed source.** The HTML must continue to fetch its secrets from `/sandbox/config` after Google login. Don't put `apiKey` or `backendToken` back into the `CONFIG` block.
2. **6 mandatory tags on every AWS resource.** `project, team, squad, owner, expires, environment`. The SCP enforces this at creation time for IAM and most other resources. Use `backend/lambdas/shared/tags.js`.
3. **No S3 in POC us-east-1.** The SCP blocks `s3:CreateBucket` and `s3:PutObject`. Use Lambda inline ZipFile uploads (50MB limit) — the deploy script already does this.
4. **Don't bundle node_modules in Lambda zips.** The `nodejs24.x` runtime ships `@aws-sdk/*` v3. Bundling adds 80MB+ and breaks the inline upload path.
5. **Google login restricted to `@aplazo.mx`.** Both client-side (GIS `hd` param + claim check) and server-side (`fetch_config` Lambda verifies `hd` from `tokeninfo`). Don't loosen this.
6. **Idempotent deploys.** `deploy-direct.sh` should remain re-runnable without breaking existing state. Look up before create; update if exists.

---

## 7. Decisions Already Made (don't re-litigate)

- **No SAM/CloudFormation.** S3 is blocked by SCP. We use direct AWS CLI / SDK calls via `deploy-direct.sh`.
- **Data plane lives entirely in POC us-east-1, not main us-west-1.** Originally planned cross-region from main, but SCP `p-5zv6maiv` blocked us-west-1. Pivot: build everything in POC us-east-1. DevOps copied the real staging Aurora snapshot to us-east-1 (re-encrypted with `aws/rds`) so we get real staging data without cross-region.
- **Anthropic call from browser, not backend proxy.** The frontend talks to `api.anthropic.com` directly using the runtime-fetched key. Backend proxy is a roadmap item.
- **Frontend gate only for Google auth (not backend JWT verify on every tool call).** Each tool call uses the BackendToken (Bearer). The Google JWT is only verified at `/sandbox/config` time.
- **Integration types narrowed to API + API_OFFLINE.** The PRD listed 14; we cut to 2 because the others aren't being demoed.
- **Mock fields (`credit_state`, `payment_outcome`, `extra_prompt`) removed entirely.** Don't add them back to the UI.
- **HTML Publisher = Aplazo Cognito-gated CDN at `aplazo.ai`.** The HTML is published via `/html-publisher` in Claude Cowork. Republish after frontend changes.
- **Sandbox URL uses path-prefix on the shared ALB**, not host-header subdomain. URL: `http://<alb-dns>/sandbox-<id>/`. Subdomain would require DNS + cert work that's out of scope for hackathon.
- **Container image built via AWS CodeBuild, not local Docker.** The author was on macOS without Docker Desktop running; CodeBuild + NO_SOURCE + inline base64 source worked. ECR Public Gallery (`public.ecr.aws/docker/library/node:24-alpine`) to avoid Docker Hub rate-limits inside CodeBuild.
- **Mini-app in Fargate is a placeholder, not the real `checkout-engine`.** Renders merchant info + a button to the real Aplazo checkout. Replacing it with the real Aplazo checkout-engine is the main post-hackathon item (needs DevOps mirror to POC ECR or our own reimplementation).
- **Aurora snapshot in POC**, not main. Originally planned cross-account, but KMS access for the staging key was denied. DevOps re-encrypted with `aws/rds` and shared a copy → `apzdbstg-hackathon-local` in POC.
- **Auto-detect Aurora vs RDS in restore_rds_snapshot.** The Lambda reads the snapshot ARN: `cluster-snapshot:` → Aurora path. Lets us swap `RDS_GOLDEN_SNAPSHOT` env var without code changes.
- **Aurora restore is fire-and-poll-short.** API GW HTTP API has a 30s hard timeout; we poll for ~25s and return whatever state we have. Status `creating` is fine — agent proceeds, ECS task finishes booting in background ~5-10 min after the agent returns.
- **ALB listener rule priority via hash of sandbox_id.** Range 1000-9000, with up to 20 attempts to avoid collisions. ALB has 100-rule default limit; if we hit it, raise the quota.

---

## 8. Open Questions (mostly resolved)

| Question | Answer (resolved during hackathon) |
| :-- | :-- |
| Where does the data plane live? | POC us-east-1 (us-west-1 access denied by SCP). |
| Shared `aplazo-stg-cluster` vs dedicated? | We use the shared `poc-hackaton-cluster` that another team set up. Adding services to it works fine. |
| ALB rule priority numbering? | Hash of sandbox_id into 1000-9000 range. Works for ~tens of sandboxes; raise quota if needed. |
| Wildcard ACM cert? | Not needed for hackathon (we use ALB HTTP listener default DNS). For prod, request `*.sandbox.checkout.aplazo.net` from DevOps. |
| Loan UUID routing in checkout? | Out of scope — we open the real `checkout.aplazo.net` URL Aplazo returns. Per-sandbox checkout flow is post-hackathon. |
| SCP `logs:CreateLogGroup` block? | Workaround: pre-create the log group `/ecs/sandboxagent` before deploys. Same for CodeBuild. |

---

## 9. Reference Materials

| Resource | Where |
| :-- | :-- |
| PRD v1.6 | https://docs.google.com/document/d/1ik5-MMWy6xAygyAH-GNyckvfk9qgYVLSSmKjYIiiSts/ |
| Pulumi infrastructure repo | https://github.com/aplazo/node.pulumi-infrastructure |
| Aplazo Online API docs | https://aplazo.gitbook.io/aplazo-integrations/online-api/ |
| Aplazo HTML Publisher | Claude Cowork → `/html-publisher` (announced 2026-03 by @daviduziel) |
| Hackathon DevOps support | Slack `#hackathon-support-2026` (Brandom Marañon, Duvan Bedoya) |
| IT (Anthropic keys) | Slack — Jorge / Vero |

---

## 10. Git State (entry point)

```
e842ff0  Add STATUS.md — team-facing project brief
e61e428  Switch RDS_GOLDEN_SNAPSHOT to real staging Aurora apzdbstg-hackathon-local
c7e74c2  Pre-code Aurora cluster restore path (auto-dispatch from ARN)
e7cbef8  Wave 4: real data plane — RDS + ECS + ALB per sandbox in POC us-east-1
cd093d8  README: comprehensive local setup for new devs
dc31e5c  HANDOFF: add first-time AWS profile setup (interactive + manual)
93b168c  Clarify summary card: highlight real checkout, hide mock infra
263b3b8  Add HANDOFF.md master prompt for the next dev
3cd2a6c  Wave 3: auth-gated runtime config + real Aplazo loan flow
148ee12  Add direct-CLI deploy path (SCP blocks SAM/S3 in POC)
7d719cc  Add Google SSO gate, narrow integration types, drop unused fields
8f4e122  Scaffold SandboxAgent v1.6: frontend + 7 Lambdas + SAM infra
2b28213  Initial commit
```

Latest: `e842ff0`. All changes on `origin/master`.

---

## 11. Acceptance Criteria

### Hackathon demo (DONE ✅)

A merchant can press "Generate sandbox" and within ~80 seconds:

1. ✅ See a real Aurora cluster + instance creating in POC us-east-1 (`sandbox-<id>-cluster`)
2. ✅ See a real ECS Fargate service running a per-sandbox container in `poc-hackaton-cluster`
3. ✅ See a real ALB listener rule + target group routing `/sandbox-<id>/*` to that service
4. ✅ See a real merchant created in Aplazo dev (real `merchantId`)
5. ✅ See a real loan created on `api.aplazo.net` (real `checkout.aplazo.net/main/<uuid>`)
6. ✅ See the session persisted in DynamoDB
7. ✅ Click the sandbox URL → see the merchant-specific HTML page served from Fargate
8. ✅ Every resource carries the 6 mandatory tags + `sandbox-id`
9. ✅ Reaper deletes everything via `expires=2026-05-30`

### Stretch (post-hackathon)

- **Sub-20-min provisioning** (currently ~80s visible + ~7 min Aurora restore in background)
- **Per-sandbox checkout URL** (`sandbox-<id>.checkout.aplazo.net`) instead of the shared one — see [`URL-STRATEGY.md`](./URL-STRATEGY.md) for the full 6-step plan
- **Destroy sandbox button** for manual cleanup before the reaper
- **Pre-warmed snapshot pool**

---

## 12. Handoff Note

The hackathon project is **demo-complete**. Each per-sandbox AWS resource is real (Aurora cluster from staging snapshot, ECS Fargate service, ALB rule, DynamoDB session), and the agent loop hits real Aplazo APIs (merchant creation + loan creation). The only "shared" part of the user-visible flow is the final Aplazo checkout URL — that's because `api.aplazo.net/loan` returns whatever URL Aplazo's checkout-engine controls, and we don't own that infrastructure.

What's left (section 3) is mostly polish + productionization. The bones are solid.

When in doubt, **try the AWS call** — the error message tells you exactly what's blocked. Workarounds for the SCP issues we hit are documented above.
