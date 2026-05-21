const { ok, error, parseBody } = require('../shared/response');
const { checkBearer } = require('../shared/auth');
const { mockRestoreRds } = require('../shared/mock-data');
const { mandatoryTags } = require('../shared/tags');

const MOCK_MODE = process.env.MOCK_MODE === 'true';
const REGION = process.env.AWS_REGION || 'us-east-1';
const DB_INSTANCE_CLASS = process.env.DB_INSTANCE_CLASS || 'db.t3.micro';
const GOLDEN_SNAPSHOT = process.env.RDS_GOLDEN_SNAPSHOT || 'sandboxagent-golden-v1';
const SUBNET_GROUP = process.env.RDS_SUBNET_GROUP || 'sandboxagent-subnet-group';
const RDS_SG_ID = process.env.RDS_SG_ID || '';
const POLL_INTERVAL_MS = 5000;
const FIRE_AND_POLL_BUDGET_MS = 20_000;

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Tool 2 — restore_rds_snapshot (REAL, hackathon variant)
 *
 * Restores from the SandboxAgent golden snapshot (our own seed data, since
 * we don't have us-west-1 access to staging snapshots). When DevOps copies
 * the real staging snapshot to us-east-1, swap RDS_GOLDEN_SNAPSHOT env var
 * and the architecture is identical.
 *
 * Pattern: fire-and-poll-short
 *   - Issue RestoreDBInstanceFromDBSnapshot (returns immediately)
 *   - Poll for ~20s for status changes (API GW hard limit is 30s)
 *   - Return whatever we have — agent proceeds even if status=creating
 *   - The actual RDS becomes "available" 5-10 min later in the background
 */
exports.handler = async (event) => {
  const auth = checkBearer(event);
  if (!auth.ok) return error(401, 'unauthorized', auth.reason);

  const { sandbox_id, requester, merchant_ref, integration_type } = parseBody(event);
  if (!sandbox_id) return error(400, 'invalid_input', 'sandbox_id is required');

  if (MOCK_MODE) {
    await sleep(800);
    return ok(mockRestoreRds(sandbox_id));
  }

  try {
    const {
      RDSClient,
      RestoreDBInstanceFromDBSnapshotCommand,
      DescribeDBInstancesCommand,
    } = require('@aws-sdk/client-rds');
    const rds = new RDSClient({ region: REGION });
    const dbInstanceId = `sandbox-${sandbox_id}`;
    const tags = mandatoryTags({ requester, sandboxId: sandbox_id, merchantRef: merchant_ref, integrationType: integration_type });

    let alreadyExists = false;
    try {
      const existing = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbInstanceId }));
      if (existing.DBInstances?.length) alreadyExists = true;
    } catch (e) {
      if (!/DBInstanceNotFound/.test(String(e?.name) + String(e?.message))) throw e;
    }

    if (!alreadyExists) {
      const restoreArgs = {
        DBInstanceIdentifier: dbInstanceId,
        DBSnapshotIdentifier: GOLDEN_SNAPSHOT,
        DBInstanceClass: DB_INSTANCE_CLASS,
        DBSubnetGroupName: SUBNET_GROUP,
        VpcSecurityGroupIds: RDS_SG_ID ? [RDS_SG_ID] : undefined,
        MultiAZ: false,
        PubliclyAccessible: false,
        AutoMinorVersionUpgrade: true,
        DeletionProtection: false,
        Tags: tags,
      };
      await rds.send(new RestoreDBInstanceFromDBSnapshotCommand(restoreArgs));
    }

    const start = Date.now();
    let status = 'creating';
    let endpoint = null;
    let port = 5432;
    while (Date.now() - start < FIRE_AND_POLL_BUDGET_MS) {
      await sleep(POLL_INTERVAL_MS);
      try {
        const desc = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbInstanceId }));
        const inst = desc.DBInstances?.[0];
        if (!inst) continue;
        status = inst.DBInstanceStatus || status;
        endpoint = inst.Endpoint?.Address || null;
        port = inst.Endpoint?.Port || port;
        if (status === 'available') break;
        if (status === 'failed' || status === 'incompatible-restore') {
          return error(500, 'rds_restore_failed', `RDS entered status "${status}"`);
        }
      } catch (_) { /* transient, keep polling */ }
    }

    return ok({
      dbInstanceId,
      status,
      endpoint,
      port,
      sourceSnapshot: GOLDEN_SNAPSHOT,
      alreadyExisted: alreadyExists,
      estimatedReadyInSeconds: status === 'available' ? 0 : 300,
    });
  } catch (e) {
    console.error('restore_rds_snapshot failed', e);
    return error(500, 'aws_call_failed', `${e.name || 'Error'}: ${e.message}`);
  }
};
