import { getPublicAutomationBanner } from '../services/automationBanner.service.js';

export async function getAutomationStatusBanner(req, res) {
  try {
    const payload = await getPublicAutomationBanner();
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    return res.json(payload);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err || 'automation_banner_failed'),
    });
  }
}
