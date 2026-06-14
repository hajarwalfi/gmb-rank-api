import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { createRequire } from 'module';
import { parseCrmSnapshotRegions } from './crmSnapshotRegions.service.js';
import { readBusinessConnectSnapshotPayload } from './businessConnectCron.service.js';
import { readServicesKeywordsPayload } from './servicesKeywordsSnapshot.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');
const DATA_PATH = path.join(SERVER_ROOT, 'data', 'gmb-review-tracking.json');
const LOG_JSONL = path.join(SERVER_ROOT, 'data', 'gmb_review_tracking_cron.jsonl');
const LOG_LAST = path.join(SERVER_ROOT, 'data', 'gmb_review_tracking_cron_last.json');
const PAGE_SIZE = Number(process.env.GMB_REVIEW_TRACKING_PAGE_SIZE || 50);
const CONCURRENCY = Number(process.env.GMB_REVIEW_TRACKING_CONCURRENCY || 3);
const require = createRequire(import.meta.url);

function getGmbClient() {
  return require(path.resolve(__dirname, '../../config/gmb.cjs'));
}

function appendLog(payload) {
  try {
    const dir = path.dirname(LOG_JSONL);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const rec = { ts: new Date().toISOString(), ...payload };
    fs.appendFileSync(LOG_JSONL, `${JSON.stringify(rec)}\n`, 'utf8');
    fs.writeFileSync(LOG_LAST, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
  } catch (e) {
    console.warn('[GmbReviewTracking] log write failed:', e?.message || e);
  }
}

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** @param {string | null | undefined} iso */
export function formatLastReviewAge(iso, now = new Date()) {
  if (!iso) {
    return { days: null, daysLabel: '-', ageBucket: 'no_reviews' };
  }
  const last = new Date(iso);
  if (Number.isNaN(last.getTime())) {
    return { days: null, daysLabel: '-', ageBucket: 'unknown' };
  }
  const ms = now.getTime() - last.getTime();
  if (ms < 24 * 60 * 60 * 1000) {
    return { days: 0, daysLabel: 'less than 24hrs', ageBucket: 'under_24h' };
  }
  const today0 = startOfUtcDay(now);
  const review0 = startOfUtcDay(last);
  const dayDiff = Math.max(0, Math.round((today0.getTime() - review0.getTime()) / 86400000));
  if (dayDiff <= 0) {
    return { days: 0, daysLabel: 'less than 24hrs', ageBucket: 'under_24h' };
  }
  const daysLabel = dayDiff === 1 ? '1 days ago' : `${dayDiff} days ago`;
  let ageBucket = 'ok';
  if (dayDiff >= 30) ageBucket = 'gte_30d';
  else if (dayDiff >= 14) ageBucket = 'gte_14d';
  return { days: dayDiff, daysLabel, ageBucket };
}

function parseReviewTime(review) {
  const raw = review?.createTime || review?.updateTime || review?.raw?.createTime || review?.raw?.updateTime;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Fetch reviews with pageSize=50; return newest createTime from paginated results (max 3 pages cap).
 */
async function fetchLatestReviewIso(accountId, locationIdShort) {
  const gmb = getGmbClient();
  const accountName = String(accountId || '').startsWith('accounts/')
    ? String(accountId)
    : `accounts/${String(accountId || '').replace(/^accounts\//, '')}`;
  const locShort = String(locationIdShort || '').replace(/^locations\//, '');
  const locationName = `${accountName}/locations/${locShort}`;
  const headers = await gmb.getHeaders();
  const baseUrl = `${gmb.baseURL}/${locationName}/reviews`;

  let nextPageToken = null;
  let bestIso = null;
  let bestMs = 0;
  let pages = 0;
  const maxPages = Number(process.env.GMB_REVIEW_TRACKING_MAX_PAGES || 3);

  do {
    const params = new URLSearchParams();
    params.set('pageSize', String(Math.min(50, Math.max(1, PAGE_SIZE))));
    if (nextPageToken) params.set('pageToken', nextPageToken);
    const url = params.toString() ? `${baseUrl}?${params}` : baseUrl;
    const res = await axios.get(url, { headers, timeout: 60_000, validateStatus: () => true });
    if (res.status >= 400) {
      throw new Error(`Reviews API HTTP ${res.status}: ${String(res.data?.error?.message || res.statusText || '').slice(0, 200)}`);
    }
    const batch = Array.isArray(res.data?.reviews) ? res.data.reviews : [];
    for (const r of batch) {
      const iso = r?.createTime || r?.updateTime || null;
      if (!iso) continue;
      const ms = new Date(iso).getTime();
      if (Number.isFinite(ms) && ms >= bestMs) {
        bestMs = ms;
        bestIso = new Date(ms).toISOString();
      }
    }
    if (!batch.length && !res.data?.nextPageToken) break;
    nextPageToken = res.data?.nextPageToken || null;
    pages += 1;
    if (!nextPageToken) break;
  } while (pages < maxPages);

  return { lastReviewAt: bestIso, pagesFetched: pages };
}

function linkedPayingRowsFromBusinessConnect() {
  return readBusinessConnectSnapshotPayload().then((p) => {
    const rows = Array.isArray(p?.rows) ? p.rows : [];
    return rows.filter(
      (r) =>
        String(r?.pipeline_stage || '') === 'paying' &&
        r?.status === 'linked' &&
        r?.linkedbusiness?.location_id,
    );
  });
}

async function loadAccountIdLookup() {
  const lookup = {
    byClientId: new Map(),
    byLocationId: new Map(),
    envDefaultAccountId: String(process.env.GMB_DEFAULT_ACCOUNT_ID || process.env.GMB_ACCOUNT_ID || '').trim(),
  };
  try {
    const payload = await readServicesKeywordsPayload();
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    for (const row of rows) {
      const accountId = String(row?.accountId || '').trim();
      if (!accountId) continue;
      const cid = String(row?.clientId || '').trim();
      const loc = String(row?.locationIdShort || row?.locationId || '').trim();
      if (cid) lookup.byClientId.set(cid, accountId);
      if (loc) lookup.byLocationId.set(loc, accountId);
    }
  } catch (e) {
    console.warn('[GmbReviewTracking] services-keywords account lookup failed:', e?.message || e);
  }
  return lookup;
}

function resolveAccountId(entry, lookup) {
  const fromRow = String(
    entry?.accountId ||
      entry?.linkedbusiness?.accountId ||
      entry?.linkedbusiness?.account_id ||
      '',
  ).trim();
  if (fromRow) return fromRow;
  const clientId = String(entry?.clientId || '').trim();
  const loc = String(entry?.linkedbusiness?.location_id || '').trim();
  if (clientId && lookup?.byClientId?.get(clientId)) return lookup.byClientId.get(clientId);
  if (loc && lookup?.byLocationId?.get(loc)) return lookup.byLocationId.get(loc);
  return String(lookup?.envDefaultAccountId || '').trim();
}

async function buildRowFromBusinessConnect(entry, now, lookup) {
  const clientId = String(entry?.clientId || '').trim();
  const region = String(entry?.region || '').trim().toLowerCase();
  const businessName = String(entry?.business_name || '').trim();
  const gmbName = String(entry?.linkedbusiness?.connected_business_name || businessName).trim();
  const accountId = resolveAccountId(entry, lookup);
  const locationIdShort = String(entry?.linkedbusiness?.location_id || '').trim();

  const base = {
    clientId,
    region,
    business_name: businessName,
    gmbName,
    accountId: accountId || null,
    locationIdShort,
    totalReviews: Number(entry?.linkedbusiness?.reviews_count ?? entry?.reviews_count ?? 0) || 0,
    lastReviewAt: null,
    days: null,
    daysLabel: '-',
    ageBucket: 'no_reviews',
    fetchError: null,
    scannedAt: now.toISOString(),
  };

  if (!accountId || !locationIdShort) {
    return { ...base, fetchError: 'Missing accountId or locationId' };
  }

  try {
    const { lastReviewAt } = await fetchLatestReviewIso(accountId, locationIdShort);
    const age = formatLastReviewAge(lastReviewAt, now);
    return {
      ...base,
      lastReviewAt,
      days: age.days,
      daysLabel: age.daysLabel,
      ageBucket: age.ageBucket,
    };
  } catch (e) {
    return { ...base, fetchError: String(e?.message || e) };
  }
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

export async function readGmbReviewTrackingPayload() {
  const fp = String(process.env.GMB_REVIEW_TRACKING_JSON_PATH || '').trim() || DATA_PATH;
  try {
    const raw = await fsp.readFile(fp, 'utf8');
    const j = JSON.parse(raw);
    return {
      ok: true,
      sourcePath: fp,
      generatedAt: j?.generatedAt ?? null,
      scanDate: j?.scanDate ?? null,
      crmRegions: Array.isArray(j?.crmRegions) ? j.crmRegions : [],
      doneReminders: j?.doneReminders && typeof j.doneReminders === 'object' ? j.doneReminders : {},
      byRegion: j?.byRegion && typeof j.byRegion === 'object' ? j.byRegion : {},
      rows: Array.isArray(j?.rows) ? j.rows : [],
      summary: j?.summary ?? null,
    };
  } catch {
    return {
      ok: true,
      sourcePath: fp,
      generatedAt: null,
      scanDate: null,
      crmRegions: [],
      doneReminders: {},
      byRegion: {},
      rows: [],
      summary: null,
    };
  }
}

export async function buildAndWriteGmbReviewTrackingSnapshot(outputPath = DATA_PATH) {
  const now = new Date();
  const scanDate = now.toISOString().slice(0, 10);
  const regions = parseCrmSnapshotRegions();
  const prev = await readGmbReviewTrackingPayload();
  const doneReminders = prev.doneReminders || {};

  const linked = await linkedPayingRowsFromBusinessConnect();
  const accountLookup = await loadAccountIdLookup();
  const built = await pool(linked, CONCURRENCY, (entry) =>
    buildRowFromBusinessConnect(entry, now, accountLookup),
  );

  /** @type {Record<string, { rows: unknown[] }>} */
  const byRegion = {};
  for (const reg of regions) {
    byRegion[reg] = { rows: built.filter((r) => r.region === reg) };
  }

  const noReviews = built.filter((r) => !r.lastReviewAt);
  const gte14 = built.filter((r) => r.ageBucket === 'gte_14d' || r.ageBucket === 'gte_30d');
  const gte30 = built.filter((r) => r.ageBucket === 'gte_30d');

  const payload = {
    ok: true,
    generatedAt: now.toISOString(),
    scanDate,
    crmRegions: regions,
    doneReminders,
    summary: {
      totalLinkedPaying: built.length,
      withLastReview: built.filter((r) => r.lastReviewAt).length,
      noReviews: noReviews.length,
      gte14Days: gte14.length,
      gte30Days: gte30.length,
      errors: built.filter((r) => r.fetchError).length,
      byRegion: Object.fromEntries(
        regions.map((reg) => {
          const rows = byRegion[reg]?.rows || [];
          return [
            reg,
            {
              count: rows.length,
              noReviews: rows.filter((r) => !r.lastReviewAt).length,
              gte14Days: rows.filter((r) => r.ageBucket === 'gte_14d' || r.ageBucket === 'gte_30d').length,
              gte30Days: rows.filter((r) => r.ageBucket === 'gte_30d').length,
            },
          ];
        }),
      ),
    },
    byRegion,
    rows: built,
  };

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8');
  return { outputPath, summary: payload.summary, payload };
}

function isDone(doneReminders, clientId, bucket) {
  const rec = doneReminders?.[clientId];
  if (!rec) return false;
  if (bucket === 'twoWeeks') return Boolean(rec.twoWeeks);
  if (bucket === 'oneMonth') return Boolean(rec.oneMonth);
  return false;
}

export function buildFrequencyLists(payload, region) {
  const reg = String(region || '').trim().toLowerCase();
  const rows = reg
    ? Array.isArray(payload?.byRegion?.[reg]?.rows)
      ? payload.byRegion[reg].rows
      : (payload?.rows || []).filter((r) => r.region === reg)
    : payload?.rows || [];

  const doneReminders = payload?.doneReminders || {};
  const twoWeeks = [];
  const oneMonth = [];

  for (const r of rows) {
    const days = r.days ?? null;
    const cid = String(r.clientId || '');
    if (!cid) continue;
    if (days != null && days >= 14 && days < 30 && !isDone(doneReminders, cid, 'twoWeeks')) {
      twoWeeks.push(r);
    }
    if (days != null && days >= 30 && !isDone(doneReminders, cid, 'oneMonth')) {
      oneMonth.push(r);
    }
  }

  twoWeeks.sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
  oneMonth.sort((a, b) => (b.days ?? 0) - (a.days ?? 0));

  return {
    region: reg || 'all',
    scanDate: payload?.scanDate ?? null,
    generatedAt: payload?.generatedAt ?? null,
    twoWeeks,
    oneMonth,
    counts: {
      twoWeeks: twoWeeks.length,
      oneMonth: oneMonth.length,
    },
  };
}

export async function markReviewReminderDone(clientId, bucket) {
  const cid = String(clientId || '').trim();
  const b = String(bucket || '').trim();
  if (!cid || !['twoWeeks', 'oneMonth'].includes(b)) {
    throw new Error('clientId and bucket (twoWeeks|oneMonth) required');
  }
  const fp = String(process.env.GMB_REVIEW_TRACKING_JSON_PATH || '').trim() || DATA_PATH;
  const payload = await readGmbReviewTrackingPayload();
  if (!payload.generatedAt) {
    throw new Error('gmb-review-tracking.json not found — run rebuild first');
  }
  const doneReminders = { ...(payload.doneReminders || {}) };
  const prev = doneReminders[cid] && typeof doneReminders[cid] === 'object' ? doneReminders[cid] : {};
  doneReminders[cid] = {
    ...prev,
    [b]: new Date().toISOString(),
  };
  const raw = JSON.parse(await fsp.readFile(fp, 'utf8'));
  raw.doneReminders = doneReminders;
  await fsp.writeFile(fp, JSON.stringify(raw, null, 2), 'utf8');
  return { ok: true, clientId: cid, bucket: b, doneReminders: doneReminders[cid] };
}

function msUntilNextReviewTrackingCronUtc() {
  const utcH = Number(process.env.GMB_REVIEW_TRACKING_CRON_UTC_HOUR ?? 18);
  const utcM = Number(process.env.GMB_REVIEW_TRACKING_CRON_UTC_MINUTE ?? 30);
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcH, utcM, 0, 0));
  if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return Math.max(60_000, target.getTime() - now.getTime());
}

export async function runGmbReviewTrackingRebuildJob() {
  const outputPath = String(process.env.GMB_REVIEW_TRACKING_JSON_PATH || '').trim() || DATA_PATH;
  appendLog({ phase: 'started', ok: true, outputPath });
  try {
    const out = await buildAndWriteGmbReviewTrackingSnapshot(outputPath);
    appendLog({ phase: 'completed', ok: true, outputPath, summary: out?.summary || null });
    console.log('[GmbReviewTracking] completed —', outputPath, out?.summary || {});
    return { ok: true, outputPath, summary: out?.summary || null };
  } catch (e) {
    const msg = String(e?.message || e);
    appendLog({ phase: 'error', ok: false, outputPath, error: msg });
    console.error('[GmbReviewTracking] failed:', msg);
    return { ok: false, outputPath, error: msg };
  }
}

let _timer = null;

export function initGmbReviewTrackingCron() {
  const enabled = String(process.env.ENABLE_GMB_REVIEW_TRACKING_CRON ?? 'true').toLowerCase() !== 'false';
  if (!enabled) {
    console.log('[GmbReviewTracking] disabled (ENABLE_GMB_REVIEW_TRACKING_CRON=false)');
    return;
  }

  const scheduleNext = () => {
    const delay = msUntilNextReviewTrackingCronUtc();
    const next = new Date(Date.now() + delay);
    const h = Number(process.env.GMB_REVIEW_TRACKING_CRON_UTC_HOUR ?? 18);
    const m = String(Number(process.env.GMB_REVIEW_TRACKING_CRON_UTC_MINUTE ?? 30)).padStart(2, '0');
    console.log(`[GmbReviewTracking] next scan at ${next.toISOString()} (UTC ${h}:${m} ≈ 00:00 IST)`);
    _timer = setTimeout(async () => {
      _timer = null;
      await runGmbReviewTrackingRebuildJob();
      scheduleNext();
    }, delay);
  };

  if (String(process.env.GMB_REVIEW_TRACKING_RUN_ON_STARTUP ?? 'false').toLowerCase() === 'true') {
    void runGmbReviewTrackingRebuildJob();
  }
  scheduleNext();
}
