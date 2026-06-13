import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../../');
const HISTORY_DIR = path.join(SERVER_ROOT, 'data', 'history');

/**
 * Ensures the history directory exists
 */
async function ensureDir() {
  await fs.mkdir(HISTORY_DIR, { recursive: true });
}

/**
 * Helper to generate an auto-incremented scan ID
 */
export function generateNextScanId(existingScans = []) {
  if (!existingScans.length) return 'scan_001';

  const lastScan = existingScans[existingScans.length - 1];
  const lastIdStr = lastScan.scan_id || 'scan_000';
  const prefix = 'scan_';

  if (lastIdStr.startsWith(prefix)) {
    const num = parseInt(lastIdStr.replace(prefix, ''), 10);
    if (!isNaN(num)) {
      return `${prefix}${String(num + 1).padStart(3, '0')}`;
    }
  }
  return `${prefix}${String(existingScans.length + 1).padStart(3, '0')}`;
}

import { createHash } from 'crypto';

function getSafeFilepath(businessId) {
  const h = createHash('sha256').update(businessId).digest('hex');
  return path.join(HISTORY_DIR, `${h}.json`);
}

/**
 * Saves new scan data to a business's local JSON history file.
 * Appends each scan to `scans[]` (never replaces the full history) so pings / audits retain older runs.
 */
export async function saveToHistory(businessId, businessName, locationName, scanData) {
  if (!businessId) {
    console.warn('[HistoryManager] saveToHistory skipped. businessId is missing.');
    return null;
  }
  await ensureDir();

  const filepath = getSafeFilepath(businessId);

  let historyData = {
    business_id: businessId,
    gmbKey: businessId, // Ensure compatibility with Unified format
    business_name: businessName || '',
    location: locationName || '',
    scans: [],
    snapshots: []
  };

  try {
    const fileContent = await fs.readFile(filepath, 'utf8');
    historyData = JSON.parse(fileContent);
    if (!Array.isArray(historyData.scans)) historyData.scans = [];
    if (!Array.isArray(historyData.snapshots)) historyData.snapshots = [];
    // Update summary data in case it changed
    if (businessName) historyData.business_name = businessName;
    if (locationName) historyData.location = locationName;
    if (!historyData.business_id) historyData.business_id = businessId;
    if (!historyData.gmbKey) historyData.gmbKey = businessId;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[HistoryManager] Failed to read ${businessId}:`, err);
    }
  }

  // Create new scan entry
  const newScan = {
    scan_id: generateNextScanId(historyData.scans),
    scanned_at: scanData.scanned_at || new Date().toISOString(),
    traffic: {
      website_clicks: scanData.traffic?.website_clicks ?? 0,
      direction_requests: scanData.traffic?.direction_requests ?? 0,
      calls: scanData.traffic?.calls ?? 0,
      impressions: scanData.traffic?.impressions ?? 0
    },
    map_ranks: Array.isArray(scanData.map_ranks) ? scanData.map_ranks.map(r => ({
      keyword: r.keyword || 'unknown',
      rank: typeof r.rank === 'number' ? r.rank : null,
      volume: r.volume || 0,
      daily_traffic: r.daily_traffic || 0,
      estimated_clicks: r.estimated_clicks || 0,
      screenshot_url: r.screenshot_url || r.screenshotUrl || null
    })) : [],
    reviews: {
      total_count: scanData.reviews?.total_count ?? 0,
      average_rating: scanData.reviews?.average_rating ?? 0,
      new_since_last_scan: scanData.reviews?.new_since_last_scan ?? 0
    },
    screenshot_url: scanData.screenshot_url || null
  };

  // Push and save
  historyData.scans.push(newScan);
  // Sort descending
  historyData.scans.sort((a, b) => new Date(b.scanned_at || 0) - new Date(a.scanned_at || 0));
  historyData.latest_scan = historyData.scans[0];
  historyData.total_scans = historyData.scans.length;

  await fs.writeFile(filepath, JSON.stringify(historyData, null, 2), 'utf8');
  console.log(`[HistoryManager] Appended ${newScan.scan_id} for ${businessId}`);
  return historyData;
}

/**
 * Retrieves the full history for a given business ID
 */
export async function getHistory(businessId) {
  try {
    const filepath = getSafeFilepath(businessId);
    const fileContent = await fs.readFile(filepath, 'utf8');
    return JSON.parse(fileContent);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Returns a list of all discovered business IDs in the history directory
 */
export async function getAllBusinessIds() {
  await ensureDir();
  try {
    const files = await fs.readdir(HISTORY_DIR);
    const ids = [];
    for (const filename of files) {
      if (!filename.endsWith('.json')) continue;
      try {
        const fileContent = await fs.readFile(path.join(HISTORY_DIR, filename), 'utf8');
        const data = JSON.parse(fileContent);
        if (data.business_id) ids.push(data.business_id);
      } catch (e) { }
    }
    return ids;
  } catch (err) {
    return [];
  }
}




