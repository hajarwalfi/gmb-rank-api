import { Router } from 'express';
import * as RankingController from '../controllers/ranking.controller.js';

const router = Router();

/** Playwright + manual CAPTCHA can exceed default socket timeouts. */
function allowLongCapture(req, res, next) {
  req.socket?.setTimeout?.(0);
  res.setTimeout?.(0);
  next();
}

/**
 * Cloudflare can return 524 around ~100s if no response is sent.
 * Return a controlled 504 JSON before that threshold to avoid browser-side pseudo-CORS failures.
 */
function captureEdgeTimeoutGuard(req, res, next) {
  const timeoutMs = Math.max(30_000, Number(process.env.CAPTURE_EDGE_TIMEOUT_MS) || 120_000);
  const originalJson = res.json.bind(res);
  // Prevent noisy "headers already sent" crashes if a long async branch resolves after timeout response.
  res.json = (payload) => {
    if (res.headersSent || res.writableEnded) return res;
    return originalJson(payload);
  };
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({
        error:
          'The screenshot request took longer than expected. Please retry, or use fewer parallel captures.',
        transientErrorKind: 'timeout',
        suppressToast: true,
      });
    }
  }, timeoutMs);
  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));
  next();
}

// SerpAPI JSON Routes
router.post('/keywords', RankingController.getKeywords);
router.post('/run', RankingController.runRanking);
router.post('/automated-run', allowLongCapture, RankingController.runAutomatedRanking);
router.post('/places-udm1-list', allowLongCapture, RankingController.getPlacesUdm1List);
router.post('/capture-screenshot', allowLongCapture, captureEdgeTimeoutGuard, RankingController.captureScreenshot);
export default router;
