import DashboardSnapshotService from '../services/dashboardSnapshot.service.js';

export const getDashboardMetrics = async (req, res) => {
  try {
    const data = await DashboardSnapshotService.getMetricsWithDeltas();
    res.json(data);
  } catch (error) {
    console.error('[DashboardController] Error fetching metrics:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard metrics' });
  }
};

export const triggerSnapshot = async (req, res) => {
  try {
    const align = String(req.body?.alignBaseline ?? req.query?.alignBaseline ?? '').toLowerCase() === 'true';
    if (align) {
      const snapshot = await DashboardSnapshotService.alignWeeklyBaselineToCurrent();
      return res.json({ message: 'Weekly baseline aligned to current metrics (+0 deltas until counts change)', snapshot });
    }
    const snapshot = await DashboardSnapshotService.takeSnapshot();
    res.json({ message: 'Snapshot captured successfully', snapshot });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
