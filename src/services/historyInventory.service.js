import { getHistory, getAllBusinessIds } from './historyManager.js';
import { calculateDelta } from './deltaCalculator.js';
import { readTracking } from './gmbTrackingHistory.service.js';

function normKeyword(k) {
  return String(k || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Local pack positions we treat as “ranking on Maps” (matches typical 3-pack / LMF UI). */
export function isValidMapRank(n) {
  const r = Number(n);
  return Number.isFinite(r) && r >= 1 && r <= 20;
}

/**
 * Merge latest + previous scan map_ranks with unified-tracking JSON (GBP clicks / month),
 * same idea as GET /api/history/all.
 */
export async function enrichTwoScansWithTracking(businessId, latestScan, previousScan) {
  try {
    const tracking = await readTracking(businessId);
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
}

function pickScreenshotUrl(mr, scan) {
  const row = String(mr?.screenshot_url || mr?.screenshotUrl || '').trim();
  if (row) return row;
  return String(scan?.screenshot_url || '').trim() || null;
}

/** Opens Google Maps search for “keyword + service area” (best-effort map-pack context). */
function buildMapResultUrl(keyword, locationLabel) {
  const q = [keyword, locationLabel].map((s) => String(s || '').trim()).filter(Boolean).join(' ').trim();
  if (!q) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

/**
 * Flatten every business’s latest scan keywords → one row per keyword.
 * @param {string} [filter] - 'all' | 'ranked' | 'not_ranked' | 'improved'
 */
export async function buildMapsRankingInventory(filter = 'all') {
  const ids = await getAllBusinessIds();
  const rawRows = [];

  for (const id of ids) {
    const history = await getHistory(id);
    if (!history?.scans?.length) continue;

    const scansDesc = [...history.scans].sort(
      (a, b) => new Date(b?.scanned_at || 0) - new Date(a?.scanned_at || 0)
    );
    const enrichedScans = calculateDelta(scansDesc).reverse();
    const latestScan = enrichedScans[0];
    const previousScan = enrichedScans[1] || null;

    if (!latestScan) continue;

    await enrichTwoScansWithTracking(id, latestScan, previousScan);

    const prevByKeyword = new Map();
    if (Array.isArray(previousScan?.map_ranks)) {
      for (const r of previousScan.map_ranks) {
        prevByKeyword.set(normKeyword(r.keyword), r);
      }
    }

    const ranks = Array.isArray(latestScan.map_ranks) ? latestScan.map_ranks : [];
    for (const mr of ranks) {
      const kw = String(mr.keyword || '').trim();
      if (!kw) continue;

      const rankNum =
        mr.rank != null && Number.isFinite(Number(mr.rank)) ? Number(mr.rank) : null;
      const rankedOnMaps = isValidMapRank(rankNum);

      const prevRow = prevByKeyword.get(normKeyword(kw));
      const prevRank =
        prevRow?.rank != null && Number.isFinite(Number(prevRow.rank)) ? Number(prevRow.rank) : null;

      let rankImproved = false;
      if (prevRank != null && rankNum != null && isValidMapRank(prevRank) && isValidMapRank(rankNum)) {
        rankImproved = rankNum < prevRank;
      }

      rawRows.push({
        business_id: history.business_id,
        business_name: history.business_name || '',
        /** Service area / listing label from history JSON */
        location: history.location || '',
        keyword: kw,
        rank: rankNum,
        previous_rank: prevRank,
        ranked_on_maps: rankedOnMaps,
        rank_improved_vs_previous: rankImproved,
        has_previous_scan: Boolean(previousScan),
        screenshot_url: pickScreenshotUrl(mr, latestScan),
        map_result_url: buildMapResultUrl(kw, history.location || ''),
        scanned_at: latestScan.scanned_at || null,
        scan_id: latestScan.scan_id || null,
      });
    }
  }

  const f = String(filter || 'all').toLowerCase();
  let rows = rawRows;
  if (f === 'ranked') {
    rows = rawRows.filter((r) => r.ranked_on_maps);
  } else if (f === 'not_ranked') {
    rows = rawRows.filter((r) => !r.ranked_on_maps);
  } else if (f === 'improved') {
    rows = rawRows.filter((r) => r.rank_improved_vs_previous);
  }

  const businessIdsRanked = new Set(
    rawRows.filter((r) => r.ranked_on_maps).map((r) => r.business_id)
  );

  return {
    generated_at: new Date().toISOString(),
    filter: f === 'all' || !f ? 'all' : f,
    summary: {
      total_businesses_in_history: ids.length,
      businesses_with_at_least_one_ranked_keyword: businessIdsRanked.size,
      total_keyword_rows: rawRows.length,
      ranked_rows: rawRows.filter((r) => r.ranked_on_maps).length,
      not_ranked_rows: rawRows.filter((r) => !r.ranked_on_maps).length,
      improved_rank_rows: rawRows.filter((r) => r.rank_improved_vs_previous).length,
      rows_returned: rows.length,
    },
    rows,
  };
}
