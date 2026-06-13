/**
 * CORS for Client Hub, Formflow Admin, and ranking frontends → ranking API.
 */

const EXPLICIT_ORIGINS = [
  'https://formflow-buddy-admin.synoventum.us.cc',
  'https://www.formflow-buddy-admin.synoventum.us.cc',
  'https://clienthub.systemicdigital.io',
  'https://www.clienthub.systemicdigital.io',
  'https://google-search-ranking.synoventum.us.cc',
  'https://www.google-search-ranking.synoventum.us.cc',
  'https://google-search-ranking-api.synoventum.us.cc',
  'https://www.google-search-ranking-api.synoventum.us.cc',
  'https://5892c2a2-af8f-4eb4-b421-2b0d5b5a50ae.lovableproject.com',
];

const ORIGIN_PATTERNS = [
  /^https:\/\/google-search-ranking(-api)?\.synoventum\.us\.cc$/,
  /^https:\/\/www\.google-search-ranking(-api)?\.synoventum\.us\.cc$/,
  /^https:\/\/formflow-buddy-admin\.synoventum\.us\.cc$/,
  /^https:\/\/www\.formflow-buddy-admin\.synoventum\.us\.cc$/,
  /^https:\/\/formflow-buddy-[0-9]+\.vercel\.app$/,
  /^https:\/\/formflow-buddy-03-hgsnsc082-systemicdigitals-projects\.vercel\.app$/,
  /^https:\/\/formflow-buddy-03-[a-z0-9-]+-systemicdigitals-projects\.vercel\.app$/,
  /^https:\/\/clienthub\.systemicdigital\.io$/,
  /^https:\/\/www\.clienthub\.systemicdigital\.io$/,
  /^https:\/\/[a-z0-9-]+\.lovable\.app$/,
  /** Lovable preview / hosted project URLs (e.g. *.lovableproject.com) */
  /^https:\/\/[a-z0-9-]+\.lovableproject\.com$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

function extraOriginsFromEnv() {
  return String(process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Avoid flooding PM2 error log when a dev preview polls the API. */
const blockedOriginWarned = new Set();

/** @param {string | undefined} origin */
export function isCorsOriginAllowed(origin) {
  if (!origin) return false;
  const o = String(origin).trim().replace(/\/+$/, '');
  if (EXPLICIT_ORIGINS.includes(o)) return true;
  for (const extra of extraOriginsFromEnv()) {
    if (extra === o) return true;
  }
  return ORIGIN_PATTERNS.some((re) => re.test(o));
}

export function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && isCorsOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
}

export function createEarlyCorsMiddleware() {
  return (req, res, next) => {
    applyCorsHeaders(req, res);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
      const requested = req.headers['access-control-request-headers'];
      res.setHeader(
        'Access-Control-Allow-Headers',
        requested ||
          'Content-Type, Authorization, Accept, x-formflow-crm-key, X-Automation-Client',
      );
      res.setHeader('Access-Control-Max-Age', '86400');
      return res.status(204).end();
    }
    next();
  };
}

export function getCorsOptions() {
  return {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (isCorsOriginAllowed(origin)) return cb(null, origin);
      if (!blockedOriginWarned.has(origin)) {
        blockedOriginWarned.add(origin);
        console.warn(`[CORS] blocked origin (logged once): ${origin}`);
      }
      return cb(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
    optionsSuccessStatus: 204,
  };
}

export function logCorsBootSummary() {
  const extras = extraOriginsFromEnv();
  console.log(
    `[CORS] Allowed: formflow-buddy-admin, clienthub, synoventum ranking, lovable.app / lovableproject.com. Extra: ${
      extras.length ? extras.join(', ') : '(none)'
    }`,
  );
}
