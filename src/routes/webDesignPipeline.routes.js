import { Router } from 'express';
import * as Controller from '../controllers/webDesignPipelineProgress.controller.js';

const router = Router();

router.get('/progress', Controller.getBatch);
router.post('/progress/batch', Controller.postBatch);
router.patch('/progress/:clientId', Controller.patchOne);

export default router;
