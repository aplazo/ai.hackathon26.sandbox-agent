const { ok, error, parseBody } = require('../shared/response');
const { checkBearer } = require('../shared/auth');
const { mockRestoreRds } = require('../shared/mock-data');
const { mandatoryTags } = require('../shared/tags');

const MOCK_MODE = process.env.MOCK_MODE === 'true';
const DB_INSTANCE_CLASS = process.env.DB_INSTANCE_CLASS || 'db.t3.medium';
const TARGET_REGION = process.env.AWS_REGION || 'us-east-1';
const POLL_INTERVAL_MS = 15_000;
const MAX_POLL_MS = 14 * 60 * 1000;

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Tool 2 — restore_rds_snapshot.
 *
 * Cross-region copy from main(us-west-1) → POC(us-east-1), then restore in POC.
 *
 *   1. CopyDBSnapshot (in POC us-east-1) from the shared us-west-1 snapshot
 *   2. Wait for copy to be available
 *   3. RestoreDBInstanceFromDBSnapshot from the local copy
 *   4. Poll until the instance is "available"
 */
exports.handler = async (event) => {
  const auth = checkBearer(event);
  if (!auth.ok) return error(401, 'unauthorized', auth.reason);

  const { snapshot_arn, sandbox_id, requester, merchant_ref, integration_type, source_region } = parseBody(event);
  if (!snapshot_arn || !sandbox_id) {
    return error(400, 'invalid_input', 'snapshot_arn and sandbox_id are required');
  }

  if (MOCK_MODE) {
    await sleep(800);
    return ok(mockRestoreRds(sandbox_id));
  }

  try {
    const {
      RDSClient, CopyDBSnapshotCommand, DescribeDBSnapshotsCommand,
      RestoreDBInstanceFromDBSnapshotCommand, DescribeDBInstancesCommand,
    } = require('@aws-sdk/client-rds');
    const rds = new RDSClient({ region: TARGET_REGION });
    const tags = mandatoryTags({ requester, sandboxId: sandbox_id, merchantRef: merchant_ref, integrationType: integration_type });
    const localSnapshotId = `sandbox-src-${sandbox_id}`;
    const dbInstanceId = `sandbox-${sandbox_id}`;

    const srcRegion = source_region || process.env.STAGING_REGION || 'us-west-1';
    const isCrossRegion = srcRegion !== TARGET_REGION;

    let localSnapshotArn = snapshot_arn;
    if (isCrossRegion) {
      await rds.send(new CopyDBSnapshotCommand({
        SourceDBSnapshotIdentifier: snapshot_arn,
        TargetDBSnapshotIdentifier: localSnapshotId,
        SourceRegion: srcRegion,
        Tags: tags,
      }));

      const copyStart = Date.now();
      while (Date.now() - copyStart < 10 * 60 * 1000) {
        await sleep(POLL_INTERVAL_MS);
        const desc = await rds.send(new DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: localSnapshotId }));
        const snap = desc.DBSnapshots?.[0];
        if (snap?.Status === 'available') { localSnapshotArn = snap.DBSnapshotArn; break; }
        if (snap?.Status === 'failed') return error(500, 'snapshot_copy_failed', 'CopyDBSnapshot ended in failed state');
      }
      if (!localSnapshotArn || localSnapshotArn === snapshot_arn) {
        return error(504, 'snapshot_copy_timeout', `CopyDBSnapshot did not finish within 10 minutes (snapshot id: ${localSnapshotId})`);
      }
    }

    await rds.send(new RestoreDBInstanceFromDBSnapshotCommand({
      DBInstanceIdentifier: dbInstanceId,
      DBSnapshotIdentifier: localSnapshotArn,
      DBInstanceClass: DB_INSTANCE_CLASS,
      MultiAZ: false,
      PubliclyAccessible: false,
      Tags: tags,
    }));

    const restoreStart = Date.now();
    while (Date.now() - restoreStart < MAX_POLL_MS) {
      await sleep(POLL_INTERVAL_MS);
      const desc = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbInstanceId }));
      const inst = desc.DBInstances?.[0];
      if (!inst) continue;
      if (inst.DBInstanceStatus === 'available') {
        return ok({
          dbInstanceId,
          status: 'available',
          endpoint: inst.Endpoint?.Address || null,
          port: inst.Endpoint?.Port || 5432,
          estimatedReadyInSeconds: 0,
          sourceRegion: srcRegion,
          copyPerformed: isCrossRegion,
        });
      }
      if (inst.DBInstanceStatus === 'failed' || inst.DBInstanceStatus === 'incompatible-restore') {
        return error(500, 'rds_restore_failed', `RDS instance entered status "${inst.DBInstanceStatus}"`);
      }
    }
    return ok({ dbInstanceId, status: 'creating', endpoint: null, port: 5432, estimatedReadyInSeconds: 60, polling_timeout: true });
  } catch (e) {
    return error(500, 'aws_call_failed', e.message);
  }
};
