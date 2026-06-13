
import * as GmbService from '../services/gmb.service.js';
import {
  readKeywordCountCache,
  readKeywordCountSummary,
  rebuildKeywordCountCache,
  filterFlatLocationsByKeywordCache,
} from '../services/gmbKeywordCountCache.service.js';
import * as SupabaseGmbService from '../services/supabaseGmb.service.js';
import { runRebuildAutoConnectedGmbJob } from '../services/autoConnectGmbRebuildCron.service.js';
import {
  readBusinessConnectSnapshotPayload,
  runBusinessConnectRebuildJob,
} from '../services/businessConnectCron.service.js';
import {
  readServicesKeywordsPayload,
  runServicesKeywordsRebuildJob,
  locationsFromServicesKeywords,
  buildKeywordsForLocationIntent,
} from '../services/servicesKeywordsSnapshot.service.js';
import {
  readGmbReviewTrackingPayload,
  runGmbReviewTrackingRebuildJob,
  buildFrequencyLists,
  markReviewReminderDone,
} from '../services/gmbReviewTracking.service.js';
import { getHistory } from '../services/historyManager.js';
import { makeGmbKey, publicScreenshotUrl } from '../services/gmbTrackingHistory.service.js';

function resolveLatestScanFromHistory(history) {
  if (!history) return null;
  if (history.latest_scan) return history.latest_scan;
  const scans = Array.isArray(history.scans) ? history.scans : [];
  if (!scans.length) return null;
  return [...scans].sort(
    (a, b) => new Date(b.scanned_at || 0) - new Date(a.scanned_at || 0)
  )[0];
}

/**
 * Manual-Auto Run is satisfied only when keywords have rank rows AND there is screenshot proof
 * (scan-level or on at least one map_ranks row).
 */
function scanHasRankingCapture(latestScan) {
  if (!latestScan) return false;
  const ranks = Array.isArray(latestScan.map_ranks) ? latestScan.map_ranks : [];
  if (!ranks.length) return false;
  const scanShot = String(latestScan.screenshot_url || '').trim();
  if (scanShot) return true;
  return ranks.some((r) => String(r?.screenshot_url || r?.screenshotUrl || '').trim());
}

function normalizeMapRankRowForClient(row) {
  const raw = row?.screenshot_url || row?.screenshotUrl;
  return {
    keyword: String(row?.keyword || '').trim(),
    rank: typeof row?.rank === 'number' ? row.rank : row?.rank ?? null,
    screenshotUrl: publicScreenshotUrl(raw, null),
  };
}

/** Align query id with services-keywords rows (numeric Google location id only). */
function normalizeLocationIdForServicesKeywords(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^loc:locations\//i, '').replace(/^locations\//i, '').trim();
  if (/^loc:/i.test(s)) s = s.replace(/^loc:/i, '').trim();
  return s;
}

export async function getServicesKeywordsForLocation(req, res) {
  try {
    const accountId = String(req.query?.accountId || '').trim();
    const locationId = String(req.query?.locationId || '').trim();
    const intent = String(req.query?.intent || '').trim();
    if (!accountId || !locationId) {
      return res.status(400).json({ error: 'Missing accountId or locationId' });
    }

    const locShort = normalizeLocationIdForServicesKeywords(locationId);

    if (intent.toLowerCase() === 'manual') {
      const out = await buildKeywordsForLocationIntent(accountId, locShort, 'manual');
      if (!out.ok) {
        return res.status(404).json({ ok: false, error: 'Location not found in services-keywords snapshot.' });
      }
      return res.json({
        ok: true,
        accountId,
        locationIdShort: locShort,
        businessName: out.businessName,
        resolvedCountry: out.resolvedCountry ?? null,
        keywords: out.keywords,
        keywordSource: out.keywordSource,
        intent: 'manual',
        targetCount: out.targetCount ?? null,
      });
    }

    const payload = await readServicesKeywordsPayload();
    const allRows = locationsFromServicesKeywords(payload?.rows || []);
    const match = allRows.find(
      (r) =>
        String(r.accountId || '').trim() === accountId &&
        String(r.locationIdShort || '').trim() === locShort,
    );
    const keywords = Array.isArray(match?.keywords) ? match.keywords : [];
    return res.json({
      ok: true,
      accountId,
      locationIdShort: locShort,
      businessName: String(match?.businessName || match?.title || '').trim() || null,
      resolvedCountry: match?.resolvedCountry || null,
      keywords,
    });
  } catch (err) {
    console.error('[gmb getServicesKeywordsForLocation]', err);
    return res.status(500).json({ error: String(err?.message || err || 'Failed to fetch keywords') });
  }
}

export async function getServicesKeywordsMissingHistory(req, res) {
  try {
    const onlyMissing = String(req.query?.onlyMissing ?? 'true').toLowerCase() !== 'false';
    const payload = await readServicesKeywordsPayload();
    const rows = locationsFromServicesKeywords(payload?.rows || []);
    const out = [];

    for (const r of rows) {
      const accountId = String(r.accountId || '').trim();
      const locationId = String(r.locationIdShort || r.locationId || '').trim();
      const title = String(r.title || r.business_name || '').trim() || 'Untitled';
      if (!accountId || !locationId) continue;

      const businessId = makeGmbKey(locationId, title);
      const history = await getHistory(businessId);
      const scans = Array.isArray(history?.scans) ? history.scans : [];
      const hasHistory = scans.length > 0 || Number(history?.total_scans || 0) > 0;
      if (onlyMissing && hasHistory) continue;

      out.push({
        clientId: String(r.clientId || '').trim() || null,
        accountId,
        locationId,
        title,
        businessId,
        hasHistory,
        totalScans: Number(history?.total_scans || 0),
        keywordsCount: Number(r.keywordsCount || (Array.isArray(r.keywords) ? r.keywords.length : 0)),
        keywords: Array.isArray(r.keywords) ? r.keywords : [],
      });
    }

    const withHistory = rows.length - out.filter((x) => !x.hasHistory).length;
    return res.json({
      ok: true,
      summary: {
        withKeywords: rows.length,
        missingHistory: out.filter((x) => !x.hasHistory).length,
        withHistory,
      },
      items: out,
    });
  } catch (err) {
    console.error('[gmb getServicesKeywordsMissingHistory]', err);
    return res.status(500).json({ error: String(err?.message || err || 'Failed to build missing-history list') });
  }
}

function normTitleForServicesMatch(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function rowMatchesRegion(r, regionQ) {
  if (!regionQ) return true;
  const rr = String(r?.region || '').trim();
  if (!rr) return true;
  return rr === regionQ;
}

/**
 * GET /api/services-keywords/for-client?clientId=&region=&locationId=&businessName=&legalBusinessName=
 * Lookup in services-keywords.json: clientId first, then location id, then fuzzy business/gmb name.
 */
export async function getServicesKeywordsForClient(req, res) {
  try {
    const clientId = String(req.query?.clientId || '').trim();
    const regionQ = String(req.query?.region || '').trim();
    const locationIdQ = String(req.query?.locationId || '').trim();
    const businessNameQ = String(req.query?.businessName || '').trim();
    const legalBusinessNameQ = String(req.query?.legalBusinessName || '').trim();

    if (!clientId && !locationIdQ && !businessNameQ && !legalBusinessNameQ) {
      return res.status(400).json({ ok: false, error: 'missing_lookup' });
    }

    const payload = await readServicesKeywordsPayload();
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];

    const byClientId = () => {
      if (!clientId) return null;
      let m = rows.find(
        (r) => String(r?.clientId || '').trim() === clientId && rowMatchesRegion(r, regionQ),
      );
      if (!m) m = rows.find((r) => String(r?.clientId || '').trim() === clientId);
      return m || null;
    };

    let match = byClientId();

    const locShort = locationIdQ ? normalizeLocationIdForServicesKeywords(locationIdQ) : '';
    if (!match && locShort) {
      const locRows = rows.filter((r) => rowMatchesRegion(r, regionQ));
      match =
        locRows.find((r) => String(r.locationIdShort || r.locationId || '').trim() === locShort) ||
        rows.find((r) => String(r.locationIdShort || r.locationId || '').trim() === locShort) ||
        null;
    }

    const nameParts = [businessNameQ, legalBusinessNameQ].map(normTitleForServicesMatch).filter(Boolean);
    if (!match && nameParts.length) {
      const pool = rows.filter((r) => rowMatchesRegion(r, regionQ));
      const poolLoose = pool.length ? pool : rows;
      match =
        poolLoose.find((r) => {
          const g = normTitleForServicesMatch(r.gmbName || '');
          const b = normTitleForServicesMatch(r.business_name || '');
          return nameParts.some(
            (n) =>
              n &&
              ((g && (g.includes(n) || n.includes(g))) || (b && (b.includes(n) || n.includes(b)))),
          );
        }) || null;
    }

    if (!match) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    const accountId = String(match.accountId || '').trim();
    const locationIdShort = String(match.locationIdShort || match.locationId || '').trim();
    if (!accountId || !locationIdShort) {
      return res.status(404).json({ ok: false, error: 'incomplete_row' });
    }

    const keywords = Array.isArray(match.keywords) ? match.keywords : [];
    const resolvedClientId = String(match.clientId || '').trim() || clientId || null;

    return res.json({
      ok: true,
      clientId: resolvedClientId,
      region: match.region ?? null,
      accountId,
      locationIdShort,
      gmbName: String(match.gmbName || '').trim() || null,
      business_name: String(match.business_name || '').trim() || null,
      keywords,
      keywordsCount: Number(match.keywordsCount || keywords.length || 0),
    });
  } catch (err) {
    console.error('[gmb getServicesKeywordsForClient]', err);
    return res
      .status(500)
      .json({ ok: false, error: err.message || 'Failed to read services-keywords row' });
  }
}

export async function getManualRunEligibility(req, res) {
  try {
    const locationIdRaw = String(req.query?.locationId || '').trim();
    const businessName = String(req.query?.businessName || '').trim();
    if (!locationIdRaw) {
      return res.json({ ok: true, eligible: false, reason: 'missing_location_id' });
    }

    const locationIdShort = normalizeLocationIdForServicesKeywords(locationIdRaw);
    const gmbKey = makeGmbKey(locationIdShort, businessName);
    const history = await getHistory(gmbKey);
    const scans = Array.isArray(history?.scans) ? history.scans : [];
    const hasScanRecord = scans.length > 0 || Number(history?.total_scans || 0) > 0;
    const latestScan = resolveLatestScanFromHistory(history);
    const hasRankingCapture = scanHasRankingCapture(latestScan);
    const mapRanksRaw = Array.isArray(latestScan?.map_ranks) ? latestScan.map_ranks : [];
    const mapRanks = mapRanksRaw.map(normalizeMapRankRowForClient);
    const scanLevelShot = latestScan
      ? publicScreenshotUrl(latestScan.screenshot_url || latestScan.screenshotUrl, null)
      : null;
    const firstRowShot = mapRanks.find((r) => r.screenshotUrl)?.screenshotUrl || null;
    const displayScreenshotUrl = scanLevelShot || firstRowShot || null;

    const payload = await readServicesKeywordsPayload();
    const rows = locationsFromServicesKeywords(payload?.rows || []);
    const row = rows.find((r) => String(r.locationId || r.locationIdShort || '').trim() === locationIdShort);
    const hasKeywords = Number(row?.keywordsCount || (Array.isArray(row?.keywords) ? row.keywords.length : 0)) > 0;

    return res.json({
      ok: true,
      eligible: !hasRankingCapture && hasKeywords,
      /** Any scan row / total_scans in JSON (may still lack ranks + screenshot). */
      hasScanRecord,
      /** True when latest scan has map_ranks entries and a screenshot (scan or row-level). */
      hasRankingCapture,
      /** @deprecated Use hasRankingCapture — kept for older clients; same as hasRankingCapture. */
      hasHistory: hasRankingCapture,
      hasKeywords,
      gmbKey,
      locationIdShort,
      accountId: String(row?.accountId || '').trim() || null,
      title: String(row?.title || row?.businessName || '').trim() || null,
      keywordsCount: Number(row?.keywordsCount || (Array.isArray(row?.keywords) ? row.keywords.length : 0)),
      latestScan: latestScan
        ? {
            scan_id: latestScan.scan_id,
            scanned_at: latestScan.scanned_at,
            screenshotUrl: displayScreenshotUrl,
            mapRanks,
          }
        : null,
    });
  } catch (err) {
    console.error('[gmb getManualRunEligibility]', err);
    return res.status(500).json({ error: String(err?.message || err || 'Failed to check manual-run eligibility') });
  }
}

export async function getLocation(req, res) {
  try {
    const { accountId, locationId } = req.query;
    if (!accountId || !locationId) {
      return res.status(400).json({ error: 'Missing accountId or locationId' });
    }

    if (accountId === 'supabase') {
      const data = await SupabaseGmbService.readActiveGmbJson();
      const client = (data?.active_gmb || []).find(c => c.id === locationId);
      if (client) {
        return res.json({
          title: client.business_name,
          categories: { 
            primaryCategory: { 
              displayName: client.niche || 'Business' 
            } 
          },
          serviceArea: [],
          serviceItems: []
        });
      }
      return res.status(404).json({ error: 'Client not found in Supabase sync' });
    }

    const location = await GmbService.getLocationFull(accountId, locationId);
    return res.json(location);
  } catch (err) {
    console.error('[gmb getLocation]', err);
    return res.status(500).json({ error: err.message });
  }
}

export async function getAccounts(req, res) {
  try {
    const { businesses } = await GmbService.readLocationsSnapshot();
    if (businesses.length) {
      const map = new Map();
      for (const loc of businesses) {
        const accountId = String(loc?.accountId || '').trim();
        if (!accountId || map.has(accountId)) continue;
        map.set(accountId, { name: accountId, accountName: accountId });
      }
      return res.json({ accounts: [...map.values()] });
    }
    if (!GmbService.hasGmbConfig()) {
      return res.status(503).json({ error: 'GMB not configured and JSON snapshot is empty.' });
    }
    const accounts = await GmbService.listAccounts();
    return res.json({ accounts });
  } catch (err) {
    console.error('[BUG: gmb listAccounts failed]', {
      message: err.message,
      code: err.code,
      response: err.response?.data,
      stack: err.stack
    });
    return res.status(500).json({ 
      error: err.message,
      details: err.response?.data || 'No further details'
    });
  }
}

export async function getLocations(req, res) {
  try {
    const { accountId } = req.query;
    if (!accountId) return res.status(400).json({ error: 'Missing accountId' });
    const accountKey = String(accountId).trim();
    const { businesses } = await GmbService.readLocationsSnapshot();
    if (businesses.length) {
      const locations = businesses
        .filter((loc) => String(loc?.accountId || '').trim() === accountKey)
        .map((loc) => ({
          name: String(loc.locationId || ''),
          title: String(loc.title || ''),
          locationId: String(loc.locationId || ''),
          locationIdShort: String(loc.locationIdShort || ''),
        }));
      return res.json({ locations });
    }
    if (!GmbService.hasGmbConfig()) {
      return res.status(503).json({ error: 'GMB not configured' });
    }
    const locations = await GmbService.listLocations(accountKey);
    return res.json({ locations });
  } catch (err) {
    console.error('[gmb listLocations]', err);
    return res.status(500).json({ error: err.message });
  }
}

export function getGmbStatus(req, res) {
  res.json({ configured: GmbService.hasGmbConfig() });
}

/**
 * GET /api/gmb/all-locations
 * Returns a flat list of all locations across all GMB accounts.
 * Used by the GMB Keyword Research dashboard.
 */
export async function getAllLocations(req, res) {
  try {
    const source = String(req.query?.source || '').trim().toLowerCase();
    if (source === 'json') {
      // 1. Try to load active GMBs from Supabase first
      const supabaseData = await SupabaseGmbService.readActiveGmbJson();
      if (supabaseData && Array.isArray(supabaseData.count)) {
        // Filter: Only show businesses that have BOTH GBP access and Niche (access_score === 0)
        // These are now pre-filtered in the 'count' list in active-gmb.json
        let locations = supabaseData.count.map(c => ({
          id: c.id,
          locationId: c.id,
          accountId: 'supabase',
          title: c.business_name,
          business_name: c.business_name,
          niche: c.niche,
          region: c.region,
          gmb_status: c.gmb_status,
          has_gbp_access: c.has_gbp_access,
          access_score: c.access_score,
          keywordsCount: c.keywordsCount,
          keywords: c.keywords,
          source: 'supabase_active'
        }));
        const includeZero = ['1', 'true', 'yes'].includes(
          String(req.query?.includeZeroKeywords || '').trim().toLowerCase()
        );
        if (!includeZero) {
          const kwCache = await readKeywordCountCache();
          locations = filterFlatLocationsByKeywordCache(locations, kwCache, 1);
        }

        return res.json({
          locations,
          count: locations.length,
          active_count: supabaseData.active_count || 0,
          ready_count: supabaseData.ready_count || 0,
          no_access_count: supabaseData.no_access_count || 0,
          total: supabaseData.total || 0,
          source: 'supabase_json',
          generatedAt: supabaseData.generatedAt || null
        });
      }

      // 2. Fallback to legacy GMB connected businesses JSON
      const { parsed, businesses } = await GmbService.readLocationsSnapshot();
      if (!businesses.length && !GmbService.hasGmbConfig()) {
        return res.status(503).json({ error: 'All JSON sources are empty and live GMB API is not configured.' });
      }
      const locations = businesses.length
        ? businesses
        : await GmbService.listAllLocations({ preferJson: false, allowLiveFallback: true });
      return res.json({
        locations,
        count: locations.length,
        source: businesses.length ? 'json' : 'api_fallback',
        generatedAt: parsed?.generatedAt || null,
        meta: parsed?.meta || null,
      });
    }
    if (!GmbService.hasGmbConfig()) {
      return res.status(503).json({ error: 'GMB not configured. Set GMB_CLIENT_ID, GMB_CLIENT_SECRET, GMB_REFRESH_TOKEN in .env' });
    }
    const locations = await GmbService.listAllLocations();
    return res.json({ locations, count: locations.length, source: 'api' });
  } catch (err) {
    console.error('[gmb getAllLocations]', err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/gmb/keyword-count-cache
 * Reads server-side JSON cache with per-location merged keyword counts.
 */
export async function getKeywordCountCache(req, res) {
  try {
    const data = await readKeywordCountCache();
    if (!data) {
      return res.json({ ok: true, updatedAt: null, totalLocations: 0, items: [] });
    }
    return res.json(data);
  } catch (err) {
    console.error('[gmb getKeywordCountCache]', err);
    return res.status(500).json({ error: err.message || 'Failed to read keyword count cache' });
  }
}

/** GET /api/gmb/keyword-counts-summary — counts for dashboard / UI (no heavy items array). */
export async function getKeywordCountsSummary(req, res) {
  try {
    const summary = await readKeywordCountSummary();
    return res.json(summary);
  } catch (err) {
    console.error('[gmb getKeywordCountsSummary]', err);
    return res.status(500).json({ error: err.message || 'Failed to read keyword summary' });
  }
}

/**
 * POST /api/gmb/keyword-count-cache/rebuild
 * Rebuilds **services-keywords.json** (paying CRM + GBP + keywords — legacy route name unchanged).
 */
export async function rebuildKeywordCountCacheNow(req, res) {
  try {
    if (!GmbService.hasGmbConfig()) {
      return res
        .status(503)
        .json({ error: 'GMB not configured. Set GMB_CLIENT_ID, GMB_CLIENT_SECRET, GMB_REFRESH_TOKEN in .env' });
    }
    const result = await rebuildKeywordCountCache({ concurrency: 4 });
    return res.json(result);
  } catch (err) {
    console.error('[gmb rebuildKeywordCountCacheNow]', err);
    return res.status(500).json({ error: err.message || 'Failed to rebuild keyword count cache' });
  }
}

/**
 * GET /api/gmb/monthly-clicks?accountId=...&locationId=...
 * Returns current month GBP clicks (month-to-date) directly from Google.
 */
export async function getMonthlyClicks(req, res) {
  try {
    const { accountId, locationId } = req.query;
    if (!accountId || !locationId) {
      return res.status(400).json({ error: 'Missing accountId or locationId' });
    }
    if (!GmbService.hasGmbConfig()) {
      return res.status(503).json({ error: 'GMB not configured' });
    }
    const includeRawSeries =
      /^(1|true|yes)$/i.test(String(req.query.includeRawSeries || '').trim()) ||
      /^(1|true|yes)$/i.test(String(req.query.verify || '').trim());
    const clicks = await GmbService.getMonthlyClicks(accountId, locationId, { includeRawSeries });
    return res.json({ ok: true, ...clicks });
  } catch (err) {
    console.error('[gmb getMonthlyClicks]', err);
    return res.status(500).json({ error: err.message || 'Failed to fetch current month GBP clicks' });
  }
}

/**
 * GET /api/gmb/active-from-supabase
 * Fetches active GMBs from Supabase, saves to JSON, and returns them.
 */
export async function syncActiveGmbFromSupabase(req, res) {
  try {
    const data = await SupabaseGmbService.syncActiveGmbFromSupabase();
    return res.json({ ok: true, ...data });
  } catch (err) {
    console.error('[gmb syncActiveGmbFromSupabase]', err);
    return res.status(500).json({ error: err.message || 'Failed to sync active GMBs from Supabase' });
  }
}

/**
 * GET /api/gmb/active-json
 * Returns the cached active GMB JSON file.
 */
export async function getActiveGmbJson(req, res) {
  try {
    const data = await SupabaseGmbService.readActiveGmbJson();
    if (!data) {
      return res.status(404).json({ error: 'Active GMB JSON not found. Run sync first.' });
    }
    return res.json(data);
  } catch (err) {
    console.error('[gmb getActiveGmbJson]', err);
    return res.status(500).json({ error: err.message || 'Failed to read active GMB JSON' });
  }
}

/**
 * GET /api/gmbautoconnect (and typo alias) — Client Hub CRM snapshot for GMB auto-connection badges / filters.
 * Body matches `rebuild-auto-connected-gmb.mjs` output (see `readAutoConnectedGmbSnapshotPayload`).
 */
export async function getAutoConnectedGmbPublicSnapshot(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    const payload = await SupabaseGmbService.readAutoConnectedGmbSnapshotPayload();
    if (!payload.ok) {
      return res.status(500).json({ ok: false, error: payload.error || 'read_failed' });
    }
    const { ok, sourcePath, ...body } = payload;
    return res.json({
      ...body,
      ok: true,
      _meta: sourcePath ? { source: 'ranking_server_or_env', path: sourcePath } : { source: 'empty' },
    });
  } catch (err) {
    console.error('[gmb getAutoConnectedGmbPublicSnapshot]', err);
    return res.status(500).json({ ok: false, error: err.message || 'Failed to read auto-connected snapshot' });
  }
}

/**
 * POST /api/gmbautoconnect/rebuild
 * Rebuild auto-connected snapshot on ranking server.
 */
export async function rebuildAutoConnectedGmbSnapshot(req, res) {
  try {
    req.socket?.setTimeout?.(0);
    res.setTimeout?.(0);
    const out = await runRebuildAutoConnectedGmbJob();
    if (!out?.ok) {
      return res.status(500).json({
        ok: false,
        error: out?.error || 'rebuild_failed',
        outputPath: out?.outputPath || null,
      });
    }
    return res.json({
      ok: true,
      outputPath: out.outputPath,
      summary: out.summary || null,
      jsonWritten: !!out.jsonWritten,
    });
  } catch (err) {
    console.error('[gmb rebuildAutoConnectedGmbSnapshot]', err);
    return res.status(500).json({ ok: false, error: err.message || 'rebuild_failed' });
  }
}

/**
 * GET /api/business-connect
 * Paying clients business-connect snapshot (linked vs not connected + reason + reviews).
 */
export async function getBusinessConnectSnapshot(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    const payload = await readBusinessConnectSnapshotPayload();
    if (!payload.ok) {
      return res.status(500).json({ ok: false, error: 'read_failed' });
    }
    const { sourcePath, ...body } = payload;
    return res.json({
      ...body,
      ok: true,
      _meta: sourcePath ? { source: 'ranking_server_or_env', path: sourcePath } : { source: 'empty' },
    });
  } catch (err) {
    console.error('[gmb getBusinessConnectSnapshot]', err);
    return res.status(500).json({ ok: false, error: err.message || 'Failed to read business-connect snapshot' });
  }
}

/**
 * POST /api/business-connect/rebuild
 * Manual trigger to rebuild business-connect JSON immediately.
 */
export async function rebuildBusinessConnectSnapshot(req, res) {
  try {
    req.socket?.setTimeout?.(0);
    res.setTimeout?.(0);
    const out = await runBusinessConnectRebuildJob();
    if (!out?.ok) {
      return res.status(500).json({
        ok: false,
        error: out?.error || 'rebuild_failed',
        outputPath: out?.outputPath || null,
      });
    }
    return res.json({
      ok: true,
      outputPath: out.outputPath,
      summary: out.summary || null,
      jsonWritten: !!out.jsonWritten,
    });
  } catch (err) {
    console.error('[gmb rebuildBusinessConnectSnapshot]', err);
    return res.status(500).json({ ok: false, error: err.message || 'rebuild_failed' });
  }
}

/**
 * GET /api/services-keywords
 * Snapshot: paying active CRM clients with GBP link — services, areas, AI keywords (`server/data/services-keywords.json`).
 * Query: view=locations — flat list for GMB Keyword Research UI (locations with ≥1 keyword only).
 */
export async function getServicesKeywordsSnapshot(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const view = String(req.query.view || '').trim().toLowerCase();
    const payload = await readServicesKeywordsPayload();
    if (view === 'locations') {
      const locations = locationsFromServicesKeywords(payload.rows);
      return res.json({
        ok: true,
        generatedAt: payload.generatedAt,
        region: payload.region,
        summary: payload.summary,
        locations,
        count: locations.length,
        source: 'services_keywords',
      });
    }
    return res.json({
      ok: true,
      generatedAt: payload.generatedAt,
      region: payload.region,
      summary: payload.summary,
      rows: payload.rows || [],
      _meta: payload.sourcePath
        ? { source: 'ranking_server_or_env', path: payload.sourcePath }
        : { source: 'empty' },
    });
  } catch (err) {
    console.error('[gmb getServicesKeywordsSnapshot]', err);
    return res.status(500).json({ ok: false, error: err.message || 'Failed to read services-keywords snapshot' });
  }
}

/** POST /api/services-keywords/rebuild — CRM paying + GBP profile → refresh JSON (+ incremental keywords). */
export async function rebuildServicesKeywordsSnapshot(req, res) {
  try {
    req.socket?.setTimeout?.(0);
    res.setTimeout?.(0);
    const forceRegenerate =
      String(req.body?.forceRegenerate ?? req.query?.forceAll ?? '').toLowerCase() === 'true' ||
      String(req.query?.force ?? '').toLowerCase() === 'true';
    const out = await runServicesKeywordsRebuildJob({ forceKeywords: forceRegenerate });
    if (!out?.ok) {
      return res.status(500).json({
        ok: false,
        error: out?.error || 'rebuild_failed',
        outputPath: out.outputPath || null,
      });
    }
    return res.json({
      ok: true,
      outputPath: out.outputPath,
      summary: out.summary || null,
      jsonWritten: !!out.jsonWritten,
    });
  } catch (err) {
    console.error('[gmb rebuildServicesKeywordsSnapshot]', err);
    return res.status(500).json({ ok: false, error: err.message || 'rebuild_failed' });
  }
}

/**
 * GET /api/gmb-review-tracking
 * Paying linked GMBs — last Google review age (`server/data/gmb-review-tracking.json`).
 */
export async function getGmbReviewTrackingSnapshot(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const payload = await readGmbReviewTrackingPayload();
    const { sourcePath, ...body } = payload;
    return res.json({
      ...body,
      ok: true,
      _meta: sourcePath ? { source: 'ranking_server', path: sourcePath } : { source: 'empty' },
    });
  } catch (err) {
    console.error('[gmb getGmbReviewTrackingSnapshot]', err);
    return res.status(500).json({ ok: false, error: err.message || 'read_failed' });
  }
}

/**
 * GET /api/gmb-review-tracking/frequency-lists?region=es
 * Reminder lists: no review in 2+ weeks / 1+ month (respects mark-done).
 */
export async function getGmbReviewFrequencyLists(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const region = String(req.query.region || '').trim().toLowerCase();
    const payload = await readGmbReviewTrackingPayload();
    const lists = buildFrequencyLists(payload, region);
    return res.json({ ok: true, ...lists });
  } catch (err) {
    console.error('[gmb getGmbReviewFrequencyLists]', err);
    return res.status(500).json({ ok: false, error: err.message || 'lists_failed' });
  }
}

/**
 * POST /api/gmb-review-tracking/mark-done
 * Body: { clientId, bucket: "twoWeeks" | "oneMonth" }
 */
export async function postGmbReviewTrackingMarkDone(req, res) {
  try {
    const clientId = req.body?.clientId;
    const bucket = req.body?.bucket;
    const out = await markReviewReminderDone(clientId, bucket);
    return res.json(out);
  } catch (err) {
    console.error('[gmb postGmbReviewTrackingMarkDone]', err);
    return res.status(400).json({ ok: false, error: err.message || 'mark_done_failed' });
  }
}

/**
 * POST /api/gmb-review-tracking/rebuild
 */
export async function rebuildGmbReviewTrackingSnapshot(req, res) {
  try {
    req.socket?.setTimeout?.(0);
    res.setTimeout?.(0);
    const out = await runGmbReviewTrackingRebuildJob();
    if (!out?.ok) {
      return res.status(500).json({
        ok: false,
        error: out?.error || 'rebuild_failed',
        outputPath: out?.outputPath || null,
      });
    }
    return res.json({
      ok: true,
      outputPath: out.outputPath,
      summary: out.summary || null,
    });
  } catch (err) {
    console.error('[gmb rebuildGmbReviewTrackingSnapshot]', err);
    return res.status(500).json({ ok: false, error: err.message || 'rebuild_failed' });
  }
}

