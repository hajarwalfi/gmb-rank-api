import mongoose from 'mongoose';

const progressSchema = new mongoose.Schema(
  {
    total: { type: Number, default: 0 },
    processed: { type: Number, default: 0 },
    success: { type: Number, default: 0 },
    found: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    currentKeyword: { type: String, default: '' },
    currentLocationTitle: { type: String, default: '' },
    totalLocations: { type: Number, default: 0 },
    processedLocations: { type: Number, default: 0 },
  },
  { _id: false }
);

const locationTargetSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true, trim: true },
    locationId: { type: String, required: true, trim: true },
    title: { type: String, default: '' },
  },
  { _id: false }
);

const resultSchema = new mongoose.Schema(
  {
    galleryPublicId: { type: String, default: null },
    galleryUrl: { type: String, default: null },
    trackingSnapshotCount: { type: Number, default: null },
    rankHistoryPath: { type: String, default: null },
    note: { type: String, default: null },
    errors: { type: [String], default: [] },
    liveRows: {
      type: [
        new mongoose.Schema(
          {
            locationTitle: { type: String, default: '' },
            keyword: { type: String, default: '' },
            status: { type: String, default: 'pending' }, // pending | done | error | not_found
            found: { type: Boolean, default: false },
            rank: { type: Number, default: null },
            screenshotPath: { type: String, default: null },
            screenshotUrl: { type: String, default: null },
            volume: { type: Number, default: 0 },
            estimated_clicks: { type: Number, default: 0 },
            daily_traffic: { type: Number, default: 0 },
            error: { type: String, default: null },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { _id: false }
);

const automationRunJobSchema = new mongoose.Schema(
  {
    allLocations: { type: Boolean, default: false },
    /** When true, excluded from `/api/automation/status-banner` and active-latest polls (silent onboarding runs). */
    hideFromBanner: { type: Boolean, default: false, index: true },
    status: {
      type: String,
      enum: ['scheduled', 'running', 'completed', 'failed', 'cancelled'],
      default: 'scheduled',
      index: true,
    },
    scheduleType: { type: String, default: 'one_time' },
    recurrence: {
      type: String,
      enum: ['once', '10mins', '30mins', '45mins', '2days', '5days', 'weekly', '14days', '15days', '20days', 'monthly'],
      default: 'once',
    },
    scheduledAt: { type: Date, required: true, index: true },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    cancelRequested: { type: Boolean, default: false },
    cancelRequestedAt: { type: Date, default: null },
    stopMode: { type: String, enum: ['graceful', 'immediate'], default: 'graceful' },

    businessName: { type: String, default: '' },
    gmbKey: { type: String, default: '', index: true },
    accountId: { type: String, default: '', index: true },
    locationId: { type: String, default: '', index: true },
    locationIdShort: { type: String, default: '' },
    locationTitle: { type: String, default: '' },
    primaryCategory: { type: String, default: '' },
    areas: { type: [String], default: [] },

    keywordMode: { type: String, enum: ['all', 'subset', 'selective'], default: 'all' },
    selectedKeywords: { type: [String], default: [] },
    resolvedKeywords: { type: [String], default: [] },
    locationTargets: { type: [locationTargetSchema], default: [] },

    progress: { type: progressSchema, default: () => ({}) },
    result: { type: resultSchema, default: () => ({}) },

    requestMeta: {
      type: new mongoose.Schema(
        {
          timezone: { type: String, default: '' },
          requestedAt: { type: Date, default: Date.now },
          /** Internal: this job was auto-created as a follow-up for missing history persistence. */
          autoFollowupOfJobId: { type: String, default: null },
          /** Internal: prevent infinite follow-up loops. */
          autoFollowupDepth: { type: Number, default: 0 },
        },
        { _id: false }
      ),
      default: () => ({}),
    },
  },
  { timestamps: true }
);

export const AutomationRunJob =
  mongoose.models.AutomationRunJob ||
  mongoose.model('AutomationRunJob', automationRunJobSchema);
