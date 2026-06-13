import { isMongoReady } from '../db/mongo.js';
import { AutomationRunJob } from '../models/AutomationRunJob.js';

/**
 * After `services-keywords.json` gains new keyword rows, run the same automation pipeline once,
 * batched across all new rows. Jobs use `hideFromBanner: true` so recurring / idle schedules stay visible in Client Hub.
 *
 * Skips enqueue when a visible **Select All** job is already running — that run merges new snapshot
 * targets on the fly (`buildSupabaseTargetsWithMinKeywords`).
 */
export async function enqueueBackgroundOnboardingForKeywordRows(rows) {
  if (!isMongoReady()) {
    console.warn('[ServicesKeywords/onboarding] Mongo not connected — skipping auto onboarding.');
    return { ok: false, reason: 'mongo_unavailable' };
  }

  const list = Array.isArray(rows) ? rows : [];
  const selectedLocations = list
    .map((r) => ({
      accountId: String(r?.accountId || '').trim(),
      locationId: String(r?.locationIdShort || r?.locationId || '').trim(),
      title: String(r?.gmbName || r?.business_name || '').trim(),
    }))
    .filter((t) => t.accountId && t.locationId);

  const dedup = new Map();
  for (const t of selectedLocations) {
    dedup.set(`${t.accountId}::${t.locationId}`, t);
  }
  const uniq = [...dedup.values()];
  if (!uniq.length) {
    return { ok: true, reason: 'nothing_to_enqueue' };
  }

  const runningSelectAll = await AutomationRunJob.findOne({
    status: 'running',
    allLocations: true,
    hideFromBanner: { $ne: true },
  }).lean();

  if (runningSelectAll?._id) {
    console.log(
      `[ServicesKeywords/onboarding] Skipping hidden onboarding (${uniq.length} loc(s)): visible Select All already running jobId=${String(runningSelectAll._id)}`
    );
    return { ok: true, skipped: 'select_all_running', deferredCount: uniq.length };
  }

  const { scheduleAutomationRun } = await import('./automationRunJob.service.js');
  const out = await scheduleAutomationRun({
    accountId: uniq[0].accountId,
    locationId: uniq[0].locationId,
    selectedLocations: uniq,
    scheduledAtIso: new Date().toISOString(),
    recurrence: 'once',
    keywords: [],
    timezone: '',
    allLocations: false,
    skipMinLead: true,
    hideFromBanner: true,
  });

  console.log(
    `[ServicesKeywords/onboarding] Enqueued hidden automation jobId=${out?.job?.id || '?'} targets=${uniq.length}`
  );
  return { ok: true, ...out };
}
