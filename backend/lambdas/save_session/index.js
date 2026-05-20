const { ok, error, parseBody } = require('../shared/response');
const { checkBearer } = require('../shared/auth');
const { sessionId, isoNow, expiresAt, unixExpiry } = require('../shared/ids');

const MOCK_MODE = process.env.MOCK_MODE === 'true';
const TABLE_NAME = process.env.SESSIONS_TABLE || 'sandboxagent-sessions';
const TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || '10');

exports.handler = async (event) => {
  const auth = checkBearer(event);
  if (!auth.ok) return error(401, 'unauthorized', auth.reason);

  const { sandbox_id, merchant_id, checkout_url, synthetic_user, config_snapshot, label } = parseBody(event);
  if (!sandbox_id || !label) {
    return error(400, 'invalid_input', 'sandbox_id and label are required');
  }

  const id = sessionId();
  const item = {
    sessionId: id,
    sandboxId: sandbox_id,
    merchantId: merchant_id ?? null,
    checkoutUrl: checkout_url ?? null,
    syntheticUser: synthetic_user ?? null,
    config: config_snapshot ?? {},
    label,
    createdAt: isoNow(),
    expiresAt: expiresAt(TTL_DAYS),
    ttl: unixExpiry(TTL_DAYS),
  };

  if (MOCK_MODE) {
    return ok({ success: true, sessionId: id, label, expiresAt: item.expiresAt, mock: true });
  }

  try {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
    return ok({ success: true, sessionId: id, label, expiresAt: item.expiresAt });
  } catch (e) {
    return error(500, 'dynamodb_put_failed', e.message);
  }
};
