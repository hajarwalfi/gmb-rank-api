import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../../');
const AUDIT_DIR = path.join(SERVER_ROOT, 'data', 'automation_missing_json');
const LATEST_PTR_FILE = path.join(AUDIT_DIR, 'latest.json');

function nowIso() {
  return new Date().toISOString();
}

function auditFilePath(jobId) {
  return path.join(AUDIT_DIR, `job_${String(jobId)}.json`);
}

async function ensureDir() {
  await fs.mkdir(AUDIT_DIR, { recursive: true });
}

async function readAuditRaw(jobId) {
  try {
    const raw = await fs.readFile(auditFilePath(jobId), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function normalizeTarget(t) {
  const accountId = String(t?.accountId || '').trim();
  const locationId = String(t?.locationId || '').trim();
  const locationTitle = String(t?.title || t?.locationTitle || '').trim();
  if (!accountId || !locationId) return null;
  return { accountId, locationId, locationTitle };
}

function buildSummary(doc) {
  const expected = Array.isArray(doc?.expectedTargets) ? doc.expectedTargets : [];
  const outcomes = Array.isArray(doc?.outcomes) ? doc.outcomes : [];
  const expectedKeySet = new Set(expected.map((t) => `${t.accountId}::${t.locationId}`));
  const validOutcomes = outcomes.filter((o) => expectedKeySet.has(`${o.accountId}::${o.locationId}`));
  const saved = validOutcomes.filter((o) => o.persistedToHistory === true);
  const missing = validOutcomes.filter((o) => o.persistedToHistory !== true);
  const processedSet = new Set(validOutcomes.map((o) => `${o.accountId}::${o.locationId}`));
  const pending = expected.filter((t) => !processedSet.has(`${t.accountId}::${t.locationId}`));

  return {
    expectedCount: expected.length,
    processedCount: processedSet.size,
    savedCount: saved.length,
    missingCount: missing.length,
    pendingCount: pending.length,
  };
}

async function writeAudit(jobId, doc) {
  await ensureDir();
  doc.jobId = String(jobId);
  doc.updatedAt = nowIso();
  await fs.writeFile(auditFilePath(jobId), JSON.stringify(doc, null, 2), 'utf8');
  await fs.writeFile(
    LATEST_PTR_FILE,
    JSON.stringify({ jobId: String(jobId), updatedAt: doc.updatedAt }, null, 2),
    'utf8'
  );
}

export async function initAutomationMissingJsonAudit({
  jobId,
  allLocations = false,
  scheduledAt = null,
  targets = [],
} = {}) {
  const normalizedTargets = [];
  const seen = new Set();
  for (const raw of Array.isArray(targets) ? targets : []) {
    const t = normalizeTarget(raw);
    if (!t) continue;
    const key = `${t.accountId}::${t.locationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedTargets.push(t);
  }

  const existing = await readAuditRaw(jobId);
  const doc = existing || {
    jobId: String(jobId),
    createdAt: nowIso(),
    allLocations: Boolean(allLocations),
    scheduledAt: scheduledAt || null,
    status: 'scheduled',
    expectedTargets: [],
    outcomes: [],
  };

  doc.allLocations = Boolean(allLocations);
  doc.scheduledAt = scheduledAt || doc.scheduledAt || null;
  doc.status = doc.status || 'scheduled';
  if (!Array.isArray(doc.expectedTargets)) doc.expectedTargets = [];
  if (!Array.isArray(doc.outcomes)) doc.outcomes = [];

  const existingMap = new Map(doc.expectedTargets.map((t) => [`${t.accountId}::${t.locationId}`, t]));
  for (const t of normalizedTargets) {
    const key = `${t.accountId}::${t.locationId}`;
    existingMap.set(key, t);
  }
  doc.expectedTargets = [...existingMap.values()];

  await writeAudit(jobId, doc);
  return doc;
}

export async function markAutomationMissingJsonStatus(jobId, status) {
  const doc = (await readAuditRaw(jobId)) || {
    jobId: String(jobId),
    createdAt: nowIso(),
    allLocations: false,
    scheduledAt: null,
    expectedTargets: [],
    outcomes: [],
  };
  doc.status = String(status || '').trim() || doc.status || 'unknown';
  await writeAudit(jobId, doc);
}

export async function recordAutomationMissingJsonOutcome(jobId, row = {}) {
  const accountId = String(row.accountId || '').trim();
  const locationId = String(row.locationId || '').trim();
  if (!accountId || !locationId) return null;

  const doc = (await readAuditRaw(jobId)) || {
    jobId: String(jobId),
    createdAt: nowIso(),
    allLocations: false,
    scheduledAt: null,
    status: 'running',
    expectedTargets: [],
    outcomes: [],
  };
  if (!Array.isArray(doc.expectedTargets)) doc.expectedTargets = [];
  if (!Array.isArray(doc.outcomes)) doc.outcomes = [];

  const targetKey = `${accountId}::${locationId}`;
  const maybeTarget = normalizeTarget({
    accountId,
    locationId,
    title: row.locationTitle || '',
  });
  if (maybeTarget) {
    const idx = doc.expectedTargets.findIndex((t) => `${t.accountId}::${t.locationId}` === targetKey);
    if (idx >= 0) doc.expectedTargets[idx] = maybeTarget;
    else doc.expectedTargets.push(maybeTarget);
  }

  const next = {
    accountId,
    locationId,
    locationTitle: String(row.locationTitle || '').trim(),
    gmbKey: String(row.gmbKey || '').trim(),
    persistedToHistory: row.persistedToHistory === true,
    reason: String(row.reason || '').trim() || null,
    at: nowIso(),
  };

  const outIdx = doc.outcomes.findIndex((o) => `${o.accountId}::${o.locationId}` === targetKey);
  if (outIdx >= 0) doc.outcomes[outIdx] = next;
  else doc.outcomes.push(next);

  await writeAudit(jobId, doc);
  return next;
}

export async function getAutomationMissingJsonAudit(jobId) {
  const doc = await readAuditRaw(jobId);
  if (!doc) return null;
  const summary = buildSummary(doc);
  const missing = (Array.isArray(doc.outcomes) ? doc.outcomes : []).filter((o) => o.persistedToHistory !== true);
  return { ...doc, summary, missing };
}

export async function getLatestAutomationMissingJsonAudit() {
  try {
    const raw = await fs.readFile(LATEST_PTR_FILE, 'utf8');
    const ptr = JSON.parse(raw);
    const id = String(ptr?.jobId || '').trim();
    if (!id) return null;
    return getAutomationMissingJsonAudit(id);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}
