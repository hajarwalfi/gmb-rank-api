/**
 * Populate data/gmb-review-monthly.json from scan history + GBP reviews API.
 *
 *   node scripts/rebuild-gmb-review-monthly.mjs
 *   GMB_REVIEW_MONTHLY_FETCH_GBP=false node scripts/rebuild-gmb-review-monthly.mjs  # scans only (fast)
 */
import { buildAndWriteGmbReviewMonthlySnapshot } from '../src/services/gmbReviewMonthly.service.js';

const out = await buildAndWriteGmbReviewMonthlySnapshot();
console.log(JSON.stringify(out.summary, null, 2));
process.exit(out?.summary ? 0 : 1);
