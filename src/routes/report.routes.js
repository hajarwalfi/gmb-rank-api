import { Router } from 'express';
import * as ReportController from '../controllers/report.controller.js';

const router = Router();
router.post('/save', ReportController.saveReport);
router.get('/list', ReportController.listReports);
router.delete('/:id', ReportController.deleteReport);
router.get('/:id', ReportController.getReportById);
export default router;
