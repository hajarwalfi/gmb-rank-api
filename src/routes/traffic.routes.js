import { Router } from 'express';
import * as TrafficController from '../controllers/traffic.controller.js';

const router = Router();

router.post('/analyze-demand', TrafficController.analyzeDemand);
router.post('/traffic-tracker', TrafficController.getVolumeLight);

export default router;
