/**
 * tokenService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages WhatsApp Business API long-lived access tokens (60-day validity).
 *
 * THREE FUNCTIONS — plug into your existing app:
 *
 *   1. generateLongToken()
 *      Exchanges short-lived token → 60-day long-lived token
 *      Writes new token to .env file and updates process.env live
 *
 *   2. addTokenPermissions()
 *      Verifies the token has all required WhatsApp permissions
 *      Logs any missing permissions with instructions to fix
 *
 *   3. startTokenAutoRenewal()
 *      Checks token age every 24 hours
 *      Auto-renews when token is 50+ days old (before 60-day expiry)
 *      Called once in app.js boot() — runs silently in background
 *
 * SETUP — add these to .env:
 *   WA_APP_ID          = your Meta App ID (from App Settings)
 *   WA_APP_SECRET      = your Meta App Secret (from App Settings)
 *   WA_SHORT_TOKEN     = short-lived token from Developer Console (initial setup only)
 *   WA_TOKEN_GENERATED_AT = (auto-set by this service, do not edit manually)
 */

import axios  from 'axios';
import fs     from 'fs';
import path   from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to .env file — walks up from src/services/ to project root
const ENV_FILE = path.resolve(__dirname, '../../.env');

// Required permissions for WhatsApp Business API
const REQUIRED_PERMISSIONS = [
  'whatsapp_business_messaging',
  'whatsapp_business_management',
  'business_management',
];

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read current .env file content
 */
function readEnvFile() {
  if (!fs.existsSync(ENV_FILE)) {
    console.warn(`⚠️  [TokenService] .env file not found at ${ENV_FILE}`);
    return '';
  }
  return fs.readFileSync(ENV_FILE, 'utf8');
}

/**
 * Update or add a key=value pair in the .env file
 * Also updates process.env immediately so the running app uses the new value
 */
function updateEnvFile(key, value) {
  let content = readEnvFile();

  if (content.includes(`${key}=`)) {
    // Replace existing key — handle both quoted and unquoted values
    content = content.replace(
      new RegExp(`^${key}=.*$`, 'm'),
      `${key}=${value}`
    );
  } else {
    // Append new key
    content += `\n${key}=${value}`;
  }

  fs.writeFileSync(ENV_FILE, content, 'utf8');
  process.env[key] = value;   // live update — no restart needed
  console.log(`   ✅ [TokenService] ${key} updated in .env and process.env`);
}

/**
 * Get token metadata by calling Meta's debug_token endpoint
 */
async function inspectToken(token) {
  const appId     = process.env.WA_APP_ID;
  const appSecret = process.env.WA_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error('WA_APP_ID and WA_APP_SECRET must be set in .env to inspect tokens');
  }

  const { data } = await axios.get('https://graph.facebook.com/debug_token', {
    params: {
      input_token:  token,
      access_token: `${appId}|${appSecret}`,
    },
    timeout: 10000,
  });

  console.log("inspectToken - ", data.data);
  return data.data; // { is_valid, expires_at, scopes, app_id, user_id, ... }
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 1 — generateLongToken()
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Exchanges a short-lived token for a 60-day long-lived token.
 * Saves the new token to .env as WA_ACCESS_TOKEN.
 * Also records WA_TOKEN_GENERATED_AT (Unix timestamp) for auto-renewal tracking.
 *
 * Call this once manually after generating a token in the Meta Developer Console.
 * After initial setup, startTokenAutoRenewal() handles all subsequent renewals.
 *
 * @param {string} shortToken  - Optional. If not provided, uses WA_ACCESS_TOKEN from .env.
 * @returns {object}           - { longToken, expiresAt, appId }
 */
export async function generateLongToken(shortToken) {
  console.log('\n🔑 [TokenService] Generating 60-day long-lived token...');

  const appId     = process.env.WA_APP_ID;
  const appSecret = process.env.WA_APP_SECRET;
  const token     = shortToken || process.env.WA_ACCESS_TOKEN;

  if (!appId)     throw new Error('WA_APP_ID is not set in .env — find it in Meta App Settings > Basic');
  if (!appSecret) throw new Error('WA_APP_SECRET is not set in .env — find it in Meta App Settings > Basic');
  if (!token)     throw new Error('No token provided. Pass shortToken or set WA_ACCESS_TOKEN in .env');

  // Exchange short-lived → long-lived via Graph API
  const { data } = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
    params: {
      grant_type:        'fb_exchange_token',
      client_id:         appId,
      client_secret:     appSecret,
      fb_exchange_token: token,
    },
    timeout: 15000,
  });

  if (!data.access_token) {
    throw new Error(`Meta token exchange failed: ${JSON.stringify(data)}`);
  }

  const longToken  = data.access_token;
  const expiresIn  = data.expires_in || (60 * 24 * 60 * 60); // default 60 days in seconds
  const expiresAt  = new Date(Date.now() + expiresIn * 1000);
  const generatedAt = Math.floor(Date.now() / 1000); // Unix timestamp

  // Save to .env and update live process.env
  updateEnvFile('WA_ACCESS_TOKEN',      longToken);
  updateEnvFile('WA_TOKEN_GENERATED_AT', String(generatedAt));

  console.log(`   ✅ Long-lived token generated`);
  console.log(`   📅 Valid until: ${expiresAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`);
  console.log(`   ⏱  Expires in: ${Math.round(expiresIn / 86400)} days`);

  return {
    longToken,
    expiresAt,
    expiresInDays: Math.round(expiresIn / 86400),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 2 — addTokenPermissions()
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Inspects the current WA_ACCESS_TOKEN and verifies it has all required
 * WhatsApp Business API permissions.
 *
 * Logs clearly which permissions are present and which are missing.
 * If permissions are missing, logs exact instructions to add them.
 *
 * @returns {object} - { valid, scopes, missing, tokenInfo }
 */
export async function addTokenPermissions() {
  console.log('\n🔐 [TokenService] Checking token permissions...');

  const token = process.env.WA_ACCESS_TOKEN;
  if (!token) throw new Error('WA_ACCESS_TOKEN is not set in .env');

  let tokenInfo;
  try {
    tokenInfo = await inspectToken(token);
  } catch (err) {
    throw new Error(`Token inspection failed: ${err.message}\nMake sure WA_APP_ID and WA_APP_SECRET are set in .env`);
  }

  const isValid = tokenInfo.is_valid;
  const scopes  = tokenInfo.scopes || [];
  const missing = REQUIRED_PERMISSIONS.filter(p => !scopes.includes(p));

  // Log token status
  console.log(`\n   Token Status  : ${isValid ? '✅ Valid' : '❌ Invalid'}`);
  console.log(`   App ID        : ${tokenInfo.app_id || 'unknown'}`);
  console.log(`   Token Type    : ${tokenInfo.type || 'unknown'}`);

  if (tokenInfo.expires_at) {
    const expiresAt  = new Date(tokenInfo.expires_at * 1000);
    const daysLeft   = Math.ceil((tokenInfo.expires_at * 1000 - Date.now()) / 86400000);
    console.log(`   Expires At    : ${expiresAt.toLocaleDateString('en-IN')}`);
    console.log(`   Days Remaining: ${daysLeft}`);
  } else {
    console.log(`   Expires At    : Never (System User token)`);
  }

  // Log permissions
  console.log(`\n   Permissions:`);
  REQUIRED_PERMISSIONS.forEach(p => {
    const has = scopes.includes(p);
    console.log(`     ${has ? '✅' : '❌'} ${p}`);
  });

  if (scopes.length > 0) {
    const extra = scopes.filter(s => !REQUIRED_PERMISSIONS.includes(s));
    if (extra.length > 0) {
      console.log(`\n   Additional scopes: ${extra.join(', ')}`);
    }
  }

  if (missing.length > 0) {
    console.warn(`\n   ⚠️  Missing ${missing.length} required permission(s): ${missing.join(', ')}`);
    console.warn(`\n   ── How to fix ─────────────────────────────────────────────────`);
    console.warn(`   1. Go to: https://developers.facebook.com`);
    console.warn(`   2. Select your App → App Review → Permissions and Features`);
    console.warn(`   3. Request the following permissions:`);
    missing.forEach(p => console.warn(`      • ${p}`));
    console.warn(`   4. After approval, regenerate your token to include new scopes`);
    console.warn(`   5. Run generateLongToken() again to get an updated token`);
    console.warn(`   ───────────────────────────────────────────────────────────────\n`);
  } else {
    console.log(`\n   ✅ All required permissions are present`);
  }

  return { valid: isValid, scopes, missing, tokenInfo };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 3 — startTokenAutoRenewal()
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Starts a background timer that checks token age every 24 hours.
 * Automatically renews the token when it is 50+ days old (10 days before expiry).
 *
 * Call this ONCE in app.js boot() — it runs silently in the background forever.
 *
 * Requirements:
 *   - WA_APP_ID and WA_APP_SECRET must be set in .env
 *   - WA_TOKEN_GENERATED_AT must be set (auto-set by generateLongToken())
 *
 * @param {object} opts
 * @param {number} opts.renewAfterDays  - Renew when token is this many days old (default: 50)
 * @param {number} opts.checkEveryHours - How often to check (default: 24)
 */
export function startTokenAutoRenewal(opts = {}) {
  const renewAfterDays  = opts.renewAfterDays  || 50;
  const checkEveryHours = opts.checkEveryHours || 24;
  const intervalMs      = checkEveryHours * 60 * 60 * 1000;

  console.log(`\n🔄 [TokenService] Auto-renewal started`);
  console.log(`   Renews when token is ${renewAfterDays}+ days old`);
  console.log(`   Checks every ${checkEveryHours} hour(s)\n`);

  const checkAndRenew = async () => {
    try {
      const token         = process.env.WA_ACCESS_TOKEN;
      const generatedAt   = parseInt(process.env.WA_TOKEN_GENERATED_AT || '0', 10);
      const appId         = process.env.WA_APP_ID;
      const appSecret     = process.env.WA_APP_SECRET;

      if (!token) {
        console.warn('⚠️  [TokenService] WA_ACCESS_TOKEN not set — skipping renewal check');
        return;
      }

      if (!appId || !appSecret) {
        console.warn('⚠️  [TokenService] WA_APP_ID or WA_APP_SECRET not set — skipping renewal check');
        return;
      }

      // Calculate token age
      const now       = Math.floor(Date.now() / 1000);
      const ageInDays = generatedAt > 0
        ? Math.floor((now - generatedAt) / 86400)
        : null;

      if (ageInDays === null) {
        console.log('🔑 [TokenService] WA_TOKEN_GENERATED_AT not set — run generateLongToken() once to initialise');
        return;
      }

      const daysUntilRenew = renewAfterDays - ageInDays;

      console.log(`🔑 [TokenService] Token age: ${ageInDays} days | Renews at: ${renewAfterDays} days | ${daysUntilRenew > 0 ? `Next renewal in ${daysUntilRenew} day(s)` : 'RENEWAL DUE'}`);

      if (ageInDays >= renewAfterDays) {
        console.log(`\n🔄 [TokenService] Token is ${ageInDays} days old — renewing now...`);

        try {
          const result = await generateLongToken(); // exchanges current long token for a new one
          console.log(`✅ [TokenService] Auto-renewal complete — new token valid until ${result.expiresAt.toLocaleDateString('en-IN')}`);

          // Re-check permissions after renewal
          await addTokenPermissions();

        } catch (renewErr) {
          console.error(`❌ [TokenService] Auto-renewal FAILED: ${renewErr.message}`);
          console.error(`   Manual action required:`);
          console.error(`   1. Go to developers.facebook.com`);
          console.error(`   2. Generate a new temporary token`);
          console.error(`   3. POST /api/admin/update-token with the new token`);
          console.error(`   OR call: POST /api/admin/refresh-token (auto-exchanges)`);
        }
      }

    } catch (err) {
      console.error('⚠️  [TokenService] Renewal check error:', err.message);
    }
  };

  // Run once immediately on startup to log token status
  checkAndRenew();

  // Then run on schedule
  setInterval(checkAndRenew, intervalMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTE HANDLERS — already wired into messages.js
// GET  /api/admin/token-status
// POST /api/admin/refresh-token
// POST /api/admin/update-token
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/token-status
 * Returns current token validity, age, permissions, and expiry info.
 * Protected by ADMIN_SECRET query param or body field.
 */
export async function handleTokenStatus(req, res) {
  const secret = req.query.secret || req.body?.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized — provide correct secret' });
  }

  try {
    const token       = process.env.WA_ACCESS_TOKEN || '';
    const generatedAt = parseInt(process.env.WA_TOKEN_GENERATED_AT || '0', 10);
    const ageInDays   = generatedAt > 0 ? Math.floor((Date.now() / 1000 - generatedAt) / 86400) : null;

    let tokenInfo = null;
    let missing   = REQUIRED_PERMISSIONS;

    try {
      tokenInfo = await inspectToken(token);
      missing   = REQUIRED_PERMISSIONS.filter(p => !(tokenInfo.scopes || []).includes(p));
    } catch (_) { /* token may be invalid */ }

    res.json({
      tokenSet:         !!token,
      tokenPrefix:      token ? token.substring(0, 20) + '...' : null,
      tokenAgeInDays:   ageInDays,
      generatedAt:      generatedAt ? new Date(generatedAt * 1000).toISOString() : null,
      daysUntilRenewal: ageInDays !== null ? Math.max(0, 50 - ageInDays) : null,
      daysUntilExpiry:  ageInDays !== null ? Math.max(0, 60 - ageInDays) : null,
      isValid:          tokenInfo?.is_valid || false,
      expiresAt:        tokenInfo?.expires_at ? new Date(tokenInfo.expires_at * 1000).toISOString() : 'Never',
      scopes:           tokenInfo?.scopes || [],
      missingPermissions: missing,
      appId:            process.env.WA_APP_ID || null,
      envFile:          ENV_FILE,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/admin/refresh-token
 * Exchanges the current WA_ACCESS_TOKEN for a new 60-day token.
 * No body needed — uses token already in .env.
 */
export async function handleRefreshToken(req, res) {
  const secret = req.query.secret || req.body?.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized — provide correct secret' });
  }

  try {
    const result = await generateLongToken();
    const perms  = await addTokenPermissions();
    res.json({
      success:      true,
      message:      'Token refreshed successfully',
      expiresAt:    result.expiresAt.toISOString(),
      expiresInDays: result.expiresInDays,
      permissions:  perms.scopes,
      missing:      perms.missing,
    });
  } catch (err) {
    console.error('[handleRefreshToken]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/admin/update-token
 * Manually sets a new token (paste from Developer Console).
 * Body: { secret: "...", token: "EAAxxxxx" }
 */
export async function handleUpdateToken(req, res) {
  const secret   = req.query.secret || req.body?.secret;
  const newToken = req.body?.token;

  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized — provide correct secret' });
  }
  if (!newToken) {
    return res.status(400).json({ error: 'token field is required in request body' });
  }

  try {
    // Save the new token directly (don't exchange — user provided a fresh one)
    updateEnvFile('WA_ACCESS_TOKEN',       newToken.trim());
    updateEnvFile('WA_TOKEN_GENERATED_AT', String(Math.floor(Date.now() / 1000)));

    // Check permissions on the new token
    const perms = await addTokenPermissions().catch(() => ({ scopes: [], missing: [] }));

    res.json({
      success:     true,
      message:     'WA_ACCESS_TOKEN updated in .env and live process',
      permissions: perms.scopes,
      missing:     perms.missing,
    });
  } catch (err) {
    console.error('[handleUpdateToken]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}
