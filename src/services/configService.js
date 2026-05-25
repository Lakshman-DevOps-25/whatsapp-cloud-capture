/**
 * configService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Boot flow:
 *   1. Read WA_* from .env (if present) → seed into MongoDB (first time only)
 *   2. Load all WA_* from MongoDB → set in process.env
 *   3. Check if WA_ACCESS_TOKEN is expired
 *   4. If expired → auto-refresh via Meta token exchange → save new token to MongoDB
 *   5. From this point all code reads from process.env (loaded from MongoDB)
 *
 * STAYS IN .env (never changes at runtime):
 *   PORT, NODE_ENV, MONGODB_URI
 *   MEDIA_STORAGE, UPLOAD_DIR
 *   MINIO_INTERNAL_URL, MINIO_PUBLIC_URL, MINIO_ACCESS_KEY,
 *   MINIO_SECRET_KEY, MINIO_BUCKET, ADMIN_SECRET
 *
 * STORED IN MONGODB (may change at runtime):
 *   WA_ACCESS_TOKEN, WA_TOKEN_GENERATED_AT, WA_PHONE_NUMBER_ID,
 *   WA_BUSINESS_PHONE, WA_BUSINESS_ACCOUNT_ID, WA_APP_ID,
 *   WA_APP_SECRET, WA_VERIFY_TOKEN, WA_API_VERSION
 */

import axios  from 'axios';
import Config from '../models/Config.js';

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
// SAVE — write key/value to MongoDB AND process.env
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
  console.log(`   💾 Config saved to MongoDB: ${key} = ${display}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — read single value: MongoDB first, process.env fallback
// ─────────────────────────────────────────────────────────────────────────────
export async function getConfig(key) {
  const doc = await Config.findOne({ key }).lean();
  return doc?.value || process.env[key] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ALL — all WA config values for admin display (masked)
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

// ─────────────────────────────────────────────────────────────────────────────
// CHECK TOKEN EXPIRY — inspect token via Meta debug_token API
// Returns { valid, expired, daysLeft, expiresAt }
// ─────────────────────────────────────────────────────────────────────────────
async function checkTokenExpiry(token, appId, appSecret) {
  try {
    const { data } = await axios.get('https://graph.facebook.com/debug_token', {
      params: {
        input_token:  token,
        access_token: `${appId}|${appSecret}`,
      },
      timeout: 10000,
    });

    const info     = data.data;
    const isValid  = info.is_valid;
    const expAt    = info.expires_at;   // 0 means never expires (System User token)
    const daysLeft = expAt
      ? Math.ceil((expAt * 1000 - Date.now()) / 86400000)
      : 999;

    return {
      valid:     isValid && (expAt === 0 || daysLeft > 0),
      expired:   !isValid || (expAt > 0 && daysLeft <= 0),
      daysLeft:  expAt === 0 ? 'never' : daysLeft,
      expiresAt: expAt ? new Date(expAt * 1000).toISOString() : 'never',
      neverExpires: expAt === 0,
    };
  } catch (err) {
    console.warn(`   ⚠️  Token inspection failed: ${err.message}`);
    // Cannot determine — assume valid to avoid blocking startup
    return { valid: true, expired: false, daysLeft: 'unknown' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REFRESH TOKEN — exchange current token for new 60-day token via Meta API
// ─────────────────────────────────────────────────────────────────────────────
async function refreshToken(currentToken, appId, appSecret) {
  console.log('   🔄 Exchanging for new 60-day long-lived token...');
  const { data } = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
    params: {
      grant_type:        'fb_exchange_token',
      client_id:         appId,
      client_secret:     appSecret,
      fb_exchange_token: currentToken,
    },
    timeout: 15000,
  });

  if (!data.access_token) {
    throw new Error(`Token exchange failed: ${JSON.stringify(data)}`);
  }

  return {
    token:        data.access_token,
    expiresIn:    data.expires_in || (60 * 24 * 60 * 60),
    generatedAt:  String(Math.floor(Date.now() / 1000)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOAD — called once at boot after connectDB()
//
// Step 1: Read all WA_* from .env → seed into MongoDB if not already there
// Step 2: Load all WA_* from MongoDB → set in process.env
// Step 3: Check if WA_ACCESS_TOKEN is expired via Meta API
// Step 4: If expired → refresh → save new token to MongoDB → update process.env
// ─────────────────────────────────────────────────────────────────────────────
export async function loadConfigFromDB() {
  console.log('\n⚙️  [Config] Loading WhatsApp config...');

  // ── Step 1: Seed .env values into MongoDB (first-time setup only) ───────────
  const existingDocs = await Config.find({ key: { $in: MANAGED_KEYS } }).lean();
  const inDB         = new Set(existingDocs.filter(d => d.value).map(d => d.key));

  let seeded = 0;
  for (const key of MANAGED_KEYS) {
    if (!inDB.has(key) && process.env[key]) {
      // Key is in .env but not MongoDB — seed it once
      await Config.findOneAndUpdate(
        { key },
        { key, value: process.env[key], updatedAt: new Date() },
        { upsert: true }
      );
      seeded++;
    }
  }
  if (seeded > 0) {
    console.log(`   📥 Seeded ${seeded} WA keys from .env into MongoDB (first-time setup)`);
  }

  // ── Step 2: Load all WA_* from MongoDB → process.env ───────────────────────
  const allDocs = await Config.find({ key: { $in: MANAGED_KEYS } }).lean();
  const dbMap   = {};
  allDocs.forEach(d => { if (d.value) dbMap[d.key] = d.value; });

  let loaded = 0;
  for (const key of MANAGED_KEYS) {
    if (dbMap[key]) {
      process.env[key] = dbMap[key];
      loaded++;
    }
  }

  console.log(`   ✅ Loaded ${loaded} WA keys from MongoDB into process.env`);
  console.log(`   WA_PHONE_NUMBER_ID : ${process.env.WA_PHONE_NUMBER_ID || '❌ NOT SET'}`);
  console.log(`   WA_BUSINESS_PHONE  : ${process.env.WA_BUSINESS_PHONE  || '❌ NOT SET'}`);
  console.log(`   WA_API_VERSION     : ${process.env.WA_API_VERSION      || '❌ NOT SET'}`);

  const tok = process.env.WA_ACCESS_TOKEN;
  console.log(`   WA_ACCESS_TOKEN    : ${tok ? tok.substring(0, 20) + '...' : '❌ NOT SET'}`);

  // ── Step 3: Check token expiry ───────────────────────────────────────────────
  const appId     = process.env.WA_APP_ID;
  const appSecret = process.env.WA_APP_SECRET;

  if (!tok) {
    console.warn(`   ⚠️  WA_ACCESS_TOKEN not set — seed it via POST /api/admin/config\n`);
    return;
  }

  if (!appId || !appSecret) {
    console.warn(`   ⚠️  WA_APP_ID or WA_APP_SECRET not set — cannot check token expiry`);
    console.warn(`       Seed them via POST /api/admin/config\n`);
    return;
  }

  console.log(`\n   🔍 Checking token expiry via Meta API...`);
  const expiry = await checkTokenExpiry(tok, appId, appSecret);

  if (expiry.neverExpires) {
    console.log(`   ✅ Token never expires (System User token) — no renewal needed\n`);
    return;
  }

  console.log(`   Token valid     : ${expiry.valid}`);
  console.log(`   Days remaining  : ${expiry.daysLeft}`);
  console.log(`   Expires at      : ${expiry.expiresAt}`);

  // ── Step 4: Auto-refresh if expired ─────────────────────────────────────────
  if (expiry.expired) {
    console.log(`\n   ❌ Token is EXPIRED — auto-refreshing now...`);
    try {
      const refreshed = await refreshToken(tok, appId, appSecret);

      // Save new token to MongoDB + process.env
      await saveConfigToDB('WA_ACCESS_TOKEN',       refreshed.token);
      await saveConfigToDB('WA_TOKEN_GENERATED_AT', refreshed.generatedAt);

      const expiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);
      console.log(`   ✅ Token refreshed at boot — valid until ${expiresAt.toLocaleDateString('en-IN')}`);
      console.log(`   ✅ New token saved to MongoDB — .env not modified\n`);
    } catch (err) {
      console.error(`   ❌ Auto-refresh FAILED: ${err.message}`);
      console.error(`      Manual fix: POST /api/admin/refresh-token?secret=YOUR_ADMIN_SECRET\n`);
    }
    return;
  }

  // Warn if approaching expiry (within 10 days)
  if (typeof expiry.daysLeft === 'number' && expiry.daysLeft <= 10) {
    console.warn(`   ⚠️  Token expires in ${expiry.daysLeft} day(s) — auto-renewal will fire soon\n`);
  } else {
    console.log(`   ✅ Token is valid (${expiry.daysLeft} days remaining)\n`);
  }
}
