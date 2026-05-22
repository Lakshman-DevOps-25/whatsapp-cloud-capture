/**
 * Config.js — MongoDB model for WhatsApp environment variables
 *
 * Stores all WA_* config values in MongoDB instead of .env or Render.
 * Only MONGODB_URI and PORT stay in .env (needed before DB connects).
 *
 * Collection: configs
 * Each document: { key: "WA_ACCESS_TOKEN", value: "EAAxxxx", updatedAt: Date }
 */

import mongoose from 'mongoose';

const ConfigSchema = new mongoose.Schema({
  key:       { type: String, unique: true, index: true, required: true },
  value:     { type: String, default: '' },
  updatedAt: { type: Date,   default: Date.now },
}, { timestamps: false });

export default mongoose.model('Config', ConfigSchema);
