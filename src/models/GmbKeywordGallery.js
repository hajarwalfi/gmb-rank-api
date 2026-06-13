import mongoose from 'mongoose';

const itemSchema = new mongoose.Schema({
  keyword: { type: String, required: true, trim: true },
  screenshotPath: { type: String, required: true, trim: true },
  rank: { type: Number, default: null },
  page: { type: Number, default: null },
  target_keyword: { type: String, default: null },
  source_month: { type: String, default: null },
  volume: { type: Number, default: 0 },
  daily_traffic: { type: Number, default: 0 },
  estimated_clicks: { type: Number, default: 0 },
  raw_traffic_data: { type: mongoose.Schema.Types.Mixed, default: null }
}, { _id: false });

const gmbKeywordGallerySchema = new mongoose.Schema({
  publicId: { type: String, required: true, unique: true, index: true },
  businessName: { type: String, default: '' },
  locationHint: { type: String, default: '' },
  accountId: { type: String, default: '' },
  locationId: { type: String, default: '' },
  items: { type: [itemSchema], default: [] },
}, { timestamps: true });

export const GmbKeywordGallery =
  mongoose.models.GmbKeywordGallery ||
  mongoose.model('GmbKeywordGallery', gmbKeywordGallerySchema);
