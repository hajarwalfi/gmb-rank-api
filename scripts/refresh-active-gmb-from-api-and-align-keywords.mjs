/**
 * One-shot pipeline (run on server after deploy):
 * 1) syncActiveGmbFromSupabase — CRM → active-gmb.json (merges keyword counts from **services-keywords.json** via supabase mapper)
 * 2) rebuild **services-keywords.json** — paying CRM + GBP + AI keywords (`POST /api/services-keywords/rebuild` equivalent)
 *
 * Legacy step `align-gmb-keyword-counts-to-active-gmb` was removed — that file no longer exists.
 *
 * Usage: node google-search-ranking/server/scripts/refresh-active-gmb-from-api-and-align-keywords.mjs
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const parentEnv = path.resolve(serverRoot, '../../.env');
dotenv.config({ path: parentEnv });
dotenv.config({ path: path.join(serverRoot, '.env'), override: true });

const { syncActiveGmbFromSupabase } = await import('../src/services/supabaseGmb.service.js');
const { runServicesKeywordsRebuildJob } = await import('../src/services/servicesKeywordsSnapshot.service.js');

console.log('[refresh-active-gmb] Starting syncActiveGmbFromSupabase...');
const syncOut = await syncActiveGmbFromSupabase();
console.log('[refresh-active-gmb] sync done:', {
  gbp_access_count: syncOut?.gbp_access_count,
  with_keywords_count: syncOut?.keyword_generation_summary?.with_keywords_count,
  pending_keywords_count: syncOut?.keyword_generation_summary?.pending_keywords_count,
});

console.log('[refresh-active-gmb] Rebuilding services-keywords.json ...');
const skOut = await runServicesKeywordsRebuildJob();
console.log('[refresh-active-gmb] services-keywords done:', JSON.stringify(skOut, null, 2));
