const { ok, error, parseBody } = require('../shared/response');
const { checkBearer } = require('../shared/auth');
const { mockSnapshotConfig } = require('../shared/mock-data');
const { clientForStaging } = require('../shared/aws');

const MOCK_MODE = process.env.MOCK_MODE === 'true';
const STAGING_DB_ID = process.env.STAGING_DB_ID || 'aplazo-staging-clean';
const STAGING_DB_NAME_PATTERNS = (process.env.STAGING_DB_NAME_PATTERNS
  || 'aplazo-staging-clean,checkout-engine-stg,merchant-api-stg').split(',').map((s) => s.trim()).filter(Boolean);
const ECR_REPO_PREFIX = process.env.ECR_REPO_PREFIX || 'aplazo/stg-';
const CORE_SERVICES = (process.env.CORE_SERVICES || 'checkout-api,merchant-api,payment-engine')
  .split(',').map((s) => s.trim()).filter(Boolean);
const POC_ACCOUNT_ID = process.env.POC_ACCOUNT_ID;

/**
 * Tool 1 — resolve_snapshot_config.
 *
 * Source of truth: github.com/aplazo/node.pulumi-infrastructure
 *   - Region: us-west-1, account 159200192518
 *   - Snapshots live there; we discover the latest "available" one.
 *   - ECR repos follow `aplazo/{env}-{service}` naming.
 *
 * Auto-discovery strategy:
 *   1. STS AssumeRole → main account (us-west-1)
 *   2. DescribeDBSnapshots, pick the most recent "available" matching our DB patterns
 *   3. Share the snapshot with the POC account so we can copy it later
 *   4. DescribeRepositories matching ECR_REPO_PREFIX, then DescribeImages
 *
 * On any discovery failure we fall back to env-var defaults.
 */
exports.handler = async (event) => {
  const auth = checkBearer(event);
  if (!auth.ok) return error(401, 'unauthorized', auth.reason);

  const { merchant_id } = parseBody(event);
  if (!merchant_id) return error(400, 'invalid_input', 'merchant_id is required');

  if (MOCK_MODE) return ok(mockSnapshotConfig());

  try {
    const { RDSClient, DescribeDBSnapshotsCommand, ModifyDBSnapshotAttributeCommand } = require('@aws-sdk/client-rds');
    const { ECRClient, DescribeRepositoriesCommand, DescribeImagesCommand } = require('@aws-sdk/client-ecr');

    const rds = await clientForStaging(RDSClient);
    const ecr = await clientForStaging(ECRClient);

    let chosen = null;
    for (const pattern of STAGING_DB_NAME_PATTERNS) {
      try {
        const out = await rds.send(new DescribeDBSnapshotsCommand({
          DBInstanceIdentifier: pattern,
          SnapshotType: 'manual',
        }));
        const available = (out.DBSnapshots || [])
          .filter((s) => s.Status === 'available')
          .sort((a, b) => new Date(b.SnapshotCreateTime) - new Date(a.SnapshotCreateTime));
        if (available.length) { chosen = available[0]; break; }
      } catch (_) { /* try next pattern */ }
    }
    if (!chosen) {
      return error(404, 'no_snapshot_available',
        `No available manual snapshot for any of: ${STAGING_DB_NAME_PATTERNS.join(', ')}`);
    }

    if (POC_ACCOUNT_ID) {
      try {
        await rds.send(new ModifyDBSnapshotAttributeCommand({
          DBSnapshotIdentifier: chosen.DBSnapshotIdentifier,
          AttributeName: 'restore',
          ValuesToAdd: [POC_ACCOUNT_ID],
        }));
      } catch (e) {
        console.warn(`Could not share snapshot with POC account: ${e.message}`);
      }
    }

    let repos = [];
    try {
      const r = await ecr.send(new DescribeRepositoriesCommand({}));
      repos = (r.repositories || []).filter((rp) => rp.repositoryName.startsWith(ECR_REPO_PREFIX));
    } catch (e) {
      console.warn(`ECR DescribeRepositories failed: ${e.message}`);
    }

    const coreImages = [];
    for (const service of CORE_SERVICES) {
      const repo = repos.find((rp) => rp.repositoryName.endsWith(service))
                || repos.find((rp) => rp.repositoryName.includes(service));
      if (!repo) {
        const accountId = chosen.DBSnapshotArn.split(':')[4];
        const region = process.env.STAGING_REGION || 'us-west-1';
        coreImages.push({ service, imageUri: `${accountId}.dkr.ecr.${region}.amazonaws.com/${ECR_REPO_PREFIX}${service}:latest` });
        continue;
      }
      try {
        const imgs = await ecr.send(new DescribeImagesCommand({
          repositoryName: repo.repositoryName,
          maxResults: 1,
          filter: { tagStatus: 'TAGGED' },
        }));
        const tag = imgs.imageDetails?.[0]?.imageTags?.[0] || 'latest';
        coreImages.push({ service, imageUri: `${repo.repositoryUri}:${tag}` });
      } catch (_) {
        coreImages.push({ service, imageUri: `${repo.repositoryUri}:latest` });
      }
    }

    return ok({
      snapshotArn: chosen.DBSnapshotArn,
      snapshotId: chosen.DBSnapshotIdentifier,
      sourceRegion: process.env.STAGING_REGION || 'us-west-1',
      sourceDbInstance: chosen.DBInstanceIdentifier,
      sharedWithPoc: !!POC_ACCOUNT_ID,
      coreImages,
      estimatedRestoreMinutes: 13, // copy ~5 + restore ~8
    });
  } catch (e) {
    return error(500, 'aws_call_failed', e.message);
  }
};
