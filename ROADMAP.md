# SandboxAgent — Post-Hackathon Roadmap

> **If we win the Hackathon 2026 Developer Experience track**, this is what we build next. Phased by time horizon, dependency, and business value. Each item has a concrete deliverable, effort estimate, and exit criteria.

---

## Vision

SandboxAgent becomes the **default way Aplazo engineers, QA, and integration merchants spin up isolated staging environments**. No more wiki pages, no more "ask Slack who set it up last", no more 4-hour manual setups. One prompt → one URL in <30 seconds → tested end-to-end against real merchant credentials.

**Three audience expansions over time:**

1. **Internal engineering** (hackathon scope) — engineers and QA test integrations
2. **External integration merchants** — Walmart, AliExpress, etc. self-serve their own sandboxes for e2e testing
3. **Aplazo product teams** — Risk, Underwriting, Collections all get their own per-purpose sandboxes (different snapshot sources, different seeded scenarios)

---

## Where we are today (post-hackathon state)

✅ **Demo-complete data plane in POC us-east-1**
- 8 Lambdas, real Aurora cluster per sandbox, real ECS Fargate, real ALB rule, real DynamoDB sessions
- Real merchant creation against `api.aplazo.net` (us-west-1 Lambda) + real loan via Online API
- ~80s visible provisioning + ~7 min async (Aurora restore)
- All resources tagged with `expires=2026-05-30` — DevOps reaper handles cleanup

⚠️ **Known gap (intentional, see [`URL-STRATEGY.md`](./URL-STRATEGY.md))**: the sandbox URL is `http://apz-poc-hackaton-...elb.amazonaws.com/sandbox-<id>/` — functional, but not the production target `https://sandbox-<id>.checkout.aplazo.net/...`. Cross-site permissions out of hackathon scope.

🎯 **What winning enables**: DevOps prioritization, budget for AWS resources, a dedicated dev allocation (1 person ~4 weeks). With that, the post-win path below is achievable.

---

## Phase 0 — Immediate cleanup (Day 1-2 post-win)

| Item | Effort | Owner | Deliverable |
| :-: | :-: | :-- | :-- |
| Delete test sandboxes (`e2etest40240`, `aurora1305`, `reg2126`) before they cost real $$ | 30 min | Francisco | Empty `aws rds describe-db-clusters --filter sandbox-*` output |
| Document the AWS Console "tour" for judges — links to each created resource so they can verify | 1 h | Francisco | `DEMO-TOUR.md` with deep-links per resource |
| Capture screenshots / a short Loom of the full agent loop running | 1 h | Francisco | `assets/demo.mp4` in repo |
| Slack post in `#hackathon-support-2026` thanking DevOps (Duvan, Brandom) | 5 min | Francisco | (the team that helped is acknowledged) |

**Exit criteria:** the repo has a self-contained "open this and see it work" experience for anyone who didn't see the live demo.

---

## Phase 1 — Branded HTTPS sandbox URL (Weeks 1-2)

Closes the URL gap documented in [`URL-STRATEGY.md`](./URL-STRATEGY.md). Highest-visibility win.

### Goal

`https://sandbox-<id>.sandbox.checkout.aplazo.net/login/credentials/<loan_uuid>` resolves to a per-sandbox HTTPS endpoint with real Aplazo branding.

### Workstreams (parallel)

**1A — DNS delegation** (Effort: 1 day · Owner: DevOps + us)

- DevOps adds NS record in `aplazo.net` zone (main account `159200192518`):
  - `sandbox.checkout.aplazo.net` → 4 nameservers of a new Route53 zone in POC `332730082760`
- We create the Route53 hosted zone `sandbox.checkout.aplazo.net` in POC us-east-1
- Verify resolution: `dig sandbox.checkout.aplazo.net NS`

**1B — ACM wildcard cert** (Effort: 2 hours after 1A · Owner: us)

- Request ACM cert in POC us-east-1: `*.sandbox.checkout.aplazo.net`
- DNS validation: ACM creates the CNAME record automatically in our delegated zone
- Cert reaches `ISSUED` status (~5 min)

**1C — HTTPS listener on ALB** (Effort: 1 hour · Owner: us)

- Add HTTPS:443 listener to the `apz-poc-hackaton` ALB
- Attach the wildcard cert from 1B
- Default action: 503 (since the per-sandbox rules will route from here)
- Keep the HTTP:80 listener for backward-compat / debugging

**1D — Switch from path-pattern to host-header routing** (Effort: 4 hours · Owner: us)

- Modify `deploy_ecs_services` Lambda:
  - Listener rule condition changes from `path-pattern: /sandbox-<id>/*` to `host-header: sandbox-<id>.sandbox.checkout.aplazo.net`
  - Action stays: forward to target group
- For each new sandbox: also create the Route53 A-record (ALIAS) pointing the subdomain to the ALB
- Update `validate_sandbox` + `save_session` outputs to use the new HTTPS URL

**1E — Frontend update** (Effort: 1 hour · Owner: us)

- Summary card uses the new URL pattern
- "Open Sandbox" button opens `https://sandbox-<id>.sandbox.checkout.aplazo.net/`
- Tests: regression on the agent flow

### Exit criteria

- A new sandbox provisioned by the agent has a URL that resolves to HTTPS with a valid cert.
- Clicking the URL serves the existing Fargate welcome page (no checkout-engine yet — that's Phase 2).
- Old `/sandbox-<id>/` path-pattern URL still works for backward compat.

### Total: ~2 days of work, all unblocked once DevOps does the 1A NS record (15 min on their side).

---

## Phase 2 — Real Aplazo checkout-engine running in the sandbox (Weeks 3-4)

Closes the bigger functional gap: today our Fargate task runs a "welcome page" placeholder. The real checkout-engine app lives in main us-west-1 ECR.

### Goal

When a merchant clicks "Open sandbox", they land on the **real Aplazo checkout app**, served by **their own Fargate task**, reading/writing to **their own Aurora cluster** restored from staging data.

### Workstreams

**2A — DevOps mirrors `aplazo/stg-checkout-engine` to POC ECR** (Effort: 1 day · Owner: DevOps)

- Add to `node.pulumi-infrastructure` repo: a new module that replicates the staging checkout-engine image from us-west-1 to POC us-east-1 on each build
- Or: cross-region ECR replication rule (simpler, fully managed)
- Verify: `aws ecr describe-images --repository-name aplazo/sandboxagent-checkout-engine --profile hackathon-poc`

**2B — Update `deploy_ecs_services` to use the real image** (Effort: 2 hours · Owner: us)

- Change `ECR_IMAGE_URI` env var to the mirrored image
- Adjust task definition: CPU/memory based on real checkout-engine requirements (probably 1024 / 2048)
- Adjust port mapping: real checkout-engine likely listens on different ports than 8080

**2C — Pass the sandbox's Aurora endpoint to the container** (Effort: 1 day · Owner: us)

- The real checkout-engine expects DB connection info from env vars (or Secrets Manager refs)
- Update `configure_merchant` Lambda to inject:
  - `DB_HOST = <sandbox-cluster-endpoint>`
  - `DB_USER`, `DB_PASSWORD` (from RDS instance master creds, or a per-sandbox secret)
  - `MERCHANT_ID`, `API_TOKEN` (from `create_merchant` output)
- Verify the container connects, reads merchant config, serves login page

**2D — End-to-end happy path test** (Effort: 1 day · Owner: us)

- Provision sandbox → visit `sandbox-<id>.sandbox.checkout.aplazo.net` → enter test credentials → complete loan flow against the SANDBOX's database (not staging's)
- Verify by inspecting Aurora: the loan record is in `sandbox-<id>-cluster`, not in staging
- Document the test scenario in `DEMO-TOUR.md`

### Risks / unknowns

- The real checkout-engine may have hard dependencies on other Aplazo services (merchant-api, payment-engine, risk-engine, etc.) that ALSO live in us-west-1. If yes, Phase 2 expands to mirror those too — that's a larger DevOps lift, probably another 2 weeks.
- KMS keys for any encrypted secrets the checkout-engine reads — may need cross-account access (which DevOps just resolved for the RDS snapshot, so the pattern is established).

### Exit criteria

- A merchant clicks the sandbox URL and completes a full checkout flow that touches their own isolated AWS resources end-to-end.
- The loan that gets created lands in the sandbox's Aurora cluster (verifiable in the AWS Console).

### Total: ~1 week (1 dev) + ~1 day DevOps. **+1 week buffer for the dependency cascade if checkout-engine pulls in other us-west-1 services.**

---

## Phase 3 — Production hardening (Weeks 5-8)

Once the demo flow is real and branded, harden it for actual day-to-day use by 10+ engineers.

### 3A — Backend proxy for Anthropic API (Effort: 30 min · Owner: us)

- New Lambda `sandboxagent-anthropic-proxy` proxies `api.anthropic.com/v1/messages`
- Anthropic key stays in Lambda env var, never reaches the browser
- Frontend `callAnthropic` calls `POST /sandbox/anthropic` instead of Anthropic directly
- BackendToken auth covers the proxy

**Why now:** the key is currently fetched via `/sandbox/config` post-login, so it's only delivered to authenticated `@aplazo.mx` users — but once delivered it's in browser memory. A backend proxy means it never leaves AWS.

### 3B — Cognito + Google Workspace SSO for the HTML (Effort: 1 day · Owner: us + IT)

- Current state: HTML Publisher already gates the HTML with Aplazo Cognito (we noticed during a curl probe — returns 302 to cognito.amazonaws.com). Good.
- We ADD our own GIS gate on top, which is now redundant.
- **Action:** investigate whether the HTML Publisher Cognito session is exposed in a way our HTML can read (probably a cookie + an `id_token` somewhere accessible). If yes, drop our own GIS layer; reuse the Cognito session for the `/sandbox/config` JWT verify.
- **Fallback:** keep both layers. Not broken, just overkill.

### 3C — Step Functions for long-running provisioning (Effort: 3 days · Owner: us)

- Replace the fire-and-poll-short pattern (25s Lambda budget) with proper Step Functions state machine
- States: `start_aurora_restore` → `wait_for_aurora_available` (poll) → `deploy_ecs` → `wait_for_ecs_running` → `validate` → `save_session`
- Frontend subscribes to Step Functions execution status via API GW WebSocket (or polls a status endpoint)
- Cleaner UX: stepper shows actual real-time progress instead of "creating" → return → background

### 3D — CI/CD pipeline (Effort: 1 day · Owner: us)

- GitHub Actions workflow on merge to `main`:
  1. `node --check` for all Lambdas
  2. Re-zip + `aws lambda update-function-code` for each
  3. (If container changed) trigger CodeBuild
  4. (Optional) post deployment status to Slack
- Use OpenID Connect federation between GitHub and AWS so we don't store AWS keys as GitHub secrets

### 3E — Observability (Effort: 2 days · Owner: us)

- CloudWatch dashboard with:
  - Provisioning rate (sandboxes/hour)
  - Failure rate per tool
  - Per-sandbox cost (estimated from `sandbox-id` tag → resource type)
  - p50/p95/p99 of each tool's latency
- Alarm when:
  - Failure rate > 10% (probably an Aplazo API outage)
  - Sandbox count exceeds 50 (reaper might be backed up)
  - Total cost trends > $100/day

### Exit criteria

- Anthropic key isn't reachable from browser DevTools
- Long Aurora restores have real progress visibility instead of mid-flight returns
- Engineers can ship Lambda changes via PR + merge
- Costs and failures are observable

### Total: ~4 weeks for 1 dev.

---

## Phase 4 — Scale + UX (Weeks 9-12)

Make it self-service for 50+ engineers / merchants / QA. Reduce friction.

### 4A — Pre-warmed snapshot pool (Effort: 3 days · Owner: us)

- Maintain 3 pre-restored Aurora clusters in a "pool" state (always-on, available)
- When a sandbox is requested:
  - Assign one of the pool clusters → tag it with the merchant
  - Provision a replacement in the background
- Provisioning time drops from ~7 min to ~30 seconds
- Trade-off: ~$15/day for 3 idle clusters vs. instant gratification

### 4B — Destroy sandbox button (Effort: 1 day · Owner: us)

- New tool `destroy_sandbox(sandbox_id)` that:
  1. Deletes ECS service + task def
  2. Deletes ALB rule + target group
  3. Deletes Aurora instance + cluster
  4. Removes the Route53 record
  5. Updates DynamoDB session status to `destroyed`
- UI: a "Destroy" button on saved sessions
- Useful before the `expires=2026-05-30` reaper kicks in (some sandboxes are short-lived)

### 4C — Diff between sessions (Effort: 2 days · Owner: us)

- When forking a saved session, show a visual diff of "what changes if I run this with X different"
- Powered by Claude — query "compare these two configs, summarize the difference"
- Helps engineers replicate exact prior bug states

### 4D — Multi-merchant fork (Effort: 1 day · Owner: us)

- Run the same scenario across N merchants in parallel
- Useful for testing a code change against Walmart + AliExpress + Tienda POS simultaneously
- UI: a "Fork to all merchants" button

### 4E — Synthetic user profile mapping (Effort: 1 week · Owner: us + Data team)

- Implement the Mindset Profile mapping from the original Miro design (Mario, Dani, Pao, José, Lulú)
- Each profile has pre-defined credit limit, cart pattern, payment behavior
- Prompt template: "Walmart sandbox, Mario near credit limit, failed first payment" → agent auto-maps Mario → applies the right env vars to the checkout-engine seeded data
- Requires data team to confirm profile parameters match the typology study

### Exit criteria

- Sandbox provisioning < 30 seconds
- Sandbox lifecycle is fully managed by the UI (create / fork / destroy)
- Real customer mindset profiles drive the synthetic users (not arbitrary credit numbers)

### Total: ~4 weeks for 1 dev + ~1 week of data team support.

---

## Phase 5 — Beyond engineering sandboxing (Quarter 2+)

If Phases 1-4 succeed and adoption grows, expand the scope.

### 5A — Open it up to integration merchants

- Each merchant (Walmart, AliExpress, etc.) gets their own SandboxAgent instance branded for them
- They self-serve their own e2e tests without coordinating with Aplazo
- Authentication: SAML federation or merchant-specific JWT tokens
- Auditing: who created which sandbox + what data was generated

### 5B — Other use cases beyond merchants

- **Risk team sandbox:** snapshot of staging w/ specific fraud patterns seeded
- **Underwriting team sandbox:** test rule changes against historical credit decisions
- **Collections team sandbox:** simulate payment recovery flows
- **QA regression sandbox:** scenarios from JIRA tickets auto-provisioned

### 5C — Multi-region (Effort: 2 weeks · Owner: us + DevOps)

- Right now POC us-east-1 is the only region. Aplazo's real staging lives in us-west-1.
- Long-term: SandboxAgent runs IN us-west-1 (where the source data is), eliminating any need to mirror snapshots.
- Requires SCP review on the main account to allow controlled write access from the SandboxAgent role.

### 5D — Angular 20 SPA frontend (Effort: 2-3 weeks · Owner: us)

- Migrate from single-file HTML to Angular 20 SPA (aligns with Aplazo's frontend stack)
- Component library that matches Aplazo's design system
- Better state management (sessions, history, drafts)
- Possible: integrate with Aplazo's internal portal (single sign-on with the rest of internal tools)

### 5E — AI-assisted debugging

- When a sandbox e2e test fails, the agent reads CloudWatch logs from the sandbox's ECS task + Aurora slow query log + ALB access log
- Surfaces the root cause in plain English: "Your loan creation failed because the merchant_id was missing the API_OFFLINE branch — would you like me to provision one?"
- Auto-fix where possible

---

## Quick wins (anytime, parallel)

Things that don't need to wait for a phase, can be tackled in spare time:

| Item | Effort | Value |
| :-- | :-: | :-- |
| Convert the demo HTML to a proper Angular component for inclusion in Aplazo's design portal | 2 days | UI polish + reuse |
| Add Slack notifications when a sandbox is provisioned ("Walmart sandbox `sb_xxx` is ready, click here") | 4 hours | Discoverability for the team |
| Auto-detect when api.aplazo.net is down and gracefully degrade | 2 hours | Demo reliability |
| Open-source a sanitized version (no Aplazo-specific code) as a generic "sandbox-agent" framework | 1 week | Industry positioning |
| Blog post on the engineering blog explaining the architecture | 4 hours | Recruitment + visibility |
| Video walkthrough for new engineers | 2 hours | Onboarding |
| Translation to English UI (currently the prompt + summary are Spanish/English mix) | 4 hours | Internationalization |

---

## Dependencies map

```
Phase 1 (URL)           ───┐
                           ├──→  Phase 2 (real checkout-engine)  ──→  Phase 4 (UX scale)
DevOps: NS record       ───┘                                              ↑
                                                                          │
                                                                  Phase 3 (hardening)
                                                                          ↑
                                                                          │
                                                              (independent of 1+2)


Phase 5 expansions depend on Phase 1-4 being stable.

Quick wins are parallelizable to anything.
```

### Critical path

```
DevOps NS record (1A)
    ↓
ACM cert (1B)             [parallel: us can do this in 5 min once 1A done]
    ↓
HTTPS listener (1C)       [parallel: us]
    ↓
Routing switch (1D)       [parallel: us]
    ↓
DevOps mirror image (2A)  [parallel: DevOps starts as soon as Phase 1 begins]
    ↓
Real checkout-engine (2B-2D)
    ↓
PRODUCTION READY
```

**Bottleneck: DevOps capacity.** 1A and 2A are the only items they touch. If they're available, we're done with the user-visible work in ~3 weeks. Without them, we're stuck regardless of our effort.

---

## Budget estimate

| Item | One-time | Monthly |
| :-- | :-: | :-: |
| AWS resources (Aurora clusters, Fargate, ALB) per 10 active sandboxes | — | ~$200 |
| AWS resources for the control plane (Lambdas + DynamoDB + APIGW) | — | <$10 (free tier) |
| Pre-warmed pool (3 always-on Aurora) | — | ~$45 |
| Domain registration if we go independent (Phase 1 alternative) | $12/year | — |
| ACM certs | $0 (free) | — |
| Anthropic API usage (~5K tokens per sandbox × 100/month) | — | ~$30 |
| **Total monthly at 10 active sandboxes** | | **~$285** |
| **Total monthly at 50 active sandboxes** | | **~$1200** |

These numbers are tiny relative to the 2-4 hours of engineer time saved per sandbox. At 50 sandboxes/month and an engineer-hour cost of $50, the savings are ~$10,000/month vs $1,200 in AWS costs. **8x ROI.**

---

## Success metrics

How we'd know the post-win investment is paying off:

| Metric | Baseline (today) | Target (Quarter 1 post-win) | Target (Quarter 2) |
| :-- | :-: | :-: | :-: |
| Time to ready sandbox | 2-4 hours (manual) | < 1 minute (with pre-warmed pool) | < 30 sec |
| Sandboxes created per month | ~10 (manual) | 100 | 500 |
| Engineers using it | 1-5 (manual) | 30 | 80+ |
| Merchant self-service sandboxes | 0 | 5 (Walmart, AliExpress, ...) | 20+ |
| Demo failure rate (UX errors) | unknown | < 5% | < 1% |
| Cost per sandbox | unknown (engineer hours) | $0.30/hour AWS | $0.10/hour AWS |
| Time from PR merge to deployed | manual | < 5 min (CI/CD) | < 2 min |

---

## Risks

| Risk | Probability | Impact | Mitigation |
| :-- | :-: | :-: | :-- |
| DevOps capacity for Phase 1A/2A doesn't materialize | Medium | High | Escalate via the winning hackathon prize visibility |
| Real checkout-engine has us-west-1 service dependencies | Medium | Medium | Mirror those too OR build a minimal sandbox-checkout reimplementation |
| Cost overruns from forgotten sandboxes | Low | Low | Reaper tag + cost alarms in Phase 3E |
| Aurora cluster restore time scales poorly with snapshot size | Low | Medium | Pre-warmed pool in Phase 4A mitigates |
| Anthropic API rate limits hit at scale | Medium | Low | Backend proxy in Phase 3A adds rate-limit + caching |
| SCP changes break what we built | Low | High | Document SCP IDs we depend on; pin them in writing with DevOps |

---

## Ownership proposal

If SandboxAgent wins:

- **Phase 0**: Francisco, 2 days
- **Phase 1**: Francisco + 1 DevOps eng (intermittent), 2 weeks
- **Phase 2**: Francisco + 1 DevOps eng, 2 weeks (with buffer for service dependency cascade)
- **Phase 3**: Francisco, 4 weeks
- **Phase 4**: Francisco, 4 weeks
- **Phase 5+**: dedicated team allocation needed (probably 2 devs, depending on adoption signals)

**Total: ~3 months for one engineer + ~10% of DevOps to reach production-ready (Phase 1-3), ~6 months to reach the full vision (Phase 4 done).**

---

## Why this is worth doing

- **Developer time saved**: ~2-4 hours per sandbox × 100-500 sandboxes/month = significant productivity recapture
- **QA independence**: no longer blocked on devs for environment setup
- **Merchant onboarding velocity**: integration partners can self-serve, reducing time-to-live for new merchant deals
- **Pattern reusability**: the agent + deploy pipeline becomes a template for OTHER Aplazo internal tools (think: per-developer ephemeral environments for ANY service in the monorepo)
- **Brand**: showcase Aplazo as a place where engineering invests in itself — recruitment + culture signal

---

## References

- [`HANDOFF.md`](./HANDOFF.md) — what's pending, decisions made, constraints
- [`STATUS.md`](./STATUS.md) — current state brief
- [`URL-STRATEGY.md`](./URL-STRATEGY.md) — Phase 1 details, the URL gap
- [`README.md`](./README.md) — local setup
- [`PRD-v1.7-changes.md`](./PRD-v1.7-changes.md) — proposed PRD diff
- Aplazo Pulumi infra repo: `github.com/aplazo/node.pulumi-infrastructure`
- Aplazo Online API: `aplazo.gitbook.io/aplazo-integrations/online-api`

---

*Built by Francisco Lanuza with Claude Code (Opus 4.7). Hackathon 2026 · Developer Experience track.*
