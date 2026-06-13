import * as Service from '../services/webDesignPipelineProgress.service.js';
import { isMongoReady } from '../db/mongo.js';

export async function getBatch(req, res) {
  try {
    if (!isMongoReady()) {
      return res.status(503).json({ ok: false, error: 'MongoDB is not connected.' });
    }
    const raw = String(req.query.clientIds || '').trim();
    const clientIds = raw
      ? raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    /** Long GET URLs trigger 431 (Request Header Fields Too Large). Use POST /progress/batch instead. */
    if (clientIds.length > 120) {
      return res.status(400).json({
        ok: false,
        error:
          'Too many clientIds for GET. Use POST /api/web-design-pipeline/progress/batch with JSON body { clientIds: string[] }.',
      });
    }
    const rows = await Service.getProgressForClientIds(clientIds);
    return res.json({ ok: true, items: rows });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
}

export async function postBatch(req, res) {
  try {
    if (!isMongoReady()) {
      return res.status(503).json({ ok: false, error: 'MongoDB is not connected.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    let clientIds = [];
    if (Array.isArray(body.clientIds)) {
      clientIds = body.clientIds.map((id) => String(id || '').trim()).filter(Boolean);
    } else if (typeof body.clientIds === 'string') {
      clientIds = String(body.clientIds)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const rows = await Service.getProgressForClientIds(clientIds);
    return res.json({ ok: true, items: rows });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
}

export async function patchOne(req, res) {
  try {
    if (!isMongoReady()) {
      return res.status(503).json({ ok: false, error: 'MongoDB is not connected.' });
    }
    const clientId = String(req.params.clientId || '').trim();
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const out = await Service.upsertProgress(clientId, {
      unlockFrontend: Boolean(body.unlockFrontend),
      unlockBackend: Boolean(body.unlockBackend),
      frontend: body.frontend,
      backend: body.backend,
    });
    return res.json({ ok: true, item: out });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
}
