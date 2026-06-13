/**
 * Verifies which Google identity the current GMB_REFRESH_TOKEN belongs to.
 * Loads the same .env as google-search-ranking/server (parent + server/.env).
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.resolve(serverRoot, '../../.env') });
dotenv.config({ path: path.resolve(serverRoot, '.env'), override: true });

const clientId = (process.env.GMB_CLIENT_ID || '').trim();
const clientSecret = (process.env.GMB_CLIENT_SECRET || '').trim();
const refreshToken = (process.env.GMB_REFRESH_TOKEN || '').trim();
const expected = (process.env.GMB_EXPECTED_GOOGLE_EMAIL || 'info@systemicdigital.io').trim().toLowerCase();

function decodeJwtPayload(jwt) {
  if (!jwt || typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    try {
      return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }
}

if (!clientId || !clientSecret || !refreshToken) {
  console.error(JSON.stringify({ ok: false, error: 'Missing GMB_CLIENT_ID / GMB_CLIENT_SECRET / GMB_REFRESH_TOKEN' }, null, 2));
  process.exit(1);
}

const { data: tok } = await axios.post('https://oauth2.googleapis.com/token', {
  client_id: clientId,
  client_secret: clientSecret,
  refresh_token: refreshToken,
  grant_type: 'refresh_token',
});

const access = tok.access_token;
const idPayload = decodeJwtPayload(tok.id_token);

let tokeninfo = null;
try {
  const { data } = await axios.get('https://www.googleapis.com/oauth2/v3/tokeninfo', {
    params: { access_token: access },
  });
  tokeninfo = { audience: data.audience, scope: data.scope, expires_in: data.expires_in, email: data.email || null, sub: data.sub || null };
} catch (e) {
  tokeninfo = { error: e.response?.data || e.message };
}

let userinfo = null;
try {
  const { data } = await axios.get('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${access}` },
  });
  userinfo = { sub: data.sub, email: data.email, email_verified: data.email_verified };
} catch (e) {
  userinfo = { error: String(e.response?.status), detail: e.response?.data || e.message };
}

const emailFromId =
  idPayload?.email ||
  idPayload?.email_address ||
  (typeof idPayload?.email === 'string' ? idPayload.email : null);
const resolvedEmail = (emailFromId || tokeninfo?.email || userinfo?.email || '').trim().toLowerCase() || null;

const out = {
  ok: true,
  expectedEmail: expected,
  resolvedGoogleEmail: resolvedEmail,
  matchesExpected: resolvedEmail ? resolvedEmail === expected : null,
  idTokenPresent: Boolean(tok.id_token),
  idTokenClaims: idPayload
    ? { email: idPayload.email || null, sub: idPayload.sub || null, aud: idPayload.aud || null }
    : null,
  tokeninfo,
  openidUserinfo: userinfo,
  grantedScopeFromRefresh: tok.scope || null,
  note:
    resolvedEmail
      ? resolvedEmail === expected
        ? 'Refresh token is for the expected Google account.'
        : `Refresh token is for "${resolvedEmail}", not "${expected}". Re-run OAuth signed in as ${expected} and update GMB_REFRESH_TOKEN.`
      : 'Google did not return an email for this token (common when only business.manage was granted). Add openid + email scopes to OAuth and re-consent, OR trust that whoever completed OAuth used the right account.',
};

console.log(JSON.stringify(out, null, 2));
process.exit(resolvedEmail && resolvedEmail !== expected ? 2 : 0);
