import { Router } from 'express';
import * as DashboardController from '../controllers/dashboard.controller.js';

const router = Router();

router.get('/metrics', DashboardController.getDashboardMetrics);
router.post('/snapshot', DashboardController.triggerSnapshot);

export default router;
