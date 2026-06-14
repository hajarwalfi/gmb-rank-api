import axios from 'axios';
import { config } from '../config/index.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SERVER_ROOT = path.resolve(__dirname, '../../');
const GMB_SNAPSHOT_PATH = path.join(SERVER_ROOT, 'data', 'gmb_connected_businesses.json');
const ACTIVE_GMB_PATH = path.join(SERVER_ROOT, 'data', 'active-gmb.json');
const PARENT_GMB_PATH = path.resolve(__dirname, '../../config/gmb.js');

let cachedToken = null;
let tokenExpiry = 0;
let _snapshotCacheForNormalization = null;
let _activeGmbByClientId = null;
const _lastPerfApi403LogAt = new Map();

function getGmbSnapshotForNormalization() {
  if (_snapshotCacheForNormalization) return _snapshotCacheForNormalization;
  try {
    const raw = fs.readFileSync(GMB_SNAPSHOT_PATH, 'utf8');
    _snapshotCacheForNormalization = JSON.parse(raw);
    return _snapshotCacheForNormalization;
  } catch (e) {
    return null;
  }
}

/**
 * active-gmb.json: Supabase client id → business_name + has_gbp_access (from nightly export).
 */
function getActiveGmbIndex() {
  if (_activeGmbByClientId) return _activeGmbByClientId;
  _activeGmbByClientId = new Map();
  try {
    const raw = fs.readFileSync(ACTIVE_GMB_PATH, 'utf8');
    const j = JSON.parse(raw);
    const rows = Array.isArray(j.active_gmb) ? j.active_gmb : [];
    for (const row of rows) {
      const id = row?.id && String(row.id).trim();
      if (!id) continue;
      _activeGmbByClientId.set(id.toLowerCase(), {
        business_name: row.business_name ? String(row.business_name).trim() : null,
        has_gbp_access: row.has_gbp_access === true,
      });
    }
  } catch (_) {
    /* missing file — leave map empty */
  }
  return _activeGmbByClientId;
}

function getActiveGmbRowForClientUuid(uuid) {
  if (!uuid) return null;
  return getActiveGmbIndex().get(String(uuid).trim().toLowerCase()) || null;
}

/**
 * `undefined` = client not listed in active-gmb.json (caller should still try APIs).
 * `true` / `false` = explicit flag from export.
 */
function getGbpAccessFlagForClientUuid(uuid) {
  const row = getActiveGmbRowForClientUuid(uuid);
  if (!row) return undefined;
  return row.has_gbp_access === true;
}

function resolveAccountFromSnapshotByShortLocation(shortLocId) {
  const want = String(shortLocId || '').replace(/^locations\//i, '').trim();
  if (!want) return null;
  const snap = getGmbSnapshotForNormalization();
  if (!snap?.businesses) return null;
  const found = snap.businesses.find((b) => {
    const sh = String(b.locationIdShort || '').replace(/^locations\//i, '').trim();
    const full = String(b.locationId || '');
    return sh === want || full === `locations/${want}` || full.endsWith(`/locations/${want}`);
  });
  return found?.accountId ? String(found.accountId).trim() : null;
}

function loadParentGmbClient() {
  return require(PARENT_GMB_PATH);
}

/** Calendar month-to-date day count in UTC (aligned with fetchCurrentMonthGmbClicks month window). */
function daysMonthToDateUtc(nowDate, monthStartUtc) {
  if (
    nowDate.getUTCFullYear() !== monthStartUtc.getUTCFullYear() ||
    nowDate.getUTCMonth() !== monthStartUtc.getUTCMonth()
  ) {
    return Math.max(1, Math.ceil((nowDate.getTime() - monthStartUtc.getTime()) / 86400000));
  }
  return Math.max(1, nowDate.getUTCDate());
}

function shouldLogPerf403Again(shortLocId) {
  const k = String(shortLocId || '');
  const now = Date.now();
  const prev = _lastPerfApi403LogAt.get(k) || 0;
  if (now - prev < 90_000) return false;
  _lastPerfApi403LogAt.set(k, now);
  return true;
}

/**
 * When Performance API returns 403, try parent config/gmb.js `getLocationMetrics` (My Business v4 reportInsights).
 * Same OAuth token; often allowed when businessprofileperformance.googleapis.com is not.
 */
async function fetchMtdViaLegacyReportInsights(realAid, shortLocId, monthStart, nowDate) {
  let accountId = String(realAid || '').trim();
  if (!accountId || accountId === 'accounts/unknown') {
    accountId = resolveAccountFromSnapshotByShortLocation(shortLocId) || '';
  }
  if (!accountId) return null;

  const gmb = loadParentGmbClient();
  const days = daysMonthToDateUtc(nowDate, monthStart);
  const m = await gmb.getLocationMetrics(accountId, shortLocId, { days });
  if (!m || typeof m !== 'object') return null;

  const website = Number(m.websiteClicks) || 0;
  const calls = Number(m.phoneCalls) || 0;
  const directions = Number(m.drivingDirections) || 0;
  const impressions =
    Number(m.views) || (Number(m.viewsSearch) || 0) + (Number(m.viewsMaps) || 0);

  return {
    website_clicks: website,
    call_clicks: calls,
    chat_clicks: 0,
    direction_requests: directions,
    impressions,
    overview_clicks: website + calls + directions,
    monthly_totals: {
      overview: website + calls + directions,
      calls,
      chat_clicks: 0,
      website_clicks: website,
      directions,
      impressions,
    },
    legacyDaysWindow: days,
  };
}

function buildLegacyVerification({ shortLocId, shortAccId, accountId, locationId, monthStart, monthEnd }) {
  const accShort = extractLocationShortId(accountId);
  return {
    fetchOk: true,
    dataSource: 'google_my_business_v4_reportInsights',
    httpMethod: 'POST',
    rpc: 'locations.reportInsights',
    host: 'mybusiness.googleapis.com',
    fallbackFromPerformanceApi: true,
    locationIdShort: shortLocId || null,
    accountIdShort: shortAccId || null,
    accountIdEcho: typeof accountId === 'string' ? accountId.slice(0, 120) : null,
    locationIdEcho: typeof locationId === 'string' ? locationId.slice(0, 160) : null,
    dateRangeUtc: {
      start: monthStart ? monthStart.toISOString().slice(0, 10) : null,
      end: monthEnd ? monthEnd.toISOString().slice(0, 10) : null,
    },
    note:
      'Rolling window from parent getLocationMetrics (reportInsights), not daily Performance API series; totals approximate MTD.',
    bindingCheck:
      accShort && looksNumericGoogleAccountId(accShort)
        ? 'Using snapshot/account id for reportInsights.'
        : 'Confirm account id matches Google Business for this location.',
  };
}

/**
 * Resolves Supabase UUIDs to real Google Location/Account IDs using the local snapshot.
 */
function normalizeIds(locationId, businessName, accountId = null) {
  let lid = String(locationId || '').trim();
  let aid = String(accountId || '').trim();

  let bName = (businessName && businessName !== 'null') ? String(businessName).trim() : null;

  // If it's a UUID (Supabase ID), try to resolve it to a Google Location ID using the cached snapshot
  if (lid && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(lid)) {
    if (!bName) {
      const row = getActiveGmbRowForClientUuid(lid);
      if (row?.business_name) {
        bName = row.business_name;
        console.log(`[GmbPerformance/Normalization] UUID ${lid} → business name from active-gmb.json`);
      }
    }

    const snap = getGmbSnapshotForNormalization();
    if (snap && Array.isArray(snap.businesses)) {
      const nameNorm = bName ? bName.toLowerCase() : '';
      if (!nameNorm) {
        console.warn(`[GmbPerformance/Normalization] CANNOT resolve UUID ${lid} because Business Name is missing (null).`);
        return { locationId: lid, accountId: aid };
      }

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
        console.log(`[GmbPerformance/Normalization] SUCCESS: Resolved UUID ${lid} to Google ID ${found.locationId} (${found.title})`);
        if (found.locationId) lid = found.locationId;
        // Prefer snapshot account/location pairing from GBP-connected export
        if (found.accountId) aid = found.accountId;
      } else {
        console.warn(`[GmbPerformance/Normalization] FAILED to resolve UUID ${lid} (Name: "${bName}") - Not found in snapshot.`);
      }
    } else {
      console.warn(`[GmbPerformance/Normalization] Snapshot missing or invalid. Cannot resolve UUID ${lid}`);
    }
  } else if (lid && !aid) {
    const shortGuess = extractLocationShortId(lid).replace(/^locations\//i, '').trim();
    if (shortGuess) {
      const fromSnap = resolveAccountFromSnapshotByShortLocation(shortGuess);
      if (fromSnap) aid = fromSnap;
    }
  }
  return { locationId: lid, accountId: aid };
}

/**
 * Gets a fresh access token using the GMB OAuth credentials.
 */
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const { clientId, clientSecret, refreshToken } = config.gmb;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('GMB OAuth credentials missing in .env');
  }

  const response = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  cachedToken = response.data.access_token;
  // Expire 5 minutes early to be safe
  tokenExpiry = Date.now() + (response.data.expires_in - 300) * 1000;
  return cachedToken;
}

/**
 * Normalizes locationId. 
 * If it's "accounts/123/locations/456", it extracts "456".
 */
function extractLocationShortId(fullLocationId) {
  if (!fullLocationId) return '';
  const s = String(fullLocationId).trim();
  if (!s.includes('/')) return s;
  const parts = s.split('/');
  return parts[parts.length - 1] || '';
}

function looksNumericGoogleAccountId(shortId) {
  return /^\d{8,}$/.test(String(shortId || '').trim());
}

/**
 * Reviews API URL needs the real numeric Google account segment. Stored snapshots often use placeholders
 * (e.g. `accountId=supabase`) which would otherwise become `accounts/supabase/locations/...` and return 404.
 */
async function resolveReviewsAccountNumericId(accountId, locationId, accessToken = null) {
  const accGuess = extractLocationShortId(accountId);
  if (looksNumericGoogleAccountId(accGuess)) return accGuess;

  const fallback = String(process.env.GMB_REVIEWS_ACCOUNT_ID || process.env.GOOGLE_MY_BUSINESS_ACCOUNT_ID || '').trim();
  if (looksNumericGoogleAccountId(fallback)) return fallback;

  try {
    const mod = await import('./gmb.service.js');
    if (typeof mod.listAllLocationsLive === 'function') {
      const all = await mod.listAllLocationsLive();
      const wantLoc = extractLocationShortId(locationId).replace(/^locations\//, '');
      const hit = (all || []).find((l) => {
        const sh = extractLocationShortId(String(l?.locationId || ''));
        const short = extractLocationShortId(String(l?.locationIdShort || ''));
        return (
          (wantLoc && sh === wantLoc) ||
          (wantLoc && short === wantLoc) ||
          String(l?.locationId || '').endsWith(`/locations/${wantLoc}`)
        );
      });
      if (hit?.accountId) {
        const extracted = extractLocationShortId(hit.accountId);
        if (looksNumericGoogleAccountId(extracted)) return extracted;
      }
    }
  } catch (_) {
    /* non-fatal */
  }

  const shortLoc = extractLocationShortId(locationId);
  if (accessToken && shortLoc) {
    const viaApi = await findAccountOwningLocationViaApis(accessToken, shortLoc);
    if (viaApi) return viaApi;
  }
  return null;
}

/**
 * Walk Account Management accounts and Business Information locations to find which numeric
 * account owns `locations/{shortLocId}`. Enables Reviews v4 when stored accountId is a placeholder (e.g. supabase).
 */
async function findAccountOwningLocationViaApis(token, shortLocId) {
  const headers = { Authorization: `Bearer ${token}` };
  let accRes;
  try {
    accRes = await axios.get('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers,
      params: { pageSize: 100 },
    });
  } catch (e) {
    console.warn('[GmbPerformance] Account Management list failed:', e.response?.data || e.message);
    return null;
  }
  const accounts = accRes.data?.accounts || [];
  for (const acc of accounts) {
    const accName = acc?.name;
    if (!accName || !String(accName).startsWith('accounts/')) continue;
    const accNum = extractLocationShortId(accName);
    if (!looksNumericGoogleAccountId(accNum)) continue;
    try {
      let pageToken = '';
      for (; ;) {
        const params = { readMask: 'name,title', pageSize: 100 };
        if (pageToken) params.pageToken = pageToken;
        const locRes = await axios.get(
          `https://mybusinessbusinessinformation.googleapis.com/v1/${accName}/locations`,
          { headers, params }
        );
        const locs = locRes.data?.locations || [];
        for (const loc of locs) {
          const lid = extractLocationShortId(loc?.name || '');
          if (lid && lid === shortLocId) return accNum;
        }
        pageToken = locRes.data?.nextPageToken;
        if (!pageToken) break;
      }
    } catch (inner) {
      /* try next account */
    }
  }
  return null;
}

function buildRangeParams(startDate, endDate) {
  const params = new URLSearchParams();
  // Google REST transcoding expects snake_case subfields inside dailyRange — see GBP Performance API docs.
  params.append('dailyRange.start_date.year', String(startDate.getUTCFullYear()));
  params.append('dailyRange.start_date.month', String(startDate.getUTCMonth() + 1));
  params.append('dailyRange.start_date.day', String(startDate.getUTCDate()));
  params.append('dailyRange.end_date.year', String(endDate.getUTCFullYear()));
  params.append('dailyRange.end_date.month', String(endDate.getUTCMonth() + 1));
  params.append('dailyRange.end_date.day', String(endDate.getUTCDate()));
  return params;
}

/**
 * GBP Performance API shape: multiDailyMetricTimeSeries[] holds bundles;
 * each bundle.dailyMetricTimeSeries[] is a DailyMetricTimeSeries (dailyMetric + timeSeries.datedValues).
 * @see https://developers.google.com/my-business/reference/performance/rest/v1/locations/fetchMultiDailyMetricsTimeSeries
 */
function flattenPerformanceDailyRows(multiDaily = []) {
  const rows = [];
  for (const bundle of multiDaily) {
    const inner = bundle?.dailyMetricTimeSeries || [];
    for (const ts of inner) {
      if (ts && ts.dailyMetric) rows.push(ts);
    }
  }
  return rows;
}

function sumDailySeriesByMetric(flatDailyRows = [], metric) {
  const row = flatDailyRows.find((x) => x?.dailyMetric === metric);
  if (!row) return 0;
  return (row.timeSeries?.datedValues || []).reduce((sum, dp) => {
    return sum + Number(dp?.value || 0);
  }, 0);
}

function metricDailyMap(flatDailyRows = [], metric) {
  const map = new Map();
  const row = flatDailyRows.find((x) => x?.dailyMetric === metric);
  if (!row) return map;
  for (const dv of row.timeSeries?.datedValues || []) {
    // GBP can include trailing dates with missing value; treat those as "not yet reported"
    // so we only persist dates where Google returned an actual datapoint value.
    if (dv?.value === undefined || dv?.value === null || dv?.value === '') continue;
    const dt = googleDateToUtcDate(dv?.date);
    if (!dt) continue;
    map.set(dt.toISOString().slice(0, 10), Number(dv?.value || 0));
  }
  return map;
}

function buildDailyBreakdownDesc(flatDailyRows = [], startDateIso = null, endDateIso = null) {
    const website = metricDailyMap(flatDailyRows, 'WEBSITE_CLICKS');
    const calls = metricDailyMap(flatDailyRows, 'CALL_CLICKS');
    const chats = metricDailyMap(flatDailyRows, 'BUSINESS_CONVERSATIONS');
    const directions = metricDailyMap(flatDailyRows, 'BUSINESS_DIRECTION_REQUESTS');
    const impDMaps = metricDailyMap(flatDailyRows, 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS');
    const impDSearch = metricDailyMap(flatDailyRows, 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH');
    const impMMaps = metricDailyMap(flatDailyRows, 'BUSINESS_IMPRESSIONS_MOBILE_MAPS');
    const impMSearch = metricDailyMap(flatDailyRows, 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH');

    const allDates = new Set([
      ...website.keys(), 
      ...calls.keys(), 
      ...chats.keys(), 
      ...directions.keys(),
      ...impDMaps.keys(),
      ...impDSearch.keys(),
      ...impMMaps.keys(),
      ...impMSearch.keys()
    ]);

    return [...allDates]
      .filter((date) => {
        if (startDateIso && date < startDateIso) return false;
        if (endDateIso && date > endDateIso) return false;
        return true;
      })
      .sort((a, b) => (a < b ? 1 : -1))
      .map((date) => {
        const website_clicks = website.get(date) || 0;
        const calls_clicks = calls.get(date) || 0;
        const chat_clicks = chats.get(date) || 0;
        const directions_clicks = directions.get(date) || 0;
        const impressions = 
          (impDMaps.get(date) || 0) + 
          (impDSearch.get(date) || 0) + 
          (impMMaps.get(date) || 0) + 
          (impMSearch.get(date) || 0);

        return {
          date,
          overview: website_clicks + calls_clicks + chat_clicks + directions_clicks,
          calls: calls_clicks,
          chat_clicks,
          website_clicks,
          directions_clicks,
          impressions
        };
      });
}

/**
 * GBP can expose recent not-fully-processed days as all-zero rows.
 * Remove only the latest contiguous all-zero block so stored data
 * reflects the last meaningful available day.
 */
function trimLatestAllZeroDays(descRows = []) {
  let idx = 0;
  while (idx < descRows.length) {
    const r = descRows[idx] || {};
    const sum =
      Number(r.overview || 0) +
      Number(r.calls || 0) +
      Number(r.chat_clicks || 0) +
      Number(r.website_clicks || 0) +
      Number(r.directions_clicks || 0) +
      Number(r.impressions || 0);
    if (sum > 0) break;
    idx += 1;
  }
  return idx > 0 ? descRows.slice(idx) : descRows;
}

/** Google `Date` message in DatedValue (numeric or string fields). */
function googleDateToUtcDate(d) {
  if (!d) return null;
  const y = Number(d.year);
  const month = Number(d.month);
  const day = Number(d.day);
  if (!Number.isFinite(y) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(Date.UTC(y, month - 1, day));
}

function buildPerformanceVerification({
  fetchOk,
  shortLocId,
  shortAccId,
  accountId,
  locationId,
  monthStart,
  monthEnd,
  seriesList,
  err,
}) {
  const orderHint =
    'Check order: (2) raw series / this verification object — strongest proof of Google origin; ' +
    '(4) wrong locationId → empty series or 403/404; ' +
    '(3) token identity: node google-search-ranking/server/scripts/verifyGmbOAuthIdentity.mjs';
  const base = {
    orderHint,
    fetchOk: Boolean(fetchOk),
    dataSource: 'google_business_profile_performance_api_v1',
    httpMethod: 'GET',
    rpc: 'locations/{locationId}:fetchMultiDailyMetricsTimeSeries',
    host: 'businessprofileperformance.googleapis.com',
    locationIdShort: shortLocId || null,
    accountIdShort: shortAccId || null,
    accountIdEcho: typeof accountId === 'string' ? accountId.slice(0, 120) : null,
    locationIdEcho: typeof locationId === 'string' ? locationId.slice(0, 160) : null,
    dateRangeUtc: {
      start: monthStart ? monthStart.toISOString().slice(0, 10) : null,
      end: monthEnd ? monthEnd.toISOString().slice(0, 10) : null,
    },
    dailyMetricsRequested: ['WEBSITE_CLICKS', 'CALL_CLICKS', 'BUSINESS_CONVERSATIONS'],
    bindingCheck:
      'If seriesReturned is 0 but you expect clicks, wrong locationId or OAuth user lacks access to this location.',
  };
  if (fetchOk && seriesList) {
    const flat = flattenPerformanceDailyRows(seriesList);
    return {
      ...base,
      /** Outer MultiDailyMetricTimeSeries groups (Google wraps metrics here). */
      outerGroupsReturned: seriesList.length,
      /** Flattened DailyMetricTimeSeries rows (one per metric). */
      seriesReturned: flat.length,
      metricsPresent: flat.map((s) => s.dailyMetric).filter(Boolean),
      perMetricDayCount: flat.map((s) => ({
        metric: s.dailyMetric,
        days: (s.timeSeries?.datedValues || []).length,
      })),
    };
  }
  return {
    ...base,
    httpStatus: err?.response?.status ?? null,
    googleError: err?.response?.data ?? null,
    message: err?.message || null,
  };
}

/**
 * Fetches real GBP Performance Insights and Reviews.
 * Gracefully returns 0 metrics on failure to prevent crashing automation.
 * @param {string} accountId e.g. "accounts/123"
 * @param {string} locationId e.g. "accounts/123/locations/456" or "456"
 * @param {string} [businessName] Optional business name for UUID resolution
 */
export async function fetchGmbRealMetrics(accountId, locationId, businessName = null) {
  const defaultMetrics = {
    traffic: {
      website_clicks: 0,
      direction_requests: 0,
      calls: 0,
      chat_clicks: 0,
      impressions: 0,
    },
    reviews: { total_count: 0, average_rating: 0, new_since_last_scan: 0 },
    monthPerformance: null,
  };

  const { locationId: realLid, accountId: realAid } = normalizeIds(locationId, businessName, accountId);
  const shortLocId = extractLocationShortId(realLid);
  if (!shortLocId) {
    console.warn('[GmbPerformance] fetchGmbRealMetrics: no location id');
    return defaultMetrics;
  }

  try {
    const token = await getAccessToken();
    const headers = { Authorization: `Bearer ${token}` };

    // Month-to-date Performance (same path as keyword raw_traffic_data): only needs location id in URL.
    let trafficData = { ...defaultMetrics.traffic };
    let monthPerformance = null;
    try {
      const month = await fetchCurrentMonthGmbClicks(realAid || 'accounts/unknown', realLid, { businessName });
      monthPerformance = month || null;
      trafficData = {
        website_clicks: Number(month?.website_clicks) || 0,
        calls: Number(month?.call_clicks) || 0,
        chat_clicks: Number(month?.chat_clicks) || 0,
        direction_requests: Number(month?.direction_requests) || 0,
        impressions: Number(month?.impressions) || 0,
      };
    } catch (e) {
      console.warn('[GmbPerformance] Month MTD performance merge failed:', e.response?.data || e.message);
    }

    // Reviews v4 needs accounts/{numeric}/locations/{id}/reviews
    let reviewData = { totalReviewCount: 0, averageRating: 0 };
    const shortAccId = await resolveReviewsAccountNumericId(realAid, realLid, token);
    if (shortAccId) {
      try {
        const revUrl = `https://mybusiness.googleapis.com/v4/accounts/${shortAccId}/locations/${shortLocId}/reviews`;
        let nextPageToken = null;
        let allReviews = [];
        do {
          const u = nextPageToken ? `${revUrl}?pageToken=${nextPageToken}` : revUrl;
          const revRes = await axios.get(u, { headers });
          if (allReviews.length === 0) {
            reviewData.totalReviewCount = revRes.data.totalReviewCount || 0;
            reviewData.averageRating = revRes.data.averageRating || 0;
          }
          const batch = revRes.data.reviews || [];
          allReviews = allReviews.concat(batch);
          nextPageToken = revRes.data.nextPageToken;
        } while (nextPageToken);
        
        // If API doesn't return totalReviewCount explicitly, use the length
        if (!reviewData.totalReviewCount) reviewData.totalReviewCount = allReviews.length;
      } catch (e) {
        console.warn('[GmbPerformance] Reviews API fetch failed:', e.response?.data || e.message);
      }
    } else {
      console.warn(
        `[GmbPerformance] Could not resolve Google account id for reviews. Loc=${shortLocId.slice(0, 36)}… · Set GMB_REVIEWS_ACCOUNT_ID or enable Account Management + business information APIs.`
      );
    }

    return {
      traffic: trafficData,
      reviews: {
        total_count: reviewData.totalReviewCount,
        average_rating: reviewData.averageRating,
        new_since_last_scan: 0,
      },
      monthPerformance,
    };
  } catch (err) {
    console.error('[GmbPerformance] Root fetch failed:', err.message);
    return defaultMetrics;
  }
}

/**
 * Fetch GBP performance clicks for the current month (month-to-date).
 * Returns website, call, direction, and total clicks.
 */
/**
 * @param {string} accountId
 * @param {string} locationId
 * @param {{ includeRawSeries?: boolean, businessName?: string }} [options]
 */
export async function fetchCurrentMonthGmbClicks(accountId, locationId, options = {}) {
  const { includeRawSeries = false, businessName = null } = options;
  const rawLocationId = String(locationId || '').trim();
  const clientUuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const { locationId: realLid, accountId: realAid } = normalizeIds(locationId, businessName, accountId);
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthLabelBase = `${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}/${monthStart.getUTCFullYear()}`;
  const monthStartIsoBase = monthStart.toISOString().split('T')[0];

  const fallback = {
    month: 'N/A',
    monthStart: null,
    monthEnd: null,
    reporting_days: 0,
    daysElapsed: 0,
    overview_clicks: 0,
    website_clicks: 0,
    call_clicks: 0,
    chat_clicks: 0,
    total_clicks: 0,
    monthly_totals: {
      overview: 0,
      calls: 0,
      chat_clicks: 0,
      website_clicks: 0,
      directions: 0,
      impressions: 0,
    },
    daily_breakdown_desc: [],
  };

  if (clientUuidRe.test(rawLocationId)) {
    const gbpFlag = getGbpAccessFlagForClientUuid(rawLocationId);
    if (gbpFlag === false) {
      console.log(
        `[GmbPerformance] Skipping GBP metrics for client ${rawLocationId} (active-gmb.json: has_gbp_access=false)`
      );
      const verification = buildPerformanceVerification({
        fetchOk: false,
        shortLocId: extractLocationShortId(realLid),
        shortAccId: extractLocationShortId(realAid) || null,
        accountId: realAid,
        locationId: realLid,
        monthStart,
        monthEnd,
        seriesList: null,
        err: new Error('Skipped: has_gbp_access=false in active-gmb.json'),
      });
      return {
        ...fallback,
        month: monthLabelBase,
        monthStart: monthStartIsoBase,
        verification: { ...verification, skippedNoGbpAccess: true },
        ...(includeRawSeries ? { google_multiDailyMetricTimeSeries: [] } : {}),
      };
    }
  }

  const shortLocId = extractLocationShortId(realLid).replace(/^locations\//i, '').trim();
  /** Performance API hostname only uses `locations/{locationId}` — account id is not in the URL. */
  if (!shortLocId) {
    const verification = buildPerformanceVerification({
      fetchOk: false,
      shortLocId: '',
      shortAccId: extractLocationShortId(realAid) || null,
      accountId: realAid,
      locationId: realLid,
      monthStart,
      monthEnd,
      seriesList: null,
      err: new Error('Missing location id for fetchMultiDailyMetricsTimeSeries'),
    });
    return {
      ...fallback,
      verification,
      ...(includeRawSeries ? { google_multiDailyMetricTimeSeries: [] } : {}),
    };
  }
  const shortAccIdForLog = extractLocationShortId(realAid) || '';

  try {
    const token = await getAccessToken();
    const headers = { Authorization: `Bearer ${token}` };
    const perfUrl = `https://businessprofileperformance.googleapis.com/v1/locations/${shortLocId}:fetchMultiDailyMetricsTimeSeries`;
    
    console.log(`[GmbPerformance] Requesting metrics for Google ID: ${shortLocId} (Resolved from: ${locationId})`);
    
    const params = buildRangeParams(monthStart, monthEnd);
    params.append('dailyMetrics', 'WEBSITE_CLICKS');
    params.append('dailyMetrics', 'CALL_CLICKS');
    params.append('dailyMetrics', 'BUSINESS_CONVERSATIONS');
    params.append('dailyMetrics', 'BUSINESS_DIRECTION_REQUESTS');
    params.append('dailyMetrics', 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS');
    params.append('dailyMetrics', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH');
    params.append('dailyMetrics', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS');
    params.append('dailyMetrics', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH');

    const perfRes = await axios.get(perfUrl, { headers, params });
    const seriesList = perfRes.data?.multiDailyMetricTimeSeries || [];

    const flatRows = flattenPerformanceDailyRows(seriesList);
    const websiteClicks = sumDailySeriesByMetric(flatRows, 'WEBSITE_CLICKS');
    const callClicks = sumDailySeriesByMetric(flatRows, 'CALL_CLICKS');
    const chatClicks = sumDailySeriesByMetric(flatRows, 'BUSINESS_CONVERSATIONS');

    const monthLabel = `${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}/${monthStart.getUTCFullYear()}`;
    const monthStartIso = monthStart.toISOString().split('T')[0];
    const dailyBreakdownDesc = buildDailyBreakdownDesc(flatRows, monthStartIso, null);

    const monthlyTotals = dailyBreakdownDesc.reduce(
      (acc, day) => {
        acc.overview += Number(day.overview || 0);
        acc.calls += Number(day.calls || 0);
        acc.chat_clicks += Number(day.chat_clicks || 0);
        acc.website_clicks += Number(day.website_clicks || 0);
        acc.directions += Number(day.directions_clicks || 0);
        acc.impressions += Number(day.impressions || 0);
        return acc;
      },
      { overview: 0, calls: 0, chat_clicks: 0, website_clicks: 0, directions: 0, impressions: 0 }
    );
    const overviewClicks = monthlyTotals.overview;
    const reporting_days = dailyBreakdownDesc.length;
    const gbpThrough = reporting_days > 0 ? dailyBreakdownDesc[0].date : null;

    const verification = buildPerformanceVerification({
      fetchOk: true,
      shortLocId,
      shortAccId: shortAccIdForLog,
      accountId: realAid,
      locationId: realLid,
      monthStart,
      monthEnd,
      seriesList,
      err: null,
    });

    const out = {
      month: monthLabel,
      monthStart: monthStartIso,
      monthEnd: gbpThrough,
      reporting_days,
      daysElapsed: reporting_days,
      overview_clicks: overviewClicks,
      website_clicks: monthlyTotals.website_clicks,
      call_clicks: monthlyTotals.calls,
      chat_clicks: monthlyTotals.chat_clicks,
      direction_requests: monthlyTotals.directions,
      impressions: monthlyTotals.impressions,
      total_clicks: overviewClicks,
      monthly_totals: monthlyTotals,
      daily_breakdown_desc: dailyBreakdownDesc,
      verification,
      ...(includeRawSeries ? { google_multiDailyMetricTimeSeries: seriesList } : {}),
    };

    return out;
  } catch (e) {
    const status = e.response?.status;
    const errorData = e.response?.data;

    try {
      const legacy = await fetchMtdViaLegacyReportInsights(realAid, shortLocId, monthStart, now);
      if (legacy) {
        console.log(
          `[GmbPerformance] Using legacy reportInsights for ${shortLocId} (Performance API error ${status ?? 'n/a'}; MTD window ≈${legacy.legacyDaysWindow}d)`
        );
        const verification = {
          ...buildLegacyVerification({
            shortLocId,
            shortAccId: shortAccIdForLog,
            accountId: realAid,
            locationId: realLid,
            monthStart,
            monthEnd,
          }),
          performanceApiError: {
            httpStatus: status ?? null,
            googleError: errorData ?? null,
            message: e.message ?? null,
          },
        };
        return {
          month: monthLabelBase,
          monthStart: monthStartIsoBase,
          monthEnd: monthStartIsoBase,
          reporting_days: legacy.legacyDaysWindow,
          daysElapsed: legacy.legacyDaysWindow,
          overview_clicks: legacy.overview_clicks,
          website_clicks: legacy.website_clicks,
          call_clicks: legacy.call_clicks,
          chat_clicks: legacy.chat_clicks,
          direction_requests: legacy.direction_requests,
          impressions: legacy.impressions,
          total_clicks: legacy.overview_clicks,
          monthly_totals: legacy.monthly_totals,
          daily_breakdown_desc: [],
          verification,
          ...(includeRawSeries ? { google_multiDailyMetricTimeSeries: [] } : {}),
        };
      }
    } catch (legacyErr) {
      console.warn(`[GmbPerformance] Legacy reportInsights fallback failed for ${shortLocId}:`, legacyErr.message);
    }

    if (status === 403) {
      if (shouldLogPerf403Again(shortLocId)) {
        console.warn(`[GmbPerformance] fetchCurrentMonthGmbClicks failed for ${shortLocId}:`, {
          status,
          message: e.message,
          details: errorData || 'No detail',
        });
      }
    } else {
      console.warn(`[GmbPerformance] fetchCurrentMonthGmbClicks failed for ${shortLocId}:`, {
        status,
        message: e.message,
        details: errorData || 'No detail',
      });
    }

    const verification = buildPerformanceVerification({
      fetchOk: false,
      shortLocId,
      shortAccId: shortAccIdForLog,
      accountId: realAid,
      locationId: realLid,
      monthStart,
      monthEnd,
      seriesList: null,
      err: e,
    });

    return {
      ...fallback,
      verification,
      ...(includeRawSeries ? { google_multiDailyMetricTimeSeries: [] } : {}),
    };
  }
}
