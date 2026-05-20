# SandboxAgent — Master Prompt for Continuation

> **Audience:** the next developer (human or AI agent) picking this up.
> **Goal:** finish the data plane (real isolated infrastructure per sandbox)
> in time for the Aplazo Hackathon 2026 presentation.
> **Repo:** https://github.com/aplazo/ai.hackathon26.sandbox-agent
> **Current branch:** `master` · last commit: `3cd2a6c`

---

## 0. READ THIS FIRST — Permissions Reality Check

**Francisco has full AWS permissions to build whatever the project needs.** The previous Claude session repeatedly hedged on "we don't have permissions" / "blocked by SCP" / "DevOps coordination required". **That framing was wrong** and slowed progress. Use this as ground truth:

| Where | What works | What is blocked |
| :-- | :-- | :-- |
| POC account `332730082760` · us-east-1 | **Full write** — IAM, Lambda, APIGW v2, DynamoDB, ECS, RDS, ECR, KMS, CloudWatch, ALB. All require the 6 mandatory tags at creation. | `s3:CreateBucket` and `s3:PutObject` are explicitly denied by SCP. Use Lambda `ZipFile` inline upload (50MB limit) instead of `sam deploy` style S3 bundling. |
| Main account `159200192518` · us-west-1 | **Full read** — RDS DescribeDBSnapshots, ECR DescribeRepositories, ECS DescribeTaskDefinition, Secrets Manager GetSecretValue, etc. Reachable via STS AssumeRole from POC. | Writes require coordination — but Francisco can request the cross-account role himself by running `infra/scripts/create-staging-reader-role.sh` from a profile with IAM rights in main. |
| snx account `754396578028` · us-west-2 (Pulumi sandbox) | Unknown — never probed. Per `node.pulumi-infrastructure/CLAUDE.md`, this is the official Pulumi sandbox env (`aplazo.tech` domain). May be the right home for per-merchant sandboxes. | — |

**Rule of thumb:** when in doubt, **try the AWS call**. The actual response tells you everything. The previous session left `infra/scripts/deploy-direct.sh` as proof — it creates IAM roles, Lambdas, APIGW v2 routes, DynamoDB tables, all with mandatory tags, all working.

**Do not slow down by re-asking permission questions that have already been answered by working code.**

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

The 7 tool Lambdas run in mixed mode (driven by their env vars from `deploy-direct.sh`):

| Lambda | Mode | Reason |
| :-- | :-- | :-- |
| `resolve_snapshot_config` | `MOCK_MODE=true` | Needs cross-account read of main us-west-1 — pending |
| `restore_rds_snapshot` | `MOCK_MODE=true` | Needs cross-region CopyDBSnapshot + cross-account |
| `create_merchant` | `MOCK_MODE=false` | Pure HTTP to us-west-1 merchant Lambda — works |
| `deploy_ecs_services` | `MOCK_MODE=true` | Needs cross-account + ECS in main us-west-1 |
| `configure_merchant` | `MOCK_MODE=true` | Needs the ECS cluster from #4 |
| `validate_sandbox` | `MOCK_MODE=false` | Pure HTTP to `api.aplazo.net` — works, returns real `checkout.aplazo.net` URL |
| `save_session` | `MOCK_MODE=true` | DynamoDB exists; can be flipped to real with one env var change |

`save_session` is the easiest one to flip to real next.

### 2.5 Frontend behavior

- Login screen: brand "aplazo / SandboxAgent" matches MKT Hub pattern
- After login → fetches `/sandbox/config` → stores `runtimeConfig` in closure (NOT on `CONFIG`, NOT on `window`)
- Sandbox creation form: just merchant ref + integration type (only `API` and `API_OFFLINE` are supported)
- ReAct loop calls Anthropic directly from browser with the runtime apiKey + 7 tools defined
- Stepper shows the 7 tools executing
- Summary card shows merchant info, checkout URL, validation checks
- Buttons: Copy URL, Open checkout (opens `checkout.aplazo.net/main/<uuid>` — real but shared), Save as, Fork
- Sessions saved both in localStorage (per-browser) and DynamoDB (server-side)

---

## 3. What's Pending (Your Job)

### 3.1 The core gap

Right now "Visit sandbox" opens the **shared Aplazo checkout** (`https://checkout.aplazo.net/main/<uuid>`), not a per-sandbox isolated instance. The demo narrative breaks here: we sell "isolated sandbox per merchant" but the click goes to shared infrastructure.

You need to implement **real per-sandbox provisioning** so the URL points to that merchant's own infra.

### 3.2 Target URL pattern (per merchant)

```
https://sandbox-{sandbox_id}.checkout.aplazo.net/login/credentials/{loan_uuid}
            └──────────┘                         └──────────────┘
            identifies the sandbox               identifies the checkout session
```

Domain root is `.net` (Aplazo dev domain). Subdomain prefix is `sandbox-{id}.checkout`. Loan UUID is what `/api/loan` already returns.

### 3.3 Architecture target (DevOps view)

```
══════════════════════════════════════════════════════════════════════════════
  DATA PLANE — where each sandbox actually lives
══════════════════════════════════════════════════════════════════════════════

  AWS Main Account · 159200192518 · us-west-1
  ┌─────────────────────────────────────────────────────────────────────┐
  │  STAGING (existing — source of truth)                               │
  │  ├─ RDS:  aplazo-staging-clean (golden snapshot, daily refresh)     │
  │  ├─ ECR:  aplazo/stg-* (built images per microservice)              │
  │  ├─ ECS:  aplazo-stg-cluster + ~120 services (Pulumi-deployed)      │
  │  └─ VPC:  staging VPC w/ ALB, SGs, secrets, transit gateway         │
  │                                                                     │
  │  SANDBOX TENANT (per merchant, ephemeral, tag: sandbox-id=sb_xxx)   │
  │  ┌──────────────────────────────────────────────────────────────┐   │
  │  │  RDS:    sandbox-{id}     (restored from snapshot, in-region) │   │
  │  │  ECS:    sandbox-{id}-cluster + 3 core services               │   │
  │  │  ALB:    reuses staging ALB, host-header routing              │   │
  │  │  DNS:    sandbox-{id}.checkout.aplazo.net → ALB               │   │
  │  │  IAM:    per-sandbox task execution role                      │   │
  │  │  Creds:  merchant_id + api_token (real, from /merchant_creation)│
  │  │  Cleanup: tag expires=YYYY-MM-DD → DevOps reaper deletes      │   │
  │  └──────────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────────┘
                                ▲
                                │ sts:AssumeRole "sandbox-provisioner"
                                │ + Pulumi automation OR AWS SDK
                                │
══════════════════════════════════════════════════════════════════════════════
  CONTROL PLANE — what we built (POC us-east-1, already live)
══════════════════════════════════════════════════════════════════════════════

  AWS POC · 332730082760 · us-east-1
  ┌─────────────────────────────────────────────────────────────────────┐
  │  HTTP API + 8 Lambdas (ReAct loop + tools)                          │
  │  DynamoDB sandboxagent-sessions                                     │
  │  Frontend: aplazo.ai HTML Publisher with Google SSO @aplazo.mx      │
  └─────────────────────────────────────────────────────────────────────┘
```

### 3.4 Concrete tasks (do these in order)

#### Task A — Cross-account provisioner role in main account

In main account `159200192518`, create:

```
Role: sandboxagent-provisioner
Trust:
  - principal: arn:aws:iam::332730082760:role/sandboxagent-lambda-role
  - action: sts:AssumeRole
Permissions:
  - rds:RestoreDBInstanceFromDBSnapshot, rds:CopyDBSnapshot,
    rds:DescribeDBSnapshots, rds:DescribeDBInstances, rds:AddTagsToResource
  - ecr:DescribeRepositories, ecr:DescribeImages
  - ecs:CreateCluster, ecs:CreateService, ecs:RegisterTaskDefinition,
    ecs:DescribeServices, ecs:DescribeTaskDefinition, ecs:ListTaskDefinitions,
    ecs:UpdateService
  - elbv2:CreateRule, elbv2:CreateTargetGroup, elbv2:DescribeLoadBalancers,
    elbv2:DescribeListeners, elbv2:DescribeTargetGroups
  - route53:ChangeResourceRecordSets, route53:ListHostedZones,
    route53:ListResourceRecordSets
  - iam:PassRole on roles tagged with project=sandboxagent
  - logs:CreateLogGroup, logs:CreateLogStream, logs:PutLogEvents
  - secretsmanager:GetSecretValue on hackathon/* secrets
  - kms:Decrypt, kms:CreateGrant, kms:DescribeKey
Tags (mandatory at creation):
  project=sandboxagent, team=sandboxagent, squad=developer-experience,
  owner=francisco.lanuza@aplazo.mx, expires=2026-05-30, environment=hackathon26
```

The script `infra/scripts/create-staging-reader-role.sh` is a template — extend it to attach these write permissions and re-run from a profile with IAM rights in main account. Note: the previous deploy left this script as a READ-only template; you'll need to expand the inline policy block.

#### Task B — DNS setup (Route53 main account)

```
Hosted zone: aplazo.net (likely already exists)
Record set:
  Name:   *.checkout.aplazo.net.
  Type:   A (alias)
  Target: ALIAS → staging ALB in us-west-1 (find via aws elbv2 describe-load-balancers)
  TTL:    60 seconds (allow fast updates while iterating)
```

ACM cert: confirm a `*.checkout.aplazo.net` wildcard cert exists (`aws acm list-certificates`). If not, request one (DNS-validated).

#### Task C — Rewrite the 5 mock Lambdas to real

For each of `resolve_snapshot_config`, `restore_rds_snapshot`, `deploy_ecs_services`, `configure_merchant`, `save_session`:

1. Flip `MOCK_MODE=false` in `deploy-direct.sh` for that Lambda
2. Wire `STAGING_READER_ROLE_ARN=arn:aws:iam::159200192518:role/sandboxagent-provisioner` env var
3. Update the existing code path that's already there (each Lambda has a "real" branch behind `if (MOCK_MODE)` — the AWS SDK calls are written, just gated)
4. The shared helper `backend/lambdas/shared/aws.js` already has `clientForStaging()` that handles STS AssumeRole. Use it.

Special handling:

- `restore_rds_snapshot`: cross-region copy us-west-1 → us-east-1 is already in the code, but consider switching to **in-region** restore in main us-west-1 instead (faster, no copy needed). The PRD assumed POC us-east-1 was the target; the correct DevOps architecture (per `HANDOFF.md` section 3.3) is main us-west-1.
- `deploy_ecs_services`: the existing code clones task definitions from the staging cluster cross-account. Verify the clone target is the staging cluster's ARN, not a POC cluster.
- After ECS create, you need to: create ALB target group, register the ECS service with it, create listener rule with host-header `sandbox-{id}.checkout.aplazo.net`, and create the Route53 record. None of this exists yet — it's the biggest piece of work.

#### Task D — Update the URL the frontend shows

In `frontend/sandboxagent-demo-may2026.html`:

1. The `executeTool` summary card currently shows `${d.sandboxBaseUrl}` from `deploy_ecs_services` output. Update the Lambda to return `sandboxBaseUrl: https://sandbox-{id}.checkout.aplazo.net` (real URL once Route53 is wired).
2. The checkout URL from `validate_sandbox` should keep the loan UUID. Final URL pattern:
   `${sandboxBaseUrl}/login/credentials/${loanUuid}` or however the sandbox-hosted checkout app routes.
3. Remove the "live"/"mock" distinction once Task C is done — the URL is real, period.

#### Task E — Tag everything, hook the reaper

All resources created by the Lambdas must carry the 6 mandatory tags. The helper `backend/lambdas/shared/tags.js` already returns the right list. Use it everywhere.

Confirm with DevOps that the existing reaper (or write a new one) handles RDS, ECS, ALB rules, target groups, and Route53 records — not just Lambda + DynamoDB.

#### Task F — End-to-end smoke test

```
1. Provision a sandbox via the UI
2. Verify in main us-west-1: new RDS instance, new ECS service, new ALB rule, new Route53 record
3. Open the URL from the summary card
4. Confirm the page is served by the sandbox's ECS (not shared staging)
5. Run a /api/loan against the sandbox-hosted checkout API
6. Verify the loan lands in the sandbox's RDS, not staging's
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
│       └── fetch_config/ .................. auth-gated config endpoint (NEW in wave 3)
└── infra/
    ├── template.yaml ...................... SAM template (NOT USED — SCP blocks S3, kept for reference)
    ├── samconfig.toml.example
    ├── samconfig.toml ..................... gitignored — has BackendToken + PocAccountId
    ├── policies/
    │   ├── lambda-trust-policy.json
    │   └── lambda-execution-policy.json ... add the new permissions for Task A here
    ├── scripts/
    │   ├── create-staging-reader-role.sh .. extend for Task A
    │   └── deploy-direct.sh ............... THE deploy script (NOT sam deploy)
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

### 5.6 AWS auth

```bash
aws sso login --profile hackathon-poc
aws sts get-caller-identity --profile hackathon-poc   # should return account 332730082760
```

For main account writes (Task A), Francisco needs a separate profile with IAM write rights. Probably `aplazo-apz` if that has sufficient privileges.

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
- **Anthropic call from browser, not backend proxy.** The frontend talks to `api.anthropic.com` directly using the runtime-fetched key. Backend proxy was considered and rejected for hackathon (~1h refactor). Revisit post-hackathon if you want stronger key protection.
- **Frontend gate only for Google auth (not backend JWT verify on every tool call).** Each tool call uses the BackendToken (Bearer). The Google JWT is only verified at `/sandbox/config` time. This is documented in the security model.
- **Integration types narrowed to API + API_OFFLINE.** The PRD listed 14; we cut to 2 because the others aren't being demoed.
- **Mock fields (`credit_state`, `payment_outcome`, `extra_prompt`) removed entirely.** Don't add them back to the UI.
- **HTML Publisher = Aplazo Cognito-gated CDN at `aplazo.ai`.** The HTML is published via `/html-publisher` in Claude Cowork. Republish after frontend changes.

---

## 8. Open Questions to Resolve Early

1. **Where does the data plane actually live: main us-west-1 or snx us-west-2?** Both are viable. Pick one with DevOps and commit. The architecture diagram above assumes main us-west-1 (in-region with staging).
2. **What's the existing `aplazo-stg-cluster` policy on multi-tenant Fargate services?** Adding sandboxes to the same cluster may need a separate capacity provider. Or use a dedicated `sandboxagent-cluster` in the same VPC.
3. **What's the ALB listener priority numbering convention?** Sandbox rules need unique priorities. Coordinate with DevOps on a range (e.g., 9000-9999).
4. **Wildcard ACM cert `*.checkout.aplazo.net`:** does it exist, or do we need to request one? Check via `aws acm list-certificates --profile <main-profile> --region us-west-1`.
5. **Loan UUID routing inside the sandbox:** does the checkout app key off the URL path, the Host header, or session cookie? Affects how the sandbox-hosted checkout app discovers which merchant config to use.

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
3cd2a6c  Wave 3: auth-gated runtime config + real Aplazo loan flow
148ee12  Add direct-CLI deploy path (SCP blocks SAM/S3 in POC)
7d719cc  Add Google SSO gate, narrow integration types, drop unused fields
8f4e122  Scaffold SandboxAgent v1.6: frontend + 7 Lambdas + SAM infra
2b28213  Initial commit
```

The codebase is consistent at `3cd2a6c`. All wave-3 changes are pushed to `origin/master`.

---

## 11. Acceptance Criteria

Done = **a merchant can press "Visit Sandbox" and land on a URL that:**

1. Hostname is `sandbox-{id}.checkout.aplazo.net` (resolves via Route53)
2. Serves traffic from an ECS service that **only this sandbox** owns (verify in CloudWatch logs — the service should have no other clients)
3. Reads/writes to an RDS instance that **only this sandbox** owns (verify in RDS console — instance ID matches `sandbox-{id}`)
4. Completes a `/api/loan` against that sandbox's checkout API and the loan record lands in that sandbox's RDS, not staging's
5. The 6 mandatory tags are present on every created resource
6. After `expires` date, the reaper deletes all of it without manual intervention

Stretch:
- Sub-20-minute provisioning time
- "Destroy sandbox" button in UI that triggers manual cleanup
- Pool of pre-warmed snapshots to skip the restore wait

---

## 12. Handoff Note

The previous Claude session repeatedly framed permissions as the blocker. **They are not** — Francisco has the access needed. The only confirmed SCP blocks are on S3 in the POC account (worked around by direct Lambda upload). If you find yourself blocked on a permission, **try the AWS call first**; the error message will tell you exactly what to fix. Then update this doc with whatever you learn so the next person doesn't repeat the loop.

Good luck. The agent + auth + deploy pipeline are solid. The data plane is the last 60% of the work but unblocks the demo narrative entirely.
