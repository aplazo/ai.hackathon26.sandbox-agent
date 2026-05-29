/**
 * Canonical per-sandbox resource naming. Single source of truth.
 *
 * deploy_ecs_services and configure_merchant MUST agree on the ECS service
 * name or configure can't locate the service it polls — previously the
 * `String(sandbox_id).replace(/^sb_?/, '').slice(0, 12)` derivation was
 * copy-pasted in both, which is exactly the kind of drift that breaks silently.
 */
const shortId = (sandboxId) => String(sandboxId).replace(/^sb_?/, '').slice(0, 12);

const taskFamily  = (id) => `sba-${shortId(id)}-td`;
const ecsService  = (id) => `sba-${shortId(id)}-svc`;
const targetGroup = (id) => `sba-${shortId(id)}-tg`;
const ruleName    = (id) => `sba-${shortId(id)}-rule`;
const pathPrefix  = (id) => `/sandbox-${shortId(id)}`;

// RDS/Aurora names use the full sandbox_id (not the shortId) — kept as-is.
const rdsInstance    = (id) => `sandbox-${id}`;
const auroraCluster  = (id) => `sandbox-${id}-cluster`;
const auroraInstance = (id) => `sandbox-${id}-i1`;

module.exports = {
  shortId, taskFamily, ecsService, targetGroup, ruleName, pathPrefix,
  rdsInstance, auroraCluster, auroraInstance,
};
