const { ok, error, parseBody } = require('../shared/response');
const { checkBearer } = require('../shared/auth');
const { mockDeployEcs } = require('../shared/mock-data');
const { mandatoryTags } = require('../shared/tags');

const MOCK_MODE = process.env.MOCK_MODE === 'true';
const REGION = process.env.AWS_REGION || 'us-east-1';
const CLUSTER = process.env.ECS_CLUSTER || 'poc-hackaton-cluster';
const ECS_SG_ID = process.env.ECS_SG_ID || '';
const SUBNET_IDS = (process.env.SUBNET_IDS || '').split(',').filter(Boolean);
const TASK_ROLE_ARN = process.env.TASK_EXECUTION_ROLE_ARN || '';
const ECR_IMAGE_URI = process.env.ECR_IMAGE_URI || '';
const LISTENER_ARN = process.env.LISTENER_ARN || '';
const VPC_ID = process.env.VPC_ID || '';
const SANDBOX_BASE_HOST = process.env.SANDBOX_BASE_HOST || '';
const FIRE_POLL_BUDGET_MS = 20_000;
const POLL_INTERVAL_MS = 5_000;

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function hashPriority(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return 1000 + (Math.abs(h) % 8000);
}

/**
 * Tool 4 — deploy_ecs_services (REAL)
 *
 * Per sandbox we create:
 *   - 1 ECS task definition (sandboxagent-sandbox-{id}-td)
 *   - 1 ALB target group (sba-{id}-tg)
 *   - 1 ALB listener rule (path-pattern /sandbox-{id}/*)
 *   - 1 ECS Fargate service (sba-{id}-svc) registered with the target group
 *
 * Fire-and-poll-short (max ~20s). ECS service takes longer to be RUNNING
 * but the route is live the moment the task registers with ALB (~1-2 min
 * after CreateService).
 */
exports.handler = async (event) => {
  const auth = checkBearer(event);
  if (!auth.ok) return error(401, 'unauthorized', auth.reason);

  const body = parseBody(event);
  const {
    sandbox_id, db_endpoint, merchant_id, merchant_name, integration_type,
    checkout_url, requester,
  } = body;
  if (!sandbox_id) return error(400, 'invalid_input', 'sandbox_id is required');

  if (MOCK_MODE) {
    await sleep(1200);
    return ok(mockDeployEcs({ sandboxId: sandbox_id }));
  }

  if (!ECR_IMAGE_URI || !TASK_ROLE_ARN || !LISTENER_ARN || !ECS_SG_ID || !SUBNET_IDS.length) {
    return error(500, 'misconfigured', 'Data plane env vars not set on this Lambda — check deploy-direct.sh + data-plane-config.env');
  }

  try {
    const ecsLib = require('@aws-sdk/client-ecs');
    const elbLib = require('@aws-sdk/client-elastic-load-balancing-v2');
    const ecs = new ecsLib.ECSClient({ region: REGION });
    const elb = new elbLib.ElasticLoadBalancingV2Client({ region: REGION });

    const shortId = String(sandbox_id).replace(/^sb_?/, '').slice(0, 12);
    const family = `sba-${shortId}-td`;
    const serviceName = `sba-${shortId}-svc`;
    const tgName = `sba-${shortId}-tg`;
    const ruleName = `sba-${shortId}-rule`;
    const pathPrefix = `/sandbox-${shortId}`;
    const tags = mandatoryTags({ requester, sandboxId: sandbox_id, merchantRef: merchant_id, integrationType: integration_type });
    const tagsKV = tags.map((t) => ({ key: t.Key, value: t.Value }));
    const tagsKeyValue = tags.map((t) => ({ Key: t.Key, Value: t.Value }));
    const sandboxUrl = SANDBOX_BASE_HOST ? `http://${SANDBOX_BASE_HOST}${pathPrefix}/` : null;

    // 1. Register task definition with sandbox-specific env vars
    const taskDef = await ecs.send(new ecsLib.RegisterTaskDefinitionCommand({
      family,
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      cpu: '256',
      memory: '512',
      runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
      executionRoleArn: TASK_ROLE_ARN,
      taskRoleArn: TASK_ROLE_ARN,
      containerDefinitions: [{
        name: 'checkout',
        image: ECR_IMAGE_URI,
        essential: true,
        portMappings: [{ containerPort: 8080, protocol: 'tcp' }],
        environment: [
          { name: 'PORT', value: '8080' },
          { name: 'SANDBOX_ID', value: String(sandbox_id) },
          { name: 'MERCHANT_ID', value: String(merchant_id || '') },
          { name: 'MERCHANT_NAME', value: String(merchant_name || '') },
          { name: 'INTEGRATION_TYPE', value: String(integration_type || '') },
          { name: 'CHECKOUT_URL', value: String(checkout_url || '') },
          { name: 'RDS_INSTANCE', value: `sandbox-${sandbox_id}` },
          { name: 'ECS_SERVICE', value: serviceName },
          { name: 'CREATED_AT', value: new Date().toISOString() },
          { name: 'DB_ENDPOINT', value: String(db_endpoint || '') },
        ],
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': '/ecs/sandboxagent',
            'awslogs-region': REGION,
            'awslogs-stream-prefix': shortId,
            'awslogs-create-group': 'true',
          },
        },
      }],
      tags: tagsKV,
    }));

    // 2. Create target group
    let tgArn;
    try {
      const tgRes = await elb.send(new elbLib.CreateTargetGroupCommand({
        Name: tgName,
        Protocol: 'HTTP',
        Port: 8080,
        VpcId: VPC_ID,
        TargetType: 'ip',
        HealthCheckPath: '/health',
        HealthCheckIntervalSeconds: 15,
        HealthyThresholdCount: 2,
        Matcher: { HttpCode: '200' },
        Tags: tagsKeyValue,
      }));
      tgArn = tgRes.TargetGroups[0].TargetGroupArn;
    } catch (e) {
      if (/DuplicateTargetGroupName/.test(String(e?.name) + String(e?.message))) {
        const found = await elb.send(new elbLib.DescribeTargetGroupsCommand({ Names: [tgName] }));
        tgArn = found.TargetGroups[0].TargetGroupArn;
      } else throw e;
    }

    // 3. Create listener rule (path-pattern /sandbox-{id}/*)
    const priority = hashPriority(shortId);
    let ruleArn;
    try {
      const rules = await elb.send(new elbLib.DescribeRulesCommand({ ListenerArn: LISTENER_ARN }));
      const existing = (rules.Rules || []).find((r) =>
        r.Conditions?.some((c) => c.PathPatternConfig?.Values?.includes(`${pathPrefix}/*`)));
      if (existing) {
        ruleArn = existing.RuleArn;
      } else {
        let attempts = 0;
        let basePriority = priority;
        while (attempts < 20) {
          try {
            const ruleRes = await elb.send(new elbLib.CreateRuleCommand({
              ListenerArn: LISTENER_ARN,
              Priority: basePriority + attempts,
              Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: [`${pathPrefix}/*`, pathPrefix] } }],
              Actions: [{ Type: 'forward', TargetGroupArn: tgArn }],
              Tags: tagsKeyValue,
            }));
            ruleArn = ruleRes.Rules[0].RuleArn;
            break;
          } catch (e) {
            if (/PriorityInUse/.test(String(e?.name) + String(e?.message))) { attempts++; continue; }
            throw e;
          }
        }
      }
    } catch (e) { throw e; }

    // 4. Create ECS service
    try {
      await ecs.send(new ecsLib.CreateServiceCommand({
        cluster: CLUSTER,
        serviceName,
        taskDefinition: taskDef.taskDefinition.taskDefinitionArn,
        desiredCount: 1,
        launchType: 'FARGATE',
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: SUBNET_IDS,
            securityGroups: [ECS_SG_ID],
            assignPublicIp: 'ENABLED', // needed for ECR pull from public subnet without NAT
          },
        },
        loadBalancers: [{
          targetGroupArn: tgArn,
          containerName: 'checkout',
          containerPort: 8080,
        }],
        healthCheckGracePeriodSeconds: 60,
        tags: tagsKV,
      }));
    } catch (e) {
      if (!/ServiceAlreadyExists/.test(String(e?.name) + String(e?.message))) throw e;
    }

    // 5. Fire-and-poll-short
    const start = Date.now();
    let runningCount = 0;
    while (Date.now() - start < FIRE_POLL_BUDGET_MS) {
      await sleep(POLL_INTERVAL_MS);
      try {
        const desc = await ecs.send(new ecsLib.DescribeServicesCommand({ cluster: CLUSTER, services: [serviceName] }));
        const svc = desc.services?.[0];
        if (svc) {
          runningCount = svc.runningCount || 0;
          if (runningCount >= 1) break;
        }
      } catch (_) { /* keep polling */ }
    }

    return ok({
      clusterId: CLUSTER,
      services: [{
        name: serviceName,
        status: runningCount >= 1 ? 'RUNNING' : 'PROVISIONING',
        url: sandboxUrl,
      }],
      sandboxBaseUrl: sandboxUrl,
      targetGroupArn: tgArn,
      listenerRuleArn: ruleArn,
      taskDefinitionArn: taskDef.taskDefinition.taskDefinitionArn,
      estimatedReadyInSeconds: runningCount >= 1 ? 0 : 90,
    });
  } catch (e) {
    console.error('deploy_ecs_services failed', e);
    return error(500, 'aws_call_failed', `${e.name || 'Error'}: ${e.message}`);
  }
};
