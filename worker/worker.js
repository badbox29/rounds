/**
 * Rounds — Cloudflare Worker
 *
 * Sync + auth backend for Rounds. Trimmed from Refectory's worker: same auth
 * model (token accounts sign requests with HMAC, Google accounts sign with a
 * server-minted write key), with recipes, scraping, sharing and photos removed.
 *
 * Environment variables (Cloudflare dashboard → Settings → Variables):
 *   GOOGLE_CLIENT_ID   — Google OAuth Client ID (only needed for Google sign-in)
 *   ALLOWED_ORIGINS    — Comma-separated allowed origins, e.g. https://badbox29.github.io
 *
 * KV Namespace binding:
 *   ROUNDS_KV          — KV namespace for user data
 *
 * Routes:
 *   GET    /                    — Health check (open CORS)
 *   GET    /ping                — Health check (open CORS)
 *   GET    /auth/config         — Google Client ID for the sign-in button
 *   POST   /auth/google         — Verify a Google ID token
 *   POST   /auth/verify         — Re-verify a stored Google credential at boot
 *   POST   /auth/writekey       — Mint/return the account's request-signing key (Google)
 *   POST   /auth/revokekeys     — Drop the write key (signs out every device)
 *   POST   /auth/register       — Register a token account's signing key (and move pre-v2.1 data)
 *   POST   /auth/migrate        — One-way token → Google migration (HMAC-authenticated)
 *
 * Morning reminders (optional): add a Cron Trigger that runs every 5 minutes to the
 * Worker (see README). Each run sends an ntfy notification to every account whose
 * reminder time has come (in its own timezone), at most once a day.
 * Settings live at user:{id}:reminder, with an index key rindex:{id}.
 *
 * Account ids:
 *   google:{sub}  — Google accounts (signed with a Worker-minted write key)
 *   r1{43 chars}  — token accounts: a SHA-256 fingerprint of the token. The
 *                   token itself never reaches the Worker; requests are signed
 *                   with a key the client derives from it and registers once.
 *   {22 chars}    — pre-v2.1 token accounts stored under the raw token. Still
 *                   readable until /auth/register moves them, then 410.
 *   POST   /reminder/:id/test   — Send a test reminder with the given settings (signed)
 *   GET    /storage/:token      — List keys for an account
 *   GET    /storage/:token/:key — Read a value
 *   PUT    /storage/:token/:key — Write a value (signed)
 *   DELETE /storage/:token/:key — Delete a value (signed)
 */

const KV_BINDING          = 'ROUNDS_KV';
const KV_TTL              = 60 * 60 * 24 * 1825; // 5 years, resets on every write
const HMAC_SALT           = 'rounds-hmac-v1';    // must match js/auth.js; never change after deployment
const MAX_BODY_SIZE       = 2 * 1024 * 1024;     // 2 MB — years of daily notes fit comfortably
const AUTH_RATE_LIMIT     = 30;   // sign-in, write key, migrate, revoke — per IP per window
const VERIFY_RATE_LIMIT   = 120;  // boot-time /auth/verify — per IP per window
const AUTH_RATE_LIMIT_WIN = 3600; // seconds
const RATE_LIMIT          = 120;  // storage requests per token per window
const RATE_LIMIT_WINDOW   = 60;   // seconds
const MIGRATED_TTL        = 60 * 60 * 24 * 90;

// ── Response helpers ───────────────────────────────────────────────────────

function respond(body, status = 200, extra = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json', ...extra } });
}

// ── CORS ───────────────────────────────────────────────────────────────────

function buildCors(origin) {
  return {
    'Access-Control-Allow-Origin':   origin,
    'Access-Control-Allow-Methods':  'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':  'Content-Type, Authorization, X-Timestamp, X-Signature',
    'Access-Control-Expose-Headers': 'Retry-After, X-RateLimit-Remaining, X-Account-Migrated',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  };
}

function getAllowedOrigin(request, allowedOrigins) {
  const origin = request.headers.get('Origin') || '';
  return allowedOrigins.includes(origin) ? origin : null;
}

// ── Token validation ───────────────────────────────────────────────────────

function isValidToken(token) {
  return /^(google:\d{10,30}|[a-zA-Z0-9_-]{20,128})$/.test(token);
}
const isFingerprintId = id => /^r1[A-Za-z0-9_-]{43}$/.test(id);
const isLegacyId      = id => !id.startsWith('google:') && !isFingerprintId(id);

// Must match accountIdFor() in js/auth.js.
async function fingerprintOf(token) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('rounds-account-v1:' + token));
  return 'r1' + btoa(String.fromCharCode(...new Uint8Array(h))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Move every user:{from}:* key to user:{to}:*, profile last. Never overwrites
// an existing destination profile. Returns the number of keys moved.
async function moveAccount(kv, from, to, editProfile) {
  const fromPfx = `user:${from}:`, toPfx = `user:${to}:`;
  if (await kv.get(`${toPfx}profile`, { type: 'text' })) return 0;
  let moved = 0, profile = null, cursor;
  do {
    const listed = await kv.list({ prefix: fromPfx, cursor });
    for (const k of listed.keys) {
      const sub = k.name.slice(fromPfx.length);
      const val = await kv.get(k.name, { type: 'text' });
      if (val === null) continue;
      if (sub === 'profile') { profile = val; continue; }
      await kv.put(toPfx + sub, val, { expirationTtl: KV_TTL });
      moved++;
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  if (profile !== null) {
    let out = profile;
    if (editProfile) { try { out = JSON.stringify(editProfile(JSON.parse(profile))); } catch {} }
    await kv.put(`${toPfx}profile`, out, { expirationTtl: KV_TTL });
    moved++;
  }
  return moved;
}

async function deleteAccountKeys(kv, id) {
  let cursor;
  do {
    const listed = await kv.list({ prefix: `user:${id}:`, cursor });
    for (const k of listed.keys) await kv.delete(k.name);
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
}

// ── Sliding-window rate limit (shared helper) ──────────────────────────────
// Returns null when allowed, or { retryAfter } in seconds.

async function slidingLimit(env, key, limit, windowSec) {
  const kv  = env[KV_BINDING];
  const now = Math.floor(Date.now() / 1000);
  let ts = [];
  const stored = await kv.get(key, { type: 'text' });
  if (stored) {
    try { const p = JSON.parse(stored); if (Array.isArray(p)) ts = p.filter(t => t > now - windowSec); } catch {}
  }
  if (ts.length >= limit) return { retryAfter: Math.max(1, ts[0] + windowSec - now) };
  ts.push(now);
  // KV's minimum TTL is 60 seconds.
  await kv.put(key, JSON.stringify(ts), { expirationTtl: Math.max(60, windowSec * 2) });
  return null;
}

function tooMany(rl, cors) {
  return respond({ error: 'Too many requests — try again later', retryAfter: rl.retryAfter },
    429, { ...cors, 'Retry-After': String(rl.retryAfter) });
}

// ── HMAC signing (mirrors js/auth.js exactly) ──────────────────────────────

async function deriveHmacKey(secret) {
  const enc    = new TextEncoder();
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HKDF' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(HMAC_SALT), info: enc.encode('request-signing') },
    keyMat,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify']
  );
}

// `secret` is the signing key; `msgToken` is the account named in the signed
// message. Same value for token accounts; for Google accounts the secret is
// the minted write key and the message names `google:{sub}`.
async function verifyHmac(request, secret, body, msgToken) {
  const token     = msgToken === undefined ? secret : msgToken;
  const timestamp = request.headers.get('X-Timestamp') || '';
  const signature = request.headers.get('X-Signature') || '';
  if (!timestamp || !signature) return { ok: false, reason: 'Missing HMAC headers' };
  if (Math.abs(Date.now() - parseInt(timestamp, 10)) > 5 * 60 * 1000)
    return { ok: false, reason: 'Timestamp expired' };

  const enc       = new TextEncoder();
  const bodyHash  = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(body || ''))))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const message   = `${request.method.toUpperCase()}:${token}:${timestamp}:${bodyHash}`;
  try {
    const key      = await deriveHmacKey(secret);
    const sigBytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid    = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(message));
    return valid ? { ok: true } : { ok: false, reason: 'Invalid signature' };
  } catch { return { ok: false, reason: 'Verification error' }; }
}

// ── Write keys (Google accounts) ───────────────────────────────────────────
// Google ID tokens last about an hour. Rather than make every write depend on
// one, Google proves identity once and the Worker hands back a random
// per-account secret that signs writes from then on. It can't be derived from
// `google:{sub}`, because `sub` isn't secret.

function writeKeyId(token) { return `wkey:${token}`; }

function newWriteKey() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function getWriteKey(env, token) {
  return await env[KV_BINDING].get(writeKeyId(token), { type: 'text' });
}

async function mintWriteKey(env, token) {
  const existing = await getWriteKey(env, token);
  if (existing) return existing;
  const key = newWriteKey();
  await env[KV_BINDING].put(writeKeyId(token), key);
  return key;
}

async function checkAuth(request, token, cors, body, env) {
  const deny = (msg, status = 401) => ({ ok: false, res: respond({ error: msg }, status, cors) });

  if (token.startsWith('google:')) {
    if (request.headers.get('X-Signature')) {
      const wkey = await getWriteKey(env, token);
      if (!wkey) return deny('No write key — sign in again');
      const hmac = await verifyHmac(request, wkey, body, token);
      return hmac.ok ? { ok: true } : deny(`Auth failed: ${hmac.reason}`);
    }
    // Bearer fallback: used for the first read after sign-in, before a
    // write key exists on this device.
    const authHeader = request.headers.get('Authorization') || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!idToken) return deny('Authorization required');
    const payload = await verifyGoogleJWT(idToken, env.GOOGLE_CLIENT_ID);
    if (!payload) return deny('Invalid or expired Google token');
    if (token !== `google:${payload.sub}`) return deny('Token mismatch', 403);
    return { ok: true };
  }

  if (isFingerprintId(token)) {
    const key = await getWriteKey(env, token);
    if (!key) return deny('Account not registered');
    const hmac = await verifyHmac(request, key, body, token);
    return hmac.ok ? { ok: true } : deny(`Auth failed: ${hmac.reason}`);
  }

  // Pre-v2.1 account still stored under the raw token.
  const hmac = await verifyHmac(request, token, body);
  return hmac.ok ? { ok: true } : deny(`Auth failed: ${hmac.reason}`);
}

// ── Google JWT (RS256) ─────────────────────────────────────────────────────

async function verifyGoogleJWT(idToken, clientId) {
  if (!clientId || typeof idToken !== 'string') return null;
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const dec     = s => JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')));
    const header  = dec(parts[0]);
    const payload = dec(parts[1]);
    const now     = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;
    if (payload.aud !== clientId) return null;
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) return null;
    if (!payload.sub) return null;

    const jwksRes = await fetch('https://www.googleapis.com/oauth2/v3/certs', { cf: { cacheTtl: 3600 } });
    if (!jwksRes.ok) return null;
    const jwks = await jwksRes.json();
    const jwk  = jwks.keys?.find(k => k.kid === header.kid);
    if (!jwk) return null;

    const cryptoKey    = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig          = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, sig, signingInput)) return null;

    return { sub: payload.sub, email: payload.email || null, name: payload.name || null, picture: payload.picture || null };
  } catch (e) {
    console.error('[Auth] verifyGoogleJWT:', e);
    return null;
  }
}

// ── Auth routes ────────────────────────────────────────────────────────────

async function readIdToken(request) {
  try { return (await request.json())?.idToken || null; } catch { return null; }
}

async function handleAuth(url, method, request, env, cors, ip) {
  const kv = env[KV_BINDING];

  if (url.pathname === '/auth/config' && method === 'GET') {
    return respond({ googleClientId: env.GOOGLE_CLIENT_ID || '' }, 200, cors);
  }

  // Everything below is IP rate-limited; boot-time verifies get their own,
  // larger budget so app restarts can never starve a real sign-in.
  const isVerify = url.pathname === '/auth/verify';
  const rl = await slidingLimit(env, `rl:${isVerify ? 'verify' : 'auth'}:${ip}`,
    isVerify ? VERIFY_RATE_LIMIT : AUTH_RATE_LIMIT, AUTH_RATE_LIMIT_WIN);
  if (rl) return tooMany(rl, cors);

  if (method !== 'POST') return null;

  if (url.pathname === '/auth/google' || url.pathname === '/auth/verify'
      || url.pathname === '/auth/writekey' || url.pathname === '/auth/revokekeys') {
    const idToken = await readIdToken(request);
    if (!idToken) return respond({ error: 'idToken required' }, 400, cors);
    const p = await verifyGoogleJWT(idToken, env.GOOGLE_CLIENT_ID);
    if (!p) return respond({ ok: false, error: 'Invalid or expired Google token' }, 401, cors);
    const token = `google:${p.sub}`;

    if (url.pathname === '/auth/google')     return respond({ ok: true, kvKey: token, profile: p }, 200, cors);
    if (url.pathname === '/auth/verify')     return respond({ ok: true, profile: p }, 200, cors);
    if (url.pathname === '/auth/writekey')   return respond({ ok: true, writeKey: await mintWriteKey(env, token) }, 200, cors);
    await kv.delete(writeKeyId(token));
    return respond({ ok: true }, 200, cors);
  }

  // POST /auth/register — a token account registers the signing key it
  // derives from its token. First registration wins; re-registering the same
  // key is a no-op. With legacyToken (+ a signature made with it) the account
  // is also moved off its raw-token storage key.
  if (url.pathname === '/auth/register') {
    const bodyText = await readBodyText(request);
    let body;
    try { body = JSON.parse(bodyText || ''); } catch { return respond({ error: 'Invalid JSON' }, 400, cors); }
    const { accountId, authKey, legacyToken } = body || {};
    if (!isFingerprintId(accountId || '') || !/^[0-9a-f]{64}$/.test(authKey || ''))
      return respond({ error: 'Invalid accountId or authKey' }, 400, cors);

    const existing = await getWriteKey(env, accountId);
    if (existing && existing !== authKey) return respond({ error: 'Account already registered' }, 409, cors);

    let moved = 0;
    if (legacyToken !== undefined) {
      if (typeof legacyToken !== 'string' || !isValidToken(legacyToken) || !isLegacyId(legacyToken))
        return respond({ error: 'Invalid legacy token' }, 400, cors);
      const hmac = await verifyHmac(request, legacyToken, bodyText);
      if (!hmac.ok) return respond({ error: 'Cannot verify ownership of token' }, 401, cors);
      if (await fingerprintOf(legacyToken) !== accountId) return respond({ error: 'accountId does not match token' }, 400, cors);
      if (await kv.get(`migrated:${legacyToken}`, { type: 'text' }))
        return respond({ migrated: true, authMethod: 'google' }, 410, { ...cors, 'X-Account-Migrated': 'google' });
      // The raw token must not survive anywhere in storage.
      moved = await moveAccount(kv, legacyToken, accountId, p => { delete p.userToken; delete p.workerUrl; return p; });
      await deleteAccountKeys(kv, legacyToken);
      await kv.delete(`ratelimit:${legacyToken}`);   // from pre-v2.1 Workers
    }
    if (!existing) await kv.put(writeKeyId(accountId), authKey);
    return respond({ ok: true, moved: moved > 0 }, 200, cors);
  }

  // POST /auth/migrate — token → Google, one way. The caller has to prove they
  // hold the old token (HMAC over the body), not just any Google account.
  if (url.pathname === '/auth/migrate') {
    const bodyText = await readBodyText(request);
    if (!bodyText) return respond({ error: 'Invalid body' }, 400, cors);
    let body;
    try { body = JSON.parse(bodyText); } catch { return respond({ error: 'Invalid JSON' }, 400, cors); }

    const { idToken, oldId } = body || {};
    if (!idToken || !oldId) return respond({ error: 'idToken and oldId required' }, 400, cors);
    if (!isFingerprintId(oldId)) return respond({ error: 'Invalid account id' }, 400, cors);

    const p = await verifyGoogleJWT(idToken, env.GOOGLE_CLIENT_ID);
    if (!p) return respond({ error: 'Invalid or expired Google token' }, 401, cors);

    const oldKey = await getWriteKey(env, oldId);
    const hmac   = oldKey ? await verifyHmac(request, oldKey, bodyText, oldId) : { ok: false };
    if (!hmac.ok) return respond({ error: 'Cannot verify ownership of source account' }, 401, cors);

    const kvKey = `google:${p.sub}`;
    if (await kv.get(`user:${kvKey}:profile`, { type: 'text' }))
      return respond({ error: 'A Rounds account already exists for this Google account. Sign in with Google instead.' }, 409, cors);

    if (!await kv.get(`user:${oldId}:profile`, { type: 'text' }))
      return respond({ error: 'Source account not found' }, 404, cors);

    // Data is usually end-to-end encrypted, so only the plain envelope field
    // changes; the passphrase keeps working.
    await moveAccount(kv, oldId, kvKey, prof => {
      prof.authMethod = 'google';
      delete prof.userToken;
      prof.lastModified = Date.now();
      return prof;
    });
    await deleteAccountKeys(kv, oldId);
    await kv.delete(writeKeyId(oldId));
    // Keep a morning reminder running under the new account id.
    if (await kv.get(`rindex:${oldId}`, { type: 'text' })) {
      await kv.put(`rindex:${kvKey}`, '1');
      await kv.delete(`rindex:${oldId}`);
    }
    // Other devices still on the old token get a 410 and are sent to Google sign-in.
    await kv.put(`migrated:${oldId}`, kvKey, { expirationTtl: MIGRATED_TTL });

    return respond({ ok: true, kvKey, profile: p }, 200, cors);
  }

  return null;
}

// ── Storage ────────────────────────────────────────────────────────────────

async function handleStorage(request, env, pathname, cors) {
  const kv = env[KV_BINDING];
  if (!kv) return respond({ error: 'KV not configured' }, 500, cors);

  const parts = pathname.split('/').filter(Boolean);   // ['storage', token, ...key]
  if (parts.length < 2) return respond({ error: 'Token required' }, 400, cors);

  const token = decodeURIComponent(parts[1]);
  if (!isValidToken(token)) return respond({ error: 'Invalid token format' }, 400, cors);

  // Never write a raw (pre-v2.1) token into a key name.
  const rlId = isLegacyId(token) ? await fingerprintOf(token) : token;
  const rl = await slidingLimit(env, `ratelimit:${rlId}`, RATE_LIMIT, RATE_LIMIT_WINDOW);
  if (rl) return tooMany(rl, cors);

  const method = request.method.toUpperCase();

  // A token that was upgraded to Google stops working everywhere.
  const migratedTo = await kv.get(`migrated:${token}`, { type: 'text' });
  if (migratedTo) {
    return respond({ migrated: true, authMethod: 'google' }, 410, { ...cors, 'X-Account-Migrated': 'google' });
  }
  // A pre-v2.1 raw token whose account has moved to its fingerprint id.
  if (isLegacyId(token) && await getWriteKey(env, await fingerprintOf(token))) {
    return respond({ rekeyed: true }, 410, { ...cors, 'X-Account-Rekeyed': '1' });
  }

  if (parts.length === 2) {
    if (method !== 'GET') return respond({ error: 'Method not allowed' }, 405, cors);
    const auth = await checkAuth(request, token, cors, '', env);
    if (!auth.ok) return auth.res;
    const prefix = `user:${token}:`;
    const list   = await kv.list({ prefix });
    return respond({ keys: list.keys.map(k => k.name.slice(prefix.length)), list_complete: list.list_complete }, 200, cors);
  }

  const userKey = parts.slice(2).map(decodeURIComponent).join('/');
  if (!/^[a-zA-Z0-9_\-./]{1,256}$/.test(userKey)) return respond({ error: 'Invalid key format' }, 400, cors);
  const kvKey = `user:${token}:${userKey}`;

  if (method === 'GET') {
    const auth = await checkAuth(request, token, cors, '', env);
    if (!auth.ok) return auth.res;
    const value = await kv.get(kvKey, { type: 'text' });
    if (value === null) return respond({ error: 'Not found' }, 404, cors);
    return respond(`{"value":${value}}`, 200, cors);
  }

  if (method === 'PUT') {
    const bodyText = await readBodyText(request);
    if (bodyText === null) return respond({ error: 'Invalid or oversized body' }, 400, cors);
    let parsed;
    try { parsed = JSON.parse(bodyText); } catch { return respond({ error: 'Invalid JSON' }, 400, cors); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return respond({ error: 'Body must be a JSON object' }, 400, cors);

    const auth = await checkAuth(request, token, cors, bodyText, env);
    if (!auth.ok) return auth.res;

    if (userKey === 'reminder') {
      let prev = null;
      try { prev = JSON.parse(await kv.get(kvKey, { type: 'text' }) || 'null'); } catch {}
      const clean = cleanReminder(parsed, prev);
      if (clean.error) return respond({ error: clean.error }, 400, cors);
      await kv.put(kvKey, JSON.stringify(clean.value), { expirationTtl: KV_TTL });
      if (clean.value.enabled) await kv.put(`rindex:${token}`, '1');
      else await kv.delete(`rindex:${token}`);
      return respond({ ok: true, value: clean.value }, 200, cors);
    }

    await kv.put(kvKey, JSON.stringify(parsed), { expirationTtl: KV_TTL });
    return respond({ ok: true }, 200, cors);
  }

  if (method === 'DELETE') {
    const auth = await checkAuth(request, token, cors, '', env);
    if (!auth.ok) return auth.res;
    await kv.delete(kvKey);
    if (userKey === 'reminder') await kv.delete(`rindex:${token}`);
    return respond({ ok: true }, 200, cors);
  }

  return respond({ error: 'Method not allowed' }, 405, cors);
}

// ── Morning reminders (ntfy) ───────────────────────────────────────────────

const REMINDER_GRACE_MIN = 60;   // a missed cron run can still send up to an hour late
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// The wall-clock date, weekday and minute-of-day in a timezone. Intl handles
// daylight saving, so a reminder stays at the same local time all year.
function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, dow: DOW[p.weekday], minutes: (+p.hour % 24) * 60 + (+p.minute) };
}
const toMinutes = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Validate and normalise reminder settings from the app. Keeps lastSent from
// the stored copy, and if the time has already passed today, counts today as
// done so saving at 8:20 for 8:00 doesn't fire immediately.
function cleanReminder(r, prev, now = Date.now()) {
  if (!r || typeof r !== 'object') return { error: 'Invalid settings' };
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time || '') ? r.time : null;
  if (!time) return { error: 'Time must be HH:MM' };
  const days = Array.isArray(r.days) ? [...new Set(r.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
  if (r.enabled && !days.length) return { error: 'Pick at least one day' };
  const tz = typeof r.tz === 'string' ? r.tz : '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { return { error: 'Unknown timezone' }; }
  let server;
  try {
    const u = new URL(String(r.server || 'https://ntfy.sh'));
    if (u.protocol !== 'https:') return { error: 'ntfy server must use https://' };
    server = u.origin + u.pathname.replace(/\/+$/, '');
  } catch { return { error: 'Invalid ntfy server URL' }; }
  const topic = String(r.topic || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) return { error: 'Topic: 1–64 letters, numbers, - or _' };
  const tokenStr = String(r.token || '');
  if (tokenStr.length > 200 || /[^\x21-\x7e]/.test(tokenStr)) return { error: 'Invalid access token' };
  let appUrl = '';
  try { if (r.appUrl) { const u = new URL(String(r.appUrl)); if (u.protocol === 'https:' || u.hostname === 'localhost') appUrl = u.href.slice(0, 300); } } catch {}

  const value = { enabled: !!r.enabled, time, days, tz, server, topic, token: tokenStr, appUrl, lastSent: prev?.lastSent || '' };
  const lp = localParts(now, tz);
  if (value.enabled && lp.minutes >= toMinutes(time)) value.lastSent = lp.date;
  return { value };
}

async function sendNtfy(r, test = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (r.token) headers.Authorization = `Bearer ${r.token}`;
  const msg = {
    topic: r.topic,
    title: 'Rounds',
    message: test ? 'Test reminder — notifications are working.' : 'Time to make your rounds.',
    tags: ['clipboard'],
  };
  if (r.appUrl) msg.click = r.appUrl;
  try {
    const res = await fetch(r.server + '/', { method: 'POST', headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(10000) });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: String(e && e.message || e) };
  }
}

// Cron entry: send every reminder that's due now.
async function runReminders(env, now) {
  const kv = env[KV_BINDING];
  let cursor, sent = 0;
  do {
    const listed = await kv.list({ prefix: 'rindex:', cursor });
    for (const k of listed.keys) {
      const id  = k.name.slice('rindex:'.length);
      const key = `user:${id}:reminder`;
      let r = null;
      try { r = JSON.parse(await kv.get(key, { type: 'text' }) || 'null'); } catch {}
      if (!r || !r.enabled) { await kv.delete(k.name); continue; }
      let lp;
      try { lp = localParts(now, r.tz); } catch { continue; }
      const target = toMinutes(r.time);
      if (!r.days.includes(lp.dow)) continue;
      if (lp.minutes < target || lp.minutes >= target + REMINDER_GRACE_MIN) continue;
      if (r.lastSent === lp.date) continue;
      const res = await sendNtfy(r);
      // On failure, leave lastSent alone so the next run (within the grace
      // window) tries again.
      if (res.ok) { r.lastSent = lp.date; r.lastError = ''; sent++; }
      else r.lastError = `${new Date(now).toISOString()} HTTP ${res.status}${res.error ? ' ' + res.error : ''}`;
      await kv.put(key, JSON.stringify(r), { expirationTtl: KV_TTL });
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return sent;
}

// POST /reminder/:id/test — send a test with the settings in the body (signed
// like a storage write), so the app can test before saving.
async function handleReminderTest(request, env, pathname, cors) {
  const parts = pathname.split('/').filter(Boolean);    // ['reminder', id, 'test']
  if (parts.length !== 3 || parts[2] !== 'test' || request.method.toUpperCase() !== 'POST')
    return respond({ error: 'Not found' }, 404, cors);
  const id = decodeURIComponent(parts[1]);
  if (!isValidToken(id) || isLegacyId(id)) return respond({ error: 'Invalid account id' }, 400, cors);
  const bodyText = await readBodyText(request);
  let body;
  try { body = JSON.parse(bodyText || ''); } catch { return respond({ error: 'Invalid JSON' }, 400, cors); }
  const auth = await checkAuth(request, id, cors, bodyText, env);
  if (!auth.ok) return auth.res;
  const rl = await slidingLimit(env, `rl:rtest:${id}`, 10, 3600);
  if (rl) return tooMany(rl, cors);
  const clean = cleanReminder({ ...body, enabled: false }, null);
  if (clean.error) return respond({ error: clean.error }, 400, cors);
  const res = await sendNtfy(clean.value, true);
  return respond({ ok: res.ok, status: res.status, error: res.ok ? undefined : (res.error || `ntfy returned HTTP ${res.status}`) }, 200, cors);
}

// ── Body helper ────────────────────────────────────────────────────────────

async function readBodyText(request) {
  const cl = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (cl > MAX_BODY_SIZE) return null;
  try {
    const text = await request.text();
    return text.length > MAX_BODY_SIZE ? null : text;
  } catch { return null; }
}

// ── Entry point ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();
    const ip     = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

    // Health check — open CORS, no auth (the setup wizard's "Test" button).
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/ping')) {
      return new Response(JSON.stringify({ ok: true, ts: Date.now(), app: 'Rounds' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
    const origin = getAllowedOrigin(request, allowedOrigins);
    if (!origin) return respond({ error: 'Forbidden — origin not in ALLOWED_ORIGINS' }, 403);
    const cors = buildCors(origin);

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname.startsWith('/auth/')) {
        const r = await handleAuth(url, method, request, env, cors, ip);
        if (r) return r;
      }
      if (url.pathname === '/storage' || url.pathname.startsWith('/storage/')) {
        return await handleStorage(request, env, url.pathname.replace(/\/$/, ''), cors);
      }
      if (url.pathname.startsWith('/reminder/')) {
        return await handleReminderTest(request, env, url.pathname.replace(/\/$/, ''), cors);
      }
      return respond({ error: 'Not found' }, 404, cors);
    } catch (err) {
      console.error('Worker error:', err);
      return respond({ error: 'Internal server error' }, 500, cors);
    }
  },

  // Cron Trigger ("*/5 * * * *") — morning reminders.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env, event.scheduledTime || Date.now()));
  },
};

export { runReminders, cleanReminder, localParts };   // for tests
