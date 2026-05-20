/**
 * Cross-account / cross-region AWS client factory.
 *
 * SandboxAgent runs in the POC account (us-east-1). All source-of-truth lives
 * in the main aplazo account (159200192518) and region us-west-1:
 *   - RDS snapshots of staging
 *   - ECR repos for service images
 *   - ECS task definitions (the spec we mirror)
 *
 * To read from the main account, the POC Lambda role assumes
 * `STAGING_READER_ROLE_ARN` via STS. See infra/scripts/create-staging-reader-role.sh
 * for the role we expect to exist in the main account.
 */

let cachedCredentials = null;
let cachedExpiry = 0;

async function getStagingCredentials() {
  const roleArn = process.env.STAGING_READER_ROLE_ARN;
  if (!roleArn) return null;

  if (cachedCredentials && Date.now() < cachedExpiry - 60_000) {
    return cachedCredentials;
  }

  const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
  const sts = new STSClient({});
  const res = await sts.send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: `sandboxagent-${Date.now()}`,
    DurationSeconds: 3600,
  }));
  const c = res.Credentials;
  cachedCredentials = {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
  };
  cachedExpiry = c.Expiration.getTime();
  return cachedCredentials;
}

async function clientForStaging(ClientCtor) {
  const region = process.env.STAGING_REGION || 'us-west-1';
  const credentials = await getStagingCredentials();
  return new ClientCtor(credentials ? { region, credentials } : { region });
}

function clientForLocal(ClientCtor) {
  return new ClientCtor({});
}

module.exports = { getStagingCredentials, clientForStaging, clientForLocal };
