/**
 * Full rebuild of `data/services-keywords.json`:
 * - Paying clients from FormFlow CRM API (same as nightly job)
 * - Fresh GBP profile per location
 * - New AI keywords: random count per GMB between SERVICES_KEYWORDS_PER_ROW_MIN/MAX (default 4–8)
 *
 * Usage (from repo): `node server/scripts/regenerate-services-keywords-full.mjs`
 * Requires: server/.env with OPENAI_API_KEY, GMB_*, FORMFLOW_CRM_API_KEY (or VITE_...), etc.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.resolve(serverRoot, '../../.env') });
dotenv.config({ path: path.resolve(serverRoot, '.env'), override: true });

process.env.SERVICES_KEYWORDS_FORCE_REGENERATE = 'true';

const { buildAndWriteServicesKeywordsSnapshot } = await import(
  '../src/services/servicesKeywordsSnapshot.service.js'
);

console.log('[regenerate-services-keywords-full] starting (force regenerate all keywords)…');
try {
  const out = await buildAndWriteServicesKeywordsSnapshot(undefined, { forceKeywords: true });
  console.log('[regenerate-services-keywords-full] ok', JSON.stringify(out?.summary || {}, null, 2));
  console.log('[regenerate-services-keywords-full] written:', out?.outputPath);
  process.exit(0);
} catch (e) {
  console.error('[regenerate-services-keywords-full] failed:', e?.message || e);
  process.exit(1);
}
