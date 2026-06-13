import * as ReportRepository from '../repositories/report.repository.js';

export async function saveReport(req, res) {
  try {
    const { businessName, results, generatedAt, source } = req.body || {};
    if (!businessName || typeof businessName !== 'string' || !Array.isArray(results)) {
      return res.status(400).json({
        error: 'Invalid body: need businessName (string) and results (array)',
      });
    }
    const name = String(businessName).trim();
    const outcome = await ReportRepository.saveReport({
      businessName: name,
      results,
      generatedAt,
      source,
    });
    if (outcome.duplicate) {
      return res.status(409).json({
        error: 'This report is already saved. Run a new search or change results before saving again.',
        duplicate: true,
      });
    }
    return res.json({
      id: outcome.id,
      message: `Report saved: "${name}" (${results.length} row${results.length === 1 ? '' : 's'}).`,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

export function listReports(req, res) {
  try {
    const reports = ReportRepository.listReports();
    return res.json({ reports });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

export function getReportById(req, res) {
  try {
    const report = ReportRepository.getReportById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    return res.json(report);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

export async function deleteReport(req, res) {
  try {
    const outcome = await ReportRepository.deleteReport(req.params.id);
    if (!outcome || !outcome.deleted) return res.status(404).json({ error: 'Report not found' });
    return res.json({ deleted: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
