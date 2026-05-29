// The 6 mandatory tag values come from infra/tags.env (the single source of
// truth), which deploy-direct.sh injects into every tagging Lambda's env. The
// literal fallbacks below must match tags.env and exist only for local dev.
function mandatoryTags({ requester, sandboxId, merchantRef, integrationType }) {
  const owner = requester || process.env.DEFAULT_OWNER || 'francisco.lanuza@aplazo.mx';
  const expires = process.env.RESOURCE_EXPIRES || '2026-05-30';
  const squad = process.env.SQUAD || 'developer-experience';
  const project = process.env.PROJECT_TAG || 'sandboxagent';
  const team = process.env.TEAM_TAG || 'sandboxagent';
  const environment = process.env.ENVIRONMENT_TAG || 'hackathon26';
  const tags = [
    { Key: 'project',     Value: project },
    { Key: 'team',        Value: team },
    { Key: 'squad',       Value: squad },
    { Key: 'owner',       Value: owner },
    { Key: 'expires',     Value: expires },
    { Key: 'environment', Value: environment },
  ];
  if (sandboxId)        tags.push({ Key: 'sandbox-id', Value: sandboxId });
  if (merchantRef)      tags.push({ Key: 'merchant',   Value: String(merchantRef) });
  if (integrationType)  tags.push({ Key: 'integration-type', Value: integrationType });
  return tags;
}

// Shape adapters for the two casing conventions the AWS SDKs expect.
// ELBv2 / RDS use PascalCase {Key, Value}; ECS uses lowercase {key, value}.
const elbTags = (tags) => tags.map((t) => ({ Key: t.Key, Value: t.Value }));
const ecsTags = (tags) => tags.map((t) => ({ key: t.Key, value: t.Value }));

module.exports = { mandatoryTags, elbTags, ecsTags };
