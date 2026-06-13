import { isMongoReady } from '../db/mongo.js';
import { WebDesignPipelineProgress } from '../models/WebDesignPipelineProgress.js';

function defaultTrack() {
  return {
    started: false,
    inProgress: false,
    inProgressBy: '',
    finished: false,
    finishedBy: '',
  };
}

function normalizeTrack(t) {
  const d = t && typeof t === 'object' ? t : {};
  return {
    started: Boolean(d.started),
    inProgress: Boolean(d.inProgress),
    inProgressBy: String(d.inProgressBy || '').trim().slice(0, 120),
    finished: Boolean(d.finished),
    finishedBy: String(d.finishedBy || '').trim().slice(0, 120),
  };
}

function serializeDoc(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    clientId: String(o.clientId || '').trim(),
    frontend: normalizeTrack(o.frontend),
    backend: normalizeTrack(o.backend),
    updatedAt: o.updatedAt || null,
  };
}

function mergeTrack(base, partial) {
  const out = { ...base };
  if (!partial || typeof partial !== 'object') return out;
  if (partial.started !== undefined) out.started = Boolean(partial.started);
  if (partial.inProgress !== undefined) {
    out.inProgress = Boolean(partial.inProgress);
    if (!out.inProgress) out.inProgressBy = '';
    else if (partial.inProgressBy !== undefined) out.inProgressBy = String(partial.inProgressBy || '').trim().slice(0, 120);
  } else if (partial.inProgressBy !== undefined && out.inProgress) {
    out.inProgressBy = String(partial.inProgressBy || '').trim().slice(0, 120);
  }
  if (partial.finished !== undefined) {
    out.finished = Boolean(partial.finished);
    if (!out.finished) out.finishedBy = '';
    else if (partial.finishedBy !== undefined) out.finishedBy = String(partial.finishedBy || '').trim().slice(0, 120);
  } else if (partial.finishedBy !== undefined && out.finished) {
    out.finishedBy = String(partial.finishedBy || '').trim().slice(0, 120);
  }
  return out;
}

/**
 * @param {string[]} clientIds
 */
export async function getProgressForClientIds(clientIds) {
  if (!isMongoReady()) {
    throw new Error('Database is not connected.');
  }
  const ids = [...new Set((clientIds || []).map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 2500);
  if (!ids.length) return [];

  const rows = await WebDesignPipelineProgress.find({ clientId: { $in: ids } }).lean();
  const byId = new Map(rows.map((r) => [String(r.clientId), r]));

  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) {
      return {
        clientId: id,
        frontend: defaultTrack(),
        backend: defaultTrack(),
        updatedAt: null,
      };
    }
    return serializeDoc(row);
  });
}

/**
 * @param {string} clientId
 * @param {{
 *   unlockFrontend?: boolean,
 *   unlockBackend?: boolean,
 *   frontend?: Record<string, unknown>,
 *   backend?: Record<string, unknown>,
 * }} patch
 */
export async function upsertProgress(clientId, patch = {}) {
  if (!isMongoReady()) {
    throw new Error('Database is not connected.');
  }
  const cid = String(clientId || '').trim();
  if (!cid) throw new Error('clientId is required.');

  const existing = await WebDesignPipelineProgress.findOne({ clientId: cid }).lean();
  let fe = normalizeTrack(existing?.frontend);
  let be = normalizeTrack(existing?.backend);

  if (patch.unlockFrontend) fe.started = true;
  if (patch.unlockBackend) be.started = true;

  if (patch.frontend) fe = mergeTrack(fe, patch.frontend);
  if (patch.backend) be = mergeTrack(be, patch.backend);

  if (fe.inProgress && !fe.inProgressBy) throw new Error('Name is required when Front-end In progress is checked.');
  if (fe.finished && !fe.finishedBy) throw new Error('Name is required when Front-end Finished is checked.');
  if (be.inProgress && !be.inProgressBy) throw new Error('Name is required when Back-end In progress is checked.');
  if (be.finished && !be.finishedBy) throw new Error('Name is required when Back-end Finished is checked.');

  const doc = await WebDesignPipelineProgress.findOneAndUpdate(
    { clientId: cid },
    { $set: { clientId: cid, frontend: fe, backend: be } },
    { new: true, upsert: true, runValidators: true },
  );

  return serializeDoc(doc);
}
