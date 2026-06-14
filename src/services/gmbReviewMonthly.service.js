import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import axios from 'axios';
import { createRequire } from 'module';
import { parseCrmSnapshotRegions } from './crmSnapshotRegions.service.js';
import { readServicesKeywordsPayload } from './servicesKeywordsSnapshot.service.js';
import { buildCandidateBusinessIds } from './crmHistorySignals.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');
const DATA_PATH = path.join(SERVER_ROOT, 'data', 'gmb-review-monthly.json');
const SNAPSHOT_CACHE_MS = Number(process.env.GMB_REVIEW_MONTHLY_CACHE_MS || 12_000);
let snapshotCache = null;
let snapshotCacheAt = 0;
const onDemandClientCache = new Map();
const ON_DEMAND_TTL_MS = Number(process.env.GMB_REVIEW_MONTHLY_ON_DEMAND_CACHE_MS || 300_000);
let poolCache = null;
let poolCacheAt = 0;
const POOL_CACHE_MS = Number(process.env.GMB_REVIEW_MONTHLY_POOL_CACHE_MS || 120_000);
const HISTORY_DIR = path.join(SERVER_ROOT, 'data', 'history');
const TRACKING_DIR = path.join(SERVER_ROOT, 'rank_history', 'tracking');
const PAGE_SIZE = Number(process.env.GMB_REVIEW_MONTHLY_PAGE_SIZE || 50);
const CONCURRENCY = Number(process.env.GMB_REVIEW_MONTHLY_CONCURRENCY || 4);
/** 0 = paginate all GBP reviews (no page cap). */
const MAX_PAGES = Number(process.env.GMB_REVIEW_MONTHLY_MAX_PAGES || 0);
const AFTER_KEYWORDS_MS = Number(process.env.GMB_REVIEW_MONTHLY_AFTER_KEYWORDS_MS || 15 * 60 * 1000);
const FETCH_GBP_CURRENT =
  String(process.env.GMB_REVIEW_MONTHLY_FETCH_GBP ?? 'true').toLowerCase() !== 'false';
const require = createRequire(import.meta.url);

function getGmbClient() {
  return require(path.resolve(__dirname, '../../config/gmb.cjs'));
}

export function currentMonthId(d = new Date()) {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${mo}`;
}

function monthWindow(targetMonth, now = new Date()) {
  const monthStart = new Date(`${targetMonth}-01T00:00:00.000Z`);
  const monthEnd = new Date(monthStart);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  const live = currentMonthId(now);
  const endMs =
    targetMonth === live ? Math.min(now.getTime(), monthEnd.getTime()) : monthEnd.getTime();
  return { monthStart, endMs };
}

function reviewInMonth(iso, targetMonth, now = new Date()) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  const { monthStart, endMs } = monthWindow(targetMonth, now);
  return t >= monthStart.getTime() && t < endMs;
}

/** Cumulative total on profile at end of `monthId` (from monthlyHistory rows). */
export function cumulativeTotalForMonth(monthlyHistory, monthId = currentMonthId()) {
  const h = (monthlyHistory || []).find((x) => String(x?.month || '') === monthId);
  return Number(h?.reviewCount) || 0;
}

/** First month of the current UTC calendar year (e.g. 2026-05 → `2026-01`). */
export function currentYearStartMonth(now = new Date()) {
  return `${now.getUTCFullYear()}-01`;
}

/** Month is in the same year as today and not after the current month. */
export function isMonthInCurrentYearWindow(monthId, now = new Date()) {
  const m = String(monthId || '').trim();
  if (!/^\d{4}-\d{2}$/.test(m)) return false;
  if (Number(m.slice(0, 4)) !== now.getUTCFullYear()) return false;
  return m <= currentMonthId(now);
}

export function filterMonthlyHistoryToCurrentYear(history, now = new Date()) {
  const start = currentYearStartMonth(now);
  const end = currentMonthId(now);
  return (Array.isArray(history) ? history : [])
    .filter((h) => {
      const m = String(h?.month || '').trim();
      return m >= start && m <= end;
    })
    .sort((a, b) => a.month.localeCompare(b.month));
}

/** Earliest YYYY-MM from review timestamps (optional diagnostics). */
export function resolveHistoryStartMonth(isos = [], scanMonthIds = []) {
  const months = [];
  for (const iso of isos || []) {
    const m = monthFromIso(iso);
    if (m) months.push(m);
  }
  for (const m of scanMonthIds || []) {
    const s = String(m || '').trim();
    if (/^\d{4}-\d{2}$/.test(s)) months.push(s);
  }
  if (!months.length) return currentYearStartMonth();
  return months.sort()[0];
}

export function listMonthsInclusive(startMonth, endMonth) {
  const out = [];
  const sm = /^(\d{4})-(\d{2})$/.exec(String(startMonth || ''));
  const em = /^(\d{4})-(\d{2})$/.exec(String(endMonth || ''));
  if (!sm || !em) return out;
  let y = Number(sm[1]);
  let mo = Number(sm[2]);
  const ey = Number(em[1]);
  const emo = Number(em[2]);
  while (y < ey || (y === ey && mo <= emo)) {
    out.push(`${y}-${String(mo).padStart(2, '0')}`);
    mo += 1;
    if (mo > 12) {
      mo = 1;
      y += 1;
    }
  }
  return out;
}

function monthEndExclusiveMs(monthId, now = new Date()) {
  const live = currentMonthId(now);
  if (monthId === live) return now.getTime();
  const start = new Date(`${monthId}-01T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return end.getTime();
}

export function enrichRowForLiveMonth(row, now = new Date()) {
  const liveMonth = currentMonthId(now);
  const monthlyHistory = filterMonthlyHistoryToCurrentYear(row?.monthlyHistory, now);
  const totalReviewsGoogle =
    Number(row?.totalReviewsGoogle) ||
    cumulativeTotalForMonth(monthlyHistory, liveMonth) ||
    Number(row?.reviewsThisMonth) ||
    0;
  return {
    ...row,
    currentMonth: liveMonth,
    historyYear: now.getUTCFullYear(),
    totalReviewsGoogle,
    /** Table column: total reviews on Google profile (lifetime, as on GBP now). */
    reviewsThisMonth: totalReviewsGoogle,
    monthlyHistory,
  };
}

function monthFromIso(iso) {
  const t = new Date(iso || 0).getTime();
  if (!Number.isFinite(t)) return null;
  return currentMonthId(new Date(t));
}

function reviewIso(review) {
  const raw = review?.createTime || review?.updateTime || null;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function historyFilePath(businessId) {
  const h = createHash('sha256').update(String(businessId || '')).digest('hex');
  return path.join(HISTORY_DIR, `${h}.json`);
}

function trackingFilePath(businessId) {
  const h = createHash('sha256').update(String(businessId || '')).digest('hex');
  return path.join(TRACKING_DIR, `${h}.json`);
}

function mergeMonthCountMaps(...maps) {
  const out = new Map();
  for (const m of maps) {
    for (const [month, n] of m.entries()) {
      const v = Number(n) || 0;
      if (v <= 0) continue;
      out.set(month, Math.max(out.get(month) || 0, v));
    }
  }
  return [...out.entries()]
    .map(([month, reviewCount]) => ({ month, reviewCount }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Last scan per calendar month → `reviews.total_count` at that time (cumulative on Google).
 */
export function monthlyCumulativeTotalsFromScans(scans) {
  const lastTotalByMonth = new Map();
  const list = Array.isArray(scans) ? [...scans] : [];
  list.sort((a, b) => new Date(a?.scanned_at || 0) - new Date(b?.scanned_at || 0));
  for (const scan of list) {
    const m = monthFromIso(scan?.scanned_at);
    if (!m) continue;
    const total = Number(scan?.reviews?.total_count);
    if (!Number.isFinite(total) || total < 0) continue;
    lastTotalByMonth.set(m, total);
  }
  return filterMonthlyHistoryToCurrentYear(
    [...lastTotalByMonth.entries()].map(([month, reviewCount]) => ({ month, reviewCount })),
  );
}

export function monthlyHistoryFromScans(scans) {
  return monthlyCumulativeTotalsFromScans(scans);
}

/** Paginate all GBP reviews; return create/update ISO timestamps. */
export async function fetchAllReviewIsos(accountId, locationIdShort) {
  const gmb = getGmbClient();
  const accountName = String(accountId || '').startsWith('accounts/')
    ? String(accountId)
    : `accounts/${String(accountId || '').replace(/^accounts\//, '')}`;
  const locShort = String(locationIdShort || '').replace(/^locations\//, '');
  const locationName = `${accountName}/locations/${locShort}`;
  const headers = await gmb.getHeaders();
  const baseUrl = `${gmb.baseURL}/${locationName}/reviews`;
  const isos = [];
  let nextPageToken = null;
  let pages = 0;
  const maxPages = MAX_PAGES;

  do {
    const params = new URLSearchParams();
    params.set('pageSize', String(Math.min(50, Math.max(1, PAGE_SIZE))));
    if (nextPageToken) params.set('pageToken', nextPageToken);
    const url = params.toString() ? `${baseUrl}?${params}` : baseUrl;
    const res = await axios.get(url, { headers, timeout: 90_000, validateStatus: () => true });
    if (res.status >= 400) {
      throw new Error(`Reviews API HTTP ${res.status}: ${String(res.data?.error?.message || res.statusText || '').slice(0, 200)}`);
    }
    const batch = Array.isArray(res.data?.reviews) ? res.data.reviews : [];
    for (const r of batch) {
      const iso = reviewIso(r);
      if (iso) isos.push(iso);
    }
    nextPageToken = res.data?.nextPageToken || null;
    pages += 1;
    if (!nextPageToken) break;
  } while (maxPages <= 0 || pages < maxPages);

  return { isos, pagesFetched: pages, oldestMonth: resolveHistoryStartMonth(isos) };
}

/** Cumulative total on Google at each month-end (Jan → current month of this year only). */
export function cumulativeTotalsFromReviewIsos(isos, now = new Date()) {
  const endMonth = currentMonthId(now);
  const from = currentYearStartMonth(now);
  const months = listMonthsInclusive(from, endMonth);
  const times = (isos || [])
    .map((iso) => new Date(iso).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  return months.map((m) => ({
    month: m,
    reviewCount: times.filter((t) => t < monthEndExclusiveMs(m, now)).length,
  }));
}

export async function fetchCumulativeReviewTotalsByMonth(accountId, locationIdShort) {
  const { isos, pagesFetched, oldestMonth } = await fetchAllReviewIsos(accountId, locationIdShort);
  const startMonth = currentYearStartMonth();
  const monthlyHistory = cumulativeTotalsFromReviewIsos(isos);
  const totalReviewsGoogle = isos.length;
  return {
    monthlyHistory,
    totalReviewsGoogle,
    pagesFetched,
    reviewIsoCount: isos.length,
    historyStartMonth: startMonth,
    historyEndMonth: currentMonthId(),
    oldestReviewMonth: oldestMonth,
  };
}

/** Count GBP reviews whose create/update time falls in `targetMonth` (YYYY-MM). */
export async function fetchReviewsCountForMonth(accountId, locationIdShort, targetMonth) {
  const gmb = getGmbClient();
  const accountName = String(accountId || '').startsWith('accounts/')
    ? String(accountId)
    : `accounts/${String(accountId || '').replace(/^accounts\//, '')}`;
  const locShort = String(locationIdShort || '').replace(/^locations\//, '');
  const locationName = `${accountName}/locations/${locShort}`;
  const headers = await gmb.getHeaders();
  const baseUrl = `${gmb.baseURL}/${locationName}/reviews`;
  const now = new Date();
  const { monthStart } = monthWindow(targetMonth, now);

  let count = 0;
  let nextPageToken = null;
  let pages = 0;
  let sawOlderThanMonth = false;

  do {
    const params = new URLSearchParams();
    params.set('pageSize', String(Math.min(50, Math.max(1, PAGE_SIZE))));
    if (nextPageToken) params.set('pageToken', nextPageToken);
    const url = params.toString() ? `${baseUrl}?${params}` : baseUrl;
    const res = await axios.get(url, { headers, timeout: 90_000, validateStatus: () => true });
    if (res.status >= 400) {
      throw new Error(`Reviews API HTTP ${res.status}: ${String(res.data?.error?.message || res.statusText || '').slice(0, 200)}`);
    }
    const batch = Array.isArray(res.data?.reviews) ? res.data.reviews : [];
    for (const r of batch) {
      const iso = reviewIso(r);
      if (!iso) continue;
      if (reviewInMonth(iso, targetMonth, now)) count += 1;
      else if (new Date(iso).getTime() < monthStart.getTime()) sawOlderThanMonth = true;
    }
    nextPageToken = res.data?.nextPageToken || null;
    pages += 1;
    if (sawOlderThanMonth && !nextPageToken) break;
    if (!nextPageToken) break;
  } while (pages < MAX_PAGES);

  return { month: targetMonth, reviewCount: count, pagesFetched: pages };
}

async function readJsonSafe(fp) {
  try {
    const raw = await fsp.readFile(fp, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Resolve `data/history` or `rank_history/tracking` for a services-keywords row.
 */
export async function resolveHistoryPayloadForRow(row) {
  const cands = buildCandidateBusinessIds({
    locationId: row.locationIdShort || row.locationId,
    businessName: row.business_name,
    gmbListingName: row.gmbName,
  });
  for (const bid of cands) {
    const hist = await readJsonSafe(historyFilePath(bid));
    if (hist?.scans?.length) return { source: 'data/history', businessId: bid, payload: hist };
    const trk = await readJsonSafe(trackingFilePath(bid));
    if (trk?.scans?.length) return { source: 'rank_history/tracking', businessId: bid, payload: trk };
  }
  return null;
}

/**
 * Paginate GBP reviews; bucket counts by UTC calendar month (YYYY-MM).
 */
export async function fetchReviewCountsByMonth(accountId, locationIdShort, maxMonthsBack = 12) {
  const gmb = getGmbClient();
  const accountName = String(accountId || '').startsWith('accounts/')
    ? String(accountId)
    : `accounts/${String(accountId || '').replace(/^accounts\//, '')}`;
  const locShort = String(locationIdShort || '').replace(/^locations\//, '');
  const locationName = `${accountName}/locations/${locShort}`;
  const headers = await gmb.getHeaders();
  const baseUrl = `${gmb.baseURL}/${locationName}/reviews`;

  const byMonth = new Map();
  const now = new Date();
  let nextPageToken = null;
  let pages = 0;
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - maxMonthsBack);

  do {
    const params = new URLSearchParams();
    params.set('pageSize', String(Math.min(50, Math.max(1, PAGE_SIZE))));
    if (nextPageToken) params.set('pageToken', nextPageToken);
    const url = params.toString() ? `${baseUrl}?${params}` : baseUrl;
    const res = await axios.get(url, { headers, timeout: 90_000, validateStatus: () => true });
    if (res.status >= 400) {
      throw new Error(`Reviews API HTTP ${res.status}: ${String(res.data?.error?.message || res.statusText || '').slice(0, 200)}`);
    }
    const batch = Array.isArray(res.data?.reviews) ? res.data.reviews : [];
    for (const r of batch) {
      const iso = reviewIso(r);
      if (!iso) continue;
      const d = new Date(iso);
      if (d.getTime() < cutoff.getTime()) continue;
      const key = currentMonthId(d);
      if (reviewInMonth(iso, key, now)) {
        byMonth.set(key, (byMonth.get(key) || 0) + 1);
      }
    }
    nextPageToken = res.data?.nextPageToken || null;
    pages += 1;
    if (!nextPageToken) break;
  } while (pages < MAX_PAGES);

  const monthlyHistory = [...byMonth.entries()]
    .map(([month, reviewCount]) => ({ month, reviewCount }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const cur = currentMonthId(now);
  return {
    reviewsThisMonth: cumulativeTotalForMonth(monthlyHistory, cur),
    monthlyHistory,
    pagesFetched: pages,
  };
}

function mergeCumulativeMonthlyMaps(scanHistory, gbpHistory, now = new Date()) {
  const map = new Map();
  for (const h of [...(scanHistory || []), ...(gbpHistory || [])]) {
    const m = String(h?.month || '').trim();
    const n = Number(h?.reviewCount) || 0;
    if (!m || !isMonthInCurrentYearWindow(m, now)) continue;
    map.set(m, Math.max(map.get(m) || 0, n));
  }
  const from = currentYearStartMonth(now);
  const end = currentMonthId(now);
  for (const m of listMonthsInclusive(from, end)) {
    if (!map.has(m)) map.set(m, 0);
  }
  const months = [...map.keys()].sort();
  let prev = 0;
  for (const m of months) {
    const v = Math.max(prev, map.get(m) || 0);
    map.set(m, v);
    prev = v;
  }
  return filterMonthlyHistoryToCurrentYear(
    [...map.entries()].map(([month, reviewCount]) => ({ month, reviewCount })),
    now,
  );
}

function eligibleServicesKeywordRows(payload, region) {
  const rgn = String(region || '').trim().toLowerCase();
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  return rows.filter((r) => {
    const kwc = Array.isArray(r.keywords) ? r.keywords.length : 0;
    if (kwc < 1) return false;
    if (String(r.pipeline_stage || '').toLowerCase() !== 'paying') return false;
    if (rgn && String(r.region || '').trim().toLowerCase() !== rgn) return false;
    const cid = String(r.clientId || '').trim();
    const accountId = String(r.accountId || '').trim();
    const loc = String(r.locationIdShort || r.locationId || '').trim();
    return Boolean(cid && accountId && loc);
  });
}

function toPoolRow({ clientId, region, business_name, gmbName, accountId, locationIdShort }) {
  return {
    clientId: String(clientId || '').trim(),
    region: String(region || '').trim().toLowerCase(),
    business_name: String(business_name || '').trim(),
    gmbName: String(gmbName || business_name || '').trim(),
    accountId: String(accountId || '').trim(),
    locationIdShort: String(locationIdShort || '').replace(/^locations\//, '').trim(),
    pipeline_stage: 'paying',
  };
}

/** Paying + keywords + GBP rows from `services-keywords.json` only. */
export async function buildMonthlyPoolRows() {
  if (poolCache && Date.now() - poolCacheAt < POOL_CACHE_MS) return poolCache;

  const regions = parseCrmSnapshotRegions();
  const byClient = new Map();
  const skPayload = await readServicesKeywordsPayload();
  for (const reg of regions) {
    for (const r of eligibleServicesKeywordRows(skPayload, reg)) {
      byClient.set(r.clientId, toPoolRow(r));
    }
  }

  poolCache = [...byClient.values()];
  poolCacheAt = Date.now();
  return poolCache;
}

export async function resolvePoolRowForClient(clientId, region) {
  const cid = String(clientId || '').trim();
  const rgn = String(region || '').trim().toLowerCase();
  if (!cid) return null;

  const pool = await buildMonthlyPoolRows();
  let row = pool.find((r) => r.clientId === cid && (!rgn || r.region === rgn));
  if (!row) row = pool.find((r) => r.clientId === cid);
  return row || null;
}

export function invalidateGmbReviewMonthlyCache() {
  snapshotCache = null;
  snapshotCacheAt = 0;
  poolCache = null;
  poolCacheAt = 0;
  onDemandClientCache.clear();
}

async function pool(items, limit, fn) {
  let i = 0;
  const out = new Array(items.length);
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, () => worker()));
  return out;
}

export async function readGmbReviewMonthlyPayload() {
  const fp = String(process.env.GMB_REVIEW_MONTHLY_JSON_PATH || '').trim() || DATA_PATH;
  try {
    const raw = await fsp.readFile(fp, 'utf8');
    const j = JSON.parse(raw);
    const liveMonth = currentMonthId();
    const rows = (Array.isArray(j?.rows) ? j.rows : []).map((r) => enrichRowForLiveMonth(r));
    return {
      ok: true,
      sourcePath: fp,
      generatedAt: j?.generatedAt ?? null,
      currentMonth: liveMonth,
      crmRegions: Array.isArray(j?.crmRegions) ? j.crmRegions : [],
      summary: j?.summary ?? null,
      byRegion: j?.byRegion && typeof j.byRegion === 'object' ? j.byRegion : {},
      rows,
    };
  } catch {
    return {
      ok: true,
      sourcePath: fp,
      generateAt: null,
      currentMonth: currentMonthId(),
      crmRegions: [],
      summary: null,
      byRegion: {},
      rows: [],
    };
  }
}

export async function readGmbReviewMonthlyPayloadCached() {
  if (snapshotCache && Date.now() - snapshotCacheAt < SNAPSHOT_CACHE_MS) {
    return snapshotCache;
  }
  snapshotCache = await readGmbReviewMonthlyPayload();
  snapshotCacheAt = Date.now();
  return snapshotCache;
}

export async function buildRowMonthlyReview(row, curMonth) {
  const clientId = String(row.clientId || '').trim();
  const region = String(row.region || '').trim().toLowerCase();
  const base = {
    clientId,
    region,
    business_name: String(row.business_name || '').trim(),
    gmbName: String(row.gmbName || '').trim(),
    accountId: String(row.accountId || '').trim(),
    locationIdShort: String(row.locationIdShort || row.locationId || '').trim(),
    reviewsThisMonth: 0,
    totalReviewsGoogle: 0,
    monthlyHistory: [],
    historySource: null,
    resolvedBusinessId: null,
    fetchError: null,
    scannedAt: new Date().toISOString(),
  };

  const resolved = await resolveHistoryPayloadForRow(row);
  const scans = resolved?.payload?.scans || [];
  const scanHistory = monthlyCumulativeTotalsFromScans(scans);
  let gbpHistory = [];
  let gbpError = null;
  let totalReviewsGoogle = 0;

  if (FETCH_GBP_CURRENT && base.accountId && base.locationIdShort) {
    try {
      const gbp = await fetchCumulativeReviewTotalsByMonth(base.accountId, base.locationIdShort);
      gbpHistory = gbp.monthlyHistory || [];
      totalReviewsGoogle = Number(gbp.totalReviewsGoogle) || 0;
    } catch (e) {
      gbpError = String(e?.message || e);
    }
  }

  const monthlyHistory = mergeCumulativeMonthlyMaps(scanHistory, gbpHistory, new Date());
  if (!totalReviewsGoogle) {
    totalReviewsGoogle = cumulativeTotalForMonth(monthlyHistory, curMonth);
  }

  return enrichRowForLiveMonth({
    ...base,
    monthlyHistory,
    totalReviewsGoogle,
    historySource: resolved?.source || (scans.length ? 'scan_only_no_file_match' : null),
    resolvedBusinessId: resolved?.businessId || null,
    fetchError: gbpError,
    scanMonthsFound: scanHistory.length,
  });
}

export async function buildAndWriteGmbReviewMonthlySnapshot(outputPath = DATA_PATH) {
  const now = new Date();
  const curMonth = currentMonthId(now);
  const regions = parseCrmSnapshotRegions();
  const unique = await buildMonthlyPoolRows();
  const skPayload = await readServicesKeywordsPayload();

  const yearStart = currentYearStartMonth(now);
  console.log(
    `[GmbReviewMonthly] building ${unique.length} rows (cumulative totals ${yearStart} → ${curMonth}, current year only)…`,
  );

  const built = await pool(unique, CONCURRENCY, async (row) => buildRowMonthlyReview(row, curMonth));

  const byRegion = {};
  for (const reg of regions) {
    byRegion[reg] = { rows: built.filter((r) => r.region === reg) };
  }

  const withKeywordsByRegion = {};
  for (const reg of regions) {
    withKeywordsByRegion[reg] = eligibleServicesKeywordRows(skPayload, reg).length;
  }

  const withHistory = built.filter((r) => r.historySource);
  const withReviewsThisMonth = built.filter((r) => (r.totalReviewsGoogle ?? r.reviewsThisMonth ?? 0) > 0).length;

  const outPayload = {
    ok: true,
    generatedAt: now.toISOString(),
    currentMonth: curMonth,
    crmRegions: regions,
    historyYear: now.getUTCFullYear(),
    historyStartMonth: yearStart,
    historyEndMonth: curMonth,
    countMode: 'cumulative_total_on_google_current_year',
    dataSources: ['services-keywords', 'data/history', 'rank_history/tracking', FETCH_GBP_CURRENT ? 'gbp_reviews_api' : 'scans_only'],
    summary: {
      totalRows: built.length,
      withHistoryLinked: withHistory.length,
      withReviewsThisMonth,
      noReviewsThisMonth: built.length - withReviewsThisMonth,
      gbpFetchErrors: built.filter((r) => r.fetchError).length,
      withKeywordsByRegion,
    },
    byRegion,
    rows: built,
  };

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, JSON.stringify(outPayload, null, 2), 'utf8');
  invalidateGmbReviewMonthlyCache();
  console.log('[GmbReviewMonthly] wrote', outputPath, outPayload.summary);
  return { outputPath, summary: outPayload.summary, payload: outPayload };
}

export function filterRowsByRegion(rows, payload, region) {
  const r = String(region || '').trim().toLowerCase();
  if (!r) return rows;
  const hasRowRegion = rows.some((row) => String(row?.region || '').trim());
  if (hasRowRegion) return rows.filter((row) => String(row?.region || '').trim().toLowerCase() === r);
  const crm =
    Array.isArray(payload?.crmRegions) && payload.crmRegions.length === 1
      ? String(payload.crmRegions[0] || '').trim().toLowerCase()
      : '';
  return crm === r ? rows : [];
}

export function getClientMonthlyHistory(payload, clientId, region) {
  const cid = String(clientId || '').trim();
  const rgn = String(region || '').trim().toLowerCase();
  const rows = filterRowsByRegion(payload.rows || [], payload, rgn);
  const row = rows.find((x) => String(x.clientId || '').trim() === cid);
  if (!row) return null;
  const live = enrichRowForLiveMonth(row);
  return {
    clientId: cid,
    region: live.region || rgn || null,
    business_name: live.business_name || null,
    gmbName: live.gmbName || null,
    currentMonth: live.currentMonth,
    reviewsThisMonth: live.reviewsThisMonth,
    monthlyHistory: live.monthlyHistory,
    fetchError: live.fetchError || null,
    generatedAt: payload.generatedAt || null,
  };
}

export async function getClientMonthlyHistoryOrBuild(clientId, region) {
  const cid = String(clientId || '').trim();
  const rgn = String(region || '').trim().toLowerCase();
  const payload = await readGmbReviewMonthlyPayloadCached();
  const fromSnapshot = getClientMonthlyHistory(payload, cid, rgn);
  if (fromSnapshot) return { history: fromSnapshot, source: 'snapshot' };

  const cached = onDemandClientCache.get(`${rgn}:${cid}`);
  if (cached && Date.now() - cached.at < ON_DEMAND_TTL_MS) {
    return { history: getClientMonthlyHistory({ ...payload, rows: [cached.row] }, cid, rgn), source: 'on_demand_cache' };
  }

  const poolRow = await resolvePoolRowForClient(cid, rgn);
  if (!poolRow?.accountId || !poolRow?.locationIdShort) {
    return {
      history: {
        clientId: cid,
        region: rgn || null,
        business_name: null,
        gmbName: null,
        currentMonth: currentMonthId(),
        reviewsThisMonth: 0,
        monthlyHistory: [],
        fetchError: 'no_gbp_location_for_client',
        generatedAt: payload.generatedAt || null,
      },
      source: 'empty',
    };
  }

  const built = await buildRowMonthlyReview(poolRow, currentMonthId());
  onDemandClientCache.set(`${rgn}:${cid}`, { at: Date.now(), row: built });
  return {
    history: getClientMonthlyHistory({ ...payload, rows: [built], generatedAt: new Date().toISOString() }, cid, rgn),
    source: 'on_demand_gbp',
  };
}

export async function runGmbReviewMonthlyRebuildJob() {
  const outputPath = String(process.env.GMB_REVIEW_MONTHLY_JSON_PATH || '').trim() || DATA_PATH;
  try {
    const out = await buildAndWriteGmbReviewMonthlySnapshot(outputPath);
    return { ok: true, outputPath, summary: out?.summary || null };
  } catch (e) {
    const msg = String(e?.message || e);
    console.error('[GmbReviewMonthly] failed:', msg);
    return { ok: false, outputPath, error: msg };
  }
}

let _afterKeywordsTimer = null;

/** Run rebuild ~15m after services-keywords cron finishes (deduped). */
export function scheduleGmbReviewMonthlyAfterKeywords(reason = 'services-keywords') {
  if (String(process.env.ENABLE_GMB_REVIEW_MONTHLY_AFTER_KEYWORDS ?? 'true').toLowerCase() === 'false') {
    return;
  }
  if (_afterKeywordsTimer) clearTimeout(_afterKeywordsTimer);
  const delay = Math.max(60_000, AFTER_KEYWORDS_MS);
  const runAt = new Date(Date.now() + delay);
  console.log(
    `[GmbReviewMonthly] scheduled rebuild in ${Math.round(delay / 60000)}m after ${reason} (at ${runAt.toISOString()})`,
  );
  _afterKeywordsTimer = setTimeout(() => {
    _afterKeywordsTimer = null;
    void runGmbReviewMonthlyRebuildJob();
  }, delay);
}

function msUntilNextGmbReviewMonthlyCronUtc() {
  const skH = Number(
    process.env.SERVICES_KEYWORDS_CRON_UTC_HOUR ?? process.env.KEYWORDS_ALIGN_CRON_UTC_HOUR ?? 21,
  );
  const skM = Number(
    process.env.SERVICES_KEYWORDS_CRON_UTC_MINUTE ?? process.env.KEYWORDS_ALIGN_CRON_UTC_MINUTE ?? 0,
  );
  const offsetMin = Number(process.env.GMB_REVIEW_MONTHLY_CRON_OFFSET_MINUTES ?? 15);
  let totalM = skM + offsetMin;
  let h = skH + Math.floor(totalM / 60);
  const m = totalM % 60;
  h %= 24;
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, 0, 0));
  if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return Math.max(60_000, target.getTime() - now.getTime());
}

let _monthlyCronTimer = null;

export function initGmbReviewMonthlyCron() {
  const enabled = String(process.env.ENABLE_GMB_REVIEW_MONTHLY_CRON ?? 'true').toLowerCase() !== 'false';
  if (!enabled) {
    console.log('[GmbReviewMonthly] cron disabled (ENABLE_GMB_REVIEW_MONTHLY_CRON=false)');
    return;
  }

  const scheduleNext = () => {
    const delay = msUntilNextGmbReviewMonthlyCronUtc();
    const next = new Date(Date.now() + delay);
    const offsetMin = Number(process.env.GMB_REVIEW_MONTHLY_CRON_OFFSET_MINUTES ?? 15);
    console.log(
      `[GmbReviewMonthly] next daily rebuild at ${next.toISOString()} (services-keywords UTC slot + ${offsetMin}m)`,
    );
    _monthlyCronTimer = setTimeout(async () => {
      _monthlyCronTimer = null;
      await runGmbReviewMonthlyRebuildJob();
      scheduleNext();
    }, delay);
  };

  if (String(process.env.GMB_REVIEW_MONTHLY_RUN_ON_STARTUP ?? 'false').toLowerCase() === 'true') {
    void runGmbReviewMonthlyRebuildJob();
  }
  scheduleNext();
}
