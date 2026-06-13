import util from 'util';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import {
  createEarlyCorsMiddleware,
  getCorsOptions,
  logCorsBootSummary,
} from './src/config/corsConfig.js';
import routes from './src/routes/index.js';
import { connectMongo } from './src/db/mongo.js';
import { startHourlyPilotAutomation } from './src/services/hourlyPilotAutomation.service.js';
import { startAutomationRunScheduler } from './src/services/automationRunJob.service.js';
import { startDailyGmbSnapshotCron } from './src/services/gmb.service.js';
import DashboardSnapshotService from './src/services/dashboardSnapshot.service.js';
import { initCombinedCrmSnapshotCron } from './src/services/combinedCrmSnapshotCron.service.js';
import { initAutoConnectGmbRebuildCron } from './src/services/autoConnectGmbRebuildCron.service.js';
import { initBusinessConnectCron } from './src/services/businessConnectCron.service.js';
import { initServicesKeywordsCron } from './src/services/servicesKeywordsSnapshot.service.js';
import { initGmbReviewTrackingCron } from './src/services/gmbReviewTracking.service.js';
import { initGmbReviewMonthlyCron } from './src/services/gmbReviewMonthly.service.js';
import {
  captureCrmApiKeySnapshot,
  restoreCrmApiKeysIfBlanksAfterOverride,
  resolveFormflowCrmApiKey,
} from './src/utils/formflowCrmEnv.js';

/** PM2 pipes stdout — flush each line immediately (incl. during long Playwright work). */
(function installStreamingConsoleForPm2() {
  try {
    if (process.stdout?._handle?.setBlocking) process.stdout._handle.setBlocking(true);
    if (process.stderr?._handle?.setBlocking) process.stderr._handle.setBlocking(true);
  } catch {
    /* ignore */
  }
  const writeLine = (fd, args) => {
    const line = `${util.format(...args)}\n`;
    try {
      fs.writeSync(fd, line);
    } catch {
      (fd === 1 ? process.stdout : process.stderr).write(line);
    }
  };
  console.log = (...args) => writeLine(1, args);
  console.info = console.log;
  console.warn = (...args) => writeLine(2, args);
  console.error = (...args) => writeLine(2, args);
})();

const handleGlobalErr = (type, err) => {
  const message = String(err?.message || err || '');
  const stack = String(err?.stack || '');
  const isPlaywrightAssertion =
    /Assertion error/i.test(message) &&
    /playwright-core|crConnection|crSession/i.test(stack);
  if (type === 'Rejection' && isPlaywrightAssertion) {
    console.warn('[Global Rejection] transient Playwright CDP assertion skipped');
    return;
  }
  console.error(`[Global ${type}]`, message || err);
};
process.on('unhandledRejection', (r) => handleGlobalErr('Rejection', r));
process.on('uncaughtException', (e) => handleGlobalErr('Exception', e));

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Source of truth for this service: google-search-ranking/server/.env (override: true).
// Parent repo .env loads first for shared keys; then server/.env wins.
// .env.example is used only when server/.env does not exist (template / first run).
const parentEnv = path.resolve(__dirname, '../../.env');
const localEnv = path.resolve(__dirname, '.env');
const localExample = path.resolve(__dirname, '.env.example');
dotenv.config({ path: parentEnv });
const crmKeySnapshot = captureCrmApiKeySnapshot();
dotenv.config({ path: localEnv, override: true });
restoreCrmApiKeysIfBlanksAfterOverride(crmKeySnapshot);
if (!fs.existsSync(localEnv) && !(process.env.SERPAPI_API_KEY || '').trim() && fs.existsSync(localExample)) {
  dotenv.config({ path: localExample });
}

const clientHubEnv = path.resolve(__dirname, '../../formflow-buddy/client-hub-admin/.env');
if (fs.existsSync(clientHubEnv)) {
  dotenv.config({ path: clientHubEnv });
  restoreCrmApiKeysIfBlanksAfterOverride(crmKeySnapshot);
}

resolveFormflowCrmApiKey();

const PORT = process.env.PORT || 5524;

const app = express();
app.set('trust proxy', 1);

const corsOptions = getCorsOptions();
app.use(createEarlyCorsMiddleware());
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
logCorsBootSummary();
app.use(express.json());

// ── API routes (must come before static / SPA fallback) ──────────────────────
app.get('/api/health', (_, res) => {
  res.json({ ok: true, service: 'google-search-ranking-api' });
});
app.use('/api', routes);

app.use('/api/outputs', express.static(path.join(__dirname, 'outputs')));

/** Unmatched /api/* must not fall through to React SPA `app.get('*')` (which returns HTML). */
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'api_route_not_found', path: req.originalUrl || req.url });
});

// ── Serve the built React frontend (same-origin — avoids 405 on live servers) ─
// When the client dist is present, every non-API request is handled here so
// relative /api/* paths in the React bundle always resolve to this Express server.
const clientDist = path.resolve(__dirname, '../client/dist');
if (fs.existsSync(clientDist)) {
  const API_ONLY_HOSTS = new Set(['google-search-ranking-api.synoventum.us.cc']);

  // Keep api.* hostname API-only (no SPA on root).
  app.use((req, res, next) => {
    if (API_ONLY_HOSTS.has(String(req.hostname || '').toLowerCase()) && !req.path.startsWith('/api')) {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    return next();
  });

  app.use(express.static(clientDist));
  // SPA fallback: let React Router handle all unknown paths
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
  console.log(`Serving React frontend from: ${clientDist}`);
} else {
  console.log('React client dist not found — frontend must be served separately.');
}

const server = app.listen(PORT, async () => {
  const hasSerp = !!((process.env.SERPAPI_API_KEY || '').trim());
  const hasZen = !!((process.env.SCRAPFLY_API_KEY || process.env.ZENROWS_API_KEY || '').trim());
  const hasDfs =
    !!((process.env.DATAFORSEO_LOGIN || '').trim() && (process.env.DATAFORSEO_PASSWORD || '').trim());
  console.log(`Google Search Ranking API running on http://localhost:${PORT}`);
  console.log(`SerpAPI key: ${hasSerp ? 'set (rank via API)' : 'not set (rank via browser)'}`);
  const scrapflyCountry = ((process.env.SCRAPFLY_PROXY_COUNTRY || '').trim() || 'us');
  console.log(
    `Scrapfly (udm=1 screenshots): ${hasZen ? 'set — capture uses cloud browser' : 'NOT set — capture uses local Playwright + PLAYWRIGHT_PROXY only'}`
  );
  if (hasZen && !(process.env.SCRAPFLY_PROXY_COUNTRY || '').trim()) {
    console.warn(
      'SCRAPFLY_PROXY_COUNTRY not set — exits may be EU/AP; set us (United States) for geo parity.'
    );
  } else if (hasZen) {
    console.log(`Scrapfly proxy_country: ${process.env.SCRAPFLY_PROXY_COUNTRY || 'us'}`);
  }
  console.log(
    `DataForSEO: ${hasDfs ? 'set — POST /api/ranking/capture-screenshot + useDataForSeo: true' : 'not set'}`
  );
  try {
    await connectMongo();
    startDailyGmbSnapshotCron();
  } catch (e) {
    console.error('[mongo/cron bootstrap] startup failed:', e?.message || e);
  }
  // Optional single nightly pipeline (autoconnect → business-connect → services-keywords → active-gmb).
  initCombinedCrmSnapshotCron();
  // Auto-connected GMB JSON (~03:30 IST default) — CRM rebuild → server/data + GET /api/gmbautoconnect.
  initAutoConnectGmbRebuildCron();
  // Business-connect JSON (~04:00 IST default) — paying clients link + reason + reviews.
  initBusinessConnectCron();
  /** Replaces legacy `gmb_keyword_counts.json` nightly job — paying CRM + GBP → `services-keywords.json` (default UTC 21:00). */
  initServicesKeywordsCron();
  // Cumulative monthly review totals (services-keywords pool) → `gmb-review-monthly.json` (~15m after keywords cron).
  initGmbReviewMonthlyCron();
  // GMB last-review age for paying linked clients → `gmb-review-tracking.json` (default ~00:00 IST).
  initGmbReviewTrackingCron();
  // Supabase + JSON only — does not require Mongo.
  DashboardSnapshotService.initCron();
  // Always bootstrap automation scheduler — it retries until MongoDB is reachable.
  await startAutomationRunScheduler().catch((e) =>
    console.error('[AutomationRun] scheduler bootstrap error:', e?.message || e)
  );

  const enableHourlyPilot =
    String(process.env.ENABLE_HOURLY_PILOT_CRON || 'true').toLowerCase() === 'true';
  if (enableHourlyPilot) {
    startHourlyPilotAutomation();
  } else {
    console.log('[PilotCron] Disabled (ENABLE_HOURLY_PILOT_CRON=false)');
  }
});

// Allow long-running capture (manual CAPTCHA in Playwright) without request timeout.
server.requestTimeout = 0;
if (typeof server.setTimeout === 'function') server.setTimeout(0);
