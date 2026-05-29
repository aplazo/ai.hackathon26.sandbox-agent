const { ok, error, parseBody } = require('../shared/response');
const { checkBearer } = require('../shared/auth');
const { mockConfigureMerchant } = require('../shared/mock-data');
const { syntheticUserId, isoNow } = require('../shared/ids');
const { sleep } = require('../shared/aws-errors');
const { ecsService } = require('../shared/naming');
const { ECSClient, DescribeServicesCommand } = require('@aws-sdk/client-ecs');

const MOCK_MODE = process.env.MOCK_MODE === 'true';
const REGION = process.env.AWS_REGION || 'us-east-1';
const CLUSTER = process.env.ECS_CLUSTER || 'poc-hackaton-cluster';
const POLL_BUDGET_MS = 15_000;
const POLL_INTERVAL_MS = 3_000;

// Module-scoped singleton — reused across warm invocations.
const ecs = new ECSClient({ region: REGION });

/**
 * Tool 5 — configure_merchant
 *
 * In the real-provisioning path, ECS task definitions already include all the
 * merchant-specific env vars (set in deploy_ecs_services). This Lambda's job
 * is now lighter: confirm the ECS service is healthy, generate a synthetic
 * user_id for the validation step, and return.
 *
 * Returns shape unchanged so the agent prompt doesn't have to change.
 */
exports.handler = async (event) => {
  const auth = checkBearer(event);
  if (!auth.ok) return error(401, 'unauthorized', auth.reason);

  const { sandbox_id, merchant_id } = parseBody(event);
  if (!sandbox_id || !merchant_id) return error(400, 'invalid_input', 'sandbox_id and merchant_id are required');

  if (MOCK_MODE) return ok(mockConfigureMerchant({ merchantId: merchant_id, sandboxId: sandbox_id }));

  const serviceName = ecsService(sandbox_id);
  let serviceStatus = 'UNKNOWN';
  let runningCount = 0;

  try {
    const start = Date.now();
    while (Date.now() - start < POLL_BUDGET_MS) {
      await sleep(POLL_INTERVAL_MS);
      try {
        const desc = await ecs.send(new DescribeServicesCommand({ cluster: CLUSTER, services: [serviceName] }));
        const svc = desc.services?.[0];
        if (svc) {
          serviceStatus = svc.status;
          runningCount = svc.runningCount || 0;
          if (runningCount >= 1) break;
        }
      } catch (e) { console.debug('configure_merchant service poll transient:', e?.name || e?.message); }
    }
  } catch (e) {
    console.error('configure_merchant probe failed', e);
  }

  return ok({
    merchantId: merchant_id,
    displayName: typeof merchant_id === 'string' ? merchant_id : `merchant_${merchant_id}`,
    syntheticUserId: syntheticUserId(),
    creditLimit: 10000,
    creditUsed: 0,
    ecsService: serviceName,
    ecsStatus: serviceStatus,
    ecsRunningCount: runningCount,
    configuredAt: isoNow(),
  });
};
