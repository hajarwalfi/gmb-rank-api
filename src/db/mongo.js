import mongoose from 'mongoose';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Same MongoDB as the rest of the repo (`config/database.js`).
 * Optional override: set MONGODB_URI / MONGODB_DB_NAME in env (e.g. google-search-ranking/server/.env).
 */
function loadRootDatabaseConfig() {
  try {
    const abs = path.resolve(__dirname, '../../config/database.js');
    const mod = require(abs);
    const uri = mod.MONGODB_URI != null ? String(mod.MONGODB_URI).trim() : '';
    const dbName =
      mod.MONGODB_DB_NAME != null ? String(mod.MONGODB_DB_NAME).trim() : '';
    return { uri, dbName: dbName || undefined };
  } catch (e) {
    console.warn(
      '[mongo] Could not load root config/database.js — gallery DB disabled.',
      e.message
    );
    return { uri: '', dbName: undefined };
  }
}

export async function connectMongo() {
  let uri = (process.env.MONGODB_URI || '').trim();
  let dbName = (process.env.MONGODB_DB_NAME || '').trim() || undefined;

  if (!uri) {
    const root = loadRootDatabaseConfig();
    uri = root.uri;
    if (!dbName) dbName = root.dbName;
  }

  if (!uri) {
    console.warn(
      '[mongo] No MongoDB URI — set MONGODB_URI or configure config/database.js (root).'
    );
    return false;
  }

  if (mongoose.connection.readyState === 1) return true;

  try {
    await mongoose.connect(uri, {
      ...(dbName ? { dbName } : {}),
      serverSelectionTimeoutMS: 5000,
    });
    console.log(
      `[mongo] connected for GMB gallery — db: ${mongoose.connection.name}`
    );
    return true;
  } catch (e) {
    console.error('[mongo] connection failed', e?.message || e);
    console.error(
      '[mongo] Tip: whitelist this machine in Atlas if using mongodb+srv://'
    );
    return false;
  }
}

export function isMongoReady() {
  return mongoose.connection.readyState === 1;
}
