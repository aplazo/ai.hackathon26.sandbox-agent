# SandboxAgent — Refactor Backlog

> Output of the 2026-05-29 architecture review. Phase 0 (pure, no-behavior-change
> consolidation) and the Phase 1 deploy-script bugs are **done** and on `master`'s
> history. Everything below is the remaining, prioritized work. Each item is
> tagged with the finding ID from the review.
>
> Companion docs: [`HANDOFF.md`](./HANDOFF.md) (canonical), [`ROADMAP.md`](./ROADMAP.md)
> (post-win product plan). This file is the **engineering-quality** backlog —
> the "how the code should be built," not the "what to build next."

---

## ✅ Done (Phase 0)

- **D1–D9 duplication removed** — new `shared/aws-errors.js` (`isAwsError`,
  `sleep`, `pollUntil`), `shared/snapshot.js`, `shared/naming.js`; tag-shape
  adapters in `shared/tags.js`; crypto IDs + `compactTimestamp` in `shared/ids.js`.
- **P1** — AWS SDK clients hoisted to module-scope singletons in all handlers.
- **P3** — dead `shared/aws.js` (abandoned cross-account STS helper) deleted.
- **P4** — `Math.random()` IDs → `crypto.randomInt` (same alphabet/length).
- **B1** — `deploy-direct.sh` `warn`-before-define crash fixed (helpers hoisted).
- **B2** — `deploy-direct.sh` no longer echoes the backend token to stdout.

All verified behavior-preserving (handler load + helper-equivalence harness).

## ✅ Done (Phase 1 hygiene)

- **M2** — poll loops log transient errors at debug instead of `catch (_) {}`.
- **P7** — `mock-data.js` re-synced to the real single-`checkout`-service shapes
  (was 3 services + subdomain URLs) and documented as local-dev only.
- **D7** — 6 mandatory tags single-sourced in `infra/tags.env`; `deploy-direct.sh`
  and `tags.js` both consume it (no more hardcoded copies in two places).
- **S5 (partial)** — CORS allow-origin made configurable via `CORS_ALLOW_ORIGIN`
  (default `*`); lockdown is now a one-line env change.
- **B3** — frontend `TOOLS`/`STEPS`/`SYSTEM_PROMPT` aligned to the real single
  checkout service; removed the phantom required `core_images` param.

---

## 🟡 Phase 1 — remaining

| ID | Item | Notes |
| :-- | :-- | :-- |
| S5 (rest) | **Sanitize client-facing error detail.** Handlers still return raw `${e.name}: ${e.message}` in `detail`. | Return a generic error + a server-side log correlation id. **Deliberately deferred**: the demo stepper surfaces this detail for debugging, and the cleaner home for it is the server-side agent (S1). Revisit alongside S1. |
| — | **Adopt `pollUntil` in the restore loops.** M2 added logging, but the restore loops still hand-roll while/sleep because they have early-`return error()` paths `pollUntil` can't express. | Optional tidy-up; low value, real risk. Leave until there's a reason to touch them. |

---

## 🟠 Phase 2 — security (behavior-changing — needs explicit sign-off)

> These were **flagged, not touched** in the review per the "do not change
> functionality" constraint. They are the highest-value changes in the system.

| ID | Item | Why it matters | Sketch |
| :-- | :-- | :-- | :-- |
| **S1** | **Secrets reach the browser.** `fetch_config` hands every logged-in `@aplazo.mx` user a live Anthropic API key **and** the backend master token. | Anyone who passes Google login (or scrapes their `sessionStorage`) can bill Anthropic arbitrarily and call every control-plane Lambda. | Move the ReAct loop server-side: a new `agent` Lambda runs the loop and calls `api.anthropic.com`; the browser only sends the prompt + its Google id_token. Neither secret ever leaves AWS. |
| **S2** | **Auth fails open.** `auth.js`: `if (!expected) return { ok: true }`. A missing/typo'd `BACKEND_TOKEN` env silently makes infra-creating endpoints public. | Defense-in-depth: a config mistake shouldn't disable auth. | Fail **closed** — return `{ ok: false, reason: 'server_misconfigured' }` and log. One-line change; the only reason it's here and not in Phase 0 is it alters behavior. |
| **S3** | **Single static shared token.** One token authorizes all 8 Lambdas; no identity, no scoping; rotation = redeploy everything. | No per-user attribution on resources that cost real money. | Per-request identity via the Google JWT (verify in an API GW Lambda authorizer) instead of one shared bearer; or short-lived scoped tokens minted by `fetch_config`. |
| **S4** | **Client-driven orchestration.** The 7-step sequence, ordering, and idempotency all live in browser JS. Any token holder can call any tool in any order. | Partial failures orphan Aurora clusters (ongoing cost); no rollback/saga; no server-side idempotency guard. | Server-side orchestration (see S1's `agent` Lambda, or Step Functions in P2 below) becomes the single entry point; tool Lambdas only callable by the orchestrator role. |

---

## 🔵 Phase 3 — scalability & productionization

| ID | Item | Why | Approach |
| :-- | :-- | :-- | :-- |
| **P2** | **Step Functions instead of fire-and-poll-short.** Restore/deploy Lambdas are configured at 900s timeout but busy-`sleep` ≤20s under the 30s API GW ceiling, burning billed compute and still returning `status: creating`. | Wastes money + concurrency; can't truly track the ~7-min Aurora restore. | Express/Standard state machine: `restore → wait(poll) → deploy → configure → validate → save`, with proper `Wait` states and retry/catch. The `pollUntil` helper becomes unnecessary. |
| — | **Per-sandbox destroy Lambda + saga.** No teardown path exists; relies on the tag reaper (`expires`). Partial provisioning failures leak resources. | Orphaned Aurora clusters = real cost. | A `destroy` Lambda that deletes cluster + service + rule + target group + DDB record by `sandbox-id` tag; wire compensating actions into the orchestrator. |
| **P5** | **ALB listener-rule pressure.** Priority hashed into 1000–9000 with 20 retries; ALB default 100-rule limit. | Caps at ~tens of concurrent sandboxes. | Host-header subdomains (`sandbox-<id>.checkout.aplazo.net`) instead of path rules — also unblocks the URL-strategy work; or one rule + Lambda-based routing; or raise the quota. |
| **P6** | **Prompt caching on Anthropic calls.** The system prompt + full tool schema are re-sent uncached every iteration. | Token cost grows per loop step; org standard (CLAUDE.md) is to always cache. | Add `cache_control` breakpoints on the system prompt + tools block. Folds naturally into the S1 server-side `agent` Lambda. |
| — | **DynamoDB access patterns.** Single `sessionId` hash key; can't list a user's/merchant's sessions without a scan. | Won't scale to listing/forking. | Add a GSI on `owner` (and/or `merchant`); add `createdAt` as sort key if needed. |
| **M1** | **Modularize the frontend.** One 846-line HTML file mixes auth, config fetch, agent loop, tool routing, and rendering. | Untestable, hard to change. | Split into `auth.js`/`config.js`/`agent.js`/`tools.js`/`ui.js`; mostly moot once S1 moves the loop server-side. |
| **M3** | **Tests + least-privilege IAM.** No tests anywhere; `lambda-execution-policy.json` is broad (RDS+ECS+ELBv2+EC2+KMS+STS+DDB). | Regression risk; blast radius. | Unit tests on the `shared/` helpers (the equivalence harness from the review is a starting point); scope the IAM policy to the specific ARNs/conditions actually used. |

---

## Suggested sequencing

1. **Phase 1** in one PR (hygiene, all low-risk).
2. **S2** (fail-closed) as a standalone one-liner PR — trivial, high value.
3. **S1 + S4 + P6** together: the server-side `agent` Lambda is the keystone — it removes browser secrets, centralizes orchestration, and is where prompt caching lives.
4. **P2 + destroy Lambda** once the orchestrator exists.
5. **P5** alongside the URL-strategy / DNS work (see `URL-STRATEGY.md`).
