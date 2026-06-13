import { Router } from 'express';
import { getHistory, getAllBusinessIds } from '../services/historyManager.js';
import { calculateDelta } from '../services/deltaCalculator.js';
import { readTracking } from '../services/gmbTrackingHistory.service.js';
import { buildMapsRankingInventory } from '../services/historyInventory.service.js';
import {
  batchCrmClientRankSignals,
  batchPayingKeywordRankPercentages,
  buildCrmSignalsFromServicesKeywords,
  buildCombinedModalKeywordRows,
  payingKeywordsRatioSummaryForClientIds,
  payingKeywordsRatioSummaryForRegion,
} from '../services/crmHistorySignals.service.js';

const CRM_SIGNALS_CACHE_TTL_MS = Math.max(
  15_000,
  Number(process.env.CRM_SIGNALS_CACHE_TTL_MS || 300_000),
);

const PAYING_RATIO_CACHE_TTL_MS = Math.max(
  15_000,
  Number(process.env.PAYING_KEYWORDS_RATIO_CACHE_TTL_MS || CRM_SIGNALS_CACHE_TTL_MS),
);

const HISTORY_ALL_SERVER_TTL_MS = Math.max(
  15_000,
  Number(process.env.HISTORY_ALL_CACHE_TTL_MS || 300_000),
);

/** Per-region in-memory cache (avoids Cloudflare 524 / browser timeout on Paying rank filters). */
const crmSignalsCacheByRegion = new Map();
const crmSignalsInFlightByRegion = new Map();

const payingRatioCacheByRegion = new Map();
const payingRatioInFlightByRegion = new Map();

/** In-memory response cache for heavy GET /api/history/all (reduces duplicate work + Cloudflare 524). */
let historyAllServerCacheAt = 0;
let historyAllServerPayload = null;
let historyAllServerInFlight = null;

const router = Router();

async function cachedJsonByRegion({
  region,
  bypass,
  cacheByRegion,
  inFlightByRegion,
  ttlMs,
  build,
}) {
  const cacheKey = region || '__all__';
  if (!bypass) {
    const hit = cacheByRegion.get(cacheKey);
    if (hit && Date.now() - hit.at < ttlMs) {
      return { payload: hit.payload, cached: true };
    }
    const inflight = inFlightByRegion.get(cacheKey);
    if (inflight) {
      const payload = await inflight;
      return { payload, cached: true };
    }
  }

  const run = async () => {
    const payload = await build(region);
    cacheByRegion.set(cacheKey, { at: Date.now(), payload });
    return payload;
  };

  let promise = inFlightByRegion.get(cacheKey);
  if (!promise || bypass) {
    promise = run().finally(() => {
      if (inFlightByRegion.get(cacheKey) === promise) {
        inFlightByRegion.delete(cacheKey);
      }
    });
    if (!bypass) inFlightByRegion.set(cacheKey, promise);
  }

  const payload = await promise;
  return { payload, cached: !bypass && cacheByRegion.has(cacheKey) };
}

/**
 * GET /api/history/crm-signals-from-snapshot?region=es
 * Rank / improved / not-ranked flags from `data/services-keywords.json` + history (aligned with nightly snapshot clientIds).
 * Cached in memory per region; `?refresh=1` bypasses cache.
 */
router.get('/crm-signals-from-snapshot', async (req, res) => {
  try {
    const region = String(req.query.region || '').trim().toLowerCase();
    const cacheKey = region || '__all__';
    const bypass = /^(1|true|yes)$/i.test(String(req.query.refresh ?? req.query.nocache ?? ''));

    if (!bypass) {
      const hit = crmSignalsCacheByRegion.get(cacheKey);
      if (hit && Date.now() - hit.at < CRM_SIGNALS_CACHE_TTL_MS) {
        return res.json({ ok: true, ...hit.payload, cached: true });
      }
      const inflight = crmSignalsInFlightByRegion.get(cacheKey);
      if (inflight) {
        const payload = await inflight;
        return res.json({ ok: true, ...payload, cached: true });
      }
    }

    const build = async () => {
      const out = await buildCrmSignalsFromServicesKeywords(region, { bypassCache: bypass });
      const { ok: _ok, ...payload } = out;
      crmSignalsCacheByRegion.set(cacheKey, { at: Date.now(), payload });
      return payload;
    };

    let promise = crmSignalsInFlightByRegion.get(cacheKey);
    if (!promise || bypass) {
      promise = build().finally(() => {
        if (crmSignalsInFlightByRegion.get(cacheKey) === promise) {
          crmSignalsInFlightByRegion.delete(cacheKey);
        }
      });
      if (!bypass) crmSignalsInFlightByRegion.set(cacheKey, promise);
    }

    const payload = await promise;
    return res.json({ ok: true, ...payload, cached: !bypass && crmSignalsCacheByRegion.has(cacheKey) });
  } catch (err) {
    console.error('[History Route] crm-signals-from-snapshot:', err);
    return res.status(500).json({ ok: false, error: 'Failed to build CRM signals from snapshot.' });
  }
});

/**
 * GET /api/history/modal-keyword-rows?clientId=&region=es
 * All snapshot keywords + scan keywords; latest vs previous scan columns (— when missing / single scan).
 */
router.get('/modal-keyword-rows', async (req, res) => {
  try {
    const clientId = String(req.query.clientId || '').trim();
    const region = String(req.query.region || '').trim().toLowerCase();
    if (!clientId) {
      return res.status(400).json({ ok: false, error: 'clientId query required' });
    }
    const data = await buildCombinedModalKeywordRows(clientId, region);
    return res.json({ ok: true, ...data });
  } catch (err) {
    console.error('[History Route] modal-keyword-rows:', err);
    return res.status(500).json({ ok: false, error: 'Failed to build modal keyword rows.' });
  }
});

/**
 * GET /api/history/paying-keywords-ratio-summary?region=es
 * % of paying snapshot rows (≥1 keyword) with ≥1 combined keyword having valid pack rank + screenshot (latest or previous scan).
 * Cached per region; `?refresh=1` bypasses cache.
 */
router.get('/paying-keywords-ratio-summary', async (req, res) => {
  try {
    const region = String(req.query.region || '').trim().toLowerCase();
    const bypass = /^(1|true|yes)$/i.test(String(req.query.refresh ?? req.query.nocache ?? ''));
    const { payload, cached } = await cachedJsonByRegion({
      region,
      bypass,
      cacheByRegion: payingRatioCacheByRegion,
      inFlightByRegion: payingRatioInFlightByRegion,
      ttlMs: PAYING_RATIO_CACHE_TTL_MS,
      build: payingKeywordsRatioSummaryForRegion,
    });
    return res.json({ ...payload, cached });
  } catch (err) {
    console.error('[History Route] paying-keywords-ratio-summary:', err);
    return res.status(500).json({ ok: false, error: 'Failed to build paying keywords ratio summary.' });
  }
});

/**
 * POST /api/history/paying-keywords-ratio-summary-for-clients
 * Body: { region, clientIds } — same ratio as GET summary, limited to paying snapshot rows in those IDs (e.g. one CRM page).
 */
router.post('/paying-keywords-ratio-summary-for-clients', async (req, res) => {
  try {
    const region = String(req.body?.region || '').trim().toLowerCase();
    const clientIds = Array.isArray(req.body?.clientIds) ? req.body.clientIds : [];
    if (!region) {
      return res.status(400).json({ ok: false, error: 'region is required in JSON body.' });
    }
    const out = await payingKeywordsRatioSummaryForClientIds(region, clientIds);
    return res.json(out);
  } catch (err) {
    console.error('[History Route] paying-keywords-ratio-summary-for-clients:', err);
    return res.status(500).json({ ok: false, error: 'Failed to build page-scoped paying keywords ratio summary.' });
  }
});

/**
 * POST /api/history/paying-keyword-rank-percentages-batch
 * Body: { region: "es", clientIds: string[] } — max 600 ids. Per row: rank % = ranked+screenshot keywords / combined union count.
 */
router.post('/paying-keyword-rank-percentages-batch', async (req, res) => {
  try {
    const region = String(req.body?.region || '').trim().toLowerCase();
    const clientIds = Array.isArray(req.body?.clientIds) ? req.body.clientIds : [];
    if (!region) {
      return res.status(400).json({ ok: false, error: 'region is required in JSON body.' });
    }
    const out = await batchPayingKeywordRankPercentages(region, clientIds);
    return res.json(out);
  } catch (err) {
    console.error('[History Route] paying-keyword-rank-percentages-batch:', err);
    return res.status(500).json({ ok: false, error: 'Failed to build per-client rank percentages.' });
  }
});

/**
 * POST /api/history/crm-batch-signals
 * Body: { clients: [{ clientId, locationId?, businessName?, gmbListingName? }] }
 * Used by Client Hub CRM to filter Paying rows by maps rank / improvement (matches inventory logic).
 */
router.post('/crm-batch-signals', async (req, res) => {
  try {
    const clients = req.body?.clients;
    if (!Array.isArray(clients)) {
      return res.status(400).json({ ok: false, error: 'Expected JSON body { clients: [...] }' });
    }
    if (clients.length > 600) {
      return res.status(400).json({ ok: false, error: 'Max 600 clients per request' });
    }
    const out = await batchCrmClientRankSignals(clients);
    return res.json(out);
  } catch (err) {
    console.error('[History Route] crm-batch-signals:', err);
    return res.status(500).json({ ok: false, error: 'Failed to build CRM rank signals.' });
  }
});

/**
 * GET /api/history/maps-ranking-inventory?filter=all|ranked|not_ranked|improved
 * Latest-scan keyword rows across all history files (not only businesses with “changes”).
 * Must stay above /:businessId.
 */
router.get('/maps-ranking-inventory', async (req, res) => {
  try {
    const filter = String(req.query.filter || 'all').trim();
    const out = await buildMapsRankingInventory(filter);
    return res.json({ ok: true, ...out });
  } catch (err) {
    console.error('[History Route] maps-ranking-inventory:', err);
    return res.status(500).json({ error: 'Failed to build maps ranking inventory.' });
  }
});

async function buildHistoryAllSummariesPayload() {
  const ids = await getAllBusinessIds();
  const summaries = [];

  for (const id of ids) {
    const history = await getHistory(id);
    if (history && history.scans && history.scans.length > 0) {
      const scansDesc = [...history.scans].sort(
        (a, b) => new Date(b?.scanned_at || 0) - new Date(a?.scanned_at || 0),
      );
      const enrichedScans = calculateDelta(scansDesc).reverse();

      const latestScan = enrichedScans[0];
      const previousScan = enrichedScans[1] || null;

      try {
        const tracking = await readTracking(id);
        const snaps = Array.isArray(tracking?.snapshots) ? tracking.snapshots : [];

        const mergeItems = (scan, snap) => {
          if (!scan || !snap) return;
          const items = Array.isArray(snap?.items) ? snap.items : [];
          const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
          const byKw = new Map(items.map((it) => [norm(it.keyword), it]));

          if (Array.isArray(scan.map_ranks)) {
            scan.map_ranks = scan.map_ranks.map((mr) => {
              const t = byKw.get(norm(mr.keyword));
              if (!t) return mr;
              return {
                ...mr,
                source_month: t.source_month || mr.source_month,
                volume: mr.volume || t.volume || 0,
                daily_traffic: mr.daily_traffic || t.daily_traffic || 0,
                estimated_clicks: mr.estimated_clicks || t.estimated_clicks || 0,
                raw_traffic_data: t.raw_traffic_data ?? mr.raw_traffic_data ?? null,
              };
            });
          }
        };

        const latestSnap = snaps.length ? snaps[snaps.length - 1] : null;
        const prevSnap = snaps.length > 1 ? snaps[snaps.length - 2] : null;

        mergeItems(latestScan, latestSnap);
        mergeItems(previousScan, prevSnap);
      } catch {
        /* non-fatal */
      }

      const recentScanDates = enrichedScans
        .map((s) => s?.scanned_at)
        .filter(Boolean)
        .slice(0, 2);

      summaries.push({
        business_id: history.business_id,
        business_name: history.business_name,
        location: history.location,
        total_scans: enrichedScans.length,
        first_scan_date: enrichedScans[enrichedScans.length - 1]?.scanned_at,
        previous_scan_date: enrichedScans[1]?.scanned_at || null,
        recent_scan_dates: recentScanDates,
        latest_scan: latestScan,
        previous_scan: previousScan,
      });
    }
  }

  return { ok: true, businesses: summaries };
}

// GET /api/history/all — cached in memory; `?refresh=1` bypasses cache.
router.get('/all', async (req, res) => {
  try {
    const bypass = /^(1|true|yes)$/i.test(String(req.query.refresh ?? req.query.nocache ?? ''));

    if (bypass) {
      const payload = await buildHistoryAllSummariesPayload();
      historyAllServerPayload = payload;
      historyAllServerCacheAt = Date.now();
      return res.json({ ...payload, cached: false });
    }

    const now = Date.now();
    if (historyAllServerPayload && now - historyAllServerCacheAt < HISTORY_ALL_SERVER_TTL_MS) {
      return res.json({ ...historyAllServerPayload, cached: true });
    }

    if (historyAllServerInFlight) {
      const payload = await historyAllServerInFlight;
      return res.json({ ...payload, cached: true });
    }

    historyAllServerInFlight = buildHistoryAllSummariesPayload()
      .then((payload) => {
        historyAllServerPayload = payload;
        historyAllServerCacheAt = Date.now();
        return payload;
      })
      .finally(() => {
        historyAllServerInFlight = null;
      });

    const payload = await historyAllServerInFlight;
    return res.json({ ...payload, cached: false });
  } catch (err) {
    console.error('[History Route] Error fetching all businesses:', err);
    return res.status(500).json({ error: 'Failed to fetch history list.' });
  }
});

//
// Lightweight index of every JSON in data/history (no delta/tracking merges).
// Used so clients can fuzzy-match names to business_id, then GET /api/history/:businessId alone.
//
router.get('/list', async (req, res) => {
  try {
    const ids = await getAllBusinessIds();
    const rows = [];

    for (const id of ids) {
      const history = await getHistory(id);
      if (!history?.business_id) continue;

      const scans = Array.isArray(history.scans) ? history.scans : [];
      rows.push({
        business_id: history.business_id,
        business_name: history.business_name || '',
        location: history.location || '',
        total_scans: scans.length,
      });
    }

    return res.json({ ok: true, businesses: rows });
  } catch (err) {
    console.error('[History Route] Error fetching history index:', err);
    return res.status(500).json({ error: 'Failed to fetch history index.' });
  }
});

// GET /api/history/:businessId
router.get('/:businessId', async (req, res) => {
  try {
    const history = await getHistory(req.params.businessId);
    if (!history) {
      return res.status(404).json({ error: 'History not found for this business.' });
    }

    // Merge traffic fields from tracking JSON (rank_history/tracking) into scans.map_ranks
    // so UI can show volume/daily/source_month stored per keyword.
    try {
      const tracking = await readTracking(req.params.businessId);
      const snaps = Array.isArray(tracking?.snapshots) ? tracking.snapshots : [];
      const latest = snaps.length ? snaps[snaps.length - 1] : null;
      const items = Array.isArray(latest?.items) ? latest.items : [];
      const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const byKw = new Map(items.map((it) => [norm(it.keyword), it]));

      for (const scan of history.scans || []) {
        const ranks = Array.isArray(scan?.map_ranks) ? scan.map_ranks : [];
        scan.map_ranks = ranks.map((mr) => {
          const t = byKw.get(norm(mr.keyword));
          if (!t) return mr;
          return {
            ...mr,
            target_keyword: t.target_keyword ?? mr.target_keyword,
            source_month: t.source_month ?? mr.source_month,
            volume: mr.volume ?? t.volume,
            daily_traffic: t.daily_traffic ?? mr.daily_traffic,
            estimated_clicks: t.estimated_clicks ?? mr.estimated_clicks,
            raw_traffic_data: t.raw_traffic_data ?? mr.raw_traffic_data,
          };
        });
      }
    } catch (e) {
      // Best-effort; history can still be served without tracking merge
    }

    // Apply delta calculator logic
    const enrichedScans = calculateDelta(history.scans || []);
    history.scans = enrichedScans;

    return res.json({ ok: true, data: history });
  } catch (err) {
    console.error(`[History Route] Error fetching history for ${req.params.businessId}:`, err);
    return res.status(500).json({ error: 'Failed to fetch business history.' });
  }
});

export default router;
