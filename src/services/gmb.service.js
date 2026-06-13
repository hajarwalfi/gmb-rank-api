import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { config } from '../config/index.js';
import { fetchCurrentMonthGmbClicks } from './googlePerformance.service.js';
import { syncActiveGmbFromSupabase } from './supabaseGmb.service.js';
import { rebuildKeywordCountCache } from './gmbKeywordCountCache.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SERVER_ROOT = path.resolve(__dirname, '../../');
const GMB_SNAPSHOT_PATH = path.join(SERVER_ROOT, 'data', 'gmb_connected_businesses.json');
const DEFAULT_JSON_MAX_AGE_MS = 36 * 60 * 60 * 1000; // 36 hours

let _dailySnapshotTimer = null;
let _snapshotRefreshInFlight = null;

/**
 * Uses parent repo config/gmb.js. Ensure GMB_* env vars are set (same as parent).
 */
function getGmbClient() {
  const parentGmbPath = path.resolve(__dirname, '../../../../config/gmb.js');
  return require(parentGmbPath);
}

/**
 * Fetch location full details (serviceArea, serviceItems, categories) from GMB.
 * @param {string} accountId - GMB account ID
 * @param {string} locationId - GMB location ID
 * @returns {Promise<{ title, categories, serviceArea, serviceItems, storefrontAddress }>}
 */
export async function getLocationFull(accountId, locationId) {
  const gmb = getGmbClient();
  const location = await gmb.getLocationFull(accountId, locationId);
  return {
    title: location.title,
    categories: location.categories,
    serviceArea: location.serviceArea,
    serviceItems: location.serviceItems,
    storefrontAddress: location.storefrontAddress,
  };
}

/**
 * List accounts (from parent GMB). Requires GMB_* env.
 */
export async function listAccounts() {
  const gmb = getGmbClient();
  if (typeof gmb.listAccounts === 'function') {
    return gmb.listAccounts();
  }
  return [];
}

/**
 * List locations for an account.
 */
export async function listLocations(accountId) {
  const gmb = getGmbClient();
  if (typeof gmb.listLocations === 'function') {
    return gmb.listLocations(accountId);
  }
  return [];
}

let _locationCache = null;
let _cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function normalizeLocationRow(loc = {}) {
  const accountId = String(loc.accountId || '').trim();
  const locationId = String(loc.locationId || '').trim();
  if (!accountId || !locationId) return null;
  return {
    accountId,
    locationId,
    locationIdShort: String(loc.locationIdShort || '').trim(),
    title: String(loc.title || loc.gmbName || '').trim() || 'Unnamed',
  };
}

function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function buildDiffMeta(previousRows = [], currentRows = [], previousMeta = null) {
  const prevSet = new Set(previousRows.map((r) => `${r.accountId}::${r.locationId}`));
  const currSet = new Set(currentRows.map((r) => `${r.accountId}::${r.locationId}`));

  const newLocationIds = [];
  const removedLocationIds = [];

  for (const id of currSet) {
    if (!prevSet.has(id)) newLocationIds.push(id);
  }
  for (const id of prevSet) {
    if (!currSet.has(id)) removedLocationIds.push(id);
  }

  const now = new Date();
  const weekKey = isoWeekKey(now);
  const previousWeekKey = String(previousMeta?.weekKey || '');
  const previousWeekAdded = Number(previousMeta?.weekAddedSoFar || 0);
  const previousTotal = previousRows.length;
  const currentTotal = currentRows.length;
  const newLocationsCount = newLocationIds.length;
  const removedLocationsCount = removedLocationIds.length;

  const weekStartBaselineTotal =
    previousWeekKey === weekKey
      ? Number(previousMeta?.weekStartBaselineTotal ?? previousTotal)
      : previousTotal;

  const weekAddedSoFar =
    previousWeekKey === weekKey
      ? Math.max(0, previousWeekAdded + newLocationsCount)
      : Math.max(0, currentTotal - weekStartBaselineTotal);

  return {
    runTimestamp: now.toISOString(),
    previousTotalLocations: previousTotal,
    newLocationsCount,
    removedLocationsCount,
    newLocationIds,
    removedLocationIds,
    weekKey,
    weekStartBaselineTotal,
    weekAddedSoFar,
  };
}

async function atomicWriteJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tempPath, filePath);
}

export async function readLocationsSnapshot() {
  try {
    const raw = await fs.readFile(GMB_SNAPSHOT_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const businesses = Array.isArray(parsed?.businesses)
      ? parsed.businesses.map(normalizeLocationRow).filter(Boolean)
      : [];
    return { parsed, businesses };
  } catch {
    return { parsed: null, businesses: [] };
  }
}

export async function readLocationsSnapshotMeta() {
  const { parsed } = await readLocationsSnapshot();
  return parsed?.meta || null;
}

/**
 * List ALL locations across ALL accounts — returns a flat array.
 * Used by the GMB Keyword Research dashboard dropdown.
 * Includes a memory cache to avoid 40-second fetch delays on every click.
 */
/**
 * @param {{ forceLive?: boolean }} [options] - `forceLive: true` skips snapshot shortcut (nightly cron refresh).
 */
export async function listAllLocationsLive(options = {}) {
  const forceLive = options.forceLive === true;
  const now = Date.now();
  if (!forceLive && _locationCache && (now - _cacheTime) < CACHE_TTL) {
    console.log(`[gmb listAllLocations] Returning cached results (${_locationCache.length} locations)`);
    return _locationCache;
  }

  if (!forceLive) {
    try {
      const { businesses } = await readLocationsSnapshot();
      const mapped = (businesses || []).map(normalizeLocationRow).filter(Boolean);
      if (mapped.length) {
        _locationCache = mapped;
        _cacheTime = Date.now();
        console.log(
          `[gmb listAllLocations] Loaded ${mapped.length} locations from snapshot file (no live Google API).`
        );
        return _locationCache;
      }
    } catch (e) {
      console.warn('[gmb listAllLocations] Could not read locations snapshot:', e?.message || e);
    }
  }

  const allowLiveFetch =
    forceLive ||
    String(process.env.GMB_ALLOW_LIVE_LOCATION_LIST_FETCH || '').toLowerCase() === 'true';

  if (!allowLiveFetch) {
    console.warn(
      '[gmb listAllLocations] Skipping live Google API fetch (use nightly snapshot or set GMB_ALLOW_LIVE_LOCATION_LIST_FETCH=true). Returning empty.'
    );
    _locationCache = [];
    _cacheTime = Date.now();
    return _locationCache;
  }

  console.log('[gmb listAllLocations] Starting full GMB API fetch (can take 30-60s)...');
  const accounts = await listAccounts();
  const results = [];
  
  for (const acc of accounts) {
    try {
      const locs = await listLocations(acc.accountId);
      console.log(`[gmb listAllLocations] Fetched ${locs.length} locations for ${acc.accountId}`);
      for (const loc of locs) {
        results.push({
          accountId: acc.accountId,            // "accounts/123"
          locationId: loc.locationId,          // "accounts/123/locations/456"
          locationIdShort: loc.locationIdShort, // "456"
          title: loc.name || 'Unnamed',
        });
      }
    } catch (e) {
      console.warn('[gmb listAllLocations] skipping account', acc.accountId, e.message);
    }
  }

  _locationCache = results;
  _cacheTime = Date.now();
  console.log(`[gmb listAllLocations] Fetch complete. Cached ${results.length} locations.`);
  return results;
}

export async function refreshLocationsSnapshotFromLiveApi(extra = {}) {
  const { parsed: previous, businesses: previousRows } = await readLocationsSnapshot();
  const currentRows = await listAllLocationsLive({ forceLive: true });
  const meta = buildDiffMeta(previousRows, currentRows, previous?.meta || null);

  const payload = {
    connectedGoogleEmail: extra.connectedGoogleEmail ?? previous?.connectedGoogleEmail ?? null,
    labeledAsEmail: extra.labeledAsEmail ?? previous?.labeledAsEmail ?? null,
    googleSubject: extra.googleSubject ?? previous?.googleSubject ?? null,
    emailResolvedFrom: extra.emailResolvedFrom ?? previous?.emailResolvedFrom ?? 'not_available',
    note: extra.note ?? previous?.note ?? null,
    totalLocations: currentRows.length,
    generatedAt: meta.runTimestamp,
    businesses: currentRows.map((row) => ({
      accountId: row.accountId,
      locationId: row.locationId,
      locationIdShort: row.locationIdShort,
      gmbName: row.title,
      title: row.title,
    })),
    meta,
  };
  await atomicWriteJson(GMB_SNAPSHOT_PATH, payload);
  return payload;
}

export async function listAllLocations(options = {}) {
  const {
    preferJson = true,
    allowLiveFallback = true,
    maxJsonAgeMs = DEFAULT_JSON_MAX_AGE_MS,
  } = options || {};

  const results = [];

  // 1. Load Supabase Sync GMBs (active-gmb.json) - GBP access only list.
  try {
    const { readActiveGmbJson } = await import('./supabaseGmb.service.js');
    const supabaseData = await readActiveGmbJson();
    const sourceRows = Array.isArray(supabaseData?.count)
      ? supabaseData.count
      : (Array.isArray(supabaseData?.active_gmb) ? supabaseData.active_gmb : []);
    if (sourceRows.length) {
      sourceRows.forEach(loc => {
        results.push({
          accountId: 'supabase',
          locationId: loc.id,
          locationIdShort: loc.id,
          title: loc.business_name,
          source: 'supabase'
        });
      });
    }
  } catch (err) {
    console.warn('[gmb listAllLocations] Could not load Supabase GMBs:', err.message);
  }

  // 2. Load Legacy Snapshot
  if (preferJson) {
    const { parsed, businesses } = await readLocationsSnapshot();
    const generatedAtMs = parsed?.generatedAt ? Date.parse(parsed.generatedAt) : 0;
    const jsonAgeMs = generatedAtMs ? Date.now() - generatedAtMs : Number.POSITIVE_INFINITY;
    const isFresh = Number.isFinite(jsonAgeMs) && jsonAgeMs <= maxJsonAgeMs;
    if (businesses.length && isFresh) {
      // Merge unique ones
      businesses.forEach(b => {
        if (!results.find(r => r.locationId === b.locationId)) {
          results.push(b);
        }
      });
    }
  }

  // 3. Live Fallback if needed
  if (allowLiveFallback && results.length === 0) {
    const live = await listAllLocationsLive();
    return live;
  }

  return results;
}

function next2amLocal(now = new Date()) {
  const next = new Date(now);
  next.setHours(2, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

export function startDailyGmbSnapshotCron() {
  if (_dailySnapshotTimer) return;
  const scheduleNext = () => {
    const next = next2amLocal(new Date());
    const delayMs = Math.max(1000, next.getTime() - Date.now());
    _dailySnapshotTimer = setTimeout(async () => {
      _dailySnapshotTimer = null;
      try {
        console.log('[gmb snapshot cron] Starting daily maintenance pipeline (2:00 AM)...');
        
        // 1. Refresh GMB Locations Snapshot
        if (!_snapshotRefreshInFlight) {
          _snapshotRefreshInFlight = refreshLocationsSnapshotFromLiveApi();
        }
        await _snapshotRefreshInFlight;
        console.log('[gmb snapshot cron] GMB locations refreshed.');

        // 2. Sync Active GMBs from Supabase (Categorizes Access/No-Access)
        const activePayload = await syncActiveGmbFromSupabase();
        console.log('[gmb snapshot cron] Supabase clients synced.');

        // 3. Rebuild paying+GBP services-keywords when new GBP-access clients appeared (incremental merge inside rebuild).
        const newGbpIds = Array.isArray(activePayload?.new_gbp_access_ids)
          ? activePayload.new_gbp_access_ids
          : [];
        if (newGbpIds.length) {
          await rebuildKeywordCountCache({});
          console.log(`[gmb snapshot cron] services-keywords rebuild ran after ${newGbpIds.length} new GBP client id(s).`);
        } else {
          console.log('[gmb snapshot cron] No new GBP clients — services-keywords rebuild skipped.');
        }

      } catch (e) {
        console.error('[gmb snapshot cron] Maintenance pipeline failed:', String(e?.message || e));
      } finally {
        _snapshotRefreshInFlight = null;
        scheduleNext();
      }
    }, delayMs);
    console.log(`[gmb snapshot cron] next live sync at ${next.toLocaleString()}`);
  };
  scheduleNext();
}

export function hasGmbConfig() {
  const { gmb } = config;
  return !!(gmb.clientId && gmb.clientSecret && gmb.refreshToken);
}

export async function getMonthlyClicks(accountId, locationId, options) {
  const opts = options || {};
  return fetchCurrentMonthGmbClicks(accountId, locationId, opts);
}
