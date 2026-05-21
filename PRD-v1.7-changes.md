# PRD v1.7 — Changes from v1.6 → v1.7

> Paste these into the [PRD Google Doc](https://docs.google.com/document/d/1ik5-MMWy6xAygyAH-GNyckvfk9qgYVLSSmKjYIiiSts/) — no edit tool available to do it automatically.
>
> **Bump version to 1.7** and add a changelog entry. Most existing sections are still valid; this is a focused diff.

---

## 0. Header / changelog updates

### Old (v1.6)
```
Versión: 1.6
Fecha: May 20, 2026
Cambios v1.6: Tool create_merchant añadido al flujo — crea un merchant fresco por sandbox via Lambda existente · ...
```

### New (v1.7)
```
Versión: 1.7
Fecha: May 21, 2026
Cambios v1.7:
  · Implementación completa del data plane real (Aurora PostgreSQL 15.15 cluster + ECS Fargate + ALB rule por sandbox)
  · Pivote arquitectónico: TODO en POC us-east-1 (cuenta 332730082760), no main us-west-1
    (SCP p-5zv6maiv niega RDS/ECR en us-west-1 desde el role Hackathon2026)
  · Aurora snapshot apzdbstg-hackathon-local re-encriptado con aws/rds por DevOps,
    shared con POC para restore in-region
  · 7 tools del agente todos en MOCK_MODE=false, ejecutando contra recursos reales
  · 8º Lambda: fetch_config — endpoint auth-gated (Google JWT verify) que entrega
    runtime secrets (Anthropic key + BackendToken) post-login,
    cumple regla del hackathon "no secrets en HTML source"
  · SAM/CloudFormation reemplazado por deploy-direct.sh (S3 bloqueado por SCP p-4avftpkm)
  · Container del sandbox: app custom Node.js 24 zero-deps, built via AWS CodeBuild,
    pushed a POC ECR repo sandboxagent/checkout
Región AWS: us-east-1 únicamente (data plane + control plane consolidados)
```

---

## 1. Stack table (Sección 1 del PRD)

### Reemplazar la tabla de Stack completo:

```
| Capa | Tecnología |
| :-: | :-: |
| Frontend | Single HTML file — desplegado vía Aplazo HTML Publisher en aplazo.ai |
| Auth del frontend | Google Sign-In With Google (hd=aplazo.mx) + backend tokeninfo verify |
| Agente LLM | Anthropic API directa desde browser (claude-sonnet-4-20250514, ReAct loop tool_use) |
| Auth-gated config | Lambda fetch_config — verifica JWT, devuelve secrets en runtime |
| Tool execution | API Gateway HTTP API + 8 Lambdas Node.js 24 arm64 (us-east-1) |
| Container del sandbox | ECS Fargate task con imagen custom sandboxagent/checkout (POC ECR) |
| Base de datos por sandbox | Aurora PostgreSQL 15.15 cluster + instance db.t3.medium |
| Source DB | apzdbstg-hackathon-local (snapshot de staging compartido por DevOps) |
| Merchant creation | Lambda existente jwaakdci64.execute-api.us-west-1.amazonaws.com/merchant_creation (HTTPS público, no cross-account AWS) |
| Online API validation | api.aplazo.net /auth + /loan |
| Persistencia de sesiones | DynamoDB sandboxagent-sessions (TTL on-demand) |
| Container build | AWS CodeBuild (Docker local no requerido) |
| Deploy script | infra/scripts/deploy-direct.sh (NO SAM — SCP p-4avftpkm bloquea S3) |
| Región principal | us-east-1 |
| Cuenta AWS | POC 332730082760 (hackathon) |
```

---

## 2. Sección 2 — Problem statement

**No cambia significativamente.** Mantener como está.

---

## 3. Sección 3 — Goals / Non-Goals

### Reemplazar Non-Goals con:

```
### Non-Goals (v1.7)

- Replicar el checkout-engine real de Aplazo en el sandbox.
  El sandbox URL sirve una página informativa custom; el checkout funcional
  sigue siendo el shared checkout.aplazo.net (donde Aplazo controla la app).
  La isolation real está en el data plane (Aurora + ECS + ALB).

- Per-sandbox subdomain (sandbox-{id}.checkout.aplazo.net).
  Requiere wildcard DNS + cert + reimplementación del checkout-engine.
  Post-hackathon. Por ahora usamos path-prefix: <alb-dns>/sandbox-{id}/

- Cross-region cross-account access a us-west-1.
  Bloqueado por SCP del POC account. DevOps copió el snapshot a us-east-1
  para evitarlo. Toda la infra del sandbox vive en POC us-east-1.

- Soporte multi-cuenta de AWS (snx, prod).
  Sólo POC 332730082760 us-east-1.

- Snapshots en tiempo real / CDC.
  El snapshot apzdbstg-hackathon-local se actualiza manualmente por DevOps.
```

---

## 4. Sección 5.1 — Merchant Input e Integration Type

### Cambiar de 14 tipos a 2:

```
FR-05 (actualizado): los tipos de integración soportados son:
  - API
  - API_OFFLINE (auto-crea sucursal en el merchant)

Los otros 12 tipos del v1.6 (SHOPI, POSUI, WOO, MGT, WALMART, etc.)
fueron removidos del UI por ahora — alcance reducido para el demo.
Volver a incluirlos es trivial (un option en el <select>) cuando se necesite.
```

---

## 5. Sección 5.3 — Summary Card

### Actualizar:

```
FR-08 (actualizado): card final con:
  - Merchant (nombre + ID real creado en Aplazo dev)
  - Integration type
  - Synthetic user ID (generado server-side)
  - Sandbox URL (path-based: <alb-dns>/sandbox-{id}/)
  - Checkout URL (real, checkout.aplazo.net/main/{uuid})
  - Validation pills (auth ✓, loan ✓, db ✓, ecs ✓)
  - Infrastructure details (collapsible) — Aurora cluster ID, ECS service ID

FR-10 (actualizado): "Open Checkout" abre el URL real de Aplazo dev,
NO la mock sandbox-{id}.aplazo.ai del v1.6.
```

### Remover campos (5.x):

- `credit_state` (approved_with_headroom, near_limit, first_timer, returning)
- `payment_outcome` (successful, failed, pending)
- `extra_prompt`

Estos campos no se usan en la implementación. La form inicial sólo pide merchant ref + integration type.

---

## 6. Sección 6 — Arquitectura

### Reemplazar el diagrama principal (6.1) con:

```
   Browser (sandboxagent-demo-may2026.html)
     ├─ Google Sign-In With Google (hd=aplazo.mx)
     ├─ POST /sandbox/config con id_token (backend verifica via tokeninfo)
     ├─ Recibe Anthropic API key + BackendToken en runtime
     ├─ Anthropic API direct (claude-sonnet-4-20250514, tool_use loop)
     └─ 7 tool calls → API Gateway → Lambdas
                              │
                              ▼
                       POC us-east-1 (account 332730082760)
                       ├─ HTTP API f0ndmxurpk (8 routes)
                       ├─ 8 Lambdas Node.js 24 arm64
                       ├─ DynamoDB sandboxagent-sessions
                       └─ IAM role sandboxagent-lambda-role
                              │
                              │ per-sandbox provisioning (REAL)
                              ▼
                       POC us-east-1 data plane
                       ├─ Aurora cluster sandbox-{id}-cluster + instance sandbox-{id}-i1
                       │  └─ restored from snapshot apzdbstg-hackathon-local
                       ├─ ECS Fargate service sba-{id}-svc en poc-hackaton-cluster
                       │  └─ container sandboxagent/checkout en POC ECR
                       ├─ ALB target group sba-{id}-tg
                       └─ ALB listener rule /sandbox-{id}/* en apz-poc-hackaton

       + HTTPS público (no AWS cross-account):
         ├─ us-west-1 Merchant Creation Lambda (jwaakdci64.execute-api.us-west-1)
         └─ api.aplazo.net /auth + /loan
```

### Sección 6.2 — Los Tools

**Mantener los 7 tools** del v1.6 con estos ajustes:

#### Tool 1 — resolve_snapshot_config
- **Cambio:** ya no es cross-account a us-west-1. Lee del snapshot local en POC.
- **AWS SDK call:** `rds.describeDBClusterSnapshots({ DBClusterSnapshotIdentifier: 'apzdbstg-hackathon-local', IncludeShared: true })`
- **Auto-detección:** mira si el ARN contiene `cluster-snapshot:` → path Aurora; si no, path RDS regular. Permite swap entre snapshots con una env var.

#### Tool 2 — restore_rds_snapshot
- **Cambio:** ya no es cross-region CopyDBSnapshot. Restore directo en POC us-east-1.
- **Aurora path (default):** `RestoreDBClusterFromSnapshot` + `CreateDBInstance(db.t3.medium)`
- **RDS regular path (fallback):** `RestoreDBInstanceFromDBSnapshot(db.t3.micro)`
- **Pattern:** fire-and-poll-short (≤25s polling budget; API GW hard limit es 30s). Retorna `status="creating"` + endpoint inmediatamente. Cluster termina available ~5-7 min después en background.

#### Tool 4 — deploy_ecs_services
- **Cambio:** ya no clona task definitions de staging us-west-1. Crea task def + service desde cero con la imagen `sandboxagent/checkout`.
- **AWS SDK calls:** `RegisterTaskDefinition` + `CreateService` en `poc-hackaton-cluster` + `CreateTargetGroup` + `CreateRule` con path-pattern `/sandbox-{id}/*` en el shared ALB `apz-poc-hackaton`.
- **Network:** subnets us-east-1a + 1c (donde sirve el ALB), security group dedicado `sandboxagent-ecs-sg` que permite 8080 desde el ALB SG.

#### Tool 6 — validate_sandbox
- **Cambio:** payload de `/api/loan` actualizado al schema real de Aplazo Online API (`totalPrice`, `shopId`, `cartId`, `buyer`, `products`, etc.)
- **Auth response:** parsea `Authorization: Bearer <jwt>` (no `token` que asumía el v1.6)
- **Output:** `checkoutUrl` viene de `response.url`

### Sección 6.3 — Backend Lambda Structure

```
api-gateway (us-east-1)
└── POST /sandbox/{tool}
    ├── /resolve-snapshot       → sandboxagent-resolve-snapshot-config
    ├── /restore-rds            → sandboxagent-restore-rds-snapshot
    ├── /create-merchant        → sandboxagent-create-merchant
    ├── /deploy-ecs             → sandboxagent-deploy-ecs-services
    ├── /configure-merchant     → sandboxagent-configure-merchant
    ├── /validate-sandbox       → sandboxagent-validate-sandbox
    ├── /save-session           → sandboxagent-save-session
    └── /config                 → sandboxagent-fetch-config (NEW — auth-gated)
```

### Sección 6.4 — CONFIG block del frontend

### Reemplazar con:

```js
// Solo valores públicos. Secrets se fetchan en runtime después del Google login.
const CONFIG = {
  backendUrl:     'https://f0ndmxurpk.execute-api.us-east-1.amazonaws.com/sandbox/sandbox',
  googleClientId: '627677728138-b4b39v4ie3dn3qa0lm6lg01mtcao7otv.apps.googleusercontent.com',
  allowedDomain:  'aplazo.mx',
};

// Populated after Google login from /sandbox/config (closure-scoped, never window.*)
let runtimeConfig = null;
```

### Sección 6.5 — Timing del provisioning

```
| Paso | Tool | Tiempo visible | Tiempo real (background) |
| :-: | :-- | :-: | :-: |
| Resolve snapshot | resolve_snapshot_config | ~2s | — |
| Restore Aurora | restore_rds_snapshot | ~20s | ~5-7 min |
| Crear merchant | create_merchant | ~5s | — |
| Deploy ECS | deploy_ecs_services | ~20s | ~1-2 min |
| Configurar merchant | configure_merchant | ~15s | — |
| Validar (Online API) | validate_sandbox | ~5s | — |
| Guardar sesión | save_session | <1s | — |
| Total | | ~80s | ~5-10 min |
```

---

## 7. Sección 7 — Recursos AWS y Tagging

### Agregar a la sección 7:

```
Tag adicional (Pulumi convention): squad=developer-experience

Recursos efímeros adicionales por sandbox que no estaban en v1.6:
| Aurora cluster | sandbox-{id}-cluster | tags estándar + sandbox-id |
| Aurora instance | sandbox-{id}-i1 (db.t3.medium) | ídem |
| ALB target group | sba-{id}-tg | en VPC default us-east-1 |
| ALB listener rule | path-pattern /sandbox-{id}/* | priority hash(id) en rango 1000-9000 |
| ECS task definition | sba-{id}-td:1 | revisión nueva por sandbox |
| DynamoDB record | sess_{id} | TTL 10 días |
```

---

## 8. Sección 8 — Secrets Manager

### Reemplazar con:

```
v1.7: NO usamos Secrets Manager para nada (el SCP no lo bloquea pero no aplica
al diseño actual). Los secrets viven como Lambda env vars, gateados por nuestro
endpoint /sandbox/config + Google JWT verification.

Secrets ubicados:
  ANTHROPIC_API_KEY  → env var de sandboxagent-fetch-config Lambda
  BACKEND_TOKEN      → env var de todos los 8 Lambdas
  GOOGLE_CLIENT_ID   → hardcoded en HTML (público por diseño de OAuth)
                       + env var de sandboxagent-fetch-config

Rotación: cambiar env vars vía aws lambda update-function-configuration.
```

---

## 9. Sección 11 — Deploy

### Reemplazar completa:

```
### Frontend
Archivo:  sandboxagent-demo-may2026.html
URL live: https://www.aplazo.ai/engineering/sandboxagent-demo-may2026.html
Deploy:   Cowork → /html-publisher → Publish HTML → Engineering team

### Backend
Cuenta:   POC 332730082760
Región:   us-east-1
Profile:  hackathon-poc (SSO via identitycenter.amazonaws.com/ssoins-7223ad900089de27)
Script:   infra/scripts/deploy-direct.sh (idempotent — safe to re-run)

Pasos:
  1. aws sso login --profile hackathon-poc
  2. cd infra && ./scripts/deploy-direct.sh
  3. (Si cambias el HTML) re-publicar vía /html-publisher

NO usar sam deploy — la SCP del POC niega s3:CreateBucket y la SAM
bootstrap stack falla en CREATE_FAILED. Esto está documentado en
infra/README.md y HANDOFF.md.

Soporte DevOps: #hackathon-support-2026 → Duvan Bedoya, Brandom Marañon
```

---

## 10. Sección 13 — Risks (actualizar estados)

### Actualizar los riesgos del v1.6:

| Riesgo v1.6 | Estado v1.7 |
| :-- | :-- |
| RDS restore tarda > 15 min | ✅ Resuelto — Aurora restore ~5-7 min, fire-and-poll-short Lambda |
| ECS services no healthcheck en tiempo | ✅ Resuelto — health check `/health` con retry, grace period 60s |
| Online API dev no disponible | ⚠️ Mitigado parcialmente — depende de uptime de api.aplazo.net |
| Costo excede $50 USD | ✅ OK — Aurora db.t3.medium + Fargate task ~$2/día por sandbox, reaper limpia |
| Secrets Manager: merchant credentials no configuradas | ✅ N/A — no usamos Secrets Manager |
| Lambda timeout en restore RDS | ✅ Resuelto — fire-and-poll-short pattern <25s, API GW timeout no se hits |

### Nuevos riesgos v1.7:

| Riesgo | Mitigación |
| :-- | :-- |
| Cluster Aurora se queda sin borrar tras expire | DevOps reaper maneja tagged resources. Verificar manualmente post-demo. |
| SCP de POC cambia y bloquea algo | Snapshot del estado funcional en commit `e842ff0`. Re-probar tools si SCP rolls. |
| ALB listener rule limit (100/listener default) | Hash-based priority + cleanup. Si llegamos a >50 sandboxes simultáneos, raise quota. |

---

## 11. Sección 16 — Roadmap Post-Hackathon

### Reemplazar lista:

```
| Item | Descripción |
| :-: | :-- |
| Per-sandbox checkout URL | Implementar sandbox-{id}.checkout.aplazo.net (wildcard DNS + cert + DevOps mirror del checkout-engine ECR image a POC) |
| Backend proxy para Anthropic | Lambda proxea api.anthropic.com; el key nunca toca el browser |
| Cognito + Google Workspace SSO | Reemplazar el GIS-only gate del HTML por auth completo (post HTML Publisher) |
| Destroy sandbox button | Manual cleanup pre-reaper (Lambda nueva /sandbox/destroy con sandbox_id) |
| Snapshot pre-warming pool | Mantener 2-3 clusters Aurora pre-restored para bajar tiempo de 7 min a <30s |
| Step Functions para flow largo | Reemplazar fire-and-poll-short por state machine — visibility + retries |
| CI/CD pipeline | GitHub Actions → deploy-direct.sh on merge to main |
| Observability | CloudWatch dashboards, cost-per-sandbox via tag sandbox-id |
| Angular 20 SPA frontend | Migrar del single HTML — PRD v1.1 como spec |
| Mindset-based synthetic users | Profile mapping (Mario/Dani/Pao/José/Lulú) del Miro board — auto-aplicar perfiles a partir del nombre en el prompt |
```

---

## Versión final propuesta

```
SandboxAgent PRD v1.7 · APLAZO Hackathon 2026
Stack: HTML Publisher (frontend) · Lambda + API Gateway (backend)
       · Aurora 15.15 + ECS Fargate + ALB (data plane)
       · Merchant Creation Lambda (us-west-1, HTTPS) · api.aplazo.net Online API
Región principal: us-east-1 (POC account 332730082760)
Última actualización: 2026-05-21 · commit e842ff0
```
