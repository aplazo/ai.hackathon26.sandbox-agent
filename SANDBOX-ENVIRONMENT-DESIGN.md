# Design Doc — Shared Merchant Sandbox Environment

> **Status:** Proposed (awaiting sign-off)
> **Author:** Argel Bejarano · **Date:** 2026-05-31
> **Reviewers:** DevOps (prospective owners), Platform
> **Supersedes the production direction of:** the hackathon per-merchant agent (see [`HANDOFF.md`](./HANDOFF.md))
> **Companion docs:** [`HANDOFF.md`](./HANDOFF.md) (canonical history), [`REFACTOR-BACKLOG.md`](./REFACTOR-BACKLOG.md) (security backlog), [`ROADMAP.md`](./ROADMAP.md)

---

## 1. Problem

Merchants integrating Aplazo currently test against the **staging** environment. This has burned us repeatedly. Confirmed root causes (ranked):

1. **Staging is broken by internal deploys** — internal release cadence makes it flaky/unstable for external partners.
2. **Merchant test traffic destabilizes staging** — noisy-neighbor load degrades the environment internal teams rely on.

Explicitly **not** confirmed as past pains: real downstream side-effects, test-data collisions. (We still treat "no real money/KYC/SMS" as a hard invariant for an externally-reachable environment — see §6 D5.)

**Goal (deliverable 1):** stand up a real sandbox environment and **move all merchants off staging** within ~1 month. Owner: **DevOps**. Iterate on sandbox *behavior* afterward.

---

## 2. Key finding — two different products were hiding under one word

The hackathon repo ("SandboxAgent") and this deliverable are **not the same system**. The shared word *sandbox* masked a product fork:

| | Hackathon system (built) | This deliverable (needed) |
| :-- | :-- | :-- |
| Shape | N **ephemeral, per-merchant** stacks (Aurora cluster + ECS + ALB rule each), provisioned on demand by an **AI agent** from a natural-language prompt | **One shared, always-on** environment all merchants point at |
| Cost curve | Linear in merchants (one Aurora cluster *each*) — untenable at "all merchants" | Flat, multi-tenant by `merchant_id` |
| Ops model | DevOps on-call for an LLM-driven provisioner | DevOps own a standard environment (IaC + CI/CD + dashboards) |
| Seed data | Real staging snapshot (`apzdbstg-hackathon-local`) | Synthetic / anonymized |

**Decision:** build the shared environment as the production deliverable. The hackathon agent is **demoted to optional internal tooling** for spinning up *throwaway* isolated stacks (e.g. testing a breaking API change) — it is **not** in the merchant-facing path.

This choice also **shrinks the security surface**: the Phase 2 backlog items S1 (secrets to browser), S3 (static shared token), S4 (client-driven orchestration) are all properties of the agent control plane and largely cease to apply.

---

## 3. Decisions (confirmed with stakeholder 2026-05-31)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | One shared, always-on sandbox environment, multi-tenant by `merchant_id`. | Matches goal; Stripe/PayPal "test mode" model; DevOps-ownable. |
| D2 | It is an **environment**, not on-demand infra. Standing deployment via Pulumi. | Nobody on-call for an LLM. Agent demoted to internal tooling. |
| D3 | **Own release pipeline, pinned to stable (production) releases — never internal/dev branches.** | Direct fix for root cause #1 (broken by internal deploys). Decoupled by construction. |
| D4 | **Synthetic / anonymized seed data.** Retire the staging snapshot for this purpose. | Real customer data in an external sandbox = compliance/data-leak event. |
| D5 | **Hard invariant:** sandbox cannot reach real money / KYC / SMS — enforced at network *and* config. | A config typo must not be able to spend real money or text a real customer. |
| D6 | **Scope month 1 to the core integration contract**, not platform parity. | 1 month + DevOps + external partners ⇒ ruthless scoping (see §5). |
| D7 | Build region/account-agnostic in Pulumi. POC us-east-1 acceptable for now per stakeholder; flag migration debt. | Eventual move to main region becomes a config flip, not a rebuild. |

---

## 4. Recommended architecture

```
  PUBLIC (merchant-facing, branded HTTPS + WAF + per-merchant rate limit)
   ├─ sandbox-api.aplazo.* ........ auth, create loan/checkout, status, refund
   ├─ sandbox.checkout.aplazo.* ... hosted checkout (real engine, sandbox mode)
   └─ outbound webhooks ........... to each merchant's test endpoint

  SANDBOX ENVIRONMENT  (isolated VPC, NO peering to prod/staging data)
   ├─ Thin slice of REAL platform services, pinned to prod release
   ├─ Own database, seeded with SYNTHETIC data + per-merchant test creds
   ├─ Decisioning SIMULATOR (magic amounts/IDs → approve / decline / error)
   └─ Downstream SIMULATORS (KYC / SMS / payment rails) — real ones unreachable

  OPERATIONS (DevOps-owned)
   ├─ Pulumi IaC + standard CI/CD (promote stable builds only)
   ├─ Secrets Manager (no env-var / /tmp secrets), Cognito/SSO for admin UI
   ├─ Dashboards, per-merchant usage/error metrics, alerting, runbooks
   └─ Periodic reseed/reset job (data hygiene)

  INTERNAL TOOLING (not in merchant path)
   └─ Hackathon agent → spins EPHEMERAL throwaway stacks on demand
```

The "sandbox behavior to iterate on" lives entirely in the **decisioning / downstream simulators** — the right seam for future change without touching the environment.

---

## 5. Tradeoffs

- **Shared vs. per-merchant (settled → shared).** Trades maximum isolation for sane cost/ops. Safe because prod is already tenant-partitioned by `merchant_id` and data collisions were not a confirmed pain. A merchant later needing hard isolation is exactly where the demoted agent earns its keep.
- **Thin real services + simulated downstreams vs. full clone vs. all-mocks.** Full clone won't fit a month and rots into a maintenance monster; all-mocks gives fidelity merchants distrust. **Chosen middle:** run the *real* services merchants touch, fake only what's behind the contract boundary (decisioning + downstreams).
- **POC us-east-1 now vs. real Aplazo-managed account now.** POC account has hostile SCPs (no S3) and `expires=` reaper tags built for *throwaway* infra — building a permanent env there is migration debt. Mitigation: Pulumi region/account-agnostic (D7); seriously consider a proper Aplazo sandbox account from day one if DevOps can grant it.

---

## 6. Security (deferred Phase 2, re-mapped to this architecture)

| Backlog item | Status under this design |
| :-- | :-- |
| S1 secrets reach browser | **Moot** — agent leaves the merchant path. |
| S3 single static token | **Moot** — no shared control-plane token in the prod path. |
| S4 client-driven orchestration | **Moot** — no browser orchestration in the prod path. |
| S2 auth fails open | **Still ships** (fail-closed) — applies to any retained control-plane endpoint. |

New security requirements introduced by an externally-reachable environment:
- WAF + per-merchant rate limiting + DDoS protection on public endpoints.
- Per-merchant scoped test credentials (issuance + rotation).
- Network isolation: dedicated VPC, **no peering to prod/staging data**.
- Secrets in a proper secrets manager (not env vars / `/tmp` files as in the hackathon).
- Hard guarantee (D5) the sandbox can never reach real money rails / KYC / SMS.

---

## 7. Implementation plan (~1 month, phased)

**Phase 0 — Discovery (Days 1–3, blocking).** Decides whether month 1 = core flow or parity.
- Enumerate the **integration contract**: exact endpoints, hosted-checkout flow, webhook events a merchant touches.
- Map each to its prod services + downstream deps; classify each downstream **real-isolated / simulated / stubbed**.
- Confirm the `merchant_id` tenancy boundary holds end-to-end.
- *Output:* one-page contract + "what must be faked" list.

**Phase 1 — Environment skeleton (Week 1–2).** Pulumi: isolated VPC (no prod-data peering), thin real-service slice on a stable release, own DB, synthetic seed job, per-merchant credential issuance.

**Phase 2 — Sandbox behavior + safety (Week 2–3).** Decisioning simulator (magic values), hard guarantees against real money/KYC/SMS (D5), branded HTTPS + ACM + WAF + per-merchant rate limits, webhook delivery.

**Phase 3 — Cutover + ops (Week 3–4).** Issue sandbox credentials, update integration docs, **partner comms**, run sandbox **in parallel with staging** during a deprecation window (not a hard switch), dashboards/alerts/runbooks, then revoke merchant access to staging.

---

## 8. Risks (the 5-year view)

1. **Drift is existential.** A sandbox that lags prod becomes a lie merchants integrate against. The release-promotion discipline (D3) is the single most important long-term practice.
2. **Cutover is a partner-comms project**, not just engineering. Plan parallel-run + deprecation window, not a flip.
3. **Scope creep.** Merchants will ask for every prod feature. Hold the Phase-0 contract.
4. **POC-account migration debt** (§5).

---

## 9. Reuse from the hackathon repo

Useful: Pulumi/IaC patterns, the 6-mandatory-tag discipline (`shared/tags.js`), the `checkout-app` container scaffold, ECS/ALB wiring, deterministic-provisioning learnings, the `shared/` helper layer.

Demoted: the AI agent control plane (8 Lambdas + browser ReAct loop) → optional internal tooling for ephemeral throwaway stacks only.

---

## 10. Open questions (to close in Phase 0)

1. Is `aplazo.gitbook.io/.../online-api` the **full** merchant integration contract, or only part of it?
2. POC us-east-1 now vs. a proper Aplazo-managed sandbox account from day one — DevOps call.
3. Exact list of downstreams that must be simulated (KYC provider, SMS, payment rails, decisioning) and their contracts.
4. Source of truth for synthetic seed data generation (generator vs. masked extract).
5. Branded domain scheme + DNS/ACM ownership (ties to [`URL-STRATEGY.md`](./URL-STRATEGY.md) blockers).
