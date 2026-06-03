# Production Deployment Design — SandboxAgent / Merchant Sandbox

> **Status:** Proposed · **Author:** Argel Bejarano · **Date:** 2026-06-03
> **Audience:** DevOps (prospective owners), Platform, Security
> **Companion docs:** [`HANDOFF.md`](./HANDOFF.md) (canonical history), [`SANDBOX-ENVIRONMENT-DESIGN.md`](./SANDBOX-ENVIRONMENT-DESIGN.md) (the shared-env decision), [`REFACTOR-BACKLOG.md`](./REFACTOR-BACKLOG.md), [`URL-STRATEGY.md`](./URL-STRATEGY.md)

---

## 0. Scope — there are two systems, not one

This repo contains **two deployable systems** that the word "sandbox" has been hiding (HANDOFF §13). Production means different things for each, so this doc is split into two tracks and never blends them.

| Track | System | Production posture |
| :-- | :-- | :-- |
| **A** | **Shared merchant sandbox environment** — one always-on, multi-tenant (`merchant_id`) env, Stripe "test-mode" model. *Does not exist yet — Phase 0.* | **The merchant-facing production deliverable.** Greenfield Pulumi. Build it right. |
| **B** | **Agent control plane** — 8 Lambdas + browser ReAct loop that provisions ephemeral per-merchant stacks from an NL prompt. *Exists, demo-complete.* | **Internal tooling only.** Lightweight hardening so it's safe to keep, **not** the merchant path. Do not scale-engineer it. |

**Non-negotiable framing:** per-merchant Aurora is linear-cost and untenable at "all merchants"; the agent leaks secrets to the browser (S1) and is client-orchestrated (S4). Choosing the shared model (D1) makes S1/S3/S4 moot. We do **not** productionize Track B as the merchant path — we productionize Track A and demote Track B.

**Orchestration decision:** Lambda (control plane) + **ECS Fargate** (data plane) is the right fit and stays. EKS is offered only as a fallback (§6.4) if an org standard mandates it — I'd argue against introducing a cluster to run one stateless container.

**Observability decision:** **Datadog** is the system of record (Aplazo is a DD shop). CloudWatch remains the AWS-native source; DD ingests it. See §7.

---

# TRACK A — Shared Sandbox Environment (the deliverable)

## 1. Infrastructure architecture

```
                          INTERNET
                              │
            ┌─────────────────▼──────────────────┐
            │  Route53  sandbox-api.aplazo.{net}  │   (DNS owned in the
            │           sandbox.checkout.aplazo.* │    sandbox account)
            └─────────────────┬──────────────────┘
                              │  ACM (wildcard, DNS-validated)
                     ┌────────▼─────────┐
                     │   AWS WAF        │  managed rules + per-merchant rate limit
                     └────────┬─────────┘
                     ┌────────▼─────────┐
                     │  ALB (HTTPS:443) │  one shared ALB, host/path routing
                     └────────┬─────────┘
        ┌──────────────────────┼───────────────────────┐
        │                      │                        │
 ┌──────▼──────┐      ┌────────▼────────┐      ┌────────▼────────┐
 │ sandbox-api │      │ sandbox-checkout│      │  admin / status │
 │  (Fargate)  │      │   (Fargate)     │      │   (Fargate)     │
 │ real svc    │      │ real engine,    │      │  Cognito-gated  │
 │ slice, prod │      │ sandbox mode    │      │                 │
 │ release pin │      │                 │      │                 │
 └──────┬──────┘      └────────┬────────┘      └─────────────────┘
        │                      │
        │   ┌──────────────────┴───────────────────────────┐
        │   │  SIMULATORS (the contract boundary — fakes)   │
        │   │   decisioning · KYC · SMS · payment rails     │
        │   │   magic amounts/IDs → approve/decline/error   │
        │   └────────────────────────────────────────────────┘
        │
 ┌──────▼───────────────────────────────────────────────────┐
 │  DATA TIER  (isolated, NO peering to prod/staging data)   │
 │   Aurora PostgreSQL (multi-AZ), SYNTHETIC seed only       │
 │   ElastiCache / Redis (sessions, rate counters)           │
 │   Secrets Manager (per-merchant test creds, rotation)     │
 └───────────────────────────────────────────────────────────┘

  ISOLATED VPC · 3 AZ · private subnets for app+data · NAT for egress allowlist
  HARD INVARIANT (D5): egress allowlist makes real money/KYC/SMS rails
                       physically unreachable — enforced at SG/NACL + config.
```

**Key properties**
- **One VPC, dedicated, no VPC peering / no Transit Gateway route to prod or staging data.** This is the structural enforcement of D4/D5 — synthetic data only, real rails unreachable.
- **Multi-tenant by `merchant_id`** at the app layer (prod is already partitioned this way), not infra-per-merchant. Flat cost.
- **3 AZs**, Aurora multi-AZ writer + reader, Fargate services spread across AZs.
- **Egress allowlist via NAT + SG**: outbound only to the merchant test-webhook endpoints and AWS APIs. Production payment/KYC/SMS hostnames are *not* in the allowlist — a config typo cannot spend real money.
- **Region/account-agnostic Pulumi (D7):** POC us-east-1 acceptable today, but POC has hostile SCPs (no S3) and `expires=` reaper tags built for throwaway infra. **Strong recommendation: request a dedicated Aplazo-managed `sandbox` account** so the env isn't living on borrowed throwaway infra. Migration becomes a config flip, not a rebuild.

### 1.1 Pulumi project layout

```
infra-pulumi/
├── Pulumi.yaml
├── Pulumi.sandbox-prod.yaml      # stable, merchant-facing
├── Pulumi.sandbox-staging.yaml   # our own pre-prod for the sandbox env itself
├── index.ts                      # stack entrypoint
├── components/
│   ├── network.ts        # VPC, subnets, NAT, egress allowlist, SGs, NACLs
│   ├── data.ts           # Aurora (multi-AZ), Redis, subnet groups, KMS
│   ├── secrets.ts        # Secrets Manager + rotation lambdas
│   ├── services.ts       # ECS cluster, Fargate services, task defs, autoscaling
│   ├── edge.ts           # ALB, ACM, WAF, Route53, listener rules
│   ├── simulators.ts     # decisioning/KYC/SMS/rails fakes (Fargate or Lambda)
│   ├── observability.ts  # log groups, DD forwarder, alarms, dashboards
│   └── tags.ts           # the 6 mandatory tags (reuse from backend/lambdas/shared/tags.js)
└── README.md
```

Reuse from the hackathon repo (per design doc §9): the **6-mandatory-tag discipline**, the `checkout-app` container scaffold, ECS/ALB wiring learnings, the `shared/` helper patterns.

## 2. Deployment workflow — the release-promotion discipline (D3)

This is the **single most important long-term practice** (design doc §8, risk #1: drift is existential). The sandbox env must track *prod* releases, never internal/dev branches — that's the direct fix for "staging is broken by internal deploys."

```
  prod release tag (e.g. checkout-engine v2.4.1, immutable, signed)
        │
        │  promotion event (NOT a rebuild — promote the exact prod artifact)
        ▼
  sandbox-staging  ── automated smoke + contract tests ──┐
        │                                                │ pass
        ▼                                                ▼
  sandbox-prod  ◄── manual approval gate (DevOps) ── canary 10% → 100%
```

- **Immutable artifacts.** The sandbox runs the *same image digest* prod ran. No "rebuild from source for sandbox" — that reintroduces drift.
- **Pin, don't follow.** Sandbox config records `pinned_prod_release: v2.4.1`. A scheduled "promotion PR" bumps the pin; a human merges. Internal `main` churn never touches sandbox.
- **Parallel-run cutover (design doc §7 Phase 3):** sandbox runs *alongside* staging during a deprecation window. Not a hard switch. Partner comms is a project, not a flag flip.

## 3. CI/CD pipeline (Track A)

Two pipelines: **infra** (Pulumi) and **release-promotion** (app artifacts).

### 3.1 Infra pipeline — `.github/workflows/infra.yml`

```yaml
name: infra-pulumi
on:
  pull_request: { paths: ['infra-pulumi/**'] }
  push: { branches: [main], paths: ['infra-pulumi/**'] }

permissions:
  id-token: write          # OIDC → AWS, no long-lived keys
  contents: read
  pull-requests: write

jobs:
  preview:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<SANDBOX_ACCT>:role/gha-pulumi-preview
          aws-region: us-east-1
      - uses: pulumi/actions@v5
        with: { command: preview, stack-name: sandbox-staging }
        env: { PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }} }
      # posts the plan as a PR comment for review

  deploy-staging:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: sandbox-staging        # GH environment, no approval
    steps: [ ... pulumi up --stack sandbox-staging ... ]

  deploy-prod:
    needs: deploy-staging
    runs-on: ubuntu-latest
    environment: sandbox-prod           # GH environment WITH required reviewers
    steps: [ ... pulumi up --stack sandbox-prod ... ]
```

Guardrails: **OIDC federation** (no static AWS keys in GitHub), `pulumi preview` on every PR posted as a comment, **required reviewers** on the `sandbox-prod` GitHub Environment, drift detection on a schedule (`pulumi preview --expect-no-changes` nightly → alert if dirty).

### 3.2 Release-promotion pipeline — `.github/workflows/promote.yml`

```yaml
name: promote-release
on:
  workflow_dispatch:
    inputs:
      prod_release: { description: 'Prod release tag to pin', required: true }

jobs:
  promote:
    runs-on: ubuntu-latest
    steps:
      - name: Resolve prod image digest      # pin by digest, never :latest
        run: echo "DIGEST=$(crane digest <prod-ecr>/checkout-engine:${{ inputs.prod_release }})" >> $GITHUB_ENV
      - name: Open promotion PR              # bumps pinned_prod_release in Pulumi config
      # merge → infra.yml deploys staging → smoke → prod approval → canary
```

CI quality gates carried from the existing CLAUDE.md tooling conventions: `tsc`, `lint`, unit tests, and **contract tests against the integration contract** (Phase 0 output) — the contract test is what catches drift before merchants do.

## 4. Monitoring, reliability & scaling (Track A) — see §7 for the shared Datadog detail

- **SLOs:** sandbox-api availability 99.5% (it's a test env, not prod — be honest), p95 latency, checkout success rate. Error budget burn alerts.
- **Per-merchant metrics:** request volume, error rate, rate-limit hits — tagged `merchant_id`. This is how you spot one merchant's load test before it's a problem (the original staging noisy-neighbor pain).
- **Reliability:** Aurora multi-AZ + reader, Fargate min 2 tasks/AZ, ALB health checks, circuit breaker on ECS deploys (`deploymentCircuitBreaker: rollback`), graceful drain.
- **Scaling:** Fargate target-tracking autoscaling on CPU/req-count; Aurora reader auto-scaling; per-merchant rate limits at WAF cap noisy neighbors *structurally*.
- **Data hygiene:** scheduled reseed/reset job (synthetic data) — `expires`-style TTL on synthetic merchant data, nightly reset to a known-good baseline.

---

# TRACK B — Agent as Internal Tooling (harden what exists)

The agent stays useful for spinning **throwaway isolated stacks** (e.g. testing a breaking API change). It must be *safe*, not *scalable*. Scope hardening to that.

## 5. What to fix (and explicitly what not to)

| Item | Action | Source |
| :-- | :-- | :-- |
| **S2 — fail-closed auth** | ✅ Already shipped (`checkBearer` fails closed when `BACKEND_TOKEN` unset). Keep. | PR #2, REFACTOR-BACKLOG |
| **Secrets in `/tmp` & env vars** | Move `ANTHROPIC_API_KEY` / `BACKEND_TOKEN` to **Secrets Manager**; Lambdas read at cold start via the AWS extension. Kill `/tmp/sandboxagent-*.txt`. | HANDOFF §2.3 |
| **Anthropic key reaches browser** | Add a thin **proxy Lambda** so the key never leaves AWS (~30 min, HANDOFF §3.2). Even for internal tooling this is the right default. | HANDOFF §3.2 |
| **Long-running Aurora restore vs 30s API GW limit** | Replace fire-and-poll-short with **Step Functions** (Standard) — proper orchestration of the ~5-7 min restore. Frontend polls execution status. | HANDOFF §3.2 |
| **Manual deploys** | GitHub Actions wraps `deploy-direct.sh` on merge to `master` (see §5.1). | HANDOFF §3.2 |
| **Destroy button / reaper** | Ship the manual-destroy Lambda; keep tag-based reaper (`expires`). | HANDOFF §3.2 |
| **DON'T** scale per-merchant Aurora, add HA, or chase merchant-facing SLAs | Out of scope. This is internal tooling. | Design doc §2 |

## 5.1 CI/CD for the agent — `.github/workflows/deploy-agent.yml`

The constraint that shapes everything: **POC SCP blocks S3** → no SAM → `deploy-direct.sh` uses inline Lambda `ZipFile`. CI just runs that script under OIDC.

```yaml
name: deploy-agent
on:
  push: { branches: [master], paths: ['backend/**', 'infra/**', 'checkout-app/**'] }

permissions: { id-token: write, contents: read }

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cd backend && npm ci && npm test     # unit tests on shared/ helpers
      - run: cd backend && npx tsc --noEmit || true
      # NOTE: do NOT bundle node_modules — runtime ships @aws-sdk v3 (HANDOFF §6.4)

  deploy:
    needs: test
    runs-on: ubuntu-latest
    environment: hackathon-poc          # required reviewer = manual gate
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}   # repo variable, not a hardcoded ARN
          aws-region: us-east-1
      - name: Pull secrets from Secrets Manager   # replaces /tmp files
        run: |
          echo "BACKEND_TOKEN=$(aws secretsmanager get-secret-value --secret-id sandboxagent/backend-token --query SecretString --output text)" >> $GITHUB_ENV
          echo "ANTHROPIC_API_KEY=$(aws secretsmanager get-secret-value --secret-id sandboxagent/anthropic-key --query SecretString --output text)" >> $GITHUB_ENV
      - name: Deploy
        run: cd infra && ./scripts/deploy-direct.sh   # already idempotent (HANDOFF §6.6)
      - name: Smoke test
        run: |
          curl -fsS -X POST "$API_URL/resolve-snapshot" \
            -H "Authorization: Bearer $BACKEND_TOKEN" \
            -H 'Content-Type: application/json' \
            -d '{"merchant_id":"smoke_test"}' || exit 1
```

Migrate secrets to Secrets Manager **first** — otherwise CI has nowhere to read them from (the `/tmp` files are a single-laptop artifact and a CI blocker).

---

# CROSS-CUTTING

## 6. Docker / container & orchestration setup

### 6.1 Harden the container (`checkout-app/Dockerfile`)

Current image is fine for a demo but not production. Changes:

```dockerfile
# multi-stage; pin by digest not tag; non-root (already USER node ✓); healthcheck; tini
FROM public.ecr.aws/docker/library/node:24-alpine@sha256:<pin> AS base
WORKDIR /app
COPY package.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY index.js ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "index.js"]
```
- **Pin base by digest** (supply-chain), `npm ci` not silent copy, add a `/health` endpoint the ALB target group hits, drop capabilities, read-only root FS at the task-def level.
- **Image scanning:** ECR scan-on-push + block deploy on CRITICAL (Trivy in CI).

### 6.2 ECS Fargate task definition essentials
- `deploymentCircuitBreaker: { enable: true, rollback: true }` — failed deploys auto-roll back (downtime risk ↓).
- `minimumHealthyPercent: 100`, `maximumPercent: 200` — rolling deploy, zero-downtime.
- 2+ tasks across AZs, target-tracking autoscaling, ALB health check + connection draining.
- Datadog agent as a **sidecar** (or ECS Fargate trace/log via the DD container) for APM.

### 6.3 Build pipeline (POC S3 constraint)
The repo built images via **AWS CodeBuild + NO_SOURCE + inline base64** because the author had no local Docker and Docker Hub is rate-limited from CodeBuild (use `public.ecr.aws/docker/library/node:24-alpine`). In a real account: GitHub Actions → `docker buildx` (arm64) → push to ECR by digest → ECS deploy. CodeBuild stays the fallback where S3/local-Docker is blocked.

### 6.4 EKS fallback (only if org-mandated)
I recommend **against** EKS here — one stateless container does not justify a cluster's operational tax. If an Aplazo platform standard forces it: 1 Deployment + HPA + Service + Ingress (ALB controller) + ExternalSecrets (→ Secrets Manager) + Karpenter for nodes, Helm chart per service, ArgoCD for GitOps promotion. The release-promotion discipline (§2) maps cleanly onto ArgoCD app-of-apps. But Fargate gives you the same outcome with far less to operate.

## 7. Monitoring strategy (Datadog)

CloudWatch stays the AWS-native source of truth; **Datadog is the on-call surface and system of record.** Wire via the Datadog AWS integration + Lambda Forwarder for logs.

**Instrumentation**
- **APM/traces:** `dd-trace` in Lambdas (Datadog Lambda extension layer) and the Fargate services. Trace the full provision/checkout path end-to-end.
- **Logs:** structured JSON from every Lambda/container → CW → DD Forwarder → DD Logs, pipelines parse `merchant_id`, `sandbox_id`, `session_id`.
- **Metrics:** custom metrics on provision duration, Aurora restore time, ECS `runningCount`, per-merchant request/error rates. Cost-per-sandbox via the `sandbox-id` tag (HANDOFF §3.2).

**Monitors (alerting)** — minimum set:
| Monitor | Condition |
| :-- | :-- |
| Provision failure rate | >10% of agent runs error over 15m |
| Stuck provisioning | Step Function execution running >15m |
| API 5xx | sandbox-api 5xx rate > threshold (per-merchant breakdown) |
| Aurora health | CPU / connections / replica lag (Track A) |
| ECS deploy rollback | circuit breaker fired |
| WAF rate-limit spike | one `merchant_id` hammering (the noisy-neighbor signal) |
| Egress-allowlist denial | **any** attempt to reach a real money/KYC/SMS host → page (D5 invariant breach) |
| Cost anomaly | DD cost monitor on the sandbox account |

**Dashboards:** (1) Provisioning funnel — agent step success/latency; (2) Shared-env health — SLO/error-budget, per-merchant table; (3) Cost-per-sandbox / per-merchant; (4) Security — auth failures, WAF blocks, egress denials.

**SLOs in Datadog:** sandbox-api 99.5% availability, checkout-success-rate, with error-budget burn-rate alerts. Tie to `incident.io` (MCP available) for on-call.

## 8. Reliability & downtime-risk reduction (summary)
- **Zero-downtime deploys:** ECS rolling + circuit-breaker rollback; Lambda alias + canary (`AllAtOnce`→`Canary10Percent5Minutes`) via CodeDeploy.
- **Blast-radius isolation:** dedicated VPC, no prod peering, egress allowlist — a sandbox failure can't touch prod.
- **Stateful safety:** Aurora multi-AZ + automated backups + PITR (Track A); DynamoDB PITR (Track B sessions).
- **Idempotent + reversible:** `deploy-direct.sh` is already idempotent; Pulumi gives plan/preview + rollback.
- **Drift detection:** nightly `pulumi preview --expect-no-changes`; DD monitor on config drift.

---

## 9. Production deployment checklist

### Pre-deploy — foundations
- [ ] **Account decision made:** dedicated Aplazo `sandbox` account requested, or POC us-east-1 accepted with migration debt logged (design doc §5).
- [ ] Phase 0 **integration contract** enumerated (the gate for everything — design doc §7).
- [ ] Pulumi project bootstrapped; state backend chosen (Pulumi Cloud / S3+DynamoDB lock).
- [ ] **OIDC** GitHub↔AWS roles created (`gha-pulumi-*`, `gha-sandboxagent-deploy`); zero static keys in GitHub.
- [ ] **6 mandatory tags** enforced in Pulumi (`project, team, squad, owner, expires, environment`) — fix the stale `owner=francisco.lanuza` / `expires=2026-05-30` in `deploy-direct.sh`.

### Security
- [ ] Secrets in **Secrets Manager**, rotation enabled; `/tmp/sandboxagent-*.txt` deleted everywhere.
- [ ] **S2 fail-closed auth** verified in deployed env (not just merged).
- [ ] Anthropic key **proxied** — never reaches the browser.
- [ ] WAF + per-merchant rate limits live on public endpoints (Track A).
- [ ] **Egress allowlist** proven: integration test asserts real money/KYC/SMS hosts are unreachable (D5).
- [ ] No VPC peering / TGW route from sandbox VPC to prod or staging data.
- [ ] Cognito/SSO on any admin/agent UI (not just client-side GIS — HANDOFF §3.2).
- [ ] Synthetic seed only; staging snapshot `apzdbstg-hackathon-local` **retired** for this purpose (D4 — compliance).
- [ ] Container images scanned (ECR + Trivy), base pinned by digest, non-root.

### Reliability & data
- [ ] Aurora multi-AZ + automated backups + PITR; restore tested.
- [ ] ECS circuit-breaker rollback + min 2 tasks/AZ + health checks + draining.
- [ ] Autoscaling policies set (Fargate target-tracking, Aurora readers).
- [ ] Synthetic-data reseed/reset job scheduled and verified.
- [ ] DynamoDB PITR on `sandboxagent-sessions` (Track B).

### CI/CD
- [ ] Infra pipeline: `pulumi preview` on PR, required reviewers on `sandbox-prod`, nightly drift check.
- [ ] **Release-promotion** pipeline promotes prod artifacts by **digest** (D3) — no rebuild-for-sandbox.
- [ ] Agent deploy pipeline wraps `deploy-direct.sh`; does **not** bundle `node_modules`.
- [ ] Smoke + contract tests gate every promotion.

### Observability
- [ ] Datadog AWS integration + Lambda Forwarder wired; APM tracing on Lambdas + Fargate.
- [ ] Monitors from §7 created (incl. egress-denial pager and stuck-provisioning).
- [ ] SLOs + error-budget burn alerts defined; routed to `incident.io`.
- [ ] Cost-per-merchant / per-sandbox dashboard live.
- [ ] Runbooks written for: stuck provisioning, failed promotion, Aurora failover, egress-invariant breach.

### Cutover (Track A)
- [ ] Sandbox runs **in parallel** with staging during a deprecation window (not a hard switch — design doc §7 Phase 3).
- [ ] Per-merchant test credentials issued + rotation documented.
- [ ] Integration docs updated; **partner comms** plan executed (risk #2).
- [ ] Staging access revoked only after parallel-run validation.

---

## 10. Sequencing (what to do first)

1. **Phase 0 contract** (3 days, blocking) — without it, Track A is guesswork.
2. **Track B quick wins in parallel** (low risk, immediate value): Secrets Manager migration → agent CI/CD → Step Functions → fix stale tags. These also de-risk the laptop-dependency (`/tmp` secrets, manual deploy) today.
3. **Track A skeleton** (Pulumi VPC + data + thin service slice) once the contract is known.
4. **Edge + safety** (WAF, ACM, egress invariant, simulators).
5. **Cutover** (parallel-run + partner comms).

> The agent (Track B) is the *demo*; the shared env (Track A) is the *product*. Spend production effort accordingly.
