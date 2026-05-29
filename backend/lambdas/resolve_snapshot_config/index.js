const { ok, error, parseBody } = require('../shared/response');
const { checkBearer } = require('../shared/auth');
const { mockSnapshotConfig } = require('../shared/mock-data');
const { isAuroraClusterSnapshot } = require('../shared/snapshot');
const { RDSClient, DescribeDBSnapshotsCommand, DescribeDBClusterSnapshotsCommand } = require('@aws-sdk/client-rds');

const MOCK_MODE = process.env.MOCK_MODE === 'true';
const REGION = process.env.AWS_REGION || 'us-east-1';
const ACCOUNT_ID = process.env.POC_ACCOUNT_ID || '332730082760';
const GOLDEN_SNAPSHOT = process.env.RDS_GOLDEN_SNAPSHOT || 'sandboxagent-golden-v1';
const ECR_IMAGE_URI = process.env.ECR_IMAGE_URI || `${ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/sandboxagent/checkout:latest`;

// Module-scoped singleton — reused across warm invocations.
const rds = new RDSClient({ region: REGION });

/**
 * Tool 1 — resolve_snapshot_config
 *
 * Auto-detects whether RDS_GOLDEN_SNAPSHOT points at:
 *   - a regular RDS DB snapshot (our default sandboxagent-golden-v1)
 *   - an Aurora cluster snapshot (e.g. apzdbstg-hackathon-east1 once shared)
 *
 * In both cases returns the ARN + the single mini-app image. The downstream
 * Lambda restore_rds_snapshot reads the ARN format and dispatches accordingly.
 */
exports.handler = async (event) => {
  const auth = checkBearer(event);
  if (!auth.ok) return error(401, 'unauthorized', auth.reason);

  const { merchant_id } = parseBody(event);
  if (!merchant_id) return error(400, 'invalid_input', 'merchant_id is required');

  if (MOCK_MODE) return ok(mockSnapshotConfig());

  try {
    const isAurora = isAuroraClusterSnapshot(GOLDEN_SNAPSHOT);

    let snapshotArn = null;
    let snapshotId  = null;
    let sourceDb    = null;
    let engine      = null;
    let estimatedRestoreMinutes = 5;

    if (isAurora) {
      const out = await rds.send(new DescribeDBClusterSnapshotsCommand({
        DBClusterSnapshotIdentifier: GOLDEN_SNAPSHOT,
        IncludeShared: true,
      }));
      const snap = out.DBClusterSnapshots?.[0];
      if (!snap) return error(404, 'snapshot_missing', `Aurora cluster snapshot ${GOLDEN_SNAPSHOT} not found / not shared`);
      snapshotArn = snap.DBClusterSnapshotArn;
      snapshotId  = snap.DBClusterSnapshotIdentifier;
      sourceDb    = snap.DBClusterIdentifier;
      engine      = snap.Engine;
      estimatedRestoreMinutes = 7; // cluster + instance
    } else {
      const out = await rds.send(new DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: GOLDEN_SNAPSHOT }));
      const snap = out.DBSnapshots?.[0];
      if (!snap) return error(404, 'snapshot_missing', `Golden snapshot ${GOLDEN_SNAPSHOT} not found`);
      snapshotArn = snap.DBSnapshotArn;
      snapshotId  = snap.DBSnapshotIdentifier;
      sourceDb    = snap.DBInstanceIdentifier;
      engine      = snap.Engine;
    }

    return ok({
      snapshotArn,
      snapshotId,
      isAuroraCluster: isAurora,
      sourceRegion: REGION,
      sourceDbInstance: sourceDb,
      engine,
      coreImages: [{ service: 'checkout', imageUri: ECR_IMAGE_URI }],
      estimatedRestoreMinutes,
    });
  } catch (e) {
    console.error('resolve_snapshot_config failed', e);
    return error(500, 'aws_call_failed', `${e.name || 'Error'}: ${e.message}`);
  }
};
