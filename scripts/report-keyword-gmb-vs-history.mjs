/**
 * Compare services-keywords.json (withKeywords rows) to data/history/*.json
 * (SHA-256 of gmbKey = loc:<numericLocationId>).
 *
 * Run from google-search-ranking/server:
 *   node scripts/report-keyword-gmb-vs-history.mjs
 *     → Lists ONLY GMBs with NO history JSON yet (266 − "have file" = your remaining queue).
 *
 *   node scripts/report-keyword-gmb-vs-history.mjs --include-incomplete-files
 *     → Also lists locations that HAVE a file but still lack map_ranks + screenshot (stub runs).
 *
 *   node scripts/report-keyword-gmb-vs-history.mjs --csv
 *   node scripts/report-keyword-gmb-vs-history.mjs --include-incomplete-files --csv
 *
 * Self-contained (no imports from src/).
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const SERVICES_PATH = path.join(SERVER_ROOT, 'data', 'services-keywords.json');
const HISTORY_DIR = path.join(SERVER_ROOT, 'data', 'history');

const argv = new Set(process.argv.slice(2));
const INCLUDE_INCOMPLETE = argv.has('--include-incomplete-files');
const WANT_CSV = argv.has('--csv');

/** Matches makeGmbKey() for normal numeric Google location IDs (services-keywords rows). */
function makeGmbKey(locationId, businessName) {
  let lid = String(locationId || '').trim();
  if (lid) {
    const shortId = lid.split('/').filter(Boolean).pop();
    return `loc:${shortId}`;
  }
  const n = String(businessName || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!n) return 'name:unknown';
  return `name:${n}`;
}

function hashFileName(gmbKey) {
  return `${createHash('sha256').update(gmbKey).digest('hex')}.json`;
}

function readHistory(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

function scansPresent(doc) {
  if (!doc) return false;
  const n = Array.isArray(doc.scans) ? doc.scans.length : 0;
  return n > 0 || Number(doc.total_scans || 0) > 0;
}

function resolveLatestScan(doc) {
  if (!doc) return null;
  if (doc.latest_scan) return doc.latest_scan;
  const scans = Array.isArray(doc.scans) ? doc.scans : [];
  if (!scans.length) return null;
  return [...scans].sort((a, b) => new Date(b.scanned_at || 0) - new Date(a.scanned_at || 0))[0];
}

function hasMeaningfulCapture(scan) {
  if (!scan) return false;
  const ranks = Array.isArray(scan.map_ranks) ? scan.map_ranks : [];
  if (!ranks.length) return false;
  const scanShot = String(scan.screenshot_url || scan.screenshotUrl || '').trim();
  if (scanShot) return true;
  return ranks.some((r) => String(r?.screenshot_url || r?.screenshotUrl || '').trim());
}

function rowReason(exists, doc, anyScan, strictOk) {
  if (!exists) return 'no_history_file';
  if (!doc) return 'history_unreadable';
  if (!anyScan) return 'no_scans_in_file';
  if (!strictOk) return 'map_ranks_or_screenshot_missing';
  return 'ok';
}

function CSV(s) {
  const x = String(s ?? '');
  if (/[",\n]/.test(x)) return `"${x.replace(/"/g, '""')}"`;
  return x;
}

if (!fs.existsSync(SERVICES_PATH)) {
  console.error('Missing:', SERVICES_PATH);
  process.exit(1);
}
if (!fs.existsSync(HISTORY_DIR)) {
  console.error('Missing directory:', HISTORY_DIR);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(SERVICES_PATH, 'utf8'));
const withKw = (Array.isArray(raw.rows) ? raw.rows : []).filter(
  (r) => Array.isArray(r.keywords) && r.keywords.length > 0
);

const summaryWithKeywords = raw.summary?.withKeywords ?? withKw.length;

const missingNoFile = [];
const incompleteFiles = [];

let historyFileOnDisk = 0;
let strictComplete = 0;

for (const r of withKw) {
  const lid = String(r.locationIdShort || r.locationId || '').trim();
  const title = String(r.gmbName || r.business_name || r.title || '').trim();
  const gmbKey = makeGmbKey(lid || null, title);
  const fp = path.join(HISTORY_DIR, hashFileName(gmbKey));
  const exists = fs.existsSync(fp);
  const doc = exists ? readHistory(fp) : null;

  const latest = resolveLatestScan(doc);
  const anyScan = scansPresent(doc);
  const strictOk = anyScan && hasMeaningfulCapture(latest);
  const reason = rowReason(exists, doc, anyScan, strictOk);

  if (exists) historyFileOnDisk++;
  if (strictOk) strictComplete++;

  const base = {
    gmbName: r.gmbName,
    business_name: r.business_name,
    locationId: lid,
    gmbKey,
    hash: hashFileName(gmbKey).replace(/\.json$/, ''),
    reason,
  };

  if (!exists) {
    missingNoFile.push(base);
  } else if (INCLUDE_INCOMPLETE && reason !== 'ok') {
    incompleteFiles.push(base);
  }
}

const total = withKw.length;
const noFileCount = missingNoFile.length;
const incompleteCount = incompleteFiles.length;
const listToPrint = INCLUDE_INCOMPLETE ? [...missingNoFile, ...incompleteFiles] : missingNoFile;

console.log('=== Keyword GMB vs data/history ===');
console.log(`services-keywords summary.withKeywords: ${summaryWithKeywords}`);
console.log(`Rows with keywords (filtered):          ${total}`);
console.log(`History JSON file on disk:             ${historyFileOnDisk} / ${total}`);
console.log(`No history JSON file yet:              ${noFileCount} / ${total}`);
console.log(`Full capture (map_ranks + screenshot): ${strictComplete} / ${total}`);
if (historyFileOnDisk + noFileCount !== total) {
  console.log('Warning: file on disk + no-file should equal total; check duplicates or logic.');
}
console.log(`List mode:                             ${INCLUDE_INCOMPLETE ? '--include-incomplete-files' : 'no JSON file only (default)'}`);
console.log(`Rows listed below:                     ${listToPrint.length}`);
console.log('');

if (!listToPrint.length) {
  console.log(
    INCLUDE_INCOMPLETE
      ? 'No missing files and no incomplete captures.'
      : 'Every keyword GMB already has a history JSON file.'
  );
  process.exit(0);
}

console.log(
  INCLUDE_INCOMPLETE
    ? '--- No history file + incomplete captures ---'
    : '--- No history JSON file (queue for first write) ---'
);
listToPrint.forEach((m, i) => {
  console.log(
    `${String(i + 1).padStart(3)}. ${String(m.gmbName || '').padEnd(40)} | ${m.locationId} | ${m.reason}`
  );
});

if (WANT_CSV) {
  console.log('');
  console.log('#csv');
  console.log(['gmbName', 'business_name', 'locationId', 'gmbKey', 'history_hash', 'reason'].join(','));
  for (const m of listToPrint) {
    console.log(
      [CSV(m.gmbName), CSV(m.business_name), CSV(m.locationId), CSV(m.gmbKey), CSV(m.hash), CSV(m.reason)].join(',')
    );
  }
}

process.exit(0);
