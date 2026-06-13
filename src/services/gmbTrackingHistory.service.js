import fs from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomUUID } from 'crypto';
import { generateNextScanId, saveToHistory } from './historyManager.js';
import { fetchGmbRealMetrics } from './googlePerformance.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../../');
const TRACKING_DIR = path.join(SERVER_ROOT, 'rank_history', 'tracking');
const GMB_SNAPSHOT_PATH = path.join(SERVER_ROOT, 'data', 'gmb_connected_businesses.json');

let _snapshotCacheForNormalization = null;
function getGmbSnapshotForNormalization() {
  if (_snapshotCacheForNormalization) return _snapshotCacheForNormalization;
  try {
    const raw = readFileSync(GMB_SNAPSHOT_PATH, 'utf8');
    _snapshotCacheForNormalization = JSON.parse(raw);
    return _snapshotCacheForNormalization;
  } catch (e) {
    return null;
  }
}

function normalizeIds(locationId, businessName, accountId = null) {
  let lid = String(locationId || '').trim();
  let aid = String(accountId || '').trim();

  // If it's a UUID (Supabase ID), try to resolve it to a Google Location ID using the cached snapshot
  if (lid && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(lid)) {
    const snap = getGmbSnapshotForNormalization();
    if (snap && Array.isArray(snap.businesses)) {
      const nameNorm = String(businessName || '').trim().toLowerCase();
      // 1. Try exact name match
      let found = snap.businesses.find(
        (b) => String(b.title || b.gmbName || '').trim().toLowerCase() === nameNorm
      );

      // 2. Try partial match if exact fails
      if (!found && nameNorm) {
        found = snap.businesses.find(b => {
          const t = String(b.title || b.gmbName || '').trim().toLowerCase();
          return t.includes(nameNorm) || nameNorm.includes(t);
        });
      }

      if (found) {
        console.log(`[Normalization] Resolved UUID ${lid} to Google ID ${found.locationId} (${found.title})`);
        if (found.locationId) lid = found.locationId;
        if (found.accountId) aid = found.accountId;
      } else {
        console.warn(`[Normalization] Could not find Google ID for UUID ${lid} (Name: "${businessName}") in snapshot.`);
      }
    }
  }
  return { locationId: lid, accountId: aid };
}

function resolveBaseUrl(rawValue, fallback = '') {
  const candidates = String(rawValue || '')
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!candidates.length) return String(fallback || '').replace(/\/+$/, '');
  const firstValid = candidates.find((x) => /^https?:\/\//i.test(x)) || candidates[0];
  return firstValid.replace(/\/+$/, '');
}

function getApiBase() {
  return resolveBaseUrl(
    process.env.RANK_HISTORY_API_BASE_URL,
    `http://localhost:${process.env.PORT || 5524}`
  );
}

function getFrontendBase() {
  return resolveBaseUrl(process.env.RANK_HISTORY_FRONTEND_BASE_URL, '');
}

export function makeGmbKey(locationId, businessName) {
  const { locationId: lid } = normalizeIds(locationId, businessName);

  if (lid) {
    // Force consistent short ID format (remove "locations/" prefix)
    // so manual and auto runs use the same history JSON.
    const shortId = lid.split('/').filter(Boolean).pop();
    return `loc:${shortId}`;
  }
  const n = String(businessName || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!n) return 'name:unknown';
  return `name:${n}`;
}

function trackingFilePath(gmbKey) {
  const h = createHash('sha256').update(gmbKey).digest('hex');
  return path.join(TRACKING_DIR, `${h}.json`);
}

export function toScreenshotLiveUrl(screenshotPath, apiBase = getApiBase()) {
  const rel = String(screenshotPath || '').trim().replace(/^\/+/, '');
  if (!rel) return null;
  if (/^https?:\/\//i.test(rel)) return rel;
  return `${apiBase}/api/outputs/${rel}`;
}

function isLoopbackOrigin(urlStr) {
  try {
    const u = new URL(String(urlStr).trim());
    const h = (u.hostname || '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return /localhost|127\.0\.0\.1/i.test(String(urlStr || ''));
  }
}

/**
 * For links returned to the browser (compare page, etc.): prefer a non-loopback origin from
 * RANK_HISTORY_API_BASE_URL when it uses "local||live" so production JSON saved with localhost
 * still opens images on http://localhost:5524 (or whatever is listed).
 */
export function getPublicApiBaseForLinks() {
  const raw = String(process.env.RANK_HISTORY_API_BASE_URL || '').trim();
  const parts = raw.split('||').map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (!/^https?:\/\//i.test(p)) continue;
    if (!isLoopbackOrigin(p)) return p.replace(/\/+$/, '');
  }
  return getApiBase();
}

/**
 * Normalize a stored screenshot URL or path for the current deployment's public API host.
 */
export function publicScreenshotUrl(storedUrl, storedPath) {
  const base = getPublicApiBaseForLinks();
  const u = String(storedUrl || '').trim();
  const marker = '/api/outputs/';
  if (u.includes(marker)) {
    const i = u.indexOf(marker);
    return `${base}${u.slice(i)}`;
  }
  const rel = String(storedPath || '').trim().replace(/^\/+/, '');
  if (!rel) return null;
  if (/^https?:\/\//i.test(rel)) {
    if (rel.includes(marker)) {
      const j = rel.indexOf(marker);
      return `${base}${rel.slice(j)}`;
    }
    return rel;
  }
  return `${base}/api/outputs/${rel}`;
}

/**
 * Public gallery page host from RANK_HISTORY_FRONTEND_BASE_URL (non-loopback first when using local||live).
 */
export function getPublicFrontendBaseForLinks() {
  const raw = String(process.env.RANK_HISTORY_FRONTEND_BASE_URL || '').trim();
  const parts = raw.split('||').map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (!/^https?:\/\//i.test(p)) continue;
    if (!isLoopbackOrigin(p)) return p.replace(/\/+$/, '');
  }
  const fb = getFrontendBase();
  return fb ? String(fb).replace(/\/+$/, '') : '';
}

/**
 * Tracking JSON snapshots[].galleryUrl (and galleryPublicId) → href for gallery view.
 */
export function publicGalleryUrl(storedUrl, galleryPublicId) {
  const base = getPublicFrontendBaseForLinks();
  const id = String(galleryPublicId || '').trim();
  const u = String(storedUrl || '').trim();
  const marker = '/gmb-keyword-gallery/';
  let pathFromRoot = '';
  if (u.includes(marker)) {
    pathFromRoot = u.slice(u.indexOf(marker));
  } else if (id) {
    pathFromRoot = `${marker}${id}`;
  } else {
    return null;
  }
  if (!pathFromRoot.startsWith('/')) pathFromRoot = `/${pathFromRoot}`;
  if (!base) {
    if (/^https?:\/\//i.test(u)) return u;
    return null;
  }
  return `${base}${pathFromRoot}`;
}

function normalizeKeyword(k) {
  return String(k || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeRawTrafficData(raw) {
  if (!raw || typeof raw !== 'object') return raw ?? null;
  const out = { ...raw };
  const rows = Array.isArray(out.daily_breakdown_desc) ? out.daily_breakdown_desc : null;
  if (!rows) return out;

  const normalized = rows.map((r) => ({
    date: String(r?.date || ''),
    overview: Number(r?.overview || 0),
    calls: Number(r?.calls || 0),
    chat_clicks: Number(r?.chat_clicks || 0),
    website_clicks: Number(r?.website_clicks || 0),
  }));

  // Sort latest -> oldest by date string (YYYY-MM-DD)
  normalized.sort((a, b) => (a.date < b.date ? 1 : -1));

  // Trim latest contiguous all-zero rows (common for delayed GBP processing windows).
  let start = 0;
  while (start < normalized.length) {
    const x = normalized[start];
    const sum = x.overview + x.calls + x.chat_clicks + x.website_clicks;
    if (sum > 0) break;
    start += 1;
  }
  const trimmed = normalized.slice(start);

  const monthly = trimmed.reduce(
    (acc, d) => {
      acc.overview += Number(d.overview || 0);
      acc.calls += Number(d.calls || 0);
      acc.chat_clicks += Number(d.chat_clicks || 0);
      acc.website_clicks += Number(d.website_clicks || 0);
      return acc;
    },
    { overview: 0, calls: 0, chat_clicks: 0, website_clicks: 0 }
  );

  out.daily_breakdown_desc = trimmed;
  out.monthly_totals = monthly;
  out.overview_clicks = monthly.overview;
  out.total_clicks = monthly.overview;
  out.call_clicks = monthly.calls;
  out.chat_clicks = monthly.chat_clicks;
  out.website_clicks = monthly.website_clicks;
  out.reporting_days = trimmed.length;
  out.daysElapsed = trimmed.length;
  out.monthEnd = trimmed.length ? trimmed[0].date : null;

  return out;
}

export async function readTracking(gmbKey) {
  const fp = trackingFilePath(gmbKey);
  try {
    const raw = await fs.readFile(fp, 'utf8');
    const doc = JSON.parse(raw);
    if (!doc.snapshots) doc.snapshots = [];
    if (!doc.scans) doc.scans = [];
    return doc;
  } catch {
    return null;
  }
}

async function writeTracking(doc) {
  await fs.mkdir(TRACKING_DIR, { recursive: true });
  const fp = trackingFilePath(doc.gmbKey);
  doc.updatedAt = new Date().toISOString();
  await fs.writeFile(fp, JSON.stringify(doc, null, 2), 'utf8');
  return fp;
}

/**
 * Upsert traffic fields for a keyword item inside tracking JSON.
 * - Finds snapshot by `snapshotId` if provided; otherwise scans from newest → oldest.
 * - Finds keyword item by normalized keyword match.
 * - Writes back the updated tracking JSON.
 */
export async function upsertTrackingItemTraffic({
  gmbKey,
  snapshotId = '',
  keyword,
  patch = {},
}) {
  const k = String(keyword || '').trim();
  if (!gmbKey || !k) return { ok: false, reason: 'missing_params' };

  const doc = await readTracking(gmbKey);
  if (!doc) return { ok: false, reason: 'not_found' };

  const norm = normalizeKeyword(k);
  const snaps = Array.isArray(doc.snapshots) ? doc.snapshots : [];
  if (!snaps.length) return { ok: false, reason: 'no_snapshots' };

  const pickSnapshots = (() => {
    const sid = String(snapshotId || '').trim();
    if (!sid) return [...snaps].reverse();
    const one = snaps.find((s) => String(s?.id || '').trim() === sid);
    return one ? [one] : [];
  })();

  if (!pickSnapshots.length) return { ok: false, reason: 'snapshot_not_found' };

  let updated = false;
  let updatedSnapshotId = null;

  for (const snap of pickSnapshots) {
    const items = Array.isArray(snap?.items) ? snap.items : [];
    if (!items.length) continue;
    const idx = items.findIndex((it) => normalizeKeyword(it?.keyword) === norm);
    if (idx < 0) continue;

    const prev = items[idx] || {};
    const next = {
      // keep original fields (and order) first
      keyword: prev.keyword,
      rank: prev.rank ?? null,
      page: prev.page ?? null,
      screenshotPath: prev.screenshotPath ?? null,
      screenshotUrl: prev.screenshotUrl ?? null,

      // then traffic fields (requested: after screenshotUrl)
      target_keyword:
        typeof patch.target_keyword === 'string' && patch.target_keyword.trim()
          ? patch.target_keyword.trim()
          : (prev.target_keyword || prev.keyword),
      source_month:
        typeof patch.source_month === 'string' && patch.source_month.trim()
          ? patch.source_month.trim()
          : (prev.source_month ?? null),
      volume: Number.isFinite(Number(patch.volume)) ? Number(patch.volume) : (Number(prev.volume) || 0),
      daily_traffic: Number.isFinite(Number(patch.daily_traffic))
        ? Number(patch.daily_traffic)
        : (Number(prev.daily_traffic) || 0),
      estimated_clicks: Number.isFinite(Number(patch.estimated_clicks))
        ? Number(patch.estimated_clicks)
        : (Number(prev.estimated_clicks) || 0),
      raw_traffic_data: normalizeRawTrafficData(patch.raw_traffic_data ?? prev.raw_traffic_data ?? null),
    };

    snap.items[idx] = next;
    updated = true;
    updatedSnapshotId = snap.id || null;
    break;
  }

  if (!updated) return { ok: false, reason: 'keyword_not_found_in_snapshots' };
  const fp = await writeTracking(doc);
  return { ok: true, filePath: fp, snapshotId: updatedSnapshotId };
}

export async function appendSnapshot({
  gmbKey,
  businessName = '',
  accountId = '',
  locationId = '',
  source,
  galleryPublicId = null,
  galleryUrl = null,
  savedAt,
  items = [],
}) {
  const existing =
    (await readTracking(gmbKey)) || {
      gmbKey,
      business_id: gmbKey, // Legacy compatibility
      businessName: String(businessName || ''),
      locationId: String(locationId || ''),
      accountId: String(accountId || ''),
      snapshots: [],
      scans: [],
    };

  if (String(businessName || '').trim()) existing.businessName = String(businessName).trim();
  if (String(accountId || '').trim()) existing.accountId = String(accountId).trim();
  if (String(locationId || '').trim()) existing.locationId = String(locationId).trim();

  const normalizedSource = (() => {
    const s = String(source || '').trim().toLowerCase();
    if (s === 'cron') return 'cron';
    if (s === 'automation') return 'automation';
    return 'manual';
  })();

  const snapshot = {
    id: randomUUID(),
    savedAt: savedAt || new Date().toISOString(),
    source: normalizedSource,
    galleryPublicId: galleryPublicId || null,
    galleryUrl: galleryUrl || null,
    items: Array.isArray(items) ? items : [],
  };

  existing.snapshots.push(snapshot);

  let historySaved = false;
  let historySaveError = null;
  // --- MIRROR TO LEGACY HISTORY SCHEMA (inline to use the same file) ---
  try {
    const { locationId: realLid, accountId: realAid } = normalizeIds(
      locationId || existing.locationId,
      businessName || existing.businessName,
      accountId || existing.accountId
    );

    let realMetrics = { traffic: {}, reviews: {} };
    if (realAid && realLid) {
      try {
        realMetrics = await fetchGmbRealMetrics(
          realAid,
          realLid,
          businessName || existing.businessName
        );
      } catch (metricsErr) {
        console.warn(
          `[TrackingService] fetchGmbRealMetrics failed for ${gmbKey} (using zero metrics, still saving data/history):`,
          metricsErr.message
        );
      }
    }

    const mapRanksList = (Array.isArray(items) ? items : []).map(tItem => {
      const vol = Number(tItem.volume) || 0;
      let daysInMonth = 30;
      if (tItem.source_month && tItem.source_month.includes('/')) {
        const parts = tItem.source_month.split('/');
        const m = Number(parts[0]);
        const y = Number(parts[1]);
        if (m && y) daysInMonth = new Date(y, m, 0).getDate();
      }

      return {
        keyword: tItem.keyword || 'unknown',
        target_keyword: tItem.target_keyword || tItem.keyword,
        source_month: tItem.source_month || 'N/A',
        rank: typeof tItem.rank === 'number' ? tItem.rank : null,
        volume: vol,
        daily_traffic: tItem.daily_traffic || (Math.round((tItem.estimated_clicks || 0) / daysInMonth * 10) / 10),
        estimated_clicks: tItem.estimated_clicks || 0,
        screenshot_url: tItem.screenshotUrl || null,
        raw_traffic_data: tItem.raw_traffic_data || null
      };
    });

    const estimatedMonthly = mapRanksList.reduce((sum, r) => sum + (r.estimated_clicks || 0), 0);

    const newScan = {
      scan_id: generateNextScanId(existing.scans || []),
      scanned_at: snapshot.savedAt,
      traffic: {
        website_clicks: realMetrics.traffic?.website_clicks ?? 0,
        direction_requests: realMetrics.traffic?.direction_requests ?? 0,
        calls: realMetrics.traffic?.calls ?? 0,
        impressions: realMetrics.traffic?.impressions ?? 0,
        estimated_monthly_clicks: Math.round(estimatedMonthly),
        estimated_daily_clicks: Math.round(estimatedMonthly / 30 * 10) / 10
      },
      reviews: {
        total_count: realMetrics.reviews?.total_count ?? 0,
        average_rating: realMetrics.reviews?.average_rating ?? 0,
        new_since_last_scan: realMetrics.reviews?.new_since_last_scan ?? 0
      },
      map_ranks: mapRanksList,
      screenshot_url: items[0]?.screenshotUrl || galleryUrl || null
    };

    if (!Array.isArray(existing.scans)) existing.scans = [];
    existing.scans.push(newScan);
    // Sort legacy scans descending (latest first)
    existing.scans.sort((a, b) => new Date(b.scanned_at || 0) - new Date(a.scanned_at || 0));
    existing.latest_scan = existing.scans[0];
    existing.total_scans = existing.scans.length;

    // Also mirror into legacy `server/data/history` JSON store so both paths remain in sync.
    await saveToHistory(
      gmbKey,
      businessName || existing.businessName,
      realLid || locationId || existing.locationId || '',
      {
        scanned_at: snapshot.savedAt,
        traffic: newScan.traffic,
        reviews: newScan.reviews,
        map_ranks: mapRanksList,
        screenshot_url: newScan.screenshot_url,
      }
    );
    historySaved = true;

    console.log(`[TrackingService] Successfully mirrored snapshot to legacy scans + data/history for ${gmbKey}`);
  } catch (mirrorErr) {
    historySaveError = String(mirrorErr?.message || mirrorErr || 'unknown_mirror_error');
    console.error('[TrackingService] Mirroring to legacy history failed (non-fatal):', mirrorErr.message);
    // Fallback: still persist minimal history so data/history does not lag behind tracking.
    try {
      const { locationId: fallbackLid } = normalizeIds(
        locationId || existing.locationId,
        businessName || existing.businessName,
        accountId || existing.accountId
      );
      const fallbackMapRanks = (Array.isArray(items) ? items : []).map((tItem) => ({
        keyword: tItem.keyword || 'unknown',
        target_keyword: tItem.target_keyword || tItem.keyword || 'unknown',
        source_month: tItem.source_month || null,
        rank: typeof tItem.rank === 'number' ? tItem.rank : null,
        volume: Number(tItem.volume) || 0,
        daily_traffic: Number(tItem.daily_traffic) || 0,
        estimated_clicks: Number(tItem.estimated_clicks) || 0,
        screenshot_url: tItem.screenshotUrl || null,
        raw_traffic_data: tItem.raw_traffic_data || null,
      }));
      await saveToHistory(
        gmbKey,
        businessName || existing.businessName,
        fallbackLid || locationId || existing.locationId || '',
        {
          scanned_at: snapshot.savedAt,
          traffic: {
            website_clicks: 0,
            direction_requests: 0,
            calls: 0,
            impressions: 0,
          },
          reviews: {
            total_count: 0,
            average_rating: 0,
            new_since_last_scan: 0,
          },
          map_ranks: fallbackMapRanks,
          screenshot_url: items[0]?.screenshotUrl || galleryUrl || null,
        }
      );
      historySaved = true;
      historySaveError = null;
      console.warn(`[TrackingService] Fallback data/history save succeeded for ${gmbKey}`);
    } catch (fallbackErr) {
      historySaveError = `${historySaveError}; fallback_failed:${String(fallbackErr?.message || fallbackErr)}`;
      console.error('[TrackingService] Fallback data/history save failed:', fallbackErr.message);
    }
  }

  const fp = await writeTracking(existing);

  return {
    filePath: fp,
    snapshot,
    snapshotCount: existing.snapshots.length,
    doc: existing,
    historySaved,
    historySaveError,
  };
}

export async function listTrackedLocations() {
  await fs.mkdir(TRACKING_DIR, { recursive: true });
  const names = await fs.readdir(TRACKING_DIR);
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(TRACKING_DIR, name), 'utf8');
      const data = JSON.parse(raw);
      if (!data?.gmbKey) continue;
      const n = Array.isArray(data.snapshots) ? data.snapshots.length : 0;
      out.push({
        gmbKey: data.gmbKey,
        businessName: data.businessName || '',
        accountId: data.accountId || '',
        locationId: data.locationId || '',
        snapshotCount: n,
        canCompare: n >= 2,
      });
    } catch {
      /* skip bad file */
    }
  }
  out.sort((a, b) => String(a.businessName).localeCompare(String(b.businessName)));
  return out;
}

export async function getAllTrackingRows() {
  await fs.mkdir(TRACKING_DIR, { recursive: true });
  const names = await fs.readdir(TRACKING_DIR);
  const rows = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(TRACKING_DIR, name), 'utf8');
      const data = JSON.parse(raw);
      if (!data?.gmbKey || !Array.isArray(data.snapshots)) continue;

      for (const snap of data.snapshots) {
        const savedAt = snap.savedAt || null;
        const source = snap.source || 'manual';
        const items = Array.isArray(snap.items) ? snap.items : [];
        for (const item of items) {
          rows.push({
            businessName: data.businessName || '',
            gmbKey: data.gmbKey,
            keyword: item.keyword,
            rank: item.rank,
            savedAt,
            source,
            screenshotUrl: publicScreenshotUrl(item.screenshotUrl, item.screenshotPath),
            galleryUrl: publicGalleryUrl(snap.galleryUrl, snap.galleryPublicId),
          });
        }
      }
    } catch {
      /* skip bad file */
    }
  }
  // Sort by date desc
  rows.sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0));
  return rows;
}

function parseEpoch(v) {
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function buildCompareRows(doc, options = {}) {
  const snaps = Array.isArray(doc?.snapshots) ? doc.snapshots : [];
  if (snaps.length < 2) {
    return { ok: false, message: 'Need at least two saved runs to compare (run Search All + save again, or wait for another cron run).' };
  }
  const snapshotOptions = snaps
    .map((s, i) => ({
      id: s?.id || `idx-${i}`,
      savedAt: s?.savedAt || null,
      source: s?.source || 'manual',
      itemCount: Array.isArray(s?.items) ? s.items.length : 0,
      sortAt: parseEpoch(s?.savedAt),
    }))
    .sort((a, b) => b.sortAt - a.sortAt);

  const olderSnapshotId = String(options?.olderSnapshotId || '').trim();
  const latestSnapshotId = String(options?.latestSnapshotId || '').trim();

  let older = snaps[snaps.length - 2];
  let latest = snaps[snaps.length - 1];
  let usingCustomSelection = false;

  if (olderSnapshotId && latestSnapshotId && olderSnapshotId !== latestSnapshotId) {
    const oldCandidate = snaps.find((s, i) => (s?.id || `idx-${i}`) === olderSnapshotId);
    const newCandidate = snaps.find((s, i) => (s?.id || `idx-${i}`) === latestSnapshotId);
    if (oldCandidate && newCandidate) {
      const oldTs = parseEpoch(oldCandidate.savedAt);
      const newTs = parseEpoch(newCandidate.savedAt);
      if (oldTs <= newTs) {
        older = oldCandidate;
        latest = newCandidate;
      } else {
        older = newCandidate;
        latest = oldCandidate;
      }
      usingCustomSelection = true;
    }
  }

  const oldMap = new Map();
  for (const row of older.items || []) {
    const key = normalizeKeyword(row.keyword);
    if (!key) continue;
    oldMap.set(key, row);
  }

  const rows = [];
  for (const row of latest.items || []) {
    const key = normalizeKeyword(row.keyword);
    if (!key) continue;
    const prev = oldMap.get(key);
    if (!prev) continue;

    const oldRank = prev.rank != null && Number.isFinite(Number(prev.rank)) ? Number(prev.rank) : null;
    const newRank = row.rank != null && Number.isFinite(Number(row.rank)) ? Number(row.rank) : null;

    let message = '';
    let trend = 'neutral';
    if (oldRank != null && newRank != null) {
      if (newRank < oldRank) {
        trend = 'improved';
        message = 'Great work — rank improved (lower is better on Google).';
      } else if (newRank > oldRank) {
        trend = 'worse';
        message = 'Needs attention — rank moved down; keep optimizing listings and relevance.';
      } else {
        trend = 'same';
        message = 'Steady — same rank as last saved run.';
      }
    } else if (newRank != null && oldRank == null) {
      trend = 'neutral';
      message = 'New visibility — no rank in the older snapshot to compare.';
    } else if (newRank == null && oldRank != null) {
      trend = 'worse';
      message = 'Latest run has no rank for this keyword — worth investigating.';
    } else {
      message = 'Not enough rank data to compare.';
    }

    rows.push({
      keyword: row.keyword,
      oldRank,
      newRank,
      oldScreenshotUrl: publicScreenshotUrl(prev.screenshotUrl, prev.screenshotPath),
      newScreenshotUrl: publicScreenshotUrl(row.screenshotUrl, row.screenshotPath),
      oldGalleryUrl: publicGalleryUrl(older.galleryUrl, older.galleryPublicId),
      newGalleryUrl: publicGalleryUrl(latest.galleryUrl, latest.galleryPublicId),
      message,
      trend,
    });
  }

  const olderPublic = publicGalleryUrl(older.galleryUrl, older.galleryPublicId);
  const latestPublic = publicGalleryUrl(latest.galleryUrl, latest.galleryPublicId);

  return {
    ok: true,
    businessName: doc.businessName || '',
    gmbKey: doc.gmbKey,
    usingCustomSelection,
    selectedOlderSnapshotId: older.id || null,
    selectedLatestSnapshotId: latest.id || null,
    olderSavedAt: older.savedAt,
    latestSavedAt: latest.savedAt,
    olderSource: older.source,
    latestSource: latest.source,
    olderGalleryUrl: olderPublic,
    latestGalleryUrl: latestPublic,
    olderGalleryUrlFromJson: older.galleryUrl || null,
    latestGalleryUrlFromJson: latest.galleryUrl || null,
    olderGalleryPublicId: older.galleryPublicId || null,
    latestGalleryPublicId: latest.galleryPublicId || null,
    snapshotOptions: snapshotOptions.map((x) => ({
      id: x.id,
      savedAt: x.savedAt,
      source: x.source,
      itemCount: x.itemCount,
    })),
    rows,
  };
}

export function galleryItemsFromDoc(doc, apiBase = getApiBase()) {
  const items = [];
  for (const row of doc.items || []) {
    const keyword = typeof row.keyword === 'string' ? row.keyword.trim() : '';
    if (!keyword) continue;
    const vol = row.volume != null && Number.isFinite(Number(row.volume)) ? Number(row.volume) : 0;
    const daily =
      row.daily_traffic != null && Number.isFinite(Number(row.daily_traffic))
        ? Number(row.daily_traffic)
        : (row.dailyAverage != null && Number.isFinite(Number(row.dailyAverage)) ? Number(row.dailyAverage) : 0);
    items.push({
      keyword,
      rank: row.rank != null && Number.isFinite(Number(row.rank)) ? Number(row.rank) : null,
      page: row.page != null && Number.isFinite(Number(row.page)) ? Number(row.page) : null,
      screenshotPath: row.screenshotPath || null,
      screenshotUrl: toScreenshotLiveUrl(row.screenshotPath, apiBase),

      // Persist traffic fields (so tracking JSON + history charts have real demand data)
      target_keyword: typeof row.target_keyword === 'string' && row.target_keyword.trim() ? row.target_keyword.trim() : keyword,
      source_month: typeof row.source_month === 'string' ? row.source_month : null,
      volume: vol,
      daily_traffic: daily,
      estimated_clicks:
        row.estimated_clicks != null && Number.isFinite(Number(row.estimated_clicks))
          ? Number(row.estimated_clicks)
          : 0,
      raw_traffic_data: normalizeRawTrafficData(row.raw_traffic_data || row.raw || null),
    });
  }
  return items;
}

export function defaultGalleryPageUrl(publicId) {
  const fe = getFrontendBase();
  const id = String(publicId || '').trim();
  if (!id) return null;
  if (fe) return `${fe}/gmb-keyword-gallery/${id}`;
  return `${getApiBase()}/gmb-keyword-gallery/${id}`;
}

/**
 * After hourly pilot finishes — same JSON tracking as manual (no confirm).
 */
export async function appendSnapshotFromPilotPayload(basePayload, startedAt) {
  const loc = basePayload?.gmbLocation;
  if (!loc || !String(loc.title || '').trim()) return { skipped: true, reason: 'no_location' };

  const keywords = Array.isArray(basePayload.keywords) ? basePayload.keywords : [];
  const items = keywords
    .filter((k) => String(k.screenshotPath || '').trim())
    .map((k) => ({
      keyword: k.keyword,
      rank: k.rank != null && Number.isFinite(Number(k.rank)) ? Number(k.rank) : null,
      page: k.page != null && Number.isFinite(Number(k.page)) ? Number(k.page) : null,
      screenshotPath: k.screenshotPath || null,
      screenshotUrl:
        k.screenshotLivePath || toScreenshotLiveUrl(k.screenshotPath),
    }));
  if (!items.length) return { skipped: true, reason: 'no_screenshots' };

  const gal = basePayload.gallery || {};
  const gmbKey = makeGmbKey(loc.locationId, loc.title);

  return appendSnapshot({
    gmbKey,
    businessName: loc.title,
    accountId: loc.accountId || '',
    locationId: loc.locationId || '',
    source: 'cron',
    galleryPublicId: gal.publicId || null,
    galleryUrl: gal.link || null,
    savedAt: (startedAt instanceof Date ? startedAt : new Date(startedAt)).toISOString(),
    items,
  });
}

/**
 * One-time automation run snapshot append:
 * - Prefer rows with screenshots (same behavior as pilot/manual gallery-based tracking)
 * - Fallback: if no screenshots, keep rank-found rows so automation progress still lands in tracking JSON.
 */
export async function appendSnapshotFromAutomationPayload(basePayload, startedAt) {
  const loc = basePayload?.gmbLocation;
  if (!loc || !String(loc.title || '').trim()) return { skipped: true, reason: 'no_location' };

  const keywords = Array.isArray(basePayload.keywords) ? basePayload.keywords : [];
  const withScreenshots = keywords
    .filter((k) => String(k.screenshotPath || '').trim())
    .map((k) => ({
      keyword: k.keyword,
      rank: k.rank != null && Number.isFinite(Number(k.rank)) ? Number(k.rank) : null,
      page: k.page != null && Number.isFinite(Number(k.page)) ? Number(k.page) : null,
      screenshotPath: k.screenshotPath || null,
      screenshotUrl: k.screenshotLivePath || toScreenshotLiveUrl(k.screenshotPath),
      // Traffic fields
      target_keyword: k.target_keyword || k.keyword,
      source_month: k.source_month || null,
      volume: Number(k.volume) || 0,
      estimated_clicks: Number(k.estimated_clicks) || 0,
      daily_traffic: Number(k.daily_traffic) || 0,
      raw_traffic_data: normalizeRawTrafficData(k.raw_traffic_data || null),
    }));

  const rankOnlyFallback = keywords
    .filter((k) => k.rank != null && Number.isFinite(Number(k.rank)))
    .map((k) => ({
      keyword: k.keyword,
      rank: Number(k.rank),
      page: k.page != null && Number.isFinite(Number(k.page)) ? Number(k.page) : null,
      screenshotPath: k.screenshotPath || null,
      screenshotUrl: k.screenshotLivePath || toScreenshotLiveUrl(k.screenshotPath),
      // Traffic fields
      target_keyword: k.target_keyword || k.keyword,
      source_month: k.source_month || null,
      volume: Number(k.volume) || 0,
      estimated_clicks: Number(k.estimated_clicks) || 0,
      daily_traffic: Number(k.daily_traffic) || 0,
      raw_traffic_data: normalizeRawTrafficData(k.raw_traffic_data || null),
    }));

  const items = withScreenshots.length ? withScreenshots : rankOnlyFallback;

  const gal = basePayload.gallery || {};
  const gmbKey = makeGmbKey(loc.locationId, loc.title);

  return appendSnapshot({
    gmbKey,
    businessName: loc.title,
    accountId: loc.accountId || '',
    locationId: loc.locationId || '',
    source: 'automation',
    galleryPublicId: gal.publicId || null,
    galleryUrl: gal.link || null,
    savedAt: (startedAt instanceof Date ? startedAt : new Date(startedAt)).toISOString(),
    items,
  });
}
