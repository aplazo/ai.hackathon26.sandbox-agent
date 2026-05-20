const { ok, error, parseBody } = require('../shared/response');
const { checkBearer } = require('../shared/auth');
const { mockDeployEcs } = require('../shared/mock-data');
const { mandatoryTags } = require('../shared/tags');
const { clientForStaging } = require('../shared/aws');

const MOCK_MODE = process.env.MOCK_MODE === 'true';
const SUBNETS = (process.env.SUBNET_IDS || '').split(',').filter(Boolean);
const SECURITY_GROUPS = (process.env.SECURITY_GROUP_IDS || '').split(',').filter(Boolean);
const TASK_EXECUTION_ROLE_ARN = process.env.TASK_EXECUTION_ROLE_ARN;
const TASK_ROLE_ARN = process.env.TASK_ROLE_ARN;
const SANDBOX_DOMAIN = process.env.SANDBOX_DOMAIN || 'aplazo.ai';
const STAGING_CLUSTER = process.env.STAGING_CLUSTER || 'aplazo-stg-cluster';

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Tool 4 — deploy_ecs_services.
 *
 * Auto-discovery strategy:
 *   1. Cross-account read of the staging task definitions in main us-west-1
 *      (DescribeTaskDefinition for each service in the staging cluster).
 *   2. Clone each into POC us-east-1, overriding the DB endpoint env var and
 *      sandbox-specific values. This guarantees parity with what Pulumi deploys
 *      (CPU/memory/port/env vars/secrets) per
 *      github.com/aplazo/node.pulumi-infrastructure.
 *   3. If discovery fails for a service, fall back to a synthesized task def
 *      using the imageUri from Tool 1.
 *
 * Creates the cluster + services in POC us-east-1.
 */
exports.handler = async (event) => {
  const auth = checkBearer(event);
  if (!auth.ok) return error(401, 'unauthorized', auth.reason);

  const { sandbox_id, db_endpoint, core_images, merchant_id, requester } = parseBody(event);
  if (!sandbox_id || !core_images || !Array.isArray(core_images)) {
    return error(400, 'invalid_input', 'sandbox_id and core_images[] are required');
  }

  if (MOCK_MODE) {
    await sleep(1200);
    return ok(mockDeployEcs({ sandboxId: sandbox_id }));
  }

  try {
    const ecsClient = require('@aws-sdk/client-ecs');
    const localEcs = new ecsClient.ECSClient({});
    const stagingEcs = await clientForStaging(ecsClient.ECSClient);

    const clusterName = `sandbox-${sandbox_id}`;
    const tags = mandatoryTags({ requester, sandboxId: sandbox_id, merchantRef: merchant_id });

    await localEcs.send(new ecsClient.CreateClusterCommand({
      clusterName,
      tags: tags.map((t) => ({ key: t.Key, value: t.Value })),
    }));

    const services = [];
    for (const img of core_images) {
      const family = `sandbox-${sandbox_id}-${img.service}`;
      let taskDefArn = null;

      try {
        const list = await stagingEcs.send(new ecsClient.ListTaskDefinitionsCommand({
          familyPrefix: img.service, status: 'ACTIVE', sort: 'DESC', maxResults: 1,
        }));
        const sourceArn = list.taskDefinitionArns?.[0];
        if (sourceArn) {
          const src = await stagingEcs.send(new ecsClient.DescribeTaskDefinitionCommand({ taskDefinition: sourceArn }));
          const sourceTd = src.taskDefinition;
          const containers = sourceTd.containerDefinitions.map((c) => ({
            ...c,
            image: img.imageUri,
            environment: [
              ...(c.environment || []).filter((e) => !['DB_ENDPOINT', 'MERCHANT_ID', 'SANDBOX_ID'].includes(e.name)),
              { name: 'DB_ENDPOINT', value: db_endpoint || '' },
              { name: 'SANDBOX_ID',  value: sandbox_id },
              { name: 'MERCHANT_ID', value: String(merchant_id || '') },
            ],
          }));
          const reg = await localEcs.send(new ecsClient.RegisterTaskDefinitionCommand({
            family,
            networkMode: sourceTd.networkMode || 'awsvpc',
            requiresCompatibilities: sourceTd.requiresCompatibilities || ['FARGATE'],
            cpu: sourceTd.cpu || '512',
            memory: sourceTd.memory || '1024',
            executionRoleArn: TASK_EXECUTION_ROLE_ARN,
            taskRoleArn: TASK_ROLE_ARN,
            containerDefinitions: containers,
            tags: tags.map((t) => ({ key: t.Key, value: t.Value })),
          }));
          taskDefArn = reg.taskDefinition.taskDefinitionArn;
        }
      } catch (e) {
        console.warn(`Cross-account TD discovery failed for ${img.service}: ${e.message}`);
      }

      if (!taskDefArn) {
        const reg = await localEcs.send(new ecsClient.RegisterTaskDefinitionCommand({
          family,
          networkMode: 'awsvpc',
          requiresCompatibilities: ['FARGATE'],
          cpu: '512',
          memory: '1024',
          executionRoleArn: TASK_EXECUTION_ROLE_ARN,
          taskRoleArn: TASK_ROLE_ARN,
          containerDefinitions: [{
            name: img.service,
            image: img.imageUri,
            essential: true,
            portMappings: [{ containerPort: 8080, protocol: 'tcp' }],
            environment: [
              { name: 'DB_ENDPOINT', value: db_endpoint || '' },
              { name: 'SANDBOX_ID', value: sandbox_id },
              { name: 'MERCHANT_ID', value: String(merchant_id || '') },
            ],
          }],
          tags: tags.map((t) => ({ key: t.Key, value: t.Value })),
        }));
        taskDefArn = reg.taskDefinition.taskDefinitionArn;
      }

      await localEcs.send(new ecsClient.CreateServiceCommand({
        cluster: clusterName,
        serviceName: img.service,
        taskDefinition: taskDefArn,
        desiredCount: 1,
        launchType: 'FARGATE',
        networkConfiguration: {
          awsvpcConfiguration: { subnets: SUBNETS, securityGroups: SECURITY_GROUPS, assignPublicIp: 'DISABLED' },
        },
        tags: tags.map((t) => ({ key: t.Key, value: t.Value })),
      }));

      services.push({
        name: img.service,
        status: 'PROVISIONING',
        url: `https://sandbox-${sandbox_id}-${img.service}.${SANDBOX_DOMAIN}`,
      });
    }

    const start = Date.now();
    const MAX_WAIT_MS = 4 * 60 * 1000;
    while (Date.now() - start < MAX_WAIT_MS) {
      await sleep(15000);
      const desc = await localEcs.send(new ecsClient.DescribeServicesCommand({
        cluster: clusterName,
        services: services.map((s) => s.name),
      }));
      let allRunning = true;
      for (const svc of desc.services || []) {
        const target = services.find((s) => s.name === svc.serviceName);
        if (target) target.status = svc.runningCount === svc.desiredCount ? 'RUNNING' : 'PROVISIONING';
        if (svc.runningCount !== svc.desiredCount) allRunning = false;
      }
      if (allRunning) break;
    }

    return ok({
      clusterId: clusterName,
      services,
      sandboxBaseUrl: `https://sandbox-${sandbox_id}.${SANDBOX_DOMAIN}`,
    });
  } catch (e) {
    return error(500, 'ecs_deploy_failed', e.message);
  }
};
