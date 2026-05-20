const { ok, error, parseBody } = require('../shared/response');
const { checkBearer } = require('../shared/auth');
const { mockConfigureMerchant } = require('../shared/mock-data');
const { syntheticUserId, isoNow } = require('../shared/ids');

const MOCK_MODE = process.env.MOCK_MODE === 'true';
const DEFAULT_CREDIT = { limit: 10000, used: 0 };

exports.handler = async (event) => {
  const auth = checkBearer(event);
  if (!auth.ok) return error(401, 'unauthorized', auth.reason);

  const { sandbox_id, merchant_id, api_token, integration_type } = parseBody(event);
  if (!sandbox_id || !merchant_id) {
    return error(400, 'invalid_input', 'sandbox_id and merchant_id are required');
  }

  if (MOCK_MODE) {
    return ok(mockConfigureMerchant({ merchantId: merchant_id }));
  }

  try {
    const {
      ECSClient, DescribeServicesCommand, DescribeTaskDefinitionCommand,
      RegisterTaskDefinitionCommand, UpdateServiceCommand,
    } = require('@aws-sdk/client-ecs');
    const ecs = new ECSClient({});
    const clusterName = `sandbox-${sandbox_id}`;

    const services = await ecs.send(new DescribeServicesCommand({
      cluster: clusterName,
      services: ['checkout-api', 'merchant-api', 'payment-engine'],
    }));

    const envVars = [
      { name: 'MERCHANT_ID',      value: String(merchant_id) },
      { name: 'API_TOKEN',        value: String(api_token || '') },
      { name: 'INTEGRATION_TYPE', value: String(integration_type || '') },
    ];

    for (const svc of services.services || []) {
      const taskDefArn = svc.taskDefinition;
      const td = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDefArn }));
      const container = { ...td.taskDefinition.containerDefinitions[0] };
      const existing = new Map((container.environment || []).map((e) => [e.name, e.value]));
      for (const e of envVars) existing.set(e.name, e.value);
      container.environment = Array.from(existing, ([name, value]) => ({ name, value }));

      const newTd = await ecs.send(new RegisterTaskDefinitionCommand({
        family: td.taskDefinition.family,
        networkMode: td.taskDefinition.networkMode,
        requiresCompatibilities: td.taskDefinition.requiresCompatibilities,
        cpu: td.taskDefinition.cpu,
        memory: td.taskDefinition.memory,
        executionRoleArn: td.taskDefinition.executionRoleArn,
        taskRoleArn: td.taskDefinition.taskRoleArn,
        containerDefinitions: [container],
      }));

      await ecs.send(new UpdateServiceCommand({
        cluster: clusterName,
        service: svc.serviceName,
        taskDefinition: newTd.taskDefinition.taskDefinitionArn,
      }));
    }

    return ok({
      merchantId: merchant_id,
      displayName: typeof merchant_id === 'string' ? merchant_id : `merchant_${merchant_id}`,
      syntheticUserId: syntheticUserId(),
      creditLimit: DEFAULT_CREDIT.limit,
      creditUsed: DEFAULT_CREDIT.used,
      configuredAt: isoNow(),
    });
  } catch (e) {
    return error(500, 'ecs_configure_failed', e.message);
  }
};
