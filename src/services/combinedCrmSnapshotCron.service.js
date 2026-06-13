import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runRebuildAutoConnectedGmbJob } from './autoConnectGmbRebuildCron.service.js';
import { runBusinessConnectRebuildJob } from './businessConnectCron.service.js';
import { runServicesKeywordsRebuildJob } from './servicesKeywordsSnapshot.service.js';
import { syncActiveGmbFromSupabase } from './supabaseGmb.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');
const LOG_JSONL = path.join(SERVER_ROOT, 'data', 'combined_crm_snapshot_cron.jsonl');
const LOG_LAST = path.join(SERVER_ROOT, 'data', 'combined_crm_snapshot_cron_last.json');

function appendLog(payload) {
  try {
    const dir = path.dirname(LOG_JSONL);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const rec = { ts: new Date().toISOString(), ...payload };
    fs.appendFileSync(LOG_JSONL, `${JSON.stringify(rec)}\n`, 'utf8');
    fs.writeFileSync(LOG_LAST, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
  } catch (e) {
    console.warn('[CombinedCrmSnapshotCron] log write failed:', e?.message || e);
  }
}

function msUntilNextUtc(hour, minute) {
  const utcH = Number(hour);
  const utcM = Number(minute);
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcH, utcM, 0, 0));
  if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return Math.max(60_000, target.getTime() - now.getTime());
}

/**
 * Single nightly pipeline (same order as `scripts/rebuild-all-crm-snapshots-combined.mjs`):
 * autoconnect → business-connect → services-keywords → active-gmb.
 * Enable with `ENABLE_COMBINED_CRM_SNAPSHOT_CRON=true` and set `ENABLE_*` on the legacy split crons to false
 * to avoid duplicate work.
 */
export async function runCombinedCrmSnapshotPipeline() {
  const steps = [
    ['auto-connected-gmb', () => runRebuildAutoConnectedGmbJob()],
    ['business-connect', () => runBusinessConnectRebuildJob()],
    ['services-keywords', () => runServicesKeywordsRebuildJob({ forceKeywords: false })],
    ['active-gmb', () => syncActiveGmbFromSupabase()],
  ];
  appendLog({ phase: 'started', ok: true, steps: steps.map((s) => s[0]) });
  try {
    for (const [name, fn] of steps) {
      const out = await fn();
      if (out && out.ok === false) {
        const err = out?.error || 'step_failed';
        appendLog({ phase: 'error', ok: false, step: name, error: String(err) });
        console.error('[CombinedCrmSnapshotCron] failed at', name, err);
        return { ok: false, failedStep: name, error: String(err) };
      }
    }
    appendLog({ phase: 'completed', ok: true });
    console.log('[CombinedCrmSnapshotCron] completed full pipeline (es+us+br merged snapshots)');
    return { ok: true };
  } catch (e) {
    const msg = String(e?.message || e);
    appendLog({ phase: 'error', ok: false, error: msg });
    console.error('[CombinedCrmSnapshotCron] failed:', msg);
    return { ok: false, error: msg };
  }
}

let _timer = null;

export function initCombinedCrmSnapshotCron() {
  const enabled = String(process.env.ENABLE_COMBINED_CRM_SNAPSHOT_CRON ?? 'false').toLowerCase() === 'true';
  if (!enabled) {
    console.log('[CombinedCrmSnapshotCron] disabled (ENABLE_COMBINED_CRM_SNAPSHOT_CRON=false)');
    return;
  }

  const hour = Number(process.env.COMBINED_CRM_SNAPSHOT_CRON_UTC_HOUR ?? 21);
  const minute = Number(process.env.COMBINED_CRM_SNAPSHOT_CRON_UTC_MINUTE ?? 15);

  const scheduleNext = () => {
    const delay = msUntilNextUtc(hour, minute);
    const next = new Date(Date.now() + delay);
    console.log(
      `[CombinedCrmSnapshotCron] next full pipeline at ${next.toISOString()} (UTC ${hour}:${String(minute).padStart(2, '0')})`,
    );
    _timer = setTimeout(async () => {
      _timer = null;
      await runCombinedCrmSnapshotPipeline();
      scheduleNext();
    }, delay);
  };

  if (String(process.env.COMBINED_CRM_SNAPSHOT_RUN_ON_STARTUP ?? 'false').toLowerCase() === 'true') {
    void runCombinedCrmSnapshotPipeline();
  }
  scheduleNext();
}
