/**
 * Computes deltas for a series of consecutive scan entries.
 */
export function calculateDelta(scans = []) {
  if (!scans || !scans.length) return [];

  // Deep clone so we don't unexpectedly mutate
  const enrichedScans = JSON.parse(JSON.stringify(scans));

  // Sort them chronologically ascending by scanned_at just in case
  enrichedScans.sort((a, b) => new Date(a.scanned_at) - new Date(b.scanned_at));

  for (let i = 0; i < enrichedScans.length; i++) {
    const current = enrichedScans[i];
    const prev = i > 0 ? enrichedScans[i - 1] : null;

    current.deltas = {
      traffic: {
        website_clicks_diff: null,
        website_clicks_pct: null,
        impressions_diff: null,
        impressions_pct: null,
      },
      map_ranks: {},
      reviews: {
        new_since_last_scan: current.reviews?.new_since_last_scan || 0,
        total_count_diff: null,
      }
    };

    if (prev) {
      // 1. Traffic calculation (Clicks)
      const currentClicks = current.traffic?.website_clicks || 0;
      const prevClicks = prev.traffic?.website_clicks || 0;
      const diffClicks = currentClicks - prevClicks;
      
      let pctClicks = 0;
      if (prevClicks > 0) {
        pctClicks = (diffClicks / prevClicks) * 100;
      } else if (prevClicks === 0 && currentClicks > 0) {
        pctClicks = 100;
      }
      
      current.deltas.traffic.website_clicks_diff = diffClicks;
      current.deltas.traffic.website_clicks_pct = Math.round(pctClicks * 10) / 10;

      // 1b. Impressions calculation
      const currentImp = current.traffic?.impressions || 0;
      const prevImp = prev.traffic?.impressions || 0;
      const diffImp = currentImp - prevImp;

      let pctImp = 0;
      if (prevImp > 0) {
        pctImp = (diffImp / prevImp) * 100;
      } else if (prevImp === 0 && currentImp > 0) {
        pctImp = 100;
      }
      current.deltas.traffic.impressions_diff = diffImp;
      current.deltas.traffic.impressions_pct = Math.round(pctImp * 10) / 10;

      // 2. Rank calculation
      const currentRanks = current.map_ranks || [];
      const prevRanks = prev.map_ranks || [];

      // create lookup map for previous ranks
      const prevRankMap = prevRanks.reduce((acc, r) => {
        if (r.keyword) acc[r.keyword] = r.rank;
        return acc;
      }, {});

      for (const curRank of currentRanks) {
        if (!curRank.keyword) continue;
        
        const prRank = prevRankMap[curRank.keyword];
        let diff = null;

        // Remember lower rank = better. 
        if (prRank != null && curRank.rank != null) {
          diff = curRank.rank - prRank;
        }

        current.deltas.map_ranks[curRank.keyword] = diff;
      }

      // 3. Reviews calculation
      const curRev = current.reviews?.total_count || 0;
      const preRev = prev.reviews?.total_count || 0;
      current.deltas.reviews.total_count_diff = curRev - preRev;
    }
  }

  return enrichedScans;
}
