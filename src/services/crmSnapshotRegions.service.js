/**
 * Which Formflow CRM regions are merged into ranking-server JSON snapshots
 * (`business-connect.json`, `auto-connected-gmb.json`, and optionally others).
 *
 * Precedence:
 * 1) `CRM_SNAPSHOT_REGIONS` or `SERVICES_KEYWORDS_CRM_REGIONS` — comma / semicolon / whitespace separated
 * 2) Legacy single-region: `SERVICES_KEYWORDS_CRM_REGION` or `CRM_SNAPSHOT_REGION` (one code, e.g. `es`)
 * 3) Default: `es`, `us`, `br`
 *
 * Note: `AUTOCONNECT_CRM_REGION` / `BUSINESS_CONNECT_CRM_REGION` are **not** read here so
 * service-specific env vars cannot accidentally shrink the merged multi-region snapshots.
 */
export function parseCrmSnapshotRegions() {
  const combined = String(process.env.CRM_SNAPSHOT_REGIONS || process.env.SERVICES_KEYWORDS_CRM_REGIONS || '').trim();
  if (combined) {
    const parts = combined
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return [...new Set(parts)];
  }
  const single = String(process.env.SERVICES_KEYWORDS_CRM_REGION || process.env.CRM_SNAPSHOT_REGION || '')
    .trim()
    .toLowerCase();
  if (single) return [single];
  return ['es', 'us', 'br'];
}

export function crmSnapshotRegionsLabel(regions) {
  const list = Array.isArray(regions) ? regions : parseCrmSnapshotRegions();
  return list.join(',');
}
