/**
 * CRM "Connections" + auto-connect snapshot rebuild (ES + US + BR via `CRM_SNAPSHOT_REGIONS`):
 *  1) business-connect.json — linked vs not + reviews (Business-connect dropdown in Client Hub)
 *  2) auto-connected-gmb.json — AUTO-CONNECTION / manual / alreadyLinked (Connections column)
 *
 * Output rows include per-client `region` (`es` | `us` | `br`). Top-level `crmRegions` lists all merged regions.
 * When `AUTOCONNECT_MIRROR_TO_CLIENT_HUB_PUBLIC=true`, also copies auto-connected JSON to Client Hub
 * `public/auto-connected-gmb.json` (+ repo root copy).
 *
 * Env (same as `_backup-workspace-2026-05-14`): repo `../../.env` then `server/.env` with override only.
 *
 * Usage (from `google-search-ranking/server`):
 *   node scripts/rebuild-connections-snapshots.mjs
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.resolve(serverRoot, '../../.env') });
dotenv.config({ path: path.join(serverRoot, '.env'), override: true });

const { parseCrmSnapshotRegions } = await import('../src/services/crmSnapshotRegions.service.js');
const { runBusinessConnectRebuildJob } = await import('../src/services/businessConnectCron.service.js');
const { runRebuildAutoConnectedGmbJob } = await import('../src/services/autoConnectGmbRebuildCron.service.js');

console.log('[rebuild-connections] CRM regions:', parseCrmSnapshotRegions().join(', '));

console.log('\n[rebuild-connections] === business-connect ===');
const bc = await runBusinessConnectRebuildJob();
console.log('[rebuild-connections] business-connect:', JSON.stringify(bc, null, 2));
if (!bc?.ok) process.exit(1);

console.log('\n[rebuild-connections] === auto-connected-gmb ===');
const ac = await runRebuildAutoConnectedGmbJob();
console.log('[rebuild-connections] auto-connected-gmb:', JSON.stringify(ac, null, 2));
process.exit(ac?.ok ? 0 : 1);
