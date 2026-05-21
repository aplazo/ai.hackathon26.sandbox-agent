const { ok, error, parseBody } = require('../shared/response');
const { checkBearer } = require('../shared/auth');
const { mockSnapshotConfig } = require('../shared/mock-data');

const MOCK_MODE = process.env.MOCK_MODE === 'true';
const REGION = process.env.AWS_REGION || 'us-east-1';
const ACCOUNT_ID = process.env.POC_ACCOUNT_ID || '332730082760';
const GOLDEN_SNAPSHOT = process.env.RDS_GOLDEN_SNAPSHOT || 'sandboxagent-golden-v1';
const ECR_IMAGE_URI = process.env.ECR_IMAGE_URI || `${ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/sandboxagent/checkout:latest`;

/**
 * Tool 1 — resolve_snapshot_config
 *
 * Real-mode (POC us-east-1 hackathon variant): we use the SandboxAgent golden
 * snapshot (our own seed) since us-west-1 access to staging is denied by SCP.
 * Returns the snapshot ARN + the single mini-app image we use across all
 * sandboxes. Output shape preserved so the agent prompt doesn't change.
 */
exports.handler = async (event) => {
  const auth = checkBearer(event);
  if (!auth.ok) return error(401, 'unauthorized', auth.reason);

  const { merchant_id } = parseBody(event);
  if (!merchant_id) return error(400, 'invalid_input', 'merchant_id is required');

  if (MOCK_MODE) return ok(mockSnapshotConfig());

  try {
    const { RDSClient, DescribeDBSnapshotsCommand } = require('@aws-sdk/client-rds');
    const rds = new RDSClient({ region: REGION });
    const out = await rds.send(new DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: GOLDEN_SNAPSHOT }));
    const snap = out.DBSnapshots?.[0];
    if (!snap) return error(404, 'snapshot_missing', `Golden snapshot ${GOLDEN_SNAPSHOT} not found`);

    return ok({
      snapshotArn: snap.DBSnapshotArn,
      snapshotId: snap.DBSnapshotIdentifier,
      sourceRegion: REGION,
      sourceDbInstance: snap.DBInstanceIdentifier,
      coreImages: [
        { service: 'checkout', imageUri: ECR_IMAGE_URI },
      ],
      estimatedRestoreMinutes: 5,
    });
  } catch (e) {
    console.error('resolve_snapshot_config failed', e);
    return error(500, 'aws_call_failed', `${e.name || 'Error'}: ${e.message}`);
  }
};
