import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '../../data/fathom_onboarding_reports.json');

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

/**
 * Create a fingerprint to detect duplicates (same taskId + fathomLink).
 */
function reportFingerprint({ taskId, fathomLink, transcript }) {
  const normalized = {
    taskId: String(taskId || '').trim().toLowerCase(),
    fathomLink: String(fathomLink || '').trim().toLowerCase(),
    // Optionally include transcript hash? But transcript could be large.
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function fingerprintFromRow(row) {
  return reportFingerprint({ taskId: row.taskId, fathomLink: row.fathomLink, transcript: row.transcript });
}

/**
 * Save onboarding analysis report.
 * If same taskId + fathomLink exists, update it with latest AI output.
 * @param {Object} report - { taskId, businessName, gmbProfileName, fathomLink, transcript, analysis, score, status }
 * @returns {Promise<Object>} { saved, updated, duplicate, id }
 */
export async function saveReport(report) {
  const incomingFp = reportFingerprint(report);

  const task = writeQueue.then(() => {
    const all = readAll();
    const existingIndex = all.findIndex(existing => fingerprintFromRow(existing) === incomingFp);
    if (existingIndex >= 0) {
      const existing = all[existingIndex];
      all[existingIndex] = {
        ...existing,
        businessName: report.businessName || existing.businessName || null,
        gmbProfileName: report.gmbProfileName || existing.gmbProfileName || null,
        transcript: report.transcript,
        analysis: report.analysis,
        score: report.score,
        status: report.status,
        passedItems: report.passedItems,
        totalItems: report.totalItems,
        confidenceAvg: report.confidenceAvg || 0,
        updatedAt: new Date().toISOString()
      };
      writeAll(all);
      return { saved: false, updated: true, duplicate: true, id: existing.id };
    }

    const id = `ob_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const row = {
      id,
      taskId: report.taskId,
      businessName: report.businessName || null,
      gmbProfileName: report.gmbProfileName || null,
      fathomLink: report.fathomLink,
      transcript: report.transcript,
      analysis: report.analysis,
      score: report.score,
      status: report.status,
      passedItems: report.passedItems,
      totalItems: report.totalItems,
      confidenceAvg: report.confidenceAvg || 0,
      createdAt: new Date().toISOString()
    };
    all.unshift(row);
    writeAll(all);
    return { saved: true, updated: false, duplicate: false, id };
  });

  writeQueue = task.catch(err => {
    console.error('[fathomOnboarding] save queue error', err);
  });

  return task;
}

/**
 * Get report by ID.
 */
export function getById(id) {
  return readAll().find(r => r.id === id) || null;
}

/**
 * Get reports for a specific taskId.
 * Returns array sorted by createdAt descending.
 */
export function getByTaskId(taskId) {
  const all = readAll();
  const filtered = all.filter(r => String(r.taskId || '') === String(taskId || ''));
  return filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * Find the most recent report for a specific Fathom link (across all tasks).
 * Used for caching analysis results to ensure consistency for the same video.
 */
export function findFirstByFathomLink(fathomLink) {
  if (!fathomLink) return null;
  const normalized = String(fathomLink).trim().toLowerCase();
  const all = readAll();
  // Sort by createdAt descending to get the freshest analysis if multiple exist
  const matches = all
    .filter(r => String(r.fathomLink || '').trim().toLowerCase() === normalized)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  return matches.length > 0 ? matches[0] : null;
}

/**
 * List all reports (most recent first).
 */
export function listReports() {
  return readAll().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * Delete a report by ID.
 */
export async function deleteById(id) {
  const task = writeQueue.then(() => {
    const all = readAll();
    const filtered = all.filter(r => r.id !== id);
    if (filtered.length === all.length) {
      return { deleted: false };
    }
    writeAll(filtered);
    return { deleted: true };
  });
  writeQueue = task.catch(err => {
    console.error('[fathomOnboarding] delete queue error', err);
  });
  return task;
}
