const { isoNow } = require('./ids');

const BRANCH_REQUIRED = new Set(['API_OFFLINE']);

const SUPPORTED_INTEGRATION_TYPES = ['API', 'API_OFFLINE'];

function branchRequired(integrationType) {
  return BRANCH_REQUIRED.has(integrationType);
}

function mockSnapshotConfig() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return {
    snapshotArn: `arn:aws:rds:us-east-1:123456789012:snapshot:aplazo-staging-clean-${stamp}`,
    snapshotId: `aplazo-staging-clean-${stamp}`,
    coreImages: [
      { service: 'checkout-api',   imageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/checkout-api:latest' },
      { service: 'merchant-api',   imageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/merchant-api:latest' },
      { service: 'payment-engine', imageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/payment-engine:latest' },
    ],
    estimatedRestoreMinutes: 8,
  };
}

function mockRestoreRds(sandboxId) {
  return {
    dbInstanceId: `sandbox-${sandboxId}`,
    status: 'available',
    endpoint: `sandbox-${sandboxId}.cluster-xyz.us-east-1.rds.amazonaws.com`,
    port: 5432,
    estimatedReadyInSeconds: 0,
    mock: true,
  };
}

function mockCreateMerchant({ merchantRef, integrationType }) {
  const merchantId = 2600 + Math.floor(Math.random() * 400);
  const apiToken = `mock-${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 6)}-mock`;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return {
    merchantId,
    apiToken,
    commerceName: `SandboxAgent ${merchantRef} ${stamp}`,
    integrationType,
    branchCreated: branchRequired(integrationType),
    branchName: branchRequired(integrationType) ? 'Sucursal No 1' : null,
    mock: true,
  };
}

function mockDeployEcs({ sandboxId }) {
  const base = `https://sandbox-${sandboxId}.aplazo.ai`;
  return {
    clusterId: `sandbox-${sandboxId}`,
    services: [
      { name: 'checkout-api',   status: 'RUNNING', url: `${base.replace('.aplazo.ai', '-checkout.aplazo.ai')}` },
      { name: 'merchant-api',   status: 'RUNNING', url: `${base.replace('.aplazo.ai', '-merchant.aplazo.ai')}` },
      { name: 'payment-engine', status: 'RUNNING', url: `${base.replace('.aplazo.ai', '-payment.aplazo.ai')}` },
    ],
    sandboxBaseUrl: base,
    mock: true,
  };
}

function mockConfigureMerchant({ merchantId }) {
  return {
    merchantId,
    displayName: typeof merchantId === 'string' ? merchantId : `merchant_${merchantId}`,
    syntheticUserId: `synthetic_${Math.random().toString(36).slice(2, 9)}`,
    creditLimit: 10000,
    creditUsed: 0,
    configuredAt: isoNow(),
    mock: true,
  };
}

function mockValidate({ sandboxBaseUrl, syntheticUserId }) {
  const loanId = `loan_${Math.random().toString(36).slice(2, 9)}`;
  return {
    allChecksPass: true,
    checks: [
      { name: 'auth_endpoint',   pass: true, statusCode: 200, detail: 'Bearer token issued' },
      { name: 'loan_creation',   pass: true, statusCode: 200, detail: 'Loan created, checkout URL ready' },
      { name: 'db_connectivity', pass: true, detail: 'DB instance responding' },
      { name: 'ecs_services',    pass: true, detail: 'All 3 services RUNNING' },
    ],
    checkoutUrl: `${sandboxBaseUrl}/checkout/${loanId}?user=${syntheticUserId}`,
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
