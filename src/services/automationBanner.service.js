import { isMongoReady } from '../db/mongo.js';
import { AutomationRunJob } from '../models/AutomationRunJob.js';
import { isPilotHourlyAutomationRunning } from './hourlyPilotAutomation.service.js';

function nextDailyMaintenanceIso() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(2, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

function ceilWholeDaysBetween(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  const diff = toMs - fromMs;
  if (diff <= 0) return 0;
  return Math.ceil(diff / 86_400_000);
}

export async function getPublicAutomationBanner() {
  const now = Date.now();

  if (isPilotHourlyAutomationRunning()) {
    return {
      ok: true,
      state: 'running',
      source: 'pilot',
      pillLabel: 'Running',
      detail: 'Pilot automation is executing',
      nextRunIso: null,
      daysUntilNext: null,
      jobId: null,
    };
  }

  if (isMongoReady()) {
    const runningLean = await AutomationRunJob.findOne({
      status: 'running',
      hideFromBanner: { $ne: true },
    })
      .sort({ updatedAt: -1 })
      .lean();

    if (runningLean?._id) {
      const name =
        String(runningLean.businessName || '').trim() ||
        String(runningLean.locationTitle || '').trim() ||
        'Automation';

      return {
        ok: true,
        state: 'running',
        source: 'automation_run',
        pillLabel: 'Running',
        detail: `${name}`,
        nextRunIso: null,
        daysUntilNext: null,
        jobId: String(runningLean._id),
      };
    }

    const nextScheduled = await AutomationRunJob.findOne({
      status: 'scheduled',
      hideFromBanner: { $ne: true },
    })
      .sort({ scheduledAt: 1 })
      .lean();

    if (nextScheduled?.scheduledAt) {
      const at = new Date(nextScheduled.scheduledAt).getTime();
      const days = ceilWholeDaysBetween(now, at);
      const biz =
        String(nextScheduled.businessName || '').trim() ||
        String(nextScheduled.locationTitle || '').trim() ||
        '';

      const dayPart =
        days === null
          ? ''
          : days === 0
            ? 'Next automation due soon.'
            : `Next automation in ${days} day${days === 1 ? '' : 's'}.`;
      const bizPart = biz ? ` ${biz}` : '';

      return {
        ok: true,
        state: 'idle',
        source: 'automation_run',
        pillLabel: 'Idle',
        detail: `${dayPart}${bizPart}`.trim(),
        nextRunIso: new Date(at).toISOString(),
        daysUntilNext: days,
        recurrence: nextScheduled.recurrence || 'once',
        jobId: String(nextScheduled._id),
      };
    }
  }

  const nextIso = nextDailyMaintenanceIso();
  const at = new Date(nextIso).getTime();
  const days = ceilWholeDaysBetween(now, at);

  const dayPart =
    days === null
      ? 'No scheduled Mongo automation.'
      : days === 0
        ? 'Nightly server sync due soon.'
        : `Next nightly sync in ${days} day${days === 1 ? '' : 's'} (~2 AM server).`;

  return {
    ok: true,
    state: 'idle',
    source: 'daily_maintenance',
    pillLabel: 'Idle',
    detail: dayPart,
    nextRunIso: nextIso,
    daysUntilNext: days,
    jobId: null,
  };
}
