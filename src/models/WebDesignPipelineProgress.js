import mongoose from 'mongoose';

const trackSchema = new mongoose.Schema(
  {
    /** User tapped "Front-end" / "Back-end" to reveal In progress / Finished for that track. */
    started: { type: Boolean, default: false },
    inProgress: { type: Boolean, default: false },
    inProgressBy: { type: String, default: '', trim: true },
    finished: { type: Boolean, default: false },
    finishedBy: { type: String, default: '', trim: true },
  },
  { _id: false },
);

const webDesignPipelineProgressSchema = new mongoose.Schema(
  {
    /** CRM client UUID (Client Hub `clients.id`). */
    clientId: { type: String, required: true, unique: true, index: true, trim: true },
    frontend: { type: trackSchema, default: () => ({}) },
    backend: { type: trackSchema, default: () => ({}) },
  },
  { timestamps: true },
);

export const WebDesignPipelineProgress =
  mongoose.models.WebDesignPipelineProgress ||
  mongoose.model('WebDesignPipelineProgress', webDesignPipelineProgressSchema);
