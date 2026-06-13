import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { isMongoReady } from '../db/mongo.js';
import { GmbKeywordGallery } from '../models/GmbKeywordGallery.js';
import * as GmbService from './gmb.service.js';
import * as RankingService from './ranking.service.js';
import { generateKeywords, mergeKeywordLists } from './keywordGeneration.service.js';
import {
  dataForSeoConfigured,
  fetchDataForSeoLocalFinder,
  findBusinessInDataForSeoItems,
  buildCheckUrlForRankPage,
  getStartFromCheckUrl,
  getRankSlotOnPage,
} from './rankAndScreenshot.service.js';
import { appendSnapshotFromPilotPayload } from './gmbTrackingHistory.service.js';
import { filterLocationTargetsMinKeywords } from './gmbKeywordCountCache.service.js';
import { cleanKeyword } from '../utils/trafficCalculator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../../');
const RANK_HISTORY_DIR = path.join(SERVER_ROOT, 'rank_history');
const PILOT_BUSINESS_NAME = (process.env.PILOT_GMB_NAME || 'Dhaso Painter').trim();
const PILOT_GMB_LOCATION_ID = String(process.env.PILOT_GMB_LOCATION_ID || '').trim();
const PILOT_GMB_ACCOUNT_ID = String(process.env.PILOT_GMB_ACCOUNT_ID || '').trim();
const intervalMinutesRaw = Number(process.env.PILOT_INTERVAL_MINUTES ?? 45);
const PILOT_INTERVAL_MINUTES = Number.isFinite(intervalMinutesRaw)
  ? Math.max(5, Math.min(24 * 60, Math.floor(intervalMinutesRaw)))
  : 45;
const PILOT_INTERVAL_MS = PILOT_INTERVAL_MINUTES * 60 * 1000;
const firstRunMinuteRaw = Number(process.env.PILOT_FIRST_RUN_MINUTE ?? 5);
const PILOT_FIRST_RUN_MINUTE = Number.isFinite(firstRunMinuteRaw)
  ? Math.max(0, Math.min(59, Math.floor(firstRunMinuteRaw)))
  : 5;
const firstRunHourRaw = process.env.PILOT_FIRST_RUN_HOUR;
const PILOT_FIRST_RUN_HOUR = (() => {
  if (firstRunHourRaw === undefined || firstRunHourRaw === null || String(firstRunHourRaw).trim() === '') {
    return null;
  }
  const n = Number(firstRunHourRaw);
  return Number.isFinite(n) ? Math.max(0, Math.min(23, Math.floor(n))) : null;
})();

function resolveBaseUrl(rawValue, fallback = '') {
  const candidates = String(rawValue || '')
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!candidates.length) return String(fallback || '').replace(/\/+$/, '');
  const firstValid = candidates.find((x) => /^https?:\/\//i.test(x)) || candidates[0];
  return firstValid.replace(/\/+$/, '');
}

const API_BASE_URL = resolveBaseUrl(
  process.env.RANK_HISTORY_API_BASE_URL,
  `http://localhost:${process.env.PORT || 5524}`
);
const FRONTEND_BASE_URL = resolveBaseUrl(process.env.RANK_HISTORY_FRONTEND_BASE_URL, '');

let _pilotTimer = null;
let _pilotStartTimer = null;
let _pilotIsRunning = false;

/** Header / CRM banner — true while hourly pilot cron is executing a ranked run */
export function isPilotHourlyAutomationRunning() {
  return _pilotIsRunning;
}

const GMB_RETRY_COUNT = Math.max(1, Number(process.env.PILOT_GMB_RETRY_COUNT || 3));
const KEYWORD_RETRY_COUNT = Math.max(1, Number(process.env.PILOT_KEYWORD_RETRY_COUNT || 2));
const RETRY_BASE_MS = Math.max(500, Number(process.env.PILOT_RETRY_BASE_MS || 1500));

function ensureArray(values) {
  if (!Array.isArray(values)) return [];
  return values.map((v) => String(v ?? '').trim()).filter(Boolean);
}

function getPrimaryCategory(locationDetails) {
  return (
    locationDetails?.categories?.primaryCategory?.displayName ||
    locationDetails?.categories?.primaryCategory?.name ||
    ''
  ).trim();
}

function getAreas(locationDetails) {
  const sa = locationDetails?.serviceArea;
  if (!sa) return [];
  if (Array.isArray(sa)) return ensureArray(sa);

  const out = [];
  if (Array.isArray(sa?.places?.placeInfos)) {
    for (const p of sa.places.placeInfos) {
      const name = p?.placeName || p?.placeId;
      if (name) out.push(String(name));
    }
  }
  if (typeof sa?.regionCode === 'string' && sa.regionCode.trim().length > 2) {
    out.push(sa.regionCode.trim());
  }
  if (Array.isArray(sa?.regions)) {
    for (const r of sa.regions) {
      const value =
        r?.displayName ||
        r?.name ||
        r?.regionCode ||
        r?.placeId ||
        (typeof r === 'string' ? r : '');
      if (value) out.push(String(value));
    }
  }
  return ensureArray(out);
}

function toLiveScreenshotPath(screenshotPath) {
  const rel = String(screenshotPath || '').trim().replace(/^\/+/, '');
  if (!rel) return null;
  if (/^https?:\/\//i.test(rel)) return rel;
  return `${API_BASE_URL}/api/outputs/${rel}`;
}

function getHourStamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  return `${y}-${m}-${d}_${h}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('enotfound') ||
    msg.includes('eai_again') ||
    msg.includes('etimedout') ||
    msg.includes('timeout') ||
    msg.includes('socket hang up') ||
    msg.includes('503') ||
    msg.includes('429') ||
    msg.includes('temporarily unavailable')
  );
}

async function withRetry(taskLabel, fn, retries) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < retries && isRetryableError(err);
      console.warn(
        `[PilotCron] ${taskLabel} failed (attempt ${attempt}/${retries}): ${String(err?.message || err)}`
      );
      if (!canRetry) break;
      const backoff = RETRY_BASE_MS * attempt;
      await sleep(backoff);
    }
  }
  throw lastErr;
}

async function writeRankHistoryJson(payload, startedAt) {
  await fs.mkdir(RANK_HISTORY_DIR, { recursive: true });
  const filename = `rank_history_${getHourStamp(startedAt)}.json`;
  const filepath = path.join(RANK_HISTORY_DIR, filename);
  await fs.writeFile(filepath, JSON.stringify(payload, null, 2), 'utf8');
  return filepath;
}

function pickPilotLocation(allLocations) {
  const rows = Array.isArray(allLocations) ? allLocations : [];
  if (!rows.length) return null;

  if (PILOT_GMB_LOCATION_ID) {
    const byId = rows.find((loc) => {
      const fullId = String(loc?.locationId || '').trim();
      const shortId = String(loc?.locationIdShort || '').trim();
      const byLocation = fullId === PILOT_GMB_LOCATION_ID || shortId === PILOT_GMB_LOCATION_ID;
      if (!byLocation) return false;
      if (!PILOT_GMB_ACCOUNT_ID) return true;
      return String(loc?.accountId || '').trim() === PILOT_GMB_ACCOUNT_ID;
    });
    if (byId) return byId;
  }

  const targetRaw = String(PILOT_BUSINESS_NAME || '').trim();
  if (!targetRaw) return null;

  const targetNorm = RankingService.normalizeGmbNameForMatch(targetRaw);
  if (!targetNorm) return null;

  const byExactNorm = rows.find((loc) => {
    const t = RankingService.normalizeGmbNameForMatch(loc?.title || '');
    return !!t && t === targetNorm;
  });
  if (byExactNorm) return byExactNorm;

  const byContainsNorm = rows.find((loc) => {
    const t = RankingService.normalizeGmbNameForMatch(loc?.title || '');
    return !!t && (t.includes(targetNorm) || targetNorm.includes(t));
  });
  if (byContainsNorm) return byContainsNorm;

  // Fallback: choose best token overlap so slight punctuation/spacing/word-order
  // differences do not block the scheduler entirely.
  const targetTokens = targetNorm.split(' ').filter((w) => w.length >= 3);
  let best = null;
  for (const loc of rows) {
    const norm = RankingService.normalizeGmbNameForMatch(loc?.title || '');
    if (!norm) continue;
    const locTokens = new Set(norm.split(' ').filter((w) => w.length >= 3));
    let overlap = 0;
    for (const t of targetTokens) {
      if (locTokens.has(t)) overlap += 1;
    }
    if (!best || overlap > best.overlap) {
      best = { loc, overlap };
    }
  }
  const minOverlap = targetTokens.length >= 2 ? 2 : 1;
  if (best && best.overlap >= minOverlap) return best.loc;
  return null;
}

function buildLocationCandidates(allLocations, limit = 10) {
  const rows = Array.isArray(allLocations) ? allLocations : [];
  const targetNorm = RankingService.normalizeGmbNameForMatch(PILOT_BUSINESS_NAME || '');
  const targetTokens = targetNorm.split(' ').filter((w) => w.length >= 3);
  const ranked = [];
  for (const loc of rows) {
    const title = String(loc?.title || '').trim();
    if (!title) continue;
    const norm = RankingService.normalizeGmbNameForMatch(title);
    if (!norm) continue;
    const tokens = new Set(norm.split(' ').filter((w) => w.length >= 3));
    let overlap = 0;
    for (const tk of targetTokens) {
      if (tokens.has(tk)) overlap += 1;
    }
    if (!overlap && targetNorm && !norm.includes(targetNorm) && !targetNorm.includes(norm)) continue;
    ranked.push({
      title,
      accountId: loc?.accountId || null,
      locationId: loc?.locationId || null,
      locationIdShort: loc?.locationIdShort || null,
      overlap,
    });
  }
  ranked.sort((a, b) => b.overlap - a.overlap || String(a.title).localeCompare(String(b.title)));
  return ranked.slice(0, limit);
}

async function createGalleryIfPossible({
  businessName,
  locationHint,
  accountId = '',
  locationId = '',
  items,
}) {
  if (!isMongoReady()) {
    return { publicId: null, galleryUrl: null, reason: 'mongo_not_ready' };
  }
  const validItems = (items || []).filter((row) => row?.keyword && row?.screenshotPath);
  if (!validItems.length) {
    return { publicId: null, galleryUrl: null, reason: 'no_valid_items' };
  }

  const publicId = randomUUID();
  await GmbKeywordGallery.create({
    publicId,
    businessName: String(businessName || ''),
    locationHint: String(locationHint || ''),
    accountId: String(accountId || '').trim(),
    locationId: String(locationId || '').trim(),
    items: validItems.map((row) => ({
      keyword: row.keyword,
      screenshotPath: row.screenshotPath,
      rank: row.rank != null && Number.isFinite(Number(row.rank)) ? Number(row.rank) : null,
      page: row.page != null && Number.isFinite(Number(row.page)) ? Number(row.page) : null,
    })),
  });

  const defaultGalleryUrl = `${API_BASE_URL}/gmb-keyword-gallery/${publicId}`;
  const galleryUrl = FRONTEND_BASE_URL
    ? `${FRONTEND_BASE_URL}/gmb-keyword-gallery/${publicId}`
    : defaultGalleryUrl;
  return { publicId, galleryUrl, reason: null };
}

async function runPilotOnce() {
  if (_pilotIsRunning) {
    console.warn('[PilotCron] Previous run still active. Skipping this scheduled tick.');
    return;
  }
  _pilotIsRunning = true;
  const startedAt = new Date();
  console.log(
    `[PilotCron] Starting scheduled run for "${PILOT_BUSINESS_NAME}" at ${startedAt.toISOString()} (every ${PILOT_INTERVAL_MINUTES}m)`
  );

  const basePayload = {
    job: {
      name: 'pilot_hourly_first_gmb',
      businessNameFilter: PILOT_BUSINESS_NAME,
      locationIdFilter: PILOT_GMB_LOCATION_ID || null,
      accountIdFilter: PILOT_GMB_ACCOUNT_ID || null,
      scheduleType: 'interval',
      intervalMinutes: PILOT_INTERVAL_MINUTES,
      startedAt: startedAt.toISOString(),
      startedHour: startedAt.getHours(),
    },
    gmbLocation: null,
    keywordSummary: { total: 0, success: 0, failed: 0, found: 0, notFound: 0 },
    keywords: [],
    gallery: { publicId: null, link: null },
    errors: [],
  };

  try {
    const allLocations = await withRetry(
      'GMB listAllLocations',
      () => GmbService.listAllLocations(),
      GMB_RETRY_COUNT
    );
    const slimTargets = allLocations
      .filter((loc) => String(loc?.accountId || '').trim() && String(loc?.locationId || '').trim())
      .map((loc) => ({
        accountId: String(loc.accountId).trim(),
        locationId: String(loc.locationId).trim(),
        title: String(loc.title || '').trim(),
      }));
    const withKeywords = await filterLocationTargetsMinKeywords(slimTargets, 1);
    const allowedIds = new Set(withKeywords.map((t) => t.locationId));
    const pool = allLocations.filter((loc) => allowedIds.has(String(loc?.locationId || '').trim()));
    if (!pool.length) {
      basePayload.errors.push(
        'Pilot pool is empty: no locations have keywordsCount >= 1 in services-keywords.json (run POST /api/services-keywords/rebuild first).'
      );
      basePayload.locationCandidates = [];
      await writeRankHistoryJson(basePayload, startedAt);
      return;
    }
    const selected = pickPilotLocation(pool);
    if (!selected) {
      const idHint = PILOT_GMB_LOCATION_ID
        ? ` (locationId filter="${PILOT_GMB_LOCATION_ID}")`
        : '';
      basePayload.errors.push(`Location not found for pilot title "${PILOT_BUSINESS_NAME}"${idHint}`);
      basePayload.locationCandidates = buildLocationCandidates(pool, 15);
      await writeRankHistoryJson(basePayload, startedAt);
      return;
    }

    const locationIdShort =
      selected.locationIdShort ||
      String(selected.locationId || '')
        .split('/')
        .filter(Boolean)
        .pop() ||
      '';
    const locationDetails = await withRetry(
      'GMB getLocationFull',
      () => GmbService.getLocationFull(selected.accountId, locationIdShort),
      GMB_RETRY_COUNT
    );
    const primaryCategory = getPrimaryCategory(locationDetails);
    const areas = getAreas(locationDetails);
    const baseKeywords = RankingService.buildKeywords(primaryCategory, areas);
    const aiKeywords = await generateKeywords(loc.title, primaryCategory, areas);
    const keywords = mergeKeywordLists(baseKeywords, aiKeywords);

    basePayload.gmbLocation = {
      accountId: selected.accountId,
      locationId: selected.locationId,
      locationIdShort,
      title: selected.title,
      primaryCategory,
      areas,
    };

    if (!dataForSeoConfigured()) {
      basePayload.errors.push('DataForSEO not configured; pilot needs DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD');
    }

    async function rankAndScreenshotOneKeyword(keyword, locationHint, biz) {
      if (!dataForSeoConfigured()) {
        throw new Error('DataForSEO not configured');
      }
      const { items, checkUrl, totalItems } = await fetchDataForSeoLocalFinder({
        keyword: String(keyword),
        location: String(locationHint || '').trim(),
        device: 'desktop',
        os: 'windows',
      });
      const match = findBusinessInDataForSeoItems(items, biz, keyword, String(locationHint || ''), checkUrl);
      if (!match.found) {
        return {
          kind: 'not_found',
          totalItems,
        };
      }
      const built = buildCheckUrlForRankPage(checkUrl, match.rank);
      const googleSearchUrl = built.checkUrlForPage || checkUrl;
      const scanRank = Number(match.rank);
      const localSerpStart = built.localStart;
      const rankSlotOnSerpPage = built.rankSlotOnPage;

      let cap;
      try {
        cap = await RankingService.runScreenshotCaptureSerial(() =>
          RankingService.captureGoogleSearchLocalScreenshot({
            keyword: String(keyword),
            rank: scanRank,
            scrollToTitle: String(match.title || biz || '').trim(),
            googleSearchUrl,
            verifyGoogleSearchUrl: googleSearchUrl,
            rankSlotOnSerpPage,
            localSerpStart,
            targetXpath: match.xpath || null,
            targetCid: match.cid || null,
          })
        );
      } catch (capErr) {
        if (
          capErr instanceof RankingService.SerpListingVerificationError ||
          capErr?.name === 'SerpListingVerificationError'
        ) {
          return {
            kind: 'serp_unverified',
            message: String(capErr?.message || capErr).slice(0, 800),
          };
        }
        throw capErr;
      }

      // GMB not found on SERP page → no screenshot saved
      if (cap?.found === false) {
        return {
          kind: 'serp_unverified',
          message: cap.message || 'Business not found on live SERP page (strict match).',
        };
      }

      const rankOut =
        cap?.displayRank != null && Number.isFinite(Number(cap.displayRank)) ? Number(cap.displayRank) : scanRank;
      return {
        kind: 'ok',
        rank: rankOut,
        title: match.title || biz,
        page: match.page ?? null,
        screenshotPath: cap?.screenshotPath || null,
      };
    }

    let gmbMonthlyClicks = null;
    try {
      if (GmbService.hasGmbConfig()) {
        gmbMonthlyClicks = await GmbService.getMonthlyClicks(selected.accountId, selected.locationId);
      }
    } catch (gErr) {
      console.warn('[PilotCron] GBP monthly clicks fetch failed:', gErr.message);
    }

    const keywordResults = [];
    for (const keyword of keywords) {
      const locationHint = (Array.isArray(areas) ? areas.join(', ') : '') || areas[0] || '';
      const cleaningContext = `${selected.title}, ${locationHint}`;
      const cleanedKw = cleanKeyword(keyword, cleaningContext);
      const gmb = gmbMonthlyClicks || null;
      const monthlyTotal = Math.max(0, Number(gmb?.total_clicks) || 0);
      const repDays = Math.max(1, Number(gmb?.reporting_days ?? gmb?.daysElapsed) || 1);
      const dailyAvg = Math.round((monthlyTotal / repDays) * 10) / 10;

      const biz = selected.title;
      const row = {
        keyword,
        target_keyword: cleanedKw,
        source_month: gmb?.month || 'N/A',
        location: locationHint,
        success: false,
        found: false,
        rank: null,
        title: null,
        page: null,
        screenshotPath: null,
        screenshotLivePath: null,
        volume: monthlyTotal,
        days: repDays,
        raw_traffic_data: gmb,
        estimated_clicks: monthlyTotal,
        daily_traffic: dailyAvg,
        message: null,
        error: null,
      };

      try {
        const out = await withRetry(
          `pilot keyword "${keyword}"`,
          () => rankAndScreenshotOneKeyword(keyword, locationHint, biz),
          KEYWORD_RETRY_COUNT
        );
        if (out.kind === 'not_found') {
          row.success = true;
          row.found = false;
          row.message = `"${biz}" not in Local Finder (~${out.totalItems} items).`;
        } else if (out.kind === 'serp_unverified') {
          row.success = true;
          row.found = false;
          row.message = out.message || 'Live SERP page did not match business (strict verification).';
        } else {
          row.success = true;
          row.found = true;
          row.rank = out.rank;
          row.title = out.title;
          row.page = out.page;
          row.screenshotPath = out.screenshotPath || null;
          row.screenshotLivePath = toLiveScreenshotPath(row.screenshotPath);
        }
      } catch (e) {
        row.error = String(e?.message || e).slice(0, 800);
        row.success = false;
      }
      keywordResults.push(row);
    }

    const gallery = await createGalleryIfPossible({
      businessName: selected.title,
      locationHint: areas[0] || '',
      accountId: selected.accountId || '',
      locationId: selected.locationId || '',
      items: keywordResults.filter((r) => r.screenshotPath),
    });

    const success = keywordResults.filter((k) => k.success).length;
    const found = keywordResults.filter((k) => k.found).length;
    const failed = keywordResults.length - success;
    const notFound = keywordResults.length - found;

    basePayload.keywordSummary = {
      total: keywordResults.length,
      success,
      failed,
      found,
      notFound,
    };
    basePayload.keywords = keywordResults;
    basePayload.gallery = {
      publicId: gallery.publicId,
      link: gallery.galleryUrl,
      note: gallery.reason || null,
    };
  } catch (err) {
    basePayload.errors.push(String(err?.message || err));
    console.error('[PilotCron] Scheduled run failed:', err);
  } finally {
    try {
      const outPath = await writeRankHistoryJson(basePayload, startedAt);
      console.log(`[PilotCron] Rank history saved: ${outPath}`);
    } catch (writeErr) {
      console.error('[PilotCron] Failed to write rank history JSON:', writeErr?.message || writeErr);
    }
    try {
      const tr = await appendSnapshotFromPilotPayload(basePayload, startedAt);
      if (tr?.skipped) {
        /* no GMB resolved this run */
      } else if (tr?.snapshotCount != null) {
        console.log(
          `[PilotCron] Unified tracking snapshot saved (${tr.snapshotCount} total for this GMB)`
        );
      }
    } catch (trErr) {
      console.error('[PilotCron] Unified tracking append failed:', trErr?.message || trErr);
    }
    _pilotIsRunning = false;
  }
}

function nextPilotRunAt(now = new Date()) {
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMilliseconds(0);
  next.setMinutes(PILOT_FIRST_RUN_MINUTE);
  if (PILOT_FIRST_RUN_HOUR != null) {
    next.setHours(PILOT_FIRST_RUN_HOUR);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }
  if (next <= now) {
    next.setHours(next.getHours() + 1);
  }
  return next;
}

export function startHourlyPilotAutomation() {
  if (_pilotTimer || _pilotStartTimer) return;
  const now = new Date();
  const firstRunAt = nextPilotRunAt(now);
  const firstDelayMs = Math.max(1_000, firstRunAt.getTime() - now.getTime());
  const hourPart =
    PILOT_FIRST_RUN_HOUR != null ? `hour=${PILOT_FIRST_RUN_HOUR}, minute=${PILOT_FIRST_RUN_MINUTE}` : `minute=${PILOT_FIRST_RUN_MINUTE} (next slot each hour)`;
  console.log(
    `[PilotCron] Pilot automation enabled. First run at local time ${firstRunAt.toLocaleString()} (${hourPart}), then every ${PILOT_INTERVAL_MINUTES} minutes.`
  );

  _pilotStartTimer = setTimeout(() => {
    _pilotStartTimer = null;
    runPilotOnce().catch((err) => {
      console.error('[PilotCron] Unhandled first-run error:', err?.message || err);
    });
    _pilotTimer = setInterval(() => {
      runPilotOnce().catch((err) => {
        console.error('[PilotCron] Unhandled run error:', err?.message || err);
      });
    }, PILOT_INTERVAL_MS);
  }, firstDelayMs);
}

