import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..', '..');

function readKeyFileFirstNonCommentLine(fp) {
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const t = String(line || '').trim();
      if (!t || t.startsWith('#')) continue;
      return t.replace(/^\uFEFF/, '').trim();
    }
  } catch {
    /* missing */
  }
  return '';
}

/** Snapshot CRM keys before `override: true` child `.env` (empty `KEY=` wipes parent otherwise). */
export function captureCrmApiKeySnapshot() {
  return {
    flow: String(process.env.FORMFLOW_CRM_API_KEY || '').trim(),
    vite: String(process.env.VITE_FORMFLOW_CRM_API_KEY || '').trim(),
  };
}

export function restoreCrmApiKeysIfBlanksAfterOverride(snap) {
  if (!snap) return;
  if (!String(process.env.FORMFLOW_CRM_API_KEY || '').trim() && snap.flow) {
    process.env.FORMFLOW_CRM_API_KEY = snap.flow;
  }
  if (!String(process.env.VITE_FORMFLOW_CRM_API_KEY || '').trim() && snap.vite) {
    process.env.VITE_FORMFLOW_CRM_API_KEY = snap.vite;
  }
}

/**
 * Read CRM API key from env + optional sidecar files. Does not load `.env` by itself.
 * @returns {string} resolved key (trimmed) or ''
 */
export function resolveFormflowCrmApiKey() {
  let k = String(process.env.FORMFLOW_CRM_API_KEY || process.env.VITE_FORMFLOW_CRM_API_KEY || '').trim();
  if (k) {
    process.env.FORMFLOW_CRM_API_KEY = k;
    return k;
  }

  const fromEnvPath = String(process.env.FORMFLOW_CRM_API_KEY_FILE || '').trim();
  if (fromEnvPath) {
    k = readKeyFileFirstNonCommentLine(fromEnvPath);
    if (k) {
      process.env.FORMFLOW_CRM_API_KEY = k;
      return k;
    }
  }

  const serverCrm = path.join(SERVER_ROOT, '.env.crm');
  k = readKeyFileFirstNonCommentLine(serverCrm);
  if (k) {
    process.env.FORMFLOW_CRM_API_KEY = k;
    return k;
  }

  const locals = [
    path.join(SERVER_ROOT, '.env.local'),
    path.join(REPO_ROOT, '.env.local'),
    path.join(REPO_ROOT, 'formflow-buddy', 'client-hub-admin', '.env.local'),
  ];
  for (const p of locals) {
    if (!fs.existsSync(p)) continue;
    dotenv.config({ path: p });
    k = String(process.env.FORMFLOW_CRM_API_KEY || process.env.VITE_FORMFLOW_CRM_API_KEY || '').trim();
    if (k) {
      process.env.FORMFLOW_CRM_API_KEY = k;
      return k;
    }
  }

  return '';
}

/**
 * Same dotenv order as `server.js` bootstrap + Client Hub `.env`, then {@link resolveFormflowCrmApiKey}.
 * Restores parent CRM keys when server `.env` has blank `FORMFLOW_CRM_API_KEY=` (matches older branch scripts).
 */
export function loadRankingServerDotenvWithCrmHydration() {
  dotenv.config({ path: path.join(REPO_ROOT, '.env') });
  const snap = captureCrmApiKeySnapshot();
  dotenv.config({ path: path.join(SERVER_ROOT, '.env'), override: true });
  restoreCrmApiKeysIfBlanksAfterOverride(snap);
  const clientHub = path.join(REPO_ROOT, 'formflow-buddy', 'client-hub-admin', '.env');
  if (fs.existsSync(clientHub)) {
    dotenv.config({ path: clientHub });
    restoreCrmApiKeysIfBlanksAfterOverride(snap);
  }
  return resolveFormflowCrmApiKey();
}

export function getFormflowCrmApiBaseUrl() {
  return String(
    process.env.FORMFLOW_CRM_API_BASE ||
      process.env.VITE_FORMFLOW_CRM_API_BASE ||
      process.env.CRM_BASE ||
      'https://click.acquisition-central.com',
  )
    .trim()
    .replace(/\/$/, '');
}

/** Axios/fetch headers for clickupbackend `/api/formflow/crm/*` (uses {@link resolveFormflowCrmApiKey}). */
export function buildFormflowCrmRequestHeaders(extra = {}) {
  const headers = { Accept: 'application/json', ...extra };
  const apiKey = resolveFormflowCrmApiKey();
  if (apiKey) headers['x-formflow-crm-key'] = apiKey;
  return headers;
}

/**
 * @param {string} [context] — e.g. "SupabaseGMB sync", "auto-connect rebuild"
 * @returns {string} non-empty API key
 */
export function assertFormflowCrmApiKey(context = 'Formflow CRM') {
  const key = resolveFormflowCrmApiKey();
  if (key) return key;
  throw new Error(
    `${context}: FORMFLOW_CRM_API_KEY is not configured. ` +
      'Set FORMFLOW_CRM_API_KEY in google-search-ranking/server/.env, ' +
      'VITE_FORMFLOW_CRM_API_KEY in formflow-buddy/client-hub-admin/.env, ' +
      'or paste the key as the first non-comment line in google-search-ranking/server/.env.crm (gitignored; see .env.crm.example).',
  );
}

/** Human-readable message when CRM HTTP auth fails (401/403). */
export function formatCrmHttpAuthError(status, context = 'Formflow CRM') {
  const st = Number(status);
  if (st === 401) {
    return (
      `${context}: HTTP 401 Unauthorized — CRM API key is missing, wrong, or expired. ` +
      'Set FORMFLOW_CRM_API_KEY or server/.env.crm to the same value used on click.acquisition-central.com (clickupbackend).'
    );
  }
  if (st === 403) {
    return `${context}: HTTP 403 Forbidden — key may be present but not allowed for this CRM route.`;
  }
  return `${context}: HTTP ${st}`;
}

/** One-line startup check so PM2 logs show CRM auth before crons fire. */
export function logFormflowCrmAuthStatusOnStartup() {
  const useCrm = String(process.env.USE_FORMFLOW_CRM_CLIENTS ?? 'false').toLowerCase() === 'true';
  const key = resolveFormflowCrmApiKey();
  const base = getFormflowCrmApiBaseUrl();
  if (key) {
    console.log(`[Formflow CRM] API key: set (${key.length} chars) — base ${base}`);
    return true;
  }
  console.error(
    '[Formflow CRM] API key: NOT SET — auto-connect, business-connect, services-keywords, and active-gmb crons cannot load paying clients from Mongo CRM.',
  );
  console.error(
    '[Formflow CRM] Fix: FORMFLOW_CRM_API_KEY in server/.env OR server/.env.crm (first line = key). Same key as Client Hub VITE_FORMFLOW_CRM_API_KEY in production.',
  );
  if (useCrm) {
    console.error(
      '[Formflow CRM] USE_FORMFLOW_CRM_CLIENTS=true without a key → HTTP 401 on GET /api/formflow/crm/clients; jobs fall back to Supabase (often fewer rows than Client Hub).',
    );
  }
  return false;
}
