import { getHistory } from './historyManager.js';
import { calculateDelta } from './deltaCalculator.js';
import { makeGmbKey, readTracking } from './gmbTrackingHistory.service.js';
import { enrichTwoScansWithTracking, isValidMapRank } from './historyInventory.service.js';
import { readServicesKeywordsPayload } from './servicesKeywordsSnapshot.service.js';

function normKeyword(k) {
  return String(k || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Same merge as GET /api/history/:businessId — latest tracking snapshot into every scan’s map_ranks.
 */
export async function mergeTrackingKeywordsIntoHistory(businessId, history) {
  if (!history) return;
  try {
    const tracking = await readTracking(businessId);
    const snaps = Array.isArray(tracking?.snapshots) ? tracking.snapshots : [];
    const latest = snaps.length ? snaps[snaps.length - 1] : null;
    const items = Array.isArray(latest?.items) ? latest.items : [];
    const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const byKw = new Map(items.map((it) => [norm(it.keyword), it]));

    for (const scan of history.scans || []) {
      const ranks = Array.isArray(scan?.map_ranks) ? scan.map_ranks : [];
      scan.map_ranks = ranks.map((mr) => {
        const t = byKw.get(norm(mr.keyword));
        if (!t) return mr;
        return {
          ...mr,
          target_keyword: t.target_keyword ?? mr.target_keyword,
          source_month: t.source_month ?? mr.source_month,
          volume: mr.volume ?? t.volume,
          daily_traffic: mr.daily_traffic ?? t.daily_traffic,
          estimated_clicks: t.estimated_clicks ?? t.estimated_clicks,
          raw_traffic_data: t.raw_traffic_data ?? mr.raw_traffic_data,
        };
      });
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * Candidate history keys for a CRM row (location formats differ between CRM, frontend, and stored JSON).
 */
export function buildCandidateBusinessIds(row) {
  const locationId = row.locationId ?? row.gmbLocationId ?? '';
  const businessName = String(row.businessName || '').trim();
  const gmbListingName = String(row.gmbListingName || '').trim();
  const set = new Set();
  const add = (s) => {
    const v = String(s || '').trim();
    if (v && v !== 'name:unknown') set.add(v);
  };

  const names = [gmbListingName, businessName].filter(Boolean);
  for (const nm of names.length ? names : ['']) {
    add(makeGmbKey(locationId, nm));
    if (nm) add(makeGmbKey('', nm));
  }
  add(makeGmbKey(locationId, businessName));
  add(makeGmbKey(locationId, ''));

  let raw = String(locationId || '')
    .trim()
    .replace(/^loc:/i, '')
    .replace(/^locations\//i, '');
  if (/^\d+$/.test(raw)) {
    add(`loc:${raw}`);
    add(`loc:locations/${raw}`);
  }

  return [...set];
}

/** Latest + previous scan rows after tracking merge and delta (shared by CRM signals + modal keywords). */
async function prepareTwoScanEnriched(businessId, history) {
  if (!history?.scans?.length) {
    return { latest: null, previous: null, scanCount: 0 };
  }
  await mergeTrackingKeywordsIntoHistory(businessId, history);

  const scansDesc = [...history.scans].sort(
    (a, b) => new Date(b?.scanned_at || 0) - new Date(a?.scanned_at || 0),
  );
  const enrichedScans = calculateDelta(scansDesc).reverse();
  const latest = enrichedScans[0] || null;
  const previous = enrichedScans[1] || null;
  if (latest && previous) {
    await enrichTwoScansWithTracking(businessId, latest, previous);
  } else if (latest) {
    await enrichTwoScansWithTracking(businessId, latest, null);
  }
  return { latest, previous, scanCount: enrichedScans.length };
}

function rankSignalsFromLatestPrevious(latest, previous) {
  if (!latest) {
    return { hasData: false, hasRanked: false, hasImproved: false };
  }
  const prevByKeyword = new Map();
  if (Array.isArray(previous?.map_ranks)) {
    for (const r of previous.map_ranks) {
      prevByKeyword.set(normKeyword(r.keyword), r);
    }
  }

  let hasRanked = false;
  let hasImproved = false;
  for (const mr of latest.map_ranks || []) {
    const rankNum = mr.rank != null && Number.isFinite(Number(mr.rank)) ? Number(mr.rank) : null;
    if (isValidMapRank(rankNum)) hasRanked = true;

    const prevRow = prevByKeyword.get(normKeyword(mr.keyword));
    const prevRank =
      prevRow?.rank != null && Number.isFinite(Number(prevRow.rank)) ? Number(prevRow.rank) : null;

    if (prevRank != null && rankNum != null && isValidMapRank(prevRank) && isValidMapRank(rankNum)) {
      if (rankNum < prevRank) hasImproved = true;
    }
  }

  return { hasData: true, hasRanked, hasImproved };
}

async function resolveHistoryForSnapshotRow(row) {
  const cands = buildCandidateBusinessIds({
    locationId: row.locationIdShort || row.locationId,
    businessName: row.business_name,
    gmbListingName: row.gmbName,
  });
  for (const bid of cands) {
    const h = await getHistory(bid);
    if (h?.scans?.length) {
      return { resolved: bid, hist: JSON.parse(JSON.stringify(h)) };
    }
  }
  return { resolved: null, hist: null };
}

function buildKeywordRowsUnion(snapshotKeywords, latest, previous) {
  const snapshotNormSet = new Set(snapshotKeywords.map((k) => normKeyword(k)));
  const lastTwoScans = [latest, previous].filter(Boolean);
  const ordered = [];
  const seen = new Set();
  const pushKw = (displayKw) => {
    const n = normKeyword(displayKw);
    if (!n || seen.has(n)) return;
    seen.add(n);
    ordered.push(String(displayKw || '').trim());
  };

  for (const k of snapshotKeywords) {
    pushKw(k);
  }
  for (const scan of lastTwoScans) {
    for (const r of scan?.map_ranks || []) {
      pushKw(r.keyword);
    }
  }

  const latestByNorm = new Map();
  for (const r of latest?.map_ranks || []) {
    latestByNorm.set(normKeyword(r.keyword), r);
  }
  const prevByNorm = new Map();
  for (const r of previous?.map_ranks || []) {
    prevByNorm.set(normKeyword(r.keyword), r);
  }

  return ordered.map((displayKw) => {
    const n = normKeyword(displayKw);
    const lr = latestByNorm.get(n);
    const pr = prevByNorm.get(n);
    const latestRank =
      lr?.rank != null && Number.isFinite(Number(lr.rank)) ? Number(lr.rank) : null;
    const previousRank =
      pr?.rank != null && Number.isFinite(Number(pr.rank)) ? Number(pr.rank) : null;
    return {
      keyword: displayKw,
      fromServicesSnapshot: snapshotNormSet.has(n),
      latestRank,
      previousRank,
      latestImpression: overviewImpressionFromRankRow(lr),
      previousImpression: overviewImpressionFromRankRow(pr),
      latestScreenshot: lr ? pickRowScreenshot(lr, latest) : null,
      previousScreenshot: pr ? pickRowScreenshot(pr, previous) : null,
    };
  });
}

async function computeSignalsForResolvedHistory(businessId, history) {
  if (!history?.scans?.length) {
    return { hasData: false, hasRanked: false, hasImproved: false, scanCount: 0 };
  }
  const { latest, previous, scanCount } = await prepareTwoScanEnriched(businessId, history);
  const core = rankSignalsFromLatestPrevious(latest, previous);
  if (!core.hasData) {
    return { hasData: false, hasRanked: false, hasImproved: false, scanCount };
  }
  return { ...core, scanCount };
}

const CRM_SIGNALS_ROW_CONCURRENCY = Math.max(
  1,
  Math.min(12, Number(process.env.CRM_SIGNALS_CONCURRENCY || 6)),
);

async function crmSignalForSnapshotRow(row, rgn) {
  const cid = String(row.clientId || '').trim();
  const empty = {
    hasData: false,
    hasRanked: false,
    hasImproved: false,
    scanCount: 0,
    resolvedBusinessId: null,
  };
  if (!cid) return { clientId: cid, signal: empty };

  const { resolved, hist } = await resolveHistoryForSnapshotRow(row);
  if (!resolved || !hist) {
    return { clientId: cid, signal: empty };
  }

  const { latest, previous, scanCount } = await prepareTwoScanEnriched(resolved, hist);
  const core = rankSignalsFromLatestPrevious(latest, previous);
  const snapshotKeywords = Array.isArray(row.keywords)
    ? row.keywords.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const keywords = buildKeywordRowsUnion(snapshotKeywords, latest, previous);
  const hasRanked = statsFromModalKeywordRows(keywords).hasAnyRankScreenshot;

  return {
    clientId: cid,
    signal: {
      hasData: core.hasData,
      hasImproved: core.hasImproved,
      hasRanked,
      scanCount,
      resolvedBusinessId: resolved,
    },
  };
}

/**
 * @param {Array<{ clientId: string, locationId?: string|null, businessName?: string|null, gmbListingName?: string|null }>} clients
 */
export async function batchCrmClientRankSignals(clients) {
  const byClientId = {};
  const list = Array.isArray(clients) ? clients : [];

  for (const row of list) {
    const clientId = String(row?.clientId || '').trim();
    if (!clientId) continue;

    const cands = buildCandidateBusinessIds({
      locationId: row.locationId,
      gmbLocationId: row.gmbLocationId,
      businessName: row.businessName,
      gmbListingName: row.gmbListingName,
    });

    let resolved = null;
    let hist = null;
    for (const bid of cands) {
      const h = await getHistory(bid);
      if (h?.scans?.length) {
        hist = h;
        resolved = bid;
        break;
      }
    }

    if (!hist) {
      byClientId[clientId] = {
        hasData: false,
        hasRanked: false,
        hasImproved: false,
        scanCount: 0,
        resolvedBusinessId: null,
      };
      continue;
    }

    const signals = await computeSignalsForResolvedHistory(resolved, JSON.parse(JSON.stringify(hist)));
    byClientId[clientId] = { ...signals, resolvedBusinessId: resolved };
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    byClientId,
  };
}

function overviewImpressionFromRankRow(mr) {
  const raw = mr?.raw_traffic_data;
  if (!raw) return null;
  const latest = Array.isArray(raw.daily_breakdown_desc) ? raw.daily_breakdown_desc[0] : null;
  if (latest != null && latest.overview != null) {
    const n = Number(latest.overview);
    return Number.isFinite(n) ? n : null;
  }
  const o = Number(raw.overview_clicks ?? raw.monthly_totals?.overview);
  return Number.isFinite(o) ? o : null;
}

function pickRowScreenshot(mr, scan) {
  const u = String(mr?.screenshot_url || mr?.screenshotUrl || '').trim();
  if (u) return u;
  return String(scan?.screenshot_url || '').trim() || null;
}

/**
 * CRM Paying-tab filters keyed by CRM `clientId`, using locations from `services-keywords.json`
 * + `data/history` (same IDs as nightly snapshot — fixes Client Hub rows missing `gmb_location_id`).
 * `hasRanked` = same rule as paying-keywords-ratio summary / modal: ≥1 combined keyword with valid
 * Maps rank (1–20) and screenshot on latest or previous scan (not “latest scan rank only”).
 */
/** Coalesce parallel region builds + short TTL so ratio + CRM routes share one compute. */
const regionCrmBuildInFlight = new Map();
const regionCrmResultCache = new Map();
const REGION_CRM_RESULT_TTL_MS = Math.max(
  15_000,
  Number(process.env.CRM_SIGNALS_CACHE_TTL_MS || 300_000),
);

async function buildCrmSignalsFromServicesKeywordsUncached(region) {
  const payload = await readServicesKeywordsPayload();
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const rgn = String(region || '').trim().toLowerCase();
  const byClientId = {};

  const candidates = rows.filter((r) => {
    const kwc = Array.isArray(r.keywords) ? r.keywords.length : 0;
    if (kwc < 1) return false;
    if (String(r.pipeline_stage || '').toLowerCase() !== 'paying') return false;
    if (rgn && String(r.region || '').trim().toLowerCase() !== rgn) return false;
    return !!String(r.clientId || '').trim();
  });

  for (let i = 0; i < candidates.length; i += CRM_SIGNALS_ROW_CONCURRENCY) {
    const chunk = candidates.slice(i, i + CRM_SIGNALS_ROW_CONCURRENCY);
    const parts = await Promise.all(chunk.map((row) => crmSignalForSnapshotRow(row, rgn)));
    for (const { clientId, signal } of parts) {
      if (clientId) byClientId[clientId] = signal;
    }
  }

  /** Region-scoped pool size (do not use merged `summary.withKeywords` for a single CRM region). */
  const summaryWithKeywords =
    candidates.length > 0 ? candidates.length : null;

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    snapshotRegion: payload.region || null,
    matchedSnapshotRows: candidates.length,
    summaryWithKeywords,
    byClientId,
  };
}

export async function buildCrmSignalsFromServicesKeywords(region, options = {}) {
  const key = String(region || '').trim().toLowerCase() || '__all__';
  const bypass = Boolean(options.bypassCache);
  if (!bypass) {
    const hit = regionCrmResultCache.get(key);
    if (hit && Date.now() - hit.at < REGION_CRM_RESULT_TTL_MS) {
      return hit.data;
    }
  }
  const existing = regionCrmBuildInFlight.get(key);
  if (existing) return existing;
  const promise = buildCrmSignalsFromServicesKeywordsUncached(region)
    .then((data) => {
      regionCrmResultCache.set(key, { at: Date.now(), data });
      return data;
    })
    .finally(() => {
      if (regionCrmBuildInFlight.get(key) === promise) {
        regionCrmBuildInFlight.delete(key);
      }
    });
  regionCrmBuildInFlight.set(key, promise);
  return promise;
}

/**
 * Combined keyword table: **union** of
 *   (1) `services-keywords.json` keywords for this client, and
 *   (2) distinct keywords from `map_ranks` on the **last two chronological scans** (newest + one before),
 *       when the business has **2+ stored scans**; if only **1 scan** exists, (2) is just that scan’s `map_ranks`.
 * Row order: snapshot order first, then newest-scan `map_ranks` order, then any from the previous scan not
 * already listed. Cell values still come from latest vs previous rows only — missing → null (UI —).
 */
export async function buildCombinedModalKeywordRows(clientId, region) {
  const cid = String(clientId || '').trim();
  const rgn = String(region || '').trim().toLowerCase();
  const payload = await readServicesKeywordsPayload();
  const row = payload.rows.find(
    (r) =>
      String(r.clientId || '').trim() === cid &&
      (!rgn || String(r.region || '').trim().toLowerCase() === rgn),
  );
  const snapshotKeywords = Array.isArray(row?.keywords) ? row.keywords.map((x) => String(x || '').trim()).filter(Boolean) : [];

  const { resolved, hist } = row ? await resolveHistoryForSnapshotRow(row) : { resolved: null, hist: null };
  const { latest, previous, scanCount } =
    resolved && hist ? await prepareTwoScanEnriched(resolved, hist) : { latest: null, previous: null, scanCount: 0 };
  const keywords = buildKeywordRowsUnion(snapshotKeywords, latest, previous);

  return {
    clientId: cid,
    resolvedBusinessId: resolved,
    businessName: row?.business_name || null,
    gmbName: row?.gmbName || null,
    scanCount,
    twoScans: Boolean(latest && previous),
    keywords,
    snapshotKeywordCount: snapshotKeywords.length,
  };
}

function screenshotPresent(u) {
  return Boolean(u && String(u).trim());
}

/**
 * Same rule as CRM modal: valid Maps pack rank (1–20) plus non-empty screenshot on latest **or** previous scan.
 */
export function keywordRowHasRankAndScreenshot(kwRow) {
  if (!kwRow) return false;
  const latestOk =
    isValidMapRank(kwRow.latestRank) && screenshotPresent(kwRow.latestScreenshot);
  const prevOk =
    isValidMapRank(kwRow.previousRank) && screenshotPresent(kwRow.previousScreenshot);
  return Boolean(latestOk || prevOk);
}

/**
 * Per-GMB stats over the combined keyword union (snapshot ∪ last two scans), same rows as the modal table.
 */
export function statsFromModalKeywordRows(keywords) {
  const list = Array.isArray(keywords) ? keywords : [];
  const combinedTotal = list.length;
  let withRankShot = 0;
  for (const k of list) {
    if (keywordRowHasRankAndScreenshot(k)) withRankShot += 1;
  }
  const rankPercentage =
    combinedTotal > 0 ? Math.round((withRankShot * 1000) / combinedTotal) / 10 : 0;
  return {
    combinedTotal,
    withRankScreenshotCount: withRankShot,
    rankPercentage,
    hasAnyRankScreenshot: withRankShot > 0,
  };
}

/**
 * % of given snapshot candidate rows (paying + keywords + region already filtered)
 * where ≥1 combined keyword has rank+screenshot in latest two scans.
 * @param {{ withKeywordsSummaryDenominator?: number }} [options] When set (e.g. `services-keywords.json` `summary.withKeywords`), used as % denominator instead of `candidates.length`.
 */
export async function payingKeywordsRatioSummaryForCandidateRows(candidates, rgn, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const d = Number(options.withKeywordsSummaryDenominator);
  const withKeywordsTotal =
    Number.isFinite(d) && d > 0 ? Math.floor(d) : list.length;
  let gmbWithAtLeastOne = 0;
  for (let i = 0; i < list.length; i += CRM_SIGNALS_ROW_CONCURRENCY) {
    const chunk = list.slice(i, i + CRM_SIGNALS_ROW_CONCURRENCY);
    const flags = await Promise.all(
      chunk.map(async (row) => {
        try {
          const { signal } = await crmSignalForSnapshotRow(row, rgn);
          return signal.hasRanked ? 1 : 0;
        } catch {
          return 0;
        }
      }),
    );
    gmbWithAtLeastOne += flags.reduce((a, b) => a + b, 0);
  }
  const keywordsRatioPercent =
    withKeywordsTotal > 0
      ? Math.round((gmbWithAtLeastOne * 1000) / withKeywordsTotal) / 10
      : 0;
  return {
    ok: true,
    region: String(rgn || '').trim().toLowerCase() || null,
    withKeywordsTotal,
    withRankScreenshotGmbCount: gmbWithAtLeastOne,
    keywordsRatioPercent,
  };
}

/**
 * % of paying snapshot locations (with keywords) where ≥1 combined keyword has rank+screenshot in latest two scans.
 */
export async function payingKeywordsRatioSummaryForRegion(region) {
  const rgn = String(region || '').trim().toLowerCase();
  const crm = await buildCrmSignalsFromServicesKeywords(region);
  const withKeywordsTotal =
    typeof crm.matchedSnapshotRows === 'number' && crm.matchedSnapshotRows > 0
      ? crm.matchedSnapshotRows
      : Object.keys(crm.byClientId || {}).length;
  let gmbWithAtLeastOne = 0;
  for (const signal of Object.values(crm.byClientId || {})) {
    if (signal?.hasRanked) gmbWithAtLeastOne += 1;
  }
  const keywordsRatioPercent =
    withKeywordsTotal > 0
      ? Math.round((gmbWithAtLeastOne * 1000) / withKeywordsTotal) / 10
      : 0;
  return {
    ok: true,
    region: rgn || null,
    withKeywordsTotal,
    withRankScreenshotGmbCount: gmbWithAtLeastOne,
    keywordsRatioPercent,
  };
}

const SUMMARY_CLIENT_IDS_MAX = 600;

/**
 * Same ratio as {@link payingKeywordsRatioSummaryForRegion}, scoped to snapshot rows whose clientId is in `clientIds`
 * (e.g. current CRM table page). Used for pagination-scoped Keywords ratio on the Paying tab.
 */
export async function payingKeywordsRatioSummaryForClientIds(region, clientIds) {
  const rgn = String(region || '').trim().toLowerCase();
  const idSet = new Set(
    [...new Set((clientIds || []).map((x) => String(x || '').trim()).filter(Boolean))].slice(
      0,
      SUMMARY_CLIENT_IDS_MAX,
    ),
  );
  if (idSet.size === 0) {
    return {
      ok: true,
      region: rgn || null,
      scope: 'page',
      withKeywordsTotal: 0,
      withRankScreenshotGmbCount: 0,
      keywordsRatioPercent: 0,
    };
  }
  const payload = await readServicesKeywordsPayload();
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const candidates = rows.filter((r) => {
    const cid = String(r.clientId || '').trim();
    if (!cid || !idSet.has(cid)) return false;
    const kwc = Array.isArray(r.keywords) ? r.keywords.length : 0;
    if (kwc < 1) return false;
    if (String(r.pipeline_stage || '').toLowerCase() !== 'paying') return false;
    if (rgn && String(r.region || '').trim().toLowerCase() !== rgn) return false;
    return true;
  });
  const base = await payingKeywordsRatioSummaryForCandidateRows(candidates, rgn);
  return { ...base, scope: 'page' };
}

const BATCH_RANK_PCT_MAX = 600;

/**
 * Per-client % = (keywords with rank+screenshot in latest two) / (combined keyword count) × 100.
 */
export async function batchPayingKeywordRankPercentages(region, clientIds) {
  const rgn = String(region || '').trim().toLowerCase();
  const ids = [...new Set((clientIds || []).map((x) => String(x || '').trim()).filter(Boolean))].slice(
    0,
    BATCH_RANK_PCT_MAX,
  );
  const items = [];
  const CONC = 6;
  for (let i = 0; i < ids.length; i += CONC) {
    const chunk = ids.slice(i, i + CONC);
    const parts = await Promise.all(
      chunk.map(async (clientId) => {
        try {
          const out = await buildCombinedModalKeywordRows(clientId, rgn);
          const st = statsFromModalKeywordRows(out.keywords);
          return {
            clientId,
            combinedTotal: st.combinedTotal,
            withRankScreenshotCount: st.withRankScreenshotCount,
            rankPercentage: st.rankPercentage,
          };
        } catch {
          return {
            clientId,
            combinedTotal: 0,
            withRankScreenshotCount: 0,
            rankPercentage: 0,
          };
        }
      }),
    );
    items.push(...parts);
  }
  return { ok: true, items };
}
