/**
 * One-shot combined pipeline for ES + US + BR (see `CRM_SNAPSHOT_REGIONS` / `parseCrmSnapshotRegions`):
 *  1) auto-connected-gmb.json
 *  2) business-connect.json
 *  3) services-keywords.json (incremental merge; use regenerate-services-keywords-full.mjs for force-AI-all)
 *  4) active-gmb.json (+ stats) via Formflow CRM when USE_FORMFLOW_CRM_CLIENTS=true
 *
 * Usage (from `google-search-ranking/server`):
 *   node scripts/rebuild-all-crm-snapshots-combined.mjs
 *
 * Requires: server/.env — FORMFLOW_CRM_API_BASE + key, GMB_*, OPENAI_* as for individual rebuild scripts.
 *
 * Env (same as `_backup-workspace-2026-05-14`): repo `../../.env` then `server/.env` with override only.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const parentEnv = path.resolve(serverRoot, '../../.env');
dotenv.config({ path: parentEnv });
dotenv.config({ path: path.join(serverRoot, '.env'), override: true });

const { parseCrmSnapshotRegions } = await import('../src/services/crmSnapshotRegions.service.js');
const { runRebuildAutoConnectedGmbJob } = await import('../src/services/autoConnectGmbRebuildCron.service.js');
const { runBusinessConnectRebuildJob } = await import('../src/services/businessConnectCron.service.js');
const { runServicesKeywordsRebuildJob } = await import('../src/services/servicesKeywordsSnapshot.service.js');
const { syncActiveGmbFromSupabase } = await import('../src/services/supabaseGmb.service.js');

const regions = parseCrmSnapshotRegions();
console.log('[rebuild-all-crm-combined] CRM_SNAPSHOT_REGIONS →', regions.join(', '));

const steps = [
  ['auto-connected-gmb', () => runRebuildAutoConnectedGmbJob()],
  ['business-connect', () => runBusinessConnectRebuildJob()],
  ['services-keywords', () => runServicesKeywordsRebuildJob({ forceKeywords: false })],
  ['active-gmb (CRM/Supabase sync)', () => syncActiveGmbFromSupabase()],
];

let failed = false;
for (const [name, fn] of steps) {
  console.log(`\n[rebuild-all-crm-combined] === ${name} ===`);
  try {
    const out = await fn();
    if (out && out.ok === false) {
      console.error(`[rebuild-all-crm-combined] FAILED: ${name}`, out?.error || out);
      failed = true;
      break;
    }
    console.log(`[rebuild-all-crm-combined] ok: ${name}`, JSON.stringify(out?.summary ?? out, null, 2)?.slice(0, 2000));
  } catch (e) {
    console.error(`[rebuild-all-crm-combined] FAILED: ${name}`, e?.message || e);
    failed = true;
    break;
  }
}

process.exit(failed ? 1 : 0);
