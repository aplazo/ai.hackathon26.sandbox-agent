/**
 * A snapshot ARN/identifier that contains "cluster-snapshot" is an Aurora
 * cluster snapshot; otherwise it's a regular RDS DB snapshot. Single source
 * of truth — previously duplicated in resolve_snapshot_config and
 * restore_rds_snapshot.
 */
const isAuroraClusterSnapshot = (id) => /cluster-snapshot/.test(String(id || ''));

module.exports = { isAuroraClusterSnapshot };
