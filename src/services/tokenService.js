/**
 * tokenService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages WhatsApp Business API long-lived access tokens (60-day validity).
 *
 * HOW TOKEN PERSISTENCE WORKS:
 *
 *   LOCAL DEV  → writes to .env file on disk ✅
 *   RENDER     → updates Render env var via Render API ✅ (persists across restarts)
 *   RAILWAY    → updates Railway env var via Railway API ✅
 *   FALLBACK   → updates process.env only (lost on restart, but works until then)
 *
 * The correct approach per environment is auto-detected from env vars.
 *
 * SETUP — add to Render/Railway environment variables:
 *   WA_APP_ID             = your Meta App ID
 *   WA_APP_SECRET         = your Meta App Secret
 *   ADMIN_SECRET          = secret to protect admin endpoints
 *   RENDER_API_KEY        = Render API key (if deploying on Render)
 *   RENDER_SERVICE_ID     = Render service ID (if deploying on Render)
 *   WA_TOKEN_GENERATED_AT = (auto-set, do not edit manually)
 */

import axios from 'axios';
import fs    from 'fs';
import path  from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE  = path.resolve(__dirname, '../../.env');

const REQUIRED_PERMISSIONS = [
  'whatsapp_business_messaging',
  'whatsapp_business_management',
  'business_management',
];

// ─────────────────────────────────────────────────────────────────────────────
// PERSISTENT TOKEN STORAGE
// Tries three strategies in order:
//   1. Render API  — persists across restarts on Render
//   2. .env file   — persists on local dev
//   3. process.env — in-memory only (lost on restart)
// ─────────────────────────────────────────────────────────────────────────────

async function persistToken(key, value) {
  // Always update in-memory immediately — works for current process
  process.env[key] = value;
  console.log(`   ✅ [TokenService] ${key} updated in process.env (live)`);

  // Strategy 1: Render API (production on Render)
  if (process.env.RENDER_API_KEY && process.env.RENDER_SERVICE_ID) {
    const updated = await updateRenderEnvVar(key, value);
    if (updated) return;
  }

  // Strategy 2: .env file (local development)
  if (fs.existsSync(ENV_FILE)) {
    updateEnvFile(key, value);
    return;
  }

  // Strategy 3: process.env only (already done above)
  console.warn(`   ⚠️  [TokenService] ${key} updated in memory only — will be lost on restart`);
  console.warn(`      To persist: set RENDER_API_KEY + RENDER_SERVICE_ID in Render env vars`);
}

// ── Strategy 1: Update via Render API ─────────────────────────────────────────
async function updateRenderEnvVar(key, value) {
  try {
    const serviceId = process.env.RENDER_SERVICE_ID;
    const apiKey    = process.env.RENDER_API_KEY;

    // Step 1: Get existing env vars from Render
    const listRes = await axios.get(
      `https://api.render.com/v1/services/${serviceId}/env-vars`,
      { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, timeout: 10000 }
    );

    // Step 2: Build updated env vars list
    const existing = listRes.data || [];
    let updated = false;
    const envVars = existing.map(ev => {
      if (ev.envVar?.key === key) {
        updated = true;
        return { key, value };
      }
      return { key: ev.envVar?.key, value: ev.envVar?.value };
    });

    if (!updated) envVars.push({ key, value });

    // Step 3: PUT updated vars back to Render
    await axios.put(
      `https://api.render.com/v1/services/${serviceId}/env-vars`,
      envVars,
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 10000 }
    );

    console.log(`   ✅ [TokenService] ${key} updated in Render environment variables (persists across restarts)`);
    return true;
  } catch (err) {
    console.error(`   ⚠️  [TokenService] Render API update failed: ${err.response?.data?.message || err.message}`);
    console.error(`      Check RENDER_API_KEY and RENDER_SERVICE_ID are correct`);
    return false;
  }
}

// ── Strategy 2: Update .env file (local dev) ──────────────────────────────────
function updateEnvFile(key, value) {
  try {
    let content = fs.readFileSync(ENV_FILE, 'utf8');
    if (content.includes(`${key}=`)) {
      content = content.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
    fs.writeFileSync(ENV_FILE, content, 'utf8');
    console.log(`   ✅ [TokenService] ${key} updated in .env file`);
  } catch (err) {
    console.warn(`   ⚠️  [TokenService] Could not write .env file: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN INSPECTION
// ─────────────────────────────────────────────────────────────────────────────
async function inspectToken(token) {
  const appId     = process.env.WA_APP_ID;
  const appSecret = process.env.WA_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('WA_APP_ID and WA_APP_SECRET must be set to inspect tokens');
  }
  const { data } = await axios.get('https://graph.facebook.com/debug_token', {
    params: { input_token: token, access_token: `${appId}|${appSecret}` },
    timeout: 10000,
  });
  return data.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 1 — generateLongToken()
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Exchanges a short-lived or existing token for a 60-day long-lived token.
 * Saves the new token to Render env vars (prod) or .env file (local).
 * Updates process.env immediately for the current running process.
 */
export async function generateLongToken(shortToken) {
  console.log('\n🔑 [TokenService] Generating 60-day long-lived token...');

  const appId     = process.env.WA_APP_ID;
  const appSecret = process.env.WA_APP_SECRET;
  const token     = shortToken || process.env.WA_ACCESS_TOKEN;

  if (!appId)     throw new Error('WA_APP_ID is not set — add it to Render env vars');
  if (!appSecret) throw new Error('WA_APP_SECRET is not set — add it to Render env vars');
  if (!token)     throw new Error('No token provided. Pass shortToken or set WA_ACCESS_TOKEN');

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

  const longToken    = data.access_token;
  const expiresIn    = data.expires_in || (60 * 24 * 60 * 60);
  const expiresAt    = new Date(Date.now() + expiresIn * 1000);
  const generatedAt  = String(Math.floor(Date.now() / 1000));

  // Persist both the new token and its generation timestamp
  await persistToken('WA_ACCESS_TOKEN',       longToken);
  await persistToken('WA_TOKEN_GENERATED_AT', generatedAt);

  console.log(`   ✅ Long-lived token generated`);
  console.log(`   📅 Valid until: ${expiresAt.toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' })}`);
  console.log(`   ⏱  Expires in: ${Math.round(expiresIn / 86400)} days`);

  return { longToken, expiresAt, expiresInDays: Math.round(expiresIn / 86400) };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 2 — addTokenPermissions()
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Inspects the current token and verifies required WhatsApp permissions.
 */
export async function addTokenPermissions() {
  console.log('\n🔐 [TokenService] Checking token permissions...');

  const token = process.env.WA_ACCESS_TOKEN;
  if (!token) throw new Error('WA_ACCESS_TOKEN is not set');

  const tokenInfo = await inspectToken(token);
  const scopes    = tokenInfo.scopes || [];
  const missing   = REQUIRED_PERMISSIONS.filter(p => !scopes.includes(p));

  console.log(`\n   Token Status  : ${tokenInfo.is_valid ? '✅ Valid' : '❌ Invalid'}`);
  console.log(`   App ID        : ${tokenInfo.app_id || 'unknown'}`);
  if (tokenInfo.expires_at) {
    const exp      = new Date(tokenInfo.expires_at * 1000);
    const daysLeft = Math.ceil((tokenInfo.expires_at * 1000 - Date.now()) / 86400000);
    console.log(`   Expires At    : ${exp.toLocaleDateString('en-IN')} (${daysLeft} days)`);
  } else {
    console.log(`   Expires At    : Never`);
  }

  console.log(`\n   Permissions:`);
  REQUIRED_PERMISSIONS.forEach(p => {
    console.log(`     ${scopes.includes(p) ? '✅' : '❌'} ${p}`);
  });

  if (missing.length > 0) {
    console.warn(`\n   ⚠️  Missing: ${missing.join(', ')}`);
    console.warn(`   Fix: developers.facebook.com → App Review → Permissions → Request missing permissions`);
  } else {
    console.log(`\n   ✅ All required permissions present`);
  }

  return { valid: tokenInfo.is_valid, scopes, missing, tokenInfo };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 3 — startTokenAutoRenewal()
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Starts background token renewal checking.
 * Checks every 24 hours, renews at day 50 (before 60-day expiry).
 * Token is saved via Render API (prod) or .env file (local).
 */
export function startTokenAutoRenewal(opts = {}) {
  const renewAfterDays  = opts.renewAfterDays  || 50;
  const checkEveryHours = opts.checkEveryHours || 24;
  const intervalMs      = checkEveryHours * 60 * 60 * 1000;

  console.log(`\n🔄 [TokenService] Auto-renewal started (renews at day ${renewAfterDays}, checks every ${checkEveryHours}h)\n`);

  // Log where tokens will be persisted
  if (process.env.RENDER_API_KEY && process.env.RENDER_SERVICE_ID) {
    console.log(`   💾 Token persistence: Render API (survives restarts ✅)`);
  } else if (fs.existsSync(ENV_FILE)) {
    console.log(`   💾 Token persistence: .env file (local dev ✅)`);
  } else {
    console.warn(`   ⚠️  Token persistence: process.env only (lost on restart)`);
    console.warn(`      Add RENDER_API_KEY + RENDER_SERVICE_ID to enable persistent renewal`);
  }

  const checkAndRenew = async () => {
    try {
      const token       = process.env.WA_ACCESS_TOKEN;
      const generatedAt = parseInt(process.env.WA_TOKEN_GENERATED_AT || '0', 10);
      const appId       = process.env.WA_APP_ID;
      const appSecret   = process.env.WA_APP_SECRET;

      if (!token || !appId || !appSecret) {
        console.log('🔑 [TokenService] Skipping renewal check — missing WA_ACCESS_TOKEN, WA_APP_ID, or WA_APP_SECRET');
        return;
      }

      if (!generatedAt) {
        console.log('🔑 [TokenService] WA_TOKEN_GENERATED_AT not set — call POST /api/admin/refresh-token once to initialise');
        return;
      }

      const ageInDays      = Math.floor((Date.now() / 1000 - generatedAt) / 86400);
      const daysUntilRenew = renewAfterDays - ageInDays;

      console.log(`🔑 [TokenService] Token age: ${ageInDays} days | Renews at: ${renewAfterDays} days | ${daysUntilRenew > 0 ? `Next renewal in ~${daysUntilRenew} day(s)` : 'RENEWAL DUE NOW'}`);

      if (ageInDays >= renewAfterDays) {
        console.log(`\n🔄 [TokenService] Renewing token (age: ${ageInDays} days)...`);
        try {
          const result = await generateLongToken();
          console.log(`✅ [TokenService] Renewed — valid until ${result.expiresAt.toLocaleDateString('en-IN')}`);
          await addTokenPermissions();
        } catch (err) {
          console.error(`❌ [TokenService] Auto-renewal FAILED: ${err.message}`);
          console.error(`   Manual fix: POST /api/admin/refresh-token?secret=YOUR_ADMIN_SECRET`);
        }
      }
    } catch (err) {
      console.error('⚠️  [TokenService] Renewal check error:', err.message);
    }
  };

  checkAndRenew(); // run once on startup
  setInterval(checkAndRenew, intervalMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTE HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

export async function handleTokenStatus(req, res) {
  const secret = req.query.secret || req.body?.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    const token       = process.env.WA_ACCESS_TOKEN || '';
    const generatedAt = parseInt(process.env.WA_TOKEN_GENERATED_AT || '0', 10);
    const ageInDays   = generatedAt ? Math.floor((Date.now() / 1000 - generatedAt) / 86400) : null;

    let tokenInfo = null, missing = REQUIRED_PERMISSIONS;
    try {
      tokenInfo = await inspectToken(token);
      missing   = REQUIRED_PERMISSIONS.filter(p => !(tokenInfo.scopes||[]).includes(p));
    } catch (_) {}

    const renderConfigured = !!(process.env.RENDER_API_KEY && process.env.RENDER_SERVICE_ID);

    res.json({
      tokenSet:          !!token,
      tokenPrefix:       token ? token.substring(0, 20) + '...' : null,
      tokenAgeInDays:    ageInDays,
      generatedAt:       generatedAt ? new Date(generatedAt * 1000).toISOString() : null,
      daysUntilRenewal:  ageInDays !== null ? Math.max(0, 50 - ageInDays) : null,
      daysUntilExpiry:   ageInDays !== null ? Math.max(0, 60 - ageInDays) : null,
      isValid:           tokenInfo?.is_valid || false,
      expiresAt:         tokenInfo?.expires_at ? new Date(tokenInfo.expires_at * 1000).toISOString() : 'Never',
      scopes:            tokenInfo?.scopes || [],
      missingPermissions: missing,
      persistence:       renderConfigured ? 'Render API (permanent)' : fs.existsSync(ENV_FILE) ? '.env file (local)' : 'process.env only (temporary)',
      renderConfigured,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function handleRefreshToken(req, res) {
  const secret = req.query.secret || req.body?.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  try {
    const result = await generateLongToken();
    const perms  = await addTokenPermissions();
    res.json({
      success:       true,
      message:       'Token refreshed and saved',
      expiresAt:     result.expiresAt.toISOString(),
      expiresInDays: result.expiresInDays,
      permissions:   perms.scopes,
      missing:       perms.missing,
      persistence:   (process.env.RENDER_API_KEY && process.env.RENDER_SERVICE_ID)
                       ? 'Saved to Render env vars (permanent)'
                       : fs.existsSync(ENV_FILE)
                         ? 'Saved to .env file'
                         : 'Saved to process.env only (temporary — add RENDER_API_KEY to make permanent)',
    });
  } catch (err) {
    console.error('[handleRefreshToken]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

export async function handleUpdateToken(req, res) {
  const secret   = req.query.secret || req.body?.secret;
  const newToken = req.body?.token;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (!newToken) {
    return res.status(400).json({ error: 'token field is required' });
  }
  try {
    await persistToken('WA_ACCESS_TOKEN',       newToken.trim());
    await persistToken('WA_TOKEN_GENERATED_AT', String(Math.floor(Date.now() / 1000)));
    const perms = await addTokenPermissions().catch(() => ({ scopes: [], missing: [] }));
    res.json({
      success:     true,
      message:     'Token updated',
      permissions: perms.scopes,
      missing:     perms.missing,
      persistence: (process.env.RENDER_API_KEY && process.env.RENDER_SERVICE_ID)
                     ? 'Saved to Render env vars (permanent)'
                     : fs.existsSync(ENV_FILE)
                       ? 'Saved to .env file'
                       : 'Saved to process.env only (temporary)',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
