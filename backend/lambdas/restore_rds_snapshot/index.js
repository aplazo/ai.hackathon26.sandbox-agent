const { ok, error, parseBody } = require('../shared/response');
const { checkBearer } = require('../shared/auth');
const { mockRestoreRds } = require('../shared/mock-data');
const { mandatoryTags } = require('../shared/tags');

const MOCK_MODE = process.env.MOCK_MODE === 'true';
const REGION = process.env.AWS_REGION || 'us-east-1';
const DB_INSTANCE_CLASS = process.env.DB_INSTANCE_CLASS || 'db.t3.micro';
const DB_AURORA_INSTANCE_CLASS = process.env.DB_AURORA_INSTANCE_CLASS || 'db.t3.medium';
const GOLDEN_SNAPSHOT = process.env.RDS_GOLDEN_SNAPSHOT || 'sandboxagent-golden-v1';
const SUBNET_GROUP = process.env.RDS_SUBNET_GROUP || 'sandboxagent-subnet-group';
const RDS_SG_ID = process.env.RDS_SG_ID || '';
const POLL_INTERVAL_MS = 5000;
const FIRE_AND_POLL_BUDGET_MS = 20_000;

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isAuroraClusterSnapshot(snapshotId) {
  return /cluster-snapshot/.test(String(snapshotId || ''));
}

/**
 * Tool 2 — restore_rds_snapshot (REAL, hackathon variant)
 *
 * Auto-detects snapshot type from the ARN:
 *   - "...:cluster-snapshot:..."  →  Aurora cluster path
 *                                    (RestoreDBClusterFromSnapshot + CreateDBInstance)
 *   - "...:snapshot:..."          →  Regular RDS path
 *                                    (RestoreDBInstanceFromDBSnapshot)
 *
 * Today we run with the regular RDS golden snapshot sandboxagent-golden-v1.
 * When DevOps grants KMS access for the real staging Aurora snapshot
 * apzdbstg-hackathon-east1, point RDS_GOLDEN_SNAPSHOT at its ARN and the
 * Lambda auto-switches paths — zero code change needed.
 *
 * Pattern in both paths: fire-and-poll-short. API GW hard ceiling is 30s
 * so we issue the restore + poll for ~20s + return whatever state we have.
 * Status="creating" is acceptable — agent proceeds and the actual RDS
 * becomes "available" 5-10 min later in the background.
 */
exports.handler = async (event) => {
  const auth = checkBearer(event);
  if (!auth.ok) return error(401, 'unauthorized', auth.reason);

  const { sandbox_id, snapshot_arn, requester, merchant_ref, integration_type } = parseBody(event);
  if (!sandbox_id) return error(400, 'invalid_input', 'sandbox_id is required');

  if (MOCK_MODE) {
    await sleep(800);
    return ok(mockRestoreRds(sandbox_id));
  }

  const snapshotId = snapshot_arn || GOLDEN_SNAPSHOT;
  const isAurora = isAuroraClusterSnapshot(snapshotId);
  const tags = mandatoryTags({ requester, sandboxId: sandbox_id, merchantRef: merchant_ref, integrationType: integration_type });

  try {
    const rdsLib = require('@aws-sdk/client-rds');
    const rds = new rdsLib.RDSClient({ region: REGION });

    if (isAurora) {
      return await restoreAuroraCluster({ rds, rdsLib, sandbox_id, snapshotId, tags });
    }
    return await restoreRegularInstance({ rds, rdsLib, sandbox_id, snapshotId, tags });
  } catch (e) {
    console.error('restore_rds_snapshot failed', e);
    return error(500, 'aws_call_failed', `${e.name || 'Error'}: ${e.message}`);
  }
};

// ============================================================================
//   Regular RDS DB instance path  (sandboxagent-golden-v1)
// ============================================================================
async function restoreRegularInstance({ rds, rdsLib, sandbox_id, snapshotId, tags }) {
  const dbInstanceId = `sandbox-${sandbox_id}`;

  let alreadyExists = false;
  try {
    const existing = await rds.send(new rdsLib.DescribeDBInstancesCommand({ DBInstanceIdentifier: dbInstanceId }));
    if (existing.DBInstances?.length) alreadyExists = true;
  } catch (e) {
    if (!/DBInstanceNotFound/.test(String(e?.name) + String(e?.message))) throw e;
  }

  if (!alreadyExists) {
    await rds.send(new rdsLib.RestoreDBInstanceFromDBSnapshotCommand({
      DBInstanceIdentifier: dbInstanceId,
      DBSnapshotIdentifier: snapshotId,
      DBInstanceClass: DB_INSTANCE_CLASS,
      DBSubnetGroupName: SUBNET_GROUP,
      VpcSecurityGroupIds: RDS_SG_ID ? [RDS_SG_ID] : undefined,
      MultiAZ: false,
      PubliclyAccessible: false,
      AutoMinorVersionUpgrade: true,
      DeletionProtection: false,
      Tags: tags,
    }));
  }

  const start = Date.now();
  let status = 'creating';
  let endpoint = null;
  let port = 5432;
  while (Date.now() - start < FIRE_AND_POLL_BUDGET_MS) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const desc = await rds.send(new rdsLib.DescribeDBInstancesCommand({ DBInstanceIdentifier: dbInstanceId }));
      const inst = desc.DBInstances?.[0];
      if (!inst) continue;
      status = inst.DBInstanceStatus || status;
      endpoint = inst.Endpoint?.Address || null;
      port = inst.Endpoint?.Port || port;
      if (status === 'available') break;
      if (status === 'failed' || status === 'incompatible-restore') {
        return error(500, 'rds_restore_failed', `RDS entered status "${status}"`);
      }
    } catch (_) { /* transient */ }
  }

  return ok({
    isAurora: false,
    dbInstanceId,
    status,
    endpoint,
    port,
    sourceSnapshot: snapshotId,
    alreadyExisted: alreadyExists,
    estimatedReadyInSeconds: status === 'available' ? 0 : 300,
  });
}

// ============================================================================
//   Aurora PostgreSQL cluster path  (apzdbstg-hackathon-east1 once KMS unblocks)
// ============================================================================
async function restoreAuroraCluster({ rds, rdsLib, sandbox_id, snapshotId, tags }) {
  const clusterId = `sandbox-${sandbox_id}-cluster`;
  const instanceId = `sandbox-${sandbox_id}-i1`;

  // ----- 1. Create cluster from snapshot (idempotent) -----
  let clusterExists = false;
  try {
    const out = await rds.send(new rdsLib.DescribeDBClustersCommand({ DBClusterIdentifier: clusterId }));
    if (out.DBClusters?.length) clusterExists = true;
  } catch (e) {
    if (!/DBClusterNotFound/.test(String(e?.name) + String(e?.message))) throw e;
  }
  if (!clusterExists) {
    await rds.send(new rdsLib.RestoreDBClusterFromSnapshotCommand({
      DBClusterIdentifier: clusterId,
      SnapshotIdentifier: snapshotId,
      Engine: 'aurora-postgresql',
      DBSubnetGroupName: SUBNET_GROUP,
      VpcSecurityGroupIds: RDS_SG_ID ? [RDS_SG_ID] : undefined,
      DeletionProtection: false,
      Tags: tags,
    }));
  }

  // ----- 2. Create instance inside cluster (idempotent) -----
  let instanceExists = false;
  try {
    const out = await rds.send(new rdsLib.DescribeDBInstancesCommand({ DBInstanceIdentifier: instanceId }));
    if (out.DBInstances?.length) instanceExists = true;
  } catch (e) {
    if (!/DBInstanceNotFound/.test(String(e?.name) + String(e?.message))) throw e;
  }
  if (!instanceExists) {
    try {
      await rds.send(new rdsLib.CreateDBInstanceCommand({
        DBInstanceIdentifier: instanceId,
        DBClusterIdentifier: clusterId,
        Engine: 'aurora-postgresql',
        DBInstanceClass: DB_AURORA_INSTANCE_CLASS,
        PubliclyAccessible: false,
        AutoMinorVersionUpgrade: true,
        Tags: tags,
      }));
    } catch (e) {
      // The cluster might not be ready for instance creation yet. Tolerate and
      // surface a status so the agent can retry / proceed.
      if (!/InvalidDBCluster|DBClusterNotFound/.test(String(e?.name) + String(e?.message))) throw e;
    }
  }

  // ----- 3. Fire-and-poll-short on cluster status (endpoint becomes available
  //         even while instance is still provisioning) -----
  const start = Date.now();
  let status = 'creating';
  let endpoint = null;
  let port = 5432;
  while (Date.now() - start < FIRE_AND_POLL_BUDGET_MS) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const desc = await rds.send(new rdsLib.DescribeDBClustersCommand({ DBClusterIdentifier: clusterId }));
      const cluster = desc.DBClusters?.[0];
      if (cluster) {
        status = cluster.Status || status;
        endpoint = cluster.Endpoint || null;
        port = cluster.Port || port;
        if (status === 'available' && endpoint) break;
        if (status === 'failed') return error(500, 'aurora_restore_failed', 'Aurora cluster entered status "failed"');
      }
    } catch (_) { /* transient */ }
  }

  return ok({
    isAurora: true,
    dbInstanceId: instanceId,
    dbClusterId: clusterId,
    status,
    endpoint,
    port,
    sourceSnapshot: snapshotId,
    alreadyExisted: clusterExists,
    estimatedReadyInSeconds: status === 'available' ? 0 : 420,
  });
}
