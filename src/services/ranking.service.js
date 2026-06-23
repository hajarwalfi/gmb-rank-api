import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure env is loaded before exports
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();


import { config } from '../config/index.js';
import { generateKeywords, mergeKeywordLists } from './keywordGeneration.service.js';
import { replaceNearMeWithServiceArea } from './nearMeQuery.service.js';
import {
  extractRecaptchaSiteKey,
  injectRecaptchaV2Token,
  solveRecaptchaV2,
} from './captcha2.service.js';

// FREE AI CONFIG (Wit.ai)
export const WIT_AI_TOKEN = process.env.WIT_AI_TOKEN;

/** Live SERP page does not contain a strict title match for the target GMB — do not persist misleading screenshots/ranks. */
export class SerpListingVerificationError extends Error {
  constructor(message = 'Target business not found on this SERP page (strict match).', code = 'GMB_NOT_ON_SERP_PAGE') {
    super(message);
    this.name = 'SerpListingVerificationError';
    this.code = code;
  }
}

// playwright-extra + stealth: dynamic only — SerpAPI-only paths (e.g. isMatchedFuzzy) never load it.
let _stealthChromium = undefined;
async function getStealthChromium() {
  if (_stealthChromium !== undefined) return _stealthChromium;
  try {
    const { chromium: chromiumExtra } = await import('playwright-extra');
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
    chromiumExtra.use(StealthPlugin());
    _stealthChromium = chromiumExtra;
    console.log('[Sniper] playwright-extra stealth loaded OK');
  } catch (e) {
    console.warn('[Sniper] playwright-extra not available:', e.message, '— using plain playwright');
    _stealthChromium = null;
  }
  return _stealthChromium;
}

/** Browser engine for launch* helpers: caller playwright module, else stealth extra, else vanilla playwright. */
async function resolveChromiumEngine(playwrightModule) {
  if (playwrightModule?.chromium) return playwrightModule.chromium;
  const stealth = await getStealthChromium();
  if (stealth) return stealth;
  const pw = await import('playwright');
  return pw.default.chromium;
}

/**
 * On Linux servers (no graphical display), automatically start Xvfb so Chrome
 * can run in headed mode — exactly like a local Windows/Mac machine.
 * Headed mode on a virtual display passes Google's bot detection far better
 * than true headless mode.
 *
 * Prerequisites on the live server (one-time):
 *   sudo apt-get install -y xvfb
 */
let _xvfbStarted = false;
export async function ensureVirtualDisplay() {
  // Windows / macOS always have a real display
  if (process.platform !== 'linux') return true;
  // Already configured
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    console.log('[Sniper] Display already set:', process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    return true;
  }
  if (_xvfbStarted) return true;

  try {
    const { spawn } = await import('child_process');
    const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1366x768x24', '-ac', '+extension', 'GLX'], {
      detached: true,
      stdio: 'ignore',
    });
    xvfb.unref();
    // Give Xvfb ~1.5 s to initialise
    await new Promise(r => setTimeout(r, 1500));
    process.env.DISPLAY = ':99';
    _xvfbStarted = true;
    console.log('[Sniper] Xvfb virtual display started on :99 — Chrome will run in headed mode');
    return true;
  } catch (e) {
    console.warn('[Sniper] Xvfb not available:', e.message);
    console.warn('[Sniper] Install it on the live server:  sudo apt-get install -y xvfb');
    return false;
  }
}

// __dirname already defined at top of file
const OUTPUTS_DIR = path.join(__dirname, '../../outputs');
const SCREENSHOTS_DIR = path.join(OUTPUTS_DIR, 'screenshots');

/**
 * Detect whether we should run the browser in headless mode.
 *
 * • Windows / macOS  →  local dev machine  →  headed (headless: false)
 *   The user can see the Chrome window, interact with CAPTCHA, and proceed.
 *
 * • Linux without a graphical display  →  remote/cloud server  →  headless
 *   Opening a headed window on a server's virtual display (Xvfb) is invisible
 *   to the web user, so CAPTCHA can never be solved.  We use headless with
 *   comprehensive stealth to avoid triggering CAPTCHA in the first place.
 *
 * Override at any time with the env var CAPTURE_HEADLESS=true|false.
 */
export function detectHeadlessMode() {
  const override = (process.env.CAPTURE_HEADLESS || '').toLowerCase().trim();
  if (override === 'false') return false;
  if (override === 'true') return true;
  if (process.platform === 'win32' || process.platform === 'darwin') return false;
  // Linux: headless when there is no graphical display (server environment)
  return !(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Comprehensive stealth init-script injected into every new page.
 * Masks the signals that Google (and other sites) use to detect headless/automated browsers.
 */
export const STEALTH_SCRIPT = `
(function () {
  // 1. Remove the automation flag
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
  } catch (_) {}

  // 2. Convincing plugins list (empty array is the headless tell-tale)
  try {
    const arr = [
      { name: 'Chrome PDF Plugin',  filename: 'internal-pdf-viewer',            description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer',  filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client',      filename: 'internal-nacl-plugin',            description: '' },
    ];
    arr.item      = (i) => arr[i] ?? null;
    arr.namedItem = (n) => arr.find(p => p.name === n) ?? null;
    arr.refresh   = () => {};
    Object.defineProperty(navigator, 'plugins', { get: () => arr, configurable: true });
  } catch (_) {}

  // 3. Languages
  try {
    Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en-US', 'en'], configurable: true });
  } catch (_) {}

  // 4. Minimal chrome runtime object (absent in raw headless mode)
  try {
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
    if (!window.chrome.app) window.chrome.app = { isInstalled: false };
  } catch (_) {}

  // 5. Permissions API — avoids 'denied' for notifications that bots trip on
  try {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params) =>
      params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(params);
  } catch (_) {}

  // 6. WebGL vendor / renderer — generic Intel fingerprint
  try {
    const origGet = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return origGet.call(this, p);
    };
  } catch (_) {}

  // 7. Remove headless from userAgent string if present
  try {
    const ua = navigator.userAgent.replace('HeadlessChrome', 'Chrome');
    Object.defineProperty(navigator, 'userAgent', { get: () => ua, configurable: true });
  } catch (_) {}
})();
`;

/** Returns the configured proxy server string, or null if none set. */
function getProxy() {
  return (
    process.env.PLAYWRIGHT_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    null
  );
}

/** Playwright expects server + optional username/password (Smartproxy/Bright Data URLs). */
function parsePlaywrightProxyFromEnv() {
  const raw = getProxy();
  if (!raw) return undefined;
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const server = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
    const o = { server };
    if (u.username) o.username = decodeURIComponent(u.username);
    if (u.password) o.password = decodeURIComponent(u.password);
    return o;
  } catch {
    return { server: raw };
  }
}

/** Modern browser User-Agents for rotation */
export const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

/**
 * Builds a Persistent Context using a dedicated browser_data folder.
 * This ensures CAPTCHA solutions and cookies persist across runs!
 */
export async function launchPersistentChromium(playwright, headless, location = '') {
  const proxy = getProxy();
  const userDataDir = path.join(process.cwd(), 'browser_data');
  await fs.mkdir(userDataDir, { recursive: true });

  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-setuid-sandbox',
    '--disable-infobars',
  ];
  if (headless) args.push('--disable-gpu', '--hide-scrollbars', '--mute-audio');

  const loc = String(location).toLowerCase();
  let locale = 'en-US';
  let timezoneId = 'America/New_York';

  if (loc.includes('india')) {
    locale = 'en-IN';
    timezoneId = 'Asia/Kolkata';
  } else if (loc.includes('texas') || loc.includes(', tx')) {
    timezoneId = 'America/Chicago';
  }

  let proxyConfig = undefined;
  if (process.env.PLAYWRIGHT_PROXY) {
    try {
      const url = new URL(process.env.PLAYWRIGHT_PROXY);
      proxyConfig = {
        server: `${url.protocol}//${url.host}`,
        username: url.username,
        password: url.password
      };
    } catch (e) {
      proxyConfig = { server: process.env.PLAYWRIGHT_PROXY };
    }
  }

  console.log(`[Sniper] Launching Persistent Stealth (Profile: ${userDataDir}) | Locale: ${locale}`);
  const engine = await resolveChromiumEngine(playwright);
  return await engine.launchPersistentContext(userDataDir, {
    headless,
    channel: 'chrome',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--window-size=1280,720',
      '--lang=' + (locale || 'en-US'),
      '--disable-popup-blocking',
      ...(headless ? ['--disable-gpu', '--hide-scrollbars', '--mute-audio'] : []),
    ],
    userAgent: USER_AGENTS[0],
    locale,
    timezoneId,
    viewport: { width: 1280, height: 720 },
    ignoreDefaultArgs: ['--enable-automation'],
    proxy: proxyConfig,
    colorScheme: 'dark',
  });
}

export async function launchChromium(playwright, headless) {
  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-setuid-sandbox',
    '--disable-infobars',
    '--lang=en-US',
  ];
  if (headless) args.push('--disable-gpu', '--hide-scrollbars', '--mute-audio');

  const parsedProxy = parsePlaywrightProxyFromEnv();
  const proxyOpt = parsedProxy ? { proxy: parsedProxy } : {};
  if (parsedProxy) {
    const safe = String(getProxy() || '').replace(/:[^:@/]{2,}@/i, ':***@');
    console.log('[Sniper] Using stealth proxy:', safe);
  }

  // Historically this always used playwright-extra; prefer stealth when installed, else caller's or vanilla playwright.
  const stealthC = await getStealthChromium();
  const engine =
    stealthC ?? playwright?.chromium ?? (await import('playwright')).default.chromium;
  return await engine.launch({ headless, args, ...proxyOpt });
}

export const SNIPER_CONTEXT = {
  userAgent: USER_AGENTS[0],
  locale: 'en-US',
  timezoneId: 'America/New_York',
  viewport: { width: 1366, height: 768 },
  colorScheme: 'dark',
};

/* ───────────────────────── URL-aware selector router ───────────────────────── */
export const SELECTORS = {
  search: {
    pageType: 'search',
    cards: ['.VkpUv', '.rllt__card[role="heading"]', '.rllt__card', '.uV679c', '[data-cid]'],
    title: ['.VwiC3b', '.rllt__description', '[role="heading"]', '.rllt__details div:first-child', '.q79vY', '.title', '.OSrY4'],
    description: ['.VwiC3b', '.rllt__description'],
    nextPage: ['#pnnext', 'a[aria-label="Next page"]', 'a[aria-label="Next"]', 'a:has-text("Next")', 'button[aria-label="Next page"]'],
  },
  maps: {
    pageType: 'maps',
    cards: ['.Nv2PK', '[role="article"]'],
    title: ['.qBF1Pd', '.NrDZNb'],
    description: ['.W4Efsd', '.W4Efsd span'],
    nextPage: ['button[aria-label="Next page"]', '[jsaction*="paginationSection.nextPage"]'],
  },
};

export function isMapsUrl(url = '') {
  const u = String(url).toLowerCase();
  return (
    u.includes('google.com/maps') ||
    u.includes('/maps/') ||
    u.includes('/maps/search')
  );
}

export function getSelectorsForUrl(url = '') {
  return isMapsUrl(url) ? SELECTORS.maps : SELECTORS.search;
}

export function selectorCsv(arr = []) {
  return Array.isArray(arr) ? arr.filter(Boolean).join(', ') : '';
}

/**
 * Build search keywords using the correct Local Pack format:
 *   {primaryCategory} {serviceArea}
 *
 * Example:
 *   primaryCategory = "Plumbing contractor"
 *   areas           = ["Newport North Carolina", "Morehead City NC"]
 *   → ["Plumbing contractor Newport North Carolina",
 *      "Plumbing contractor Morehead City NC"]
 *
 * This is what a real customer types into Google and it triggers the Maps
 * Local Pack (3-pack map results) instead of organic website links.
 *
 * @param {string}   primaryCategory  The GMB primary business category (e.g. "Plumbing contractor")
 * @param {string[]} areas            Service area list
 * @returns {string[]}
 */
/**
 * Build search keywords using the correct Local Pack format:
 * Generates 10x more variations to ensure deep research coverage.
 */
export function buildKeywords(primaryCategory, areas) {
  const cat = (primaryCategory || '').trim();
  const aList = Array.isArray(areas)
    ? areas.filter(Boolean).map(s => String(s).trim()).filter(Boolean)
    : [];

  if (!cat) return aList;

  const variations = [];
  for (const area of aList) {
    variations.push(
      `${cat} ${area}`,
      `best ${cat} ${area}`,
      `${cat} services ${area}`,
      `${cat} near ${area}`,
      `affordable ${cat} ${area}`,
      `top rated ${cat} ${area}`,
      `professional ${cat} ${area}`
    );
  }
  return [...new Set(variations)];
}

/**
 * Normalize GMB / Google Places titles for comparison: case-insensitive, `&` ≈ `and`,
 * ellipsis stripped, punctuation collapsed. Does not allow subset-word matches.
 */
export function normalizeGmbNameForMatch(str) {
  let s = String(str || '')
    .toLowerCase()
    .trim()
    .replace(/\u00a0/g, ' ')
    .replace(/…+/g, '')
    .replace(/\.{3,}/g, '');
  s = s.replace(/\s*&\s*/g, ' and ');
  s = s.replace(/\band\b/gi, 'and');
  s = s.replace(/[^\p{L}\p{N}\s]+/gu, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

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

/** Same legal name as GMB (case / `&` / `and`), including SERP word-prefix truncation only. */
export function isStrictGmbNameMatch(searchName, resultTitle) {
  return strictMatchNorms(
    normalizeGmbNameForMatch(searchName),
    normalizeGmbNameForMatch(resultTitle)
  );
}

/** When category words dominate the GMB name, strict match can miss; long distinctive tokens still identify the row. */
function isDistinctiveBrandHit(searchName, resultTitle, keyword, location) {
  const clean = (str) =>
    String(str || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .split(/\s+/)
      .filter((w) => w.length > 1);
  const sWords = clean(searchName);
  const r = String(resultTitle || '').toLowerCase();
  if (!sWords.length || !r) return false;
  const baseNoise = new Set([
    'tree',
    'service',
    'services',
    'inc',
    'llc',
    'company',
    'corp',
    'solutions',
    'contractor',
    'painter',
    'painters',
    'painting',
    'usa',
    'us',
  ]);
  const noise = new Set([...baseNoise, ...clean(keyword), ...clean(location)]);
  const brandTokens = sWords.filter((w) => !noise.has(w) && w.length >= 4);
  if (!brandTokens.length) return false;
  return brandTokens.every((w) => r.includes(w));
}

/**
 * Match GMB name to a Places title — strict legal-name rules plus narrow `isDistinctiveBrandHit` fallback.
 */
export function isMatchedFuzzy(searchName, resultTitle, keyword = '', location = '') {
  if (!searchName || !resultTitle) return false;
  if (isStrictGmbNameMatch(searchName, resultTitle)) return true;
  return isDistinctiveBrandHit(searchName, resultTitle, keyword, location);
}

/**
 * Score rows that passed `isMatchedFuzzy`; strict matches beat distinctive-token fallback.
 */
export function businessNameMatchScore(searchName, resultTitle, keyword = '', location = '') {
  if (isStrictGmbNameMatch(searchName, resultTitle)) {
    const a = normalizeGmbNameForMatch(searchName);
    const b = normalizeGmbNameForMatch(resultTitle);
    if (a === b) return 1_000_000;
    return 900_000 - Math.abs(a.length - b.length);
  }
  if (isDistinctiveBrandHit(searchName, resultTitle, keyword, location)) return 50_000;
  return 0;
}

/**
 * Returns true when a string is primarily composed of non-Latin characters
 * (Devanagari, CJK, Arabic, Cyrillic, etc.).  SerpAPI sometimes returns the
 * business name in the regional script even when hl=en is set, making normal
 * character-level fuzzy matching impossible.
 */
function isPrimarilyNonLatin(str) {
  if (!str || str.trim().length < 2) return false;
  const stripped = str.replace(/[\s\d]/gu, '').replace(/\p{P}/gu, '');
  if (!stripped.length) return false;
  const nonLatin = (stripped.match(/[^\u0000-\u024F]/gu) || []).length;
  return nonLatin / stripped.length > 0.4;
}

/**
 * Normalise a raw location string for SerpAPI.
 * Works for any city/region worldwide — no static lookup table needed.
 *  - Trims whitespace
 *  - Title-cases each word so SerpAPI's location matcher finds it reliably
 *    ("bhavnagar" → "Bhavnagar", "new york city" → "New York City")
 *  - Returns undefined when the string is empty so the param is omitted
 */
function normalizeLocation(loc) {
  if (!loc || !loc.trim()) return undefined;
  return loc.trim().replace(/\b\w/g, (c) => c.toUpperCase());
}


/**
 * Search Google Maps for `keyword` and return any results that match `businessName`.
 *
 * ENGINE CHOICE
 * ─────────────
 * • engine:'google_maps'  — returns proper paginated Maps results (positions 1-N).
 *   `start=0` → positions 1-20, `start=20` → 21-40, etc.
 *   This is the ONLY way to find a business ranked beyond the top-3 local pack.
 *
 * • engine:'google' (fallback) — only returns the 3-pack (3 results); start does
 *   not paginate local results at all, so it was useless for finding rank 4+.
 *
 * RANK CALCULATION
 * ────────────────
 * SerpAPI's google_maps returns position relative to the page (1-20 per page).
 * Absolute rank = start + page-relative position.
 * e.g. start=20, item.position=3 → absolute rank 23.
 */

/**
 * Check whether the current page is a Google CAPTCHA / "unusual traffic" page.
 */
export async function isCaptchaPage(page) {
  return page.evaluate(() => {
    const url = window.location.href;
    const body = (document.body && document.body.innerText) || '';
    return (
      url.includes('/sorry/') ||
      !!document.querySelector(
        'form[action*="sorry"], #captcha-form, .g-recaptcha, iframe[src*="recaptcha"]'
      ) ||
      /unusual traffic|i'm not a robot|please verify/i.test(body)
    );
  }).catch(() => false);
}


/**
 * Capture a screenshot of the Google local-pack for the given keyword.
 *
 * PRIORITY ORDER:
 *   1. SerpAPI screenshot (if SERPAPI_API_KEY is set) — no CAPTCHA risk, works on any server.
 *   2. Headed Playwright (headless: false) — local dev machine (Windows/macOS).
 *      Chrome opens visibly so the user can solve any CAPTCHA manually.
 *   3. Headless Playwright with stealth — last resort, may be blocked on datacenter IPs.
 *
 * Override headless/headed mode with env var CAPTURE_HEADLESS=true|false.
 */
export async function captureSpecificScreenshot(keyword, businessName) {

  // Use a unique worker ID to support parallelism
  const workerId = Math.random().toString(36).substring(7);
  const userDataDir = path.resolve(__dirname, `../../browser_data/worker_${workerId}`);

  try {
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    for (const f of lockFiles) {
      const lockPath = path.join(userDataDir, f);
      await fs.rm(lockPath, { force: true }).catch(() => { });
    }
  } catch (e) { }

  // ── Priority 2 & 3: Playwright ───────────────────────────────────────────────
  // On Linux (live server): start Xvfb virtual display so Chrome runs in HEADED
  // mode — same as local Windows. This passes Google's bot detection.
  // Install once on live server:  sudo apt-get install -y xvfb
  let playwright;
  let browser;
  let context;
  let page;

  const hasDisplay = await ensureVirtualDisplay();
  // headless only if: Xvfb unavailable AND we're on Linux AND CAPTURE_HEADLESS not forced false
  const headless = !hasDisplay && detectHeadlessMode();
  console.log(`[Sniper] Running in ${headless ? 'HEADLESS (stealth, no Xvfb)' : 'HEADED (real browser)'} mode`);

  try {
    playwright = await import('playwright');
    const { mkdir } = await import('fs/promises');
    await mkdir(SCREENSHOTS_DIR, { recursive: true });

    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(keyword)}&hl=en&pws=0&num=20`;
    console.log(`[Sniper] ${googleUrl}`);
    console.log(`[Sniper] Capture requested for "${businessName}"`);

    browser = await launchChromium(playwright, headless);
    context = await browser.newContext(SNIPER_CONTEXT);
    page = await context.newPage();

    // Inject stealth script into every page (both headed and headless for extra safety)
    await page.addInitScript({ content: STEALTH_SCRIPT });

    // Human-like: Navigate to Google home first (using global .com)
    await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2000)); // waitForTimeout(2000)

    // Type keyword with human delay
    const searchBox = await page.waitForSelector('textarea[name="q"], input[name="q"]');
    await searchBox.type(keyword, { delay: 120 });
    await page.keyboard.press('Enter');
    // Google Maps can behave like an SPA; wait for URL transitions first.
    let transitioned = false;
    await page.waitForURL(/maps\.google|\/maps\/search|tbm=lcl/i, { timeout: 9000 })
      .then(() => { transitioned = true; console.log('[Sniper] URL transitioned to Maps pattern.'); })
      .catch(() => { });
    if (!transitioned) {
      await page.waitForURL(/google\.[^/]+\/search\?/i, { timeout: 9000 })
        .then(() => { transitioned = true; console.log('[Sniper] URL transitioned to Search results.'); })
        .catch(() => { });
    }
    if (!transitioned) {
      console.warn('[Sniper] No URL transition detected; falling back to direct Google Maps search URL.');
      await page.goto(
        `https://www.google.com/maps/search/${encodeURIComponent(keyword)}`,
        { waitUntil: 'domcontentloaded', timeout: 60000 }
      );
      await page.waitForURL(/maps\.google|\/maps\/search|tbm=lcl/i, { timeout: 15000 }).catch(() => { });
    }

    // Dismiss Google consent dialog if present (cookie banner)
    try {
      // 1. Check for standard buttons
      const consentButtons = page.locator('button, div[role="button"]')
        .filter({ hasText: /accept all|i agree|got it|agree|स्वीकार|सहमत|read more|reject all/i });

      // 2. Check for the "Before you continue" container specifically
      const consentHeader = page.locator('h1, h2, div').filter({ hasText: /before you continue|google uses cookies/i });

      if (await consentHeader.first().isVisible({ timeout: 5000 }).catch(() => false) ||
        await consentButtons.first().isVisible({ timeout: 5000 }).catch(() => false)) {

        console.log('[Sniper] Google consent dialog detected. Attempting to dismiss...');

        // Try clicking the primary "Accept all" or "Agree" button
        const primaryBtn = consentButtons.first();
        await primaryBtn.click({ timeout: 3000, force: true }).catch(() => { });

        // Short wait to let it fade out
        await new Promise((r) => setTimeout(r, 1000));
        console.log('[Sniper] Consent dialog dismissed.');
      }
    } catch (e) {
      console.warn('[Sniper] Consent dismissal error:', e.message);
    }

    if (headless) {
      // ── HEADLESS PATH (live server) ──────────────────────────────────────────
      // Short wait — let the page settle
      await new Promise((r) => setTimeout(r, 4000));

      if (await isCaptchaPage(page)) {
        throw new Error('Google blocked the headless browser with a CAPTCHA.');
      }

      // Wait for context-aware Search/Maps result cards
      try {
        const sel = getSelectorsForUrl(page.url());
        const cardsQuery = selectorCsv(sel.cards);
        await page.waitForSelector(`${cardsQuery}, #search, #res, #main`, { timeout: 15000 });
        console.log(`[Sniper] Page results visible (headless mode, ${sel.pageType}).`);
      } catch (_) {
        console.warn('[Sniper] Specific selectors not found, but proceeding with screenshot anyway.');
      }

    } else {
      // ── HEADED PATH (Manual or Xvfb) ──────────────────────────────────────────
      // We wait for results, but if it's a captcha, we wait longer.
      // If no results after 20s, we just take the screenshot anyway (per user request).
      try {
        const sel = getSelectorsForUrl(page.url());
        const cardsQuery = selectorCsv(sel.cards);
        await page.waitForSelector(`${cardsQuery}, #search, #res, #main`, { timeout: 20000 });
        console.log(`[Sniper] Page results visible (headed mode, ${sel.pageType}).`);
      } catch (_) {
        if (await isCaptchaPage(page)) {
          console.log('[Sniper] CAPTCHA detected. Waiting up to 8 min for manual solution...');
          const cardsQuery = selectorCsv(getSelectorsForUrl(page.url()).cards);
          await page.waitForFunction(
            (q) => !!document.querySelector(`${q}, #search, #res`),
            cardsQuery,
            { timeout: 480000, polling: 500 }
          ).catch(() => { });
        } else {
          console.warn('[Sniper] Results not detected by selector, but capturing what is visible.');
        }
      }
    }

    // ── Screenshot ────────────────────────────────────────────────────────────
    // headless: short wait; headed (local or Xvfb): longer wait for full paint
    await new Promise((r) => setTimeout(r, headless ? 3000 : 5000));
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => { });
    await new Promise((r) => setTimeout(r, 600));

    const fn = `sniped_${Date.now()}.png`;
    const localPath = path.join(SCREENSHOTS_DIR, fn);
    await page.screenshot({ path: localPath, fullPage: false });
    console.log(`[Sniper] Screenshot saved: ${fn}`);
    return { screenshotPath: `screenshots/${fn}` };

  } catch (err) {
    console.error('[Sniper ERROR]', err?.message || err);
    // Do NOT save a partial screenshot on error — it would just show the CAPTCHA page.
    // Instead, propagate the error message so the UI can display it clearly.
    const base = err?.message || String(err);
    const hint = /Executable|browser|chromium|playwright|ENOENT/i.test(base)
      ? ' Run: cd google-search-ranking/server && npx playwright install chromium'
      : '';
    throw new Error(base + hint);
  } finally {
    if (browser) await browser.close().catch(() => { });
  }
}

/**
 * Open a SerpAPI (or other) Maps place/listing URL and save a viewport screenshot.
 * Uses PLAYWRIGHT_PROXY when set; optional CAPTCHA_2_API_KEY for reCAPTCHA v2 fallback.
 *
 * @param {{ mapsLink: string, businessName?: string, rank?: number|null }} opts
 * @returns {Promise<{ screenshotPath: string }>}
 */
export async function captureMapsLinkScreenshot({ mapsLink, businessName, rank }) {
  const url = String(mapsLink || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error('Invalid mapsLink — expected http(s) URL from SerpAPI local result.');
  }

  const { mkdir } = await import('fs/promises');
  await mkdir(SCREENSHOTS_DIR, { recursive: true });

  const playwright = await import('playwright');
  let browser;
  try {
    const { browser: b, page, zenrows } = await getCaptureBrowserAndPage(playwright);
    browser = b;
    let allowManualCaptchaWait = false;
    if (!zenrows) {
      const hasDisplay = await ensureVirtualDisplay();
      const headless = !hasDisplay && detectHeadlessMode();
      allowManualCaptchaWait = !headless;
    }

    await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 1500));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await new Promise((r) => setTimeout(r, 2500));

    // Dismiss Google consent dialog if present (cookie banner)
    try {
      const consentButtons = page.locator('button, div[role="button"]')
        .filter({ hasText: /accept all|i agree|got it|agree|स्वीकार|सहमत|read more|reject all/i });
      const consentHeader = page.locator('h1, h2, div').filter({ hasText: /before you continue|google uses cookies/i });

      if (await consentHeader.first().isVisible({ timeout: 5000 }).catch(() => false) ||
        await consentButtons.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await consentButtons.first().click({ timeout: 3000, force: true }).catch(() => { });
        await new Promise((r) => setTimeout(r, 1000));
        console.log('[MapsCapture] Consent dialog dismissed.');
      }
    } catch (e) {
      console.warn('[MapsCapture] Consent dismissal error:', e.message);
    }

    if (await isCaptchaPage(page)) {
      const apiKey = (process.env.CAPTCHA_2_API_KEY || process.env.TWOCAPTCHA_API_KEY || '').trim();
      if (apiKey) {
        const siteKey = await extractRecaptchaSiteKey(page);
        if (siteKey) {
          console.log('[MapsCapture] Attempting 2Captcha reCAPTCHA v2…');
          const token = await solveRecaptchaV2({ apiKey, pageUrl: page.url(), siteKey });
          if (token) {
            await injectRecaptchaV2Token(page, token);
            await new Promise((r) => setTimeout(r, 2000));
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
          }
        }
      }
      if (await isCaptchaPage(page) && allowManualCaptchaWait) {
        console.log('[MapsCapture] CAPTCHA — waiting up to 8m for manual solve (headed)…');
        const until = Date.now() + 480000;
        while (Date.now() < until && (await isCaptchaPage(page))) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (await isCaptchaPage(page)) {
        throw new Error(
          'Google showed CAPTCHA on Maps link. Set residential PLAYWRIGHT_PROXY, CAPTCHA_2_API_KEY, or run with CAPTURE_HEADLESS=false locally.'
        );
      }
    }

    await page.waitForSelector('[role="main"], #pane, .m6QErb', { timeout: 20000 }).catch(() => { });

    const safeName = String(businessName || 'listing').replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, 80);
    const rankSuffix = rank != null && rank !== '' ? `_rank${rank}` : '';
    const fn = `maps_${safeName}${rankSuffix}_${Date.now()}.png`;
    const localPath = path.join(SCREENSHOTS_DIR, fn);
    await page.screenshot({ path: localPath, fullPage: false });
    console.log(`[MapsCapture] Saved ${fn}`);
    return { screenshotPath: `screenshots/${fn}` };
  } catch (err) {
    const base = err?.message || String(err);
    const hint = /Executable|browser|chromium|playwright|ENOENT/i.test(base)
      ? ' Run: cd google-search-ranking/server && npx playwright install chromium'
      : '';
    throw new Error(base + hint);
  } finally {
    if (browser) await browser.close().catch(() => { });
  }
}

/**
 * Google Maps search for `keyword`, scroll the result list until `businessName` is in view,
 * then screenshot (same idea as SerpAPI rank: deeper rows need more scroll). No public Maps URL encodes SerpAPI `start=`.
 *
 * @param {{ keyword: string, businessName: string, rank: number }} opts
 * @returns {Promise<{ screenshotPath: string }>}
 */
export async function captureMapsRankContextScreenshot({ keyword, businessName, rank }) {
  const q = String(keyword || '').trim();
  const name = String(businessName || '').trim();
  const r = Math.max(1, Math.min(100, Math.floor(Number(rank) || 1)));
  if (!q || !name) {
    throw new Error('captureMapsRankContextScreenshot: keyword and businessName required.');
  }

  const { mkdir } = await import('fs/promises');
  await mkdir(SCREENSHOTS_DIR, { recursive: true });

  const playwright = await import('playwright');
  let browser;

  const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(q)}`;

  try {
    const { browser: b, page, zenrows } = await getCaptureBrowserAndPage(playwright);
    browser = b;
    let allowManualCaptchaWait = false;
    if (!zenrows) {
      const hasDisplay = await ensureVirtualDisplay();
      const headless = !hasDisplay && detectHeadlessMode();
      allowManualCaptchaWait = !headless;
    }

    await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise((t) => setTimeout(t, 1200));

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await new Promise((t) => setTimeout(t, 2200));

    try {
      const consent = page
        .locator('button, div[role="button"]')
        .filter({ hasText: /accept all|i agree|got it|सहमत|स्वीकार/i });
      if (await consent.first().isVisible({ timeout: 3000 }).catch(() => false)) {
        await consent.first().click({ timeout: 2000 }).catch(() => { });
        await new Promise((t) => setTimeout(t, 500));
      }
    } catch (_) { }

    if (await isCaptchaPage(page)) {
      const apiKey = (process.env.CAPTCHA_2_API_KEY || process.env.TWOCAPTCHA_API_KEY || '').trim();
      if (apiKey) {
        const siteKey = await extractRecaptchaSiteKey(page);
        if (siteKey) {
          const token = await solveRecaptchaV2({ apiKey, pageUrl: page.url(), siteKey });
          if (token) {
            await injectRecaptchaV2Token(page, token);
            await new Promise((t) => setTimeout(t, 2000));
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
          }
        }
      }
      if (await isCaptchaPage(page) && allowManualCaptchaWait) {
        const until = Date.now() + 480000;
        while (Date.now() < until && (await isCaptchaPage(page))) {
          await new Promise((t) => setTimeout(t, 2000));
        }
      }
      if (await isCaptchaPage(page)) {
        throw new Error(
          'Google showed CAPTCHA on Maps. Set PLAYWRIGHT_PROXY, CAPTCHA_2_API_KEY, or CAPTURE_HEADLESS=false locally.'
        );
      }
    }

    const feed = page.locator('[role="feed"]').first();
    await feed.waitFor({ state: 'visible', timeout: 25000 }).catch(() => { });

    const needle = name.slice(0, 60);
    const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    let found = false;
    const maxSteps = Math.min(120, r + 35);

    try {
      const jump = Math.max(0, r - 4) * 95;
      await feed.evaluate((el, y) => {
        el.scrollTop = y;
      }, jump);
      await new Promise((t) => setTimeout(t, 900));
    } catch (_) { }

    for (let step = 0; step < maxSteps; step++) {
      const asLink = page.getByRole('link', { name: re }).first();
      if (await asLink.isVisible({ timeout: 700 }).catch(() => false)) {
        await asLink.scrollIntoViewIfNeeded();
        await new Promise((t) => setTimeout(t, 500));
        found = true;
        break;
      }
      const art = page.locator('[role="article"]').filter({ hasText: re }).first();
      if (await art.isVisible({ timeout: 700 }).catch(() => false)) {
        await art.scrollIntoViewIfNeeded();
        await new Promise((t) => setTimeout(t, 500));
        found = true;
        break;
      }
      await feed.evaluate((el) => el.scrollBy(0, 520)).catch(() => { });
      await new Promise((t) => setTimeout(t, 320));
    }

    if (!found) {
      console.warn('[MapsRankCapture] Listing not found in panel after scrolling; saving viewport anyway.');
    }

    await new Promise((t) => setTimeout(t, 600));
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => { });

    const safeName = name.replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, 80);
    const fn = `maps_rankctx_${safeName}_r${r}_${Date.now()}.png`;
    const localPath = path.join(SCREENSHOTS_DIR, fn);
    await page.screenshot({ path: localPath, fullPage: false });
    console.log(`[MapsRankCapture] Saved ${fn} (foundInPanel=${found})`);
    return { screenshotPath: `screenshots/${fn}` };
  } catch (err) {
    const base = err?.message || String(err);
    const hint = /Executable|browser|chromium|playwright|ENOENT/i.test(base)
      ? ' Run: cd google-search-ranking/server && npx playwright install chromium'
      : '';
    throw new Error(base + hint);
  } finally {
    if (browser) await browser.close().catch(() => { });
  }
}

/**
 * Scroll the matched business card into viewport on Places (`udm=1`) before screenshot.
 */
/**
 * ZenRows Scraping Browser — mutually exclusive geo params (docs):
 * - `proxy_region` = world bucket only: na | eu | ap | sa | af | me
 * - `proxy_country` = ISO-3166 alpha-2 (us, de, gb…)
 * Sending proxy_region=us causes REQS004. @see https://docs.zenrows.com/scraping-browser/features/world-region
 */
const ZENROWS_WORLD_REGIONS = new Set(['na', 'eu', 'ap', 'sa', 'af', 'me']);

/**
 * When `ZENROWS_PROXY_COUNTRY` is unset, pick `proxy_country` from the query (align with SerpAPI `gl` / target market).
 * Checked before the US state-regex so "India" etc. are not confused with Indiana (`in`).
 */
function zenrowsInferProxyCountryFromKeyword(keyword) {
  const q = String(keyword || '').toLowerCase();
  if (!q) return null;
  if (
    /\b(india|bharat|delhi|mumbai|bengaluru|bangalore|hyderabad|chennai|kolkata|pune|ahmedabad|jaipur|gurgaon|gurugram|noida)\b/.test(
      q
    )
  ) {
    return 'in';
  }
  if (/\b(london|manchester|birmingham|england|scotland|wales|united kingdom)\b/.test(q) || /\b(uk|gb)\b/.test(q)) {
    return 'gb';
  }
  if (/\b(berlin|munich|hamburg|frankfurt|germany|deutschland)\b/.test(q)) return 'de';
  if (/\b(paris|lyon|marseille|france)\b/.test(q)) return 'fr';
  if (
    q.includes('usa') ||
    /\b(tx|ca|ny|fl|il|oh|pa|ga|nc|mi|nj|va|wa|az|ma|tn|in|mo|md|wi|co|mn|sc|al|la|ky|or|ok|ct|ia|ar|ms|ks|ut|nv|nm|wv|ne|id|hi|nh|me|ri|mt|de|sd|nd|ak|vt|wy|dc)\b/.test(
      q
    )
  ) {
    return 'us';
  }
  return null;
}

function zenrowsWorldRegionFromEnv(raw) {
  const x = String(raw || '').trim().toLowerCase();
  if (ZENROWS_WORLD_REGIONS.has(x)) return x;
  if (['us', 'usa'].includes(x)) return 'na';
  if (['uk', 'gb', 'de', 'fr', 'es', 'it', 'nl', 'ie'].includes(x)) return 'eu';
  if (['as', 'sg', 'jp', 'in', 'au', 'nz', 'kr'].includes(x)) return 'ap';
  if (['br', 'ar', 'mx'].includes(x)) return 'sa';
  if (['za', 'ng'].includes(x)) return 'af';
  if (['ae', 'il'].includes(x)) return 'me';
  if (!x) return 'na';
  return 'na';
}

function zenrowsDefaultLocationToken() {
  const c = (process.env.ZENROWS_PROXY_COUNTRY || '').trim().toLowerCase();
  if (c && /^[a-z]{2}$/.test(c)) return c;
  return zenrowsWorldRegionFromEnv(process.env.ZENROWS_PROXY_REGION);
}

/**
 * Deduped list: ISO codes → proxy_country attempts; world codes → proxy_region attempts.
 * @param {string} [keyword] — when `ZENROWS_PROXY_COUNTRY` unset and auto not off, infer `proxy_country` (e.g. US query → us).
 */
function scrapflyLocationConnectionAttempts(keyword = '') {
  const primary = (process.env.SCRAPFLY_PROXY_COUNTRY || 'us').trim().toLowerCase();
  const rawFb = (process.env.SCRAPFLY_PROXY_COUNTRY_FALLBACKS || 'de,gb').trim();
  const fallbacks = rawFb
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z]{2}$/.test(s));

  const q = String(keyword || '').toLowerCase();
  let inferred = null;
  if (/\b(india|delhi|mumbai|bangalore|hyderabad|chennai|pune|ahmedabad)\b/.test(q)) inferred = 'in';
  else if (/\b(london|england|scotland|wales|uk|gb)\b/.test(q)) inferred = 'gb';
  else if (/\b(germany|berlin|munich|frankfurt)\b/.test(q)) inferred = 'de';
  else if (/usa|\b(tx|ca|ny|fl|il|oh|pa|ga|nc|mi)\b/.test(q)) inferred = 'us';

  const base = inferred || primary;
  const seen = new Set();
  const out = [];
  for (const c of [base, primary, ...fallbacks]) {
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out.length ? out : ['us'];
}

/**
 * @param {string} [locationToken] — world code (na, eu, …) or ISO country (us, de, …). Omit → .env default.
 */
function buildScrapflyBrowserWsUrl(countryCode) {
  const apiKey = (process.env.SCRAPFLY_API_KEY || '').trim();
  if (!apiKey) return null;
  const pool = (process.env.SCRAPFLY_PROXY_POOL || 'residential').trim();
  const country = countryCode || (process.env.SCRAPFLY_PROXY_COUNTRY || 'us').trim();

  const p = new URLSearchParams({
    api_key: apiKey,
    proxy_pool: pool,
  });
  if (country && /^[a-z]{2}$/i.test(country)) {
    p.set('country', country.toLowerCase());
  }
  return `wss://browser.scrapfly.io?${p.toString()}`;
}

/**
 * Local Chromium (proxy/stealth) or ZenRows cloud browser when `ZENROWS_API_KEY` is set.
 * ZenRows = remote Playwright CDP — no local Chrome window on your machine.
 */
async function getCaptureBrowserAndPage(playwright, scrapflyCountry) {
  const ws = buildScrapflyBrowserWsUrl(scrapflyCountry);
  if (ws) {
    const country = scrapflyCountry || process.env.SCRAPFLY_PROXY_COUNTRY || 'us';
    const pool = process.env.SCRAPFLY_PROXY_POOL || 'residential';
    console.log(`[Capture] Scrapfly Cloud Browser (connectOverCDP) country=${country} pool=${pool}`);
    const browser = await playwright.chromium.connectOverCDP(ws, { timeout: 120000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error('Scrapfly: no browser context from CDP endpoint');
    let page;
    try {
      page = await context.newPage();
    } catch {
      page = context.pages().find((p) => p && !p.isClosed()) || null;
    }
    if (!page) {
      try {
        page = await context.newPage();
      } catch {
        throw new Error('Scrapfly: could not create or reuse a Playwright page');
      }
    }
    await page.addInitScript({ content: STEALTH_SCRIPT }).catch(() => { });
    return { browser, page, zenrows: true };
  }

  const hasDisplay = await ensureVirtualDisplay();
  const headless = !hasDisplay && detectHeadlessMode();
  const browser = await launchChromium(playwright, headless);
  const context = await browser.newContext(SNIPER_CONTEXT);
  const page = await context.newPage();
  await page.addInitScript({ content: STEALTH_SCRIPT });
  return { browser, page, zenrows: false };
}

/**
 * Approximate visible Place rows for hydration loops (matches extract root fallbacks).
 */
function udm1PlacesHeadingsCountScript() {
  return () => {
    const root =
      document.querySelector('#rso') ||
      document.querySelector('#center_col') ||
      document.querySelector('div[role="main"]') ||
      document.querySelector('#main') ||
      document.querySelector('#search') ||
      document.body;
    const bad = (t) =>
      !t || t.length < 2 || /people also ask|related questions|reviews from the web/i.test(t);
    const fromCid = Array.from(root.querySelectorAll('[data-cid]')).filter((card) => {
      const h = card.querySelector('h3') || card.querySelector('h2');
      if (!h) return false;
      const t = (h.textContent || '').trim();
      return !bad(t);
    }).length;
    const h3n = Array.from(root.querySelectorAll('h3, h2, [role="heading"][aria-level="3"]')).filter((h) => {
      const t = (h.textContent || '').trim();
      if (bad(t)) return false;
      return (
        !!h.closest('a[href*="/maps/place"]') ||
        !!h.closest('[data-cid]') ||
        !!h.closest('.VkpUv') ||
        !!h.closest('.rllt__card')
      );
    }).length;
    const mapLinks = root.querySelectorAll('a[href*="/maps/place"], a[href*="/maps?q="]').length;
    return Math.max(fromCid, h3n, mapLinks);
  };
}

/**
 * Google `udm=1` often mounts only a few Place cards until the list is scrolled.
 * Without this, slot 7+ can be missing from the DOM and scroll-by-index silently no-ops.
 */
async function ensureUdm1PlacesListHydratedForSlot(page, slot1Based) {
  const need = Math.min(20, Math.max(1, Math.floor(Number(slot1Based)) || 1));
  const countFn = udm1PlacesHeadingsCountScript();
  const scrollNextChunk = () => {
    const root =
      document.querySelector('#rso') ||
      document.querySelector('#center_col') ||
      document.querySelector('div[role="main"]') ||
      document.querySelector('#search') ||
      document.body;
    if (!root || root === document.body) {
      window.scrollBy(0, 520);
      return;
    }
    const cards = Array.from(root.querySelectorAll('[data-cid]'));
    if (cards.length) {
      cards[cards.length - 1].scrollIntoView({ block: 'end' });
      return;
    }
    const heads = Array.from(root.querySelectorAll('h3')).filter((h) => {
      const t = (h.textContent || '').trim();
      if (t.length < 2) return false;
      if (/people also ask|related questions|reviews from the web/i.test(t)) return false;
      return (
        !!h.closest('a[href*="/maps/place"]') ||
        !!h.closest('[data-cid]') ||
        !!h.closest('.VkpUv')
      );
    });
    const last = heads[heads.length - 1];
    if (last) last.scrollIntoView({ block: 'end' });
    else window.scrollBy(0, 520);
  };

  for (let step = 0; step < 34; step++) {
    const count = await page.evaluate(countFn);
    if (count >= need) {
      if (step > 0) {
        console.log(
          `[GoogleLclCapture] udm=1 Places column hydrated after ${step} scroll steps (${count} cards in DOM, need ${need})`
        );
      }
      return count;
    }
    await page.evaluate(scrollNextChunk);
    await new Promise((t) => setTimeout(t, 420));
  }
  const final = await page.evaluate(countFn);
  console.warn(
    `[GoogleLclCapture] udm=1 Places list still short for slot ${need}: ${final} cards in DOM after hydrate loop`
  );
  return final;
}

/**
 * Scroll a specific slot (1-20) on the current udm=1 page into viewpoint.
 */
async function scrollUdm1SlotIntoView(page, slot1Based) {
  const slot = Math.floor(Number(slot1Based));
  if (!Number.isFinite(slot) || slot < 1 || slot > 20) return false;

  const ok = await page
    .evaluate((idx0) => {
      const root =
        document.querySelector('#rso') ||
        document.querySelector('#center_col') ||
        document.querySelector('div[role="main"]') ||
        document.querySelector('#main');
      if (!root) return false;
      const heads = Array.from(root.querySelectorAll('h3')).filter((h) => {
        const t = (h.textContent || '').trim();
        if (t.length < 2) return false;
        if (/people also ask|related questions|reviews from the web/i.test(t)) return false;
        const inPlacesCard =
          !!h.closest('a[href*="/maps/place"]') ||
          !!h.closest('[data-cid]') ||
          !!h.closest('.VkpUv');
        return inPlacesCard;
      });
      const el = heads[idx0];
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      return true;
    }, slot - 1)
    .catch(() => false);

  if (ok) {
    console.log(`[GoogleLclCapture] Viewport aligned to SerpAPI page slot ${slot} (1…20 on this start= page)`);
  } else {
    console.warn(
      `[GoogleLclCapture] Could not scroll to slot ${slot}: card missing in DOM (lazy list order mismatch or different SERP than SerpAPI).`
    );
  }
  return ok;
}

/**
 * Measure listing position on the live `udm=1` page (DOM order). Organic index skips best-effort "Sponsored" cards.
 * `observedAbsoluteOrganicRank` matches what users usually count on the left list (organic pack).
 */
async function computeObservedUdm1Rank(page, titleNeedle, pageStart) {
  const gmb = normalizeGmbNameForMatch(titleNeedle);
  const start = Math.max(0, Math.min(100, Math.floor(Number(pageStart)) || 0));
  const empty = {
    observedSlotOnPage: null,
    observedAbsoluteRank: null,
    observedOrganicSlotOnPage: null,
    observedAbsoluteOrganicRank: null,
    observedMatchIsSponsored: null,
    observedMatchedHeading: null,
  };
  if (!gmb || gmb.length < 2) return empty;

  const evaluated = await page
    .evaluate(
      ({ fullGmbNorm: n, pageStart: st }) => {
        const norm = (s) =>
          String(s || '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
        const strictMatchNorms = (a, b) => {
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
        };
        const titleMatches = (h3Text) => {
          let x = norm(h3Text);
          x = x.replace(/\s*&\s*/g, ' and ');
          x = x.replace(/\band\b/gi, 'and');
          x = x.replace(/[^\p{L}\p{N}\s]+/gu, ' ');
          x = x.replace(/\s+/g, ' ').trim();
          return strictMatchNorms(n, x);
        };

        const isNoise = (t) =>
          /people also ask|related questions|reviews from the web/i.test(t);

        const isSponsoredH3 = (h3) => {
          let el = h3.closest('[data-cid]') || h3.closest('.VkpUv') || h3.parentElement;
          for (let i = 0; i < 12 && el; i++) {
            // ONLY count if "Sponsored" or "Ad" text is present in the label/container
            const txt = (el.innerText || '').slice(0, 1000);
            if (/Sponsored|Advert|· Ad\b|^Ad\s/i.test(txt)) return true;
            if (el.querySelector?.('[aria-label*="Sponsored" i], [aria-label*="Ad" i]')) return true;
            el = el.parentElement;
          }
          return false;
        };

        const pickRoot = () =>
          document.querySelector('#rso') ||
          document.querySelector('#center_col') ||
          document.querySelector('div[role="main"]') ||
          document.querySelector('#main') ||
          document.body;
        const rso = pickRoot();
        if (!rso) return { ok: false, reason: 'no udm=1 root' };

        const heads = Array.from(rso.querySelectorAll('h3, h2, [role="heading"][aria-level="3"]')).filter((h) => {
          const t = (h.textContent || '').trim();
          if (t.length < 2 || isNoise(t)) return false;
          return (
            !!h.closest('a[href*="/maps/place"]') ||
            !!h.closest('a[href*="/maps?q="]') ||
            !!h.closest('[data-cid]') ||
            !!h.closest('.VkpUv') ||
            !!h.closest('.rllt__card')
          );
        });

        let matchedIdx = -1;
        let matchedHeading = null;
        for (let i = 0; i < heads.length; i++) {
          if (titleMatches((heads[i].textContent || '').trim())) {
            matchedIdx = i;
            matchedHeading = (heads[i].textContent || '').trim().slice(0, 200);
            break;
          }
        }
        if (matchedIdx < 0) return { ok: false, reason: 'title not in list', headsCount: heads.length };

        const observedSlotOnPage = matchedIdx + 1;
        let organicSlot = 0;
        for (let i = 0; i <= matchedIdx; i++) {
          if (!isSponsoredH3(heads[i])) organicSlot += 1;
        }
        const matchSponsored = isSponsoredH3(heads[matchedIdx]);
        const observedAbsoluteRank = st + observedSlotOnPage;
        const observedAbsoluteOrganicRank = matchSponsored ? null : st + organicSlot;

        return {
          ok: true,
          observedSlotOnPage,
          observedAbsoluteRank,
          observedOrganicSlotOnPage: organicSlot,
          observedAbsoluteOrganicRank,
          observedMatchIsSponsored: matchSponsored,
          observedMatchedHeading: matchedHeading,
          headsCount: heads.length,
        };
      },
      { fullGmbNorm: gmb, pageStart: start }
    )
    .catch(() => ({ ok: false, reason: 'evaluate failed' }));

  if (!evaluated?.ok) {
    console.warn(`[GoogleLclCapture] Observed rank unavailable: ${evaluated?.reason || 'unknown'}`);
    return empty;
  }

  const {
    ok: _o,
    reason: _r,
    headsCount: hc,
    observedSlotOnPage,
    observedAbsoluteRank,
    observedOrganicSlotOnPage,
    observedAbsoluteOrganicRank,
    observedMatchIsSponsored,
    observedMatchedHeading,
  } = evaluated;
  console.log(
    `[GoogleLclCapture] Observed udm=1: organic absolute #${observedAbsoluteOrganicRank ?? 'n/a'} (organic slot ${observedOrganicSlotOnPage}, all slots ${observedSlotOnPage}${observedMatchIsSponsored ? ', matched card sponsored' : ''}) · ${hc} place headings in DOM`
  );

  return {
    observedSlotOnPage,
    observedAbsoluteRank,
    observedOrganicSlotOnPage,
    observedAbsoluteOrganicRank,
    observedMatchIsSponsored,
    observedMatchedHeading,
  };
}

/**
 * Local Finder (tbm=lcl) pack: FUZZY GMB name matching (strict first, then brand tokens).
 * Returns null if no card matches.
 */
export async function resolveStrictLocalFinderListing(page, businessName, pageStart, keyword = '') {
  const st = Math.max(0, Math.min(680, Math.floor(Number(pageStart)) || 0));
  const gmb = normalizeGmbNameForMatch(businessName);
  if (!gmb || gmb.length < 2) return null;

  const bizNameRaw = String(businessName || '').trim();
  const keywordRaw = String(keyword || '').trim();

  const out = await page
    .evaluate(
      ({ pageStart: ps, fullGmbNorm: gmbNorm, bizNameRaw, keywordRaw }) => {
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
        
        // Fuzzy matching using distinctive brand tokens
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
        
        function cardFirstLine(el) {
          const t = el.innerText || '';
          return (t.split('\n').map((x) => x.trim()).find(Boolean) || '').trim();
        }
        function isSponsoredCard(el) {
          const txt = String(el.innerText || '').slice(0, 1200);
          if (/Sponsored|Advert|· Ad\b|^Ad\s/i.test(txt)) return true;
          if (el.querySelector?.('[aria-label*="Sponsored" i], [aria-label*="Ad" i]')) return true;
          return false;
        }
        const listRoot =
          document.querySelector('#center_col') ||
          document.querySelector('#rso') ||
          document.querySelector('div[role="main"]') ||
          document.body;
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
        const raw = Array.from(
          listRoot.querySelectorAll('.rllt__details, .VkpGBb, [data-cid], .uMdZh, .rllt__card')
        ).filter(isRowLike);
        // One row can match multiple selectors (nested .rllt__details inside .rllt__card). Drop inner duplicates.
        const deduped = raw.filter((el) => !raw.some((other) => other !== el && other.contains(el)));
        deduped.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          const dy = ra.top - rb.top;
          if (Math.abs(dy) > 6) return dy;
          return ra.left - rb.left;
        });
        const nodes = deduped;

        // First pass: strict matching
        let matchedIdx = -1;
        let matchType = null;
        
        for (let i = 0; i < nodes.length; i++) {
          const line = normalizeTitleStrict(cardFirstLine(nodes[i]));
          if (strictMatchNorms(gmbNorm, line)) {
            matchedIdx = i;
            matchType = 'strict';
            break;
          }
        }
        
        // Second pass: fuzzy brand matching if strict failed
        if (matchedIdx < 0) {
          for (let i = 0; i < nodes.length; i++) {
            const title = cardFirstLine(nodes[i]);
            if (fuzzyBrandMatch(bizNameRaw, title, keywordRaw)) {
              matchedIdx = i;
              matchType = 'fuzzy';
              break;
            }
          }
        }
        
        if (matchedIdx < 0) return null;

        const el = nodes[matchedIdx];
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return null;

        const slotOnPage = matchedIdx + 1;
        let organicSlot = 0;
        for (let i = 0; i <= matchedIdx; i++) {
          if (!isSponsoredCard(nodes[i])) organicSlot += 1;
        }
        const matchSponsored = isSponsoredCard(el);
        const observedAbsoluteRank = ps + slotOnPage;
        const observedAbsoluteOrganicRank = matchSponsored ? null : ps + organicSlot;

        return {
          rect: { x: r.left, y: r.top, width: r.width, height: r.height },
          observedSlotOnPage: slotOnPage,
          observedOrganicSlotOnPage: organicSlot,
          observedAbsoluteRank,
          observedAbsoluteOrganicRank,
          observedMatchIsSponsored: matchSponsored,
          observedMatchedHeading: cardFirstLine(el).slice(0, 200),
          matchType,
        };
      },
      { pageStart: st, fullGmbNorm: gmb, bizNameRaw, keywordRaw }
    )
    .catch(() => null);

  if (out?.observedMatchedHeading) {
    console.log(
      `[GoogleLclCapture] tbm=lcl match (${out.matchType || 'strict'}): "${out.observedMatchedHeading}" slot=${out.observedSlotOnPage} absolute=#${out.observedAbsoluteRank}`
    );
  }
  return out || null;
}

/**
 * udm=1 Google Search Places column: FUZZY GMB title match (strict first, then brand tokens).
 * Returns null if the target business is not on this SERP page.
 */
export async function resolveStrictUdm1PlaceListing(page, businessName, pageStart, keyword = '') {
  const st = Math.max(0, Math.min(100, Math.floor(Number(pageStart)) || 0));
  const gmb = normalizeGmbNameForMatch(businessName);
  if (!gmb || gmb.length < 2) return null;

  const bizNameRaw = String(businessName || '').trim();
  const keywordRaw = String(keyword || '').trim();

  const out = await page
    .evaluate(
      ({ pageStart: ps, fullGmbNorm: gmbNorm, bizNameRaw, keywordRaw }) => {
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
        
        // Fuzzy matching using distinctive brand tokens
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
        
        const isNoise = (t) => /people also ask|related questions|reviews from the web/i.test(t);
        const isSponsoredH3 = (h3) => {
          let el = h3.closest('[data-cid]') || h3.closest('.VkpUv') || h3.parentElement;
          for (let i = 0; i < 12 && el; i++) {
            const txt = (el.innerText || '').slice(0, 1000);
            if (/Sponsored|Advert|· Ad\b|^Ad\s/i.test(txt)) return true;
            if (el.querySelector?.('[aria-label*="Sponsored" i], [aria-label*="Ad" i]')) return true;
            el = el.parentElement;
          }
          return false;
        };
        const root =
          document.querySelector('#rso') ||
          document.querySelector('#center_col') ||
          document.querySelector('div[role="main"]') ||
          document.querySelector('#main') ||
          document.body;
        const heads = Array.from(
          root.querySelectorAll('h3, h2, [role="heading"][aria-level="3"]')
        ).filter((h) => {
          const t = (h.textContent || '').trim();
          if (t.length < 2 || isNoise(t)) return false;
          return (
            !!h.closest('a[href*="/maps/place"]') ||
            !!h.closest('a[href*="/maps?q="]') ||
            !!h.closest('[data-cid]') ||
            !!h.closest('.VkpUv') ||
            !!h.closest('.rllt__card')
          );
        });

        // First pass: strict matching
        let matchedIdx = -1;
        let matchedHeading = null;
        let matchType = null;
        
        for (let i = 0; i < heads.length; i++) {
          const line = normalizeTitleStrict((heads[i].textContent || '').trim());
          if (strictMatchNorms(gmbNorm, line)) {
            matchedIdx = i;
            matchedHeading = (heads[i].textContent || '').trim().slice(0, 200);
            matchType = 'strict';
            break;
          }
        }
        
        // Second pass: fuzzy brand matching if strict failed
        if (matchedIdx < 0) {
          for (let i = 0; i < heads.length; i++) {
            const title = (heads[i].textContent || '').trim();
            if (fuzzyBrandMatch(bizNameRaw, title, keywordRaw)) {
              matchedIdx = i;
              matchedHeading = title.slice(0, 200);
              matchType = 'fuzzy';
              break;
            }
          }
        }
        
        if (matchedIdx < 0) return null;

        const h = heads[matchedIdx];
        const card =
          h.closest('[data-cid]') ||
          h.closest('.VkpUv') ||
          h.closest('.rllt__card') ||
          h.closest('div[jscontroller]') ||
          h;
        card.scrollIntoView({ behavior: 'instant', block: 'center' });
        const r = card.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return null;

        const observedSlotOnPage = matchedIdx + 1;
        let organicSlot = 0;
        for (let i = 0; i <= matchedIdx; i++) {
          if (!isSponsoredH3(heads[i])) organicSlot += 1;
        }
        const matchSponsored = isSponsoredH3(h);
        const observedAbsoluteRank = ps + observedSlotOnPage;
        const observedAbsoluteOrganicRank = matchSponsored ? null : ps + organicSlot;

        return {
          rect: { x: r.left, y: r.top, width: r.width, height: r.height },
          observedSlotOnPage,
          observedOrganicSlotOnPage: organicSlot,
          observedAbsoluteRank,
          observedAbsoluteOrganicRank,
          observedMatchIsSponsored: matchSponsored,
          observedMatchedHeading: matchedHeading,
          matchType,
        };
      },
      { pageStart: st, fullGmbNorm: gmb, bizNameRaw, keywordRaw }
    )
    .catch(() => null);

  if (out?.observedMatchedHeading) {
    console.log(
      `[GoogleLclCapture] udm=1 match (${out.matchType || 'strict'}): "${out.observedMatchedHeading}" slot=${out.observedSlotOnPage} absolute=#${out.observedAbsoluteRank}`
    );
  }
  return out || null;
}

/** @returns {Promise<boolean>} */
async function scrollUdm1PlaceTitleIntoView(page, titleNeedle) {
  const raw = String(titleNeedle || '').trim();
  if (!raw || raw.length < 2) return false;
  const pattern = raw
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .slice(0, 90);
  if (!pattern) return false;
  const re = new RegExp(pattern, 'i');

  const headingScopes = [
    '#rso h3, #rso [role="heading"][aria-level="3"]',
    '#center_col h3, #center_col [role="heading"][aria-level="3"]',
    'div[role="main"] h3, div[role="main"] [role="heading"][aria-level="3"]',
  ];
  for (const scope of headingScopes) {
    try {
      const heading = page.locator(scope).filter({ hasText: re }).first();
      if (await heading.isVisible({ timeout: 3500 }).catch(() => false)) {
        await heading.scrollIntoViewIfNeeded();
        await new Promise((t) => setTimeout(t, 650));
        return true;
      }
    } catch (_) { }
  }

  try {
    const linkRow = page
      .locator(
        '#rso a[href*="/maps/place"], #center_col a[href*="/maps/place"], div[role="main"] a[href*="/maps/place"]'
      )
      .filter({ hasText: re })
      .first();
    if (await linkRow.isVisible({ timeout: 4000 }).catch(() => false)) {
      await linkRow.scrollIntoViewIfNeeded();
      await new Promise((t) => setTimeout(t, 600));
      return true;
    }
  } catch (_) { }
  return false;
}

function udm1ZenrowsFastCaptureEnabled() {
  return String(process.env.ZENROWS_UDM1_FAST_CAPTURE || 'true').toLowerCase() !== 'false';
}

function parseUdm1CaptureBudgetMs() {
  const raw = Number(process.env.ZENROWS_UDM1_CAPTURE_BUDGET_MS);
  if (Number.isFinite(raw)) return Math.max(8000, Math.min(120000, Math.floor(raw)));
  return 80000;
}

function parseUdm1PerAttemptBudgetMs(totalBudgetMs, attemptsCount) {
  void totalBudgetMs;
  void attemptsCount;
  const raw = Number(process.env.ZENROWS_UDM1_CAPTURE_BUDGET_PER_ATTEMPT_MS);
  if (Number.isFinite(raw)) return Math.max(10000, Math.min(120000, Math.floor(raw)));
  // Default: keep one full 80s window per attempt, then retry.
  return 80000;
}

function parseUdm1CloudRetryCount() {
  const raw = Number(process.env.ZENROWS_UDM1_RETRY_PER_LOCATION);
  if (!Number.isFinite(raw)) return 2;
  return Math.max(1, Math.min(4, Math.floor(raw)));
}

function parseUdm1RetryBackoffBaseMs() {
  const raw = Number(process.env.ZENROWS_UDM1_RETRY_BACKOFF_MS);
  if (!Number.isFinite(raw)) return 1500;
  return Math.max(500, Math.min(10000, Math.floor(raw)));
}

function isRetryableUdm1CloudError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    /timeout|timed out|navigation budget exceeded/.test(msg) ||
    /assertion error|assert/.test(msg) ||
    /connectovercdp|websocket|cdp connection|allocation failed|proxy unavailable/.test(msg) ||
    /err::browser::allocation_failed|err::browser::cdp_connection_failed|err::browser::websocket_upgrade_failed/.test(
      msg
    )
  );
}

function udm1RetryDelayMs(retryIndex, baseMs) {
  const n = Math.max(0, Number(retryIndex) || 0);
  return Math.min(12000, Math.floor(baseMs * Math.pow(2, n)));
}

async function withUdm1Budget(label, fn, budgetCtx) {
  const left = Math.max(0, budgetCtx.deadline - Date.now());
  if (left <= 0) {
    console.warn(`[GoogleLclCapture] Skipping ${label} (time budget exhausted)`);
    return null;
  }
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[GoogleLclCapture] ${label} timed out after ${left}ms (budget guard)`);
          resolve(null);
        }, left);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** SerpAPI verify URL already loaded — scroll until GMB title is in viewport. */
async function scrollUdm1UntilGmbInViewport(page, scrollToTitle, serpSlot) {
  const title = String(scrollToTitle || '').trim();
  if (title.length < 2) return false;

  const rawMax = Number(process.env.ZENROWS_UDM1_SCROLL_TO_GMB_MAX_STEPS);
  const maxSteps = Number.isFinite(rawMax)
    ? Math.max(10, Math.min(80, Math.floor(rawMax)))
    : udm1ZenrowsFastCaptureEnabled()
      ? 36
      : 48;

  for (let step = 0; step < maxSteps; step++) {
    if (await scrollUdm1PlaceTitleIntoView(page, title)) {
      console.log(`[GoogleLclCapture] GMB in viewport after ${step} scroll step(s)`);
      return true;
    }
    if (step > 0 && step % 10 === 0) {
      await ensureUdm1PlacesListHydratedForSlot(
        page,
        Math.min(20, Math.max(serpSlot, 8))
      ).catch(() => { });
    }
    await page
      .evaluate(() => {
        const col =
          document.querySelector('#center_col') ||
          document.querySelector('#rso') ||
          document.querySelector('div[role="main"]') ||
          document.scrollingElement ||
          document.documentElement;
        if (col && col !== document.documentElement && col.scrollHeight > col.clientHeight) {
          col.scrollTop += 460;
        } else {
          window.scrollBy(0, 520);
        }
      })
      .catch(() => { });
    await new Promise((r) => setTimeout(r, udm1ZenrowsFastCaptureEnabled() ? 300 : 400));
  }
  return false;
}

function parseUdm1CaptureTimeouts() {
  const rawGoto = Number(process.env.CAPTURE_GOTO_TIMEOUT_MS);
  const rawReady = Number(process.env.CAPTURE_PAGE_READY_MS);
  const gotoMs = Number.isFinite(rawGoto)
    ? Math.max(30000, Math.min(240000, rawGoto))
    : 80000;
  const readyMs = Number.isFinite(rawReady)
    ? Math.max(20000, Math.min(180000, rawReady))
    : 80000;
  return { gotoMs, readyMs };
}

/**
 * ZenRows / cloud: one `goto` to the exact rank URL, brief settle, screenshot.
 * Avoids `waitForSelector(…visible)` on compound selectors — Google often has many
 * `[data-async-context]` nodes that match but aren’t “visible”, causing long retries.
 */
async function gotoUdm1SingleShotZenrows(page, url, opts = {}) {
  const { gotoMs } = parseUdm1CaptureTimeouts();
  const fast = !!opts.fast;
  const raw = Number(process.env.ZENROWS_UDM1_SETTLE_MS);
  let settleMs;
  if (Number.isFinite(raw)) {
    settleMs = Math.max(1000, Math.min(15000, raw));
  } else {
    settleMs = fast ? 3200 : 5000;
  }

  console.log(
    `[GoogleLclCapture] Cloud CDP → Serp URL (domcontentloaded + ${settleMs}ms settle${fast ? ', fast' : ''})`
  );
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: gotoMs });
  await new Promise((r) => setTimeout(r, fast ? 500 : 900));
  try {
    const consent = page
      .locator('button, div[role="button"]')
      .filter({ hasText: /accept all|i agree|got it|सहमत|स्वीकार/i });
    const consentMs = fast ? 2800 : 4000;
    if (await consent.first().isVisible({ timeout: consentMs }).catch(() => false)) {
      await consent.first().click({ timeout: 2000 }).catch(() => { });
      await new Promise((r) => setTimeout(r, fast ? 400 : 600));
    }
  } catch (_) { }
  await new Promise((r) => setTimeout(r, settleMs));
}

/** Cloud browser: fail only on obvious proxy HTML — do not wait for visible `[data-async-context]`. */
async function assertZenRowsNoHardFail(page) {
  let bodyText = '';
  try {
    bodyText = ((await page.textContent('body')) || '').toLowerCase();
  } catch {
    return;
  }
  if (
    /proxy.*timed out|proxy connection attempt timed out|upstream connect error|access denied/.test(
      bodyText
    )
  ) {
    throw new Error(
      'ZenRows proxy error page instead of Google. Try another ZENROWS_PROXY_REGION (world: na,eu,ap,…) or ZENROWS_PROXY_COUNTRY (ISO: us,de) / fallbacks.'
    );
  }
}

async function assertGoogleSerpUsable(page) {
  let bodyText = '';
  try {
    bodyText = ((await page.textContent('body')) || '').toLowerCase();
  } catch {
    bodyText = '';
  }
  const proxyError =
    /proxy.*timed out|proxy connection attempt timed out|upstream connect error|error 403|access denied/.test(
      bodyText
    );
  if (proxyError) {
    throw new Error(
      'Proxy/block page instead of Google SERP. Increase CAPTURE_GOTO_TIMEOUT_MS or change proxy.'
    );
  }
  const attached = await page
    .locator('#rso, #search, form[role="search"], textarea[name="q"]')
    .first()
    .waitFor({ state: 'attached', timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (attached) return;
  throw new Error('Google SERP shell did not render; page is not usable for screenshot.');
}

/**
 * `domcontentloaded` often never fires on Google behind slow / streaming proxies.
 * `commit` finishes when the navigation commits; we then wait for SERP shell selectors.
 */
async function gotoUdm1RankPage(page, url) {
  const { gotoMs, readyMs } = parseUdm1CaptureTimeouts();
  const serpShell = '#rso, #search, #main, form[role="search"], textarea[name="q"]';
  let lastErr;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 3000));
      console.warn('[GoogleLclCapture] Retrying navigation (attempt 2)');
    }
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: gotoMs });
      await new Promise((r) => setTimeout(r, 1200));
      try {
        const consent = page
          .locator('button, div[role="button"]')
          .filter({ hasText: /accept all|i agree|got it|सहमत|स्वीकार/i });
        if (await consent.first().isVisible({ timeout: 4000 }).catch(() => false)) {
          await consent.first().click({ timeout: 2000 }).catch(() => { });
          await new Promise((r) => setTimeout(r, 600));
        }
      } catch (_) { }
      await page.waitForSelector(serpShell, { state: 'attached', timeout: readyMs });
      return;
    } catch (e) {
      lastErr = e;
      console.warn(
        `[GoogleLclCapture] goto+wait attempt ${attempt + 1}:`,
        e?.message || e
      );
    }
  }

  try {
    throw lastErr;
  } catch (e) {
    lastErr = e;
  }

  const base = lastErr?.message || String(lastErr);
  if (/timeout|Timeout/i.test(base)) {
    throw new Error(
      `${base} — Slow or blocked load via proxy. Try CAPTURE_GOTO_TIMEOUT_MS=180000, ` +
      `CAPTURE_PAGE_READY_MS=120000, a faster residential proxy, or CAPTURE_HEADLESS=false locally.`
    );
  }
  throw lastErr;
}

const UDM1_RANK_OVERLAY_RED = '#e4181f';

/** Strict GMB-only rect on udm=1 (no DataForSEO slot fallback). */
async function getUdm1PlaceCardRect(page, titleNeedle, pageStart) {
  const resolved = await resolveStrictUdm1PlaceListing(page, titleNeedle, pageStart);
  if (!resolved?.rect) return null;
  return {
    ...resolved.rect,
    detectedOrganicRank: resolved.observedAbsoluteOrganicRank ?? resolved.observedAbsoluteRank,
  };
}

async function injectUdm1RankOverlayOnPage(page, rect, rankNum) {
  if (!rect || rect.width < 8 || rect.height < 8) return;
  const r = Math.round(Number(rankNum));
  const label = Number.isFinite(r) && r > 0 ? r : 1;
  await page.evaluate(
    ({ x, y, width, height, rankLabel, color }) => {
      const id = 'gmb-udm1-rank-overlay';
      document.getElementById(id)?.remove();
      const pad = 8;
      const border = 4;
      const rx = Math.max(0, x - pad);
      const ry = Math.max(0, y - pad);
      const rw = width + 2 * pad;
      const rh = height + 2 * pad;
      const wrap = document.createElement('div');
      wrap.id = id;
      wrap.setAttribute('data-gmb-rank-annotate', '1');
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
    { ...rect, rankLabel: label, color: UDM1_RANK_OVERLAY_RED },
  );
}

/**
 * Use OpenAI Vision API to detect exact GMB position in screenshot
 * @param {Buffer} imageBuffer - Screenshot PNG buffer
 * @param {string} businessName - Target GMB business name to find
 * @param {number} expectedRank - Expected rank from DataForSEO
 * @param {Object} sharp - Sharp module (passed to avoid re-importing)
 * @returns {Promise<{x: number, y: number, width: number, height: number} | null>}
 */
async function detectGmbPositionWithAI_LCL(imageBuffer, businessName, expectedRank, sharp) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('[AI-GMB-LCL] No OPENAI_API_KEY found');
    return null;
  }

  const OpenAI = (await import('openai')).default;
  const openai = new OpenAI({ apiKey });

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
    console.log(`[AI-GMB-LCL] Raw response: ${content}`);

    if (!content) return null;

    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[AI-GMB-LCL] No JSON found in response');
      return null;
    }

    const result = JSON.parse(jsonMatch[0]);
    
    if (!result.found) {
      console.log(`[AI-GMB-LCL] Business "${businessName}" NOT FOUND in screenshot`);
      return null;
    }

    // Validate coordinates
    const rect = {
      x: Math.max(0, Math.min(imgWidth - 50, result.x || 0)),
      y: Math.max(0, Math.min(imgHeight - 50, result.y || 0)),
      width: Math.max(100, Math.min(500, result.width || 400)),
      height: Math.max(80, Math.min(200, result.height || 120)),
    };

    console.log(`[AI-GMB-LCL] Found "${businessName}" at x=${rect.x}, y=${rect.y}, w=${rect.width}, h=${rect.height}, visual_rank=${result.visual_rank || 'unknown'}`);
    
    return rect;
  } catch (err) {
    console.error(`[AI-GMB-LCL] OpenAI API error: ${err?.message || err}`);
    return null;
  }
}

/**
 * Screenshot Google Search using Scrapfly Screenshot API ONLY (NO browser).
 * Uses check_url directly and DataForSEO rank for overlay position estimation.
 */
export async function captureGoogleSearchLocalScreenshot({
  keyword,
  rank,
  scrollToTitle,
  googleSearchUrl: googleSearchUrlOpt,
  verifyGoogleSearchUrl: verifyUrlOpt,
  rankSlotOnSerpPage: rankSlotBody,
  localSerpStart: localStartBody,
  targetXpath: _targetXpath,
  targetCid: _targetCid,
}) {
  void _targetXpath;
  void _targetCid;
  const q = String(keyword || '').trim();
  const r = Math.max(1, Math.min(100, Number(rank) || 1));
  if (!q) throw new Error('captureGoogleSearchLocalScreenshot: keyword required.');
  
  const explicit = String(googleSearchUrlOpt || verifyUrlOpt || '').trim();
  if (!explicit || !/^https?:\/\//i.test(explicit)) {
    throw new Error(
      'captureGoogleSearchLocalScreenshot: googleSearchUrl or verifyGoogleSearchUrl required.'
    );
  }

  const url = explicit;
  let startForFn = 0;
  try {
    const u = new URL(url);
    const s = u.searchParams.get('start');
    if (s != null && s !== '') {
      const n = Number(s);
      if (Number.isFinite(n)) startForFn = n;
    }
  } catch { /* keep startForFn = 0 */ }

  const ls = localStartBody != null && localStartBody !== ''
    ? Math.max(0, Math.min(100, Number(localStartBody)))
    : startForFn;
  
  let slotOnPage = rankSlotBody != null && rankSlotBody !== ''
    ? Math.floor(Number(rankSlotBody))
    : r - ls;
  if (!Number.isFinite(slotOnPage) || slotOnPage < 1) slotOnPage = r - ls;
  slotOnPage = Math.max(1, Math.min(20, slotOnPage));

  const { mkdir, writeFile } = await import('fs/promises');
  const sharp = (await import('sharp')).default;
  await mkdir(SCREENSHOTS_DIR, { recursive: true });

  const scrapflyKey = (process.env.SCRAPFLY_API_KEY || '').trim();
  if (!scrapflyKey) {
    throw new Error('SCRAPFLY_API_KEY is required for screenshot capture.');
  }

  console.log(`[GoogleLclCapture] Using Scrapfly Screenshot API`);
  console.log(`[GoogleLclCapture] DataForSEO rank=${r} start=${ls} slot=${slotOnPage}`);
  console.log(`[GoogleLclCapture] URL: ${url.slice(0, 150)}…`);

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
    console.log(`[GoogleLclCapture] Attempt ${attempt + 1}/${scrapflyConfigs.length} with ${cfg.proxy_pool}`);

    // Step 1: Use Scrapfly Screenshot API with minimal params
    const screenshotUrl = new URL('https://api.scrapfly.io/screenshot');
    screenshotUrl.searchParams.set('key', scrapflyKey);
    screenshotUrl.searchParams.set('url', url);
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
        console.warn(`[GoogleLclCapture] Attempt ${attempt + 1} failed: ${lastError.message}`);
        continue;
      }

      screenshotBuffer = Buffer.from(await response.arrayBuffer());
      console.log(`[GoogleLclCapture] Screenshot received: ${screenshotBuffer.length} bytes`);
      
      if (screenshotBuffer.length > 5000) {
        break; // Success
      } else {
        lastError = new Error('Screenshot too small, likely blocked');
        console.warn(`[GoogleLclCapture] Attempt ${attempt + 1}: Screenshot too small`);
      }
    } catch (err) {
      lastError = err;
      console.warn(`[GoogleLclCapture] Attempt ${attempt + 1} error: ${err?.message || err}`);
    }

    // Small delay between retries
    if (attempt < scrapflyConfigs.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  if (!screenshotBuffer || screenshotBuffer.length < 5000) {
    console.error(`[GoogleLclCapture] All Scrapfly attempts failed:`, lastError?.message || 'Unknown');
    throw lastError || new Error('Scrapfly Screenshot API failed after all retries');
  }

  if (!screenshotBuffer || screenshotBuffer.length < 1000) {
    throw new Error('Scrapfly did not return valid screenshot');
  }

  // Step 2: Detect actual slot by finding the business BY NAME via a Scrapfly scrape.
  // DataForSEO and Scrapfly may use different proxies/locations and return different result orders,
  // so we cannot blindly trust DataForSEO's slot number to position the red box.
  const realRank = r;
  let actualSlotOnPage = slotOnPage;
  const bizTitle = String(scrollToTitle || '').trim();

  if (bizTitle) {
    try {
      const scrapeUrl = new URL('https://api.scrapfly.io/scrape');
      scrapeUrl.searchParams.set('key', scrapflyKey);
      scrapeUrl.searchParams.set('url', url);
      scrapeUrl.searchParams.set('render_js', 'true');
      scrapeUrl.searchParams.set('rendering_wait', '4000');
      scrapeUrl.searchParams.set('country', 'us');
      scrapeUrl.searchParams.set('proxy_pool', 'public_residential_pool');
      scrapeUrl.searchParams.set('asp', 'true');

      const scrapeResp = await fetch(scrapeUrl.toString(), { signal: AbortSignal.timeout(65000) });
      if (scrapeResp.ok) {
        const scrapeJson = await scrapeResp.json();
        const html = String(scrapeJson?.result?.content || '');

        // Extract h3 text content in DOM order — Google udm=1 place cards use h3 for business name.
        // Strip inner tags (e.g. <span>) before reading text so "Business Name" inside
        // <h3><span>Business Name</span></h3> is captured correctly.
        const placeHeadings = [];
        const h3Pattern = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
        let m;
        while ((m = h3Pattern.exec(html)) !== null) {
          const text = m[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
          if (text.length >= 2 && !/people also ask|related questions|reviews from the web/i.test(text)) {
            placeHeadings.push(text);
          }
        }

        console.log(`[GoogleLclCapture] Scrape found ${placeHeadings.length} h3 headings for name matching`);

        for (let i = 0; i < placeHeadings.length; i++) {
          if (isMatchedFuzzy(bizTitle, placeHeadings[i], q)) {
            actualSlotOnPage = i + 1;
            console.log(`[GoogleLclCapture] Name match: "${bizTitle}" → "${placeHeadings[i]}" at slot ${actualSlotOnPage} (DataForSEO said ${slotOnPage})`);
            break;
          }
        }

        if (actualSlotOnPage === slotOnPage) {
          console.warn(`[GoogleLclCapture] "${bizTitle}" not found in scrape headings — keeping DataForSEO slot ${slotOnPage}`);
        }
      } else {
        console.warn(`[GoogleLclCapture] Scrape for name-based slot returned ${scrapeResp.status} — keeping DataForSEO slot`);
      }
    } catch (scrapeErr) {
      console.warn(`[GoogleLclCapture] Name-based slot scrape failed: ${scrapeErr?.message} — keeping DataForSEO slot ${slotOnPage}`);
    }
  }

  console.log(`[GoogleLclCapture] Processing overlay for rank #${r} actualSlot=${actualSlotOnPage}${actualSlotOnPage !== slotOnPage ? ` (corrected from DataForSEO slot ${slotOnPage})` : ''}`);

  // Step 4: Add overlay using Sharp
  try {
    const metadata = await sharp(screenshotBuffer).metadata();
    const imgWidth = metadata.width || 1440;
    const imgHeight = metadata.height || 900;
    console.log(`[GoogleLclCapture] Image size: ${imgWidth}x${imgHeight}`);

    // Google Local Finder layout:
    // - Filter bar + separator at top ~230px
    // - Remaining height divided evenly across results on this page (20 per page on udm=1)
    // Card height is derived from the actual screenshot so the overlay
    // tracks the real DOM position regardless of Scrapfly zoom/DPI.
    const firstCardY = 230;
    const pageSize = 20; // udm=1 shows 20 results per page
    const cardHeight = Math.round((imgHeight - firstCardY) / pageSize);
    const markerY = firstCardY + (actualSlotOnPage - 1) * cardHeight;

    console.log(`[GoogleLclCapture] Marker Y position: ${markerY}px`);

    // GMB card box: from separator to separator
    const cardX = 120;   // Left edge of GMB content
    const cardW = 530;   // Width to cover GMB + Website/Directions buttons
    const cardH = 140;   // Height (separator to separator minus padding)
    const badgeSize = 32;
    
    const svgOverlay = `
      <svg width="${imgWidth}" height="${imgHeight}" xmlns="http://www.w3.org/2000/svg">
        <rect x="${cardX}" y="${markerY}" width="${cardW}" height="${cardH}" fill="none" stroke="#e4181f" stroke-width="4"/>
        <rect x="${cardX - badgeSize - 5}" y="${markerY}" width="${badgeSize}" height="${badgeSize}" fill="#e4181f"/>
        <text x="${cardX - badgeSize/2 - 5}" y="${markerY + badgeSize/2 + 2}" font-family="Arial" font-size="16" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">#${realRank}</text>
      </svg>
    `;

    const finalBuffer = await sharp(screenshotBuffer)
      .composite([{ input: Buffer.from(svgOverlay), top: 0, left: 0 }])
      .png()
      .toBuffer();

    // Step 5: Save screenshot
    const fn = `google_udm1_start${startForFn}_r${realRank}_slot${actualSlotOnPage}_${Date.now()}.png`;
    const localPath = path.join(SCREENSHOTS_DIR, fn);
    await writeFile(localPath, finalBuffer);
    console.log(`[GoogleLclCapture] Saved ${fn}`);

    return {
      found: true,
      screenshotPath: `screenshots/${fn}`,
      scannedRank: r,
      scannedSlotOnPage: actualSlotOnPage,
      localSerpStart: ls,
      observedSlotOnPage: actualSlotOnPage,
      observedAbsoluteRank: realRank,
      displayRank: realRank,
      matchType: 'dataforseo',
    };
  } catch (sharpErr) {
    console.error(`[GoogleLclCapture] Sharp error:`, sharpErr?.message || sharpErr);
    throw sharpErr;
  }
}

/**
 * LEGACY: Old cloud browser capture function - kept for reference
 * @deprecated Use captureGoogleSearchLocalScreenshot instead
 */
async function _legacyCloudBrowserCapture_DISABLED({
  keyword,
  rank,
  scrollToTitle,
  googleSearchUrl: googleSearchUrlOpt,
  verifyGoogleSearchUrl: verifyUrlOpt,
  rankSlotOnSerpPage: rankSlotBody,
  localSerpStart: localStartBody,
}) {
  const q = String(keyword || '').trim();
  const r = Math.max(1, Math.min(100, Number(rank) || 1));
  if (!q) throw new Error('_legacyCloudBrowserCapture: keyword required.');
  const start = Math.floor((r - 1) / 20) * 20;
  const gl = /usa|\b(tx|ca|ny|fl|il|oh|pa|ga|nc|mi|nj|va|wa|az|ma|tn|in|mo|md|wi|co|mn|sc|al|la|ky|or|ok|ct|ia|ar|ms|ks|ut|nv|nm|wv|ne|id|hi|nh|me|ri|mt|de|sd|nd|ak|vt|wy|dc)\b/i.test(q)
    ? 'us'
    : 'in';
  const explicit = String(googleSearchUrlOpt || verifyUrlOpt || '').trim();
  const zenrowsOn = !!buildScrapflyBrowserWsUrl();
  const strictUdm1Url =
    zenrowsOn && String(process.env.ZENROWS_STRICT_UDM1_URL || 'true').toLowerCase() !== 'false';

  if (strictUdm1Url && zenrowsOn && (!explicit || !/^https?:\/\//i.test(explicit))) {
    throw new Error(
      'Scrapfly udm=1 capture needs the exact googleSearchUrl from POST /api/ranking/automated-run. ' +
      'Send googleSearchUrl (or verifyGoogleSearchUrl) in the capture-screenshot JSON body so the cloud browser opens the same SERP page as the rank.'
    );
  }

  const url =
    explicit && /^https?:\/\//i.test(explicit)
      ? explicit
      : `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en&gl=${gl}&start=${start}&udm=1&pws=0`;
  const isTbmLclUrl = /[?&]tbm=lcl(?:&|$)/i.test(url);

  let startForFn = start;
  try {
    if (explicit && /^https?:\/\//i.test(explicit)) {
      const u = new URL(explicit);
      const s = u.searchParams.get('start');
      if (s != null && s !== '') {
        const n = Number(s);
        if (Number.isFinite(n)) startForFn = n;
      }
    }
  } catch {
    /* keep startForFn */
  }

  const ls =
    localStartBody != null && localStartBody !== ''
      ? Math.max(0, Math.min(100, Number(localStartBody)))
      : startForFn;
  let slotOnPage =
    rankSlotBody != null && rankSlotBody !== ''
      ? Math.floor(Number(rankSlotBody))
      : r - ls;
  if (!Number.isFinite(slotOnPage) || slotOnPage < 1) slotOnPage = r - ls;
  slotOnPage = Math.max(1, Math.min(20, slotOnPage));

  const { mkdir } = await import('fs/promises');
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
  const playwright = await import('playwright');
  let browser;
  try {
    const captureBudgetMs = parseUdm1CaptureBudgetMs();
    const scrapflyKey = (process.env.SCRAPFLY_API_KEY || '').trim();
    if (!scrapflyKey) {
      throw new Error(
        'SCRAPFLY_API_KEY is required for udm=1 capture. Get it from scrapfly.io dashboard.'
      );
    }

    const fast = udm1ZenrowsFastCaptureEnabled();
    let page;
    let budgetCtx = null;

    const locations = scrapflyLocationConnectionAttempts(q);
    const perAttemptBudgetMs = parseUdm1PerAttemptBudgetMs(captureBudgetMs, locations.length);

    const retryPerLocation = parseUdm1CloudRetryCount();
    const retryBackoffMs = parseUdm1RetryBackoffBaseMs();

    if (isTbmLclUrl) {
      let lastErr;
      for (let ri = 0; ri < locations.length; ri++) {
        const loc = locations[ri];
        if (ri > 0) {
          console.warn(`[GoogleLclCapture] Cloud retry ${ri + 1}/${locations.length} country=${loc}`);
        }
        for (let retry = 0; retry < retryPerLocation; retry++) {
          if (browser) await browser.close().catch(() => { });
          browser = undefined;
          try {
            if (retry > 0) {
              console.warn(
                `[GoogleLclCapture] Retry on same country (${retry + 1}/${retryPerLocation}) country=${loc}`
              );
            }
            const conn = await getCaptureBrowserAndPage(playwright, loc);
            browser = conn.browser;
            page = conn.page;
            console.log(`[GoogleLclCapture] Cloud wss · Local Finder link (${url.length} chars)\n${url}`);
            await gotoUdm1SingleShotZenrows(page, url, { fast });
            await assertZenRowsNoHardFail(page);
            await page
              .waitForSelector('.rllt__details, .VkpGBb, [data-cid], #rcnt, #search', { timeout: 30000 })
              .catch(() => { });
            await new Promise((t) => setTimeout(t, fast ? 900 : 1300));

            const bizTitle = String(scrollToTitle || '').trim();
            const resolvedStrict = await resolveStrictLocalFinderListing(page, bizTitle || q, ls, q);

            // GMB NOT found on this page (strict+fuzzy) → don't save screenshot, don't save data
            if (!resolvedStrict) {
              console.warn(
                `[GoogleLclCapture] GMB NOT FOUND on page (strict+fuzzy) — skipping screenshot save. ` +
                  `Target="${(bizTitle || q).slice(0, 120)}" start=${ls}`
              );
              await browser.close().catch(() => { });
              browser = undefined;
              return {
                found: false,
                screenshotPath: null,
                scannedRank: null,
                localSerpStart: ls,
                displayRank: null,
                message: `"${(bizTitle || q).slice(0, 100)}" not found on Local Finder page (start=${ls}). No screenshot saved.`,
              };
            }

            // GMB FOUND → add red marker with real DOM rank, save screenshot
            const rankForOverlay = resolvedStrict.observedAbsoluteRank;
            if (rankForOverlay !== r) {
              console.log(
                `[GoogleLclCapture] DOM pack rank #${rankForOverlay} overrides DataForSEO rank #${r} for overlay`
              );
            }
            await injectUdm1RankOverlayOnPage(page, resolvedStrict.rect, rankForOverlay).catch(() => { });
            await new Promise((t) => setTimeout(t, 350));

            const fn = `google_udm1_start${startForFn}_r${rankForOverlay}_serp${r}_${Date.now()}.png`;
            const localPath = path.join(SCREENSHOTS_DIR, fn);
            if (await isCaptchaPage(page)) {
              throw new Error('[GoogleLclCapture] CAPTCHA detected before screenshot save (tbm=lcl path).');
            }
            await page.screenshot({ path: localPath, fullPage: false });
            console.log(`[GoogleLclCapture] GMB FOUND → Saved ${fn} (DOM rank #${rankForOverlay})`);
            return {
              found: true,
              screenshotPath: `screenshots/${fn}`,
              scannedRank: r,
              scannedSlotOnPage: resolvedStrict.observedSlotOnPage,
              localSerpStart: ls,
              observedSlotOnPage: resolvedStrict.observedSlotOnPage,
              observedAbsoluteRank: resolvedStrict.observedAbsoluteRank,
              observedOrganicSlotOnPage: resolvedStrict.observedOrganicSlotOnPage,
              observedAbsoluteOrganicRank: resolvedStrict.observedAbsoluteOrganicRank,
              observedMatchIsSponsored: resolvedStrict.observedMatchIsSponsored,
              observedMatchedHeading: resolvedStrict.observedMatchedHeading,
              displayRank: rankForOverlay,
            };
          } catch (e) {
            lastErr = e;
            console.warn(`[GoogleLclCapture] Cloud country ${loc} failed:`, e?.message || e);
            const canRetrySameLoc = retry < retryPerLocation - 1 && isRetryableUdm1CloudError(e);
            if (!canRetrySameLoc) break;
            const waitMs = udm1RetryDelayMs(retry, retryBackoffMs);
            await new Promise((t) => setTimeout(t, waitMs));
          }
        }
      }
      if (lastErr) throw lastErr;
    }

    let lastErr;
    for (let ri = 0; ri < locations.length; ri++) {
      budgetCtx = { deadline: Date.now() + perAttemptBudgetMs };
      const loc = locations[ri];
      if (ri > 0) {
        console.warn(`[GoogleLclCapture] Cloud retry ${ri + 1}/${locations.length} country=${loc}`);
      }
      for (let retry = 0; retry < retryPerLocation; retry++) {
        if (browser) await browser.close().catch(() => { });
        browser = undefined;
        try {
          if (retry > 0) {
            console.warn(
              `[GoogleLclCapture] Retry on same country (${retry + 1}/${retryPerLocation}) country=${loc}`
            );
          }
          const conn = await getCaptureBrowserAndPage(playwright, loc);
          browser = conn.browser;
          page = conn.page;
          if (!conn.zenrows) throw new Error('Expected cloud CDP browser for udm=1 capture');
          console.log(`[GoogleLclCapture] Cloud wss · Serp link (${url.length} chars)\n${url}`);
          const navOk = await withUdm1Budget(
            'gotoUdm1SingleShotZenrows',
            async () => {
              await gotoUdm1SingleShotZenrows(page, url, { fast });
              return true;
            },
            budgetCtx
          );
          if (!navOk) throw new Error('Navigation budget exceeded while opening Google URL');
          await assertZenRowsNoHardFail(page);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          console.warn(`[GoogleLclCapture] Cloud country ${loc} failed:`, e?.message || e);
          const canRetrySameLoc = retry < retryPerLocation - 1 && isRetryableUdm1CloudError(e);
          if (!canRetrySameLoc) break;
          const waitMs = udm1RetryDelayMs(retry, retryBackoffMs);
          await new Promise((t) => setTimeout(t, waitMs));
        }
      }
      if (!lastErr) {
        break;
      }
    }
    if (lastErr) throw lastErr;

    if (await isCaptchaPage(page)) {
      throw new Error(
        'Google Search showed CAPTCHA. Set SCRAPFLY_API_KEY (Cloud Browser), PLAYWRIGHT_PROXY, or CAPTURE_HEADLESS=false locally.'
      );
    }

    await withUdm1Budget('waitForUdm1ListShell#1', () => waitForUdm1ListShell(page, { fast }), budgetCtx);
    await withUdm1Budget('tryClickGooglePlacesTabIfNeeded', () => tryClickGooglePlacesTabIfNeeded(page), budgetCtx);
    await new Promise((t) => setTimeout(t, fast ? 350 : 600));

    const bizTitle = String(scrollToTitle || '').trim();
    await withUdm1Budget(
      'hydrateForStrictGmb',
      () => ensureUdm1PlacesListHydratedForSlot(page, Math.min(20, Math.max(8, slotOnPage))),
      budgetCtx
    ).catch(() => { });

    let resolved =
      (await withUdm1Budget(
        'resolveStrictUdm1PlaceListing',
        () => resolveStrictUdm1PlaceListing(page, bizTitle || q, ls, q),
        budgetCtx
      )) || null;

    if (!resolved) {
      await withUdm1Budget('hydrateForStrictGmb#2', () => ensureUdm1PlacesListHydratedForSlot(page, 20), budgetCtx).catch(
        () => { }
      );
      resolved =
        (await withUdm1Budget(
          'resolveStrictUdm1PlaceListing#2',
          () => resolveStrictUdm1PlaceListing(page, bizTitle || q, ls, q),
          budgetCtx
        )) || null;
    }

    // GMB NOT found on udm=1 page (strict+fuzzy) → don't save screenshot, don't save data
    if (!resolved?.rect) {
      console.warn(
        `[GoogleLclCapture] GMB NOT FOUND on udm=1 page (strict+fuzzy) — skipping screenshot save. ` +
          `Target="${(bizTitle || q).slice(0, 120)}" start=${ls}`
      );
      return {
        found: false,
        screenshotPath: null,
        scannedRank: null,
        localSerpStart: ls,
        displayRank: null,
        message: `"${(bizTitle || q).slice(0, 100)}" not found on udm=1 page (start=${ls}). No screenshot saved.`,
      };
    }

    // GMB FOUND → add red marker with real DOM rank, save screenshot
    const rankForOverlay =
      resolved.observedAbsoluteOrganicRank != null
        ? resolved.observedAbsoluteOrganicRank
        : resolved.observedAbsoluteRank;
    const rankForFilename = rankForOverlay ?? r;

    if (rankForOverlay != null && rankForOverlay !== r) {
      console.log(
        `[GoogleLclCapture] DOM rank #${rankForOverlay} used for overlay (DataForSEO reported #${r})`
      );
    }

    try {
      await injectUdm1RankOverlayOnPage(page, resolved.rect, rankForOverlay ?? r);
      await new Promise((t) => setTimeout(t, fast ? 320 : 450));
      console.log(
        `[GoogleLclCapture] Rank overlay #${rankForOverlay ?? r} on strict match "${resolved.observedMatchedHeading || bizTitle}" (slot ${resolved.observedSlotOnPage})`
      );
    } catch (e) {
      console.warn('[GoogleLclCapture] Rank overlay failed:', e?.message || e);
    }

    const fn = `google_udm1_start${startForFn}_r${rankForFilename}_serp${r}_${Date.now()}.png`;
    const localPath = path.join(SCREENSHOTS_DIR, fn);
    if (await isCaptchaPage(page)) {
      throw new Error('[GoogleLclCapture] CAPTCHA detected before screenshot save (udm=1 path).');
    }
    await page.screenshot({ path: localPath, fullPage: false });
    console.log(`[GoogleLclCapture] GMB FOUND → Saved ${fn} (DOM rank #${rankForOverlay})`);
    return {
      found: true,
      screenshotPath: `screenshots/${fn}`,
      scannedRank: r,
      scannedSlotOnPage: slotOnPage,
      localSerpStart: ls,
      observedSlotOnPage: resolved.observedSlotOnPage,
      observedAbsoluteRank: resolved.observedAbsoluteRank,
      observedOrganicSlotOnPage: resolved.observedOrganicSlotOnPage,
      observedAbsoluteOrganicRank: resolved.observedAbsoluteOrganicRank,
      observedMatchIsSponsored: resolved.observedMatchIsSponsored,
      observedMatchedHeading: resolved.observedMatchedHeading,
      displayRank: rankForOverlay,
    };
  } catch (err) {
    const base = err?.message || String(err);
    let hint = '';
    const wsZen =
      /REQS004|connectOverCDP|WebSocket|wss:\/\/browser\.zenrows/i.test(base);
    if (
      !wsZen &&
      /Executable doesn't exist|browserType\.launch|Could not find browser|npx playwright install/i.test(
        base
      )
    ) {
      hint =
        ' Run: cd google-search-ranking/server && npx playwright install chromium';
    } else if (
      /timeout|Timeout/i.test(base) &&
      !/CAPTURE_GOTO_TIMEOUT_MS/i.test(base)
    ) {
      hint =
        ' Increase CAPTURE_GOTO_TIMEOUT_MS / CAPTURE_PAGE_READY_MS or try another proxy.';
    } else if (/scrapfly|zenrows|CDP|wss:|proxy_pool|country/i.test(base)) {
      hint =
        ' Check SCRAPFLY_API_KEY and plan. Use SCRAPFLY_PROXY_POOL=residential and SCRAPFLY_PROXY_COUNTRY=us';
    }
    throw new Error(base + hint);
  } finally {
    if (browser) await browser.close().catch(() => { });
  }
}

/* ─── GMB automated-run: ZenRows-only `udm=1` pagination (replaces SerpAPI google_local for this path) ─── */

function inferGlUdm1Keyword(keyword) {
  const q = String(keyword || '').toLowerCase();
  return (
    q.includes('usa') ||
    /\b(tx|ca|ny|fl|il|oh|pa|ga|nc|mi|nj|va|wa|az|ma|tn|in|mo|md|wi|co|mn|sc|al|la|ky|or|ok|ct|ia|ar|ms|ks|ut|nv|nm|wv|ne|id|hi|nh|me|ri|mt|de|sd|nd|ak|vt|wy|dc)\b/.test(
      q
    )
  );
}

function encodeUuleLatLngZenrowsScan(lat, lng, timestamp) {
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

function buildUdm1UrlZenrowsRank(keyword, start, opts = {}) {
  const gl = inferGlUdm1Keyword(keyword) ? 'us' : 'in';
  const s = Math.max(0, Math.min(100, Number(start) || 0));
  let url = `https://www.google.com/search?q=${encodeURIComponent(keyword)}&hl=en&gl=${gl}&start=${s}&udm=1&pws=0`;
  const prebuiltUule = typeof opts.uule === 'string' ? opts.uule.trim() : '';
  if (prebuiltUule.startsWith('a+')) {
    url += `&uule=${encodeURIComponent(prebuiltUule)}`;
    return url;
  }
  const geo = opts.gpsCoordinates;
  if (geo?.latitude != null && geo?.longitude != null) {
    const uule = encodeUuleLatLngZenrowsScan(geo.latitude, geo.longitude, opts.uuleTimestamp);
    if (uule) url += `&uule=${encodeURIComponent(uule)}`;
  } else {
    const nearText = (opts.nearText != null ? String(opts.nearText) : '').trim();
    if (nearText) url += `&near=${encodeURIComponent(nearText)}`;
  }
  return url;
}

function latLngFromGoogleMapsHref(href) {
  const s = String(href || '');
  const at = s.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)(?:,|$)/);
  if (at) {
    const lat = Number(at[1]);
    const lng = Number(at[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { latitude: lat, longitude: lng };
  }
  const d3 = s.match(/!3d(-?\d+\.?\d*)/);
  const d4 = s.match(/!4d(-?\d+\.?\d*)/);
  if (d3 && d4) {
    const lat = Number(d3[1]);
    const lng = Number(d4[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { latitude: lat, longitude: lng };
  }
  return null;
}

function enrichZenrowsPlaceRowsWithGps(rows) {
  return rows.map((r) => {
    const g = latLngFromGoogleMapsHref(r.link);
    if (!g) return { ...r };
    return {
      ...r,
      gps_coordinates: { latitude: g.latitude, longitude: g.longitude },
    };
  });
}

function pickBestZenrowsUdm1Page(results, businessName, keyword, location, startOffset) {
  let best = null;
  for (let i = 0; i < results.length; i++) {
    const title = results[i].title;
    if (!isMatchedFuzzy(businessName, title, keyword, location)) continue;
    const score = businessNameMatchScore(businessName, title, keyword, location);
    const rank = startOffset + i + 1;
    if (!best || score > best.score || (score === best.score && rank < best.rank)) {
      best = { index: i, score, rank, title, hit: results[i] };
    }
  }
  return best;
}

/** If URL has udm=1 but the list hasn’t painted (common on ZenRows), click the Places tab once. */
async function tryClickGooglePlacesTabIfNeeded(page) {
  try {
    const sparse = await page
      .evaluate(() => {
        if (!/udm=1/.test(String(location.href || ''))) return false;
        const n =
          document.querySelectorAll('[data-cid]').length +
          document.querySelectorAll('a[href*="/maps/place"]').length;
        return n < 2;
      })
      .catch(() => false);
    if (!sparse) return;
    const tab = page.getByRole('tab', { name: 'Places', exact: true }).first();
    if (await tab.isVisible({ timeout: 6000 }).catch(() => false)) {
      await tab.click({ timeout: 5000 }).catch(() => { });
      await new Promise((r) => setTimeout(r, 2800));
    }
  } catch (_) { }
}

/**
 * ZenRows / streaming SERP: `#rso` is often empty briefly; udm=1 Places may live under
 * `#center_col`, `role=main`, or only as `/maps/place` anchors without `[data-cid]`.
 */
async function waitForUdm1ListShell(page, opts = {}) {
  const fast = !!opts.fast;
  const envN = Number(process.env.ZENROWS_UDM1_SHELL_WAIT_MS);
  let ms;
  if (Number.isFinite(envN)) {
    ms = Math.min(45000, Math.max(3000, envN));
  } else if (fast) {
    ms = 12000;
  } else {
    ms = 22000;
  }
  const pollMs = fast ? 300 : 450;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const ok = await page
      .evaluate(() => {
        const hasBlk = !!(
          document.querySelector('#rso *') ||
          document.querySelector('#center_col *') ||
          document.querySelector('div[role="main"]') ||
          document.querySelector('#search #main')
        );
        if (!hasBlk) return false;
        if (document.querySelector('[data-cid]')) return true;
        if (document.querySelector('a[href*="/maps/place"]')) return true;
        if (document.querySelector('#rso h3, #center_col h3, div[role="main"] h3')) return true;
        return false;
      })
      .catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function extractZenrowsUdm1PlaceRows(page) {
  return page.evaluate(() => {
    const isNoise = (t) =>
      /people also ask|related questions|reviews from the web/i.test(String(t || ''));

    const pickRoot = () =>
      document.querySelector('#rso') ||
      document.querySelector('#center_col') ||
      document.querySelector('div[role="main"]') ||
      document.querySelector('#main') ||
      document.querySelector('#search') ||
      document.body;

    const mapsHref = (el) => {
      if (!el || !el.querySelector) return null;
      const a =
        el.querySelector('a[href*="/maps/place"]') ||
        el.querySelector('a[href*="google.com/maps/place"]') ||
        el.querySelector('a[href*="maps.google.com/maps"]') ||
        el.querySelector('a[href*="/maps?q="]');
      return a ? String(a.href) : null;
    };

    const titleFromMapsAnchor = (a) => {
      let card =
        a.closest('[data-cid]') ||
        a.closest('[data-hveid]') ||
        a.closest('.VkpUv') ||
        a.closest('div[jscontroller]');
      if (!card || card === document.body) card = a.parentElement;
      let h =
        card?.querySelector('h3') ||
        card?.querySelector('h2') ||
        card?.querySelector('[role="heading"][aria-level="3"]') ||
        card?.querySelector('[role="heading"][aria-level="2"]');
      if (h) {
        const t = (h.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length >= 2 && !isNoise(t)) return t;
      }
      const ar = a.getAttribute('aria-label') || '';
      const beforeDot = ar.split(/\s*[·•]\s*/)[0]?.replace(/\s+/g, ' ').trim();
      if (beforeDot && beforeDot.length >= 2 && !isNoise(beforeDot)) return beforeDot;
      const txt = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt && txt.length >= 2 && txt.length < 220 && !isNoise(txt)) return txt;
      return '';
    };

    const root = pickRoot();

    const isSponsoredH3 = (h3) => {
      let el = h3.closest('[data-cid]') || h3.closest('.VkpUv') || h3.parentElement;
      for (let i = 0; i < 6 && el; i++) {
        const text = (el.innerText || '').slice(0, 200).toLowerCase();
        if (/\bsponsored\b|^\s*ad[\s:]|·\s*ad\b|^\s*advertisement\b/i.test(text)) return true;
        if (el.querySelector?.('[aria-label*="Sponsored" i], [data-text-ad="1"]')) return true;
        el = el.parentElement;
      }
      return false;
    };

    const rowFromPlaceCard = (card) => {
      const h = card.querySelector('h3') || card.querySelector('h2');
      if (!h) return null;
      const title = (h.textContent || '').replace(/\s+/g, ' ').trim();
      if (title.length < 2 || isNoise(title)) return null;
      const link = mapsHref(card);
      const isSponsored = isSponsoredH3(h);
      return { title, name: title, link: link || null, isSponsored };
    };

    const byCid = [];
    const seenCid = new Set();
    root.querySelectorAll('[data-cid]').forEach((card) => {
      const cid = card.getAttribute('data-cid');
      if (cid && seenCid.has(cid)) return;
      if (cid) seenCid.add(cid);
      const row = rowFromPlaceCard(card);
      if (row) byCid.push(row);
    });

    if (byCid.length > 0) return byCid;

    const heads = Array.from(root.querySelectorAll('h3, h2')).filter((h) => {
      const t = (h.textContent || '').trim();
      if (t.length < 2 || isNoise(t)) return false;
      return (
        !!h.closest('a[href*="/maps/place"]') ||
        !!h.closest('a[href*="/maps?q="]') ||
        !!h.closest('[data-cid]') ||
        !!h.closest('.VkpUv')
      );
    });
    const fromHeads = heads.map((h) => {
      const card = h.closest('[data-cid]') || h.closest('.VkpUv') || h.parentElement;
      const anchor =
        h.closest('a[href*="/maps/place"]') ||
        h.closest('a[href*="/maps?q="]') ||
        (card &&
          card.querySelector &&
          (card.querySelector('a[href*="/maps/place"]') ||
            card.querySelector('a[href*="/maps?q="]')));
      const title = (h.textContent || '').replace(/\s+/g, ' ').trim();
      return {
        title,
        name: title,
        link: anchor ? String(anchor.href) : null,
        isSponsored: isSponsoredH3(h),
      };
    });
    if (fromHeads.length > 0) return fromHeads;

    const linkScope =
      document.querySelector('#rso') ||
      document.querySelector('#center_col') ||
      document.querySelector('div[role="main"]') ||
      root;
    const fromLinks = [];
    const seenHref = new Set();
    linkScope.querySelectorAll('a[href*="/maps/place"]').forEach((a) => {
      const href = String(a.href || '').split('#')[0];
      if (!href || seenHref.has(href)) return;
      const title = titleFromMapsAnchor(a);
      if (!title) return;
      seenHref.add(href);
      fromLinks.push({ title, name: title, link: href, isSponsored: isSponsoredH3(a) });
    });
    return fromLinks;
  });
}

function logZenrowsUdm1ScanPage(start, rows, label) {
  const winLo = start + 1;
  const winHi = start + rows.length;
  console.log(
    `[ZenrowsGmbRank] ---------- ${label} | start=${start} | absolute #${winLo}-#${winHi} ----------`
  );
  for (let i = 0; i < rows.length; i++) {
    const absRank = start + i + 1;
    const slot = absRank - start;
    const t = String(rows[i].title || '(no title)').replace(/\s+/g, ' ').trim().slice(0, 85);
    console.log(`[ZenrowsGmbRank]   abs #${absRank}\t(slot ${slot}/~20)\t${t}`);
  }
  console.log(`[ZenrowsGmbRank] ---------- end ${label} ----------`);
}

/** Deepest `start=` for udm=1 rank scan (inclusive). Env: `ZENROWS_UDM1_MAX_START` (100–300, default 240 ≈ 13 pages). */
export function zenrowsUdm1MaxStartResolved() {
  return Math.min(300, Math.max(100, Number(process.env.ZENROWS_UDM1_MAX_START) || 240));
}

/**
 * Paginate Google Search Places (`udm=1`) via ZenRows only — same tab/order as screenshot verification.
 * @returns {{ globalBest: object|null, sharedUule: string|null, sessionUuleTs: number }}
 */
export async function findGmbRankViaZenrowsUdm1Paginated({ keyword, businessName, location }) {
  if (!(process.env.SCRAPFLY_API_KEY || '').trim()) {
    throw new Error(
      'SCRAPFLY_API_KEY is required for /api/ranking/automated-run.'
    );
  }

  const q = String(keyword || '').trim();
  const biz = String(businessName || '').trim();
  const loc = String(location || '').trim();
  if (!q || !biz) throw new Error('keyword and businessName required');

  const PAGE_SIZE = 20;
  const MAX_START = zenrowsUdm1MaxStartResolved();
  const sessionUuleTs = Math.floor(Date.now() * 1000);
  let sharedUule = null;
  let globalBest = null;

  const playwright = await import('playwright');
  const locTokens = scrapflyLocationConnectionAttempts(q);
  let lastErr;

  for (let ri = 0; ri < locTokens.length; ri++) {
    let browser;
    try {
      if (ri > 0) {
        console.warn(`[ZenrowsGmbRank] retry ${ri + 1}/${locTokens.length} location=${locTokens[ri]}`);
      }
      const conn = await getCaptureBrowserAndPage(playwright, locTokens[ri]);
      browser = conn.browser;
      const page = conn.page;
      if (!conn.zenrows) {
        await browser.close().catch(() => { });
        throw new Error('ZenRows is required for GMB udm=1 rank scan');
      }

      let start = 0;
      let consecutiveEmpty = 0;
      while (start <= MAX_START) {
        const pageNum = start / PAGE_SIZE + 1;
        const url = buildUdm1UrlZenrowsRank(q, start, { nearText: loc });
        console.log(`[ZenrowsGmbRank] Places tab page ${pageNum} (start=${start})…`);
        await gotoUdm1SingleShotZenrows(page, url);
        await assertZenRowsNoHardFail(page);
        if (await isCaptchaPage(page)) {
          throw new Error(
            'Google showed CAPTCHA during ZenRows udm=1 rank scan. Retry later or adjust ZenRows / query volume.'
          );
        }
        await waitForUdm1ListShell(page);
        await tryClickGooglePlacesTabIfNeeded(page);
        await waitForUdm1ListShell(page);
        await ensureUdm1PlacesListHydratedForSlot(page, 20);
        let rawRows = await extractZenrowsUdm1PlaceRows(page);
        let results = enrichZenrowsPlaceRowsWithGps(rawRows);

        if (!results.length) {
          for (let retry = 0; retry < 3 && !results.length; retry++) {
            await new Promise((r) => setTimeout(r, 2200));
            await page.evaluate(() => window.scrollTo(0, 0)).catch(() => { });
            await ensureUdm1PlacesListHydratedForSlot(page, 20);
            rawRows = await extractZenrowsUdm1PlaceRows(page);
            results = enrichZenrowsPlaceRowsWithGps(rawRows);
          }
        }

        if (!sharedUule && results.length) {
          const pageBestNear = pickBestZenrowsUdm1Page(results, biz, q, loc, start);
          if (pageBestNear) {
            const pin = latLngFromGoogleMapsHref(pageBestNear.hit?.link);
            if (pin) {
              sharedUule = encodeUuleLatLngZenrowsScan(
                pin.latitude,
                pin.longitude,
                sessionUuleTs
              );
              console.log(
                `[ZenrowsGmbRank] Match on near= page at abs #${pageBestNear.rank}; uule from matched row for verify URL (${pin.latitude.toFixed(5)},${pin.longitude.toFixed(5)})`
              );
            } else {
              console.log(
                `[ZenrowsGmbRank] Match on near= page at abs #${pageBestNear.rank}; no maps link coords — verify URL will keep using near=`
              );
            }
            globalBest = {
              ...pageBestNear,
              pageStart: start,
              pageResults: results.map((r) => ({ ...r })),
            };
            console.log(
              `[ZenrowsGmbRank] Stopping deeper pagination — match on near= SERP (no mid-scan uule rewind).`
            );
            break;
          }
        }

        if (!results.length) {
          consecutiveEmpty++;
          console.warn(
            `[ZenrowsGmbRank] No rows at start=${start} (empty streak ${consecutiveEmpty}) — skipping chunk (deep udm=1 often flaky).`
          );
          if (consecutiveEmpty >= 4) {
            console.log(`[ZenrowsGmbRank] Stopping after ${consecutiveEmpty} empty pages in a row.`);
            break;
          }
          start += PAGE_SIZE;
          continue;
        }
        consecutiveEmpty = 0;

        logZenrowsUdm1ScanPage(start, results, `Page ${pageNum}`);
        const pageBest = pickBestZenrowsUdm1Page(results, biz, q, loc, start);
        if (pageBest) {
          globalBest = {
            ...pageBest,
            pageStart: start,
            pageResults: results.map((r) => ({ ...r })),
          };
          console.log(
            `[ZenrowsGmbRank] Match on page ${pageNum} (start=${start}) — stopping deeper pagination.`
          );
          break;
        }

        start += PAGE_SIZE;
      }

      await browser.close().catch(() => { });
      return { globalBest, sharedUule, sessionUuleTs };
    } catch (e) {
      lastErr = e;
      if (browser) await browser.close().catch(() => { });
    }
  }

  throw lastErr || new Error('ZenRows udm=1 rank scan failed');
}

/**
 * ZenRows-only: ordered Places results from Google Search `udm=1` as JSON.
 * Uses `near=` only (no rank-1 uule rewind) so ordering tracks normal manual / share links.
 * CAPTCHA cannot be guaranteed away; ZenRows + default single-page fetch reduces exposure — retries other proxy tokens on CAPTCHA.
 *
 * @param {{ keyword: string, location?: string, maxPages?: number }} opts
 * @returns {Promise<{ ok: boolean, captchaDetected: boolean, keyword: string, location: string, maxPages: number, places: Array<{rank:number,slotOnPage:number,pageStart:number,title:string,mapsLink:string|null,latitude:number|null,longitude:number|null}>, googleSearchUrls: string[], message?: string }>}
 */
export async function fetchGooglePlacesUdm1ListZenrows({ keyword, location = '', maxPages = 1 }) {
  if (!(process.env.SCRAPFLY_API_KEY || '').trim()) {
    throw new Error('SCRAPFLY_API_KEY is required for Places udm=1 JSON (Cloud Browser).');
  }
  const q = String(keyword || '').trim();
  const loc = String(location || '').trim();
  if (!q) throw new Error('keyword is required');

  const pages = Math.max(1, Math.min(6, Math.floor(Number(maxPages)) || 1));
  const PAGE_SIZE = 20;
  const playwright = await import('playwright');
  const locTokens = scrapflyLocationConnectionAttempts(q);

  for (let ri = 0; ri < locTokens.length; ri++) {
    let browser;
    try {
      if (ri > 0) {
        console.warn(`[PlacesUdm1List] retry ${ri + 1}/${locTokens.length} location=${locTokens[ri]}`);
      }
      const conn = await getCaptureBrowserAndPage(playwright, locTokens[ri]);
      browser = conn.browser;
      const page = conn.page;
      if (!conn.zenrows) {
        await browser.close().catch(() => { });
        throw new Error('ZenRows is required for places-udm1-list');
      }

      const googleSearchUrls = [];
      const places = [];
      let hitCaptcha = false;

      let totalOrganicFound = 0;
      for (let p = 0; p < pages; p++) {
        const start = p * PAGE_SIZE;
        const url = buildUdm1UrlZenrowsRank(q, start, { nearText: loc });
        googleSearchUrls.push(url);
        console.log(`[PlacesUdm1List] page ${p + 1}/${pages} start=${start}`);
        await gotoUdm1SingleShotZenrows(page, url);
        await assertZenRowsNoHardFail(page);
        if (await isCaptchaPage(page)) {
          hitCaptcha = true;
          console.warn(`[PlacesUdm1List] CAPTCHA at start=${start} (token=${locTokens[ri]})`);
          break;
        }
        await waitForUdm1ListShell(page);
        await tryClickGooglePlacesTabIfNeeded(page);
        await waitForUdm1ListShell(page);
        await ensureUdm1PlacesListHydratedForSlot(page, 20);
        const rawRows = await extractZenrowsUdm1PlaceRows(page);
        const results = enrichZenrowsPlaceRowsWithGps(rawRows);
        if (!results.length) break;

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.isSponsored) continue;

          totalOrganicFound++;
          const g = r.gps_coordinates;
          places.push({
            rank: totalOrganicFound,
            slotOnPage: i + 1,
            pageStart: start,
            title: String(r.title || r.name || '').replace(/\s+/g, ' ').trim(),
            mapsLink: r.link || null,
            latitude: g?.latitude != null && Number.isFinite(Number(g.latitude)) ? Number(g.latitude) : null,
            longitude: g?.longitude != null && Number.isFinite(Number(g.longitude)) ? Number(g.longitude) : null,
          });
        }

        if (!results.length) break;
      }

      await browser.close().catch(() => { });

      if (hitCaptcha && places.length === 0 && ri < locTokens.length - 1) {
        continue;
      }

      if (hitCaptcha && places.length === 0) {
        return {
          ok: false,
          captchaDetected: true,
          keyword: q,
          location: loc,
          maxPages: pages,
          places: [],
          googleSearchUrls,
          message:
            'Google showed CAPTCHA. Retry later, set ZENROWS_PROXY_REGION=na for US-heavy queries, or use maxPages=1.',
        };
      }

      if (hitCaptcha && places.length > 0) {
        return {
          ok: true,
          captchaDetected: true,
          keyword: q,
          location: loc,
          maxPages: pages,
          places,
          googleSearchUrls,
          message: 'Partial list: CAPTCHA appeared on a later page; earlier pages are included.',
        };
      }

      return {
        ok: true,
        captchaDetected: false,
        keyword: q,
        location: loc,
        maxPages: pages,
        places,
        googleSearchUrls,
      };
    } catch (e) {
      if (browser) await browser.close().catch(() => { });
      if (ri === locTokens.length - 1) throw e;
      console.warn(`[PlacesUdm1List] error token=${locTokens[ri]}:`, e?.message || e);
    }
  }

  throw new Error('Places udm=1 list failed after proxy attempts');
}


function isStrictMatch(searchName, resultTitle) {
  if (!searchName || !resultTitle) return false;
  // Strip special characters and normalize
  const s = searchName.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const r = resultTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

  // 1. Exact match (perfect)
  if (s === r) return true;

  const sWords = s.split(/\s+/).filter(w => w.length > 2);
  const rWords = r.split(/\s+/).filter(w => r.includes(w));

  // 2. High-confidence partial match
  // If search name has multiple words, at least 3 significant words must match
  // OR the majority of words must match.
  if (sWords.length >= 3) {
    return rWords.length >= 3 || rWords.length >= (sWords.length * 0.7);
  }

  // 3. Fallback for short names
  return r.includes(s) || s.includes(r);
}

/** Global capture slots (API + pilot). Concurrency is configurable and bounded. */
let _activeScreenshotCaptures = 0;
const _screenshotCaptureWaiters = [];

function getScreenshotCaptureConcurrencyLimit() {
  const raw = Number(process.env.SCREENSHOT_CAPTURE_CONCURRENCY || 3);
  if (!Number.isFinite(raw)) return 3;
  return Math.max(1, Math.min(20, Math.floor(raw)));
}

function dequeueScreenshotWaiter() {
  if (_screenshotCaptureWaiters.length === 0) return;
  const limit = getScreenshotCaptureConcurrencyLimit();
  if (_activeScreenshotCaptures >= limit) return;
  const next = _screenshotCaptureWaiters.shift();
  if (!next) return;
  _activeScreenshotCaptures += 1;
  next(() => {
    _activeScreenshotCaptures = Math.max(0, _activeScreenshotCaptures - 1);
    dequeueScreenshotWaiter();
  });
}

function acquireScreenshotCaptureSlot() {
  const limit = getScreenshotCaptureConcurrencyLimit();
  if (_activeScreenshotCaptures < limit) {
    _activeScreenshotCaptures += 1;
    return Promise.resolve(() => {
      _activeScreenshotCaptures = Math.max(0, _activeScreenshotCaptures - 1);
      dequeueScreenshotWaiter();
    });
  }
  return new Promise((resolve) => {
    _screenshotCaptureWaiters.push(resolve);
  });
}

export async function runScreenshotCaptureSerial(task) {
  const release = await acquireScreenshotCaptureSlot();
  try {
    return await task();
  } finally {
    release();
  }
}
