import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { getLocationFull } from './gmb.service.js';
import {
  generateKeywords,
  inferCountryFromLocations,
  randomIntInclusive,
} from './keywordGeneration.service.js';
import { crmSnapshotRegionsLabel, parseCrmSnapshotRegions } from './crmSnapshotRegions.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');
const DATA_PATH = path.join(SERVER_ROOT, 'data', 'services-keywords.json');
const LOG_JSONL = path.join(SERVER_ROOT, 'data', 'services_keywords_cron.jsonl');
const LOG_LAST = path.join(SERVER_ROOT, 'data', 'services_keywords_cron_last.json');
const DAILY_TRACK_JSONL = path.join(SERVER_ROOT, 'data', 'services_keywords_daily_track.jsonl');
const CONCURRENCY = Number(process.env.SERVICES_KEYWORDS_CONCURRENCY || 4);

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

/** Default false: include all paying CRM clients with a valid GMB link (no CRM `gmb_status` filter). Set env to true to restrict to Active/verified-style statuses only. */
function requireActiveGmbStatus() {
  return String(process.env.SERVICES_KEYWORDS_REQUIRE_ACTIVE_GMB_STATUS ?? 'false').toLowerCase() === 'true';
}

function isActiveGmbStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s) return !requireActiveGmbStatus();
  return (
    s === 'active' ||
    s === 'activo' ||
    s === 'ativo' ||
    s.includes('active') ||
    s.includes('activo') ||
    s.includes('ativo') ||
    s === 'verified'
  );
}

function toShortLocationId(locationId) {
  const raw = String(locationId || '').trim();
  if (!raw) return '';
  const m = raw.match(/locations\/([^/]+)$/i);
  if (m?.[1]) return m[1];
  return raw.replace(/^locations\//i, '');
}

export function getCategory(detail) {
  return (
    detail?.categories?.primaryCategory?.displayName ||
    detail?.categories?.primaryCategory?.name ||
    ''
  ).trim();
}

/** Service-area places/regions only (no storefront fallback). */
export function getExplicitServiceAreas(detail) {
  const sa = detail?.serviceArea;
  const out = [];
  if (!sa) return out;
  if (Array.isArray(sa)) {
    sa.filter(Boolean).forEach((a) => out.push(String(a)));
    return [...new Set(out.filter(Boolean))];
  }
  sa.places?.placeInfos?.forEach((p) => {
    const n = p?.placeName || p?.placeId;
    if (n) out.push(String(n));
  });
  if (sa.regionCode && String(sa.regionCode).length > 2) out.push(String(sa.regionCode));
  sa.regions?.forEach((r) => {
    const v = r?.displayName || r?.name || r?.regionCode || r?.placeId || (typeof r === 'string' ? r : '');
    if (v) out.push(String(v));
  });
  return [...new Set(out.filter(Boolean))];
}

function getStorefrontLocalityLine(detail) {
  const city = detail?.storefrontAddress?.locality || detail?.address?.locality;
  const state = detail?.storefrontAddress?.administrativeArea || detail?.address?.administrativeArea;
  if (!city) return '';
  return state ? `${city} ${state}` : String(city);
}

/** Areas used for AI + UI chips: explicit GBP areas, else storefront line from GBP (still “from GBP”). */
export function getAreasForKeywords(detail) {
  const explicit = getExplicitServiceAreas(detail);
  if (explicit.length) return { areas: explicit, source: 'gbp_explicit' };
  const line = getStorefrontLocalityLine(detail);
  if (line) return { areas: [line], source: 'gbp_storefront_address' };
  return { areas: [], source: 'none' };
}

export function extractGbpServiceLabels(detail) {
  const items = Array.isArray(detail?.serviceItems) ? detail.serviceItems : [];
  const labels = [];
  for (const it of items) {
    const free = it?.freeFormServiceItem;
    if (free?.label) labels.push(String(free.label).trim());
    const str = it?.structuredServiceItem;
    if (str?.displayName) labels.push(String(str.displayName).trim());
    if (str?.description) labels.push(String(str.description).trim());
  }
  return [...new Set(labels.filter(Boolean))].slice(0, 40);
}

function appendLog(payload) {
  try {
    const dir = path.dirname(LOG_JSONL);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const rec = { ts: new Date().toISOString(), ...payload };
    fs.appendFileSync(LOG_JSONL, `${JSON.stringify(rec)}\n`, 'utf8');
    fs.writeFileSync(LOG_LAST, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
  } catch (e) {
    console.warn('[ServicesKeywords] log write failed:', e?.message || e);
  }
}

async function fetchPayingClientsForRegion(region) {
  const reg = String(region || '').trim().toLowerCase();
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
  return rows
    .filter((c) => String(c?.pipeline_stage || '') === 'paying')
    .map((c) => {
      const id = String(c?.id ?? c?._id ?? '').trim();
      return {
        ...c,
        id,
        region: String(c?.region || reg).trim().toLowerCase() || reg,
      };
    })
    .filter((c) => c.id);
}

/** Paying clients from all CRM snapshot regions (default es+us+br) — same pool as business-connect / autoconnect. */
async function fetchPayingClients() {
  const regions = parseCrmSnapshotRegions();
  const byId = new Map();
  for (const reg of regions) {
    const rows = await fetchPayingClientsForRegion(reg);
    for (const c of rows) {
      const id = String(c?.id ?? '').trim();
      if (id && !byId.has(id)) byId.set(id, c);
    }
  }
  return [...byId.values()];
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

/**
 * Compare previous vs next snapshot rows (keyed by CRM clientId).
 * `firstTimeKeywordRows` are full next-row objects that newly gained keywords (new client with keywords, or 0 → N).
 */
export function computeServicesKeywordsDiff(prevRows, nextRows) {
  const prevList = Array.isArray(prevRows) ? prevRows : [];
  const nextList = Array.isArray(nextRows) ? nextRows : [];
  const prevByClient = new Map();
  for (const r of prevList) {
    const id = String(r?.clientId || '').trim();
    if (id) prevByClient.set(id, r);
  }
  const nextIds = new Set();
  const newPayingClients = [];
  const firstTimeKeywordRows = [];
  for (const r of nextList) {
    const cid = String(r?.clientId || '').trim();
    if (!cid) continue;
    nextIds.add(cid);
    const prev = prevByClient.get(cid);
    const pKw = Number(prev?.keywordsCount || 0);
    const nKw = Number(r?.keywordsCount || 0);
    if (!prev) {
      newPayingClients.push({
        clientId: cid,
        gmbName: String(r?.gmbName || r?.business_name || '').trim(),
        keywordsCount: nKw,
      });
      if (nKw > 0) firstTimeKeywordRows.push(r);
    } else if (pKw === 0 && nKw > 0) {
      firstTimeKeywordRows.push(r);
    }
  }
  const removedClientIds = [];
  for (const id of prevByClient.keys()) {
    if (!nextIds.has(id)) removedClientIds.push(id);
  }
  return { newPayingClients, firstTimeKeywordRows, removedClientIds };
}

function appendDailyTrackLine(payload) {
  try {
    const dir = path.dirname(DAILY_TRACK_JSONL);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(DAILY_TRACK_JSONL, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (e) {
    console.warn('[ServicesKeywords] daily track write failed:', e?.message || e);
  }
}

export function buildServiceContextString(primaryCategory, gbpServices) {
  const cat = String(primaryCategory || '').trim();
  const sv = Array.isArray(gbpServices) ? gbpServices.filter(Boolean).map((s) => String(s).trim()) : [];
  if (!cat && !sv.length) return '';
  if (!sv.length) return cat;
  if (!cat) return `Services: ${sv.slice(0, 15).join('; ')}`;
  return `${cat} · Services: ${sv.slice(0, 15).join('; ')}`;
}

/**
 * On-demand: 10–15 service+area keywords for Client Hub manual run (`intent=manual`).
 * Uses live GBP when possible, else snapshot row fallback.
 */
export async function buildKeywordsForLocationIntent(accountId, locationIdShort, intent = '') {
  const payload = await readServicesKeywordsPayload();
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const match = rows.find(
    (r) =>
      String(r.accountId || '').trim() === String(accountId || '').trim() &&
      String(r.locationIdShort || r.locationId || '').trim() === String(locationIdShort || '').trim(),
  );
  if (!match) {
    return { ok: false, error: 'not_found', keywords: [], keywordSource: 'none', resolvedCountry: null };
  }

  const fallbackKws = Array.isArray(match.keywords) ? match.keywords : [];
  const resolvedCountryOut = match.resolvedCountry || null;

  if (String(intent).toLowerCase() !== 'manual') {
    return {
      ok: true,
      keywords: fallbackKws,
      keywordSource: 'snapshot',
      businessName: String(match.gmbName || match.business_name || '').trim() || null,
      resolvedCountry: resolvedCountryOut,
    };
  }

  let detail = null;
  try {
    detail = await getLocationFull(accountId, locationIdShort);
  } catch {
    detail = null;
  }
  const snap =
    match.gbpDetailSnapshot && typeof match.gbpDetailSnapshot === 'object' ? match.gbpDetailSnapshot : null;
  const effective = detail || snap;
  if (!effective) {
    return {
      ok: true,
      keywords: fallbackKws,
      keywordSource: 'snapshot_no_gbp',
      businessName: String(match.gmbName || match.business_name || '').trim() || null,
      resolvedCountry: resolvedCountryOut,
    };
  }

  const primaryCategory = getCategory(detail) || getCategory(snap) || String(match.primaryCategory || '');
  const gbpServices = detail
    ? extractGbpServiceLabels(detail)
    : Array.isArray(match.gbpServices)
      ? match.gbpServices
      : [];
  const { areas: areasForAi } = getAreasForKeywords(effective);
  if (!areasForAi.length) {
    return {
      ok: true,
      keywords: fallbackKws,
      keywordSource: 'snapshot_no_areas',
      businessName: String(match.gmbName || match.business_name || '').trim() || null,
      resolvedCountry: resolvedCountryOut,
    };
  }

  const gmbTitle = String(effective?.title || match.gmbName || match.business_name || '').trim();
  const serviceStr = buildServiceContextString(primaryCategory, gbpServices);
  if (!serviceStr.trim()) {
    return {
      ok: true,
      keywords: fallbackKws,
      keywordSource: 'snapshot_no_service_context',
      businessName: gmbTitle || null,
      resolvedCountry: resolvedCountryOut,
    };
  }

  const manualMin = Number(process.env.MANUAL_RUN_KEYWORDS_MIN || 10);
  const manualMax = Number(process.env.MANUAL_RUN_KEYWORDS_MAX || 15);
  const tc = randomIntInclusive(Math.min(manualMin, manualMax), Math.max(manualMin, manualMax));

  const kws = await generateKeywords(gmbTitle, serviceStr, areasForAi, {
    targetCount: tc,
    manualDeep: true,
  });

  return {
    ok: true,
    keywords: kws.length ? kws : fallbackKws,
    keywordSource: kws.length ? 'generated_manual_intent' : 'snapshot_fallback',
    targetCount: tc,
    businessName: gmbTitle || String(match.gmbName || '').trim() || null,
    resolvedCountry: resolvedCountryOut,
  };
}

/**
 * Merge: drop clients no longer in pool; keep prior keywords when client still present; generate only for new or empty.
 * @param {string} [outputPath]
 * @param {{ forceKeywords?: boolean }} [opts] — forceKeywords or env SERVICES_KEYWORDS_FORCE_REGENERATE=true regenerates AI lists for every row (full rebuild).
 */
export async function buildAndWriteServicesKeywordsSnapshot(outputPath = DATA_PATH, opts = {}) {
  const prevRaw = await readServicesKeywordsPayload();
  const prevRows = Array.isArray(prevRaw?.rows) ? prevRaw.rows : [];
  const prevByClient = new Map(
    prevRows
      .filter((r) => String(r?.clientId || '').trim())
      .map((r) => [String(r.clientId).trim(), r]),
  );

  const paying = await fetchPayingClients();
  const withLinks = await pool(paying, CONCURRENCY, async (c) => {
    const clientId = String(c?.id || '').trim();
    if (!clientId) return null;
    const link = await fetchClientGmbLink(clientId);
    if (!link) return null;
    if (requireActiveGmbStatus() && !isActiveGmbStatus(link?.gmb_status)) return null;
    const accountId = String(link?.accountId || '').trim();
    const locationIdShort = toShortLocationId(
      String(link?.locationIdShort || link?.listingSnapshot?.locationIdShort || link?.listingSnapshot?.gmbLocationId || ''),
    );
    if (!accountId || !locationIdShort) return null;
    return {
      clientId,
      business_name: String(c?.business_name || '').trim(),
      region: String(c?.region || '').trim(),
      niche: String(c?.niche || '').trim(),
      accountId,
      locationIdShort,
      link,
    };
  });

  const eligible = withLinks.filter(Boolean);

  const nextRows = await pool(eligible, CONCURRENCY, async (entry) => {
    const { clientId, business_name, region, niche, accountId, locationIdShort, link } = entry;
    let detail = null;
    let errMsg = null;
    try {
      detail = await getLocationFull(accountId, locationIdShort);
    } catch (e) {
      errMsg = String(e?.message || e);
    }

    const prev = prevByClient.get(clientId);
    const prevKws = Array.isArray(prev?.keywords) ? prev.keywords.map((k) => String(k).trim()).filter(Boolean) : [];
    const prevSnap =
      prev?.gbpDetailSnapshot && typeof prev.gbpDetailSnapshot === 'object' ? prev.gbpDetailSnapshot : null;

    const gmbTitle = String(
      detail?.title || prevSnap?.title || link?.listingSnapshot?.title || business_name || '',
    ).trim();
    const primaryCategory = getCategory(detail) || getCategory(prevSnap) || String(niche || '');
    const gbpServices = detail ? extractGbpServiceLabels(detail) : [];
    const explicitAreas = detail ? getExplicitServiceAreas(detail) : [];
    const { areas: areasForAi, source: serviceAreasSource } = detail
      ? getAreasForKeywords(detail)
      : { areas: [], source: 'none' };
    const serviceAreasFallbackLine =
      serviceAreasSource === 'gbp_storefront_address' && areasForAi.length ? areasForAi[0] : null;
    const inferredCountryRaw = await inferCountryFromLocations(areasForAi.length ? areasForAi : explicitAreas);
    const resolvedCountry = String(inferredCountryRaw || prev?.resolvedCountry || '').trim() || null;

    let keywords = [];
    let keywordGenerationReason = null;

    const forceKeywords =
      Boolean(opts.forceKeywords) ||
      String(process.env.SERVICES_KEYWORDS_FORCE_REGENERATE || '').toLowerCase() === 'true';

    if (!forceKeywords && prevKws.length > 0) {
      keywords = prevKws;
    } else if (!detail) {
      keywordGenerationReason = errMsg ? `GBP profile fetch failed: ${errMsg}` : 'GBP profile fetch failed.';
    } else if (!areasForAi.length) {
      keywordGenerationReason =
        'Keywords were not generated because GBP returned no service areas and no storefront address locality.';
    } else {
      const serviceStr = buildServiceContextString(primaryCategory, gbpServices);
      if (!serviceStr.trim()) {
        keywordGenerationReason =
          'Keywords were not generated because GBP primary category and service list were both empty.';
      } else {
        const rowMin = Number(process.env.SERVICES_KEYWORDS_PER_ROW_MIN || 4);
        const rowMax = Number(process.env.SERVICES_KEYWORDS_PER_ROW_MAX || 8);
        const tc = randomIntInclusive(Math.min(rowMin, rowMax), Math.max(rowMin, rowMax));
        keywords = (await generateKeywords(gmbTitle, serviceStr, areasForAi, { targetCount: tc })).slice(0, tc);
        if (!keywords.length) {
          keywordGenerationReason =
            'Keywords were not generated because AI returned an empty result for the GBP category/services/areas.';
        }
      }
    }

    const slimDetail = detail
      ? {
        title: detail.title,
        categories: detail.categories,
        serviceArea: detail.serviceArea,
        serviceItems: detail.serviceItems,
        storefrontAddress: detail.storefrontAddress,
      }
      : prevSnap || {
        title: gmbTitle,
        categories: primaryCategory
          ? { primaryCategory: { displayName: primaryCategory } }
          : undefined,
        serviceArea: undefined,
        serviceItems: [],
        storefrontAddress: undefined,
      };

    const gbpServicesOut = detail
      ? gbpServices
      : Array.isArray(prev?.gbpServices) && prev.gbpServices.length
        ? prev.gbpServices
        : gbpServices;
    const explicitAreasOut = detail
      ? explicitAreas
      : Array.isArray(prev?.serviceAreasExplicit) && prev.serviceAreasExplicit.length
        ? prev.serviceAreasExplicit
        : explicitAreas;
    const serviceAreasSourceOut = detail ? serviceAreasSource : prev?.serviceAreasSource || serviceAreasSource;
    const serviceAreasFallbackOut = detail
      ? serviceAreasFallbackLine
      : prev?.serviceAreasFallback || serviceAreasFallbackLine;

    return {
      clientId,
      gmbName: gmbTitle,
      business_name,
      region,
      accountId,
      locationId: locationIdShort,
      locationIdShort,
      pipeline_stage: 'paying',
      primaryCategory: primaryCategory || null,
      gbpServices: gbpServicesOut,
      serviceAreasExplicit: explicitAreasOut,
      serviceAreasFallback: serviceAreasFallbackOut,
      serviceAreasSource: serviceAreasSourceOut,
      resolvedCountry: resolvedCountry || null,
      keywords,
      keywordsWithCountry: keywords.map((k) => ({
        keyword: String(k || '').trim(),
        country: resolvedCountry || null,
      })),
      keywordsCount: keywords.length,
      keywordGenerationReason,
      gbpDetailSnapshot: slimDetail,
      updatedAt: new Date().toISOString(),
    };
  });

  nextRows.sort((a, b) => String(a.gmbName || '').localeCompare(String(b.gmbName || ''), undefined, { sensitivity: 'base' }));

  const withK = nextRows.filter((r) => Number(r.keywordsCount || 0) > 0);
  const keywordsTotalSum = nextRows.reduce((s, r) => s + Number(r.keywordsCount || 0), 0);
  const payingClientsTotal = paying.length;
  const gmbLinkedCount = nextRows.length;
  const crmRegions = parseCrmSnapshotRegions();
  const payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    region: crmSnapshotRegionsLabel(crmRegions),
    crmRegions,
    summary: {
      /** All **paying** clients from CRM API (`pipeline_stage === paying`) — denominator for dashboards (e.g. 266). */
      totalEligible: payingClientsTotal,
      /** Rows in this file: paying clients with usable CRM GMB link + GBP fetched (subset of paying). */
      gmbLinkedCount,
      payingWithoutGmbLink: Math.max(0, payingClientsTotal - gmbLinkedCount),
      withKeywords: withK.length,
      withoutKeywords: gmbLinkedCount - withK.length,
      keywordsTotalSum,
    },
    rows: nextRows,
  };

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8');

  const diff = computeServicesKeywordsDiff(prevRows, nextRows);

  return { outputPath, summary: payload.summary, payload, diff };
}

export async function readServicesKeywordsPayload() {
  const fp = String(process.env.SERVICES_KEYWORDS_JSON_PATH || '').trim() || DATA_PATH;
  try {
    const raw = await fsp.readFile(fp, 'utf8');
    const j = JSON.parse(raw);
    return {
      ok: true,
      sourcePath: fp,
      generatedAt: j?.generatedAt ?? null,
      region: j?.region ?? null,
      summary: j?.summary ?? null,
      rows: Array.isArray(j?.rows) ? j.rows : [],
    };
  } catch {
    return {
      ok: true,
      sourcePath: null,
      generatedAt: null,
      region: null,
      summary: null,
      rows: [],
    };
  }
}

/** Map snapshot rows → same shape `GmbKeywordDashboard` / `GmbAutomationRunPage` expect for locations. */
export function locationsFromServicesKeywords(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .filter((r) => String(r?.accountId || '').trim() && String(r?.locationIdShort || r?.locationId || '').trim())
    .map((r) => ({
      accountId: String(r.accountId),
      locationId: String(r.locationIdShort || r.locationId || '').trim(),
      locationIdShort: String(r.locationIdShort || r.locationId || '').trim(),
      title: String(r.gmbName || r.business_name || '').trim() || 'Untitled',
      business_name: String(r.business_name || '').trim(),
      clientId: String(r.clientId || '').trim(),
      niche: String(r.primaryCategory || '').trim(),
      keywords: Array.isArray(r.keywords) ? r.keywords : [],
      keywordsCount: Number(r.keywordsCount || 0),
      serviceAreasSource: r.serviceAreasSource,
      serviceAreasExplicit: Array.isArray(r.serviceAreasExplicit) ? r.serviceAreasExplicit : [],
      serviceAreasFallback: r.serviceAreasFallback || null,
      gbpServices: Array.isArray(r.gbpServices) ? r.gbpServices : [],
      gbpDetailSnapshot: r.gbpDetailSnapshot || null,
      source: 'services_keywords',
    }))
    .filter((loc) => Number(loc.keywordsCount || 0) >= 1);
}

/**
 * Same slot as the legacy `gmb_keyword_counts` nightly align (default **21:00 UTC** → ~02:30 IST).
 * Override with SERVICES_KEYWORDS_CRON_UTC_* or reuse KEYWORDS_ALIGN_CRON_UTC_*.
 */
function msUntilNextServicesKeywordsCronUtc() {
  const utcH = Number(
    process.env.SERVICES_KEYWORDS_CRON_UTC_HOUR ?? process.env.KEYWORDS_ALIGN_CRON_UTC_HOUR ?? 21,
  );
  const utcM = Number(
    process.env.SERVICES_KEYWORDS_CRON_UTC_MINUTE ?? process.env.KEYWORDS_ALIGN_CRON_UTC_MINUTE ?? 0,
  );
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcH, utcM, 0, 0));
  if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return Math.max(60_000, target.getTime() - now.getTime());
}

export async function runServicesKeywordsRebuildJob(options = {}) {
  const outputPath = String(process.env.SERVICES_KEYWORDS_JSON_PATH || '').trim() || DATA_PATH;
  appendLog({ phase: 'started', ok: true, outputPath, forceKeywords: Boolean(options.forceKeywords) });
  try {
    const out = await buildAndWriteServicesKeywordsSnapshot(outputPath, {
      forceKeywords: Boolean(options.forceKeywords),
    });
    const jsonWritten = fs.existsSync(outputPath);
    const diff = out?.diff || null;
    if (diff) {
      appendDailyTrackLine({
        ts: new Date().toISOString(),
        phase: 'after_rebuild',
        outputPath,
        newPayingClients: diff.newPayingClients || [],
        firstTimeKeywordSnapshots: (diff.firstTimeKeywordRows || []).map((r) => ({
          clientId: String(r?.clientId || '').trim(),
          gmbName: String(r?.gmbName || r?.business_name || '').trim(),
          accountId: String(r?.accountId || '').trim(),
          locationId: String(r?.locationIdShort || r?.locationId || '').trim(),
          keywordsCount: Number(r?.keywordsCount || 0),
        })),
        removedClientIds: diff.removedClientIds || [],
      });
    }

    appendLog({
      phase: 'completed',
      ok: true,
      outputPath,
      jsonWritten,
      summary: out?.summary || null,
      diffSummary: diff
        ? {
          newPayingClientsCount: diff.newPayingClients?.length || 0,
          firstTimeKeywordsCount: diff.firstTimeKeywordRows?.length || 0,
          removedClientIdsCount: diff.removedClientIds?.length || 0,
        }
        : null,
    });
    console.log('[ServicesKeywords] completed — JSON at', outputPath, out?.summary || {});

    const autoOnboard =
      String(process.env.SERVICES_KEYWORDS_AUTO_ONBOARD_AUTOMATION ?? 'true').toLowerCase() !== 'false';
    if (autoOnboard && diff?.firstTimeKeywordRows?.length) {
      try {
        const mod = await import('./servicesKeywordsBackgroundOnboarding.service.js');
        await mod.enqueueBackgroundOnboardingForKeywordRows(diff.firstTimeKeywordRows);
      } catch (e) {
        console.warn('[ServicesKeywords] background onboarding failed:', e?.message || e);
      }
    }

    const result = {
      ok: true,
      outputPath,
      jsonWritten,
      summary: out?.summary || null,
      diff: diff || null,
    };
    if (jsonWritten) {
      try {
        const { scheduleGmbReviewMonthlyAfterKeywords } = await import('./gmbReviewMonthly.service.js');
        scheduleGmbReviewMonthlyAfterKeywords('services-keywords');
      } catch (e) {
        console.warn('[ServicesKeywords] gmb-review-monthly schedule failed:', e?.message || e);
      }
    }
    return result;
  } catch (e) {
    const msg = String(e?.message || e);
    appendLog({ phase: 'error', ok: false, outputPath, error: msg });
    console.error('[ServicesKeywords] failed:', msg);
    return { ok: false, outputPath, jsonWritten: false, error: msg };
  }
}

/**
 * Full regenerate mode (same behavior as scripts/regenerate-services-keywords-full.mjs):
 * force keyword regeneration for every eligible row.
 */
export async function runServicesKeywordsFullRegenerateJob() {
  return runServicesKeywordsRebuildJob({ forceKeywords: true });
}

async function shouldUseFullRegenerateForCron() {
  const mode = String(process.env.SERVICES_KEYWORDS_CRON_MODE || 'full_once_then_incremental')
    .trim()
    .toLowerCase();
  if (mode === 'full_always') return true;
  if (mode === 'incremental_only') return false;

  // default: full once (if snapshot missing/empty), then incremental on later cron runs.
  const current = await readServicesKeywordsPayload();
  const rows = Array.isArray(current?.rows) ? current.rows : [];
  return rows.length === 0;
}

async function runServicesKeywordsCronJob() {
  const runFull = await shouldUseFullRegenerateForCron();
  if (runFull) {
    console.log('[ServicesKeywords] cron mode = full regenerate (forceKeywords=true)');
    return runServicesKeywordsFullRegenerateJob();
  }
  console.log('[ServicesKeywords] cron mode = incremental (new/empty rows only)');
  return runServicesKeywordsRebuildJob();
}

let _timer = null;
export function initServicesKeywordsCron() {
  const enabled =
    String(
      process.env.ENABLE_SERVICES_KEYWORDS_CRON ?? process.env.ENABLE_KEYWORDS_ALIGN_CRON ?? 'true',
    ).toLowerCase() !== 'false';
  if (!enabled) {
    console.log('[ServicesKeywords] disabled (ENABLE_SERVICES_KEYWORDS_CRON=false)');
    return;
  }

  const scheduleNext = () => {
    const delay = msUntilNextServicesKeywordsCronUtc();
    const next = new Date(Date.now() + delay);
    const h = Number(process.env.SERVICES_KEYWORDS_CRON_UTC_HOUR ?? process.env.KEYWORDS_ALIGN_CRON_UTC_HOUR ?? 21);
    const m = String(
      Number(process.env.SERVICES_KEYWORDS_CRON_UTC_MINUTE ?? process.env.KEYWORDS_ALIGN_CRON_UTC_MINUTE ?? 0),
    ).padStart(2, '0');
    console.log(`[ServicesKeywords] next paying+GBP keywords rebuild at ${next.toISOString()} (UTC ${h}:${m}; legacy keyword-align slot)`);
    _timer = setTimeout(async () => {
      _timer = null;
      await runServicesKeywordsCronJob();
      scheduleNext();
    }, delay);
  };

  if (String(process.env.SERVICES_KEYWORDS_RUN_ON_STARTUP ?? 'false').toLowerCase() === 'true') {
    void runServicesKeywordsCronJob();
  }
  scheduleNext();
}
