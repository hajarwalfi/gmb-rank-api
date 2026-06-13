import { isMongoReady } from '../db/mongo.js';
import { GmbKeywordGallery } from '../models/GmbKeywordGallery.js';
import {
  appendSnapshot,
  buildCompareRows,
  defaultGalleryPageUrl,
  galleryItemsFromDoc,
  getAllTrackingRows,
  listTrackedLocations,
  makeGmbKey,
  readTracking,
  upsertTrackingItemTraffic,
} from '../services/gmbTrackingHistory.service.js';
import { calculateEstimatedClicks } from '../utils/trafficCalculator.js';

export async function postSaveFromGallery(req, res) {
  if (!isMongoReady()) {
    return res.status(503).json({
      error:
        'Gallery database unavailable. Ensure MongoDB connects (root config/database.js or MONGODB_URI).',
    });
  }

  const publicId = String(req.body?.publicId || '').trim();
  const confirmCompare = !!req.body?.confirmCompare;
  const galleryPageUrl =
    typeof req.body?.galleryPageUrl === 'string' && req.body.galleryPageUrl.trim()
      ? req.body.galleryPageUrl.trim()
      : null;

  if (!publicId) {
    return res.status(400).json({ error: 'publicId is required' });
  }

  const doc = await GmbKeywordGallery.findOne({ publicId }).lean();
  if (!doc) {
    return res.status(404).json({ error: 'Gallery not found' });
  }

  const gmbKey = makeGmbKey(doc.locationId, doc.businessName);
  const existing = await readTracking(gmbKey);
  const priorCount = existing?.snapshots?.length || 0;

  if (priorCount >= 1 && !confirmCompare) {
    const last = existing.snapshots[priorCount - 1];
    return res.status(200).json({
      ok: true,
      saved: false,
      needsConfirm: true,
      gmbKey,
      businessName: doc.businessName || '',
      snapshotCount: priorCount,
      lastSavedAt: last?.savedAt || null,
      lastSource: last?.source || null,
      message:
        'A previous tracking snapshot exists for this GMB. Confirm to save this run and compare with the last one.',
    });
  }

  const items = galleryItemsFromDoc(doc);
  if (!items.length) {
    return res.status(400).json({ error: 'No keyword rows to save in this gallery' });
  }

  const galleryUrl = galleryPageUrl || defaultGalleryPageUrl(publicId);

  try {
    const result = await appendSnapshot({
      gmbKey,
      businessName: doc.businessName || '',
      accountId: doc.accountId || '',
      locationId: doc.locationId || '',
      source: 'manual',
      galleryPublicId: publicId,
      galleryUrl,
      savedAt: new Date().toISOString(),
      items,
    });

    return res.status(201).json({
      ok: true,
      saved: true,
      needsConfirm: false,
      gmbKey,
      snapshotCount: result.snapshotCount,
      snapshotId: result.snapshot.id,
    });
  } catch (e) {
    console.error('[tracking] save-from-gallery failed', e);
    return res.status(500).json({ error: 'Failed to save tracking snapshot' });
  }
}

export async function getTrackingLocations(req, res) {
  try {
    const locations = await listTrackedLocations();
    return res.json({ locations });
  } catch (e) {
    console.error('[tracking] list failed', e);
    return res.status(500).json({ error: 'Failed to list tracking data' });
  }
}

export async function getTrackingCompare(req, res) {
  const gmbKey = String(req.query?.gmbKey || '').trim();
  const olderSnapshotId = String(req.query?.olderSnapshotId || '').trim();
  const latestSnapshotId = String(req.query?.latestSnapshotId || '').trim();
  if (!gmbKey) {
    return res.status(400).json({ error: 'gmbKey query parameter is required' });
  }

  try {
    const doc = await readTracking(gmbKey);
    if (!doc) {
      return res.status(404).json({ error: 'No tracking data for this GMB yet' });
    }
    const cmp = buildCompareRows(doc, { olderSnapshotId, latestSnapshotId });
    if (!cmp.ok) {
      return res.status(200).json({ ok: false, ...cmp, gmbKey, businessName: doc.businessName || '' });
    }
    return res.json({ ok: true, ...cmp });
  } catch (e) {
    console.error('[tracking] compare failed', e);
    return res.status(500).json({ error: 'Failed to build comparison' });
  }
}

export async function getTrackingAllRows(req, res) {
  try {
    const rows = await getAllTrackingRows();
    return res.json({ rows });
  } catch (e) {
    console.error('[tracking] all-rows failed', e);
    return res.status(500).json({ error: 'Failed to fetch all tracking rows' });
  }
}

/**
 * Patch traffic fields into rank_history/tracking JSON for a saved snapshot item.
 * If snapshotId is not provided, we patch the newest snapshot that contains the keyword.
 */
export async function postAttachTraffic(req, res) {
  try {
    const keyword = String(req.body?.keyword || '').trim();
    const snapshotId = String(req.body?.snapshotId || '').trim();
    const gmbKeyBody = String(req.body?.gmbKey || '').trim();
    const locationId = String(req.body?.locationId || '').trim();
    const businessName = String(req.body?.businessName || '').trim();

    const gmbKey = gmbKeyBody || makeGmbKey(locationId, businessName);
    if (!gmbKey || !keyword) {
      return res.status(400).json({ error: 'gmbKey (or locationId/businessName) and keyword are required' });
    }

    const patch = {
      target_keyword: req.body?.target_keyword,
      source_month: req.body?.source_month,
      volume: req.body?.volume,
      daily_traffic: req.body?.daily_traffic,
      estimated_clicks: req.body?.estimated_clicks,
      raw_traffic_data: req.body?.raw_traffic_data,
    };

    const result = await upsertTrackingItemTraffic({
      gmbKey,
      snapshotId,
      keyword,
      patch,
    });

    if (!result.ok) {
      return res.status(200).json({ ok: false, ...result });
    }
    return res.json({ ok: true, snapshotId: result.snapshotId, filePath: result.filePath });
  } catch (e) {
    console.error('[tracking] attach-traffic failed', e);
    return res.status(500).json({ error: 'Failed to attach traffic to tracking snapshot' });
  }
}
