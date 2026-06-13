const mongoose = require('mongoose');

const onboardingReportSchema = new mongoose.Schema({
  taskId: { type: String, required: true, unique: true, index: true },
  business_name: { type: String, default: null },
  call_link: { type: String, default: null },
  transcript: { type: String, default: null },
  checklist_results: { type: Object, default: {} }, // Will store { rank: Number, reason: String }
  score: { type: Number, default: null },        // 0-10 scale
  average_rank: { type: Number, default: null }, // 1-5 scale
  completed: { type: Number, default: null },    // Count of items with rank >= 3 (for legacy/summary)
  total: { type: Number, default: 9 },           // 9 categories
  status: {
    type: String,
    enum: ['Good', 'Average', 'Poor'],
    default: null,
  },
  scoring_error: { type: String, default: null },
  created_at: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('OnboardingReport', onboardingReportSchema);
