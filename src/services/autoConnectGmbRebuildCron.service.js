import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildAndWriteAutoConnectedGmbSnapshot } from './autoConnectGmbSnapshotBuilder.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');
const DATA_AUTO_CONNECTED = path.join(SERVER_ROOT, 'data', 'auto-connected-gmb.json');

function maybeMirrorAutoConnectedJson(srcPath) {
  try {
    const enabled = String(process.env.AUTOCONNECT_MIRROR_TO_CLIENT_HUB_PUBLIC || '').toLowerCase() === 'true';
    if (!enabled) return { mirrored: false, reason: 'AUTOCONNECT_MIRROR_TO_CLIENT_HUB_PUBLIC is not true' };
    const publicDest = path.resolve(SERVER_ROOT, '..', '..', 'formflow-buddy', 'client-hub-admin', 'public', 'auto-connected-gmb.json');
    const rootDest = path.resolve(SERVER_ROOT, '..', '..', 'formflow-buddy', 'client-hub-admin', 'auto-connected-gmb.json');
    for (const p of [publicDest, rootDest]) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.copyFileSync(srcPath, p);
    }
    return { mirrored: true, publicPath: publicDest, rootPath: rootDest };
  } catch (e) {
    return { mirrored: false, error: String(e?.message || e) };
  }
}
const LOG_JSONL = path.join(SERVER_ROOT, 'data', 'autoconnect_gmb_cron.jsonl');
const LOG_LAST = path.join(SERVER_ROOT, 'data', 'autoconnect_gmb_cron_last.json');

/** Default 22:00 UTC ≈ 03:30 IST (UTC+5:30, no DST). Override with AUTOCONNECT_CRON_UTC_HOUR / MINUTE. */
function msUntilNextAutoConnectCronUtc() {
  const utcH = Number(process.env.AUTOCONNECT_CRON_UTC_HOUR ?? 22);
  const utcM = Number(process.env.AUTOCONNECT_CRON_UTC_MINUTE ?? 0);
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcH, utcM, 0, 0));
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return Math.max(15_000, target.getTime() - now.getTime());
}

function appendLog(payload) {
  try {
    const dir = path.dirname(LOG_JSONL);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const rec = { ts: new Date().toISOString(), ...payload };
    fs.appendFileSync(LOG_JSONL, `${JSON.stringify(rec)}\n`, 'utf8');
    fs.writeFileSync(LOG_LAST, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
  } catch (e) {
    console.warn('[AutoConnectRebuildCron] log write failed:', e?.message || e);
  }
}

/**
 * Runs ranking-server native auto-connect rebuild (CRM API → JSON).
 * Primary output: `google-search-ranking/server/data/auto-connected-gmb.json` (served by GET /api/gmbautoconnect).
 */
export async function runRebuildAutoConnectedGmbJob() {
  const outputPath = String(process.env.AUTO_CONNECTED_GMB_OUTPUT_PATH || '').trim() || DATA_AUTO_CONNECTED;
  appendLog({ phase: 'started', ok: true, outputPath });
  try {
    const out = await buildAndWriteAutoConnectedGmbSnapshot(outputPath);
    const jsonWritten = fs.existsSync(outputPath);
    const mirror = jsonWritten ? maybeMirrorAutoConnectedJson(outputPath) : { mirrored: false };
    appendLog({
      phase: 'completed',
      ok: true,
      jsonWritten,
      outputPath,
      summary: out?.summary || null,
      mirror,
    });
    console.log('[AutoConnectRebuildCron] completed — JSON at', outputPath, out?.summary || {}, mirror);
    return { ok: true, jsonWritten, outputPath, summary: out?.summary || null, mirror };
  } catch (e) {
    const msg = String(e?.message || e);
    appendLog({ phase: 'error', ok: false, error: msg, outputPath });
    console.error('[AutoConnectRebuildCron] failed:', msg);
    return { ok: false, jsonWritten: false, outputPath, error: msg };
  }
}

let _timer = null;

export function initAutoConnectGmbRebuildCron() {
  const enabled = String(process.env.ENABLE_AUTOCONNECT_REBUILD_CRON ?? 'true').toLowerCase() !== 'false';
  if (!enabled) {
    console.log('[AutoConnectRebuildCron] disabled (ENABLE_AUTOCONNECT_REBUILD_CRON=false)');
    return;
  }

  const scheduleNext = () => {
    const delay = msUntilNextAutoConnectCronUtc();
    const next = new Date(Date.now() + delay);
    const h = Number(process.env.AUTOCONNECT_CRON_UTC_HOUR ?? 22);
    const m = String(Number(process.env.AUTOCONNECT_CRON_UTC_MINUTE ?? 0)).padStart(2, '0');
    console.log(
      `[AutoConnectRebuildCron] next rebuild at ${next.toISOString()} (UTC ${h}:${m} ≈ 03:30 IST when hour=22 minute=0)`
    );
    _timer = setTimeout(async () => {
      _timer = null;
      await runRebuildAutoConnectedGmbJob();
      scheduleNext();
    }, delay);
  };

  if (String(process.env.AUTOCONNECT_REBUILD_ON_STARTUP ?? 'false').toLowerCase() === 'true') {
    void runRebuildAutoConnectedGmbJob();
  }
  scheduleNext();
}
