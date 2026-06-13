import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { readLocationsSnapshot } from './gmb.service.js';
import { crmSnapshotRegionsLabel, parseCrmSnapshotRegions } from './crmSnapshotRegions.service.js';
import {
  assertFormflowCrmApiKey,
  buildFormflowCrmRequestHeaders,
  formatCrmHttpAuthError,
  getFormflowCrmApiBaseUrl,
} from '../utils/formflowCrmEnv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../../');
const ACTIVE_GMB_JSON_PATH = path.join(SERVER_ROOT, 'data', 'active-gmb.json');
const STATS_HISTORY_PATH = path.join(SERVER_ROOT, 'data', 'stats-history.json');
/** Ranking server copy (cron writes here first — same payload Client Hub expects). */
const SERVER_DATA_AUTO_CONNECTED_GMB_JSON = path.join(SERVER_ROOT, 'data', 'auto-connected-gmb.json');

const PAGE_SIZE = 1000;

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** CRM GMB filter “Active” — DB may store English key or localized label (es/pt). */
function isCrmActiveGmbStatus(gmbStatus) {
  const v = String(gmbStatus ?? '').trim().toLowerCase();
  return v === 'active' || v === 'activo' || v === 'ativo';
}

async function resolveAutoConnectedGmbPath() {
  const fromEnv = String(process.env.AUTO_CONNECTED_GMB_JSON_PATH || '').trim();
  if (fromEnv) return fromEnv;
  try {
    await fs.access(SERVER_DATA_AUTO_CONNECTED_GMB_JSON);
    return SERVER_DATA_AUTO_CONNECTED_GMB_JSON;
  } catch {
    return null;
  }
}

/**
 * Parsed auto-connected snapshot (same shape as `public/auto-connected-gmb.json` from rebuild script).
 * Used by GET /api/gmbautoconnect and optional callers.
 */
export async function readAutoConnectedGmbSnapshotPayload() {
  const fp = await resolveAutoConnectedGmbPath();
  if (!fp) {
    return {
      ok: true,
      sourcePath: null,
      generatedAt: null,
      auto_connected_gmb_name: [],
      manual_connect_gmb_name: [],
      alreadyLinked: [],
      noEligible: [],
      errors: [],
      summary: null,
    };
  }
  try {
    const raw = await fs.readFile(fp, 'utf8');
    const j = JSON.parse(raw);
    return {
      ok: true,
      sourcePath: fp,
      generatedAt: j?.generatedAt ?? null,
      summary: j?.summary ?? null,
      auto_connected_gmb_name: Array.isArray(j?.auto_connected_gmb_name) ? j.auto_connected_gmb_name : [],
      manual_connect_gmb_name: Array.isArray(j?.manual_connect_gmb_name) ? j.manual_connect_gmb_name : [],
      alreadyLinked: Array.isArray(j?.alreadyLinked) ? j.alreadyLinked : [],
      noEligible: Array.isArray(j?.noEligible) ? j.noEligible : [],
      errors: Array.isArray(j?.errors) ? j.errors : [],
    };
  } catch (e) {
    console.warn('[SupabaseGMB] readAutoConnectedGmbSnapshotPayload failed:', e?.message || e);
    return {
      ok: false,
      sourcePath: fp,
      error: String(e?.message || e),
      auto_connected_gmb_name: [],
      manual_connect_gmb_name: [],
      alreadyLinked: [],
      noEligible: [],
      errors: [],
      summary: null,
    };
  }
}

/**
 * Same hydration as Client Hub `ClientCRM.loadAutoConnectionSnapshot`:
 * - `auto_connected_gmb_name` + `alreadyLinked` → CRM “auto-connection” client IDs (GBP linked).
 * - `manual_connect_gmb_name` → first dropdown listing name only (for Google title match; not auto badge).
 */
async function loadAutoConnectedSnapshot(filePath) {
  if (!filePath) return { linkedIds: new Set(), gmbNameByClientId: new Map(), summary: null, path: null };
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const j = JSON.parse(raw);
    const rows = Array.isArray(j?.auto_connected_gmb_name) ? j.auto_connected_gmb_name : [];
    const linkedRows = Array.isArray(j?.alreadyLinked) ? j.alreadyLinked : [];
    const manualRows = Array.isArray(j?.manual_connect_gmb_name) ? j.manual_connect_gmb_name : [];

    const linkedIds = new Set();
    const gmbNameByClientId = new Map();

    const addLinked = (r) => {
      const id = String(r?.clientId || '').trim();
      if (!id) return;
      linkedIds.add(id);
      const gn = String(r?.gmb_name || '').trim();
      if (gn && !gmbNameByClientId.has(id)) gmbNameByClientId.set(id, gn);
    };
    for (const r of rows) addLinked(r);
    for (const r of linkedRows) addLinked(r);

    for (const r of manualRows) {
      const id = String(r?.clientId || '').trim();
      if (!id) continue;
      const topManual = Array.isArray(r?.manual_dropdown_top3_gmb_names)
        ? String(r.manual_dropdown_top3_gmb_names[0] || '').trim()
        : '';
      if (topManual && !gmbNameByClientId.has(id)) gmbNameByClientId.set(id, topManual);
    }

    return { linkedIds, gmbNameByClientId, summary: j?.summary ?? null, path: filePath };
  } catch (e) {
    console.warn('[SupabaseGMB] auto-connected-gmb.json read failed:', e?.message || e);
    return { linkedIds: new Set(), gmbNameByClientId: new Map(), summary: null, path: filePath };
  }
}

/**
 * Same list as Client Hub `fetchClients(region)` — Mongo CRM via clickupbackend
 * (`GET /api/formflow/crm/clients?region=…`). Matches Paying + Active counts (not Supabase RLS).
 */
async function fetchClientsFromFormflowCrm(region) {
  const fromEnv = String(process.env.FORMFLOW_CRM_API_BASE || '').trim().replace(/\/$/, '');
  const rawBase =
    fromEnv ||
    String(process.env.VITE_FORMFLOW_CRM_API_BASE || '').trim().replace(/\/$/, '') ||
    'https://click.acquisition-central.com';
  const key =
    String(process.env.FORMFLOW_CRM_API_KEY || '').trim() ||
    String(process.env.VITE_FORMFLOW_CRM_API_KEY || '').trim();
  const url = `${rawBase}/api/formflow/crm/clients?region=${encodeURIComponent(region)}`;
  const headers = { Accept: 'application/json' };
  if (key) headers['x-formflow-crm-key'] = key;
  const res = await axios.get(url, { headers, timeout: 120_000, validateStatus: () => true });
  if (res.status >= 400) {
    const errMsg = res.data?.error || res.data?.message || res.statusText;
    throw new Error(`CRM clients HTTP ${res.status}: ${String(errMsg).slice(0, 200)}`);
  }
  const data = res.data?.data;
  if (!Array.isArray(data)) throw new Error('CRM clients: expected { ok, data: Client[] }');
  return data
    .map((row) => {
      const id = String(row?.id ?? row?._id ?? '').trim();
      return { ...row, id };
    })
    .filter((r) => r.id);
}

function useCombinedCrmClientPool() {
  return String(process.env.SUPABASE_SYNC_COMBINED_REGIONS ?? 'true').toLowerCase() !== 'false';
}

function mergeClientsById(rows) {
  const byId = new Map();
  for (const c of rows) {
    const id = String(c?.id ?? c?._id ?? '').trim();
    if (id && !byId.has(id)) byId.set(id, { ...c, id });
  }
  return [...byId.values()];
}

function applyPayingAndActiveFilters(rawClients, payingOnly, requireActive) {
  let out = rawClients;
  if (payingOnly) {
    out = out.filter((c) => String(c?.pipeline_stage || '') === 'paying');
  }
  if (payingOnly && requireActive) {
    const before = out.length;
    out = out.filter((c) => isCrmActiveGmbStatus(c?.gmb_status));
    console.log(`[SupabaseGMB] CRM Active GMB filter (active|activo|ativo): ${out.length} of ${before}`);
  }
  return out;
}

/**
 * Paying (+ optional Active) CRM clients for dashboard `active-gmb.json`.
 * When `SUPABASE_SYNC_COMBINED_REGIONS` is true (default), merges es+us+br like other snapshot builders.
 */
async function fetchSyncRawClients() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  const payingOnly = String(process.env.SUPABASE_SYNC_PAYING_PIPELINE_ONLY ?? 'true').toLowerCase() !== 'false';
  const requireActive = String(process.env.SUPABASE_SYNC_REQUIRE_GMB_ACTIVE ?? 'false').toLowerCase() === 'true';
  const combined = useCombinedCrmClientPool();
  const regions = combined
    ? parseCrmSnapshotRegions()
    : [String(process.env.SUPABASE_SYNC_REGION || '').trim().toLowerCase()].filter((r) =>
        ['us', 'es', 'br'].includes(r),
      );
  const syncRegionLabel = combined ? crmSnapshotRegionsLabel(regions) : regions[0] || '';
  const useFormflowCrm = String(process.env.USE_FORMFLOW_CRM_CLIENTS ?? 'false').toLowerCase() === 'true';

  let rawClients = [];
  let clientsSource = 'supabase';

  if (useFormflowCrm && regions.length) {
    try {
      console.log(
        `[SupabaseGMB] Fetching clients from Formflow CRM API (regions=${syncRegionLabel || regions.join(',')})…`,
      );
      const chunks = [];
      for (const reg of regions) {
        chunks.push(...(await fetchClientsFromFormflowCrm(reg)));
      }
      rawClients = mergeClientsById(chunks);
      clientsSource = 'formflow_crm';
      rawClients = applyPayingAndActiveFilters(rawClients, payingOnly, requireActive);
    } catch (e) {
      console.warn('[SupabaseGMB] Formflow CRM fetch failed, falling back to Supabase:', e?.message || e);
      clientsSource = 'supabase_fallback';
    }
  }

  if (!useFormflowCrm || !regions.length || clientsSource === 'supabase_fallback') {
    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        'Supabase URL/Key missing and Formflow CRM fetch failed. Set SUPABASE_* or fix USE_FORMFLOW_CRM_CLIENTS + FORMFLOW_CRM_API_BASE + FORMFLOW_CRM_API_KEY.',
      );
    }
    const baseParams = { select: '*' };
    if (payingOnly) {
      baseParams.pipeline_stage = 'eq.paying';
    } else {
      baseParams.gmb_status = 'eq.Active';
    }
    console.log('[SupabaseGMB] Fetching clients from Supabase…');
    if (combined && regions.length > 1) {
      const chunks = [];
      for (const reg of regions) {
        const params = { ...baseParams, region: `eq.${reg}` };
        chunks.push(...(await fetchClientsAllPages(supabaseUrl, supabaseKey, params)));
      }
      rawClients = mergeClientsById(chunks);
    } else {
      const params = { ...baseParams };
      const syncRegion = regions[0] || String(process.env.SUPABASE_SYNC_REGION || '').trim().toLowerCase();
      if (syncRegion && ['us', 'es', 'br'].includes(syncRegion)) {
        params.region = `eq.${syncRegion}`;
      }
      rawClients = await fetchClientsAllPages(supabaseUrl, supabaseKey, params);
    }
    clientsSource = 'supabase';
    rawClients = applyPayingAndActiveFilters(rawClients, payingOnly, requireActive);
  }

  const filterDesc =
    clientsSource === 'formflow_crm'
      ? `formflow_crm:${syncRegionLabel || regions.join(',')}${payingOnly ? '+paying' : ''}${requireActive ? '+gmb~Active' : ''}`
      : payingOnly
        ? `supabase:paying${syncRegionLabel ? `+regions=${syncRegionLabel}` : ''}${requireActive ? '+gmb_status~Active' : ''}`
        : 'supabase:gmb_status=Active';

  return { rawClients, clientsSource, filterDesc, crmRegions: regions, syncRegionLabel };
}

async function fetchClientsAllPages(supabaseUrl, supabaseKey, params) {
  const headersBase = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    Prefer: 'count=exact',
  };
  const out = [];
  let offset = 0;
  for (;;) {
    const range = `${offset}-${offset + PAGE_SIZE - 1}`;
    const res = await axios.get(`${supabaseUrl}/rest/v1/clients`, {
      params,
      headers: { ...headersBase, Range: range },
    });
    const chunk = Array.isArray(res.data) ? res.data : [];
    out.push(...chunk);
    if (chunk.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return out;
}

/**
 * Fetches active GMBs from Supabase and saves them to a JSON file.
 * Categorizes them by GBP Access and Niche availability.
 */
export async function syncActiveGmbFromSupabase() {
  const { rawClients, clientsSource, filterDesc, crmRegions, syncRegionLabel } = await fetchSyncRawClients();
  console.log(`[SupabaseGMB] Source=${clientsSource} → ${rawClients.length} client(s) (${filterDesc}).`);

  const autoPath = await resolveAutoConnectedGmbPath();
  const { linkedIds: autoConnectedClientIds, gmbNameByClientId, summary: crmSnapshotSummary } =
    await loadAutoConnectedSnapshot(autoPath);
  if (autoPath) {
    console.log(
      `[SupabaseGMB] CRM snapshot linked clientIds (auto + alreadyLinked): ${autoConnectedClientIds.size} — ${path.basename(autoPath)}` +
        (crmSnapshotSummary?.totalPaying != null ? ` (CRM totalPaying: ${crmSnapshotSummary.totalPaying})` : '')
    );
  }

  // Load connected GMBs to check for access
  const { businesses: connected } = await readLocationsSnapshot();
  const connectedExact = new Set(
    connected.map((b) => String(b?.title || '').toLowerCase().trim()).filter(Boolean)
  );
  const connectedNormalized = new Set(
    connected.map((b) => normalizeName(b?.title || '')).filter(Boolean)
  );

  const clients = rawClients.map((c) => {
    const businessName = String(c.business_name || '').trim();
    const niche = String(c.niche || '').trim();
    const idStr = String(c.id ?? c._id ?? '').trim();
    
    const hasNiche = niche.length > 0;
    const gmbAlias = idStr ? gmbNameByClientId.get(idStr) : '';
    const aliasMatch =
      gmbAlias &&
      (connectedExact.has(gmbAlias.toLowerCase()) ||
        connectedNormalized.has(normalizeName(gmbAlias)));
    const hasGbp =
      (idStr && autoConnectedClientIds.has(idStr)) ||
      !!aliasMatch ||
      connectedExact.has(businessName.toLowerCase()) ||
      connectedNormalized.has(normalizeName(businessName));

    const gmb_display_name = String((idStr && gmbNameByClientId.get(idStr)) || businessName || '').trim();
    
    let access_score = 0;
    if (!hasNiche && !hasGbp) access_score = 2;
    else if (!hasNiche || !hasGbp) access_score = 1;

    return {
      id: idStr,
      business_name: businessName,
      gmb_display_name,
      niche: hasNiche ? niche : null,
      service_delivery_stage: c.service_delivery_stage,
      owner_name: c.owner_name,
      region: c.region,
      phone: c.phone,
      email: c.email,
      website: c.website,
      legal_address: c.legal_address,
      gmb_status: c.gmb_status,
      created_at: c.created_at,
      has_gbp_access: hasGbp,
      access_score: access_score
    };
  });

  // Categorize by GBP access.
  // NOTE: count now intentionally means "GBP access confirmed" list.
  const gbp_access_list = clients.filter(c => c.has_gbp_access === true);
  const no_access_list = clients.filter(c => c.has_gbp_access === false);

  // Manage Stats and Weekly logic
  const stats = await readStatsHistory();
  const now = new Date();
  
  const lastReset = new Date(stats.lastWeeklyReset || 0);
  
  // Calculate this week's Monday 2 AM baseline
  const thisMonday2AM = new Date(now);
  thisMonday2AM.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // Back to Monday
  thisMonday2AM.setHours(2, 0, 0, 0);

  const isNewWeek = now >= thisMonday2AM && lastReset < thisMonday2AM;

  if (isNewWeek) {
    stats.lastWeekCount = stats.currentWeekNewCount || 0;
    stats.currentWeekNewCount = 0;
    stats.lastWeeklyReset = now.toISOString();
  }

  const prevData = await readActiveGmbJson();
  // Support migration: check active_gmb, clients, or gbp_access/no_access
  const prevClients = Array.isArray(prevData?.active_gmb) 
    ? prevData.active_gmb 
    : Array.isArray(prevData?.clients)
      ? prevData.clients
      : [...(prevData?.gbp_access || []), ...(prevData?.no_access || [])];
  const prevIds = new Set(prevClients.map(c => c.id));
  const newlyAddedClients = clients.filter(c => !prevIds.has(c.id));
  const newCount = newlyAddedClients.length;
  const newGbpAccessClients = newlyAddedClients.filter((c) => c.has_gbp_access === true);
  
  stats.currentWeekNewCount = (stats.currentWeekNewCount || 0) + newCount;
  stats.totalActive = clients.length;
  stats.lastUpdatedAt = now.toISOString();

  // Merge keyword rows from paying+GBP `services-keywords.json` (CRM id + counts).
  let keywordData = { rows: [] };
  try {
    const skPath = path.join(SERVER_ROOT, 'data', 'services-keywords.json');
    const skRaw = await fs.readFile(skPath, 'utf8');
    const sk = JSON.parse(skRaw);
    keywordData.rows = Array.isArray(sk?.rows) ? sk.rows : [];
  } catch (err) {
    console.warn('[SupabaseGMB] Could not load services-keywords.json for merging:', err.message);
  }

  const kwMap = new Map();
  for (const row of keywordData.rows) {
    const cid = String(row?.clientId || '').trim();
    if (!cid) continue;
    kwMap.set(cid, {
      keywordsCount: Number(row.keywordsCount || 0),
      keywords: Array.isArray(row.keywords) ? row.keywords : [],
      keywordGenerationReason: row.keywordGenerationReason,
    });
  }

  // Categories for the new structure
  const active_gmb = clients; // All 255
  const no_gbp_acess_niche_null = no_access_list;
  const ready_list = clients.filter(c => c.access_score === 0).map(c => {
    const kwInfo = kwMap.get(c.id) || {};
    return {
      ...c,
      keywordsCount: kwInfo.keywordsCount || 0,
      keywords: kwInfo.keywords || []
    };
  });
  const gbp_access_count_list = gbp_access_list.map(c => {
    const kwInfo = kwMap.get(c.id) || {};
    return {
      ...c,
      keywordsCount: kwInfo.keywordsCount || 0,
      keywords: kwInfo.keywords || []
    };
  });
  const keywordPendingForGbp = gbp_access_count_list
    .filter((c) => Number(c?.keywordsCount || 0) <= 0)
    .map((c) => ({
      id: c.id,
      business_name: c.business_name,
      reason:
        String(kwMap.get(c.id)?.keywordGenerationReason || '').trim() ||
        'Keywords were not generated because usable category/service-area signals were not stable at generation time (or AI returned an empty result).',
    }));

  const uniqueSortedNames = (rows) => {
    const out = new Set();
    for (const c of rows) {
      const n = String(c?.gmb_display_name || c?.business_name || '').trim();
      if (n) out.add(n);
    }
    return [...out].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  };
  const gbp_access_names = uniqueSortedNames(gbp_access_list);
  const not_access_names = uniqueSortedNames(no_access_list);

  /** Written to disk: human-first name lists + fields required by API/automation. */
  const filePayload = {
    generatedAt: now.toISOString(),
    /** `formflow_crm` = same Mongo list as Client Hub; `supabase` = direct PostgREST (can differ under RLS). */
    clients_source: clientsSource,
    crmRegions: Array.isArray(crmRegions) ? crmRegions : [],
    region: syncRegionLabel || null,
    gbp_access: gbp_access_names,
    not_access: not_access_names,
    total: clients.length,
    active_count: clients.length,
    ready_count: ready_list.length,
    gbp_access_count: gbp_access_count_list.length,
    no_access_count: no_gbp_acess_niche_null.length,
    active_gmb,
    no_gbp_acess_niche_null,
    count: gbp_access_count_list,
    ready_list,
  };

  await fs.mkdir(path.dirname(ACTIVE_GMB_JSON_PATH), { recursive: true });
  await fs.writeFile(ACTIVE_GMB_JSON_PATH, JSON.stringify(filePayload, null, 2), 'utf8');
  await saveStatsHistory(stats);

  /** Return includes fields used by in-process callers (not persisted to active-gmb.json). */
  return {
    ...filePayload,
    new_gbp_access_count: newGbpAccessClients.length,
    new_gbp_access_ids: newGbpAccessClients.map((c) => c.id),
    keyword_generation_summary: {
      gbp_access_total: gbp_access_count_list.length,
      with_keywords_count: gbp_access_count_list.length - keywordPendingForGbp.length,
      pending_keywords_count: keywordPendingForGbp.length,
    },
    keyword_generation_pending: keywordPendingForGbp,
  };
}

async function readStatsHistory() {
  try {
    const raw = await fs.readFile(STATS_HISTORY_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      currentWeekNewCount: 0,
      lastWeekCount: 0,
      totalActive: 0,
      lastWeeklyReset: new Date().toISOString(),
      lastUpdatedAt: null
    };
  }
}

async function saveStatsHistory(stats) {
  await fs.mkdir(path.dirname(STATS_HISTORY_PATH), { recursive: true });
  await fs.writeFile(STATS_HISTORY_PATH, JSON.stringify(stats, null, 2), 'utf8');
}

/**
 * Reads the active GMBs from the local JSON file.
 */
export async function readActiveGmbJson() {
  try {
    const raw = await fs.readFile(ACTIVE_GMB_JSON_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}
