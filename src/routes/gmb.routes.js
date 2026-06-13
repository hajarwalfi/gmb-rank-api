import { Router } from 'express';
import * as GmbController from '../controllers/gmb.controller.js';

const router = Router();
router.get('/status', GmbController.getGmbStatus);

// GMB listAllLocations can take 40-60s; disable default socket timeouts to prevent 524/RESET
router.get('/all-locations', (req, res, next) => {
  req.socket?.setTimeout?.(0);
  res.setTimeout?.(0);
  next();
}, GmbController.getAllLocations);

router.get('/accounts', GmbController.getAccounts);
router.get('/locations', GmbController.getLocations);
router.get('/location', GmbController.getLocation);
router.get('/monthly-clicks', GmbController.getMonthlyClicks);
router.get('/keyword-count-cache', GmbController.getKeywordCountCache);
router.get('/keyword-counts-summary', GmbController.getKeywordCountsSummary);
router.post('/keyword-count-cache/rebuild', (req, res, next) => {
  req.socket?.setTimeout?.(0);
  res.setTimeout?.(0);
  next();
}, GmbController.rebuildKeywordCountCacheNow);
router.get('/active-from-supabase', GmbController.syncActiveGmbFromSupabase);
router.get('/active-json', GmbController.getActiveGmbJson);
export default router;
