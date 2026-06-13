import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { refreshLocationsSnapshotFromLiveApi } from '../src/services/gmb.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.resolve(serverRoot, '../../.env') });
dotenv.config({ path: path.resolve(serverRoot, '.env'), override: true });

const clientId = (process.env.GMB_CLIENT_ID || '').trim();
const clientSecret = (process.env.GMB_CLIENT_SECRET || '').trim();
const refreshToken = (process.env.GMB_REFRESH_TOKEN || '').trim();

if (!clientId || !clientSecret || !refreshToken) {
  console.error('Missing GMB_CLIENT_ID / GMB_CLIENT_SECRET / GMB_REFRESH_TOKEN in env');
  process.exit(1);
}

const { data: tok } = await axios.post('https://oauth2.googleapis.com/token', {
  client_id: clientId,
  client_secret: clientSecret,
  refresh_token: refreshToken,
  grant_type: 'refresh_token',
});

function decodeJwtEmail(idToken) {
  if (!idToken || typeof idToken !== 'string') return { email: null, sub: null };
  const parts = idToken.split('.');
  if (parts.length < 2) return { email: null, sub: null };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return { email: payload.email || null, sub: payload.sub || null };
  } catch {
    return { email: null, sub: null };
  }
}

const fromId = decodeJwtEmail(tok.id_token);

/** Never downgrade to null if a prior step already found email/subject. */
let connectedEmail = fromId.email;
let googleSubject = fromId.sub;
try {
  const { data: info } = await axios.get('https://www.googleapis.com/oauth2/v3/tokeninfo', {
    params: { access_token: tok.access_token },
  });
  if (info?.email) connectedEmail = info.email;
  if (info?.sub) googleSubject = info.sub;
} catch {
  /* tokeninfo can fail for some token types — keep id_token-derived values */
}
if (!connectedEmail || !googleSubject) {
  try {
    const { data: me } = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (me?.email) connectedEmail = me.email;
    if (me?.sub) googleSubject = me.sub;
  } catch {
    /* userinfo often 401 without OpenID scopes — id_token / tokeninfo is enough */
  }
}

const labelEmail = (process.env.GMB_EXPORT_LABEL_EMAIL || '').trim();
const hadIdTokenEmail = Boolean(fromId.email);

const emailResolvedFrom = connectedEmail
  ? hadIdTokenEmail
    ? 'oauth_id_token'
    : 'tokeninfo_or_userinfo'
  : labelEmail
    ? 'env_GMB_EXPORT_LABEL_EMAIL'
    : 'not_available';

const note =
  connectedEmail || labelEmail
    ? null
    : 'OAuth refresh did not include id_token email and tokeninfo/userinfo did not return email (common for GMB-only scopes). The businesses list is still complete for this refresh token. Optional: set GMB_EXPORT_LABEL_EMAIL in server/.env to tag exports, or re-authorize once with OpenID email scopes.';
const out = await refreshLocationsSnapshotFromLiveApi({
  connectedGoogleEmail: connectedEmail,
  labeledAsEmail: labelEmail || null,
  googleSubject,
  emailResolvedFrom,
  note,
});

console.log(
  JSON.stringify(
    {
      connectedGoogleEmail: connectedEmail,
      labeledAsEmail: labelEmail || null,
      emailResolvedFrom,
      totalLocations: out.totalLocations,
      meta: out.meta || null,
      written: path.join(serverRoot, 'data', 'gmb_connected_businesses.json'),
    },
    null,
    2
  )
);
