/**
 * Mock fixtures — LOCAL DEV ONLY.
 *
 * Every deployed Lambda runs with MOCK_MODE=false (see deploy-direct.sh), so
 * none of this executes in the POC environment. It exists so the API can be
 * exercised locally / offline without touching real AWS or Aplazo APIs.
 *
 * IMPORTANT: keep each mock's shape in lock-step with its real handler's `ok()`
 * response. They had drifted (3 services + subdomain URLs vs the real single
 * `checkout` container + path routing); re-synced 2026-05. If you change a
 * handler's output shape, update the matching mock here.
 */
const { isoNow, syntheticUserId, compactTimestamp } = require('./ids');
const { ecsService, targetGroup, taskFamily, pathPrefix, rdsInstance } = require('./naming');

const BRANCH_REQUIRED = new Set(['API_OFFLINE']);

const SUPPORTED_INTEGRATION_TYPES = ['API', 'API_OFFLINE'];

// Host the real deploy uses comes from SANDBOX_BASE_HOST; this is a stand-in.
const MOCK_ALB_HOST = 'apz-poc-hackaton.mock.elb.amazonaws.com';

function branchRequired(integrationType) {
  return BRANCH_REQUIRED.has(integrationType);
}

// Mirrors resolve_snapshot_config (regular RDS path).
function mockSnapshotConfig() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const snapshotId = `aplazo-staging-clean-${stamp}`;
  return {
    snapshotArn: `arn:aws:rds:us-east-1:123456789012:snapshot:${snapshotId}`,
    snapshotId,
    isAuroraCluster: false,
    sourceRegion: 'us-east-1',
    sourceDbInstance: 'aplazo-staging',
    engine: 'postgres',
    coreImages: [{ service: 'checkout', imageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/sandboxagent/checkout:latest' }],
    estimatedRestoreMinutes: 5,
    mock: true,
  };
}

// Mirrors restore_rds_snapshot (regular RDS path).
function mockRestoreRds(sandboxId) {
  const dbInstanceId = rdsInstance(sandboxId);
  return {
    isAurora: false,
    dbInstanceId,
    status: 'available',
    endpoint: `${dbInstanceId}.cluster-xyz.us-east-1.rds.amazonaws.com`,
    port: 5432,
    sourceSnapshot: 'aplazo-staging-clean',
    alreadyExisted: false,
    estimatedReadyInSeconds: 0,
    mock: true,
  };
}

// Mirrors create_merchant.
function mockCreateMerchant({ merchantRef, integrationType }) {
  const merchantId = 2600 + Math.floor(Math.random() * 400);
  const apiToken = `mock-${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 6)}-mock`;
  return {
    merchantId,
    apiToken,
    commerceName: `SandboxAgent ${merchantRef} ${compactTimestamp()}`,
    integrationType,
    branchCreated: branchRequired(integrationType),
    branchName: branchRequired(integrationType) ? 'Sucursal No 1' : null,
    mock: true,
  };
}

// Mirrors deploy_ecs_services — ONE checkout service, path-routed on the ALB.
function mockDeployEcs({ sandboxId }) {
  const serviceName = ecsService(sandboxId);
  const sandboxUrl = `http://${MOCK_ALB_HOST}${pathPrefix(sandboxId)}/`;
  return {
    clusterId: 'poc-hackaton-cluster',
    services: [{ name: serviceName, status: 'RUNNING', url: sandboxUrl }],
    sandboxBaseUrl: sandboxUrl,
    targetGroupArn: `arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/${targetGroup(sandboxId)}/mock`,
    listenerRuleArn: `arn:aws:elasticloadbalancing:us-east-1:123456789012:listener-rule/app/apz-poc-hackaton/mock/mock/mock`,
    taskDefinitionArn: `arn:aws:ecs:us-east-1:123456789012:task-definition/${taskFamily(sandboxId)}:1`,
    estimatedReadyInSeconds: 0,
    mock: true,
  };
}

// Mirrors configure_merchant.
function mockConfigureMerchant({ merchantId, sandboxId }) {
  return {
    merchantId,
    displayName: typeof merchantId === 'string' ? merchantId : `merchant_${merchantId}`,
    syntheticUserId: syntheticUserId(),
    creditLimit: 10000,
    creditUsed: 0,
    ecsService: sandboxId ? ecsService(sandboxId) : 'sba-mock-svc',
    ecsStatus: 'ACTIVE',
    ecsRunningCount: 1,
    configuredAt: isoNow(),
    mock: true,
  };
}

// Mirrors validate_sandbox.
function mockValidate({ sandboxBaseUrl, syntheticUserId: userId }) {
  const loanId = `loan_${Math.random().toString(36).slice(2, 9)}`;
  return {
    allChecksPass: true,
    checks: [
      { name: 'auth_endpoint',   pass: true, statusCode: 200, detail: 'Bearer token issued' },
      { name: 'loan_creation',   pass: true, statusCode: 200, detail: `Loan ${loanId} created, checkout URL ready` },
      { name: 'db_connectivity', pass: true, detail: 'DB instance responding (provisioned by Tool 2)' },
      { name: 'ecs_services',    pass: true, detail: 'checkout service RUNNING (provisioned by Tool 4)' },
    ],
    checkoutUrl: `${sandboxBaseUrl}/checkout/${loanId}?user=${userId}`,
    sandboxUrl: sandboxBaseUrl,
    validatedAt: isoNow(),
    mock: true,
  };
}

module.exports = {
  BRANCH_REQUIRED,
  SUPPORTED_INTEGRATION_TYPES,
  branchRequired,
  mockSnapshotConfig,
  mockRestoreRds,
  mockCreateMerchant,
  mockDeployEcs,
  mockConfigureMerchant,
  mockValidate,
};
