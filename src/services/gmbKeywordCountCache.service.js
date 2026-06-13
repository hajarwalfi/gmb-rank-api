/**
 * Legacy API compatibility: exposes the same helpers/routes as the old `gmb_keyword_counts.json`
 * pipeline, but data now comes exclusively from **`services-keywords.json`** (paying CRM + GBP + keywords).
 *
 * Former nightly align cron (default **21:00 UTC**) → `initServicesKeywordsCron` in servicesKeywordsSnapshot.service.js
 */
import { readServicesKeywordsPayload, runServicesKeywordsRebuildJob } from './servicesKeywordsSnapshot.service.js';
import { readActiveGmbJson } from './supabaseGmb.service.js';
import { qualifiedDashboardLocationIds } from './dashboardMetricsLens.js';

function servicesRowsToCacheDoc(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const summary = payload?.summary && typeof payload.summary === 'object' ? payload.summary : {};
  const withK = typeof summary.withKeywords === 'number' ? summary.withKeywords : rows.filter((r) => Number(r?.keywordsCount || 0) > 0).length;
  const zeroK =
    typeof summary.withoutKeywords === 'number'
      ? summary.withoutKeywords
      : rows.filter((r) => Number(r?.keywordsCount || 0) <= 0).length;

  const items = rows.map((r) => ({
    accountId: String(r.accountId || ''),
    /** GBP short location id (automation/API). */
    locationId: String(r.locationIdShort || r.locationId || '').trim(),
    locationIdShort: String(r.locationIdShort || r.locationId || '').trim(),
    clientId: String(r.clientId || '').trim(),
    title: String(r.gmbName || r.business_name || '').trim() || 'Untitled',
    keywordsCount: Number(r.keywordsCount || 0),
    keywords: Array.isArray(r.keywords) ? r.keywords : [],
    keywordGenerationReason: r.keywordGenerationReason || null,
  }));

  return {
    ok: true,
    updatedAt: payload?.generatedAt || null,
    source: 'services_keywords',
    region: payload?.region ?? null,
    totalLocations: rows.length,
    rebuiltLocations: rows.length,
    items,
    keyword_generation_summary: {
      with_keywords_count: withK,
      zero_keywords_count: zeroK,
    },
    keyword_generation_pending: items
      .filter((item) => Number(item?.keywordsCount || 0) <= 0)
      .map((item) => ({
        locationId: String(item?.locationId || ''),
        title: String(item?.title || ''),
        reason:
          String(item?.keywordGenerationReason || '').trim() ||
          'No keywords row in paying+GBP services-keywords snapshot for this listing.',
      })),
    _snapshotSummary: summary,
  };
}

export async function readKeywordCountCache() {
  const payload = await readServicesKeywordsPayload();
  if (!Array.isArray(payload.rows) || !payload.rows.length) return null;
  return servicesRowsToCacheDoc(payload);
}

export async function readKeywordCountSummary() {
  const payload = await readServicesKeywordsPayload();
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : {};
  let keywordsTotalSum = typeof summary.keywordsTotalSum === 'number' ? summary.keywordsTotalSum : 0;
  if (!keywordsTotalSum) {
    for (const row of rows) keywordsTotalSum += Number(row?.keywordsCount || 0);
  }

  let qualified_gmb_count =
    typeof summary.withKeywords === 'number'
      ? summary.withKeywords
      : rows.filter((r) => Number(r?.keywordsCount || 0) > 0).length;
  try {
    const active = await readActiveGmbJson();
    const activeIds = new Set(
      (Array.isArray(active?.count) ? active.count : [])
        .map((c) => String(c?.id || '').trim())
        .filter(Boolean),
    );
    const doc = servicesRowsToCacheDoc(payload);
    qualified_gmb_count = qualifiedDashboardLocationIds(activeIds, doc).size;
  } catch {
    /* fallback: summary.withKeywords / row counts */
  }

  return {
    ok: true,
    updatedAt: payload.generatedAt || null,
    totalLocations: typeof summary.totalEligible === 'number' ? summary.totalEligible : rows.length,
    with_keywords_count:
      typeof summary.withKeywords === 'number'
        ? summary.withKeywords
        : rows.filter((r) => Number(r?.keywordsCount || 0) > 0).length,
    zero_keywords_count:
      typeof summary.withoutKeywords === 'number'
        ? summary.withoutKeywords
        : rows.filter((r) => Number(r?.keywordsCount || 0) <= 0).length,
    keywordsTotalSum,
    qualified_gmb_count,
  };
}

export function keywordsCountMapFromCache(kwCache) {
  const m = new Map();
  for (const it of Array.isArray(kwCache?.items) ? kwCache.items : []) {
    const n = Number(it?.keywordsCount || 0);
    const sid = String(it?.locationId || '').trim();
    const cid = String(it?.clientId || '').trim();
    if (sid) m.set(sid, n);
    if (cid) m.set(cid, n);
  }
  return m;
}

/** Flat UI rows — match by GBP short id OR CRM client id (`count[].id`). */
export function filterFlatLocationsByKeywordCache(locations, kwCache, minKw = 1) {
  const m = keywordsCountMapFromCache(kwCache);
  return locations.filter((loc) => {
    const lid = String(loc?.locationId || loc?.id || '').trim();
    const n = m.has(lid) ? m.get(lid) : Number(loc?.keywordsCount ?? 0);
    return Number.isFinite(n) && n >= minKw;
  });
}

export async function filterLocationTargetsMinKeywords(targets, minKw = 1, kwCache = null) {
  const cache = kwCache || (await readKeywordCountCache());
  const m = keywordsCountMapFromCache(cache);
  return targets.filter((t) => {
    const lid = String(t?.locationId || '').trim();
    const cid = String(t?.clientId || '').trim();
    const n = m.has(lid) ? m.get(lid) : cid && m.has(cid) ? m.get(cid) : null;
    return n != null && Number.isFinite(n) && n >= minKw;
  });
}

/** Paying+GBP-linked rows from `services-keywords.json` with enough keywords. */
export async function buildSupabaseTargetsWithMinKeywords(minKw = 1) {
  const payload = await readServicesKeywordsPayload();
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  return rows
    .filter((r) => Number(r.keywordsCount || 0) >= minKw)
    .map((r) => ({
      accountId: String(r.accountId || ''),
      locationId: String(r.locationIdShort || r.locationId || '').trim(),
      title: String(r.gmbName || r.business_name || '').trim(),
      clientId: String(r.clientId || '').trim(),
    }))
    .filter((t) => t.accountId && t.locationId);
}

/** Rebuild paying GMB pool + keywords — writes `services-keywords.json` (same as POST /api/services-keywords/rebuild). */
export async function rebuildKeywordCountCache(opts = {}) {
  void opts;
  await runServicesKeywordsRebuildJob();
  return (await readKeywordCountCache()) || {
    ok: true,
    updatedAt: null,
    totalLocations: 0,
    items: [],
    keyword_generation_summary: { with_keywords_count: 0, zero_keywords_count: 0 },
  };
}

/** @deprecated Use `rebuildKeywordCountCache` / services-keywords rebuild — kept for script compatibility. */
export async function alignKeywordCountsToActiveGmb() {
  return rebuildKeywordCountCache();
}

/** @deprecated Nightly job moved to `initServicesKeywordsCron` (same default UTC as old align). */
export function initKeywordCountsAlignCron() {
  console.log(
    '[KeywordCountCache] initKeywordCountsAlignCron is deprecated — use initServicesKeywordsCron (services-keywords.json).',
  );
}
