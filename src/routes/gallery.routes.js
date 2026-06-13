import { Router } from 'express';
import * as GalleryController from '../controllers/gallery.controller.js';

const router = Router();

router.post('/gmb-keywords', GalleryController.createGmbKeywordGallery);
router.get('/gmb-keywords/:publicId', GalleryController.getGmbKeywordGallery);

export default router;
