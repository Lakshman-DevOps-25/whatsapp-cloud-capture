/**
 * configService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Stores ONLY WhatsApp Business API credentials in MongoDB.
 *
 * STAYS IN .env — static, never change at runtime:
 *   PORT, NODE_ENV, MONGODB_URI
 *   MEDIA_STORAGE, UPLOAD_DIR
 *   MINIO_INTERNAL_URL, MINIO_PUBLIC_URL
 *   MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET
 *   ADMIN_SECRET
 *
 * STORED IN MONGODB — change at runtime (token renewal, number switch):
 *   WA_ACCESS_TOKEN         ← renewed every 60 days automatically
 *   WA_TOKEN_GENERATED_AT   ← tracks token age for auto-renewal
 *   WA_PHONE_NUMBER_ID      ← changes when switching phone numbers
 *   WA_BUSINESS_PHONE       ← changes when switching phone numbers
 *   WA_BUSINESS_ACCOUNT_ID  ← may change
 *   WA_APP_ID               ← needed for token exchange
 *   WA_APP_SECRET           ← needed for token exchange
 *   WA_VERIFY_TOKEN         ← webhook verification string
 *   WA_API_VERSION          ← update when Meta releases new version
 */

import Config from '../models/Config.js';

// ── Only WA_* keys are managed in MongoDB ─────────────────────────────────────
export const MANAGED_KEYS = [
  'WA_ACCESS_TOKEN',
  'WA_TOKEN_GENERATED_AT',
  'WA_PHONE_NUMBER_ID',
  'WA_BUSINESS_PHONE',
  'WA_BUSINESS_ACCOUNT_ID',
  'WA_APP_ID',
  'WA_APP_SECRET',
  'WA_VERIFY_TOKEN',
  'WA_API_VERSION',
];

// ─────────────────────────────────────────────────────────────────────────────
// LOAD — called once at boot after connectDB()
// Reads WA_* keys from MongoDB → sets in process.env
// If a key exists in process.env but not in MongoDB → seeds it into MongoDB
// ─────────────────────────────────────────────────────────────────────────────
export async function loadConfigFromDB() {
  console.log('\n⚙️  Loading WhatsApp config from MongoDB...');

  const docs  = await Config.find({ key: { $in: MANAGED_KEYS } }).lean();
  const dbMap = {};
  docs.forEach(d => { dbMap[d.key] = d.value; });

  let loaded = 0, seeded = 0;

  for (const key of MANAGED_KEYS) {
    if (dbMap[key]) {
      // Found in MongoDB — load into process.env
      process.env[key] = dbMap[key];
      loaded++;
    } else if (process.env[key]) {
      // Not in MongoDB yet but exists in process.env — seed it (first-time setup)
      await saveConfigToDB(key, process.env[key]);
      seeded++;
    }
  }

  console.log(`   ✅ Loaded ${loaded} WA keys from MongoDB, seeded ${seeded} from env`);
  console.log(`   WA_PHONE_NUMBER_ID : ${process.env.WA_PHONE_NUMBER_ID || '❌ NOT SET'}`);
  console.log(`   WA_BUSINESS_PHONE  : ${process.env.WA_BUSINESS_PHONE  || '❌ NOT SET'}`);
  console.log(`   WA_API_VERSION     : ${process.env.WA_API_VERSION      || '❌ NOT SET'}`);
  const tok = process.env.WA_ACCESS_TOKEN;
  console.log(`   WA_ACCESS_TOKEN    : ${tok ? tok.substring(0, 20) + '...' : '❌ NOT SET'}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SAVE — called by tokenService when token renews, or by admin API
// Updates MongoDB AND process.env simultaneously
// ─────────────────────────────────────────────────────────────────────────────
export async function saveConfigToDB(key, value) {
  await Config.findOneAndUpdate(
    { key },
    { key, value, updatedAt: new Date() },
    { upsert: true, new: true }
  );
  process.env[key] = value;
  const display = (key.includes('TOKEN') || key.includes('SECRET'))
    ? value.substring(0, 15) + '...'
    : value;
  console.log(`   💾 MongoDB config updated: ${key} = ${display}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — read a single WA config value from MongoDB
// ─────────────────────────────────────────────────────────────────────────────
export async function getConfig(key) {
  const doc = await Config.findOne({ key }).lean();
  return doc?.value || process.env[key] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ALL — returns all WA config values for admin display
// Masks token and secret values
// ─────────────────────────────────────────────────────────────────────────────
export async function getAllConfig() {
  const docs   = await Config.find({ key: { $in: MANAGED_KEYS } }).lean();
  const result = {};

  MANAGED_KEYS.forEach(key => {
    const doc  = docs.find(d => d.key === key);
    const val  = doc?.value || process.env[key] || '';
    const mask = key.includes('TOKEN') || key.includes('SECRET');
    result[key] = {
      value:     mask && val ? val.substring(0, 15) + '...' : val,
      source:    doc ? 'MongoDB' : (process.env[key] ? 'process.env (.env)' : 'NOT SET'),
      updatedAt: doc?.updatedAt || null,
    };
  });

  return result;
}
