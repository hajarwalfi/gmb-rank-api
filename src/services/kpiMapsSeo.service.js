import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildCrmSignalsFromServicesKeywords } from './crmHistorySignals.service.js';
import { parseCrmSnapshotRegions } from './crmSnapshotRegions.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Stored under `server/data/kpi-monthly/` — one JSON per calendar month + region. */
export function kpiMonthlyDir() {
  return path.join(__dirname, '../../data/kpi-monthly');
}

export function kpiMonthlyFilePath(region, monthId) {
  const rgn = String(region || '').trim().toLowerCase();
  const m = String(monthId || '').trim();
  return path.join(kpiMonthlyDir(), `${m}-${rgn}.json`);
}

export function currentMonthId(d = new Date()) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${mo}`;
}

export function previousMonthId(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const y = x.getFullYear();
  const mo = String(x.getMonth() + 1).padStart(2, '0');
  return `${y}-${mo}`;
}

const RANK_FILTERS = new Set(['all', 'ranked', 'improved', 'not_ranked', 'two_scans']);

/** Combined ES + US + BR maps/SEO KPIs (valid paying GMB rows from services-keywords snapshot). */
export const KPI_COMBINED_REGION = 'combined';

export function isCombinedKpiRegion(region) {
  const r = String(region || '').trim().toLowerCase();
  return r === KPI_COMBINED_REGION || r === 'all' || r === 'es,us,br' || r === 'es+us+br';
}

function sumMetricObjects(target, add) {
  if (!add || typeof add !== 'object') return target;
  const keys = [
    'payingWithKeywords',
    'ranked',
    'notRanked',
    'improved',
    'improvedRanked',
    'improvedNotRanked',
    'withTwoScans',
  ];
  for (const k of keys) {
    target[k] = (target[k] ?? 0) + Number(add[k] ?? 0);
  }
  return target;
}

function finalizeRates(metrics) {
  const payingWithKeywords = Number(metrics.payingWithKeywords ?? 0);
  metrics.rankedRatePercent =
    payingWithKeywords > 0
      ? Math.round((Number(metrics.ranked ?? 0) * 1000) / payingWithKeywords) / 10
      : 0;
  metrics.improvedRatePercent =
    payingWithKeywords > 0
      ? Math.round((Number(metrics.improved ?? 0) * 1000) / payingWithKeywords) / 10
      : 0;
  return metrics;
}

/**
 * Merge paying+keywords CRM signal rows from each configured CRM region (default es, us, br).
 * Client IDs are deduped (last region wins if duplicate — should not occur).
 */
async function buildMergedCrmSignalsByClientId() {
  const regions = parseCrmSnapshotRegions();
  const byClientId = {};
  let summaryWithKeywords = 0;
  let matchedSnapshotRows = 0;
  for (const rgn of regions) {
    const snap = await buildCrmSignalsFromServicesKeywords(rgn);
    const by = snap.byClientId && typeof snap.byClientId === 'object' ? snap.byClientId : {};
    for (const [id, s] of Object.entries(by)) {
      const cid = String(id || '').trim();
      if (cid) byClientId[cid] = s;
    }
    const sw = Number(snap.summaryWithKeywords);
    if (Number.isFinite(sw) && sw > 0) summaryWithKeywords += Math.floor(sw);
    matchedSnapshotRows += Number(snap.matchedSnapshotRows ?? Object.keys(by).length);
  }
  return {
    regions,
    byClientId,
    summaryWithKeywords: summaryWithKeywords > 0 ? summaryWithKeywords : null,
    matchedSnapshotRows,
  };
}

function aggregatesFromSignalEntries(entries, filter, summaryWithKeywords, matchedSnapshotRows) {
  const filtered = entries.filter(([, s]) => passesRankMapFilter(s, filter));

  let ranked = 0;
  let notRanked = 0;
  let improved = 0;
  let improvedRanked = 0;
  let improvedNotRanked = 0;
  let withTwoScans = 0;

  for (const [, s] of filtered) {
    if (!s) continue;
    if (s.hasRanked) ranked += 1;
    else notRanked += 1;
    if ((s.scanCount ?? 0) >= 2) withTwoScans += 1;
    const imp = (s.scanCount ?? 0) >= 2 && Boolean(s.hasImproved);
    if (imp) {
      improved += 1;
      if (s.hasRanked) improvedRanked += 1;
      else improvedNotRanked += 1;
    }
  }

  const payingWithKeywordsDenom =
    filter === 'all' && summaryWithKeywords != null && summaryWithKeywords > 0
      ? summaryWithKeywords
      : filtered.length;

  const rankedRatePercent =
    payingWithKeywordsDenom > 0 ? Math.round((ranked * 1000) / payingWithKeywordsDenom) / 10 : 0;
  const improvedRatePercent =
    payingWithKeywordsDenom > 0 ? Math.round((improved * 1000) / payingWithKeywordsDenom) / 10 : 0;

  return {
    snapshotMatchedRows: matchedSnapshotRows,
    summaryWithKeywords,
    payingWithKeywords: payingWithKeywordsDenom,
    ranked,
    notRanked,
    improved,
    improvedRanked,
    improvedNotRanked,
    withTwoScans,
    rankedRatePercent,
    improvedRatePercent,
  };
}

/**
 * Same semantics as Client Hub CRM Paying tab rank-map filter (snapshot + signals).
 * `hasRanked` on each row follows the modal rule: ≥1 combined keyword with rank+screenshot
 * on latest or previous scan (see {@link buildCrmSignalsFromServicesKeywords}).
 * @param {object | undefined} s
 * @param {string} rankMapFilter
 */
export function passesRankMapFilter(s, rankMapFilter) {
  const f = String(rankMapFilter || 'all').trim();
  if (f === 'all') return true;
  if (!s) return f === 'not_ranked';
  if (f === 'ranked') return Boolean(s.hasRanked);
  if (f === 'improved') return (s.scanCount ?? 0) >= 2 && Boolean(s.hasImproved);
  if (f === 'not_ranked') return !s.hasRanked;
  if (f === 'two_scans') return (s.scanCount ?? 0) >= 2;
  return true;
}

/**
 * Aggregate maps/SEO KPIs for one region or combined ES+US+BR (CRM Paying rank filter parity).
 */
export async function computeMapsSeoAggregates(region, rankMapFilter = 'all') {
  const rgn = String(region || '').trim().toLowerCase();
  const filter = RANK_FILTERS.has(String(rankMapFilter)) ? String(rankMapFilter) : 'all';

  if (isCombinedKpiRegion(rgn)) {
    const merged = await buildMergedCrmSignalsByClientId();
    const entries = Object.entries(merged.byClientId).filter(([id]) => id && String(id).trim());
    const agg = aggregatesFromSignalEntries(
      entries,
      filter,
      merged.summaryWithKeywords,
      merged.matchedSnapshotRows,
    );
    return {
      region: KPI_COMBINED_REGION,
      crmRegions: merged.regions,
      rankMapFilter: filter,
      generatedAt: new Date().toISOString(),
      ...agg,
    };
  }

  const snap = await buildCrmSignalsFromServicesKeywords(rgn);
  const by = snap.byClientId && typeof snap.byClientId === 'object' ? snap.byClientId : {};
  const entries = Object.entries(by).filter(([id]) => id && String(id).trim());
  const summaryWk =
    Number.isFinite(Number(snap.summaryWithKeywords)) && Number(snap.summaryWithKeywords) > 0
      ? Math.floor(Number(snap.summaryWithKeywords))
      : null;
  const agg = aggregatesFromSignalEntries(
    entries,
    filter,
    summaryWk,
    Number(snap.matchedSnapshotRows ?? entries.length),
  );

  return {
    region: rgn || null,
    rankMapFilter: filter,
    generatedAt: new Date().toISOString(),
    ...agg,
  };
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function readMonthlySnapshot(region, monthId) {
  const rgn = String(region || '').trim().toLowerCase();
  if (isCombinedKpiRegion(rgn)) {
    const combinedFp = kpiMonthlyFilePath(KPI_COMBINED_REGION, monthId);
    if (fs.existsSync(combinedFp)) return readJsonSafe(combinedFp);
    const regions = parseCrmSnapshotRegions();
    const parts = regions.map((r) => readMonthlySnapshot(r, monthId)).filter(Boolean);
    if (parts.length === 0) return null;
    const metrics = {};
    for (const p of parts) {
      sumMetricObjects(metrics, p.metrics || p);
    }
    finalizeRates(metrics);
    return {
      schemaVersion: 1,
      month: String(monthId),
      region: KPI_COMBINED_REGION,
      crmRegions: regions,
      aggregatedFrom: regions,
      metrics,
    };
  }
  const fp = kpiMonthlyFilePath(region, monthId);
  if (!fs.existsSync(fp)) return null;
  return readJsonSafe(fp);
}

export function writeMonthlySnapshot(region, monthId, payload) {
  const dir = kpiMonthlyDir();
  fs.mkdirSync(dir, { recursive: true });
  const fp = kpiMonthlyFilePath(region, monthId);
  const body = {
    schemaVersion: 1,
    month: String(monthId),
    region: String(region || '').trim().toLowerCase(),
    savedAt: new Date().toISOString(),
    ...payload,
  };
  fs.writeFileSync(fp, JSON.stringify(body, null, 2), 'utf8');
  return fp;
}

function growthBetween(current, previous) {
  if (!previous || !current) {
    return {
      hasPrevious: false,
      rankedDelta: 0,
      notRankedDelta: 0,
      improvedDelta: 0,
      improvedRankedDelta: 0,
      improvedNotRankedDelta: 0,
      rankedRatePointsDelta: 0,
      improvedRatePointsDelta: 0,
    };
  }
  return {
    hasPrevious: true,
    rankedDelta: (current.ranked ?? 0) - (previous.ranked ?? 0),
    notRankedDelta: (current.notRanked ?? 0) - (previous.notRanked ?? 0),
    improvedDelta: (current.improved ?? 0) - (previous.improved ?? 0),
    improvedRankedDelta: (current.improvedRanked ?? 0) - (previous.improvedRanked ?? 0),
    improvedNotRankedDelta: (current.improvedNotRanked ?? 0) - (previous.improvedNotRanked ?? 0),
    rankedRatePointsDelta:
      Math.round(((current.rankedRatePercent ?? 0) - (previous.rankedRatePercent ?? 0)) * 10) / 10,
    improvedRatePointsDelta:
      Math.round(((current.improvedRatePercent ?? 0) - (previous.improvedRatePercent ?? 0)) * 10) / 10,
  };
}

/**
 * Live metrics + optional previous-month file + growth.
 * If no previous file, growth fields are zero and hasPrevious false (UI can show 0% / em dash).
 */
export async function buildMapsSeoDashboard(region, rankMapFilter = 'all') {
  const rgn = String(region || '').trim().toLowerCase();
  const filter = RANK_FILTERS.has(String(rankMapFilter)) ? String(rankMapFilter) : 'all';
  const live = await computeMapsSeoAggregates(rgn, filter);

  const now = new Date();
  const curMonth = currentMonthId(now);
  const prevMonth = previousMonthId(now);

  let previous = readMonthlySnapshot(rgn, prevMonth);
  const hadBaselineFile = Boolean(previous);
  /** Seed empty previous metrics for response only when file missing — MoM stays 0 until first monthly JSON exists. */
  if (!previous) {
    previous = {
      schemaVersion: 1,
      month: prevMonth,
      region: rgn,
      placeholder: true,
      metrics: {
        payingWithKeywords: 0,
        ranked: 0,
        notRanked: 0,
        improved: 0,
        improvedRanked: 0,
        improvedNotRanked: 0,
        withTwoScans: 0,
        rankedRatePercent: 0,
        improvedRatePercent: 0,
        rankMapFilter: filter,
      },
    };
  }

  const prevMetrics = previous.metrics || previous;
  const growth = hadBaselineFile ? growthBetween(live, prevMetrics) : growthBetween(null, null);

  return {
    ok: true,
    currentMonth: curMonth,
    previousMonth: prevMonth,
    live,
    previousMetrics: prevMetrics,
    growth,
    monthlyFileHint: kpiMonthlyFilePath(rgn, prevMonth),
  };
}

/**
 * Persist a month’s rollup (call from cron on 1st or manually). Writes `data/kpi-monthly/{month}-{region}.json`.
 */
export async function saveMonthlyMapsSeoSnapshot(region, monthId, rankMapFilter = 'all') {
  const rgn = String(region || '').trim().toLowerCase();
  const m = String(monthId || '').trim();
  if (!/^\d{4}-\d{2}$/.test(m)) {
    throw new Error('monthId must be YYYY-MM');
  }
  const filter = RANK_FILTERS.has(String(rankMapFilter)) ? String(rankMapFilter) : 'all';
  const saveAs = isCombinedKpiRegion(rgn) ? KPI_COMBINED_REGION : rgn;
  const metrics = await computeMapsSeoAggregates(saveAs, filter);
  const crmRegions = isCombinedKpiRegion(rgn) ? parseCrmSnapshotRegions() : undefined;
  writeMonthlySnapshot(saveAs, m, {
    metrics,
    rankMapFilter: filter,
    ...(crmRegions ? { crmRegions } : {}),
  });
  return { ok: true, region: saveAs, month: m, file: kpiMonthlyFilePath(saveAs, m) };
}
