import * as AutomationRunService from '../services/automationRunJob.service.js';

export async function createAutomationRun(req, res) {
  try {
    const {
      accountId,
      locationId,
      selectedLocations = [],
      scheduledAt,
      recurrence = 'once',
      keywords = [],
      timezone = '',
      isAllSelected = false,
      runNow = false,
      /** Optional: caller label for logs (prefer body over custom headers — avoids CORS preflight issues). */
      clientSource = '',
    } = req.body || {};
    if (!scheduledAt && !runNow) {
      return res.status(400).json({
        error: 'Please select a location and a valid schedule time.',
      });
    }
    const hasMulti = Array.isArray(selectedLocations) && selectedLocations.length > 0;
    if (!hasMulti && !isAllSelected && (!accountId || !locationId)) {
      return res.status(400).json({
        error: 'Please select at least one location and a valid schedule time.',
      });
    }
    const scheduledAtIso = runNow ? new Date().toISOString() : String(scheduledAt).trim();
    const out = await AutomationRunService.scheduleAutomationRun({
      accountId: accountId != null ? String(accountId).trim() : '',
      locationId: locationId != null ? String(locationId).trim() : '',
      selectedLocations: hasMulti ? selectedLocations : [{ accountId, locationId }],
      scheduledAtIso,
      recurrence,
      keywords,
      timezone,
      allLocations: Boolean(isAllSelected),
      skipMinLead: Boolean(runNow),
    });
    const clientHint = String(
      clientSource ||
        req.headers['x-automation-client'] ||
        req.headers['x-request-source'] ||
        ''
    ).trim();
    const kwCount = Array.isArray(keywords) ? keywords.length : 0;
    console.log(
      `[AutomationRun] POST /api/automation-runs scheduled job=${out?.job?.id || '?'} immediate=${Boolean(
        runNow
      )} locations=${Number(out?.selectedLocationCount || 0)} selectiveKeywords=${kwCount} recurrence=${String(
        recurrence || 'once'
      )}${clientHint ? ` client=${clientHint}` : ''}`
    );
    return res.json({
      ok: true,
      ...out,
      message: 'Automation run has been scheduled successfully.',
    });
  } catch (err) {
    return res.status(400).json({
      error: String(err?.message || err || 'We could not schedule this automation run right now.'),
    });
  }
}

export async function getLatestActiveAutomationRun(req, res) {
  try {
    const job = await AutomationRunService.getLatestActiveAutomationRun();
    return res.json({ ok: true, job: job || null });
  } catch (err) {
    return res.status(500).json({
      error: String(err?.message || err || 'We could not load active automation status right now.'),
    });
  }
}

export async function stopAutomationRun(req, res) {
  try {
    const { jobId } = req.params;
    const mode = String(req.body?.mode || 'graceful');
    const out = await AutomationRunService.requestStopAutomationRun(jobId, mode);
    return res.json({ ok: true, ...out, message: 'Stop request was accepted.' });
  } catch (err) {
    return res.status(400).json({
      error: String(err?.message || err || 'We could not stop this automation run right now.'),
    });
  }
}

export async function getAutomationRun(req, res) {
  try {
    const { jobId } = req.params;
    const job = await AutomationRunService.getAutomationRunJob(jobId);
    if (!job) return res.status(404).json({ error: 'Automation run not found.' });
    return res.json({ ok: true, job });
  } catch (err) {
    return res.status(500).json({
      error: String(err?.message || err || 'We could not load this automation run right now.'),
    });
  }
}

export async function getActiveAutomationRun(req, res) {
  try {
    const { accountId, locationId } = req.query || {};
    if (!accountId || !locationId) {
      return res.status(400).json({ error: 'Missing accountId or locationId.' });
    }
    const job = await AutomationRunService.getActiveAutomationRunForLocation({
      accountId: String(accountId).trim(),
      locationId: String(locationId).trim(),
    });
    return res.json({ ok: true, job: job || null });
  } catch (err) {
    return res.status(500).json({
      error: String(err?.message || err || 'We could not load active automation status right now.'),
    });
  }
}

export async function getLatestMissingJsonAudit(req, res) {
  try {
    const audit = await AutomationRunService.getLatestAutomationMissingJson();
    return res.json({ ok: true, audit: audit || null });
  } catch (err) {
    return res.status(500).json({
      error: String(err?.message || err || 'We could not load latest missing JSON audit right now.'),
    });
  }
}

export async function getMissingJsonAuditByJob(req, res) {
  try {
    const { jobId } = req.params;
    const audit = await AutomationRunService.getAutomationMissingJsonByJob(jobId);
    if (!audit) return res.status(404).json({ error: 'Missing JSON audit not found for this job.' });
    return res.json({ ok: true, audit });
  } catch (err) {
    return res.status(500).json({
      error: String(err?.message || err || 'We could not load missing JSON audit right now.'),
    });
  }
}
