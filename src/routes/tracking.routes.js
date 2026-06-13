import { Router } from 'express';
import * as TrackingController from '../controllers/tracking.controller.js';

const router = Router();

router.post('/save-from-gallery', TrackingController.postSaveFromGallery);
router.post('/attach-traffic', TrackingController.postAttachTraffic);
router.get('/locations', TrackingController.getTrackingLocations);
router.get('/compare', TrackingController.getTrackingCompare);
router.get('/all-rows', TrackingController.getTrackingAllRows);

export default router;
