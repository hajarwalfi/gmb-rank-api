import {
  buildMapsSeoDashboard,
  computeMapsSeoAggregates,
  saveMonthlyMapsSeoSnapshot,
} from '../services/kpiMapsSeo.service.js';

/**
 * GET /api/kpi/maps-seo/dashboard?region=es&rankMapFilter=all
 */
export async function getMapsSeoDashboard(req, res) {
  try {
    const region = String(req.query.region || '').trim().toLowerCase();
    const rankMapFilter = String(req.query.rankMapFilter || 'all').trim();
    if (!region) {
      return res.status(400).json({ ok: false, error: 'region query required (us|es|br|combined).' });
    }
    const out = await buildMapsSeoDashboard(region, rankMapFilter);
    return res.json(out);
  } catch (err) {
    console.error('[KPI Maps SEO] dashboard:', err);
    return res.status(500).json({ ok: false, error: 'Failed to build maps/SEO KPI dashboard.' });
  }
}

/**
 * GET /api/kpi/maps-seo/live?region=es&rankMapFilter=all — live aggregates only (no MoM).
 */
export async function getMapsSeoLive(req, res) {
  try {
    const region = String(req.query.region || '').trim().toLowerCase();
    const rankMapFilter = String(req.query.rankMapFilter || 'all').trim();
    if (!region) {
      return res.status(400).json({ ok: false, error: 'region query required (us|es|br|combined).' });
    }
    const live = await computeMapsSeoAggregates(region, rankMapFilter);
    return res.json({ ok: true, live });
  } catch (err) {
    console.error('[KPI Maps SEO] live:', err);
    return res.status(500).json({ ok: false, error: 'Failed to compute live maps/SEO KPIs.' });
  }
}

/**
 * POST /api/kpi/maps-seo/monthly-save
 * Body: { region, month: "2026-04", rankMapFilter?: "all" } — archives that month’s live rollup to JSON (cron on 1st).
 */
export async function postMonthlySave(req, res) {
  try {
    const region = String(req.body?.region || '').trim().toLowerCase();
    const month = String(req.body?.month || '').trim();
    const rankMapFilter = String(req.body?.rankMapFilter || 'all').trim();
    if (!region) {
      return res.status(400).json({ ok: false, error: 'region is required in JSON body.' });
    }
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ ok: false, error: 'month must be YYYY-MM in JSON body.' });
    }
    const out = await saveMonthlyMapsSeoSnapshot(region, month, rankMapFilter);
    return res.json(out);
  } catch (err) {
    console.error('[KPI Maps SEO] monthly-save:', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Failed to save monthly snapshot.' });
  }
}
