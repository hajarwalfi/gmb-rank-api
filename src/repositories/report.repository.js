import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '../../data/reports.json');

/** Serialize writes so rapid / overlapping saves never drop a row (read-modify-write race). */
let writeQueue = Promise.resolve();

function readAll() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(rows) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(rows, null, 2), 'utf8');
}

/** Same business + same run snapshot + same rows → duplicate (blocks double-save / rapid re-clicks). */
function reportContentFingerprint({ businessName, results, generatedAt, source }) {
  const normalized = {
    businessName: String(businessName || '').trim().toLowerCase(),
    generatedAt: generatedAt || '',
    source: source || '',
    results: results || [],
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function fingerprintFromStoredRow(row) {
  return reportContentFingerprint({
    businessName: row.businessName,
    results: row.results,
    generatedAt: row.generatedAt,
    source: row.source,
  });
}

export async function saveReport(report) {
  const incomingFp = reportContentFingerprint(report);

  const task = writeQueue.then(() => {
    const all = readAll();
    if (all.some((existing) => fingerprintFromStoredRow(existing) === incomingFp)) {
      return { saved: false, duplicate: true, id: null };
    }

    const id = `r_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const row = {
      id,
      businessName: report.businessName,
      results: report.results,
      generatedAt: report.generatedAt || new Date().toISOString(),
      source: report.source,
      savedAt: new Date().toISOString(),
    };
    all.unshift(row);
    writeAll(all);
    return { saved: true, duplicate: false, id };
  });
  writeQueue = task.catch((err) => {
    console.error('[reports] save queue error', err);
  });
  return task;
}

export function getReportById(id) {
  return readAll().find((r) => r.id === id) || null;
}

export function listReports() {
  return readAll().sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
}

export async function deleteReport(id) {
  const task = writeQueue.then(() => {
    const all = readAll();
    const filtered = all.filter((r) => r.id !== id);
    if (filtered.length === all.length) return { deleted: false };
    writeAll(filtered);
    return { deleted: true };
  });
  writeQueue = task.catch((err) => {
    console.error('[reports] delete queue error', err);
  });
  return task;
}
