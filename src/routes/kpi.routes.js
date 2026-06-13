import { Router } from 'express';
import * as KpiMapsSeo from '../controllers/kpiMapsSeo.controller.js';

const router = Router();

router.get('/maps-seo/dashboard', KpiMapsSeo.getMapsSeoDashboard);
router.get('/maps-seo/live', KpiMapsSeo.getMapsSeoLive);
router.post('/maps-seo/monthly-save', KpiMapsSeo.postMonthlySave);

export default router;
