/**
 * Dashboard "qualified" GMB pool: paying+active ∩ keyword cache count in [minKw, maxKw].
 * Default: min 1, no upper cap (set DASHBOARD_QUALIFIED_KEYWORDS_MAX to cap, e.g. 6).
 * "Keywords tracked" = latest scan rows with rank + screenshot (see countLatestScanRankScreenshotKeywords).
 */

export function getDashboardKeywordBand() {
  const lo = Number(process.env.DASHBOARD_QUALIFIED_KEYWORDS_MIN ?? 1);
  const minKw = Number.isFinite(lo) ? Math.max(0, Math.floor(lo)) : 1;
  const hiRaw = process.env.DASHBOARD_QUALIFIED_KEYWORDS_MAX;
  let maxKw = null;
  if (hiRaw !== undefined && String(hiRaw).trim() !== '') {
    const h = Number(hiRaw);
    if (Number.isFinite(h)) maxKw = Math.max(minKw, Math.floor(h));
  }
  return { minKw, maxKw };
}

/** Active CRM id is bare UUID; history files often use `loc:<uuid>`. */
export function bareLocationIdFromBusinessId(businessId) {
  const s = String(businessId || '').trim();
  if (!s) return '';
  return s.startsWith('loc:') ? s.slice(4).trim() : s;
}

/**
 * @param {Set<string>|Iterable<string>} activeIdSet bare location UUIDs
 * @param {object|null} kwCache keyword cache doc (from services-keywords-derived items)
 * @returns {Set<string>} bare ids eligible for dashboard "Total GMB" pool
 */
export function qualifiedDashboardLocationIds(activeIdSet, kwCache) {
  const { minKw, maxKw } = getDashboardKeywordBand();
  const items = Array.isArray(kwCache?.items) ? kwCache.items : [];
  const active = activeIdSet instanceof Set ? activeIdSet : new Set(activeIdSet);
  const out = new Set();
  for (const it of items) {
    const crmId = String(it?.clientId || '').trim();
    const locId = String(it?.locationId || '').trim();
    const id = (crmId && active.has(crmId)) ? crmId : locId && active.has(locId) ? locId : '';
    if (!id) continue;
    const n = Number(it?.keywordsCount ?? 0);
    if (!Number.isFinite(n)) continue;
    if (n < minKw) continue;
    if (maxKw != null && n > maxKw) continue;
    out.add(id);
  }
  return out;
}

/**
 * Keywords that count toward "Keywords tracked": latest scan rows with numeric rank and a saved screenshot URL.
 */
export function countLatestScanRankScreenshotKeywords(historyDetail) {
  const latest =
    historyDetail?.latest_scan ||
    (Array.isArray(historyDetail?.scans) && historyDetail.scans.length ? historyDetail.scans[0] : null);
  const rows = Array.isArray(latest?.map_ranks) ? latest.map_ranks : [];
  let n = 0;
  for (const row of rows) {
    const rank = row?.rank;
    const hasRank = rank != null && Number.isFinite(Number(rank));
    const shot = String(row?.screenshot_url || row?.screenshotUrl || '').trim();
    if (hasRank && shot) n += 1;
  }
  return n;
}
