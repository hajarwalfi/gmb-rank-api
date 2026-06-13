/**
 * GMB Traffic Estimation Logic
 * Based on Rank Click-Through Rate (CTR) and Geo-weight adjustments (Rating, Reviews, Distance).
 */

const CTR_MODEL = {
  1: 0.30,
  2: 0.18,
  3: 0.12,
  4: 0.08,
  5: 0.05,
  6: 0.04,
  7: 0.035,
  8: 0.03,
  9: 0.025,
  10: 0.02,
};

/**
 * Calculates estimated clicks for a single keyword.
 */
export function calculateEstimatedClicks(searchVolume, rank, metrics = {}) {
  const vol = Number(searchVolume) || 0;
  const r = Number(rank);

  if (vol <= 0 || !r || r > 20) return 0;

  let ctr = 0.01;
  if (r <= 10) {
    ctr = CTR_MODEL[r] || 0.02;
  }

  const rating = Number(metrics.rating) || 0;
  const reviews = Number(metrics.reviews) || 0;
  const distance = Number(metrics.distance) || 1.0;

  let ratingFactor = 1.0;
  if (rating > 4.0) {
    ratingFactor = 1.0 + (rating - 4.0) * 0.1;
  } else if (rating > 0 && rating < 4.0) {
    ratingFactor = 1.0 - (4.0 - rating) * 0.1;
  }
  ratingFactor = Math.max(0.7, Math.min(1.15, ratingFactor));

  let reviewFactor = 1.0;
  if (reviews > 100) reviewFactor = 1.10;
  else if (reviews > 50) reviewFactor = 1.05;
  else if (reviews < 5) reviewFactor = 0.95;

  const distanceFactor = Number(distance) || 1.0;
  const estimatedClicks = (vol * ctr) * ratingFactor * reviewFactor * distanceFactor;

  return Math.round(estimatedClicks * 100) / 100;
}

/**
 * Prepares a keyword for DataForSEO Labs analysis.
 */
export function cleanKeyword(keyword, location = '') {
  if (!keyword) return '';
  let clean = String(keyword).toLowerCase();

  // 1. Geography fillers (Remove zip, usa, near me)
  const fillers = [
    /\bnear me\b/g,
    /\busa\b/g,
    /\bunited states\b/g,
    /\b\d{5}\b/g,
    /,\s*/g
  ];

  fillers.forEach(f => {
    clean = clean.replace(f, ' ');
  });

  // 2. Clear punctuation and extra spaces
  clean = clean.replace(/[.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return clean || keyword.toLowerCase();
}

/**
 * Aggregates traffic for multiple keywords.
 */
export function aggregateTraffic(keywordData = []) {
  let totalMonthly = 0;
  const details = keywordData.map(kw => {
    const clicks = calculateEstimatedClicks(kw.volume, kw.rank, {
      rating: kw.rating,
      reviews: kw.reviews,
      distance: kw.distance
    });
    totalMonthly += clicks;
    return {
      keyword: kw.keyword,
      clicks: Math.round(clicks),
      daily: Math.round(clicks / 30 * 10) / 10
    };
  });

  return {
    total_monthly_clicks: Math.round(totalMonthly),
    total_daily_clicks: Math.round(totalMonthly / 30),
    keyword_contribution: details
  };
}

/**
 * Generates multiple keyword variations for broader DataForSEO Labs matching.
 * Mirrors the logic in traffic.controller.js.
 */
export function generateKeywordCandidates(keyword, locationContext = '') {
  if (!keyword) return [];
  const cleaned = cleanKeyword(keyword, locationContext);
  const original = String(keyword).trim();
  const commaParts = original.split(',').map(s => s.trim()).filter(Boolean);
  const commaPartsLower = commaParts.map(s => s.toLowerCase());

  const deMod = cleaned
    .replace(/\b(best|affordable|cheap|top|near)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const candidates = [
    original,
    cleaned,
    ...commaParts,
    ...commaPartsLower,
    deMod,
  ].map(s => String(s || '').trim()).filter(Boolean);

  return [...new Set(candidates)];
}
