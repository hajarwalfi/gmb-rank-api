/**
 * DataForSEO Local Finder → rank_absolute → check_url → Scrapfly Screenshot API + cloud browser → screenshot
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { chromium } from 'playwright';
import OpenAI from 'openai';
import sharp from 'sharp';
import {
  isStrictGmbNameMatch,
  normalizeGmbNameForMatch,
  isCaptchaPage,
  SerpListingVerificationError,
} from './ranking.service.js';
import { extractRecaptchaSiteKey, solveRecaptchaV2, injectRecaptchaV2Token } from './captcha2.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.join(__dirname, '../../outputs/screenshots');
const require = createRequire(import.meta.url);

function getSharedOpenAiClient() {
  try {
    const shared = require('../../../../config/openai.js');
    if (shared && shared.chat?.completions?.create) return shared;
  } catch {
    // fallback to env-backed client
  }
  return null;
}

/** US 2-letter → full name (DataForSEO `location_name` uses full names, e.g. Midland,Texas,United States). */
const US_STATE_ABBR = {
  al: 'Alabama',
  ak: 'Alaska',
  az: 'Arizona',
  ar: 'Arkansas',
  ca: 'California',
  co: 'Colorado',
  ct: 'Connecticut',
  de: 'Delaware',
  fl: 'Florida',
  ga: 'Georgia',
  hi: 'Hawaii',
  id: 'Idaho',
  il: 'Illinois',
  in: 'Indiana',
  ia: 'Iowa',
  ks: 'Kansas',
  ky: 'Kentucky',
  la: 'Louisiana',
  me: 'Maine',
  md: 'Maryland',
  ma: 'Massachusetts',
  mi: 'Michigan',
  mn: 'Minnesota',
  ms: 'Mississippi',
  mo: 'Missouri',
  mt: 'Montana',
  ne: 'Nebraska',
  nv: 'Nevada',
  nh: 'New Hampshire',
  nj: 'New Jersey',
  nm: 'New Mexico',
  ny: 'New York',
  nc: 'North Carolina',
  nd: 'North Dakota',
  oh: 'Ohio',
  ok: 'Oklahoma',
  or: 'Oregon',
  pa: 'Pennsylvania',
  ri: 'Rhode Island',
  sc: 'South Carolina',
  sd: 'South Dakota',
  tn: 'Tennessee',
  tx: 'Texas',
  ut: 'Utah',
  vt: 'Vermont',
  va: 'Virginia',
  wa: 'Washington',
  wv: 'West Virginia',
  wi: 'Wisconsin',
  wy: 'Wyoming',
  dc: 'District of Columbia',
};

const LOCATIONS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** @type {Map<string, { at: number, rows: any[] }>} */
const googleLocationsCache = new Map();

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableNetworkError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const code = String(err?.code || err?.cause?.code || '').toUpperCase();
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'EAI_AGAIN' ||
    msg.includes('fetch failed') ||
    msg.includes('socket disconnected') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('aborted')
  );
}

/**
 * Use OpenAI Vision API to detect exact GMB position in screenshot
 * @param {Buffer} imageBuffer - Screenshot PNG buffer
 * @param {string} businessName - Target GMB business name to find
 * @param {number} expectedRank - Expected rank from DataForSEO
 * @returns {Promise<{x: number, y: number, width: number, height: number} | null>}
 */
async function detectGmbPositionWithAI(imageBuffer, businessName, expectedRank) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('[AI-GMB] No OPENAI_API_KEY found');
    return null;
  }

  const openai = getSharedOpenAiClient() || new OpenAI({ apiKey });

  // Convert buffer to base64
  const base64Image = imageBuffer.toString('base64');
  const imageDataUrl = `data:image/png;base64,${base64Image}`;

  // Get image dimensions for coordinate calculation
  const metadata = await sharp(imageBuffer).metadata();
  const imgWidth = metadata.width || 1440;
  const imgHeight = metadata.height || 2000;

  const prompt = `You are analyzing a Google Local Finder search results page screenshot.

TASK: Find the exact position of the GMB business named "${businessName}" in this screenshot.

IMPORTANT RULES:
1. Look for a business listing card that matches or closely matches "${businessName}" (allow minor differences like "J & I" vs "J&I", punctuation, extra words like "Inc" or "LLC")
2. The business card typically contains: business name, star rating, review count, years in business, address, phone, and buttons like "Website" and "Directions"
3. Return ONLY the bounding box coordinates of that specific business card
4. Coordinates should be in PIXELS relative to the image (width=${imgWidth}, height=${imgHeight})
5. DO NOT count sponsored results at the top of the page
6. If the business is NOT found in the screenshot, respond with "NOT_FOUND"

Expected rank from search data: #${expectedRank}

RESPOND IN THIS EXACT JSON FORMAT ONLY:
{"found": true, "x": <left_edge_pixels>, "y": <top_edge_pixels>, "width": <card_width_pixels>, "height": <card_height_pixels>, "visual_rank": <actual_position_on_page>}

Or if not found:
{"found": false}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } },
          ],
        },
      ],
      max_tokens: 300,
      temperature: 0,
    });

    const content = response.choices?.[0]?.message?.content?.trim();
    console.log(`[AI-GMB] Raw response: ${content}`);

    if (!content) return null;

    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[AI-GMB] No JSON found in response');
      return null;
    }

    const result = JSON.parse(jsonMatch[0]);
    
    if (!result.found) {
      console.log(`[AI-GMB] Business "${businessName}" NOT FOUND in screenshot`);
      return null;
    }

    // Validate coordinates
    const rect = {
      x: Math.max(0, Math.min(imgWidth - 50, result.x || 0)),
      y: Math.max(0, Math.min(imgHeight - 50, result.y || 0)),
      width: Math.max(100, Math.min(500, result.width || 400)),
      height: Math.max(80, Math.min(200, result.height || 120)),
    };

    console.log(`[AI-GMB] Found "${businessName}" at x=${rect.x}, y=${rect.y}, w=${rect.width}, h=${rect.height}, visual_rank=${result.visual_rank || 'unknown'}`);
    
    return rect;
  } catch (err) {
    console.error(`[AI-GMB] OpenAI API error: ${err?.message || err}`);
    return null;
  }
}

/**
 * Add red marker overlay on screenshot using Sharp
 * @param {Buffer} imageBuffer - Original PNG screenshot buffer
 * @param {{ x: number, y: number, width: number, height: number }} rect - GMB card bounding rect
 * @param {number} rank - Rank number to display
 * @returns {Promise<Buffer>} - Modified PNG buffer with red marker overlay
 */
async function addRedMarkerOverlay(imageBuffer, rect, rank) {
  const borderWidth = 4;
  const padding = 8;
  const badgeSize = 36;
  const fontSize = 18;
  const markerColor = '#e4181f';

  // Get image dimensions
  const metadata = await sharp(imageBuffer).metadata();
  const imgWidth = metadata.width || 1440;
  const imgHeight = metadata.height || 900;

  // Calculate overlay position (with padding)
  const overlayX = Math.max(0, Math.round(rect.x) - padding);
  const overlayY = Math.max(0, Math.round(rect.y) - padding);
  const overlayWidth = Math.min(imgWidth - overlayX, Math.round(rect.width) + 2 * padding);
  const overlayHeight = Math.min(imgHeight - overlayY, Math.round(rect.height) + 2 * padding);

  // Create SVG overlay with red border and rank badge
  const svgOverlay = `
    <svg width="${imgWidth}" height="${imgHeight}" xmlns="http://www.w3.org/2000/svg">
      <!-- Red border around GMB card -->
      <rect 
        x="${overlayX}" 
        y="${overlayY}" 
        width="${overlayWidth}" 
        height="${overlayHeight}" 
        fill="none" 
        stroke="${markerColor}" 
        stroke-width="${borderWidth}"
      />
      <!-- Rank badge (top-left corner) -->
      <rect 
        x="${overlayX}" 
        y="${Math.max(0, overlayY - badgeSize)}" 
        width="${badgeSize}" 
        height="${badgeSize}" 
        fill="${markerColor}"
      />
      <text 
        x="${overlayX + badgeSize / 2}" 
        y="${Math.max(badgeSize / 2, overlayY - badgeSize / 2 + 6)}" 
        font-family="Arial, sans-serif" 
        font-size="${fontSize}" 
        font-weight="bold" 
        fill="white" 
        text-anchor="middle" 
        dominant-baseline="middle"
      >#${rank}</text>
    </svg>
  `;

  // Composite SVG overlay onto original image
  const result = await sharp(imageBuffer)
    .composite([
      {
        input: Buffer.from(svgOverlay),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();

  return result;
}

export async function fetchJsonWithRetry(url, options, { attempts = 3, baseDelayMs = 900 } = {}) {
  const timeoutMs = Math.max(5000, Number(process.env.DATAFORSEO_TIMEOUT_MS) || 90000);
  const envAttempts = Math.max(1, Number(process.env.DATAFORSEO_RETRY_COUNT) || attempts);
  const delays = [2000, 5000, 10000];
  let lastErr = null;
  for (let i = 1; i <= envAttempts; i++) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      const data = await response.json();
      return { response, data };
    } catch (e) {
      lastErr = e;
      if (i >= envAttempts || !isRetryableNetworkError(e)) throw e;
      const delay = delays[i - 1] ?? baseDelayMs * i;
      console.warn(
        `[DataForSEO] network retry ${i}/${envAttempts - 1} after ${delay}ms: ${e?.name || 'Error'} ${e?.cause?.code || e?.code || e?.message || e}`
      );
      await sleep(delay);
    }
  }
  throw lastErr || new Error('fetchJsonWithRetry failed');
}

function normLoc(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalize state-like segment from GMB hint: "CA 90604" -> "CA", "California 90604" -> "California". */
function cleanStateSegment(rawState) {
  const s = String(rawState || '').trim();
  if (!s) return '';
  // strip trailing ZIP / postal-like tail
  const noZip = s.replace(/\s+\d{4,10}(?:-\d{2,6})?\s*$/g, '').trim();
  // "CA 90604" may still remain if extra spacing artifacts
  const m = noZip.match(/^([a-z]{2})(?:\s+.*)?$/i);
  if (m) return m[1].toUpperCase();
  return noZip;
}

/**
 * Parse `City, ST, USA`-style strings from GMB / dashboard into structured geo (full state & country names).
 * @returns {{ city: string|null, state_full: string|null, country: string|null }|null}
 */
function parseStructuredLocationFromHint(explicitLocation) {
  const raw = String(explicitLocation || '').trim();
  if (!raw) return null;
  const segments = raw.split(',').map((x) => x.trim()).filter(Boolean);
  if (segments.length < 2) return null;

  const lastRaw = segments[segments.length - 1].replace(/\./g, '');
  let country = 'United States';
  if (/^(usa?)$/i.test(lastRaw)) country = 'United States';
  else if (/^united states$/i.test(lastRaw)) country = 'United States';
  else country = segments[segments.length - 1];

  const stateSeg = cleanStateSegment(segments[segments.length - 2]);
  let state_full = null;
  if (/^[a-z]{2}$/i.test(stateSeg)) {
    state_full = US_STATE_ABBR[stateSeg.toLowerCase()] || stateSeg;
  } else {
    state_full = stateSeg;
  }

  const cityParts = segments.slice(0, -2);
  const city = cityParts.length ? cityParts.join(', ') : null;

  return { city, state_full, country };
}

/** 
 * Scans the keyword for country tokens to ensure DataForSEO uses the correct base location.
 */
export function extractCountryFromKeyword(keyword) {
  const k = String(keyword || '').toLowerCase();
  if (k.includes('united states') || k.includes(', usa') || k.endsWith(' usa') || k.includes(' us ')) return 'United States';
  if (k.includes('india')) return 'India';
  if (k.includes('united kingdom') || k.includes(' UK')) return 'United Kingdom';
  if (k.includes('canada') || k.includes(', ca')) return 'Canada';
  if (k.includes('australia')) return 'Australia';
  return null;
}

/** Comma-separated catalog form (no spaces after commas), per DataForSEO examples. */
function buildCatalogLocationName(geo) {
  if (!geo) return null;
  const parts = [geo.city, geo.state_full, geo.country].filter((x) => x && String(x).trim());
  if (!parts.length) return null;
  return parts.map((p) => String(p).trim().replace(/\s+/g, ' ')).join(',');
}

/** Map resolved country to `/v3/serp/google/locations/{iso}` path segment (lowercase). */
function countryToLocationsIsoPath(geo) {
  const c = normLoc(geo?.country);
  if (!c || c === 'usa' || c === 'us' || c.includes('united states')) return 'us';
  if (c === 'in' || c.includes('india')) return 'in';
  if (c === 'uk' || c.includes('united kingdom')) return 'gb';
  if (c === 'au' || c.includes('australia')) return 'au';
  if (c === 'ca' || c === 'canada') return 'ca';
  if (c === 'de' || c.includes('germany')) return 'de';
  if (c === 'es' || c.includes('spain')) return 'es';
  return 'us';
}

/**
 * @param {string} authB64
 * @param {string} countryIsoLower e.g. 'us'
 */
async function fetchGoogleLocationsCached(authB64, countryIsoLower) {
  const key = countryIsoLower || 'us';
  const now = Date.now();
  const hit = googleLocationsCache.get(key);
  if (hit && now - hit.at < LOCATIONS_CACHE_TTL_MS) return hit.rows;

  const url = `https://api.dataforseo.com/v3/serp/google/locations/${encodeURIComponent(key)}`;
  const { response, data } = await fetchJsonWithRetry(
    url,
    {
      method: 'GET',
      headers: {
        Authorization: `Basic ${authB64}`,
        'Content-Type': 'application/json',
      },
    },
    { attempts: 3, baseDelayMs: 800 }
  );
  const locCode = Number(data.status_code);
  if (!response.ok || !Number.isFinite(locCode) || locCode !== 20000) {
    const msg = data.status_message || data.message || `HTTP ${response.status}`;
    throw new Error(`DataForSEO locations: ${msg}`);
  }
  const rows = data.tasks?.[0]?.result || [];
  googleLocationsCache.set(key, { at: now, rows });
  return rows;
}

/**
 * @returns {Promise<{ city: string|null, state_full: string|null, country: string|null }|null>}
 */
async function aiExtractGeoFromKeyword(keyword, explicitHint) {
  const sharedClient = getSharedOpenAiClient();
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!sharedClient && !apiKey) return null;

  const model = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
  const client = sharedClient || new OpenAI({ apiKey, timeout: 45_000, maxRetries: 1 });
  const kw = String(keyword || '').trim();
  const hint = String(explicitHint || '').trim();

  const content = `Search keyword (may embed service + city + state): ${kw || '(empty)'}
Optional verified business area (prefer for city/state when keyword is ambiguous): ${hint || '(none)'}

Extract the geographic target for Google Local / SERP location. Return ONLY valid JSON:
{"city": string or null, "state_full": string or null, "country": string or null}

Rules:
- city: locality only (e.g. Midland), no business category. If unsure, null.
- state_full: full English name (Texas not TX). If unsure, null.
- country: full English name (United States not USA). Default United States when clearly US local intent.
- Use null for unknown fields — do not guess countries.`;

  try {
    const completion = await client.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content }],
      temperature: 0.1,
    });
    const text = completion.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    const j = JSON.parse(text);
    return {
      city: j.city != null && String(j.city).trim() ? String(j.city).trim() : null,
      state_full: j.state_full != null && String(j.state_full).trim() ? String(j.state_full).trim() : null,
      country: j.country != null && String(j.country).trim() ? String(j.country).trim() : null,
    };
  } catch (e) {
    console.warn('[DataForSEO/Geo] OpenAI extract failed:', e?.message || e);
    return null;
  }
}

function mergeGeoHints(structFromGmb, aiGeo) {
  const base = structFromGmb || { city: null, state_full: null, country: null };
  if (!aiGeo) return base.city || base.state_full ? base : null;

  return {
    city: base.city || aiGeo.city || null,
    state_full: base.state_full || aiGeo.state_full || null,
    country: base.country || aiGeo.country || 'United States',
  };
}

/**
 * For DataForSEO, we now strictly pick the Country-level location row using the full name.
 * @returns {{ location_code: number, location_name: string }|null}
 */
function pickDataForSeoLocationRow(rows, geo) {
  if (!rows?.length || !geo?.country) return null;

  const countryName = String(geo.country).trim();
  // Exact match for the country name in the DataForSEO catalog
  const match = rows.find((r) =>
    String(r.location_name).toLowerCase() === countryName.toLowerCase() &&
    String(r.location_type || '').toLowerCase() === 'country'
  );

  if (match) return { location_code: match.location_code, location_name: match.location_name };

  // Hard fallbacks for US/India if catalog match is tricky
  if (countryName.toLowerCase().includes('united states') || countryName.toLowerCase() === 'usa') {
    return { location_code: 2840, location_name: 'United States' };
  }
  if (countryName.toLowerCase() === 'india') {
    return { location_code: 2356, location_name: 'India' };
  }

  // Final fallback to the first 'country' type row if available
  const anyCountry = rows.find(r => String(r.location_type || '').toLowerCase() === 'country');
  if (anyCountry) return { location_code: anyCountry.location_code, location_name: anyCountry.location_name };
  return null;
}

/**
 * Structured geo from GMB hint + OpenAI on keyword, then match to DataForSEO locations.
 */
export async function resolveDataForSeoLocation(authB64, keyword, explicitLocation) {
  const structFromHint = parseStructuredLocationFromHint(explicitLocation);
  const aiGeo = await aiExtractGeoFromKeyword(keyword, explicitLocation);
  const keywordCountry = extractCountryFromKeyword(keyword);
  const merged = mergeGeoHints(structFromHint, aiGeo);
  const geo = {
    city: merged?.city || null,
    state_full: merged?.state_full || null,
    country: merged?.country || keywordCountry || 'United States',
  };
  const isoPath = countryToLocationsIsoPath(geo);
  let rows = [];
  try {
    rows = await fetchGoogleLocationsCached(authB64, isoPath);
  } catch (e) {
    const msg = String(e?.message || e);
    console.warn(`[DataForSEO] locations catalog failed (${isoPath}): ${msg}`);
  }
  let picked = pickDataForSeoLocationRow(rows, geo);

  if (!picked) {
    // Hard fallback if locations catalog fails or has no country row.
    if (String(geo.country).toLowerCase() === 'india') {
      picked = { location_code: 2356, location_name: 'India' };
      console.warn(`[DataForSEO] location fallback: using India country code 2356`);
    } else {
      picked = { location_code: 2840, location_name: 'United States' };
      console.warn(
        `[DataForSEO] location fallback: using default US country code 2840 (catalog unavailable or no match for /locations/${isoPath})`,
      );
    }
  }

  return { geo, picked, isoPath };
}

export function dataForSeoConfigured() {
  const login = (process.env.DATAFORSEO_LOGIN || '').trim();
  const pass = (process.env.DATAFORSEO_PASSWORD || '').trim();
  return !!(login && pass);
}

/** Local pack page size for DataForSEO `start=` pagination (aligns with Google). */
export const DATAFORSEO_LOCAL_PAGE_SIZE = 20;

/**
 * Set `start` on DataForSEO's `check_url` so the opened SERP page contains `rank_absolute`.
 * @returns {{ checkUrlForPage: string|null, checkUrlRaw: string|null, localStart: number, rankSlotOnPage: number }}
 */
export function buildCheckUrlForRankPage(checkUrlRaw, rankAbsolute, pageSize = DATAFORSEO_LOCAL_PAGE_SIZE) {
  const r = Math.max(1, Math.floor(Number(rankAbsolute) || 1));
  const ps = Math.max(1, Math.min(50, Number(pageSize) || DATAFORSEO_LOCAL_PAGE_SIZE));
  const localStart = Math.floor((r - 1) / ps) * ps;
  const slot = r - localStart;
  const rankSlotOnPage = Math.max(1, Math.min(ps, slot));

  if (!checkUrlRaw || typeof checkUrlRaw !== 'string' || !/^https?:\/\//i.test(checkUrlRaw.trim())) {
    return {
      checkUrlForPage: null,
      checkUrlRaw: checkUrlRaw ? String(checkUrlRaw) : null,
      localStart,
      rankSlotOnPage,
    };
  }
  try {
    const u = new URL(checkUrlRaw.trim());
    u.searchParams.set('start', String(localStart));
    return {
      checkUrlForPage: u.toString(),
      checkUrlRaw: checkUrlRaw.trim(),
      localStart,
      rankSlotOnPage,
    };
  } catch {
    return {
      checkUrlForPage: checkUrlRaw.trim(),
      checkUrlRaw: checkUrlRaw.trim(),
      localStart,
      rankSlotOnPage,
    };
  }
}

/** Extract 'start' parameter from check_url (if present) to align verification with live SERP page. */
export function getStartFromCheckUrl(checkUrlRaw, defaultPageSize = DATAFORSEO_LOCAL_PAGE_SIZE) {
  if (!checkUrlRaw || typeof checkUrlRaw !== 'string') return 0;
  try {
    const u = new URL(checkUrlRaw.trim());
    const s = u.searchParams.get('start');
    if (s != null && s !== '') {
      const n = parseInt(s, 10);
      return Number.isFinite(n) ? Math.max(0, n) : 0;
    }
  } catch {
    /* ignore URL parse error */
  }
  return 0;
}

/** Map absolute rank to 1..20 slot on the current SERP page. */
export function getRankSlotOnPage(rankAbsolute, localStart, pageSize = DATAFORSEO_LOCAL_PAGE_SIZE) {
  const r = Math.max(1, Math.floor(Number(rankAbsolute) || 1));
  const s = Math.max(0, Math.floor(Number(localStart) || 0));
  const ps = Math.max(1, Math.min(50, Number(pageSize) || DATAFORSEO_LOCAL_PAGE_SIZE));
  const slot = r - s;
  return Math.max(1, Math.min(ps, slot));
}

/**
 * @returns {Promise<{ items: any[], checkUrl: string|null, totalItems: number }>}
 */
export async function fetchDataForSeoLocalFinder({ keyword, location, device = 'desktop', os = 'windows', depth = 100 }) {
  const login = (process.env.DATAFORSEO_LOGIN || '').trim();
  const password = (process.env.DATAFORSEO_PASSWORD || '').trim();
  if (!login || !password) throw new Error('DataForSEO credentials missing (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD)');

  const kw = String(keyword || '').trim();
  if (!kw) throw new Error('DataForSEO: keyword is required');
  const auth = Buffer.from(`${login}:${password}`).toString('base64');
  const { picked, geo, isoPath } = await resolveDataForSeoLocation(auth, keyword, location);
  const locationCode = Number(picked?.location_code) || 2840;
  const normDepth = Math.max(20, Math.min(700, Math.floor(Number(depth) || 100)));

  const tasks = [];
  const oss = String(os).toLowerCase() === 'both' ? ['windows', 'macos'] : [os || 'windows'];

  for (const o of oss) {
    let d = device;
    // Force desktop for windows/macos as requested
    if (o === 'windows' || o === 'macos') {
      d = 'desktop';
    } else if (String(device).toLowerCase() === 'both') {
      // If device 'both' is requested but OS is specific (and not windows/macos),
      // we'd normally do desktop/mobile, but user wants static windows/macos.
      // So 'both' here will just default to desktop.
      d = 'desktop';
    }

    tasks.push({
      keyword: kw,
      location_code: locationCode,
      language_code: 'en',
      device: d || 'desktop',
      os: o,
      depth: normDepth,
    });
  }

  const payload = tasks;

  console.log(
    `[DataForSEO] Local Finder: "${kw}" | depth=${normDepth} | resolved geo=${JSON.stringify(geo)} | location_code=${locationCode} location_name="${picked.location_name}" (catalog ${isoPath})`,
  );
  console.log(`[DataForSEO] payload check: tasks=${payload.length} body_bytes=${JSON.stringify(payload).length}`);

  let data = null;
  let task0 = null;
  let result = null;
  let lastEmptyHint = '';

  for (let attempt = 1; attempt <= 4; attempt++) {
    const { response, data: body } = await fetchJsonWithRetry(
      'https://api.dataforseo.com/v3/serp/google/local_finder/live/advanced',
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
      { attempts: 3, baseDelayMs: 1000 }
    );
    data = body;
    const topCode = Number(data.status_code);
    if (!response.ok || !Number.isFinite(topCode) || topCode !== 20000) {
      const msg = data.status_message || data.message || `HTTP ${response.status}`;
      const m = String(msg || '').toLowerCase();
      const retryableServer =
        response.status >= 500 ||
        m.includes('internal server error') ||
        m.includes('temporarily unavailable') ||
        m.includes('timeout');
      if (retryableServer && attempt < 4) {
        const delay = 1200 * attempt;
        console.warn(`[DataForSEO] server error on attempt ${attempt}; retrying in ${delay}ms: ${msg}`);
        await sleep(delay);
        continue;
      }
      throw new Error(`DataForSEO: ${msg} (status_code: ${data.status_code})`);
    }

    const allTasks = data.tasks || [];
    const allResults = allTasks.map(t => t?.result?.[0]).filter(Boolean);

    if (allResults.length > 0) {
      result = allResults[0]; // Base result for metadata
      // Merge items from all tasks (desktop + mobile)
      const mergedItems = [];
      const seenIds = new Set();
      for (const res of allResults) {
        if (Array.isArray(res.items)) {
          for (const item of res.items) {
            const id = `${item.rank_absolute}_${item.title || item.name}`;
            if (!seenIds.has(id)) {
              mergedItems.push(item);
              seenIds.add(id);
            }
          }
        }
      }

      // Update result with merged data
      result.items = mergedItems;
      result.items_count = mergedItems.length;
      // Pick the first valid checkUrl
      result.check_url = allResults.find(r => r.check_url)?.check_url || result.check_url;
      break;
    }

    task0 = allTasks[0];
    const tMsg = task0?.status_message || task0?.status_code;
    lastEmptyHint =
      tMsg != null
        ? ` task: ${JSON.stringify(tMsg)}`
        : ` body_keys=${Object.keys(data || {}).join(',')}`;

    const taskErr = allTasks.some(t => Number(t?.status_code) !== 20000 && t?.status_code != null);
    if (taskErr) {
      const errTask = allTasks.find(t => Number(t?.status_code) !== 20000);
      const tmsg = String(errTask?.status_message || '');
      const retryableTask = /internal server error|temporarily unavailable|timeout/i.test(tmsg);
      if (retryableTask && attempt < 4) {
        const delay = 1200 * attempt;
        console.warn(`[DataForSEO] task error on attempt ${attempt}; retrying in ${delay}ms: ${tmsg}`);
        await sleep(delay);
        continue;
      }
      throw new Error(`DataForSEO task failed: ${errTask?.status_code} ${errTask?.status_message || ''}`.trim());
    }

    if (attempt < 4) {
      const delay = 900 * attempt;
      console.warn(`[DataForSEO] local_finder returned empty result on attempt ${attempt}; retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  if (!result) {
    throw new Error(`DataForSEO: No result in response (empty local_finder payload).${lastEmptyHint}`);
  }

  const items = result.items || [];
  const checkUrl = result.check_url || null;
  const totalItems = result.items_count ?? items.length;

  console.log(`[DataForSEO] items=${items.length} totalItems≈${totalItems} (short) check_url=${checkUrl ? `${checkUrl.slice(0, 72)}…` : 'none'}`);
  const titlePreview = items
    .filter((i) => i && i.rank_absolute != null && (i.title || i.name))
    .slice(0, 120)
    .map((i) => `#${i.rank_absolute} ${String(i.title || i.name).replace(/\s+/g, ' ').trim()}`);
  if (titlePreview.length) {
    console.log(`[DataForSEO] titles (rank → title):\n${titlePreview.join('\n')}`);
  }
  if (checkUrl) {
    console.log(`[DataForSEO] check_url (full, terminal log):\n${checkUrl}`);
  }

  return { items, checkUrl, totalItems };
}

export function findBusinessInDataForSeoItems(items, businessName, keyword, location, checkUrl) {
  let localItems = items.filter(
    (i) => i.type === 'local_pack' || i.type === 'local_finder' || i.type === 'maps'
  );
  if (!localItems.length) {
    localItems = items.filter((i) => i.rank_absolute != null && (i.title || i.name));
  }

  console.log(`[DataForSEO/Match] candidate rows: ${localItems.length} | target: "${businessName}" (strict name only)`);
  let best = null;
  for (const item of localItems) {
    const title = item.title || item.name || '';
    if (!isStrictGmbNameMatch(businessName, title)) continue;
    const rank = Number(item.rank_absolute) || Number.MAX_SAFE_INTEGER;
    if (!best || rank < best.rank) {
      best = { item, rank };
    }
  }
  if (best?.item) {
    const item = best.item;
    const title = item.title || item.name || '';
    const rank = item.rank_absolute;
    const page = item.page || 1;
    console.log(`[DataForSEO/Match] strict hit: "${title}" rank_absolute=${rank} page=${page}`);
    return {
      found: true,
      rank,
      title,
      page,
      xpath: item.xpath || null,
      cid: item.cid || null,
      phone: item.phone || null,
      rating: item.rating?.value ?? item.rating ?? null,
      reviews: item.rating?.votes_count ?? item.reviews_count ?? null,
      address: item.description?.split('\n')[0] || item.address || '',
      website: item.url || item.contact_url || null,
      checkUrl,
    };
  }

  return { found: false, totalChecked: localItems.length };
}

export function findBusinessInResults(items, businessName, keyword, location, checkUrl) {
  return findBusinessInDataForSeoItems(items, businessName, keyword, location, checkUrl);
}



const RANK_OVERLAY_RED = '#e4181f';

/**
 * Find the local-finder list card (by business name with FUZZY matching) and return viewport rect + actual DOM slot position.
 * Fuzzy matching: strict match first, then distinctive brand tokens if strict fails.
 * @returns {{ rect: {x,y,width,height}, slotOnPage: number, matchedTitle: string, matchType: string } | null}
 */
async function getLocalFinderCardRectWithSlot(page, bizName, keyword = '') {
  const fullGmbNorm = normalizeGmbNameForMatch(bizName);
  const bizNameRaw = String(bizName || '').trim();
  const keywordRaw = String(keyword || '').trim();
  
  return page.evaluate(
    ({ fullGmbNorm: gmb, bizNameRaw, keywordRaw }) => {
      function normalizeTitleStrict(s) {
        let x = String(s || '')
          .toLowerCase()
          .trim()
          .replace(/\u00a0/g, ' ')
          .replace(/…+/g, '')
          .replace(/\.{3,}/g, '');
        x = x.replace(/\s*&\s*/g, ' and ');
        x = x.replace(/\band\b/gi, 'and');
        x = x.replace(/[^\p{L}\p{N}\s]+/gu, ' ');
        return x.replace(/\s+/g, ' ').trim();
      }

      // Strict match - exact or prefix match
      function strictMatchNorms(a, b) {
        if (!a || !b) return false;
        if (a === b) return true;
        const aw = a.split(' ').filter(Boolean);
        const bw = b.split(' ').filter(Boolean);
        if (!aw.length || !bw.length) return false;
        if (bw.length > aw.length) return false;
        if (bw.length < aw.length) {
          if (bw.length < 2 && a.length > 5) return false;
          for (let i = 0; i < bw.length; i++) {
            if (bw[i] !== aw[i]) return false;
          }
          return true;
        }
        for (let i = 0; i < aw.length - 1; i++) {
          if (bw[i] !== aw[i]) return false;
        }
        const la = aw[aw.length - 1];
        const lb = bw[bw.length - 1];
        return la === lb || (la.startsWith(lb) && lb.length >= 3);
      }

      // Fuzzy match - distinctive brand tokens (ignores common words like LLC, Inc, Services)
      function fuzzyBrandMatch(searchName, resultTitle, keyword) {
        const clean = (str) =>
          String(str || '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, '')
            .split(/\s+/)
            .filter((w) => w.length > 1);
        const sWords = clean(searchName);
        const r = String(resultTitle || '').toLowerCase();
        if (!sWords.length || !r) return false;
        
        // Common noise words to ignore
        const noiseWords = new Set([
          'tree', 'service', 'services', 'inc', 'llc', 'company', 'corp', 'corporation',
          'solutions', 'contractor', 'contractors', 'painter', 'painters', 'painting',
          'usa', 'us', 'the', 'and', 'of', 'in', 'at', 'for', 'by', 'group', 'team',
          'pro', 'pros', 'professional', 'professionals', 'expert', 'experts',
          'pressure', 'washing', 'cleaning', 'maintenance', 'repair', 'repairs',
          'home', 'house', 'residential', 'commercial', 'industrial',
        ]);
        
        // Add keyword words to noise
        const keywordWords = clean(keyword);
        for (const kw of keywordWords) noiseWords.add(kw);
        
        // Get distinctive brand tokens (4+ chars, not noise)
        const brandTokens = sWords.filter((w) => !noiseWords.has(w) && w.length >= 3);
        if (!brandTokens.length) return false;
        
        // All distinctive brand tokens must appear in result
        return brandTokens.every((w) => r.includes(w));
      }

      function cardFirstLine(el) {
        const t = el.innerText || '';
        return (t.split('\n').map((x) => x.trim()).find(Boolean) || '').trim();
      }

      // Collect all cards from different selectors, dedupe
      const selectors = ['.rllt__details', '.VkpGBb', '[data-cid]', '.uMdZh', '.rllt__card'];
      const allCards = [];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (!allCards.includes(el)) allCards.push(el);
        }
      }

      // Remove nested duplicates (parent containing child)
      const deduped = allCards.filter((el) => !allCards.some((other) => other !== el && other.contains(el)));

      // Filter to row-like elements and sort by DOM position (top to bottom)
      const isRowLike = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.height < 30 || r.height > 420) return false;
        if (r.left > window.innerWidth * 0.62) return false;
        const ttxt = String(el.innerText || '').trim();
        if (!ttxt || ttxt.length < 3) return false;
        return !!(
          el.querySelector('h3, h2, [role="heading"]') ||
          el.querySelector('a[href*="/maps"], a[href*="google.com/maps"], [data-cid]')
        );
      };

      const cards = deduped
        .filter(isRowLike)
        .sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          const dy = ra.top - rb.top;
          if (Math.abs(dy) > 6) return dy;
          return ra.left - rb.left;
        });

      // First pass: try strict name match
      let matchedIdx = -1;
      let matchedTitle = null;
      let matchType = null;
      
      for (let i = 0; i < cards.length; i++) {
        const title = cardFirstLine(cards[i]);
        const normalized = normalizeTitleStrict(title);
        if (strictMatchNorms(gmb, normalized)) {
          matchedIdx = i;
          matchedTitle = title;
          matchType = 'strict';
          break;
        }
      }

      // Second pass: try fuzzy brand match if strict failed
      if (matchedIdx < 0) {
        for (let i = 0; i < cards.length; i++) {
          const title = cardFirstLine(cards[i]);
          if (fuzzyBrandMatch(bizNameRaw, title, keywordRaw)) {
            matchedIdx = i;
            matchedTitle = title;
            matchType = 'fuzzy';
            break;
          }
        }
      }

      if (matchedIdx < 0) return null;

      const el = cards[matchedIdx];
      el.scrollIntoView({ behavior: 'instant', block: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return null;

      // Slot is 1-based (1st card = slot 1)
      const slotOnPage = matchedIdx + 1;

      return {
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        slotOnPage,
        matchedTitle,
        matchType,
      };
    },
    { fullGmbNorm, bizNameRaw, keywordRaw },
  );
}

/**
 * Red frame + "#N" label like manual QA markup (fixed overlay, then viewport screenshot).
 */
async function injectRankOverlayOnPage(page, rect, rankNum) {
  const r = Math.round(Number(rankNum));
  const label = Number.isFinite(r) && r > 0 ? r : 1;
  await page.evaluate(
    ({ x, y, width, height, rankLabel, color }) => {
      const id = 'dfs-local-finder-rank-overlay';
      document.getElementById(id)?.remove();
      const pad = 8;
      const border = 4;
      const rx = Math.max(0, x - pad);
      const ry = Math.max(0, y - pad);
      const rw = width + 2 * pad;
      const rh = height + 2 * pad;
      const wrap = document.createElement('div');
      wrap.id = id;
      wrap.setAttribute('data-dfs-annotate', '1');
      wrap.style.cssText = [
        'position:fixed',
        `left:${rx}px`,
        `top:${ry}px`,
        `width:${rw}px`,
        `height:${rh}px`,
        'box-sizing:border-box',
        `border:${border}px solid ${color}`,
        'pointer-events:none',
        'z-index:2147483647',
        'border-radius:4px',
        'box-shadow:0 0 0 1px rgba(0,0,0,0.25)',
      ].join(';');
      const text = document.createElement('div');
      text.textContent = `#${rankLabel}`;
      text.style.cssText = [
        'position:absolute',
        // Outside the red box: anchor to top-left, shift up by 10px
        'left:0px',
        'top:0px',
        'transform:translate(0, calc(-100% - 10px))',
        'font:bold 32px system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif',
        `color:${color}`,
        'line-height:1',
        'white-space:nowrap',
        'letter-spacing:-0.02em',
        'text-shadow:0 1px 2px rgba(0,0,0,0.85),0 0 1px rgba(0,0,0,0.5)',
      ].join(';');
      wrap.appendChild(text);
      document.body.appendChild(wrap);
    },
    { ...rect, rankLabel: label, color: RANK_OVERLAY_RED },
  );
}

/**
 * Scrapfly Screenshot API - direct screenshot capture
 * 1. Use Scrapfly Screenshot API with proper Google bypass params
 * 2. Estimate GMB position based on DataForSEO rank
 * 3. Add red marker overlay using Sharp
 */
async function captureCheckUrlScreenshotZenrows({ checkUrl, rank, businessName, keyword = '' }) {
  const apiKey = (process.env.SCRAPFLY_API_KEY || '').trim();
  if (!apiKey) throw new Error('SCRAPFLY_API_KEY is required');

  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });

  const start = getStartFromCheckUrl(checkUrl);
  const slotOnPage = getRankSlotOnPage(rank, start);

  console.log(`[DataForSEO/Capture] Using Scrapfly Screenshot API`);
  console.log(`[DataForSEO/Capture] DataForSEO rank=${rank} start=${start} slot=${slotOnPage}`);
  console.log(`[DataForSEO/Capture] check_url: ${checkUrl.slice(0, 150)}…`);

  // Retry configurations for Scrapfly - simpler params work better with Google
  const scrapflyConfigs = [
    { proxy_pool: 'public_residential_pool', rendering_wait: 5000, timeout: 60000, asp: true },
    { proxy_pool: 'public_residential_pool', rendering_wait: 3000, timeout: 45000, asp: false },
    { proxy_pool: 'public_datacenter_pool', rendering_wait: 2000, timeout: 30000, asp: false },
  ];

  let screenshotBuffer = null;
  let lastError = null;

  for (let attempt = 0; attempt < scrapflyConfigs.length; attempt++) {
    const cfg = scrapflyConfigs[attempt];
    console.log(`[DataForSEO/Capture] Attempt ${attempt + 1}/${scrapflyConfigs.length} with ${cfg.proxy_pool}`);

    // Step 1: Use Scrapfly Screenshot API with minimal params
    const screenshotUrl = new URL('https://api.scrapfly.io/screenshot');
    screenshotUrl.searchParams.set('key', apiKey);
    screenshotUrl.searchParams.set('url', checkUrl);
    screenshotUrl.searchParams.set('format', 'png');
    screenshotUrl.searchParams.set('resolution', '1440x900');
    screenshotUrl.searchParams.set('capture', 'fullpage');
    screenshotUrl.searchParams.set('rendering_wait', String(cfg.rendering_wait));
    screenshotUrl.searchParams.set('country', 'us');
    screenshotUrl.searchParams.set('proxy_pool', cfg.proxy_pool);
    if (cfg.asp) screenshotUrl.searchParams.set('asp', 'true');
    screenshotUrl.searchParams.set('timeout', String(cfg.timeout));

    try {
      const response = await fetch(screenshotUrl.toString(), {
        method: 'GET',
        signal: AbortSignal.timeout(cfg.timeout + 10000),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        lastError = new Error(`Scrapfly failed: ${response.status} - ${errorText.slice(0, 200)}`);
        console.warn(`[DataForSEO/Capture] Attempt ${attempt + 1} failed: ${lastError.message}`);
        continue;
      }

      screenshotBuffer = Buffer.from(await response.arrayBuffer());
      console.log(`[DataForSEO/Capture] Screenshot received: ${screenshotBuffer.length} bytes`);
      
      if (screenshotBuffer.length > 5000) {
        break; // Success
      } else {
        lastError = new Error('Screenshot too small, likely blocked');
        console.warn(`[DataForSEO/Capture] Attempt ${attempt + 1}: Screenshot too small`);
      }
    } catch (err) {
      lastError = err;
      console.warn(`[DataForSEO/Capture] Attempt ${attempt + 1} error: ${err?.message || err}`);
    }

    // Small delay between retries
    if (attempt < scrapflyConfigs.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  if (!screenshotBuffer || screenshotBuffer.length < 5000) {
    console.error(`[DataForSEO/Capture] All Scrapfly attempts failed:`, lastError?.message || 'Unknown');
    throw lastError || new Error('Scrapfly Screenshot API failed after all retries');
  }

  // Step 2: Calculate marker position
  // Google Local Finder layout:
  // - Header + search + nav tabs + filters = ~145px
  // - Each GMB card = ~150px height
  const realRank = rank;
  const headerHeight = 145;
  const cardHeight = 150;
  const markerY = headerHeight + (slotOnPage - 1) * cardHeight;
  
  console.log(`[DataForSEO/Capture] Processing: rank=${rank} slot=${slotOnPage} markerY=${markerY}`);

  try {
    // GMB card position: x starts at ~105px, width ~450px, height ~140px
    const estimatedRect = {
      x: 105,
      y: markerY,
      width: 450,
      height: 140,
    };

    const finalBuffer = await addRedMarkerOverlay(screenshotBuffer, estimatedRect, realRank);

    // Step 3: Save screenshot
    const safeName = String(businessName).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
    const filename = `dfs_${safeName}_rank${realRank}_${Date.now()}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);

    await fs.writeFile(filepath, finalBuffer);
    console.log(`[DataForSEO/Capture] Saved ${filename}`);

    return {
      screenshotPath: `screenshots/${filename}`,
      realRank,
      slotOnPage,
      start,
      matchedTitle: businessName,
      dataForSeoRank: rank,
      matchType: 'dataforseo',
    };
  } catch (err) {
    console.error(`[DataForSEO/Capture] Processing error:`, err?.message || err);
    throw err;
  }
}

/**
 * Fuzzy brand match - checks if distinctive brand tokens appear in result
 */
function fuzzyBrandMatch(searchName, resultTitle, keyword = '') {
  const clean = (str) =>
    String(str || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .split(/\s+/)
      .filter((w) => w.length > 1);
  
  const sWords = clean(searchName);
  const r = String(resultTitle || '').toLowerCase();
  if (!sWords.length || !r) return false;

  const noiseWords = new Set([
    'tree', 'service', 'services', 'inc', 'llc', 'company', 'corp', 'corporation',
    'solutions', 'contractor', 'contractors', 'painter', 'painters', 'painting',
    'usa', 'us', 'the', 'and', 'of', 'in', 'at', 'for', 'by', 'group', 'team',
    'pro', 'pros', 'professional', 'professionals', 'expert', 'experts',
    'pressure', 'washing', 'cleaning', 'maintenance', 'repair', 'repairs',
    'home', 'house', 'residential', 'commercial', 'industrial',
  ]);

  const keywordWords = clean(keyword);
  for (const kw of keywordWords) noiseWords.add(kw);

  const brandTokens = sWords.filter((w) => !noiseWords.has(w) && w.length >= 3);
  if (!brandTokens.length) return false;

  return brandTokens.every((w) => r.includes(w));
}

/**
 * @param {object} opts
 * @param {string} opts.keyword
 * @param {string} opts.businessName
 * @param {string} [opts.location]
 * @param {string} [opts.device]
 * @param {string} [opts.os]
 * @param {boolean} [opts.skipScreenshot]
 */
export async function rankAndCapture({
  keyword,
  businessName,
  location = '',
  device = 'desktop',
  os = 'windows',
  skipScreenshot = false,
}) {
  const kw = String(keyword || '').trim();
  const biz = String(businessName || '').trim();
  if (!kw || !biz) {
    return { success: false, error: 'keyword and businessName are required' };
  }

  let items;
  let checkUrl;
  let totalItems;
  try {
    ({ items, checkUrl, totalItems } = await fetchDataForSeoLocalFinder({
      keyword: kw,
      location: String(location || '').trim(),
      device,
      os,
    }));
  } catch (err) {
    return { success: false, error: String(err?.message || err) };
  }

  const match = findBusinessInResults(items, biz, kw, String(location || '').trim(), checkUrl);

  if (!match.found) {
    return {
      success: false,
      found: false,
      totalChecked: match.totalChecked,
      message: `"${biz}" not found in Local Finder results (checked ${match.totalChecked} local_pack rows, ~${totalItems} items).`,
    };
  }

  let screenshotPath = null;
  let screenshotError = null;
  let gmbFoundOnSerp = true;
  let realRank = match.rank;
  let slotOnPage = null;
  let matchedTitle = match.title;

  if (!skipScreenshot && match.checkUrl) {
    try {
      const built = buildCheckUrlForRankPage(match.checkUrl, match.rank);
      const urlForCapture = built.checkUrlForPage || match.checkUrl;
      const captureResult = await captureCheckUrlScreenshotZenrows({
        checkUrl: urlForCapture,
        rank: match.rank,
        businessName: match.title || biz,
        keyword,
      });

      // GMB not found on SERP page → screenshot not saved
      if (captureResult === null) {
        gmbFoundOnSerp = false;
        screenshotError = `"${(match.title || biz).slice(0, 100)}" not found on live SERP page. No screenshot saved.`;
      } else {
        // GMB found → use real rank from DOM
        screenshotPath = captureResult.screenshotPath;
        realRank = captureResult.realRank;
        slotOnPage = captureResult.slotOnPage;
        matchedTitle = captureResult.matchedTitle || match.title;
        console.log(
          `[DataForSEO/rankAndCapture] Real rank #${realRank} (DataForSEO reported #${match.rank})`
        );
      }
    } catch (e) {
      screenshotError = String(e?.message || e).slice(0, 800);
      console.error('[DataForSEO/Capture]', screenshotError);
    }
  }

  // If GMB not found on SERP → return not found (don't save rank data)
  if (!gmbFoundOnSerp) {
    return {
      success: false,
      found: false,
      serpVerificationFailed: true,
      rank: null,
      title: match.title,
      checkUrl: match.checkUrl,
      screenshotPath: null,
      screenshotError,
      message: screenshotError,
      totalResults: totalItems,
      engine: 'dataforseo_local_finder',
    };
  }

  return {
    success: true,
    found: true,
    rank: realRank, // Use real DOM-based rank
    dataForSeoRank: match.rank, // Original DataForSEO rank for reference
    title: matchedTitle,
    slotOnPage,
    page: match.page,
    rating: match.rating,
    reviews: match.reviews,
    address: match.address,
    website: match.website,
    phone: match.phone,
    checkUrl: match.checkUrl,
    screenshotPath,
    screenshotError,
    totalResults: totalItems,
    engine: 'dataforseo_local_finder',
  };
}
