function mandatoryTags({ requester, sandboxId, merchantRef, integrationType }) {
  const owner = requester || process.env.DEFAULT_OWNER || 'francisco.lanuza@aplazo.mx';
  const expires = process.env.RESOURCE_EXPIRES || '2026-05-30';
  const squad = process.env.SQUAD || 'developer-experience';
  const tags = [
    { Key: 'project',     Value: 'sandboxagent' },
    { Key: 'team',        Value: 'sandboxagent' },
    { Key: 'squad',       Value: squad },
    { Key: 'owner',       Value: owner },
    { Key: 'expires',     Value: expires },
    { Key: 'environment', Value: 'hackathon26' },
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
