import { randomUUID } from 'crypto';
import { GmbKeywordGallery } from '../models/GmbKeywordGallery.js';
import { isMongoReady } from '../db/mongo.js';

function allowScreenshotPath(p) {
  if (p == null || typeof p !== 'string') return false;
  const s = p.trim();
  if (!s) return false;
  if (s.startsWith('https://') || s.startsWith('http://')) return true;
  const norm = s.replace(/\\/g, '/').replace(/^\/+/, '');
  if (norm.includes('..')) return false;
  return norm.startsWith('screenshots/');
}

export async function createGmbKeywordGallery(req, res) {
  if (!isMongoReady()) {
    return res.status(503).json({
      error:
        'Gallery database unavailable. Ensure MongoDB connects (root config/database.js or MONGODB_URI).',
    });
  }

  const {
    businessName = '',
    locationHint = '',
    accountId = '',
    locationId = '',
    items = [],
  } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }

  const cleaned = [];
  for (const row of items) {
    const keyword = typeof row.keyword === 'string' ? row.keyword.trim() : '';
    const screenshotPath =
      typeof row.screenshotPath === 'string' ? row.screenshotPath.trim() : '';
    if (!keyword || !screenshotPath || !allowScreenshotPath(screenshotPath)) continue;
    const rank = row.rank != null && Number.isFinite(Number(row.rank)) ? Number(row.rank) : null;
    const page = row.page != null && Number.isFinite(Number(row.page)) ? Number(row.page) : null;
    
    cleaned.push({ 
        keyword, 
        screenshotPath, 
        rank, 
        page,
        target_keyword: row.target_keyword || null,
        source_month: row.source_month || null,
        volume: Number(row.volume) || 0,
        daily_traffic: Number(row.daily_traffic) || 0,
        estimated_clicks: Number(row.estimated_clicks) || 0,
        raw_traffic_data: row.raw_traffic_data || null
    });
}

  if (!cleaned.length) {
    return res.status(400).json({ error: 'No valid keyword/screenshotPath entries' });
  }

  const publicId = randomUUID();
  try {
    await GmbKeywordGallery.create({
      publicId,
      businessName: typeof businessName === 'string' ? businessName : '',
      locationHint: typeof locationHint === 'string' ? locationHint : '',
      accountId: typeof accountId === 'string' ? accountId.trim() : '',
      locationId: typeof locationId === 'string' ? locationId.trim() : '',
      items: cleaned,
    });
  } catch (e) {
    console.error('[gallery] create failed', e);
    return res.status(500).json({ error: 'Failed to save gallery' });
  }

  return res.status(201).json({ publicId });
}

export async function getGmbKeywordGallery(req, res) {
  if (!isMongoReady()) {
    return res.status(503).json({
      error:
        'Gallery database unavailable. Ensure MongoDB connects (root config/database.js or MONGODB_URI).',
    });
  }

  const { publicId } = req.params;
  if (!publicId || typeof publicId !== 'string') {
    return res.status(400).json({ error: 'Invalid id' });
  }

  const doc = await GmbKeywordGallery.findOne({ publicId: publicId.trim() })
    .select('publicId businessName locationHint accountId locationId items createdAt updatedAt')
    .lean();

  if (!doc) return res.status(404).json({ error: 'Gallery not found' });

  return res.json(doc);
}
