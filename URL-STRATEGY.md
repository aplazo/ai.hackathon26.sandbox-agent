# Sandbox URL Strategy — Hackathon Constraint & Post-Win Plan

> **TL;DR:** the sandbox URL we generate today (`http://apz-poc-hackaton-...elb.amazonaws.com/sandbox-<id>/`) is hackathon-constrained. The **production target** is `https://sandbox-<id>.checkout.aplazo.net/login/credentials/<loan_uuid>`. **Gap = no cross-site permissions for the hackathon scope.** If we win the hackathon, closing this gap is the **first piece of work** post-win.

---

## 1. What the demo generates today

```
Pattern:
  http://apz-poc-hackaton-371887012.us-east-1.elb.amazonaws.com/sandbox-<sandbox_id>/

Concrete example:
  http://apz-poc-hackaton-371887012.us-east-1.elb.amazonaws.com/sandbox-sb8k2m9p4x/

Components:
┌──────────────────────────┬───────────────────────────────────────────────────┐
│ Element                  │ Owned by / shared                                 │
├──────────────────────────┼───────────────────────────────────────────────────┤
│ Scheme: http             │ ALB has only HTTP:80 listener (no ACM cert)       │
│ ALB DNS                  │ Shared ALB, provisioned by another hackathon team │
│ Path: /sandbox-<id>/     │ Per-sandbox, we own — listener rule + target      │
│                          │ group + Fargate service all created by our agent  │
│ Backend                  │ Per-sandbox ECS Fargate task (real, isolated)     │
│                          │ running our `sandboxagent/checkout` container     │
└──────────────────────────┴───────────────────────────────────────────────────┘
```

**This URL is functionally complete** — the merchant clicks it and lands on a page served by their own Fargate task, showing their merchant data, with a button to launch the real Aplazo checkout. The AWS infrastructure behind it is real and isolated.

**What it's not:**
- ❌ HTTPS (no cert)
- ❌ Branded with `aplazo.net` domain
- ❌ Memorable / typeable

---

## 2. What we want in production

```
Pattern:
  https://sandbox-<sandbox_id>.checkout.aplazo.net/login/credentials/<loan_uuid>

Concrete example:
  https://sandbox-sb8k2m9p4x.checkout.aplazo.net/login/credentials/268712-abc

Components:
┌──────────────────────────┬───────────────────────────────────────────────────┐
│ Element                  │ Required infrastructure                           │
├──────────────────────────┼───────────────────────────────────────────────────┤
│ Scheme: https            │ ACM wildcard cert *.sandbox.checkout.aplazo.net   │
│ Subdomain per sandbox    │ Wildcard DNS *.sandbox.checkout.aplazo.net        │
│                          │ → POC us-east-1 ALB                               │
│ /login/credentials/...   │ Path served by the REAL Aplazo checkout-engine    │
│                          │ (currently lives in main us-west-1 ECR)           │
│ Backend                  │ Per-sandbox Fargate task running the real         │
│                          │ checkout-engine image (currently we run a         │
│                          │ minimal welcome-page placeholder)                 │
└──────────────────────────┴───────────────────────────────────────────────────┘
```

---

## 3. Why we can't have this for the hackathon

Three independent blockers, **all cross-site / cross-team permissions**:

### 3.1 DNS — `*.checkout.aplazo.net` is owned by main account

```
Route53 zone:        aplazo.net
Owning account:      159200192518 (main aplazo)
SCP applied to us:   p-5zv6maiv (denies us-west-1 + main-account-resource access)

Effect: we cannot add records to *.checkout.aplazo.net from POC.
```

**Workaround paths (post-hackathon):**

| Option | Owner needed | Complexity |
| :-- | :-- | :-- |
| A. Subdomain delegation: DevOps adds NS record `sandbox.checkout.aplazo.net` → Route53 zone we own in POC | DevOps + us | Low (1 record on their side, we own a new zone) |
| B. DevOps adds the wildcard `*.sandbox.checkout.aplazo.net` directly | DevOps | Low (single ALIAS record) but no autonomy for us afterward |
| C. We register a domain in POC (e.g. `sandboxagent.dev` from Route53) | Us | Medium ($12/year, fully self-managed) |

### 3.2 ACM cert — wildcard for `*.sandbox.checkout.aplazo.net`

```
Validation method: DNS (recommended)
Required:          DNS records in the aplazo.net zone (or sub-zone if delegated)
                   → requires #3.1 resolved first

Alternative:       Email validation — sends to admin@aplazo.net etc.
                   Faster but less automated.
```

**Workaround paths:**
- Resolves automatically once #3.1 is done — request cert, validate via the delegated zone.

### 3.3 Checkout-engine app — image lives in us-west-1

```
Image:               aplazo/stg-checkout-engine
Owning region/acct:  us-west-1 / main 159200192518
SCP block:           p-5zv6maiv denies us-west-1 ECR reads from POC

Effect: even with DNS + cert, we have nothing to run at that URL beyond
        the minimal welcome page we built.
```

**Workaround paths (post-hackathon):**

| Option | Description |
| :-- | :-- |
| A. **DevOps mirrors the image** to POC ECR | Aplazo Pulumi infra repo can add `sandboxagent/checkout-engine` to POC ECR as a continuous mirror |
| B. **We reimplement a minimal sandbox-checkout** | Build a smaller Node/Next.js app that does the login + display + payment flow against `api.aplazo.net`. Easier to reason about, but maintenance lives with us |
| C. **CloudFront proxy to checkout.aplazo.net** | Cosmetic only — same shared backend, just a custom domain in front. Not real isolation. |

---

## 4. What we can do for the hackathon demo (without cross-site)

Two pragmatic options **inside our POC us-east-1 scope**, no DevOps coordination needed:

### Option A — Internal redirect via HTML Publisher

Publish a small redirect HTML at `aplazo.ai/engineering/sandbox-<id>.html` (the HTML Publisher we already use) that:
1. Reads `<id>` from the URL
2. Redirects to `http://apz-poc-hackaton-.../sandbox-<id>/`

URL becomes: `https://www.aplazo.ai/engineering/sandbox-sb8k2m9p4x.html`

Pros:
- HTTPS ✓
- `aplazo.ai` branding ✓
- Auto-published via the same `/html-publisher` flow we already use
- No DevOps work

Cons:
- One HTML per sandbox (or a single page that takes `?id=...`)
- `.html` extension visible
- Still says `engineering/` not `sandbox/`

### Option B — Generic prefix on a domain we register

Register a short domain in POC Route53 (e.g. `sandboxagent.dev` or similar), point `*.sandboxagent.dev` to the POC ALB, request a wildcard ACM cert.

URL becomes: `https://sandbox-sb8k2m9p4x.sandboxagent.dev/`

Pros:
- Real HTTPS subdomain ✓
- `sandbox-` prefix ✓
- Self-managed, no DevOps coordination

Cons:
- Costs ~$12/year for the domain
- Domain isn't an Aplazo domain (less branded)
- 5-15 min DNS propagation after registration

### Option C — Just keep the current URL + describe the gap

URL stays: `http://apz-poc-hackaton-...elb.amazonaws.com/sandbox-sb8k2m9p4x/`

Pros:
- Zero additional work
- 100% functional already
- The path-prefix `/sandbox-<id>/` does carry the `sandbox` semantics

Cons:
- `apz-poc-hackaton...elb.amazonaws.com` in the URL is ugly and obviously AWS
- HTTP only

---

## 5. Decision for the hackathon

**Option C (keep current URL) + describe the gap clearly in the demo narrative.**

Rationale:
1. **The AWS isolation we demonstrate is real** — Aurora cluster, ECS service, ALB rule are all real per sandbox. That's the hackathon value.
2. **The URL aesthetic is not the prize.** What's evaluated is the agent loop + the provisioning pipeline + the architecture decisions. A pretty URL doesn't add to those.
3. **The gap is honest and easy to explain** — it requires DevOps coordination (DNS delegation + image mirror) that's out of scope for the 2-day hackathon window.
4. **It signals a clear post-win starting point.** If judges ask "what's next if you win this track?", the answer is concrete: close the cross-site gap, in 3 well-defined steps (DNS → cert → image mirror).

If Option A (redirect via HTML Publisher) is desired for visual polish, it's a 30-min add — we'd publish a single HTML page with JS-based redirect that takes `?id=` from query string.

---

## 6. Post-win roadmap (if SandboxAgent wins the hackathon)

**Phase 1 — Branded sandbox URL (~2 days, 1 dev + DevOps coordination)**

1. **DevOps:** Add NS record in `aplazo.net` zone: `sandbox.checkout.aplazo.net` delegated to a Route53 zone we create in POC.
2. **Us:** Create Route53 hosted zone for `sandbox.checkout.aplazo.net` in POC us-east-1.
3. **Us:** Request ACM wildcard cert `*.sandbox.checkout.aplazo.net` (DNS-validated against the newly delegated zone).
4. **Us:** Add HTTPS:443 listener to the POC ALB with this cert.
5. **Us:** Modify `deploy_ecs_services` Lambda to use **host-header routing** instead of path-pattern, so each sandbox gets its own subdomain instead of a path prefix.
6. **Us:** Add Route53 A-record (ALIAS) for each sandbox at provision-time.

Result: `https://sandbox-<id>.sandbox.checkout.aplazo.net/`

**Phase 2 — Real checkout-engine in the sandbox (~1 week, 1 dev + DevOps)**

1. **DevOps:** Add `aplazo/stg-checkout-engine` to the Pulumi infra repo as a mirror to POC ECR (continuous sync from main us-west-1 ECR).
2. **Us:** Update `deploy_ecs_services` to use the mirrored image instead of our `sandboxagent/checkout` welcome page.
3. **Us:** Configure the checkout-engine container to point at the sandbox's own Aurora cluster (env var injection).
4. **Us:** Verify the sandbox-hosted checkout serves the loan flow end-to-end (login → credentials → confirmation → real bank/card flow against api.aplazo.net).

Result: clicking "Open checkout" goes to `https://sandbox-<id>.sandbox.checkout.aplazo.net/login/credentials/<uuid>` which serves the **real Aplazo checkout** running on **isolated sandbox infrastructure**.

**Phase 3 — Make it self-service for engineers (~2 weeks)**

1. Multi-region: replicate POC us-east-1 setup in main us-west-1 (where staging actually lives) once SCPs allow.
2. CI/CD: GitHub Actions for the agent + container builds + ECR pushes.
3. Snapshot pre-warming pool to bring sandbox provisioning under 30 seconds.
4. Destroy-sandbox UI button (manual cleanup pre-reaper).
5. Cognito SSO for the HTML itself (currently only the secrets are gated).

**Total post-win effort to reach the full PRD vision: ~3-4 weeks for 1 dev + DevOps support.**

---

## 7. What to say in the demo

> "The sandbox URL today points to a real Fargate task running our checkout-app container on our isolated AWS infrastructure. The path `/sandbox-<id>/` is the per-sandbox routing rule on the shared hackathon ALB.
>
> In production, this would be `https://sandbox-<id>.checkout.aplazo.net/login/credentials/<uuid>` — a per-sandbox subdomain with HTTPS, serving the real Aplazo checkout-engine. We can't have that for the hackathon because:
>
> 1. The `aplazo.net` Route53 zone lives in the main AWS account, behind an SCP we can't write to.
> 2. The `checkout-engine` Docker image lives in us-west-1 ECR, also behind the same SCP.
>
> Both are 1-day fixes with DevOps coordination — we documented the exact 6-step rollout in `URL-STRATEGY.md`. If we win this track, this is the first piece of work."

---

## 8. References

- [`HANDOFF.md`](./HANDOFF.md) — section 3.1 references this strategy doc
- [`STATUS.md`](./STATUS.md) — known gap row links here
- [`README.md`](./README.md) — common gotchas + roadmap
- [`PRD-v1.7-changes.md`](./PRD-v1.7-changes.md) — section 6 (architecture) + section 11 (roadmap)
- AWS Route53 docs: subdomain delegation pattern
- ACM wildcard certs: DNS validation
- Aplazo Pulumi infra repo: `github.com/aplazo/node.pulumi-infrastructure` (where the ECR mirror lives)
