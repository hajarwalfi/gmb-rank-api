import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { parseCrmSnapshotRegions } from './crmSnapshotRegions.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_OUTPUT = path.join(SERVER_ROOT, 'data', 'auto-connected-gmb.json');
const CONCURRENCY = Number(process.env.AUTOCONNECT_BUILD_CONCURRENCY || 6);

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

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['`’]/g, "'")
    .replace(/\b([a-z0-9]+)'s\b/g, '$1')
    .replace(/&/g, ' and ')
    .replace(/\b(llc|inc|corp|corporation|co|company|ltd|services?)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const la = a.length;
  const lb = b.length;
  const dp = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i += 1) dp[i][0] = i;
  for (let j = 0; j <= lb; j += 1) dp[0][j] = j;
  for (let i = 1; i <= la; i += 1) {
    for (let j = 1; j <= lb; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[la][lb];
}

function isOneEditAway(a, b) {
  if (!a || !b || a === b) return false;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (la > lb) i += 1;
    else if (lb > la) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  if (i < la || j < lb) edits += 1;
  return edits === 1;
}

function isMinorTypoMatch(a, b) {
  if (!a || !b || a === b) return false;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 2) return false;
  const maxAllowed = Math.min(2, Math.max(1, Math.floor(Math.max(la, lb) / 4)));
  if (Math.min(la, lb) <= 3) return maxAllowed >= 1 && editDistance(a, b) <= 1;
  return editDistance(a, b) <= maxAllowed;
}

function scoreNameMatch(target, candidate) {
  const t = normalizeName(target);
  const c = normalizeName(candidate);
  if (!t || !c) return 0;
  if (t === c) return 1000;
  if (c.includes(t) || t.includes(c)) return 800;
  const tCompact = t.replace(/\s+/g, '');
  const cCompact = c.replace(/\s+/g, '');
  if (tCompact === cCompact) return 1000;
  const maxCompactLen = Math.max(tCompact.length, cCompact.length);
  if (maxCompactLen >= 7) {
    const compactDistance = editDistance(tCompact, cCompact);
    const compactSimilarity = 1 - compactDistance / maxCompactLen;
    if (compactSimilarity >= 0.86) return 800;
    if (compactSimilarity >= 0.78) return 700;
    if (compactSimilarity >= 0.72) return 650;
  }
  if (tCompact && cCompact && (tCompact.includes(cCompact) || cCompact.includes(tCompact))) {
    const extra = Math.abs(tCompact.length - cCompact.length);
    if (extra <= 3) return 800;
    if (extra <= 4) return 700;
  }
  const tArr = t.split(' ');
  const cArr = c.split(' ');
  const stem = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
  const tStemArr = tArr.map(stem);
  const cStemArr = cArr.map(stem);
  const tWords = new Set(tArr);
  const cWords = new Set(cArr);
  const tStemWords = new Set(tStemArr);
  const cStemWords = new Set(cStemArr);
  let overlap = 0;
  for (const w of tWords) {
    if (cWords.has(w)) {
      overlap += 1;
      continue;
    }
    if (cArr.some((cw) => isOneEditAway(w, cw) || isMinorTypoMatch(w, cw))) overlap += 1;
  }
  for (const w of tStemWords) {
    if (cStemWords.has(w)) overlap += 1;
  }
  const coverage = tStemArr.length > 0
    ? Array.from(tStemWords).filter((w) => cStemWords.has(w)).length / tStemArr.length
    : 0;
  if (coverage >= 0.8 && Math.max(tStemArr.length, cStemArr.length) >= 2) return Math.max(700, overlap + 3);
  const firstTokenBoost = tArr[0] && cArr[0] && tArr[0] === cArr[0] ? 2 : 0;
  return overlap + firstTokenBoost;
}

function pickBestCatalogMatchMulti(rows, labels, minStrongScore = 800, minGap = 1) {
  const clean = [...new Set(labels.map((l) => String(l || '').trim()).filter(Boolean))];
  if (!clean.length || !rows.length) return null;
  const bestPerNormalizedCandidate = new Map();
  for (const row of rows) {
    const candidate = String(row.title || row.name || '').trim();
    const normalizedCandidate = normalizeName(candidate);
    const score = Math.max(...clean.map((lbl) => scoreNameMatch(lbl, candidate)));
    const prev = bestPerNormalizedCandidate.get(normalizedCandidate);
    if (!prev || score > prev.score) bestPerNormalizedCandidate.set(normalizedCandidate, { row, score });
  }
  const scored = Array.from(bestPerNormalizedCandidate.values()).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const secondBestScore = scored[1]?.score ?? -1;
  if (!best) return null;
  if (best.score >= minStrongScore) return best;
  if (best.score < 2) return null;
  if (secondBestScore >= 0 && best.score - secondBestScore < minGap) return null;
  return best;
}

function resolveLocationIdShort(row) {
  if (!row) return '';
  const direct = String(row.locationIdShort || '').trim();
  if (direct) return direct.replace(/^locations\//i, '');
  const gmbId = String(row.gmbLocationId || '').trim();
  if (gmbId) return gmbId.replace(/^locations\//i, '');
  const name = String(row.name || '').trim();
  const m = name.match(/locations\/([^/]+)$/i);
  return m?.[1] || '';
}

async function crmGet(pathname) {
  const url = `${crmBaseUrl()}${pathname}`;
  const res = await axios.get(url, {
    headers: crmHeaders(),
    timeout: 35_000,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    throw new Error(`HTTP ${res.status}: ${String(res.data?.error || res.data?.message || '').slice(0, 300)}`);
  }
  return res.data || {};
}

async function crmPost(pathname, body) {
  const url = `${crmBaseUrl()}${pathname}`;
  const res = await axios.post(url, body, {
    headers: { ...crmHeaders(), 'Content-Type': 'application/json' },
    timeout: 35_000,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    throw new Error(`HTTP ${res.status}: ${String(res.data?.error || res.data?.message || '').slice(0, 300)}`);
  }
  return res.data || {};
}

async function connectGmbToClient(clientId, row, crmRegionCode) {
  const locationId = resolveLocationIdShort(row);
  if (!row?.accountId || !locationId) return null;
  const reg = String(crmRegionCode || 'es').trim().toLowerCase() || 'es';
  const j = await crmPost(`/api/formflow/crm-gmb/clients/${encodeURIComponent(clientId)}`, {
    region: reg,
    accountId: row.accountId,
    locationId,
    title: row.title || row.name || undefined,
    gmbLocationId: row.gmbLocationId || undefined,
  });
  return j?.link || null;
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
 * Build auto-connected snapshot payload for one CRM region (paying clients only).
 * @param {string} region
 */
async function buildAutoConnectedPayloadForRegion(region) {
  const reg = String(region || 'es').trim().toLowerCase() || 'es';
  const clientsRes = await crmGet(`/api/formflow/crm/clients?region=${encodeURIComponent(reg)}`);
  const paying = (Array.isArray(clientsRes?.data) ? clientsRes.data : []).filter((c) => c.pipeline_stage === 'paying');

  const buckets = {
    alreadyLinked: [],
    auto_connected_gmb_name: [],
    manual_connect_gmb_name: [],
    noEligible: [],
    errors: [],
  };
  const autoByClient = new Map();
  const manualByClient = new Map();
  const noEligibleByClient = new Map();
  const errorByClient = new Map();

  await pool(paying, CONCURRENCY, async (c) => {
    const clientBase = {
      clientId: c.id,
      region: reg,
      business_name: c.business_name || '',
      legal_business_name: c.legal_business_name || null,
      clientUrl: `${crmBaseUrl()}/crm/${reg}/client/${c.id}`,
    };
    try {
      const linkJ = await crmGet(`/api/formflow/crm-gmb/clients/${encodeURIComponent(c.id)}`);
      if (linkJ?.link) {
        buckets.alreadyLinked.push({ ...clientBase, gmb_name: linkJ.link?.listingSnapshot?.title || null });
        return;
      }
      const catJ = await crmGet(`/api/formflow/crm-gmb/locations-catalog?clientId=${encodeURIComponent(c.id)}`);
      const labels = [c.business_name || '', c.legal_business_name || ''].filter(Boolean);
      const catalog = Array.isArray(catJ?.locations) ? catJ.locations : [];
      const eligible = catalog.filter((r) => r.linkStatus !== 'linked_other_client');

      let best = pickBestCatalogMatchMulti(eligible, labels, 800, 1);
      if (!best && eligible.length === 0) best = pickBestCatalogMatchMulti(catalog, labels, 700, 1);

      if (best) {
        try {
          const linked = await connectGmbToClient(c.id, best.row, reg);
          autoByClient.set(c.id, {
            ...clientBase,
            gmb_name: linked?.listingSnapshot?.title || best.row.title || best.row.name || '',
            score: best.score,
          });
          return;
        } catch {
          // fallback to manual suggestions below
        }
      }

      const sourceForManual = eligible.length > 0 ? eligible : catalog;
      if (sourceForManual.length === 0) {
        noEligibleByClient.set(c.id, clientBase);
        return;
      }
      const top3 = sourceForManual
        .map((r) => {
          const listing = String(r.title || r.name || '');
          const score = Math.max(...labels.map((lbl) => scoreNameMatch(lbl, listing)), 0);
          return { listing, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      manualByClient.set(c.id, {
        ...clientBase,
        manual_dropdown_top3_gmb_names: top3.map((t) => t.listing),
        manual_dropdown_top3_with_score: top3,
      });
    } catch (e) {
      errorByClient.set(c.id, { ...clientBase, error: String(e?.message || e) });
    }
  });

  const noEligibleSecondPassCandidates = Array.from(noEligibleByClient.values());
  await pool(noEligibleSecondPassCandidates, CONCURRENCY, async (c) => {
    try {
      const labels = [c.business_name || '', c.legal_business_name || ''].filter(Boolean);
      const catJ = await crmGet(`/api/formflow/crm-gmb/locations-catalog?clientId=${encodeURIComponent(c.clientId)}`);
      const catalog = Array.isArray(catJ?.locations) ? catJ.locations : [];
      const best = pickBestCatalogMatchMulti(catalog, labels, 600, 10);
      if (!best) return;
      const linked = await connectGmbToClient(c.clientId, best.row, c.region || reg);
      autoByClient.set(c.clientId, {
        ...c,
        gmb_name: linked?.listingSnapshot?.title || best.row.title || best.row.name || '',
        score: best.score,
        source: 'noEligible_rescan',
      });
      noEligibleByClient.delete(c.clientId);
      manualByClient.delete(c.clientId);
    } catch (e) {
      errorByClient.set(c.clientId, { ...c, error: String(e?.message || e) });
      noEligibleByClient.delete(c.clientId);
    }
  });

  buckets.auto_connected_gmb_name = Array.from(autoByClient.values()).map(({ score, source, ...rest }) => rest);
  buckets.manual_connect_gmb_name = Array.from(manualByClient.values());
  buckets.noEligible = Array.from(noEligibleByClient.values());
  buckets.errors = Array.from(errorByClient.values());

  const totalPaying = paying.length;
  const sameNameCount = buckets.auto_connected_gmb_name.filter((x) => scoreNameMatch(x.business_name, x.gmb_name) >= 1000).length;
  const sameMatchCount = buckets.auto_connected_gmb_name.filter((x) => scoreNameMatch(x.business_name, x.gmb_name) >= 800).length;

  const summary = {
    totalPaying,
    alreadyLinkedCount: buckets.alreadyLinked.length,
    wouldAutoCount: buckets.auto_connected_gmb_name.length,
    manualCount: buckets.manual_connect_gmb_name.length,
    noEligibleCount: buckets.noEligible.length,
    sameNameCount,
    sameMatchCount,
    errors: buckets.errors.length,
  };

  return {
    region: reg,
    payingCount: paying.length,
    buckets,
    summary,
  };
}

/**
 * Merge per-region payloads into one file (GET /api/gmbautoconnect).
 * Regions come from {@link parseCrmSnapshotRegions}.
 */
export async function buildAndWriteAutoConnectedGmbSnapshot(outputPath = DEFAULT_OUTPUT) {
  const regions = parseCrmSnapshotRegions();
  const merged = {
    alreadyLinked: [],
    auto_connected_gmb_name: [],
    manual_connect_gmb_name: [],
    noEligible: [],
    errors: [],
  };
  /** @type {Record<string, any>} */
  const byRegion = {};

  for (const reg of regions) {
    const part = await buildAutoConnectedPayloadForRegion(reg);
    byRegion[reg] = part.summary;
    merged.alreadyLinked.push(...part.buckets.alreadyLinked);
    merged.auto_connected_gmb_name.push(...part.buckets.auto_connected_gmb_name);
    merged.manual_connect_gmb_name.push(...part.buckets.manual_connect_gmb_name);
    merged.noEligible.push(...part.buckets.noEligible);
    merged.errors.push(...part.buckets.errors);
  }

  const totalPaying = regions.reduce((acc, r) => acc + (byRegion[r]?.totalPaying || 0), 0);
  const sameNameCount = merged.auto_connected_gmb_name.filter((x) => scoreNameMatch(x.business_name, x.gmb_name) >= 1000).length;
  const sameMatchCount = merged.auto_connected_gmb_name.filter((x) => scoreNameMatch(x.business_name, x.gmb_name) >= 800).length;

  const out = {
    generatedAt: new Date().toISOString(),
    mode: 'ranking_server_pipeline',
    region: regions.join(','),
    crmRegions: regions,
    summary: {
      totalPaying,
      alreadyLinkedCount: merged.alreadyLinked.length,
      wouldAutoCount: merged.auto_connected_gmb_name.length,
      manualCount: merged.manual_connect_gmb_name.length,
      noEligibleCount: merged.noEligible.length,
      sameNameCount,
      sameMatchCount,
      errors: merged.errors.length,
      byRegion,
    },
    auto_connected_gmb_name: merged.auto_connected_gmb_name,
    manual_connect_gmb_name: merged.manual_connect_gmb_name,
    alreadyLinked: merged.alreadyLinked,
    noEligible: merged.noEligible,
    errors: merged.errors,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(out, null, 2), 'utf8');
  return { outputPath, summary: out.summary, payload: out };
}
