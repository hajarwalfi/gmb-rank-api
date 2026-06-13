import * as RankingService from '../services/ranking.service.js';
import {
  rankAndCapture,
  dataForSeoConfigured,
  fetchDataForSeoLocalFinder,
  findBusinessInDataForSeoItems,
  buildCheckUrlForRankPage,
  getStartFromCheckUrl,
  getRankSlotOnPage,
} from '../services/rankAndScreenshot.service.js';
import { generateKeywords, mergeKeywordLists } from '../services/keywordGeneration.service.js';

function inferGlUs(keyword) {
  const q = String(keyword || '').toLowerCase();
  return q.includes('usa') || /\b(tx|ca|ny|fl|il|oh|pa|ga|nc|mi|nj|va|wa|az|ma|tn|in|mo|md|wi|co|mn|sc|al|la|ky|or|ok|ct|ia|ar|ms|ks|ut|nv|nm|wv|ne|id|hi|nh|me|ri|mt|de|sd|nd|ak|vt|wy|dc)\b/.test(q);
}

/** US state abbreviations → full name (for SerpAPI `location` strings). */
const US_STATE_NAME = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};

/** Normalize free-text location; SerpAPI expects strings from their [locations API](https://serpapi.com/locations-api). */
function normalizeLocationForSerp(locStr) {
  const parts = String(locStr || '')
    .trim()
    .split(/\s*,\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    const up = p.toUpperCase();
    if (/^[A-Z]{2}$/.test(up) && US_STATE_NAME[up]) out.push(up);
    else if (/^USA$/i.test(p)) out.push('USA');
    else out.push(p.replace(/\b\w/g, (c) => c.toUpperCase()));
  }
  return out.join(', ');
}

/** Ordered location strings to try; ends with `null` = omit `location` (query often already has geo). */
function serpLocationAttempts(location) {
  const raw = location != null ? String(location).trim() : '';
  if (!raw || raw.startsWith('@')) return [null];

  const base = normalizeLocationForSerp(raw);
  const set = new Set();
  const add = (s) => {
    const x = s == null ? '' : String(s).trim();
    if (x) set.add(x);
  };
  add(base);
  add(base.replace(/,\s*USA\s*$/i, ', United States'));
  add(base.replace(/,\s*USA\s*$/i, '').trim());

  const m = base.match(/^(.+),\s*([A-Z]{2})\s*,\s*(.+)$/);
  if (m) {
    const st = US_STATE_NAME[m[2]];
    if (st) {
      add(`${m[1]}, ${st}, United States`);
      add(`${m[1]}, ${st}`);
    }
  }
  return [...set, null];
}

/** Optional https URL from a local result row (Maps / Places), when SerpAPI provides it. */
function listingUrlFromHit(hit) {
  if (!hit) return null;
  const raw = hit.link || hit.links?.google_maps;
  if (raw && /^https?:\/\//i.test(String(raw))) return String(raw).trim();
  return null;
}

/** SerpAPI row → lat/lng for uule (matched row first, else any row on the page with coords). */
function gpsCoordinatesFromLocalPage(hit, pageRows) {
  const pick = (h) => {
    const g = h?.gps_coordinates;
    if (!g) return null;
    const lat = Number(g.latitude);
    const lng = Number(g.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { latitude: lat, longitude: lng };
  };
  const fromHit = pick(hit);
  if (fromHit) return fromHit;
  for (const row of pageRows || []) {
    const g = pick(row);
    if (g) return g;
  }
  return null;
}

/**
 * Google `uule=` from coordinates — same shape as SerpAPI’s Ruby helper.
 * Keep one request-level timestamp so SerpAPI + ZenRows use same uule bytes.
 * @see https://github.com/serpapi/uule_converter/blob/master/lib/serpapi-uule-converter.rb
 */
function encodeGoogleUuleFromLatLng(lat, lng, timestamp) {
  const E7 = 10_000_000;
  const latN = Number(lat);
  const lngN = Number(lng);
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) return '';
  const latE7 = Math.round(latN * E7);
  const lonE7 = Math.round(lngN * E7);
  const ts =
    timestamp != null && Number.isFinite(Number(timestamp))
      ? Math.floor(Number(timestamp))
      : Math.floor(Date.now() * 1000);
  const uuleString =
    `role:1\n` +
    `producer:12\n` +
    `provenance:0\n` +
    `timestamp:${ts}\n` +
    `latlng{\n` +
    `latitude_e7:${latE7}\n` +
    `longitude_e7:${lonE7}\n` +
    `}\n` +
    `radius:-1\n`;
  const b64 = Buffer.from(uuleString, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `a+${b64}`;
}

/**
 * Matches browser “Places” list: `udm=1`. Optional `gpsCoordinates` / `nearText` improve parity with SerpAPI vs ZenRows IP.
 */
function buildGoogleSearchLocalUrl(keyword, start = 0, opts = {}) {
  const gl = inferGlUs(keyword) ? 'us' : 'in';
  const s = Math.max(0, Math.min(100, Number(start) || 0));
  let url = `https://www.google.com/search?q=${encodeURIComponent(keyword)}&hl=en&gl=${gl}&start=${s}&udm=1&pws=0`;
  const prebuiltUule = typeof opts.uule === 'string' ? opts.uule.trim() : '';
  if (prebuiltUule.startsWith('a+')) {
    url += `&uule=${encodeURIComponent(prebuiltUule)}`;
    return url;
  }
  const geo = opts.gpsCoordinates;
  if (geo?.latitude != null && geo?.longitude != null) {
    const uule = encodeGoogleUuleFromLatLng(geo.latitude, geo.longitude, opts.uuleTimestamp);
    if (uule) url += `&uule=${encodeURIComponent(uule)}`;
  } else {
    const nearText = (opts.nearText != null ? String(opts.nearText) : '').trim();
    if (nearText) url += `&near=${encodeURIComponent(nearText)}`;
  }
  return url;
}

/** Deepest `start=` for SerpAPI google_local + udm=1 URL lists (0 … max, step 20). */
function getGoogleLocalMaxStart() {
  const n = parseInt(process.env.GOOGLE_LOCAL_MAX_START || '100', 10);
  if (!Number.isFinite(n) || n < 0) return 100;
  return Math.min(300, n);
}

function placesPageStarts(maxStart) {
  const cap = Math.max(0, Number(maxStart) || 0);
  const starts = [];
  for (let s = 0; s <= cap; s += 20) starts.push(s);
  return starts;
}

/** Extract q / uule / start from a Google Search Places URL (udm=1) for SerpAPI parity. */
function parsePlacesGoogleSearchUrl(urlStr) {
  try {
    const u = new URL(String(urlStr || '').trim());
    if (!u.hostname.includes('google.')) return null;
    const q = u.searchParams.get('q');
    const uuleRaw = u.searchParams.get('uule');
    const uule =
      uuleRaw && String(uuleRaw).trim().startsWith('a+') ? String(uuleRaw).trim() : null;
    const startParam = u.searchParams.get('start');
    const start =
      startParam != null && startParam !== '' ? Math.max(0, parseInt(startParam, 10) || 0) : 0;
    return { q: q ? String(q) : null, uule, start };
  } catch {
    return null;
  }
}

/**
 * Browser-style Places tab links (udm=1). When `sharedUule` is set, `firstPage` / `byStart` use it
 * (same as SerpAPI google_local + ZenRows). Otherwise uses near= from location.
 */
function buildKeywordPlacesTabUrls(keyword, location, sessionUuleTs = null, sharedUule = null, maxStart = 100) {
  const starts = placesPageStarts(maxStart);
  const nearText = String(location || '').trim();
  const byStartNear = {};
  for (const st of starts) {
    byStartNear[String(st)] = buildGoogleSearchLocalUrl(keyword, st, { nearText });
  }
  const uuleStr = typeof sharedUule === 'string' && sharedUule.trim().startsWith('a+') ? sharedUule.trim() : null;
  const byStartPrimary = {};
  if (uuleStr) {
    for (const st of starts) {
      byStartPrimary[String(st)] = buildGoogleSearchLocalUrl(keyword, st, { uule: uuleStr });
    }
  } else {
    Object.assign(byStartPrimary, byStartNear);
  }
  const out = {
    description: uuleStr
      ? 'udm=1 Places URLs with uule= (aligned with SerpAPI google_local when uule is used); ZenRows opens googleSearchUrl for the matched start= page.'
      : 'udm=1 Places URLs from keyword + near= (SerpAPI google_local with location); ZenRows opens googleSearchUrl after rank.',
    firstPage: byStartPrimary['0'],
    byStart: byStartPrimary,
    maxStart,
  };
  if (uuleStr) {
    out.withSessionUule = {
      uuleTimestamp: sessionUuleTs,
      firstPage: byStartPrimary['0'],
      byStart: { ...byStartPrimary },
    };
    out.withNear = { firstPage: byStartNear['0'], byStart: { ...byStartNear } };
  }
  return out;
}

/**
 * Absolute rank 1…100 for the SERP (not page-relative 1–20).
 * SerpAPI `google_local` `position` is often a 1..20 **page slot**, sometimes a **global** rank on this page.
 * Treating large/globals as always-global caused bogus ranks (e.g. 81) → wrong `start=80` URL when the row was on `start=60`.
 */
function absoluteRankFromSerpLocal(start, index, item) {
  const fromOrder = start + index + 1;
  const p = item?.position;
  if (p == null || p === '') return fromOrder;
  const n = Math.floor(Number(p));
  if (!Number.isFinite(n) || n < 1) return fromOrder;

  const pageLo = start + 1;
  const pageHi = start + 20;

  if (n >= pageLo && n <= pageHi) return n;

  if (n >= 1 && n <= 20) return start + n;

  return fromOrder;
}

function pickBestLocalRow(results, businessName, keyword, location, startOffset) {
  let best = null;
  for (let i = 0; i < results.length; i++) {
    const title = results[i].title;
    if (!RankingService.isMatchedFuzzy(businessName, title, keyword, location)) continue;
    const score = RankingService.businessNameMatchScore(businessName, title, keyword, location);
    const rank = absoluteRankFromSerpLocal(startOffset, i, results[i]);
    if (
      !best ||
      score > best.score ||
      (score === best.score && rank < best.rank)
    ) {
      best = { index: i, score, rank, title, hit: results[i] };
    }
  }
  return best;
}

/** Terminal: absolute ranks (#61–#80 when start=60), not page slots #1–#20 */
function logLocalResultsPage(start, results, pageLabel) {
  const winLo = start + 1;
  const winHi = start + results.length;
  console.log(
    `[RankingCtrl] ---------- ${pageLabel} | SerpAPI start=${start} | this page = absolute #${winLo}-#${winHi} (first row is #${winLo}, not #1) ----------`
  );
  for (let i = 0; i < results.length; i++) {
    const absRank = absoluteRankFromSerpLocal(start, i, results[i]);
    const slot = absRank - start;
    const t = String(results[i].title || results[i].name || '(no title)').replace(/\s+/g, ' ').trim().slice(0, 85);
    console.log(`[RankingCtrl]   abs #${absRank}\t(page slot ${slot}/~20)\t${t}`);
  }
  console.log(`[RankingCtrl] ---------- end ${pageLabel} ----------`);
}

function logMatchedResultPage(start, results, matchedRank, matchedTitle) {
  console.log(
    `[RankingCtrl] >>> MATCH PAGE: Serp start=${start} | absolute ranks #${start + 1}-#${start + results.length} | chosen absolute #${matchedRank} "${matchedTitle}"`
  );
  for (let i = 0; i < results.length; i++) {
    const absRank = absoluteRankFromSerpLocal(start, i, results[i]);
    const slot = absRank - start;
    const t = String(results[i].title || results[i].name || '(no title)').replace(/\s+/g, ' ').trim().slice(0, 85);
    const pin = absRank === matchedRank ? '  <<<< MATCH' : '';
    console.log(`[RankingCtrl]   abs #${absRank}\t(slot ${slot})\t${t}${pin}`);
  }
  console.log(`[RankingCtrl] <<< end match page`);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * SerpAPI `google_local` — aligns with Google Search Places-style results + `udm=1` URLs.
 * (Plain `google` + `tbm=lcl` often differs from what users see under Places / udm=1.)
 * Pagination: start 0, 20, …, 100.
 * ═══════════════════════════════════════════════════════════════════════════ */


function clientSafeErrorMessage(err) {
  if (typeof err === 'string') return err;
  const msg = err?.message;
  if (typeof msg === 'string' && msg.trim()) return msg;
  try {
    return JSON.stringify(err);
  } catch {
    return 'SerpAPI rank search failed';
  }
}

function errorText(err) {
  return String(err?.message || err || '');
}

function classifyCaptureError(err) {
  const msg = errorText(err).toLowerCase();
  if (msg.includes('captcha')) return 'captcha';
  if (msg.includes('timeout') || msg.includes('aborted')) return 'timeout';
  if (msg.includes('assert')) return 'assertion';
  return 'other';
}

function isTransientCaptureError(err) {
  const kind = classifyCaptureError(err);
  // Playwright CDP "Assertion error" can happen on transient connection churn.
  return kind === 'captcha' || kind === 'timeout' || kind === 'assertion';
}

async function recalculateRankAndCaptureOnce({
  businessName,
  keyword,
  location,
  device,
  os,
}) {
  const { items, checkUrl, totalItems } = await fetchDataForSeoLocalFinder({
    keyword: String(keyword || '').trim(),
    location: String(location || '').trim(),
    device: 'both',
    os: 'both',
  });
  const match = findBusinessInDataForSeoItems(
    items,
    businessName,
    keyword,
    String(location || ''),
    checkUrl
  );
  if (!match?.found) {
    throw new Error(
      `Retry rank step could not find business in DataForSEO results (~${totalItems || 0} rows).`
    );
  }
  const built = buildCheckUrlForRankPage(checkUrl, match.rank);
  const googleSearchUrl = built.checkUrlForPage || checkUrl;
  // Caller must serialize via RankingService.runScreenshotCaptureSerial (avoid nested queue deadlock).
  const cap = await RankingService.captureGoogleSearchLocalScreenshot({
    keyword: String(keyword),
    rank: Number(match.rank),
    scrollToTitle: String(match.title || businessName || '').trim(),
    googleSearchUrl,
    verifyGoogleSearchUrl: googleSearchUrl,
    rankSlotOnSerpPage: built.rankSlotOnPage,
    localSerpStart: built.localStart,
    targetXpath: match.xpath || null,
    targetCid: match.cid || null,
  });
  const scanRank = Number(match.rank);
  const displayRank =
    cap?.displayRank != null && Number.isFinite(Number(cap.displayRank)) ? Number(cap.displayRank) : scanRank;
  return {
    screenshotPath: cap?.screenshotPath || null,
    rank: displayRank,
    scanRank,
    displayRank,
    title: match.title || businessName,
    localSerpStart: built.localStart,
    rankSlotOnSerpPage: built.rankSlotOnPage,
    checkUrl,
    checkUrlForPage: googleSearchUrl,
  };
}

export async function runAutomatedRanking(req, res) {
  try {
    const {
      businessName,
      keyword,
      location,
      maxDepth: maxDepthBody,
      captureScreenshotImmediately: captureImmediateBody,
      uule: bodyUule,
      latitude: bodyLat,
      longitude: bodyLng,
      placesGoogleUrl,
      placesTabUrl,
    } = req.body;
    // NOTE: This route runs behind Cloudflare on live env. Inline ZenRows capture can exceed CF timeouts (524).
    // We gate inline screenshot strictly behind an explicit env switch.
    const inlineEnabled = String(process.env.INLINE_SCREENSHOT_ENABLED || 'false').toLowerCase() === 'true';
    const captureImmediately =
      inlineEnabled &&
      (captureImmediateBody === true ||
        (captureImmediateBody !== false &&
          String(process.env.AUTO_UDM1_SCREENSHOT_AFTER_RANK || '').toLowerCase() === 'true'));
    if (!businessName || !keyword) {
      return res.status(400).json({ error: 'Missing businessName or keyword' });
    }
    const dataForSeoDepth = Math.max(20, Math.min(700, Math.floor(Number(maxDepthBody) || 100)));

    const PAGE_SIZE = 20;
    const MAX_START = getGoogleLocalMaxStart();
    const totalPagesHint = Math.floor(MAX_START / PAGE_SIZE) + 1;
    const sessionUuleTs = Math.floor(Date.now() * 1000);

    let sharedUule = null;
    const uuleTrim = typeof bodyUule === 'string' ? bodyUule.trim() : '';
    if (uuleTrim.startsWith('a+')) sharedUule = uuleTrim;
    else if (Number.isFinite(Number(bodyLat)) && Number.isFinite(Number(bodyLng))) {
      sharedUule = encodeGoogleUuleFromLatLng(Number(bodyLat), Number(bodyLng), sessionUuleTs);
    } else {
      const linkFromBody = String(placesGoogleUrl || placesTabUrl || req.body.googleSearchUrl || '').trim();
      if (linkFromBody) {
        const parsed = parsePlacesGoogleSearchUrl(linkFromBody);
        if (parsed?.uule) {
          sharedUule = parsed.uule;
          console.log('[RankingCtrl] Using uule from Places URL for SerpAPI (page 1…N same anchor as browser).');
        }
        if (parsed?.q && parsed.q !== String(keyword).trim()) {
          console.warn(
            `[RankingCtrl] placesGoogleUrl q differs from request keyword — SerpAPI still uses body keyword; set keyword to match URL if needed. url q="${parsed.q.slice(0, 80)}…"`
          );
        }
      }
    }

    let keywordPlacesTabUrls = buildKeywordPlacesTabUrls(
      keyword,
      location,
      sessionUuleTs,
      sharedUule,
      MAX_START
    );

    const automatedRankEngine = String(process.env.AUTOMATED_RANK_ENGINE || 'dataforseo').toLowerCase();
    const useDataForSeoAutomated = dataForSeoConfigured() && automatedRankEngine !== 'serpapi';

    let rank = null;
    let matchedTitle = null;
    let mapsLink = null;
    let globalBest = null;
    let scanRank = null;
    let localSerpStart = 0;
    let rankSlotOnSerpPage = 1;
    let googleSearchUrl = null;
    let gpsCoordinates = null;
    let dataForSeoCheckUrlRaw = null;
    let dataForSeoCheckUrlForPage = null;
    let dataForSeoTotalItems = 0;
    let matchedXpath = null;
    let matchedCid = null;

    if (useDataForSeoAutomated) {
      console.log(
        `[RankingCtrl] (DataForSEO Local Finder → rank_absolute; ZenRows opens DataForSEO check_url for that page) 🔍 "${businessName}" | q="${keyword}" | loc="${location || ''}"`
      );
      const { items, checkUrl, totalItems } = await fetchDataForSeoLocalFinder({
        keyword: String(keyword),
        location: String(location || '').trim(),
        device: 'both',
        os: 'both',
        depth: dataForSeoDepth,
      });
      dataForSeoCheckUrlRaw = checkUrl;
      dataForSeoTotalItems = totalItems;
      console.log('[RankingCtrl] DataForSEO check_url (full, from JSON):\n', checkUrl || '(null)');

      const match = findBusinessInDataForSeoItems(
        items,
        businessName,
        keyword,
        String(location || ''),
        checkUrl
      );

      if (match.found) {
        const built = buildCheckUrlForRankPage(checkUrl, match.rank);
        dataForSeoCheckUrlForPage = built.checkUrlForPage;
        console.log(
          '[RankingCtrl] DataForSEO check_url (paginated for rank_absolute — ZenRows opens):\n',
          built.checkUrlForPage || '(null)'
        );


        rank = Number(match.rank);
        matchedTitle = match.title;
        matchedXpath = match.xpath || null;
        matchedCid = match.cid || null;
        mapsLink = match.website || null;
        scanRank = rank;
        googleSearchUrl = built.checkUrlForPage || checkUrl;
        localSerpStart = built.localStart;
        rankSlotOnSerpPage = built.rankSlotOnPage;
        gpsCoordinates = null;

        keywordPlacesTabUrls = buildKeywordPlacesTabUrls(
          keyword,
          location,
          sessionUuleTs,
          sharedUule,
          MAX_START
        );
      }
    } else {
      throw new Error('Ranking engine (DataForSEO) not configured or disabled. SerpAPI fallback has been removed.');
    }

    if (rank != null && (useDataForSeoAutomated || globalBest)) {
      console.log('[RankingCtrl] ZenRows will open DataForSEO check_url (paginated), not a SerpAPI-built link.');

      let screenshotPath = null;
      let screenshotCapturedAt = null;
      let screenshotError = null;
      let observedFields = {};
      if (captureImmediately) {
        try {
          screenshotCapturedAt = new Date().toISOString();
          console.log(
            `[RankingCtrl] Inline screenshot (${screenshotCapturedAt}) — ${useDataForSeoAutomated ? 'after DataForSEO' : 'after Scan Engine'}`
          );
          const cap = await RankingService.runScreenshotCaptureSerial(() =>
            RankingService.captureGoogleSearchLocalScreenshot({
              keyword: String(keyword),
              rank: scanRank,
              scrollToTitle: String(matchedTitle || businessName || '').trim(),
              googleSearchUrl,
              verifyGoogleSearchUrl: googleSearchUrl,
              rankSlotOnSerpPage,
              localSerpStart,
              targetXpath: matchedXpath,
              targetCid: matchedCid,
            })
          );

          // GMB NOT FOUND on page → return not found, no screenshot saved
          if (cap.found === false) {
            console.warn('[RankingCtrl] GMB not found on SERP page — no screenshot saved.');
            return res.json({
              found: false,
              serpVerificationFailed: true,
              rank: null,
              scanRank,
              title: matchedTitle,
              hasMore: false,
              engine: 'dataforseo_local_finder',
              verifyMode: 'udm=1',
              message: cap.message || 'Business not found on live SERP page.',
              keywordPlacesTabUrls,
              screenshotPath: null,
              screenshotCapturedAt: null,
              screenshotError: cap.message,
              localSerpStart,
              absoluteRank: null,
              rankSlotOnSerpPage: null,
              googleSearchUrl,
              gpsCoordinates,
              checkUrl: dataForSeoCheckUrlRaw,
              dataForSeoCheckUrlForPage,
              dataForSeoTotalItems,
              results: [
                {
                  keyword,
                  rank: null,
                  scanRank,
                  found: false,
                  success: true,
                  serpVerificationFailed: true,
                  title: matchedTitle,
                  mapsLink,
                  googleSearchUrl,
                  verifyGoogleSearchUrl: googleSearchUrl,
                  keywordPlacesTabUrls,
                  screenshotPath: null,
                  screenshotError: cap.message,
                  message: cap.message,
                  checkUrl: dataForSeoCheckUrlRaw,
                  dataForSeoCheckUrlForPage,
                  dataForSeoTotalItems,
                },
              ],
            });
          }

          // GMB FOUND → screenshot saved with red marker
          screenshotPath = cap.screenshotPath;
          const {
            displayRank,
            scannedRank,
            scannedSlotOnPage,
            observedSlotOnPage,
            observedAbsoluteRank,
            observedOrganicSlotOnPage,
            observedAbsoluteOrganicRank,
            observedMatchIsSponsored,
            observedMatchedHeading,
          } = cap;
          observedFields = {
            displayRank,
            scannedRank,
            scannedSlotOnPage,
            observedSlotOnPage,
            observedAbsoluteRank,
            observedOrganicSlotOnPage,
            observedAbsoluteOrganicRank,
            observedMatchIsSponsored,
            observedMatchedHeading,
          };
          console.log(
            `[RankingCtrl] GMB FOUND → Inline screenshot saved: ${screenshotPath} (DOM rank #${displayRank ?? '?'}, DataForSEO rank #${scanRank})`
          );
        } catch (e) {
          if (
            e instanceof RankingService.SerpListingVerificationError ||
            e?.name === 'SerpListingVerificationError'
          ) {
            const vfMsg = String(e?.message || 'Business not found on live SERP page (strict match).').slice(0, 800);
            console.warn('[RankingCtrl] SERP verification failed:', vfMsg);
            return res.json({
              found: false,
              serpVerificationFailed: true,
              rank: null,
              scanRank,
              title: matchedTitle,
              hasMore: false,
              engine: 'dataforseo_local_finder',
              verifyMode: 'udm=1',
              message: vfMsg,
              keywordPlacesTabUrls,
              screenshotPath: null,
              screenshotCapturedAt: null,
              screenshotError: vfMsg,
              localSerpStart,
              absoluteRank: null,
              rankSlotOnSerpPage: null,
              googleSearchUrl,
              gpsCoordinates,
              checkUrl: dataForSeoCheckUrlRaw,
              dataForSeoCheckUrlForPage,
              dataForSeoTotalItems,
              results: [
                {
                  keyword,
                  rank: null,
                  scanRank,
                  found: false,
                  success: true,
                  serpVerificationFailed: true,
                  title: matchedTitle,
                  mapsLink,
                  googleSearchUrl,
                  verifyGoogleSearchUrl: googleSearchUrl,
                  keywordPlacesTabUrls,
                  screenshotPath: null,
                  screenshotError: vfMsg,
                  message: vfMsg,
                  checkUrl: dataForSeoCheckUrlRaw,
                  dataForSeoCheckUrlForPage,
                  dataForSeoTotalItems,
                },
              ],
            });
          }
          screenshotError = String(e?.message || e).slice(0, 800);
          console.warn('[RankingCtrl] Inline udm=1 screenshot failed:', screenshotError);
        }
      }

      let rankOut = scanRank;
      rankSlotOnSerpPage = scanRank - localSerpStart;
      if (screenshotPath && observedFields.displayRank != null) {
        rankOut = observedFields.displayRank;
        rankSlotOnSerpPage = Math.max(1, Math.min(20, rankOut - localSerpStart));
        if (rankOut !== scanRank) {
          console.log(
            `[RankingCtrl] API/UI rank → #${rankOut} (Google udm=1); API list rank was #${scanRank}`
          );
        }
      }

      const rankEngine = useDataForSeoAutomated ? 'dataforseo_local_finder' : 'google_local';
      const dataForSeoTarget = useDataForSeoAutomated
        ? {
          matchedRankAbsolute: scanRank,
          computedStart: localSerpStart,
          computedSlotOnPage: rankSlotOnSerpPage,
          targetXpath: matchedXpath,
          targetCid: matchedCid,
        }
        : undefined;
      const defaultMsg = captureImmediately
        ? screenshotPath
          ? `Rank found (${rankEngine}); udm=1 screenshot captured in the same request.`
          : 'Rank found; inline screenshot failed — client may retry capture-screenshot.'
        : 'Rank found. UI should call capture-screenshot next — browser opens only this rank’s page (start=… on udm=1).';

      return res.json({
        found: true,
        rank: rankOut,
        scanRank: scanRank,
        title: matchedTitle,
        hasMore: false,
        engine: rankEngine,
        verifyMode: 'udm=1',
        message: defaultMsg,
        keywordPlacesTabUrls,
        screenshotPath,
        screenshotCapturedAt,
        screenshotError,
        localSerpStart,
        absoluteRank: rankOut,
        rankSlotOnSerpPage,
        googleSearchUrl,
        gpsCoordinates,
        ...(useDataForSeoAutomated
          ? {
            checkUrl: dataForSeoCheckUrlRaw,
            dataForSeoCheckUrlForPage,
            dataForSeoTotalItems,
            dataForSeoTarget,
          }
          : {}),
        ...observedFields,
        results: [
          {
            keyword,
            rank: rankOut,
            scanRank: scanRank,
            found: true,
            success: true,
            title: matchedTitle,
            mapsLink,
            googleSearchUrl,
            verifyGoogleSearchUrl: googleSearchUrl,
            keywordPlacesTabUrls,
            screenshotPath,
            screenshotCapturedAt,
            screenshotError,
            localSerpStart,
            absoluteRank: rankOut,
            rankSlotOnSerpPage,
            gpsCoordinates,
            ...(useDataForSeoAutomated
              ? {
                checkUrl: dataForSeoCheckUrlRaw,
                dataForSeoCheckUrlForPage,
                dataForSeoTotalItems,
                dataForSeoTarget,
              }
              : {}),
            ...observedFields,
          },
        ],
      });
    }

    keywordPlacesTabUrls = buildKeywordPlacesTabUrls(
      keyword,
      location,
      sessionUuleTs,
      sharedUule,
      MAX_START
    );
    const fallbackGoogleSearchUrl = keywordPlacesTabUrls.firstPage;
    const rankCeiling = MAX_START + PAGE_SIZE;
    const notFoundEngine = useDataForSeoAutomated ? 'dataforseo_local_finder' : 'google_local';

    if (useDataForSeoAutomated) {
      console.log(
        '[RankingCtrl] Business not in DataForSEO Local Finder results. check_url from JSON (full):\n',
        dataForSeoCheckUrlRaw || '(null)'
      );
    } else {
      console.log(
        `[RankingCtrl] Not found in top ${rankCeiling} (google_local, start≤${MAX_START}). Keyword Places page-0:`,
        fallbackGoogleSearchUrl
      );
    }

    return res.json({
      found: false,
      rank: null,
      title: null,
      hasMore: false,
      engine: notFoundEngine,
      verifyMode: 'udm=1',
      mapsLink: null,
      keywordPlacesTabUrls,
      googleSearchUrl: fallbackGoogleSearchUrl,
      verifyGoogleSearchUrl: fallbackGoogleSearchUrl,
      localSerpStart: 0,
      checkUrl: useDataForSeoAutomated ? dataForSeoCheckUrlRaw : undefined,
      dataForSeoTotalItems: useDataForSeoAutomated ? dataForSeoTotalItems : undefined,
      message: useDataForSeoAutomated
        ? `Not found in DataForSEO Local Finder results (~${dataForSeoTotalItems} items). See checkUrl in response / logs.`
        : `Not found in top ${MAX_START + PAGE_SIZE} results (SerpAPI Google Local, start≤${MAX_START}).`,
      results: [
        {
          keyword,
          rank: null,
          found: false,
          success: true,
          mapsLink: null,
          keywordPlacesTabUrls,
          googleSearchUrl: fallbackGoogleSearchUrl,
          verifyGoogleSearchUrl: fallbackGoogleSearchUrl,
          ...(useDataForSeoAutomated
            ? { checkUrl: dataForSeoCheckUrlRaw, dataForSeoTotalItems }
            : {}),
        },
      ],
    });
  } catch (err) {
    console.error('[RankingCtrl runAutomatedRanking ERROR]', err);
    const detail = String(clientSafeErrorMessage(err)).slice(0, 2000);
    return res.status(500).type('application/json').send(JSON.stringify({ error: detail }));
  }
}

/** POST /api/ranking/places-udm1-list — ordered Places on Search udm=1 via ZenRows (Scraping Browser). */
export async function getPlacesUdm1List(req, res) {
  try {
    const { keyword, location, maxPages } = req.body;
    const out = await RankingService.fetchGooglePlacesUdm1ListZenrows({
      keyword: String(keyword || '').trim(),
      location: typeof location === 'string' ? location : '',
      maxPages,
    });
    return res.json(out);
  } catch (err) {
    console.error('[RankingCtrl getPlacesUdm1List]', err);
    const detail = String(clientSafeErrorMessage(err)).slice(0, 2000);
    return res.status(500).type('application/json').send(JSON.stringify({ error: detail }));
  }
}

export async function captureScreenshot(req, res) {
  try {
    const {
      mapsLink,
      businessName,
      rank,
      keyword,
      screenshotMode,
      listingTitle,
      matchedTitle,
      googleSearchUrl: googleSearchUrlBody,
      verifyGoogleSearchUrl: verifyUrlBody,
      rankSlotOnSerpPage,
      localSerpStart: localSerpStartBody,
      location: bodyLocation,
      device: bodyDevice,
      os: bodyOs,
      skipScreenshot,
      useDataForSeo,
      source: bodySource,
    } = req.body;
    const link = typeof mapsLink === 'string' && mapsLink.trim() ? mapsLink.trim() : '';
    const r = rank != null && rank !== '' ? Number(rank) : null;
    const placeOnly = screenshotMode === 'place';
    const scrollTitle = String(listingTitle || matchedTitle || businessName || '').trim();
    const name = scrollTitle || String(businessName || '').trim();

    const googleSearchUrl =
      typeof googleSearchUrlBody === 'string' && googleSearchUrlBody.trim()
        ? googleSearchUrlBody.trim()
        : typeof verifyUrlBody === 'string' && verifyUrlBody.trim()
          ? verifyUrlBody.trim()
          : undefined;

    const useDataForSeoFlow =
      useDataForSeo === true ||
      String(bodySource || '').toLowerCase() === 'dataforseo' ||
      (String(process.env.DEFAULT_DATAFORSEO_RANK_CAPTURE || '').toLowerCase() === 'true' &&
        useDataForSeo !== false);

    const hasVerifyUrl =
      Boolean(googleSearchUrl) ||
      (typeof verifyUrlBody === 'string' && verifyUrlBody.trim().length > 0);
    const serpLocalParamsReady =
      !placeOnly && r != null && !Number.isNaN(r) && keyword && name && hasVerifyUrl;

    if (
      useDataForSeoFlow &&
      !placeOnly &&
      keyword &&
      name &&
      !/^https?:\/\//i.test(link) &&
      !serpLocalParamsReady
    ) {
      if (!dataForSeoConfigured()) {
        return res.status(503).json({
          error:
            'DataForSEO capture requested (useDataForSeo or source=dataforseo) but DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set in .env',
        });
      }
      let result;
      try {
        result = await rankAndCapture({
          keyword: String(keyword).trim(),
          businessName: name,
          location: typeof bodyLocation === 'string' ? bodyLocation.trim() : '',
          device: bodyDevice === 'mobile' ? 'mobile' : 'desktop',
          os: bodyOs === 'macos' ? 'macos' : 'windows',
          skipScreenshot: !!skipScreenshot,
        });
      } catch (e) {
        if (
          e instanceof RankingService.SerpListingVerificationError ||
          e?.name === 'SerpListingVerificationError'
        ) {
          return res.status(422).json({
            success: false,
            found: false,
            serpVerificationFailed: true,
            error: String(e?.message || e).slice(0, 800),
            engine: 'dataforseo_local_finder',
          });
        }
        throw e;
      }

      if (result.error && !result.found) {
        return res.status(500).json({ success: false, error: result.error, engine: 'dataforseo_local_finder' });
      }
      if (!result.success || !result.found) {
        return res.status(404).json({
          success: false,
          found: false,
          message: result.message || 'Business not found',
          totalChecked: result.totalChecked ?? 0,
          engine: 'dataforseo_local_finder',
        });
      }

      return res.json({
        success: true,
        found: true,
        rank: result.rank,
        title: result.title,
        rating: result.rating,
        reviews: result.reviews,
        address: result.address,
        website: result.website,
        phone: result.phone,
        checkUrl: result.checkUrl,
        screenshotPath: result.screenshotPath,
        screenshotError: result.screenshotError,
        totalResults: result.totalResults,
        engine: result.engine,
        captureKind: 'dataforseo_local_finder',
      });
    }

    if (!placeOnly && r != null && !Number.isNaN(r) && keyword && name) {
      try {
        const cap = await RankingService.runScreenshotCaptureSerial(() =>
          RankingService.captureGoogleSearchLocalScreenshot({
            keyword: String(keyword),
            rank: r,
            scrollToTitle: scrollTitle || businessName,
            googleSearchUrl,
            verifyGoogleSearchUrl: googleSearchUrl,
            rankSlotOnSerpPage,
            localSerpStart: localSerpStartBody,
          })
        );
        const {
          screenshotPath,
          displayRank,
          serpApiSlotOnPage,
          localSerpStart: capLocalStart,
          observedSlotOnPage,
          observedAbsoluteRank,
          observedOrganicSlotOnPage,
          observedAbsoluteOrganicRank,
          observedMatchIsSponsored,
          observedMatchedHeading,
        } = cap;
        const scanRankApi = r;
        const domRank =
          displayRank != null && Number.isFinite(Number(displayRank))
            ? Number(displayRank)
            : scanRankApi;
        return res.json({
          screenshotPath,
          rank: domRank,
          scanRank: scanRankApi,
          serpApiRank: scanRankApi,
          displayRank: domRank,
          serpApiSlotOnPage,
          localSerpStart: capLocalStart,
          observedSlotOnPage,
          observedAbsoluteRank,
          observedOrganicSlotOnPage,
          observedAbsoluteOrganicRank,
          observedMatchIsSponsored,
          observedMatchedHeading,
          title: name || businessName,
          page: null,
          captureKind: 'google_search_local',
        });
      } catch (e) {
        if (
          e instanceof RankingService.SerpListingVerificationError ||
          e?.name === 'SerpListingVerificationError'
        ) {
          return res.status(422).json({
            success: false,
            serpVerificationFailed: true,
            error: String(e?.message || e).slice(0, 800),
            captureKind: 'google_search_local',
          });
        }
        const firstKind = classifyCaptureError(e);
        if (
          keyword &&
          name &&
          isTransientCaptureError(e)
        ) {
          // Requested in error policy: on transient CAPTCHA/timeout, restart full flow from rank fetch.
          try {
            console.warn(
              `[captureScreenshot] transient ${firstKind}; restarting rank->screenshot once`
            );
            const retried = await RankingService.runScreenshotCaptureSerial(() =>
              recalculateRankAndCaptureOnce({
                businessName: name,
                keyword: String(keyword),
                location: typeof bodyLocation === 'string' ? bodyLocation.trim() : '',
                device: bodyDevice,
                os: bodyOs,
              })
            );
            const dr =
              retried.displayRank != null && Number.isFinite(Number(retried.displayRank))
                ? Number(retried.displayRank)
                : retried.rank;
            const sr = retried.scanRank ?? retried.rank;
            return res.json({
              screenshotPath: retried.screenshotPath,
              rank: dr,
              scanRank: sr,
              serpApiRank: sr,
              displayRank: dr,
              localSerpStart: retried.localSerpStart,
              title: retried.title,
              page: null,
              captureKind: 'google_search_local',
              recoveryMode: 'rank_refetch_then_capture',
              suppressToast: true,
              transientErrorKind: firstKind,
              checkUrl: retried.checkUrl,
              dataForSeoCheckUrlForPage: retried.checkUrlForPage,
            });
          } catch (retryErr) {
            if (
              retryErr instanceof RankingService.SerpListingVerificationError ||
              retryErr?.name === 'SerpListingVerificationError'
            ) {
              return res.status(422).json({
                success: false,
                serpVerificationFailed: true,
                error: String(retryErr?.message || retryErr).slice(0, 800),
                captureKind: 'google_search_local',
              });
            }
            const retryKind = classifyCaptureError(retryErr);
            const merged = `${errorText(e)} | retry: ${errorText(retryErr)}`;
            return res.status(502).json({
              error: merged.slice(0, 1200),
              suppressToast:
                retryKind === 'captcha' || retryKind === 'timeout' || retryKind === 'assertion',
              transientErrorKind: retryKind,
            });
          }
        }
        // If caller supplied Google search URL/check_url, do not silently fallback to Maps screenshot.
        if (googleSearchUrl) {
          return res.status(502).json({
            error: `Google search screenshot failed for provided check_url/googleSearchUrl: ${String(
              e?.message || e
            )}`,
            suppressToast:
              firstKind === 'captcha' || firstKind === 'timeout' || firstKind === 'assertion',
            transientErrorKind: firstKind,
          });
        }
        if (!/^https?:\/\//i.test(link)) throw e;
        console.warn('[captureScreenshot] Google local screenshot failed, using mapsLink:', e?.message || e);
      }
    }

    if (/^https?:\/\//i.test(link)) {
      const { screenshotPath } = await RankingService.captureMapsLinkScreenshot({
        mapsLink: link,
        businessName: businessName || 'listing',
        rank: r,
      });
      return res.json({
        screenshotPath,
        rank: r,
        title: businessName || null,
        page: null,
        captureKind: 'maps_place',
      });
    }

    if (!keyword || !name) {
      return res.status(400).json({
        error:
          'Provide useDataForSeo + keyword + businessName (DataForSEO Local Finder), rank + keyword + verify URL (udm=1), mapsLink, or keyword + businessName for legacy capture.',
      });
    }

    const out = await RankingService.captureSpecificScreenshot(keyword, name);
    return res.json({
      screenshotPath: out.screenshotPath,
      rank: null,
      title: name,
      page: null,
      captureKind: 'google_search_legacy',
    });
  } catch (err) {
    console.error('[RankingCtrl captureScreenshot]', err);
    const kind = classifyCaptureError(err);
    return res.status(500).json({
      error: err.message || 'Screenshot capture failed',
      suppressToast: kind === 'captcha' || kind === 'timeout' || kind === 'assertion',
      transientErrorKind: kind,
    });
  }
}

// Keywords generation handler
export async function getKeywords(req, res) {
  try {
    const { businessName, primaryCategory, services = [], areas = [] } = req.body;
    if (!Array.isArray(areas))
      return res.status(400).json({ error: 'Missing or invalid areas array' });

    const searchTerm = (primaryCategory || '').trim()
      || (Array.isArray(services) && services[0] ? services[0].trim() : '')
      || String(businessName || '').trim();

    const baseKeywords = RankingService.buildKeywords(searchTerm, areas);
    const aiKeywords = await generateKeywords(businessName, searchTerm, areas);
    const keywords = mergeKeywordLists(baseKeywords, aiKeywords);

    return res.json({
      businessName,
      primaryCategory: searchTerm,
      keywords,
      keywordPlan: {
        baseKeywords,
        aiGeneratedKeywords: aiKeywords,
        mergedKeywords: keywords,
      },
    });
  } catch (err) {
    console.error('[RankingCtrl getKeywords ERROR]', err);
    return res.status(500).json({ error: err.message });
  }
}

export async function runRanking(req, res) {
  return runAutomatedRanking(req, res);
}
