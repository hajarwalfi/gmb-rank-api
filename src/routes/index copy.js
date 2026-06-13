import { Router } from 'express';
import rankingRoutes from './ranking.routes.js';
import reportRoutes from './report.routes.js';
import gmbRoutes from './gmb.routes.js';
import galleryRoutes from './gallery.routes.js';
import trackingRoutes from './tracking.routes.js';
import automationRunRoutes from './automationRun.routes.js';
import historyRoutes from './history.routes.js';
import trafficRoutes from './traffic.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import webDesignPipelineRoutes from './webDesignPipeline.routes.js';
import kpiRoutes from './kpi.routes.js';
import * as OnboardingController from '../controllers/onboarding.controller.js';
import * as GmbController from '../controllers/gmb.controller.js';
import * as AutomationBannerController from '../controllers/automationBanner.controller.js';

const router = Router();

/** Ranking + Client Hub header: Idle / Running + next scheduled automation (Mongo + pilot awareness). */
router.get('/automation/status-banner', AutomationBannerController.getAutomationStatusBanner);

/** Client Hub: same JSON as rebuild script; typo route kept for backwards compatibility. */
router.get('/gmbautoconnect', GmbController.getAutoConnectedGmbPublicSnapshot);
router.get('/gmbautoconeect', GmbController.getAutoConnectedGmbPublicSnapshot);
router.post('/gmbautoconnect/rebuild', GmbController.rebuildAutoConnectedGmbSnapshot);
router.get('/business-connect', GmbController.getBusinessConnectSnapshot);
router.post('/business-connect/rebuild', GmbController.rebuildBusinessConnectSnapshot);

router.get('/gmb-review-tracking', GmbController.getGmbReviewTrackingSnapshot);
router.get('/gmb-review-tracking/frequency-lists', GmbController.getGmbReviewFrequencyLists);
router.post('/gmb-review-tracking/mark-done', GmbController.postGmbReviewTrackingMarkDone);
router.post('/gmb-review-tracking/rebuild', (req, res, next) => {
  req.socket?.setTimeout?.(0);
  res.setTimeout?.(0);
  next();
}, GmbController.rebuildGmbReviewTrackingSnapshot);

router.get('/services-keywords', GmbController.getServicesKeywordsSnapshot);
router.get('/services-keywords/for-location', GmbController.getServicesKeywordsForLocation);
router.get('/services-keywords/for-client', GmbController.getServicesKeywordsForClient);
router.get('/services-keywords/missing-history', GmbController.getServicesKeywordsMissingHistory);
router.get('/services-keywords/manual-run-eligible', GmbController.getManualRunEligibility);
router.post('/services-keywords/rebuild', (req, res, next) => {
  req.socket?.setTimeout?.(0);
  res.setTimeout?.(0);
  next();
}, GmbController.rebuildServicesKeywordsSnapshot);

router.use('/ranking', rankingRoutes);
router.use('/report', reportRoutes);
router.use('/gmb', gmbRoutes);
router.use('/gallery', galleryRoutes);
router.use('/tracking', trackingRoutes);
router.use('/automation-runs', automationRunRoutes);
router.use('/history', historyRoutes);
router.use('/traffic', trafficRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/web-design-pipeline', webDesignPipelineRoutes);
router.use('/kpi', kpiRoutes);

// New cleaner onboarding routes
router.post('/onboarding/analyze', OnboardingController.handleFormSubmission);
router.get('/onboarding/report/:taskId', OnboardingController.getOnboardingReportByTaskId);
router.get('/onboarding/report-by-id/:reportId', OnboardingController.getOnboardingReportById);

// Multi-stage onboarding routes (Wait-Free API)
router.post('/onboarding/init', OnboardingController.initOnboardingAnalysis);
router.post('/onboarding/analyze-batch', OnboardingController.analyzeOnboardingBatch);
router.post('/onboarding/finalize', OnboardingController.finalizeOnboardingReport);

// Fathom API Key routes
router.post('/onboarding/fathom-api-key', OnboardingController.initWithFathomApiKey);
router.get('/onboarding/fathom-meetings', OnboardingController.getFathomMeetings);

// Legacy routes (backward compatibility)
router.post('/onboarding-form-submission', OnboardingController.handleFormSubmission);
router.get('/onboarding-grades', OnboardingController.getOnboardingGrades);

export default router;
