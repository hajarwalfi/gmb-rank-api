import { randomUUID } from 'crypto';

import { isMongoReady } from '../db/mongo.js';
import { AutomationRunJob } from '../models/AutomationRunJob.js';
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
import { appendSnapshotFromAutomationPayload, makeGmbKey } from './gmbTrackingHistory.service.js';
import { getHistory } from './historyManager.js';
import { readActiveGmbJson } from './supabaseGmb.service.js';
import {
  buildSupabaseTargetsWithMinKeywords,
  filterLocationTargetsMinKeywords,
} from './gmbKeywordCountCache.service.js';
import { cleanKeyword } from '../utils/trafficCalculator.js';
import { randomIntInclusive } from './keywordGeneration.service.js';
import { readServicesKeywordsPayload, locationsFromServicesKeywords } from './servicesKeywordsSnapshot.service.js';
import {
  getAutomationMissingJsonAudit,
  getLatestAutomationMissingJsonAudit,
  initAutomationMissingJsonAudit,
  markAutomationMissingJsonStatus,
  recordAutomationMissingJsonOutcome,
} from './automationMissingJsonAudit.service.js';

const schedulerTimers = new Map();
let schedulerBootstrapped = false;
let schedulerSweepTimer = null;
/** Mongo can connect after startup; retries until ready (must NOT set bootstrap early). */
let mongoSchedulerRetryInterval = null;

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
  if (Array.isArray(sa)) return sa.map((s) => String(s || '').trim()).filter(Boolean);
  const out = [];
  if (Array.isArray(sa?.places?.placeInfos)) {
    for (const p of sa.places.placeInfos) {
      const v = p?.placeName || p?.placeId;
      if (v) out.push(String(v));
    }
  }
  if (Array.isArray(sa?.regions)) {
    for (const r of sa.regions) {
      const v = r?.displayName || r?.name || r?.regionCode || r?.placeId || '';
      if (v) out.push(String(v));
    }
  }
  return out.map((s) => String(s || '').trim()).filter(Boolean);
}

function toLiveScreenshotPath(screenshotPath) {
  const rel = String(screenshotPath || '').trim().replace(/^\/+/, '');
  if (!rel) return null;
  if (/^https?:\/\//i.test(rel)) return rel;
  return `/api/outputs/${rel}`;
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

function normalizeKeywordList(list = []) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const kw of list) {
    const text = String(kw || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function buildCappedKeywords({ preferredKeywords = [], fallbackKeywords = [] } = {}) {
  const minRaw = Number(process.env.AUTOMATION_KEYWORDS_PER_GMB_MIN || 4);
  const maxRaw = Number(process.env.AUTOMATION_KEYWORDS_PER_GMB_MAX || 8);
  const max = Math.max(1, Math.floor(Number.isFinite(maxRaw) ? maxRaw : 8));
  const min = Math.max(1, Math.min(max, Math.floor(Number.isFinite(minRaw) ? minRaw : 4)));

  const preferred = normalizeKeywordList(preferredKeywords);
  const fallback = normalizeKeywordList(fallbackKeywords);
  const picked = [];
  const seen = new Set();

  const pushIfNeeded = (kw) => {
    const key = String(kw || '').trim().toLowerCase();
    if (!key || seen.has(key) || picked.length >= max) return;
    seen.add(key);
    picked.push(String(kw).trim());
  };

  preferred.forEach(pushIfNeeded);
  if (picked.length < min) {
    fallback.forEach(pushIfNeeded);
  }
  const runCap = randomIntInclusive(min, max);
  return picked.slice(0, Math.min(picked.length, runCap));
}

async function withRetry(taskLabel, fn, retries = 2, baseMs = 1200) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < retries && isRetryableError(err);
      console.warn(
        `[AutomationRun] ${taskLabel} failed (attempt ${attempt}/${retries}): ${String(err?.message || err)}`
      );
      if (!canRetry) break;
      await sleep(baseMs * attempt);
    }
  }
  throw lastErr;
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

function normalizeKeyword(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Last path segment — works for `362…`, `locations/362…`, or full resource names. */
function locationIdTail(id) {
  return String(id || '')
    .trim()
    .split('/')
    .filter(Boolean)
    .pop() || '';
}

function accountIdsMatch(requested, candidate) {
  const a = String(requested || '').trim();
  const b = String(candidate || '').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  return locationIdTail(a) === locationIdTail(b);
}

function locationIdsMatchForAutomation(requestedId, loc) {
  const lid = String(requestedId || '').trim();
  const lidShort = locationIdTail(lid);
  const targetLid = String(loc?.locationId || '').trim();
  const targetLidShort = String(loc?.locationIdShort || '').trim() || locationIdTail(targetLid);
  if (!lid && !lidShort) return false;
  if (lid && lid === targetLid) return true;
  if (lidShort && lidShort === targetLidShort) return true;
  if (lid && locationIdTail(lid) === targetLidShort) return true;
  return false;
}

/** Same pool as Settings UI (`/api/services-keywords?view=locations`). */
async function resolveLocationFromServicesKeywords(accountId, locationId) {
  const aid = String(accountId || '').trim();
  const lidShort = locationIdTail(locationId);
  if (!aid || !lidShort) return null;

  const payload = await readServicesKeywordsPayload();
  const rows = locationsFromServicesKeywords(payload?.rows || []);
  const row = rows.find((r) => {
    if (!accountIdsMatch(aid, r.accountId)) return false;
    const rShort = locationIdTail(r.locationId || r.locationIdShort);
    return rShort === lidShort;
  });
  if (!row) return null;

  const locationIdShort = locationIdTail(row.locationId || row.locationIdShort);
  const canonicalLocationId = String(row.locationId || '').includes('/')
    ? String(row.locationId).trim()
    : `locations/${locationIdShort}`;

  let locationDetails = {
    title: row.title,
    categories: { primaryCategory: { displayName: row.niche || 'Business' } },
    serviceArea: { places: { placeInfos: [] }, regions: [] },
    serviceItems: [],
    storefrontAddress: null,
  };
  const areasFromRow = [
    ...(Array.isArray(row.serviceAreasExplicit) ? row.serviceAreasExplicit : []),
    row.serviceAreasFallback ? String(row.serviceAreasFallback) : '',
  ]
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  try {
    locationDetails = await GmbService.getLocationFull(aid, locationIdShort);
  } catch (e) {
    console.warn(
      `[AutomationRun] getLocationFull failed for ${row.title} (${locationIdShort}); using services-keywords metadata:`,
      e?.message || e
    );
    if (areasFromRow.length) {
      locationDetails.serviceArea = { places: { placeInfos: areasFromRow.map((n) => ({ placeName: n })) } };
    }
  }

  const primaryCategory = getPrimaryCategory(locationDetails) || String(row.niche || '').trim() || 'Business';
  const areas = getAreas(locationDetails);
  const keywords =
    Array.isArray(row.keywords) && row.keywords.length > 0 ? row.keywords : [];

  return {
    selected: {
      accountId: aid,
      locationId: canonicalLocationId,
      locationIdShort,
      title: row.title,
    },
    locationIdShort,
    primaryCategory,
    areas: areas.length ? areas : areasFromRow,
    keywords,
    locationDetails,
  };
}

async function resolveLocationAndKeywords({ accountId, locationId }) {
  if (String(accountId).trim() === 'supabase') {
    const normalizeName = (v) =>
      String(v || '')
        .toLowerCase()
        .replace(/[’']/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    const data = await readActiveGmbJson();
    const readyList = Array.isArray(data?.count) ? data.count : [];
    const selected = readyList.find(c => c.id === locationId);

    if (!selected) {
      throw new Error(`Location ${locationId} not found in Supabase ready list.`);
    }

    const keywords = Array.isArray(selected.keywords) && selected.keywords.length > 0
      ? selected.keywords
      : [];

    // Map Supabase UUID entry -> real connected GMB account/location when available
    let mappedAccountId = 'supabase';
    let mappedLocationId = selected.id;
    let mappedLocationShort = selected.id;
    try {
      const { businesses } = await GmbService.readLocationsSnapshot();
      const byName = new Map(
        (businesses || []).map((b) => [normalizeName(b?.title || b?.gmbName || ''), b])
      );
      const hit = byName.get(normalizeName(selected.business_name)) || null;
      if (hit?.accountId && hit?.locationId) {
        mappedAccountId = String(hit.accountId).trim();
        mappedLocationId = String(hit.locationId).trim();
        mappedLocationShort =
          String(hit.locationIdShort || '').trim() ||
          String(hit.locationId).replace(/^locations\//, '').trim();
      }
    } catch {
      // Keep supabase fallback IDs if mapping cannot be resolved.
    }

    return {
      selected: {
        accountId: mappedAccountId,
        locationId: mappedLocationId,
        locationIdShort: mappedLocationShort,
        title: selected.business_name,
      },
      locationIdShort: mappedLocationShort,
      primaryCategory: selected.niche || 'Business',
      areas: selected.region ? [selected.region] : [],
      keywords,
      locationDetails: {
        title: selected.business_name,
        categories: { primaryCategory: { displayName: selected.niche || 'Business' } },
        serviceArea: { places: { placeInfos: [] }, regions: [] }
      },
    };
  }

  const allLocations = await GmbService.listAllLocations({
    preferJson: true,
    allowLiveFallback: true,
  });
  const aid = String(accountId || '').trim();
  const selected = allLocations.find(
    (loc) => accountIdsMatch(aid, loc?.accountId) && locationIdsMatchForAutomation(locationId, loc)
  );
  if (!selected) {
    const fromKeywords = await resolveLocationFromServicesKeywords(accountId, locationId);
    if (fromKeywords) {
      console.log(
        `[AutomationRun] Resolved "${fromKeywords.selected.title}" from services-keywords (not in gmb_connected_businesses snapshot).`
      );
      if (!fromKeywords.keywords.length) {
        const baseKeywords = RankingService.buildKeywords(
          fromKeywords.primaryCategory,
          fromKeywords.areas
        );
        const aiKeywords = await generateKeywords(
          fromKeywords.selected.title,
          fromKeywords.primaryCategory,
          fromKeywords.areas
        );
        fromKeywords.keywords = mergeKeywordLists(baseKeywords, aiKeywords);
      }
      return fromKeywords;
    }
    throw new Error(
      'We could not find that GMB location for automation scheduling. It may be missing from the connected GMB snapshot (refresh gmb_connected_businesses.json) or have no keywords in services-keywords.json.'
    );
  }

  const locationIdShort =
    selected.locationIdShort ||
    String(selected.locationId || '')
      .split('/')
      .filter(Boolean)
      .pop() ||
    '';

  let locationDetails = {
    title: selected.title,
    categories: { primaryCategory: { displayName: '' } },
    serviceArea: { places: { placeInfos: [] }, regions: [] },
    serviceItems: [],
    storefrontAddress: null,
  };
  try {
    locationDetails = await GmbService.getLocationFull(selected.accountId, locationIdShort);
  } catch (e) {
    console.warn(
      `[AutomationRun] getLocationFull failed for "${selected.title}" (${locationIdShort}); using services-keywords metadata:`,
      e?.message || e
    );
    try {
      const skPayload = await readServicesKeywordsPayload();
      const skRows = skPayload?.rows || [];
      const skRow = skRows.find(
        (r) =>
          String(r.accountId || '').trim() === String(selected.accountId || '').trim() &&
          String(r.locationIdShort || r.locationId || '').trim() === locationIdShort
      );
      if (skRow?.gbpDetailSnapshot) {
        locationDetails = skRow.gbpDetailSnapshot;
      } else if (skRow) {
        const areas = Array.isArray(skRow.serviceAreasExplicit) ? skRow.serviceAreasExplicit : [];
        if (areas.length) {
          locationDetails.serviceArea = { places: { placeInfos: areas.map((n) => ({ placeName: n })) } };
        }
        if (skRow.primaryCategory) {
          locationDetails.categories = { primaryCategory: { displayName: skRow.primaryCategory } };
        }
      }
    } catch {
      // keep default locationDetails
    }
  }

  const primaryCategory = getPrimaryCategory(locationDetails) || String(selected.niche || '').trim() || 'Business';
  const areas = getAreas(locationDetails);

  let keywords = [];
  try {
    const payload = await readServicesKeywordsPayload();
    const allRows = locationsFromServicesKeywords(payload?.rows || []);
    const match = allRows.find(r => 
      String(r.accountId).trim() === String(selected.accountId).trim() &&
      String(r.locationIdShort).trim() === String(locationIdShort).trim()
    );
    if (match && Array.isArray(match.keywords) && match.keywords.length > 0) {
      keywords = match.keywords;
      console.log(`[AutomationRun] Using ${keywords.length} keywords from services-keywords snapshot for "${selected.title}"`);
    }
  } catch (e) {
    console.warn('[AutomationRun] Could not read services-keywords snapshot:', e.message);
  }

  if (!keywords.length) {
    const baseKeywords = RankingService.buildKeywords(primaryCategory, areas);
    const aiKeywords = await generateKeywords(selected.title, primaryCategory, areas);
    keywords = mergeKeywordLists(baseKeywords, aiKeywords);
  }
  return {
    selected,
    locationIdShort,
    primaryCategory,
    areas,
    keywords,
    locationDetails,
  };
}

function serializeJob(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id: String(o._id),
    allLocations: Boolean(o.allLocations),
    status: o.status,
    scheduleType: o.scheduleType,
    scheduledAt: o.scheduledAt,
    startedAt: o.startedAt || null,
    finishedAt: o.finishedAt || null,
    cancelRequested: Boolean(o.cancelRequested),
    cancelRequestedAt: o.cancelRequestedAt || null,
    stopMode: o.stopMode || 'graceful',
    recurrence: o.recurrence || 'once',
    businessName: o.businessName || '',
    gmbKey: o.gmbKey || '',
    accountId: o.accountId || '',
    locationId: o.locationId || '',
    locationTitle: o.locationTitle || '',
    keywordMode: o.keywordMode || 'all',
    selectedKeywords: Array.isArray(o.selectedKeywords) ? o.selectedKeywords : [],
    resolvedKeywords: Array.isArray(o.resolvedKeywords) ? o.resolvedKeywords : [],
    locationTargets: Array.isArray(o.locationTargets) ? o.locationTargets : [],
    progress: o.progress || {},
    result: o.result || {},
    hideFromBanner: Boolean(o.hideFromBanner),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

async function saveJobProgress(jobId, progressPatch = {}) {
  await AutomationRunJob.updateOne(
    { _id: jobId },
    {
      $set: {
        'progress.total': Number(progressPatch.total || 0),
        'progress.processed': Number(progressPatch.processed || 0),
        'progress.success': Number(progressPatch.success || 0),
        'progress.found': Number(progressPatch.found || 0),
        'progress.failed': Number(progressPatch.failed || 0),
        'progress.currentKeyword': String(progressPatch.currentKeyword || ''),
        'progress.currentLocationTitle': String(progressPatch.currentLocationTitle || ''),
        'progress.totalLocations': Number(progressPatch.totalLocations || 0),
        'progress.processedLocations': Number(progressPatch.processedLocations || 0),
      },
    }
  );
}

async function appendLiveRow(jobId, row) {
  await AutomationRunJob.updateOne(
    { _id: jobId },
    {
      $push: {
        'result.liveRows': {
          locationTitle: String(row.locationTitle || ''),
          keyword: String(row.keyword || ''),
          status: String(row.status || 'pending'),
          found: Boolean(row.found),
          rank: row.rank != null && Number.isFinite(Number(row.rank)) ? Number(row.rank) : null,
          screenshotPath: row.screenshotPath || null,
          screenshotUrl: row.screenshotUrl || null,
          volume: Number(row.volume) || 0,
          estimated_clicks: Number(row.estimated_clicks) || 0,
          daily_traffic: Number(row.daily_traffic) || 0,
          error: row.error ? String(row.error).slice(0, 800) : null,
        },
      },
    }
  );
}

function calculateNextRun(recurrence, lastRunDate) {
  if (!recurrence || recurrence === 'once') return null;
  const next = new Date(lastRunDate);
  if (recurrence === '10mins') next.setMinutes(next.getMinutes() + 10);
  if (recurrence === '30mins') next.setMinutes(next.getMinutes() + 30);
  if (recurrence === '45mins') next.setMinutes(next.getMinutes() + 45);
  else if (recurrence === '2days') next.setDate(next.getDate() + 2);
  else if (recurrence === '5days') next.setDate(next.getDate() + 5);
  else if (recurrence === 'weekly') next.setDate(next.getDate() + 7);
  else if (recurrence === '14days') next.setDate(next.getDate() + 14);
  // Backward compatibility for already-saved jobs.
  else if (recurrence === '15days') next.setDate(next.getDate() + 15);
  else if (recurrence === '20days') next.setDate(next.getDate() + 20);
  else if (recurrence === 'monthly') next.setMonth(next.getMonth() + 1);
  return next;
}

async function executeJob(jobId) {
  const job = await AutomationRunJob.findById(jobId);
  if (!job || job.status !== 'scheduled') return;
  console.log(
    `[AutomationRun] executeJob start job=${jobId} status=${job.status} scheduledAt=${new Date(job.scheduledAt).toISOString()}`
  );
  console.log(
    `[AutomationRun] Job session business="${String(job.businessName || '').trim()}" gmbKey="${String(job.gmbKey || '').trim()}" targets=${Array.isArray(job.locationTargets) ? job.locationTargets.length : 0} keywordMode=${String(job.keywordMode || 'all')} hideFromBanner=${Boolean(job.hideFromBanner)} (same pipeline as GMB manual Search All → DataForSEO + Google local screenshot)`
  );
  const existingLiveRows = Array.isArray(job?.result?.liveRows) ? job.result.liveRows : [];
  const resumeMode = existingLiveRows.length > 0 || Number(job?.progress?.processed || 0) > 0;
  const isReusableCompletedRow = (row) => {
    const status = String(row?.status || '').toLowerCase();
    const hasRank = row?.rank != null && Number.isFinite(Number(row.rank));
    const hasScreenshot = Boolean(String(row?.screenshotUrl || row?.screenshotPath || '').trim());
    // Resume rule: only rank + screenshot completed rows are final and should be skipped.
    return status === 'done' && hasRank && hasScreenshot;
  };
  const reusableRows = existingLiveRows.filter(isReusableCompletedRow);

  const runningPatch = {
    status: 'running',
    startedAt: new Date(),
    finishedAt: null,
    cancelRequested: false,
    cancelRequestedAt: null,
    stopMode: 'graceful',
  };
  if (!resumeMode) {
    runningPatch['result.liveRows'] = [];
  }
  await AutomationRunJob.updateOne({ _id: jobId, status: 'scheduled' }, { $set: runningPatch });
  schedulerTimers.delete(String(jobId));

  const startedAt = new Date();
  const errors = [];
  let finalGallery = { publicId: null, galleryUrl: null, reason: null };
  let totalSuccess = reusableRows.length;
  let totalFound = reusableRows.length;
  let totalFailed = 0;
  let totalProcessed = reusableRows.length;
  let totalKeywords = 0;
  let processedLocations = 0;
  let cancelled = false;
  let hardAbort = false;

  if (resumeMode) {
    console.log(
      `[AutomationRun] Resume mode for job ${jobId}: recoveredRows=${existingLiveRows.length}, reusableCompleted=${reusableRows.length}`
    );
  } else {
    console.log(`[AutomationRun] Fresh run for job ${jobId}`);
  }

  try {
    if (!dataForSeoConfigured()) {
      throw new Error('DataForSEO is not configured. Please set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD.');
    }
    let targets = [];
    if (job.allLocations) {
      console.log(
        `[AutomationRun] Job ${jobId} is "Select All" — loading paying+active locations with keyword cache count >= 1...`
      );
      try {
        targets = await buildSupabaseTargetsWithMinKeywords(1);
        console.log(`[AutomationRun] Dynamic "Select All": ${targets.length} locations with generated keywords.`);
      } catch (e) {
        console.warn(`[AutomationRun] Dynamic fetch failed, falling back to cached targets:`, e.message);
        targets = Array.isArray(job.locationTargets) && job.locationTargets.length
          ? job.locationTargets
          : [{ accountId: job.accountId, locationId: job.locationId, title: job.locationTitle || job.businessName || '' }];
        targets = await filterLocationTargetsMinKeywords(targets, 1);
      }
    } else {
      targets = Array.isArray(job.locationTargets) && job.locationTargets.length
        ? job.locationTargets
        : [{ accountId: job.accountId, locationId: job.locationId, title: job.locationTitle || job.businessName || '' }];
      targets = await filterLocationTargetsMinKeywords(targets, 1);
    }

    if (!targets.length) {
      throw new Error(
        'No GMB locations to run: every target has 0 keywords in services-keywords snapshot. Generate keywords first (POST /api/services-keywords/rebuild).'
      );
    }
    await initAutomationMissingJsonAudit({
      jobId,
      allLocations: Boolean(job.allLocations),
      scheduledAt: job?.scheduledAt ? new Date(job.scheduledAt).toISOString() : null,
      targets,
    });
    await markAutomationMissingJsonStatus(jobId, 'running');

    // Keep denominator stable by default, but allow growth when brand-new GBP locations
    // appear during long-running "select all" jobs.
    let scheduledLocationTotal = Math.max(
      1,
      Number(job.progress?.totalLocations) > 0
        ? Number(job.progress.totalLocations)
        : targets.length
    );

    const seenTargetKeys = new Set(
      targets.map((t) => `${String(t?.accountId || '').trim()}::${String(t?.locationId || '').trim()}`)
    );

    for (let li = 0; li < targets.length; li++) {
      const target = targets[li];

      // 2-scan limit check for Supabase locations
      if (target.accountId === 'supabase') {
        try {
          const history = await getHistory(target.locationId);
          const scanCount = Number(history?.total_scans || 0);
          if (scanCount >= 2) {
            console.log(`[AutomationRun] Skipping "${target.title}" - Already reached 2-scan limit.`);
            processedLocations += 1;
            continue;
          }
        } catch (hErr) {
          console.warn(`[AutomationRun] Could not check scan count for ${target.title}:`, hErr.message);
        }
      }

      if (process.env.STOP_ALL_AUTOMATION === 'true') {
        console.warn(`[AutomationRun] Global STOP_ALL_AUTOMATION detected. Aborting job ${jobId}.`);
        cancelled = true;
        hardAbort = true;
        break;
      }

      const liveJobState = await AutomationRunJob.findById(jobId).select('cancelRequested');
      if (!liveJobState) {
        // Job was hard-removed (emergency kill). Stop immediately.
        cancelled = true;
        hardAbort = true;
        break;
      }
      if (liveJobState?.cancelRequested) {
        cancelled = true;
        break;
      }

      const resolved = await resolveLocationAndKeywords({
        accountId: target.accountId,
        locationId: target.locationId,
      });
      const preferredKeywords =
        job.keywordMode === 'selective' && Array.isArray(job.selectedKeywords) && job.selectedKeywords.length > 0
          ? job.selectedKeywords
          : resolved.keywords;
      const chosenKeywords = buildCappedKeywords({
        preferredKeywords,
        fallbackKeywords: resolved.keywords,
      });
      console.log(
        `[AutomationRun] Location ${li + 1}/${targets.length} "${resolved.selected.title}" keywords=${chosenKeywords.length}`
      );

      const locationHint = (Array.isArray(resolved.areas) ? resolved.areas.join(', ') : '') || resolved.areas?.[0] || '';
      const keywordResults = [];
      totalKeywords += chosenKeywords.length;

      let gmbMonthlyClicks = null;
      try {
        if (GmbService.hasGmbConfig()) {
          // Use resolved IDs (mapped real GMB account/location for Supabase-backed rows)
          gmbMonthlyClicks = await GmbService.getMonthlyClicks(
            resolved.selected.accountId,
            resolved.selected.locationId,
            { businessName: resolved.selected.title || resolved.locationDetails.title }
          );
        }
      } catch (gErr) {
        console.warn('[AutomationRun] GBP monthly clicks fetch failed:', gErr.message);
      }

      await AutomationRunJob.updateOne(
        { _id: jobId },
        {
          $set: {
            businessName: resolved.selected.title || '',
            locationTitle: resolved.selected.title || '',
            locationIdShort: resolved.locationIdShort || '',
            primaryCategory: resolved.primaryCategory || '',
            areas: resolved.areas || [],
            resolvedKeywords: chosenKeywords,
            gmbKey: makeGmbKey(resolved.selected.locationId, resolved.selected.title),
          },
        }
      );

      for (let i = 0; i < chosenKeywords.length; i++) {
        const liveState = await AutomationRunJob.findById(jobId).select('cancelRequested stopMode');
        if (!liveState) {
          // Job was hard-removed (emergency kill). Stop immediately.
          cancelled = true;
          hardAbort = true;
          break;
        }
        if (process.env.STOP_ALL_AUTOMATION === 'true' || liveState?.cancelRequested) {
          cancelled = true;
          if (process.env.STOP_ALL_AUTOMATION === 'true' || String(liveState?.stopMode || '') === 'immediate') {
            hardAbort = true;
            break;
          }
          if (i === 0) break;
        }

        const keyword = chosenKeywords[i];
        const existingRow = reusableRows.find(
          (r) =>
            String(r?.locationTitle || '').trim().toLowerCase() === String(resolved.selected.title || '').trim().toLowerCase() &&
            String(r?.keyword || '').trim().toLowerCase() === String(keyword || '').trim().toLowerCase() &&
            isReusableCompletedRow(r)
        );
        if (existingRow) {
          // Resume mode: this keyword has finalized rank + screenshot output.
          console.log(
            `[AutomationRun] Resume skip keyword "${keyword}" at "${resolved.selected.title}" (already finalized)`
          );
          continue;
        }
        console.log(
          `[AutomationRun] Processing keyword ${i + 1}/${chosenKeywords.length} "${keyword}" at "${resolved.selected.title}"`
        );
        console.log(
          `[AutomationRun] Capture pipeline job=${jobId} step=dataforseo+google_lcl keyword="${keyword}" location="${resolved.selected.title}" area="${String(locationHint || '').slice(0, 120)}"`
        );

        const cleaningContext = `${target.title}, ${locationHint}`;
        const cleanedKw = cleanKeyword(keyword, cleaningContext);
        const gmb = gmbMonthlyClicks || null;
        const monthlyTotal = Math.max(0, Number(gmb?.total_clicks) || 0);
        const repDays = Math.max(1, Number(gmb?.reporting_days ?? gmb?.daysElapsed) || 1);
        const dailyAvg = Math.round((monthlyTotal / repDays) * 10) / 10;

        await saveJobProgress(jobId, {
          total: totalKeywords,
          processed: totalProcessed,
          success: totalSuccess,
          found: totalFound,
          failed: totalFailed,
          currentKeyword: keyword,
          currentLocationTitle: resolved.selected.title,
          totalLocations: scheduledLocationTotal,
          processedLocations,
        });

        const row = {
          keyword,
          location: locationHint,
          success: false,
          found: false,
          rank: null,
          title: null,
          page: null,
          screenshotPath: null,
          screenshotLivePath: null,
          message: null,
          error: null,
          // Traffic: GBP Performance (same location totals for every keyword row)
          target_keyword: cleanedKw,
          source_month: gmb?.month || 'N/A',
          volume: monthlyTotal,
          days: repDays,
          raw_traffic_data: gmb || null,
          estimated_clicks: monthlyTotal,
          daily_traffic: dailyAvg,
        };
        try {
          const out = await withRetry(`automation keyword "${keyword}"`, async () => {
            const { items, checkUrl, totalItems } = await fetchDataForSeoLocalFinder({
              keyword: String(keyword),
              location: String(locationHint || '').trim(),
              device: 'desktop',
              os: 'windows',
            });
            const match = findBusinessInDataForSeoItems(
              items,
              resolved.selected.title,
              keyword,
              String(locationHint || ''),
              checkUrl
            );
            if (!match.found) return { kind: 'not_found', totalItems };
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
                  scrollToTitle: String(match.title || resolved.selected.title || '').trim(),
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
              cap?.displayRank != null && Number.isFinite(Number(cap.displayRank))
                ? Number(cap.displayRank)
                : scanRank;
            return { kind: 'ok', rank: rankOut, title: match.title || resolved.selected.title, page: match.page ?? null, screenshotPath: cap?.screenshotPath || null };
          });

          if (out.kind === 'not_found') {
            row.success = true;
            row.found = false;
            row.message = `"${resolved.selected.title}" not in Local Finder (~${out.totalItems} items).`;
            totalSuccess += 1;
            await appendLiveRow(jobId, {
              locationTitle: resolved.selected.title,
              keyword,
              status: 'not_found',
              found: false,
              rank: null,
              screenshotPath: null,
              screenshotUrl: null,
            });
            console.log(
              `[AutomationRun] Completed keyword "${keyword}" => not_found`
            );
          } else if (out.kind === 'serp_unverified') {
            row.success = true;
            row.found = false;
            row.message = out.message || 'Live SERP page did not match business (strict verification).';
            totalSuccess += 1;
            await appendLiveRow(jobId, {
              locationTitle: resolved.selected.title,
              keyword,
              status: 'not_found',
              found: false,
              rank: null,
              screenshotPath: null,
              screenshotUrl: null,
            });
            console.log(`[AutomationRun] Completed keyword "${keyword}" => serp_unverified`);
          } else {
            row.success = true;
            row.found = true;
            row.rank = out.rank;
            row.title = out.title;
            row.page = out.page;
            row.screenshotPath = out.screenshotPath || null;
            row.screenshotLivePath = toLiveScreenshotPath(row.screenshotPath);
            totalSuccess += 1;
            totalFound += 1;

            await appendLiveRow(jobId, {
              locationTitle: resolved.selected.title,
              keyword,
              status: 'done',
              found: true,
              rank: row.rank,
              screenshotPath: row.screenshotPath,
              screenshotUrl: row.screenshotLivePath,
              volume: row.volume,
              estimated_clicks: row.estimated_clicks,
              daily_traffic: row.daily_traffic,
            });
            console.log(
              `[AutomationRun] Completed keyword "${keyword}" => rank=${row.rank} screenshot=${Boolean(row.screenshotPath)}`
            );
          }
        } catch (e) {
          row.error = String(e?.message || e).slice(0, 800);
          row.success = false;
          totalFailed += 1;
          await appendLiveRow(jobId, {
            locationTitle: resolved.selected.title,
            keyword,
            status: 'error',
            found: false,
            rank: null,
            screenshotPath: null,
            screenshotUrl: null,
            error: row.error,
          });
          console.warn(
            `[AutomationRun] Keyword failed "${keyword}" at "${resolved.selected.title}": ${row.error}`
          );
        }
        keywordResults.push(row);
        totalProcessed += 1;
        await saveJobProgress(jobId, {
          total: totalKeywords,
          processed: totalProcessed,
          success: totalSuccess,
          found: totalFound,
          failed: totalFailed,
          currentKeyword: '',
          currentLocationTitle: resolved.selected.title,
          totalLocations: scheduledLocationTotal,
          processedLocations,
        });
      }

      if (hardAbort) {
        console.log(`[AutomationRun] Hard abort acknowledged for job ${jobId}. Stopping without further persistence steps.`);
        break;
      }

      const gallery = await createGalleryIfPossible({
        businessName: resolved.selected.title,
        locationHint,
        accountId: resolved.selected.accountId || '',
        locationId: resolved.selected.locationId || '',
        items: keywordResults.filter((r) => r.screenshotPath),
      });
      finalGallery = gallery.publicId ? gallery : finalGallery;

      const basePayload = {
        job: {
          id: String(jobId),
          name: 'automation_one_time',
          scheduleType: 'one_time',
          startedAt: startedAt.toISOString(),
        },
        gmbLocation: {
          accountId: resolved.selected.accountId,
          locationId: resolved.selected.locationId,
          locationIdShort: resolved.locationIdShort,
          title: resolved.selected.title,
          primaryCategory: resolved.primaryCategory,
          areas: resolved.areas,
        },
        keywordSummary: {
          total: keywordResults.length,
          success: keywordResults.filter((k) => k.success).length,
          failed: keywordResults.filter((k) => !k.success).length,
          found: keywordResults.filter((k) => k.found).length,
          notFound: keywordResults.filter((k) => !k.found).length,
        },
        keywords: keywordResults,
        gallery: {
          publicId: gallery.publicId,
          link: gallery.galleryUrl,
          note: gallery.reason || null,
        },
        errors: [],
      };
      let persistOut = null;
      try {
        persistOut = await appendSnapshotFromAutomationPayload(basePayload, startedAt);
      } catch (persistErr) {
        await recordAutomationMissingJsonOutcome(jobId, {
          accountId: resolved.selected.accountId || '',
          locationId: resolved.selected.locationId || '',
          locationTitle: resolved.selected.title || '',
          gmbKey: makeGmbKey(resolved.selected.locationId, resolved.selected.title),
          persistedToHistory: false,
          reason: `append_failed:${String(persistErr?.message || persistErr || 'unknown')}`,
        });
        throw persistErr;
      }
      await recordAutomationMissingJsonOutcome(jobId, {
        accountId: resolved.selected.accountId || '',
        locationId: resolved.selected.locationId || '',
        locationTitle: resolved.selected.title || '',
        gmbKey: makeGmbKey(resolved.selected.locationId, resolved.selected.title),
        persistedToHistory: Boolean(persistOut?.historySaved),
        reason: persistOut?.historySaved ? 'saved' : (persistOut?.historySaveError || 'legacy_history_not_saved'),
      });
      processedLocations += 1;
      // Flush location count to DB now so /active-latest polls do not show stale 0/640
      // until the next location's first keyword (resolve + GMB + setup can take a long time).
      await saveJobProgress(jobId, {
        total: totalKeywords,
        processed: totalProcessed,
        success: totalSuccess,
        found: totalFound,
        failed: totalFailed,
        currentKeyword: '',
        currentLocationTitle: resolved.selected.title,
        totalLocations: scheduledLocationTotal,
        processedLocations,
      });

      // ── Auto-update dashboard metrics after each location ──
      try {
        const { default: snapshotService } = await import('./dashboardSnapshot.service.js');
        await snapshotService.takeSnapshot();
      } catch (snapErr) {
        console.warn(`[AutomationRun] Dashboard auto-snapshot failed for location "${resolved.selected.title}":`, snapErr.message);
      }

      // Dynamic "select all": after each location, merge any new paying+keyword rows that appeared
      // in `services-keywords.json` (e.g. nightly cron or manual rebuild while this job runs).
      if (job.allLocations && !cancelled && !hardAbort) {
        try {
          const latestTargets = await buildSupabaseTargetsWithMinKeywords(1);
          let addedNow = 0;
          for (const t of latestTargets) {
            const aid = String(t?.accountId || '').trim();
            const lid = String(t?.locationId || '').trim();
            const key = `${aid}::${lid}`;
            if (!aid || !lid || seenTargetKeys.has(key)) continue;
            seenTargetKeys.add(key);
            targets.push({
              accountId: aid,
              locationId: lid,
              title: String(t?.title || '').trim(),
            });
            addedNow += 1;
          }
          if (addedNow > 0) {
            scheduledLocationTotal = Math.max(scheduledLocationTotal, targets.length);
            console.log(
              `[AutomationRun] Merged ${addedNow} new snapshot target(s) into select-all job ${jobId} (total queue=${targets.length}).`
            );
          }
        } catch (refreshErr) {
          console.warn(
            `[AutomationRun] Mid-run services-keywords merge failed for job ${jobId}: ${String(refreshErr?.message || refreshErr)}`
          );
        }
      }
      if (cancelled) break;
    }

    console.log(
      `[AutomationRun] Finalizing job ${jobId}: cancelled=${cancelled} processed=${totalProcessed}/${totalKeywords} success=${totalSuccess} failed=${totalFailed}`
    );

    await AutomationRunJob.updateOne(
      { _id: jobId },
      {
        $set: {
          status: cancelled ? 'cancelled' : 'completed',
          finishedAt: new Date(),
          'progress.currentKeyword': '',
          'progress.currentLocationTitle': '',
          'progress.total': totalKeywords,
          'progress.processed': totalProcessed,
          'progress.success': totalSuccess,
          'progress.found': totalFound,
          'progress.failed': totalFailed,
          'progress.totalLocations': scheduledLocationTotal,
          'progress.processedLocations': processedLocations,
          result: {
            galleryPublicId: finalGallery.publicId || null,
            galleryUrl: finalGallery.galleryUrl || null,
            trackingSnapshotCount: null,
            rankHistoryPath: null,
            note: cancelled ? 'Automation stopped by user request.' : (finalGallery.reason || null),
            errors,
          },
        },
      }
    );
    await markAutomationMissingJsonStatus(jobId, cancelled ? 'cancelled' : 'completed');
    if (!cancelled) {
      await scheduleAutoFollowupForMissingHistory({ job, jobId });
    }

    // ── Handle Recurrence ──
    if (!cancelled && job.recurrence && job.recurrence !== 'once') {
      // FIX: Use original scheduledAt as base for the next cycle (Fixed Interval Scheduling)
      const nextScheduledAt = calculateNextRun(job.recurrence, job.scheduledAt);
      if (nextScheduledAt) {
        console.log(`[AutomationRun] Scheduling next run for job ${jobId} at ${nextScheduledAt.toISOString()}`);
        const nextJob = await AutomationRunJob.create({
          status: 'scheduled',
          scheduleType: job.scheduleType,
          recurrence: job.recurrence,
          allLocations: job.allLocations || false,
          hideFromBanner: Boolean(job.hideFromBanner),
          scheduledAt: nextScheduledAt,
          businessName: job.businessName,
          gmbKey: job.gmbKey,
          accountId: job.accountId,
          locationId: job.locationId,
          locationIdShort: job.locationIdShort,
          locationTitle: job.locationTitle,
          primaryCategory: job.primaryCategory,
          areas: job.areas || [],
          keywordMode: job.keywordMode || 'all',
          keywords: job.keywords || [],
          selectedKeywords: job.selectedKeywords || [],
          resolvedKeywords: job.resolvedKeywords || [],
          locationTargets: job.locationTargets || [],
          timezone: job.timezone || '',
          progress: {
            total: 0,
            processed: 0,
            success: 0,
            found: 0,
            failed: 0,
            processedLocations: 0,
            totalLocations:
              Number(job.progress?.totalLocations) > 0
                ? Number(job.progress.totalLocations)
                : (Array.isArray(job.locationTargets) && job.locationTargets.length
                  ? job.locationTargets.length
                  : 1),
          }
        });
        await initAutomationMissingJsonAudit({
          jobId: String(nextJob._id),
          allLocations: Boolean(nextJob.allLocations),
          scheduledAt: nextScheduledAt.toISOString(),
          targets: Array.isArray(nextJob.locationTargets) ? nextJob.locationTargets : [],
        });
        await markAutomationMissingJsonStatus(String(nextJob._id), 'scheduled');

        if (typeof scheduleJobTimer === 'function') {
          scheduleJobTimer(nextJob);
        }
      }
    }
  } catch (err) {
    const msg = String(err?.message || err);
    errors.push(msg);
    await markAutomationMissingJsonStatus(jobId, 'failed');
    await AutomationRunJob.updateOne(
      { _id: jobId },
      {
        $set: {
          status: 'failed',
          finishedAt: new Date(),
          'progress.currentKeyword': '',
          'progress.currentLocationTitle': '',
          'result.errors': errors,
        },
      }
    );
  }
}

function scheduleJobTimer(job) {
  const id = String(job._id);
  if (schedulerTimers.has(id)) {
    clearTimeout(schedulerTimers.get(id));
    schedulerTimers.delete(id);
  }
  const runAt = new Date(job.scheduledAt).getTime();
  const delay = Math.max(0, runAt - Date.now());
  console.log(
    `[AutomationRun] Timer armed job=${id} runAt=${new Date(runAt).toISOString()} delayMs=${delay}`
  );
  const timer = setTimeout(() => {
    console.log(`[AutomationRun] Timer elapsed for job=${id} starting executeJob`);
    executeJob(id).catch((e) => console.error('[AutomationRun] executeJob failed:', e?.message || e));
  }, delay);
  schedulerTimers.set(id, timer);
}

function isDueScheduledJob(job) {
  if (!job) return false;
  if (String(job.status || '') !== 'scheduled') return false;
  const runAt = new Date(job.scheduledAt).getTime();
  return Number.isFinite(runAt) && runAt <= Date.now();
}

function triggerDueJobIfNeeded(job) {
  if (!isDueScheduledJob(job)) return;
  const id = String(job._id || job.id || '');
  if (!id) return;
  executeJob(id).catch((e) => console.error('[AutomationRun] due trigger failed:', e?.message || e));
}

async function sweepAndRunDueScheduledJobs() {
  if (!isMongoReady()) return;
  const now = new Date();
  const dueJobs = await AutomationRunJob.find({
    status: 'scheduled',
    scheduledAt: { $lte: now },
  })
    .sort({ scheduledAt: 1 })
    .limit(20);

  for (const job of dueJobs) {
    const id = String(job._id);
    if (schedulerTimers.has(id)) continue;
    executeJob(id).catch((e) => console.error('[AutomationRun] due-job execute failed:', e?.message || e));
  }
}

export async function scheduleAutomationRun({
  accountId,
  locationId,
  selectedLocations = [],
  scheduledAtIso,
  recurrence = 'once',
  keywords = [],
  timezone = '',
  allLocations = false,
  skipMinLead = false,
  hideFromBanner = false,
}) {
  if (!isMongoReady()) {
    throw new Error('Automation scheduling is unavailable right now. Database is not connected.');
  }
  const scheduledAt = new Date(String(scheduledAtIso || ''));
  if (!Number.isFinite(scheduledAt.getTime())) {
    throw new Error('Please provide a valid date and time.');
  }
  const minAllowed = Date.now() + 5 * 60 * 1000;
  if (!skipMinLead && scheduledAt.getTime() < minAllowed) {
    throw new Error('Please choose a start time at least 5 minutes from now.');
  }

  const rawTargets = Array.isArray(selectedLocations) && selectedLocations.length
    ? selectedLocations
    : [{ accountId, locationId }];
  const dedup = new Map();
  for (const t of rawTargets) {
    const aid = String(t?.accountId || '').trim();
    const lid = String(t?.locationId || '').trim();
    if (!aid || !lid) continue;
    dedup.set(`${aid}::${lid}`, { accountId: aid, locationId: lid, title: String(t?.title || '').trim() });
  }
  let targets = [...dedup.values()];
  if (!targets.length && !allLocations) {
    throw new Error('Please select at least one GMB location.');
  }

  if (allLocations) {
    targets = await buildSupabaseTargetsWithMinKeywords(1);
  } else {
    targets = await filterLocationTargetsMinKeywords(targets, 1);
  }
  if (!targets.length) {
    throw new Error(
      'No GMB locations have generated keywords yet (keyword cache must show at least 1 keyword per location).'
    );
  }

  // Prime first location metadata for card preview.
  const resolved = await resolveLocationAndKeywords({
    accountId: targets[0].accountId,
    locationId: targets[0].locationId,
  });

  const finalKeywords = Array.isArray(keywords) && keywords.length > 0 ? keywords : resolved.keywords;
  const isSelective = Array.isArray(keywords) && keywords.length > 0;

  const job = await AutomationRunJob.create({
    status: 'scheduled',
    scheduleType: 'one_time',
    recurrence: recurrence || 'once',
    allLocations: Boolean(allLocations),
    hideFromBanner: Boolean(hideFromBanner),
    scheduledAt,
    businessName: resolved.selected.title || '',
    gmbKey: makeGmbKey(resolved.selected.locationId, resolved.selected.title),
    accountId: resolved.selected.accountId || '',
    locationId: resolved.selected.locationId || '',
    locationIdShort: resolved.locationIdShort || '',
    locationTitle: resolved.selected.title || '',
    primaryCategory: resolved.primaryCategory || '',
    areas: resolved.areas || [],
    keywordMode: isSelective ? 'selective' : 'all',
    selectedKeywords: isSelective ? keywords : [],
    resolvedKeywords: finalKeywords,
    locationTargets: targets,
    progress: {
      total: 0,
      processed: 0,
      success: 0,
      found: 0,
      failed: 0,
      currentKeyword: '',
      currentLocationTitle: '',
      totalLocations: targets.length,
      processedLocations: 0,
    },
    requestMeta: {
      timezone: String(timezone || '').trim(),
      requestedAt: new Date(),
    },
  });

  await initAutomationMissingJsonAudit({
    jobId: String(job._id),
    allLocations: Boolean(allLocations),
    scheduledAt: scheduledAt.toISOString(),
    targets,
  });
  await markAutomationMissingJsonStatus(String(job._id), 'scheduled');

  console.log(
    `[AutomationRun] Job created jobId=${String(job._id)} business="${String(resolved.selected.title || '').trim()}" immediate=${Boolean(
      skipMinLead
    )} scheduledAt=${scheduledAt.toISOString()} targets=${targets.length} keywordMode=${isSelective ? 'selective' : 'all'} keywordRows=${finalKeywords.length} hideFromBanner=${Boolean(hideFromBanner)}`
  );

  scheduleJobTimer(job);
  return {
    job: serializeJob(job),
    selectedLocationCount: targets.length,
  };
}

export async function getAutomationRunJob(jobId) {
  if (!isMongoReady()) return null;
  const job = await AutomationRunJob.findById(jobId);
  triggerDueJobIfNeeded(job);
  return serializeJob(job);
}

export async function getActiveAutomationRunForLocation({ accountId, locationId }) {
  if (!isMongoReady()) return null;
  const job = await AutomationRunJob.findOne({
    accountId: String(accountId || '').trim(),
    locationId: String(locationId || '').trim(),
    status: { $in: ['scheduled', 'running'] },
    hideFromBanner: { $ne: true },
  }).sort({ createdAt: -1 });
  triggerDueJobIfNeeded(job);
  return serializeJob(job);
}

export async function getLatestActiveAutomationRun() {
  if (!isMongoReady()) return null;
  // Prefer a running job (has live progress) over a newer only-scheduled one.
  const running = await AutomationRunJob.findOne({
    status: 'running',
    hideFromBanner: { $ne: true },
  }).sort({ updatedAt: -1, createdAt: -1 });
  if (running) {
    triggerDueJobIfNeeded(running);
    return serializeJob(running);
  }
  const job = await AutomationRunJob.findOne({
    status: 'scheduled',
    hideFromBanner: { $ne: true },
  }).sort({ createdAt: -1 });
  triggerDueJobIfNeeded(job);
  return serializeJob(job);
}

export async function getAutomationMissingJsonByJob(jobId) {
  return getAutomationMissingJsonAudit(jobId);
}

export async function getLatestAutomationMissingJson() {
  return getLatestAutomationMissingJsonAudit();
}

async function scheduleAutoFollowupForMissingHistory({ job, jobId }) {
  try {
    if (!job?.allLocations) return null;
    const depth = Number(job?.requestMeta?.autoFollowupDepth || 0);
    if (depth >= 1) return null; // prevent loops

    const audit = await getAutomationMissingJsonAudit(jobId);
    const missing = Array.isArray(audit?.missing) ? audit.missing : [];
    if (!missing.length) return null;

    const scheduledAt = new Date(Date.now() + 6 * 60 * 1000);
    const targets = missing.map((m) => ({
      accountId: String(m.accountId || '').trim(),
      locationId: String(m.locationId || '').trim(),
      title: String(m.locationTitle || '').trim(),
    })).filter((t) => t.accountId && t.locationId);

    if (!targets.length) return null;

    const nextJob = await AutomationRunJob.create({
      status: 'scheduled',
      scheduleType: 'one_time',
      recurrence: 'once',
      allLocations: false,
      scheduledAt,
      businessName: targets[0]?.title || '',
      gmbKey: makeGmbKey(targets[0]?.locationId, targets[0]?.title),
      accountId: targets[0]?.accountId || '',
      locationId: targets[0]?.locationId || '',
      locationTitle: targets[0]?.title || '',
      keywordMode: 'all',
      selectedKeywords: [],
      resolvedKeywords: [],
      locationTargets: targets,
      progress: {
        total: 0,
        processed: 0,
        success: 0,
        found: 0,
        failed: 0,
        currentKeyword: '',
        currentLocationTitle: '',
        totalLocations: targets.length,
        processedLocations: 0,
      },
      requestMeta: {
        timezone: String(job?.requestMeta?.timezone || '').trim(),
        requestedAt: new Date(),
        autoFollowupOfJobId: String(jobId),
        autoFollowupDepth: depth + 1,
      },
    });

    await initAutomationMissingJsonAudit({
      jobId: String(nextJob._id),
      allLocations: false,
      scheduledAt: scheduledAt.toISOString(),
      targets,
    });
    await markAutomationMissingJsonStatus(String(nextJob._id), 'scheduled');

    scheduleJobTimer(nextJob);
    console.log(
      `[AutomationRun] Auto-followup scheduled for missing history: parent=${jobId} next=${String(nextJob._id)} targets=${targets.length}`
    );
    return nextJob;
  } catch (e) {
    console.warn('[AutomationRun] Auto-followup schedule failed (non-fatal):', e?.message || e);
    return null;
  }
}

export async function requestStopAutomationRun(jobId, mode = 'graceful') {
  if (!isMongoReady()) throw new Error('Automation run database is not ready.');
  const normalizedMode = String(mode || '').toLowerCase() === 'immediate' ? 'immediate' : 'graceful';
  const job = await AutomationRunJob.findById(jobId);
  if (!job) throw new Error('Automation run not found.');
  if (!['scheduled', 'running'].includes(String(job.status || ''))) {
    throw new Error('This automation run is already finished.');
  }
  if (String(job.status) === 'running' && normalizedMode === 'immediate') {
    // Hard remove request: immediately hide from UI and prevent recurrence.
    await AutomationRunJob.deleteOne({ _id: jobId });
    return { ok: true, mode: normalizedMode, removed: true };
  }
  if (String(job.status) === 'scheduled') {
    const jobKey = String(job._id);
    const existing = schedulerTimers.get(jobKey);
    if (existing) {
      clearTimeout(existing);
      schedulerTimers.delete(jobKey);
    }
    await AutomationRunJob.deleteOne({ _id: jobId });
    return { ok: true, mode: normalizedMode, removed: true };
  }
  await AutomationRunJob.updateOne(
    { _id: jobId },
    {
      $set: {
        cancelRequested: true,
        cancelRequestedAt: new Date(),
        stopMode: normalizedMode,
      },
    }
  );
  return { ok: true, mode: normalizedMode, removed: false };
}

export async function startAutomationRunScheduler() {
  if (schedulerBootstrapped) return;
  if (!isMongoReady()) {
    console.warn(
      '[AutomationRun] MongoDB not connected — automation timers will retry every 15s until Mongo is up (scheduled jobs remain in DB).'
    );
    if (!mongoSchedulerRetryInterval) {
      mongoSchedulerRetryInterval = setInterval(() => {
        if (!isMongoReady()) return;
        clearInterval(mongoSchedulerRetryInterval);
        mongoSchedulerRetryInterval = null;
        startAutomationRunScheduler().catch((err) =>
          console.error('[AutomationRun] Scheduler start failed after Mongo connect:', err?.message || err)
        );
      }, 15000);
    }
    return;
  }

  try {
    const recovered = await AutomationRunJob.updateMany(
      { status: 'running' },
      {
        $set: {
          status: 'scheduled',
          startedAt: null,
          finishedAt: null,
          cancelRequested: false,
          cancelRequestedAt: null,
          stopMode: 'graceful',
          'result.note': 'Server restart recovered this run. Continuing from saved progress.',
        },
      }
    );
    const recoveredCount = Number(recovered?.modifiedCount || 0);
    if (recoveredCount > 0) {
      console.log(`[AutomationRun] Recovered ${recoveredCount} interrupted running job(s) to scheduled state.`);
    }

    const pending = await AutomationRunJob.find({ status: 'scheduled' }).sort({ scheduledAt: 1 });
    for (const job of pending) {
      scheduleJobTimer(job);
    }
    if (schedulerSweepTimer) {
      clearInterval(schedulerSweepTimer);
      schedulerSweepTimer = null;
    }
    // Safety net: if an in-memory timer is lost (restart/hot-reload/process mismatch),
    // overdue scheduled jobs are still picked up and started automatically.
    schedulerSweepTimer = setInterval(() => {
      sweepAndRunDueScheduledJobs().catch((e) =>
        console.error('[AutomationRun] scheduler sweep failed:', e?.message || e)
      );
    }, 15000);

    schedulerBootstrapped = true;
    console.log(`[AutomationRun] Scheduler armed for ${pending.length} pending scheduled job(s).`);
  } catch (err) {
    console.error('[AutomationRun] Scheduler init failed:', err?.message || err);
    schedulerBootstrapped = false;
    setTimeout(() => {
      startAutomationRunScheduler().catch((e2) =>
        console.error('[AutomationRun] Scheduler retry failed:', e2?.message || e2)
      );
    }, 15000);
  }
}
