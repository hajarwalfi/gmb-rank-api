/**
 * Fathom API service - uses the root config/fathom.js which provides a FathomAPI class.
 * We import it using createRequire because server is ESM but config is CommonJS.
 */

import { createRequire } from 'module';
import axios from 'axios';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);

// Import the root config/fathom.js (from src/services -> ../../ -> project root config/)
const { fathomAPI } = require('../../config/fathom.js');

function makeOperationalError({ message, code, hint, statusCode = 400, details = null }) {
  const err = new Error(message);
  err.code = code;
  err.hint = hint;
  err.statusCode = statusCode;
  err.details = details;
  return err;
}

/**
 * Extract share ID from Fathom share URL
 * @param {string} url - Fathom share URL
 * @returns {string|null} - Share ID or null
 */
function extractShareId(url) {
  if (!url) return null;
  const match = url.match(/\/share\/([^\/\?]+)/);
  return match ? match[1] : null;
}

/**
 * Try to fetch transcript from Fathom public share page
 * @param {string} shareId - Fathom share ID
 * @param {string} fullUrl - Full Fathom share URL
 * @returns {Promise<string|null>} - Transcript text or null
 */
async function fetchTranscriptFromPublicShare(shareId, fullUrl) {
  // First, fetch the HTML to extract build ID and other metadata
  let buildId = null;
  let html = null;

  try {
    console.log('[FathomService] Fetching share page to extract metadata...');
    const htmlResponse = await axios.get(fullUrl, {
      timeout: 30000,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    html = htmlResponse.data;
    console.log(`[FathomService] HTML length: ${html.length}`);

    // Extract Next.js build ID
    const buildIdMatch = html.match(/"buildId"\s*:\s*"([^"]+)"/);
    if (buildIdMatch) {
      buildId = buildIdMatch[1];
      console.log(`[FathomService] Found buildId: ${buildId}`);
    }

    // Try to extract transcript from __NEXT_DATA__ first
    const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      try {
        const jsonData = JSON.parse(nextDataMatch[1]);
        console.log('[FathomService] __NEXT_DATA__ keys:', Object.keys(jsonData));
        if (jsonData.props?.pageProps) {
          console.log('[FathomService] pageProps keys:', Object.keys(jsonData.props.pageProps));
        }
        const transcript = extractTranscriptFromData(jsonData);
        if (transcript) {
          console.log('[FathomService] ✅ Got transcript from __NEXT_DATA__');
          return transcript;
        }
      } catch (e) {
        console.log('[FathomService] Failed to parse __NEXT_DATA__:', e.message);
      }
    }
  } catch (e) {
    console.log('[FathomService] Failed to fetch HTML:', e.message);
  }

  // Try various API endpoints with the build ID
  const apiEndpoints = [
    // Next.js data routes (need buildId)
    buildId && `https://fathom.video/_next/data/${buildId}/share/${shareId}.json`,
    buildId && `https://fathom.video/_next/data/${buildId}/en/share/${shareId}.json`,

    // tRPC patterns (Fathom might use tRPC)
    `https://fathom.video/api/trpc/share.getBySlug?input=${encodeURIComponent(JSON.stringify({ json: { slug: shareId } }))}`,
    `https://fathom.video/api/trpc/share.get?input=${encodeURIComponent(JSON.stringify({ json: { id: shareId } }))}`,
    `https://fathom.video/api/trpc/transcript.get?input=${encodeURIComponent(JSON.stringify({ json: { shareId } }))}`,

    // REST API patterns
    `https://fathom.video/api/share/${shareId}`,
    `https://fathom.video/api/v1/share/${shareId}`,
    `https://fathom.video/api/public/share/${shareId}`,
    `https://fathom.video/api/share/${shareId}/transcript`,

    // oEmbed (some services support this)
    `https://fathom.video/api/oembed?url=${encodeURIComponent(fullUrl)}&format=json`,
  ].filter(Boolean);

  for (const endpoint of apiEndpoints) {
    try {
      console.log(`[FathomService] Trying: ${endpoint}`);
      const response = await axios.get(endpoint, {
        timeout: 15000,
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': fullUrl
        }
      });
      console.log(`[FathomService] Response status: ${response.status}, type: ${typeof response.data}`);

      const transcript = extractTranscriptFromData(response.data);
      if (transcript) {
        console.log('[FathomService] ✅ Got transcript from API endpoint');
        return transcript;
      }
    } catch (e) {
      // Continue to next endpoint
    }
  }

  // Try extracting from HTML if we have it
  if (html) {
    // Look for any script tag containing transcript data
    const scriptMatches = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
    for (const match of scriptMatches) {
      const scriptContent = match[1];

      if (scriptContent.includes('"transcript"') || scriptContent.includes('"segments"')) {
        // Try segments array
        const segmentsMatch = scriptContent.match(/"segments"\s*:\s*(\[[\s\S]*?\])/);
        if (segmentsMatch) {
          try {
            const segments = JSON.parse(segmentsMatch[1]);
            if (Array.isArray(segments) && segments.length > 0) {
              console.log('[FathomService] ✅ Got transcript from HTML segments');
              return formatSegments(segments);
            }
          } catch (e) { }
        }
      }
    }

    // Look for embedded Apollo/GraphQL state
    const apolloMatch = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});/);
    if (apolloMatch) {
      try {
        const apolloData = JSON.parse(apolloMatch[1]);
        const transcript = extractTranscriptFromData(apolloData);
        if (transcript) {
          console.log('[FathomService] ✅ Got transcript from Apollo state');
          return transcript;
        }
      } catch (e) { }
    }
  }

  console.log('[FathomService] ❌ API attempts failed, trying browser automation...');

  // Final attempt: Use Playwright to render the page and extract transcript
  try {
    const browserTranscript = await fetchTranscriptWithBrowser(fullUrl);
    if (browserTranscript) {
      console.log('[FathomService] ✅ Got transcript via browser automation');
      return browserTranscript;
    }
  } catch (e) {
    console.log('[FathomService] Browser automation failed:', e.message);
  }

  console.log('[FathomService] ❌ All public share attempts failed');
  return null;
}

/**
 * Use Playwright browser automation to fetch transcript from public Fathom share page
 * This works because we render the page like a real browser and wait for JavaScript to load
 */
async function fetchTranscriptWithBrowser(url) {
  let browser = null;
  try {
    console.log('[FathomService] Launching browser to fetch transcript...');

    // Try to find Chrome/Edge on the system
    const possiblePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];

    let executablePath = null;
    for (const p of possiblePaths) {
      try {
        const fs = await import('fs');
        if (fs.existsSync(p)) {
          executablePath = p;
          break;
        }
      } catch (e) { }
    }

    if (!executablePath) {
      console.log('[FathomService] No Chrome/Edge found on system');
      return null;
    }

    console.log(`[FathomService] Using browser: ${executablePath}`);

    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    // Set a reasonable viewport
    await page.setViewportSize({ width: 1280, height: 800 });

    console.log(`[FathomService] Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for page to load
    console.log('[FathomService] Waiting for page to load...');
    await page.waitForTimeout(4000);

    // Step 1: Click on TRANSCRIPT tab
    console.log('[FathomService] Clicking TRANSCRIPT tab...');
    try {
      await page.click('text=TRANSCRIPT', { timeout: 5000 });
      console.log('[FathomService] Clicked TRANSCRIPT tab');
    } catch (e) {
      try {
        await page.click('text=Transcript', { timeout: 3000 });
        console.log('[FathomService] Clicked Transcript tab');
      } catch (e2) {
        console.log('[FathomService] Could not find TRANSCRIPT tab');
      }
    }

    await page.waitForTimeout(3000);

    // Step 2: Scroll through the ENTIRE transcript with Infinite Scroll Support
    console.log('[FathomService] Scrolling through full transcript (Infinite Scroll Support)...');

    await page.evaluate(async () => {
      const scrollContainer = (() => {
        const elements = document.querySelectorAll('*');
        for (const el of elements) {
          const style = window.getComputedStyle(el);
          if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            el.scrollHeight > el.clientHeight &&
            el.scrollHeight > 300) {
            return el;
          }
        }
        return document.documentElement; // Final fallback
      })();

      let lastHeight = scrollContainer.scrollHeight;
      let sameHeightCount = 0;

      // Keep scrolling until the scroll height stops increasing for 5 consecutive checks
      while (sameHeightCount < 6) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        // Also trigger "End" key to force lazy loading
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));

        await new Promise(r => setTimeout(r, 2000)); // Wait 2s for lazy loading

        if (scrollContainer.scrollHeight === lastHeight) {
          sameHeightCount++;
        } else {
          lastHeight = scrollContainer.scrollHeight;
          sameHeightCount = 0;
        }
      }

      // Final extra scroll to bottom and then back to top
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      await new Promise(r => setTimeout(r, 500));
      scrollContainer.scrollTop = 0;
    });

    await page.waitForTimeout(2000);

    // Step 3: Click "Copy Transcript" button to copy to clipboard
    console.log('[FathomService] Clicking Copy Transcript button...');
    let transcript = null;

    try {
      // Grant clipboard permissions
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

      // Click Copy Transcript button
      await page.click('text=Copy Transcript', { timeout: 8000 });
      console.log('[FathomService] Clicked Copy Transcript, waiting 5 seconds for clipboard sync...');
      await page.waitForTimeout(5000);

      // Read from clipboard
      transcript = await page.evaluate(async () => {
        try {
          return await navigator.clipboard.readText();
        } catch (e) {
          return null;
        }
      });

      if (transcript && transcript.length > 100) {
        console.log(`[FathomService] ✅ Got FULL transcript from clipboard: ${transcript.length} chars`);
      }
    } catch (e) {
      console.log('[FathomService] Copy Transcript button interaction failed:', e.message);
    }

    // Step 4: Fallback - extract directly from page if clipboard failed
    if (!transcript || transcript.length < 100) {
      console.log('[FathomService] Extracting transcript directly from page...');

      transcript = await page.evaluate(() => {
        // Get all text content from the transcript area
        const allText = document.body.innerText;
        const lines = allText.split('\n');

        // Find where transcript starts (after TRANSCRIPT tab area)
        let transcriptLines = [];
        let inTranscript = false;
        let currentSpeaker = '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // Skip UI elements
          if (trimmed === 'SUMMARY' || trimmed === 'TRANSCRIPT' || trimmed === 'ASK FATHOM' ||
            trimmed === 'Copy Transcript' || trimmed.includes('Search')) {
            if (trimmed === 'TRANSCRIPT') inTranscript = true;
            continue;
          }

          if (inTranscript) {
            // Check if this is a speaker name (Name Name pattern)
            if (/^[A-Z][a-z]+(\s[A-Z][a-z]+)?$/.test(trimmed) && trimmed.length < 30) {
              currentSpeaker = trimmed;
            } else if (trimmed.length > 5 && currentSpeaker) {
              transcriptLines.push(`${currentSpeaker}: ${trimmed}`);
            } else if (trimmed.length > 20) {
              transcriptLines.push(trimmed);
            }
          }
        }

        if (transcriptLines.length > 3) {
          return transcriptLines.join('\n');
        }

        // Fallback: just get all reasonable text
        return lines.filter(l => l.trim().length > 20).join('\n');
      });
    }

    console.log(`[FathomService] Final transcript length: ${transcript?.length || 0} chars`);

    await browser.close();
    browser = null;

    if (transcript && transcript.length > 50) {
      console.log('[FathomService] ✅ Got transcript via browser');
      return transcript;
    }

    console.log('[FathomService] ❌ Could not extract transcript from page');
    return null;
  } catch (error) {
    console.log('[FathomService] Browser error:', error.message);
    if (browser) {
      try { await browser.close(); } catch (e) { }
    }
    return null;
  }
}

/**
 * Extract transcript from various data structures
 */
function extractTranscriptFromData(data) {
  if (!data) return null;

  // Direct transcript string
  if (typeof data.transcript === 'string' && data.transcript.length > 50) {
    return data.transcript;
  }

  // Nested in props (Next.js pattern)
  if (data.props?.pageProps) {
    const pageProps = data.props.pageProps;
    if (pageProps.transcript && typeof pageProps.transcript === 'string') {
      return pageProps.transcript;
    }
    if (pageProps.share?.transcript) return pageProps.share.transcript;
    if (pageProps.recording?.transcript) return pageProps.recording.transcript;
    if (pageProps.call?.transcript) return pageProps.call.transcript;

    // Segments in pageProps
    const segments = pageProps.segments || pageProps.share?.segments || pageProps.recording?.segments;
    if (Array.isArray(segments) && segments.length > 0) {
      return formatSegments(segments);
    }
  }

  // Nested in result (tRPC pattern)
  if (data.result?.data?.json) {
    const json = data.result.data.json;
    if (json.transcript) return json.transcript;
    if (json.segments) return formatSegments(json.segments);
  }

  // Nested in call/recording/share
  if (data.call?.transcript) return data.call.transcript;
  if (data.recording?.transcript) return data.recording.transcript;
  if (data.share?.transcript) return data.share.transcript;

  // Segments array at various levels
  const segmentSources = [
    data.segments,
    data.call?.segments,
    data.recording?.segments,
    data.share?.segments,
    data.data?.segments,
  ];

  for (const segments of segmentSources) {
    if (Array.isArray(segments) && segments.length > 0) {
      return formatSegments(segments);
    }
  }

  // Deep search for transcript in nested objects
  if (typeof data === 'object') {
    const deepSearch = (obj, depth = 0) => {
      if (depth > 5 || !obj) return null;
      if (typeof obj.transcript === 'string' && obj.transcript.length > 50) {
        return obj.transcript;
      }
      if (Array.isArray(obj.segments) && obj.segments.length > 0) {
        return formatSegments(obj.segments);
      }
      if (typeof obj === 'object') {
        for (const key of Object.keys(obj)) {
          if (key === 'transcript' || key === 'segments' || key === 'share' || key === 'recording' || key === 'call') {
            const result = deepSearch(obj[key], depth + 1);
            if (result) return result;
          }
        }
      }
      return null;
    };
    const deepResult = deepSearch(data);
    if (deepResult) return deepResult;
  }

  return null;
}

/**
 * Format segments array into transcript text
 */
function formatSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  return segments.map(s => {
    const speaker = s.speaker?.name || s.speaker?.display_name || s.speaker || s.speakerName || 'Unknown';
    const text = s.text || s.content || s.words || '';
    const timestamp = s.timestamp || s.start || '';
    if (timestamp) {
      return `[${timestamp}] ${speaker}: ${text}`;
    }
    return `${speaker}: ${text}`;
  }).join('\n');
}

/**
 * Fetch transcript text from a Fathom recording URL.
 * For /share/ URLs: Uses browser automation directly (faster, no API search)
 * For /calls/ URLs: Uses Fathom API
 * @param {string} fathomUrl
 * @returns {Promise<string>} Plain text transcript
 */
export async function fetchTranscript(fathomUrl) {
  if (!fathomUrl || typeof fathomUrl !== 'string') {
    throw makeOperationalError({
      message: 'Fathom URL is required',
      code: 'FATHOM_URL_REQUIRED',
      hint: 'Please provide a valid Fathom share or call URL.'
    });
  }

  const shareId = extractShareId(fathomUrl);

  // For /share/ URLs, go directly to browser automation (skip API search)
  if (shareId) {
    console.log('[FathomService] Share URL detected, using browser automation...');
    try {
      const browserTranscript = await fetchTranscriptWithBrowser(fathomUrl);
      if (browserTranscript && browserTranscript.length > 100) {
        return browserTranscript;
      }
    } catch (err) {
      console.log('[FathomService] Browser automation failed:', err.message);
    }

    throw makeOperationalError({
      message: 'Could not fetch transcript from Fathom share URL.',
      code: 'FATHOM_SHARE_FETCH_FAILED',
      hint: 'Please ensure the Fathom link is publicly accessible and try again.',
      details: { fathomUrl }
    });
  }

  // For /calls/ URLs, use the API approach
  try {
    const transcript = await fathomAPI.getTranscriptByUrl(fathomUrl);
    if (transcript) {
      return transcript;
    }
  } catch (err) {
    const message = (err?.message || '').toString();

    if (message.includes('Meeting not found for URL')) {
      throw makeOperationalError({
        message: 'Meeting not found for the provided Fathom URL.',
        code: 'FATHOM_MEETING_NOT_FOUND',
        hint: 'Please ensure the meeting is accessible to the configured API key.',
        details: { fathomUrl }
      });
    }

    if (message.includes('missing recording_id')) {
      throw makeOperationalError({
        message: 'Meeting found, but recording ID is missing.',
        code: 'FATHOM_RECORDING_ID_MISSING',
        hint: 'Please open the Fathom meeting once and retry after it is fully processed.',
        details: { fathomUrl }
      });
    }

    if (message.includes('Transcript not found for recording_id')) {
      throw makeOperationalError({
        message: 'Transcript is not yet available for this meeting.',
        code: 'FATHOM_TRANSCRIPT_NOT_READY',
        hint: 'Wait a few minutes and try again after Fathom finishes transcript generation.',
        details: { fathomUrl }
      });
    }

    throw err;
  }

  throw makeOperationalError({
    message: 'Transcript not found or empty',
    code: 'FATHOM_TRANSCRIPT_EMPTY',
    hint: 'Open the Fathom link and verify the transcript tab has content.'
  });
}