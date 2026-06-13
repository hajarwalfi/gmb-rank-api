import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getHistory, getAllBusinessIds } from './historyManager.js';
import { readKeywordCountCache } from './gmbKeywordCountCache.service.js';
import {
  bareLocationIdFromBusinessId,
  countLatestScanRankScreenshotKeywords,
  qualifiedDashboardLocationIds,
} from './dashboardMetricsLens.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Bump when dashboard metric definitions change so weeklyBaseline resets once (+0 deltas). */
/** Bump when pool / baseline semantics change so production resets weeklyBaseline (avoids stale −119 style deltas). */
const DASHBOARD_METRICS_DEF_VERSION = 9;

const SNAPSHOT_FILE = path.join(__dirname, '../data/dashboard_snapshots.json');
const CRON_LOG_JSONL = path.join(__dirname, '../data/paying_gbp_dashboard_cron.jsonl');
const CRON_LAST_JSON = path.join(__dirname, '../data/paying_gbp_dashboard_cron_last.json');

/** Next run at ~03:00 IST (fixed offset UTC+5:30) → same wall clock as 21:30 UTC daily boundary. */
function msUntilNextDashboardCronUtc() {
  const utcH = Number(process.env.DASHBOARD_CRON_UTC_HOUR ?? 21);
  const utcM = Number(process.env.DASHBOARD_CRON_UTC_MINUTE ?? 30);
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcH, utcM, 0, 0));
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return Math.max(15_000, target.getTime() - now.getTime());
}

function appendDashboardCronLog(payload) {
  try {
    const dir = path.dirname(CRON_LOG_JSONL);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const rec = { ts: new Date().toISOString(), ...payload };
    fs.appendFileSync(CRON_LOG_JSONL, `${JSON.stringify(rec)}\n`, 'utf8');
    fs.writeFileSync(CRON_LAST_JSON, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
  } catch (e) {
    console.warn('[DashboardSnapshot] cron log write failed:', e?.message || e);
  }
}

class DashboardSnapshotService {
  constructor() {
    this.ensureDataDir();
    this._payingGbpCronTimer = null;
  }

  ensureDataDir() {
    const dir = path.dirname(SNAPSHOT_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(SNAPSHOT_FILE)) {
      fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({
        metricsDefinitionVersion: 0,
        weeklyBaseline: null,
        lastDailySnapshot: null,
        previousWeekClosed: null,
        history: [],
      }, null, 2));
    }
  }

  async calculateCurrentMetrics() {
    try {
      // 1. Fetch Locations from Supabase (Categorized by Access/Niche)
      const { readActiveGmbJson } = await import('./supabaseGmb.service.js');
      const supabaseData = await readActiveGmbJson();
      // Only businesses with BOTH GBP and Niche (Score 0) are "active" for tracking in the main tabs
      // These are stored in the 'count' list in the new structure
      const locations = supabaseData?.count || [];

      const activePlainIds = new Set(
        locations.map((l) => String(l?.id || '').trim()).filter(Boolean)
      );

      /** Legacy field from stats-history; dashboard deltas use weeklyBaseline vs current instead. */
      const gmbAccountsAddedThisWeek = Number(supabaseData?.newThisWeek ?? 0) || 0;

      const kwCache = await readKeywordCountCache();
      /** Fallback: legacy — active `count` ∩ keyword cache with generated keyword count in [1..6]. */
      const qualifiedIds = qualifiedDashboardLocationIds(activePlainIds, kwCache);
      /** Primary: paying CRM + GMB-linked pool size (`services-keywords.json` summary.totalEligible). */
      const { readServicesKeywordsPayload } = await import('./servicesKeywordsSnapshot.service.js');
      const sk = await readServicesKeywordsPayload();
      /** Prefer snapshot summary even if `rows` failed to hydrate (trust `totalEligible` once snapshot exists). */
      const rawEligible = sk?.summary?.totalEligible;
      const skEligible = Number(rawEligible);
      const hasEligibleSummary =
        sk?.summary &&
        typeof rawEligible === 'number' &&
        Number.isFinite(skEligible) &&
        skEligible >= 0 &&
        (sk.generatedAt != null || (Array.isArray(sk.rows) && sk.rows.length > 0));
      const gmbAccounts = hasEligibleSummary ? skEligible : qualifiedIds.size;

      // 1b. Load GMB Snapshot to map Names -> Real Location IDs (Automation history uses locations/123)
      const { readLocationsSnapshot } = await import('./gmb.service.js');
      const { businesses: gmbConnected } = await readLocationsSnapshot();

      const normalize = (v) =>
        String(v || '')
          .toLowerCase()
          .replace(/[’']/g, '')
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();
      const gmbMap = new Map();
      for (const b of gmbConnected) {
        const name = normalize(b.title || b.gmbName || '');
        if (name && !gmbMap.has(name)) gmbMap.set(name, b.locationId);
      }

      let keywordsTracked = 0;
      let dailyTraffic = 0;
      let totalReviews = 0;

      // 1c. Iterate through paying+active locations and find history via GMB Location ID or CRM UUID
      for (const loc of locations) {
        const crmId = String(loc.id).trim();
        if (!activePlainIds.has(crmId)) continue;

        const name = normalize(loc.business_name || '');
        const gmbLocId = gmbMap.get(name);

        // Try GMB Location ID formats and CRM UUID
        let detail = null;
        if (gmbLocId) {
          const shortId = gmbLocId.includes('/') ? gmbLocId.split('/').pop() : gmbLocId;
          const candidates = [
            `loc:${gmbLocId}`,
            `loc:${shortId}`,
            gmbLocId,
            shortId
          ];
          for (const cand of candidates) {
            detail = await getHistory(cand);
            if (detail) break;
          }
        }
        if (!detail) {
          detail = await getHistory(crmId);
        }

        if (!detail) continue;

        const scans = Array.isArray(detail?.scans) ? detail.scans : [];
        const latest = scans.length ? scans[0] : {};

        if (qualifiedIds.has(crmId)) {
          keywordsTracked += countLatestScanRankScreenshotKeywords(detail);
        }

        totalReviews += Number(latest?.reviews?.total_count || 0);

        const stats = this.computeDailyMetrics(scans);
        dailyTraffic += stats.avgDailyVisits;
      }

      return {
        gmbAccounts,
        gmbAccountsAddedThisWeek,
        keywordsTracked,
        dailyTraffic: Math.round(dailyTraffic),
        reviews: totalReviews,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('[DashboardSnapshot] Error calculating metrics:', error);
      throw error;
    }
  }

  computeDailyMetrics(scans = []) {
    const getDaysInMonth = (s) => {
      if (!s || s === 'N/A') return 30;
      const [m, y] = s.split('/').map(Number);
      if (!m || !y) return 30;
      return new Date(y, m, 0).getDate();
    };

    const keywordPoints = new Map();
    const orderedScans = [...scans].sort((a, b) => new Date(a.scanned_at) - new Date(b.scanned_at));

    for (const scan of orderedScans) {
      const ts = new Date(scan.scanned_at).getTime();
      const rows = Array.isArray(scan.map_ranks) ? scan.map_ranks : [];
      for (const row of rows) {
        const key = String(row.keyword || '').trim().toLowerCase();
        if (!key) continue;

        let visits = Number(row.daily_traffic) || 0;
        if (!visits && row.volume > 0) {
          const raw = row.raw_traffic_data || {};
          const gbpDays = Math.max(1, Number(raw.reporting_days ?? raw.daysElapsed) || 0);
          if (gbpDays > 0) {
            visits = Math.round((Number(row.volume) / gbpDays) * 100) / 100;
          } else {
            visits = Math.round((Number(row.volume) / getDaysInMonth(row.source_month)) * 100) / 100;
          }
        }

        if (!keywordPoints.has(key)) keywordPoints.set(key, []);
        keywordPoints.get(key).push({ ts, visits });
      }
    }

    let totalAvgLastTwo = 0;
    for (const points of keywordPoints.values()) {
      const sorted = points.sort((a, b) => a.ts - b.ts);
      const lastTwo = sorted.slice(-2);
      if (!lastTwo.length) continue;
      totalAvgLastTwo += lastTwo.reduce((sum, p) => sum + p.visits, 0) / lastTwo.length;
    }

    return { avgDailyVisits: totalAvgLastTwo };
  }

  async takeSnapshot() {
    console.log('[DashboardSnapshot] Starting daily snapshot capture...');
    const current = await this.calculateCurrentMetrics();
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));

    const now = new Date();
    const lastBaselineDate = data.weeklyBaseline ? new Date(data.weeklyBaseline.timestamp) : null;
    const isNewWeek = !lastBaselineDate || this.getWeekNumber(now) !== this.getWeekNumber(lastBaselineDate);

    if (isNewWeek) {
      /** Last reading before this ISO week (e.g. Sunday night) — optional reference for “last week close”. */
      data.previousWeekClosed = data.lastDailySnapshot || data.weeklyBaseline || null;
      console.log('[DashboardSnapshot] New ISO week — baseline reset to this run; previousWeekClosed stored.');
      data.weeklyBaseline = { ...current };
    }

    data.lastDailySnapshot = { ...current };
    data.history.push(current);
    
    if (data.history.length > 30) data.history.shift();

    data.metricsDefinitionVersion = DASHBOARD_METRICS_DEF_VERSION;
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2));
    console.log('[DashboardSnapshot] Snapshot saved successfully.');
    return current;
  }

  getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    var weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return weekNo;
  }

  async getMetricsWithDeltas() {
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));

    /** On metric-def bump: pin only `weeklyBaseline.gmbAccounts` to live CRM paying count (+0 on that card); keep other baseline fields intact. */
    if (Number(data.metricsDefinitionVersion ?? 0) < DASHBOARD_METRICS_DEF_VERSION) {
      const currentAligned = await this.calculateCurrentMetrics();
      const prevBaseline = data.weeklyBaseline && typeof data.weeklyBaseline === 'object' ? data.weeklyBaseline : {};
      data.weeklyBaseline = {
        ...prevBaseline,
        gmbAccounts: currentAligned.gmbAccounts,
        gmbAccountsAddedThisWeek: Number(
          currentAligned.gmbAccountsAddedThisWeek ?? prevBaseline.gmbAccountsAddedThisWeek ?? 0,
        ),
      };
      data.metricsDefinitionVersion = DASHBOARD_METRICS_DEF_VERSION;
      fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2));
      console.log(
        `[DashboardSnapshot] metrics v${DASHBOARD_METRICS_DEF_VERSION}: baseline.gmbAccounts = ${currentAligned.gmbAccounts} (CRM paying total); other baseline keys preserved.`,
      );
    }

    const current = await this.calculateCurrentMetrics();

    const baseline = data.weeklyBaseline || current;

    const gmbB = Number(baseline.gmbAccounts ?? 0);
    const kwB = Number(baseline.keywordsTracked ?? 0);
    const trB = Number(baseline.dailyTraffic ?? 0);
    const rvB = Number(baseline.reviews ?? 0);

    return {
      current,
      deltas: {
        gmbAccounts: Number(current.gmbAccounts ?? 0) - gmbB,
        keywordsTracked: Number(current.keywordsTracked ?? 0) - kwB,
        dailyTraffic: Number(current.dailyTraffic ?? 0) - trB,
        reviews: Number(current.reviews ?? 0) - rvB,
      },
      weeklyBaseline: baseline,
      previousWeekClosed: data.previousWeekClosed || null,
    };
  }

  /** Pin weeklyBaseline to live metrics so all deltas read 0 until the week rolls or counts move. */
  async alignWeeklyBaselineToCurrent() {
    const current = await this.calculateCurrentMetrics();
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    data.weeklyBaseline = { ...current };
    data.lastDailySnapshot = { ...current };
    data.metricsDefinitionVersion = DASHBOARD_METRICS_DEF_VERSION;
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2));
    console.log('[DashboardSnapshot] weeklyBaseline aligned to current metrics.');
    return current;
  }

  /**
   * Daily (~03:00 IST default): Supabase sync (paying + Active + GBP access) → dashboard_snapshots.json.
   * Dashboard + GMB Accounts tabs read from these files / same metrics API.
   */
  initCron() {
    const enabled = String(process.env.ENABLE_PAYING_GBP_DASHBOARD_CRON ?? 'true').toLowerCase() !== 'false';
    if (!enabled) {
      console.log('[DashboardSnapshot] Paying+GBP dashboard cron disabled (ENABLE_PAYING_GBP_DASHBOARD_CRON=false)');
      return;
    }

    const runPipeline = async (source) => {
      const out = { source, supabaseOk: false, snapshotOk: false };
      try {
        const { syncActiveGmbFromSupabase } = await import('./supabaseGmb.service.js');
        await syncActiveGmbFromSupabase();
        out.supabaseOk = true;
      } catch (e) {
        out.supabaseError = String(e?.message || e);
        console.error('[DashboardSnapshot] Supabase sync failed:', out.supabaseError);
      }
      try {
        const snap = await this.takeSnapshot();
        out.snapshotOk = true;
        out.metrics = {
          gmbAccounts: snap?.gmbAccounts,
          keywordsTracked: snap?.keywordsTracked,
          dailyTraffic: snap?.dailyTraffic,
          reviews: snap?.reviews,
        };
      } catch (e) {
        out.snapshotError = String(e?.message || e);
        console.error('[DashboardSnapshot] takeSnapshot failed:', out.snapshotError);
      }
      appendDashboardCronLog(out);
    };

    void runPipeline('startup');

    const scheduleNext = () => {
      const delay = msUntilNextDashboardCronUtc();
      const next = new Date(Date.now() + delay);
      console.log(
        `[DashboardSnapshot] next paying+GBP sync + dashboard snapshot at ${next.toISOString()} (~03:00 IST if cron UTC=21:30)`
      );
      this._payingGbpCronTimer = setTimeout(async () => {
        this._payingGbpCronTimer = null;
        await runPipeline('scheduled');
        scheduleNext();
      }, delay);
    };

    scheduleNext();
  }
}

export default new DashboardSnapshotService();
