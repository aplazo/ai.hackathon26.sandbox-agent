# SandboxAgent — Estado del Proyecto

> Brief para el team · Aplazo Hackathon 2026 · Track: Developer Experience & Internal Tooling
>
> **Última actualización:** 2026-05-21

---

## TL;DR

Construimos un **agente AI que aprovisiona ambientes de sandbox aislados en AWS desde un prompt en lenguaje natural**. En ~80 segundos visibles para el usuario (más ~7 min de aprovisionamiento async), cada merchant recibe su propio cluster Aurora con data real de staging, su propio servicio ECS Fargate, y un URL único para correr sus pruebas e2e. Todo orquestado por Claude con tool-use en un loop de 7 pasos.

**Demo live:** https://www.aplazo.ai/engineering/sandboxagent-demo-may2026.html (login con tu @aplazo.mx)

**Repo:** https://github.com/aplazo/ai.hackathon26.sandbox-agent

---

## Arquitectura

```
   USUARIO (browser)
        │  Google SSO (hd=aplazo.mx, JWT verificado backend-side)
        ▼
   ┌────────────────────────────────────┐
   │  Frontend (single HTML)            │   ← cero secrets en source
   │  · ReAct loop vs Anthropic API     │
   │  · Stepper 7-tools en tiempo real  │
   └─────────────┬──────────────────────┘
                 │  fetch() con Bearer token
                 ▼
   ┌────────────────────────────────────┐
   │  HTTP API Gateway · 8 routes        │
   │  POC us-east-1 (332730082760)       │
   └─────────────┬──────────────────────┘
                 │
                 ▼
   ┌────────────────────────────────────┐
   │  8 Lambdas (Node.js 24, arm64)      │
   │  · 7 tools del agente               │
   │  · 1 fetch_config (auth-gated)      │
   └─────────────┬──────────────────────┘
                 │
                 ▼
        ┌────────────────────┐
        │  AWS RESOURCES     │   ← lo que se aprovisiona POR SANDBOX
        ├────────────────────┤
        │  Aurora cluster    │  ← restored from real staging snapshot
        │  Aurora instance   │
        │  ECS Fargate svc   │  ← container custom (Node mini-app)
        │  ALB target group  │
        │  ALB listener rule │
        │  DynamoDB session  │
        ├────────────────────┤
        │  REAL APLAZO STACK │
        │  Merchant en dev   │  ← via Merchant Creation Lambda
        │  Loan en dev       │  ← via api.aplazo.net /loan
        └────────────────────┘
```

---

## Qué hace el agente paso a paso

Cuando el usuario escribe "Generate sandbox for walmart_mx, integration API", el ReAct loop ejecuta:

| # | Tool | Tiempo | Output real |
| :-: | :-- | :-: | :-- |
| 1 | `resolve_snapshot_config` | ~2s | ARN del Aurora cluster snapshot real |
| 2 | `restore_rds_snapshot` | ~20s + ~7min async | Cluster + instance Aurora restored |
| 3 | `create_merchant` | ~5s | Merchant nuevo en Aplazo dev (real `merchantId` + `apiToken`) |
| 4 | `deploy_ecs_services` | ~20s + ~2min async | ECS service, target group, ALB rule reales |
| 5 | `configure_merchant` | ~15s | Polling ECS hasta running, genera synthetic_user_id |
| 6 | `validate_sandbox` | ~5s | `/auth` + `/loan` reales contra `api.aplazo.net`, devuelve checkoutUrl |
| 7 | `save_session` | <1s | Record en DynamoDB para reuse/fork |

**Total visible:** ~80 segundos. Provisioning async termina ~5-10 min después.

---

## Lo que se ve cuando el merchant clickea "Visit sandbox"

URL: `http://apz-poc-hackaton-371887012.us-east-1.elb.amazonaws.com/sandbox-<id>/`

Servida por un container Node.js corriendo en Fargate del merchant. Muestra:

- Merchant ID + nombre + integration type
- Sandbox ID + timestamp de creación
- AWS infrastructure: ECS service ARN, RDS instance ARN, container host
- Botón "Open test checkout" → real Aplazo checkout con un loan real ya creado
- Footer con tag `expires=2026-05-30` (DevOps reaper lo borra al vencer)

---

## Qué es real / qué no

| Componente | Estado | Detalle |
| :-- | :-: | :-- |
| Frontend con Google SSO @aplazo.mx | ✅ real | GIS + backend tokeninfo verification |
| Anthropic ReAct loop (8 tool calls) | ✅ real | Claude Sonnet 4 + tool_use |
| 8 Lambdas Node.js 24 arm64 | ✅ real | Inline ZipFile deploy (SCP bloquea S3) |
| HTTP API Gateway + 8 routes | ✅ real | Cors-enabled, bearer-auth |
| DynamoDB sessions (TTL) | ✅ real | PutItem + TTL=10d |
| **Aurora cluster por sandbox** | ✅ **real** | Restore de `apzdbstg-hackathon-local` (snapshot de staging compartido por DevOps) |
| ECS Fargate task por sandbox | ✅ real | Container Node propio, ECR POC, ARM64 |
| ALB rule + target group por sandbox | ✅ real | Modificamos `apz-poc-hackaton` shared ALB |
| Merchant en Aplazo dev | ✅ real | Real `merchantId` (e.g. 3911) |
| Loan en Aplazo dev | ✅ real | Real loan via `api.aplazo.net` |
| Tags AWS obligatorios (6 + sandbox-id) | ✅ real | Para el DevOps reaper |
| Container scanning ECR | ✅ real | scanOnPush=true |
| Sandbox URL = `sandbox-{id}.checkout.aplazo.net` | ❌ hackathon blocker | Cross-site/DNS no permitido en hackathon scope — ver [`URL-STRATEGY.md`](./URL-STRATEGY.md) para el detalle + plan post-win (6 pasos, ~2 días de trabajo con coordinación DevOps) |

---

## Decisiones arquitectónicas clave

### 1. SAM bloqueado → deploy directo via AWS CLI
La SCP del account POC niega `s3:CreateBucket`/`PutObject`. SAM necesita un bucket de artefactos. **Solución:** un script bash idempotente (`infra/scripts/deploy-direct.sh`) que sube las Lambdas via inline ZipFile (límite 50 MB), bypaseando S3.

### 2. Docker Hub rate limit → ECR Public Gallery
CodeBuild tira 429 al hacer pull de Docker Hub (IPs compartidas de AWS). **Solución:** cambiar `FROM node:24-alpine` a `FROM public.ecr.aws/docker/library/node:24-alpine`.

### 3. SCP bloquea `logs:CreateLogGroup` → pre-creación manual
Tanto CodeBuild como ECS task execution role intentan crear log groups, y la SCP `p-4avftpkm` los niega. **Solución:** pre-crear `/aws/codebuild/sandboxagent-checkout-build` y `/ecs/sandboxagent` con tags obligatorios.

### 4. us-west-1 negado por SCP → datos en POC us-east-1
La SCP `p-5zv6maiv` niega RDS/ECR en us-west-1 desde el role Hackathon2026. **Solución:** DevOps copió el snapshot de staging a POC us-east-1 re-encriptado con `alias/aws/rds`.

### 5. Auto-detect Aurora vs RDS regular
El Lambda `restore_rds_snapshot` mira el ARN: si contiene `cluster-snapshot:` toma path Aurora (RestoreDBClusterFromSnapshot + CreateDBInstance), si no toma path RDS regular. Permite swap del env var sin código nuevo.

### 6. Auth-gated runtime config (sin secrets en HTML)
El HTML publicado solo tiene `backendUrl`, `googleClientId`, `allowedDomain` (públicos por diseño). La Anthropic API key + BackendToken se fetchan en runtime via `/sandbox/config` después del Google login. Backend verifica el JWT contra `oauth2/tokeninfo` (aud + hd + email_verified + exp).

---

## Stats

- **Líneas de código:** ~3,500 (excluyendo node_modules + builds)
- **Tiempo de provisioning visible:** ~80 segundos
- **Tiempo total real (cluster + ECS healthy):** ~7-10 min
- **Costo por sandbox/día:** ~$2 USD (Aurora db.t3.medium + Fargate task)
- **Recursos AWS creados por sandbox:** 6 (cluster + instance + service + TG + rule + DDB record)
- **Cleanup:** automático via tag `expires=2026-05-30` + DevOps reaper

---

## Stack

| Capa | Tecnología |
| :-- | :-- |
| LLM | Anthropic API (claude-sonnet-4-20250514) |
| Frontend | Single HTML, Google Identity Services, deployed via HTML Publisher |
| Backend | Node.js 24 arm64 Lambdas + HTTP API Gateway |
| Data plane | Aurora PostgreSQL 15.15, ECS Fargate, ALB shared |
| Container build | AWS CodeBuild + ECR (sin Docker local — POC SCP bloquea S3) |
| Auth | Google Sign In + JWT verify (tokeninfo) + Bearer token |
| Sessions | DynamoDB on-demand con TTL |

---

## Roadmap post-hackathon

### Short-term (semanas)
- **Real per-sandbox checkout URL** (`sandbox-{id}.checkout.aplazo.net`) — requiere wildcard DNS + cert + el `checkout-engine` real corriendo en Fargate (no nuestro mock). **Documentado como hackathon blocker en [`URL-STRATEGY.md`](./URL-STRATEGY.md)**, plan post-win en 3 fases (~3-4 semanas para llegar a la visión completa del PRD).
- **Backend proxy para Anthropic** — quitar la API key del browser, proxearlo via Lambda
- **Cleanup Lambda** — destroy sandbox bajo demanda (botón en UI), no esperar al reaper
- **Pool de snapshots pre-restored** — bajar el tiempo de provisioning de 7 min a <30s

### Long-term (post-hackathon real)
- **Cognito + Google Workspace** para el login del HTML (en lugar del GIS-only gate)
- **Angular 20 SPA frontend** (migrar del single HTML)
- **Step Functions para el flow largo** en vez del polling síncrono dentro de Lambdas
- **CI/CD pipeline** (GitHub Actions → deploy-direct.sh on merge to main)
- **Métricas / observability** (CloudWatch dashboards, costo por sandbox tracking)

---

## Quick links

- 🎬 **Demo:** https://www.aplazo.ai/engineering/sandboxagent-demo-may2026.html
- 📦 **Repo:** https://github.com/aplazo/ai.hackathon26.sandbox-agent
- 📋 **PRD v1.6:** [Google Docs](https://docs.google.com/document/d/1ik5-MMWy6xAygyAH-GNyckvfk9qgYVLSSmKjYIiiSts/)
- 📘 **HANDOFF doc para el próximo dev:** [`HANDOFF.md`](./HANDOFF.md)
- 📕 **Setup local para devs nuevos:** [`README.md`](./README.md)
- 🏗️ **Pulumi infra de referencia:** https://github.com/aplazo/node.pulumi-infrastructure
- 💬 **Slack:** `#hackathon-support-2026`

---

## Team / créditos

- **Build:** Francisco Lanuza (`francisco.lanuza@aplazo.mx`)
- **Infra support:** Duvan Bedoya, Brandom Marañon (DevOps)
- **Snapshot de staging:** Equipo de DevOps (compartido vía cross-account)
- **Anthropic API:** Vía Uziel + IT (Jorge / Vero)
- **AI pair programming:** Claude Code (Opus 4.7, 1M context)

---

## ¿Probarlo?

1. **Acceder al demo**: https://www.aplazo.ai/engineering/sandboxagent-demo-may2026.html
2. **Login con tu cuenta @aplazo.mx** (si no autorizan otras, el JWT verify lo bloquea)
3. **Generar un sandbox**:
   - Merchant ID: `walmart_mx` (o cualquier nombre)
   - Integration type: `API`
   - Click **Generate sandbox**
4. **Ver el stepper** corriendo los 7 tools en tiempo real (~80s)
5. **Inspeccionar el summary card** con el merchant real creado + checkout URL real
6. **Click "Visit Sandbox"** → abre la página del Fargate task con los datos del merchant
7. **Click "Open Checkout"** → real Aplazo checkout con un loan real ya pre-creado

Si querés ver los recursos reales que se crearon, AWS Console:

- [RDS clusters](https://us-east-1.console.aws.amazon.com/rds/home?region=us-east-1#databases:) — busca `sandbox-*-cluster`
- [ECS cluster poc-hackaton-cluster](https://us-east-1.console.aws.amazon.com/ecs/v2/clusters/poc-hackaton-cluster) — busca services `sba-*-svc`
- [ALB apz-poc-hackaton](https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#LoadBalancer:) → Listener rules

Todo con tag `project=sandboxagent` para filtrar.
