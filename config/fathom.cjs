const axios = require('axios');
const https = require('https');

// Fathom API can take 15-20s to respond — set a generous timeout and force IPv4
const FATHOM_REQUEST_TIMEOUT_MS = 45000;
const fathomAxios = axios.create({
  httpsAgent: new https.Agent({ family: 4 }),
  timeout: FATHOM_REQUEST_TIMEOUT_MS,
});

/** Shared retry wrapper for a single Fathom GET (handles 429/502/503/timeouts). */
async function fathomGetWithRetry(url, apiKey, params = {}, label = 'FathomAPI') {
  let attempt = 0;
  const maxAttempts = 4;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      return await fathomAxios.get(url, {
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        params,
        timeout: FATHOM_REQUEST_TIMEOUT_MS,
      });
    } catch (err) {
      const status = err.response?.status;
      const isRateLimit = status === 429;
      const isServerError = status === 502 || status === 503 || status === 500;
      const isTimeout = err.code === 'ECONNABORTED';
      const canRetry = (isRateLimit || isServerError || isTimeout) && attempt < maxAttempts;
      if (!canRetry) throw err;
      const wait = isRateLimit ? attempt * 3000 : isServerError ? 15000 * attempt : 10000 * attempt;
      console.warn(`[${label}] ${status || err.code || 'timeout'} — retry ${attempt}/${maxAttempts - 1} in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error('Unreachable');
}

/**
 * Fathom API Configuration
 * Reusable functions for interacting with Fathom API.
 *
 * ——— CONFIGS (API keys, webhook secrets, base URL) ———
 * All Fathom configs are in this file, right below this comment:
 *   - FATHOM_API_KEY / BACKUP / _2 / _3 / _4 : X-Api-Key list; primary first, then backups on 401/403/429; findMeetingByUrl tries each account
 *   - FATHOM_WEBHOOK_SECRET / BACKUP / _2 / _3 / _4 : webhook signature verification (try each until one validates)
 *   - baseURL : FathomAPI.baseURL = 'https://api.fathom.ai/external/v1' (in constructor below)
 * To change keys or base URL, edit the "HARD-CODED FATHOM CREDENTIALS" block and the constructor.
 */

// ——— HARD-CODED FATHOM CREDENTIALS (configs live here) ———
const FATHOM_API_KEY = 'yZEBjejqs93ibjBdxKIl1Q.eM8OPv70cu5BPy1NunrVILWBnaFme863rlsRDr0Y0Xw';
const FATHOM_API_KEY_BACKUP = 'zdgdbNyIH49tM1HhRBMXTA.zhlx1FGF-EuzWghoh6Td-r0lcrkm3I6opFDMEpQAH6U';
/** Third Fathom workspace (another account). */
const FATHOM_API_KEY_2 = 'pgnXIEAhSFrwIfBRfBqmvA.kJXXt8y69zYbzEuPzWJUkwom7lHKNdEcfYSFJwpD71Y';
/** Fourth Fathom workspace (new team member — Kurtis). */
const FATHOM_API_KEY_3 = 'zmluYQmBgVH26TOpAobCBg.sPfDNq6sRmy6SzHRobH8Z4Jiiyhgw9jY-zbiO42N4gI';

const FATHOM_WEBHOOK_SECRET = 'whsec_ZDSuTGWi+vWXIOWGHdT9TUghTd3zWAyZ';
const FATHOM_WEBHOOK_SECRET_BACKUP = 'whsec_ihbE357L9pg95SNDCMUus';
const FATHOM_WEBHOOK_SECRET_2 = 'whsec_Z8SvpEZTM7c7JUOHjxtre/oqNdOyhNH4';
const FATHOM_WEBHOOK_SECRET_3 = 'whsec_g8xeLRVCx2ghkia1XnlBFILsTHskCVWg';

/** Fifth Fathom workspace (another account — paste External API key from Fathom, same as _2 / _3). */
const FATHOM_API_KEY_4 = '63IXSYcofTv_VHi021_D1w.wcP7Z-ekwxQixgwcyyyKDnJBBmRaSneX2oqHiiKNzJI';
const FATHOM_WEBHOOK_SECRET_4 = '';

/** Sixth Fathom workspace. */
const FATHOM_API_KEY_5 = 'QN7xYo_iEqZItT8Y5MT_uQ.PWYwbY1EJHWxWhVzl-XT1RhEFk6NkfjcNWiMv2hst8s';
const FATHOM_WEBHOOK_SECRET_5 = 'whsec_bAXnq4n8IsJERdDj4bnQEankLj4vQg6O';

/** Seventh Fathom workspace. */
const FATHOM_API_KEY_6 = 'FJt0Es0GaS3RlhhXL_Lm5g.eorN6lgap4F11rCQ0eDED0wxsZ0LaqPWHxG1I9CmHfU';
const FATHOM_WEBHOOK_SECRET_6 = 'whsec_p9CgyoP27JUXx/S0Y7XJpyDebjDwpSTQ';

/** Eighth Fathom workspace. */
const FATHOM_API_KEY_7 = '7LWw_HFPnNwW4iWoC7R5jg.BMckAWKq3LpOKEvqJsqrt7jKtwprJjQgJXJ0PcPSZhA';
const FATHOM_WEBHOOK_SECRET_7 = 'whsec_uTsKu8tJgTSY1SQUoOQE4LKPnHyfg9/Z';

/** Ninth Fathom workspace (Basecamp onboarding). */
const FATHOM_API_KEY_8 = 'VRpq49pxQQPln6t3khqcFg.YpuOrl3SbL-CLH7kwHWOhopgnwX_QGmqqJXaXStZ9_0';
const FATHOM_WEBHOOK_SECRET_8 = '';

/** Tenth Fathom workspace (Basecamp — new account). */
const FATHOM_API_KEY_9 = 'GCXPZLkNhizuRQJaBu7cWg.FudHCGKeDvjV-dMcElfc4jC-BZ8vuh7BZncSWMopKNQ';
const FATHOM_WEBHOOK_SECRET_9 = 'whsec_nkjBsHDmQst0j26wj1ri2h3K2Swj3MMu';

/** Eleventh Fathom workspace (Ashly — gineth2418@gmail.com). */
const FATHOM_API_KEY_10 = 'gyRI6l10uics6JnKNS40sA.slhrh_AyP9iDQ2rmoxlQogjAjtElNpjpkkDhmfVQdLo';
const FATHOM_WEBHOOK_SECRET_10 = '';

/** Ordered list of API keys: primary first, then backups, then additional workspaces. */
const FATHOM_API_KEYS = [
  FATHOM_API_KEY,
  FATHOM_API_KEY_BACKUP,
  FATHOM_API_KEY_2,
  FATHOM_API_KEY_3,
  FATHOM_API_KEY_4,
  FATHOM_API_KEY_5,
  FATHOM_API_KEY_6,
  FATHOM_API_KEY_7,
  FATHOM_API_KEY_8,
  FATHOM_API_KEY_9,
  FATHOM_API_KEY_10,
].filter(Boolean);

/** URL → { recordingId, apiKey } cache so repeat lookups skip pagination. */
const _urlLookupCache = new Map();
const URL_LOOKUP_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function normalizeFathomUrl(url) {
  return String(url || '').trim().replace(/\/$/, '');
}

function getCachedUrlLookup(url) {
  const key = normalizeFathomUrl(url);
  const hit = _urlLookupCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.cachedAt > URL_LOOKUP_CACHE_TTL_MS) {
    _urlLookupCache.delete(key);
    return null;
  }
  return hit;
}

function cacheUrlLookup(url, recordingId, apiKey) {
  if (!url || !recordingId || !apiKey) return;
  _urlLookupCache.set(normalizeFathomUrl(url), {
    recordingId,
    apiKey,
    cachedAt: Date.now(),
  });
}
/** Ordered list of webhook secrets for signature verification (try each until one validates). */
const FATHOM_WEBHOOK_SECRETS = [
  FATHOM_WEBHOOK_SECRET,
  FATHOM_WEBHOOK_SECRET_BACKUP,
  FATHOM_WEBHOOK_SECRET_2,
  FATHOM_WEBHOOK_SECRET_3,
  FATHOM_WEBHOOK_SECRET_4,
  FATHOM_WEBHOOK_SECRET_5,
  FATHOM_WEBHOOK_SECRET_6,
  FATHOM_WEBHOOK_SECRET_7,
  FATHOM_WEBHOOK_SECRET_8,
  FATHOM_WEBHOOK_SECRET_9,
  FATHOM_WEBHOOK_SECRET_10,
].filter(Boolean);

class FathomAPI {
  constructor() {
    this.baseURL = 'https://api.fathom.ai/external/v1';  // Fathom API base (config)
    this.apiKey = FATHOM_API_KEY;  // default for backwards compatibility
    this.apiKeys = FATHOM_API_KEYS;
  }

  /**
   * Run an API request with fallback: try each API key in order.
   * On 401/403 (auth) or 429 (rate limit), retry with the next key after a short delay.
   * @param {function(string): Promise<any>} requestFn - receives (apiKey), returns promise (e.g. axios call)
   * @returns {Promise<any>}
   */
  async _requestWithFallback(requestFn) {
    const keys = this.apiKeys.length ? this.apiKeys : [this.apiKey];
    let lastError;
    for (let i = 0; i < keys.length; i++) {
      try {
        return await requestFn(keys[i]);
      } catch (err) {
        lastError = err;
        const status = err.response?.status;
        const isAuthError = status === 401 || status === 403;
        const isRateLimit = status === 429;
        const shouldTryNext = (isAuthError || isRateLimit) && i < keys.length - 1;
        if (shouldTryNext) {
          const reason = isRateLimit ? 'Rate limited (429)' : `Auth failed (${status})`;
          console.warn(`[FathomAPI] ${reason} with key #${i + 1}, trying backup key...`);
          if (isRateLimit) {
            await new Promise((r) => setTimeout(r, 1500));
          }
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /**
   * Extract call ID from Fathom URL
   * Example: "https://fathom.video/calls/521359286" -> "521359286"
   * @param {string} url - Fathom call URL
   * @returns {string|null} - Call ID or null if not found
   */
  extractCallId(url) {
    if (!url || typeof url !== 'string') {
      return null;
    }

    // Remove trailing slash and whitespace
    const cleanUrl = url.trim().replace(/\/$/, '');

    // Extract ID from URL pattern: https://fathom.video/calls/{id}
    const match = cleanUrl.match(/\/calls\/(\d+)$/);
    if (match && match[1]) {
      return match[1];
    }

    // Also handle case where URL might just be the ID
    if (/^\d+$/.test(cleanUrl)) {
      return cleanUrl;
    }

    return null;
  }

  /**
   * List all meetings from Fathom API with pagination until November 1st
   * @param {string|Date} targetDate - Target date to paginate until (default: November 1st of current year)
   * @param {string} [singleApiKey] - If set, use only this key for all requests (for multi-account search)
   * @returns {Promise<Array>} - Array of meeting objects
   */
  async listMeetings(targetDate = null, singleApiKey = null) {
    try {
      console.log('[FathomAPI.listMeetings] ===== START =====');
      if (singleApiKey) console.log('[FathomAPI.listMeetings] Using single API key (account) for this run');
      
      // Set target date to November 1st of LAST year if not provided
      // (We want to paginate back to at least Nov 1st of the previous year)
      if (!targetDate) {
        const now = new Date();
        targetDate = new Date(now.getFullYear() - 1, 10, 1); // November 1st of LAST year (month 10 is 0-indexed)
      } else if (typeof targetDate === 'string') {
        targetDate = new Date(targetDate);
      }
      
      const targetTimestamp = targetDate.getTime();
      console.log('[FathomAPI.listMeetings] Target date:', targetDate.toISOString());
      console.log('[FathomAPI.listMeetings] Will paginate until at least November 1st');
      
      const url = `${this.baseURL}/meetings`;
      console.log('[FathomAPI.listMeetings] Base API URL:', url);
      console.log('[FathomAPI.listMeetings] API Key present:', !!this.apiKey);
      
      const allMeetings = [];
      let cursor = null;
      let pageCount = 0;
      let reachedTargetDate = false;
      
      // Use limit=100 to reduce number of API calls (max is 100 per page)
      const limit = 100;
      
      do {
        pageCount++;
        console.log(`[FathomAPI.listMeetings] ===== Fetching page ${pageCount} =====`);
        
        const params = { limit };
        if (cursor) {
          params.cursor = cursor;
          console.log(`[FathomAPI.listMeetings] Using cursor: ${cursor.substring(0, 30)}...`);
        } else {
          console.log('[FathomAPI.listMeetings] First page (no cursor)');
        }
        
        console.log('[FathomAPI.listMeetings] REQUEST GET', url, 'params:', { limit, cursor: cursor ? cursor.substring(0, 30) + '...' : null });
        
        let response;
        if (singleApiKey) {
          // Retry up to 3 times on 429 before giving up
          let attempt = 0;
          while (true) {
            attempt++;
            try {
              response = await fathomAxios.get(url, {
                headers: { 'X-Api-Key': singleApiKey, 'Content-Type': 'application/json' },
                params,
              });
              break;
            } catch (err) {
              if (err.response?.status === 429 && attempt < 3) {
                console.warn(`[FathomAPI.listMeetings] 429 rate limit on page ${pageCount}, attempt ${attempt}. Waiting 3s...`);
                await new Promise(r => setTimeout(r, 3000));
              } else {
                throw err;
              }
            }
          }
        } else {
          response = await this._requestWithFallback((apiKey) =>
            fathomAxios.get(url, {
              headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
              params,
            })
          );
        }

        console.log(`[FathomAPI.listMeetings] ✅ Received response for page ${pageCount}`);
        console.log('[FathomAPI.listMeetings] Response status:', response.status);
        console.log('[FathomAPI.listMeetings] Response data keys:', Object.keys(response.data || {}));
        
        // Extract items and next_cursor from response
        const meetings = response.data?.items || [];
        const nextCursor = response.data?.next_cursor || null;
        
        console.log(`[FathomAPI.listMeetings] Found ${meetings.length} meetings in this page`);
        console.log(`[FathomAPI.listMeetings] next_cursor: ${nextCursor ? nextCursor.substring(0, 30) + '...' : 'null (no more pages)'}`);
        console.log(`[FathomAPI.listMeetings] Response limit: ${response.data?.limit || 'not specified'}`);
        
        // Check if we've reached the target date (Nov 1st)
        if (meetings.length > 0) {
          // Check if any meeting in this page is on or before the target date
          // (meetings are typically sorted newest first, so we check all to be safe)
          let hasMeetingBeforeTarget = false;
          let oldestMeetingDate = null;
          
          for (const meeting of meetings) {
            const meetingDate = meeting.created_at || meeting.createdAt || meeting.date;
            if (meetingDate) {
              const meetingTimestamp = new Date(meetingDate).getTime();
              if (meetingTimestamp <= targetTimestamp) {
                hasMeetingBeforeTarget = true;
                if (!oldestMeetingDate || meetingTimestamp < new Date(oldestMeetingDate).getTime()) {
                  oldestMeetingDate = meetingDate;
                }
              }
            }
          }
          
          if (hasMeetingBeforeTarget) {
            console.log(`[FathomAPI.listMeetings] ✅ Found meeting(s) on or before target date (${targetDate.toISOString()})`);
            console.log(`[FathomAPI.listMeetings] Oldest meeting date in this page: ${oldestMeetingDate}`);
            reachedTargetDate = true;
          } else {
            // Log the date range of this page
            const firstMeetingDate = meetings[0]?.created_at || meetings[0]?.createdAt || meetings[0]?.date;
            const lastMeetingDate = meetings[meetings.length - 1]?.created_at || meetings[meetings.length - 1]?.createdAt || meetings[meetings.length - 1]?.date;
            console.log(`[FathomAPI.listMeetings] Page date range: ${firstMeetingDate} to ${lastMeetingDate}`);
            console.log(`[FathomAPI.listMeetings] Still fetching (haven't reached ${targetDate.toISOString()} yet)...`);
          }
          
          allMeetings.push(...meetings);
          console.log(`[FathomAPI.listMeetings] Total meetings collected so far: ${allMeetings.length}`);
          
          // Removed verbose logging of meeting samples
        }
        
        // Update cursor for next iteration (following Fathom's documented pagination pattern)
        cursor = nextCursor;
        
        // Log cursor status for debugging
        if (cursor) {
          console.log(`[FathomAPI.listMeetings] ✅ next_cursor present: ${cursor.substring(0, 30)}...`);
        } else {
          console.log('[FathomAPI.listMeetings] ⚠️ next_cursor is null/empty - no more pages');
        }
        
        // Stop if we've reached the target date (Nov 1st) OR no more pages (cursor is null)
        if (reachedTargetDate) {
          console.log(`[FathomAPI.listMeetings] ✅ Stopping: reached target date (${targetDate.toISOString()})`);
          console.log(`[FathomAPI.listMeetings] Note: There may be more pages, but we've reached the target date`);
          break;
        }
        
        if (!cursor) {
          console.log('[FathomAPI.listMeetings] ✅ Stopping: no more pages (next_cursor is null)');
          break;
        }
        
        console.log(`[FathomAPI.listMeetings] Continuing pagination with next cursor...`);
        
      } while (cursor);
      
      console.log(`[FathomAPI.listMeetings] ✅ Pagination complete`);
      console.log(`[FathomAPI.listMeetings] Total pages fetched: ${pageCount}`);
      console.log(`[FathomAPI.listMeetings] Total meetings: ${allMeetings.length}`);
      console.log(`[FathomAPI.listMeetings] Reached target date: ${reachedTargetDate}`);
      console.log(`[FathomAPI.listMeetings] Final cursor status: ${cursor ? 'HAD cursor (stopped early due to date)' : 'null (fetched all pages)'}`);
      
      // Verify we actually paginated
      if (pageCount === 1 && allMeetings.length <= 10) {
        console.warn(`[FathomAPI.listMeetings] ⚠️ WARNING: Only fetched 1 page with ${allMeetings.length} meetings. This might indicate pagination didn't work properly.`);
      }
      
      console.log('[FathomAPI.listMeetings] ===== END (SUCCESS) =====');
      return allMeetings;
    } catch (error) {
      console.error('[FathomAPI.listMeetings] ===== ERROR =====');
      console.error('[FathomAPI.listMeetings] Error message:', error.message);
      console.error('[FathomAPI.listMeetings] Error response status:', error.response?.status);
      console.error('[FathomAPI.listMeetings] Error response data:', error.response?.data);
      throw error;
    }
  }

  /**
   * Check if a meeting object matches the given normalized URL.
   */
  _meetingMatchesUrl(meeting, normalizedUrl) {
    const urlA = (meeting.url || '').trim().replace(/\/$/, '');
    const urlB = (meeting.share_url || '').trim().replace(/\/$/, '');
    for (const mu of [urlA, urlB]) {
      if (!mu) continue;
      if (mu === normalizedUrl) return true;
      if (normalizedUrl.includes(mu) || mu.includes(normalizedUrl)) return true;
      const a = normalizedUrl.match(/\/calls\/(\d+)/) || normalizedUrl.match(/\/share\/([^\/]+)/);
      const b = mu.match(/\/calls\/(\d+)/) || mu.match(/\/share\/([^\/]+)/);
      if (a && b && a[1] === b[1]) return true;
    }
    return false;
  }

  /**
   * Find a meeting by URL or share_url. Searches page-by-page across all accounts,
   * returning as soon as a match is found (avoids loading all meetings into memory
   * and minimises API calls / rate-limit exposure).
   * @param {string} url - Fathom URL (e.g., https://fathom.video/calls/488522034 or share URL)
   * @param {{ maxPagesPerAccount?: number }} [opts]
   * @returns {Promise<Object|null>} - Meeting object with recording_id, or null if not found in any account
   */
  async findMeetingByUrl(url, opts = {}) {
    const maxPagesPerAccount = opts.maxPagesPerAccount ?? 60;
    console.log('[FathomAPI.findMeetingByUrl] ===== START =====');
    console.log('[FathomAPI.findMeetingByUrl] Input URL:', url);

    if (!url || typeof url !== 'string') throw new Error('URL is required');

    const normalizedUrl = normalizeFathomUrl(url);
    console.log('[FathomAPI.findMeetingByUrl] Normalized URL:', normalizedUrl);

    const cached = getCachedUrlLookup(normalizedUrl);
    if (cached) {
      console.log(`[FathomAPI.findMeetingByUrl] ✅ Cache hit — recording_id=${cached.recordingId}`);
      return {
        recording_id: cached.recordingId,
        _fathomApiKey: cached.apiKey,
        url: normalizedUrl,
      };
    }

    const keys = this.apiKeys.length ? this.apiKeys : [this.apiKey];

    let allAccountsFailed = true;
    let lastServerError = null;

    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      const apiKey = keys[keyIndex];
      console.log(`[FathomAPI.findMeetingByUrl] Trying account/key #${keyIndex + 1} of ${keys.length} (page-by-page, max ${maxPagesPerAccount} pages)...`);

      let cursor = null;
      let page = 0;
      let accountFailed = false;

      do {
        page++;
        const params = { limit: 100 };
        if (cursor) params.cursor = cursor;

        let response;
        try {
          response = await fathomGetWithRetry(
            `${this.baseURL}/meetings`,
            apiKey,
            params,
            `FathomAPI.findMeetingByUrl account #${keyIndex + 1} page ${page}`,
          );
        } catch (err) {
          const status = err.response?.status;
          const isServerError = status === 502 || status === 503 || status === 500;
          console.warn(`[FathomAPI.findMeetingByUrl] Page ${page} failed for account #${keyIndex + 1}: ${err.message} | code: ${err.code} | status: ${status}`);
          if (isServerError || err.code === 'ECONNABORTED') lastServerError = err;
          accountFailed = true;
          break;
        }

        // Small delay between pages to avoid rate limiting
        if (page > 1) await new Promise(r => setTimeout(r, 1200));

        allAccountsFailed = false;
        const meetings = response.data?.items || [];
        cursor = response.data?.next_cursor || null;

        console.log(`[FathomAPI.findMeetingByUrl] Account #${keyIndex + 1} page ${page}: ${meetings.length} meetings`);

        if (page === 1 && meetings.length > 0) {
          const sample = meetings.slice(0, 3).map(m => ({ url: m.url, share_url: m.share_url, recording_id: m.recording_id }));
          console.log(`[FathomAPI.findMeetingByUrl] Account #${keyIndex + 1} sample url fields:`, JSON.stringify(sample));
        }

        const match = meetings.find(m => this._meetingMatchesUrl(m, normalizedUrl));
        if (match) {
          match._fathomApiKey = apiKey;
          cacheUrlLookup(normalizedUrl, match.recording_id, apiKey);
          console.log(`[FathomAPI.findMeetingByUrl] ✅ Found on account #${keyIndex + 1} page ${page} — recording_id: ${match.recording_id}`);
          console.log('[FathomAPI.findMeetingByUrl] ===== END (SUCCESS) =====');
          return match;
        }

        if (page >= maxPagesPerAccount) {
          console.log(`[FathomAPI.findMeetingByUrl] Reached page limit (${maxPagesPerAccount}) for account #${keyIndex + 1}`);
          break;
        }
      } while (cursor);

      if (!accountFailed) {
        console.log(`[FathomAPI.findMeetingByUrl] Not found in account #${keyIndex + 1}`);
      }
    }

    if (allAccountsFailed && lastServerError) {
      const status = lastServerError.response?.status || 'unknown';
      console.error(`[FathomAPI.findMeetingByUrl] ❌ Fathom API unavailable — all accounts returned server errors (last: ${status})`);
      throw new Error(`Fathom API unavailable (${status}) — could not search for meeting. This is a temporary Fathom outage, not a missing meeting.`);
    }

    console.log('[FathomAPI.findMeetingByUrl] ❌ No matching meeting found in any account');
    console.log('[FathomAPI.findMeetingByUrl] ===== END (NOT FOUND) =====');
    return null;
  }

  /**
   * Get call details from Fathom API
   * @param {string} callId - Fathom call ID
   * @returns {Promise<Object>} - Call details object
   */
  async getCall(callId) {
    try {
      console.log('[FathomAPI.getCall] ===== START =====');
      console.log('[FathomAPI.getCall] Input callId:', callId);
      
      if (!callId) {
        throw new Error('Call ID is required');
      }

      const url = `${this.baseURL}/recordings/${callId}`;
      console.log('[FathomAPI.getCall] Full API URL:', url);
      
      const response = await this._requestWithFallback((apiKey) =>
        fathomAxios.get(url, {
          headers: {
            'X-Api-Key': apiKey,
            'Content-Type': 'application/json'
          }
        })
      );

      return response.data;
    } catch (error) {
      console.error('[FathomAPI.getCall] ===== ERROR =====');
      console.error('[FathomAPI.getCall] Error message:', error.message);
      console.error('[FathomAPI.getCall] Error response status:', error.response?.status);
      console.error('[FathomAPI.getCall] Error response data:', error.response?.data);
      throw error;
    }
  }

  /**
   * Get transcript for a Fathom call
   * @param {string} callId - Fathom call ID
   * @param {string} [preferredApiKey] - If set (e.g. from findMeetingByUrl), use this key only — required when call belongs to a specific workspace
   * @returns {Promise<string>} - Transcript text
   */
  async getCallTranscript(callId, preferredApiKey = null) {
    try {
      if (!callId) {
        throw new Error('Call ID is required');
      }

      const url = `${this.baseURL}/recordings/${callId}/transcript`;
      const response = preferredApiKey
        ? await fathomAxios.get(url, {
            headers: {
              'X-Api-Key': preferredApiKey,
              'Content-Type': 'application/json'
            }
          })
        : await this._requestWithFallback((apiKey) =>
            fathomAxios.get(url, {
              headers: {
                'X-Api-Key': apiKey,
                'Content-Type': 'application/json'
              }
            })
          );

      const transcript = this._parseTranscriptResponse(response.data);

      if (transcript) {
        console.log(`[FathomAPI.getCallTranscript] ✅ Valid transcript found (${transcript.length} chars)`);
        return transcript;
      }

      console.warn(`[FathomAPI.getCallTranscript] ⚠️ Transcript is empty or invalid format`);
      return null;
    } catch (error) {
      console.error('[FathomAPI.getCallTranscript] ===== ERROR =====');
      console.error('[FathomAPI.getCallTranscript] Error message:', error.message);
      console.error('[FathomAPI.getCallTranscript] Error response status:', error.response?.status);
      console.error('[FathomAPI.getCallTranscript] Error response statusText:', error.response?.statusText);
      console.error('[FathomAPI.getCallTranscript] Error response data:', error.response?.data);
      console.error('[FathomAPI.getCallTranscript] Error response headers:', error.response?.headers);
      console.error('[FathomAPI.getCallTranscript] Full error:', error);
      
      if (error.response?.status === 404) {
        console.log(`[FathomAPI.getCallTranscript] 404 - No transcript found for call ${callId}`);
        return null;
      }
      throw error;
    }
  }

  /**
   * Low-memory alternative to findMeetingByUrl: searches page-by-page, only holds
   * one page (~10 meetings) in memory at a time. Returns just the recording_id.
   * @param {string} url - Fathom URL
   * @returns {Promise<string|null>} recording_id or null
   */
  async findRecordingIdByUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const normalizedUrl = url.trim().replace(/\/$/, '');
    const keys = this.apiKeys.length ? this.apiKeys : [this.apiKey];

    for (let ki = 0; ki < keys.length; ki++) {
      const apiKey = keys[ki];
      let cursor = null;
      let page = 0;
      console.log(`[FathomAPI.findRecordingIdByUrl] Searching account #${ki + 1} page-by-page...`);

      do {
        page++;
        const params = { limit: 100 };
        if (cursor) params.cursor = cursor;

        const response = await fathomAxios.get(`${this.baseURL}/meetings`, {
          headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
          params,
        });

        const meetings = response.data?.items || [];
        cursor = response.data?.next_cursor || null;

        const match = meetings.find((m) => {
          const mu = (m.url || m.share_url || '').trim().replace(/\/$/, '');
          if (mu === normalizedUrl) return true;
          if (normalizedUrl.includes(mu) || mu.includes(normalizedUrl)) return true;
          const a = normalizedUrl.match(/\/calls\/(\d+)/) || normalizedUrl.match(/\/share\/([^\/]+)/);
          const b = mu.match(/\/calls\/(\d+)/) || mu.match(/\/share\/([^\/]+)/);
          return a && b && a[1] === b[1];
        });

        if (match) {
          console.log(`[FathomAPI.findRecordingIdByUrl] ✅ Found on page ${page} (account #${ki + 1}) — recording_id: ${match.recording_id}`);
          return match.recording_id;
        }

        console.log(`[FathomAPI.findRecordingIdByUrl] Page ${page}: ${meetings.length} meetings, no match`);
      } while (cursor);

      console.log(`[FathomAPI.findRecordingIdByUrl] Not found in account #${ki + 1}`);
    }

    console.log('[FathomAPI.findRecordingIdByUrl] ❌ Not found in any account');
    return null;
  }

  /**
   * Get transcript from Fathom URL.
   *
   * Lookup order:
   *   1. In-memory URL cache (recording_id + apiKey from a prior lookup)
   *   2. Fast path: GET /recordings/{callId}/transcript with each key (primary first)
   *   3. Shallow scan: paginate up to 15 pages per account to resolve URL → recording_id
   *   4. Deep scan: paginate up to 60 pages per account (fallback for older meetings)
   *
   * @param {string} url - Fathom URL
   * @returns {Promise<string>} - Transcript text
   */
  async getTranscriptByUrl(url) {
    if (!url || typeof url !== 'string') throw new Error('URL is required');

    const normalizedUrl = normalizeFathomUrl(url);
    console.log('[FathomAPI.getTranscriptByUrl] ===== START =====');
    console.log('[FathomAPI.getTranscriptByUrl] Input URL:', url);

    // ── Cache hit ────────────────────────────────────────────────────────────
    const cached = getCachedUrlLookup(normalizedUrl);
    if (cached) {
      console.log(`[FathomAPI.getTranscriptByUrl] Cache hit — recording_id=${cached.recordingId}`);
      const transcript = await this.getCallTranscript(cached.recordingId, cached.apiKey);
      if (transcript) {
        console.log(`[FathomAPI.getTranscriptByUrl] ✅ Cache path success (${transcript.length} chars)`);
        return transcript;
      }
      _urlLookupCache.delete(normalizedUrl);
      console.warn('[FathomAPI.getTranscriptByUrl] Cached recording_id stale — re-resolving');
    }

    // ── Fast path: direct recording ID lookup ──────────────────────────────
    const callId = this.extractCallId(url);
    if (callId) {
      console.log(`[FathomAPI.getTranscriptByUrl] Fast path: extracted callId=${callId}, trying each key (primary first)...`);
      const keys = this.apiKeys.length ? this.apiKeys : [this.apiKey];
      const transcriptUrl = `${this.baseURL}/recordings/${callId}/transcript`;
      let all404 = true;
      let hadServerError = false;

      for (let i = 0; i < keys.length; i++) {
        try {
          const response = await fathomGetWithRetry(
            transcriptUrl,
            keys[i],
            {},
            `FathomAPI.getTranscriptByUrl key #${i + 1}`,
          );
          all404 = false;
          const transcript = this._parseTranscriptResponse(response.data);
          if (transcript) {
            cacheUrlLookup(normalizedUrl, callId, keys[i]);
            console.log(`[FathomAPI.getTranscriptByUrl] ✅ Fast path hit on key #${i + 1} (${transcript.length} chars)`);
            return transcript;
          }
          console.warn(`[FathomAPI.getTranscriptByUrl] Key #${i + 1}: 200 but transcript empty — recording may still be processing`);
          break;
        } catch (err) {
          const status = err.response?.status;
          if (status === 404) {
            // Recording not in this workspace — try next key immediately
            continue;
          }
          all404 = false;
          if (status === 502 || status === 503 || status === 500 || err.code === 'ECONNABORTED') {
            hadServerError = true;
          }
          console.warn(`[FathomAPI.getTranscriptByUrl] Key #${i + 1}: ${status || err.code || err.message}, skipping`);
        }
      }

      if (all404) {
        console.log('[FathomAPI.getTranscriptByUrl] Fast path: call ID not found in any workspace — URL id may differ from recording_id');
      } else if (hadServerError) {
        console.warn('[FathomAPI.getTranscriptByUrl] Fast path: server errors encountered — will try pagination lookup');
      } else {
        console.warn('[FathomAPI.getTranscriptByUrl] Fast path exhausted — falling back to pagination lookup');
      }
    } else {
      console.log('[FathomAPI.getTranscriptByUrl] No numeric call ID in URL — using pagination lookup');
    }

    // ── Pagination lookup ───────────────────────────────────────────────────
    const meeting = await this.findMeetingByUrl(url, { maxPagesPerAccount: 60 });
    if (!meeting) throw new Error(`Meeting not found for URL: ${url}`);
    if (!meeting.recording_id) throw new Error('Meeting found but missing recording_id');

    console.log('[FathomAPI.getTranscriptByUrl] Pagination path: fetching transcript for recording_id:', meeting.recording_id);
    const apiKey = meeting._fathomApiKey || null;
    cacheUrlLookup(normalizedUrl, meeting.recording_id, apiKey || this.apiKey);
    const transcript = await this.getCallTranscript(meeting.recording_id, apiKey);
    if (!transcript) throw new Error(`Transcript not found for recording_id: ${meeting.recording_id}`);

    console.log(`[FathomAPI.getTranscriptByUrl] ✅ Pagination path success (${transcript.length} chars)`);
    return transcript;
  }

  /**
   * Parse a raw Fathom transcript API response into a plain string.
   * Handles both array-of-segments and string formats.
   * @param {any} data
   * @returns {string|null}
   */
  _parseTranscriptResponse(data) {
    if (!data) return null;
    let segments = null;
    if (Array.isArray(data)) {
      segments = data;
    } else if (data.transcript && Array.isArray(data.transcript)) {
      segments = data.transcript;
    } else if (typeof data.transcript === 'string') {
      return data.transcript.trim() || null;
    } else if (typeof data === 'string') {
      return data.trim() || null;
    }
    if (segments) {
      const text = segments.map(item => {
        const speaker = item.speaker?.display_name || 'Unknown';
        const timestamp = item.timestamp || '';
        return `[${timestamp}] ${speaker}: ${item.text || ''}`;
      }).join('\n\n').trim();
      return text || null;
    }
    return null;
  }
}

module.exports = {
  fathomAPI: new FathomAPI(),
  FATHOM_API_KEY,
  FATHOM_API_KEY_BACKUP,
  FATHOM_API_KEY_2,
  FATHOM_API_KEY_3,
  FATHOM_API_KEY_4,
  FATHOM_API_KEY_5,
  FATHOM_API_KEY_6,
  FATHOM_API_KEY_7,
  FATHOM_API_KEY_8,
  FATHOM_API_KEY_9,
  FATHOM_API_KEY_10,
  FATHOM_WEBHOOK_SECRET,
  FATHOM_WEBHOOK_SECRET_BACKUP,
  FATHOM_WEBHOOK_SECRET_2,
  FATHOM_WEBHOOK_SECRET_3,
  FATHOM_WEBHOOK_SECRET_4,
  FATHOM_WEBHOOK_SECRET_5,
  FATHOM_WEBHOOK_SECRET_6,
  FATHOM_WEBHOOK_SECRET_7,
  FATHOM_WEBHOOK_SECRET_8,
  FATHOM_WEBHOOK_SECRET_9,
  FATHOM_WEBHOOK_SECRET_10,
  /** Ordered API keys for multi-account search + fallback. */
  FATHOM_API_KEYS,
  /** Use this for webhook signature verification: try each secret in order until one validates. */
  FATHOM_WEBHOOK_SECRETS,
};

