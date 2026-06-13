import { Router } from 'express';
import * as AutomationRunController from '../controllers/automationRun.controller.js';

const router = Router();

router.post('/', AutomationRunController.createAutomationRun);
router.get('/active', AutomationRunController.getActiveAutomationRun);
router.get('/active-latest', AutomationRunController.getLatestActiveAutomationRun);
router.get('/missing-json/latest', AutomationRunController.getLatestMissingJsonAudit);
router.get('/:jobId/missing-json', AutomationRunController.getMissingJsonAuditByJob);
router.post('/:jobId/stop', AutomationRunController.stopAutomationRun);
router.get('/:jobId', AutomationRunController.getAutomationRun);

export default router;
