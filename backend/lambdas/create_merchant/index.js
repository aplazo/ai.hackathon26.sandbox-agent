const { ok, error, parseBody } = require('../shared/response');
const { checkBearer } = require('../shared/auth');
const { mockCreateMerchant, branchRequired, SUPPORTED_INTEGRATION_TYPES } = require('../shared/mock-data');
const { compactTimestamp } = require('../shared/ids');

const MOCK_MODE = process.env.MOCK_MODE === 'true';
const MERCHANT_CREATION_URL = process.env.MERCHANT_CREATION_URL
  || 'https://jwaakdci64.execute-api.us-west-1.amazonaws.com/merchant_creation';
const BRANCH_URL = process.env.BRANCH_URL
  || 'https://merchant.aplazo.net/merchant/create-branch';
const DEFAULT_CUSTOMER_FEE = 0.18;

exports.handler = async (event) => {
  const auth = checkBearer(event);
  if (!auth.ok) return error(401, 'unauthorized', auth.reason);

  const { sandbox_id, merchant_ref, integration_type, customer_fee } = parseBody(event);
  if (!sandbox_id || !merchant_ref || !integration_type) {
    return error(400, 'invalid_input', 'sandbox_id, merchant_ref and integration_type are required');
  }
  if (!SUPPORTED_INTEGRATION_TYPES.includes(integration_type)) {
    return error(400, 'invalid_integration_type',
      `integration_type must be one of: ${SUPPORTED_INTEGRATION_TYPES.join(', ')}`);
  }

  if (MOCK_MODE) {
    return ok(mockCreateMerchant({ merchantRef: merchant_ref, integrationType: integration_type }));
  }

  const commerceName = `SandboxAgent ${merchant_ref} ${compactTimestamp()}`;
  const fee = typeof customer_fee === 'number' ? customer_fee : DEFAULT_CUSTOMER_FEE;

  let createRes;
  try {
    const r = await fetch(MERCHANT_CREATION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commerce_name: commerceName,
        cat_integration_type: integration_type,
        customer_fee: fee,
      }),
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
    if (!r.ok) {
      return error(502, 'merchant_creation_failed',
        `Merchant creation Lambda returned ${r.status}: ${text.slice(0, 200)}`);
    }
    createRes = body;
  } catch (e) {
    return error(502, 'merchant_creation_unreachable', e.message);
  }

  const merchantId = createRes.merchant_id ?? createRes.merchantId;
  const apiToken = createRes.api_token ?? createRes.apiToken;
  if (!merchantId || !apiToken) {
    return error(502, 'merchant_creation_bad_response',
      `Expected merchant_id and api_token, got: ${JSON.stringify(createRes).slice(0, 200)}`);
  }

  let branchCreated = false;
  if (branchRequired(integration_type)) {
    try {
      const br = await fetch(BRANCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api_token': apiToken,
          'merchant_id': String(merchantId),
        },
        body: JSON.stringify({ branches: ['Sucursal No 1'] }),
      });
      branchCreated = br.ok;
      if (!br.ok) {
        const txt = await br.text();
        return error(502, 'branch_creation_failed',
          `Branch creation returned ${br.status}: ${txt.slice(0, 200)}`);
      }
    } catch (e) {
      return error(502, 'branch_creation_unreachable', e.message);
    }
  }

  return ok({
    merchantId,
    apiToken,
    commerceName,
    integrationType: integration_type,
    branchCreated,
    branchName: branchCreated ? 'Sucursal No 1' : null,
  });
};
