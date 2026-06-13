/**
 * One-time / manual rebuild: paying linked GMBs → last Google review age.
 * Output: `server/data/gmb-review-tracking.json` (byRegion: es, us, br).
 *
 * Requires: business-connect.json (run rebuild-connections-snapshots first if empty),
 * GMB OAuth creds, optional FORMFLOW_CRM_API_KEY for upstream snapshots.
 *
 * Usage (from `google-search-ranking/server`):
 *   node scripts/rebuild-gmb-review-tracking.mjs
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.resolve(serverRoot, '../../.env') });
dotenv.config({ path: path.join(serverRoot, '.env'), override: true });

const { runGmbReviewTrackingRebuildJob } = await import('../src/services/gmbReviewTracking.service.js');

console.log('[rebuild-gmb-review-tracking] starting…');
const out = await runGmbReviewTrackingRebuildJob();
console.log('[rebuild-gmb-review-tracking]', JSON.stringify(out, null, 2));
process.exit(out?.ok ? 0 : 1);
