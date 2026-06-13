import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { createRequire } from 'module';
import { parseCrmSnapshotRegions } from './crmSnapshotRegions.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');
const DATA_PATH = path.join(SERVER_ROOT, 'data', 'business-connect.json');
const LOG_JSONL = path.join(SERVER_ROOT, 'data', 'business_connect_cron.jsonl');
const LOG_LAST = path.join(SERVER_ROOT, 'data', 'business_connect_cron_last.json');
const CONCURRENCY = Number(process.env.BUSINESS_CONNECT_CONCURRENCY || 6);
const require = createRequire(import.meta.url);

function crmBaseUrl() {
  return String(process.env.FORMFLOW_CRM_API_BASE || process.env.CRM_BASE || 'https://click.acquisition-central.com')
    .trim()
    .replace(/\/$/, '');
}

function crmHeaders() {
  const headers = { Accept: 'application/json' };
  const apiKey = String(process.env.FORMFLOW_CRM_API_KEY || process.env.VITE_FORMFLOW_CRM_API_KEY || '').trim();
  if (apiKey) headers['x-formflow-crm-key'] = apiKey;
  return headers;
}

function getGmbClient() {
  const parentGmbPath = path.resolve(__dirname, '../../../../config/gmb.js');
  return require(parentGmbPath);
}

function toShortLocationId(locationId) {
  const raw = String(locationId || '').trim();
  if (!raw) return '';
  const m = raw.match(/locations\/([^/]+)$/i);
  if (m?.[1]) return m[1];
  return raw.replace(/^locations\//i, '');
}

function appendLog(payload) {
  try {
    const dir = path.dirname(LOG_JSONL);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const rec = { ts: new Date().toISOString(), ...payload };
    fs.appendFileSync(LOG_JSONL, `${JSON.stringify(rec)}\n`, 'utf8');
    fs.writeFileSync(LOG_LAST, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
  } catch (e) {
    console.warn('[BusinessConnectCron] log write failed:', e?.message || e);
  }
}

async function fetchPayingClientsForRegion(region) {
  const reg = String(region || 'es').trim().toLowerCase() || 'es';
  const url = `${crmBaseUrl()}/api/formflow/crm/clients?region=${encodeURIComponent(reg)}`;
  const res = await axios.get(url, {
    headers: crmHeaders(),
    timeout: 45_000,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    throw new Error(`CRM clients HTTP ${res.status}: ${String(res.data?.error || res.data?.message || '').slice(0, 300)}`);
  }
  const rows = Array.isArray(res.data?.data) ? res.data.data : [];
  return rows.filter((c) => String(c?.pipeline_stage || '') === 'paying');
}

/**
 * @param {string} region CRM region code (es | us | br)
 */
async function buildBusinessConnectRowsForRegion(region) {
  const reg = String(region || 'es').trim().toLowerCase() || 'es';
  const paying = await fetchPayingClientsForRegion(reg);
  const gmb = getGmbClient();

  return pool(paying, CONCURRENCY, async (c) => {
    const clientId = String(c?.id || '').trim();
    const businessName = String(c?.business_name || '').trim();
    const base = {
      clientId,
      business_name: businessName,
      legal_business_name: String(c?.legal_business_name || '').trim() || null,
      pipeline_stage: String(c?.pipeline_stage || ''),
      region: reg,
      status: 'not_connected',
      reviews_count: 0,
      linkedbusiness: null,
      notlinked: {
        reason: 'No CRM GMB link found for this paying client.',
      },
    };

    try {
      const link = await fetchClientGmbLink(clientId);
      if (!link) return base;

      const accountId = String(link?.accountId || link?.account_id || link?.listingSnapshot?.accountId || '').trim();
      const locationIdRaw = String(
        link?.locationIdShort ||
          link?.locationId ||
          link?.location_id ||
          link?.listingSnapshot?.locationIdShort ||
          link?.listingSnapshot?.gmbLocationId ||
          '',
      ).trim();
      const locationId = toShortLocationId(locationIdRaw);
      const connectedName = String(link?.listingSnapshot?.title || link?.title || businessName || '').trim();

      let reviewsCount = null;
      let reviewsErr = null;
      if (accountId && locationId && typeof gmb?.getReviewCount === 'function') {
        try {
          reviewsCount = Number(await gmb.getReviewCount(accountId, locationId));
          if (!Number.isFinite(reviewsCount)) reviewsCount = null;
        } catch (e) {
          reviewsErr = String(e?.message || e);
        }
      }

      return {
        ...base,
        status: 'linked',
        reviews_count: Number.isFinite(reviewsCount) && reviewsCount != null ? reviewsCount : 0,
        linkedbusiness: {
          connected_business_name: connectedName || null,
          location_id: locationId || null,
          reviews_count: Number.isFinite(reviewsCount) && reviewsCount != null ? reviewsCount : 0,
          reviews_fetch_error: reviewsErr || null,
        },
        notlinked: null,
      };
    } catch (e) {
      return {
        ...base,
        notlinked: {
          reason: `Link lookup failed: ${String(e?.message || e)}`,
        },
      };
    }
  });
}

async function fetchClientGmbLink(clientId) {
  const url = `${crmBaseUrl()}/api/formflow/crm-gmb/clients/${encodeURIComponent(clientId)}`;
  const res = await axios.get(url, {
    headers: crmHeaders(),
    timeout: 30_000,
    validateStatus: () => true,
  });
  if (res.status >= 400) return null;
  return res.data?.link || null;
}

async function pool(items, limit, fn) {
  let i = 0;
  const out = new Array(items.length);
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

export async function buildAndWriteBusinessConnectSnapshot(outputPath = DATA_PATH) {
  const regions = parseCrmSnapshotRegions();
  const allRows = [];
  /** @type {Record<string, { totalPaying: number; linkedCount: number; notConnectedCount: number; withReviewsCount: number }>} */
  const byRegion = {};

  for (const reg of regions) {
    const rows = await buildBusinessConnectRowsForRegion(reg);
    const linked = rows.filter((r) => r.status === 'linked');
    const notConnected = rows.filter((r) => r.status !== 'linked');
    byRegion[reg] = {
      totalPaying: rows.length,
      linkedCount: linked.length,
      notConnectedCount: notConnected.length,
      withReviewsCount: linked.filter((r) => typeof r.reviews_count === 'number').length,
    };
    allRows.push(...rows);
  }

  const linkedAll = allRows.filter((r) => r.status === 'linked');
  const notConnectedAll = allRows.filter((r) => r.status !== 'linked');

  const payload = {
    generatedAt: new Date().toISOString(),
    region: regions.join(','),
    crmRegions: regions,
    summary: {
      totalPaying: allRows.length,
      linkedCount: linkedAll.length,
      notConnectedCount: notConnectedAll.length,
      withReviewsCount: linkedAll.filter((r) => typeof r.reviews_count === 'number').length,
      byRegion,
    },
    rows: allRows,
  };

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8');
  return { outputPath, summary: payload.summary, payload };
}

export async function readBusinessConnectSnapshotPayload() {
  const fp = String(process.env.BUSINESS_CONNECT_JSON_PATH || '').trim() || DATA_PATH;
  try {
    const raw = await fsp.readFile(fp, 'utf8');
    const j = JSON.parse(raw);
    return {
      ok: true,
      sourcePath: fp,
      generatedAt: j?.generatedAt ?? null,
      summary: j?.summary ?? null,
      rows: Array.isArray(j?.rows) ? j.rows : [],
    };
  } catch (e) {
    return {
      ok: true,
      sourcePath: null,
      generatedAt: null,
      summary: null,
      rows: [],
      _error: String(e?.message || e),
    };
  }
}

/** Default 22:30 UTC ≈ 04:00 IST. */
function msUntilNextBusinessConnectCronUtc() {
  const utcH = Number(process.env.BUSINESS_CONNECT_CRON_UTC_HOUR ?? 22);
  const utcM = Number(process.env.BUSINESS_CONNECT_CRON_UTC_MINUTE ?? 30);
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcH, utcM, 0, 0));
  if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return Math.max(15_000, target.getTime() - now.getTime());
}

export async function runBusinessConnectRebuildJob() {
  const outputPath = String(process.env.BUSINESS_CONNECT_JSON_PATH || '').trim() || DATA_PATH;
  appendLog({ phase: 'started', ok: true, outputPath });
  try {
    const out = await buildAndWriteBusinessConnectSnapshot(outputPath);
    const jsonWritten = fs.existsSync(outputPath);
    appendLog({ phase: 'completed', ok: true, outputPath, jsonWritten, summary: out?.summary || null });
    console.log('[BusinessConnectCron] completed — JSON at', outputPath, out?.summary || {});
    return { ok: true, outputPath, jsonWritten, summary: out?.summary || null };
  } catch (e) {
    const msg = String(e?.message || e);
    appendLog({ phase: 'error', ok: false, outputPath, error: msg });
    console.error('[BusinessConnectCron] failed:', msg);
    return { ok: false, outputPath, jsonWritten: false, error: msg };
  }
}

let _timer = null;
export function initBusinessConnectCron() {
  const enabled = String(process.env.ENABLE_BUSINESS_CONNECT_CRON ?? 'true').toLowerCase() !== 'false';
  if (!enabled) {
    console.log('[BusinessConnectCron] disabled (ENABLE_BUSINESS_CONNECT_CRON=false)');
    return;
  }

  const scheduleNext = () => {
    const delay = msUntilNextBusinessConnectCronUtc();
    const next = new Date(Date.now() + delay);
    const h = Number(process.env.BUSINESS_CONNECT_CRON_UTC_HOUR ?? 22);
    const m = String(Number(process.env.BUSINESS_CONNECT_CRON_UTC_MINUTE ?? 30)).padStart(2, '0');
    console.log(`[BusinessConnectCron] next rebuild at ${next.toISOString()} (UTC ${h}:${m} ≈ 04:00 IST)`);
    _timer = setTimeout(async () => {
      _timer = null;
      await runBusinessConnectRebuildJob();
      scheduleNext();
    }, delay);
  };

  if (String(process.env.BUSINESS_CONNECT_RUN_ON_STARTUP ?? 'false').toLowerCase() === 'true') {
    void runBusinessConnectRebuildJob();
  }
  scheduleNext();
}
