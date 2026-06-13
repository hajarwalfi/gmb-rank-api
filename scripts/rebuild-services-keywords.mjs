/**
 * One-shot: paying CRM + GBP-linked locations → server/data/services-keywords.json
 * (same job as POST /api/services-keywords/rebuild)
 *
 * Usage (from server folder):
 *   node scripts/rebuild-services-keywords.mjs
 *
 * Requires: FORMFLOW_CRM_API_BASE + FORMFLOW_CRM_API_KEY (or CRM_BASE), GMB_*, OPENAI_API_KEY for new keyword rows.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const parentEnv = path.resolve(serverRoot, '../../.env');
dotenv.config({ path: parentEnv });
dotenv.config({ path: path.join(serverRoot, '.env'), override: true });

const { runServicesKeywordsRebuildJob } = await import('../src/services/servicesKeywordsSnapshot.service.js');

console.log('[rebuild-services-keywords] Starting...');
const out = await runServicesKeywordsRebuildJob();
console.log('[rebuild-services-keywords] Result:', JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
