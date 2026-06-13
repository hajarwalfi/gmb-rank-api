/**
 * OpenAI-powered local SEO keyword generation for Google Maps ranking scans.
 * Prefers shared root OpenAI client config, falls back to env-based client.
 */
import OpenAI from 'openai';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/** Default model: cost-effective; override with OPENAI_MODEL (e.g. gpt-4.1-mini). */
const DEFAULT_MODEL = 'gpt-4o-mini';
const REQUEST_TIMEOUT_MS = 90_000;
const KEYWORDS_TARGET_COUNT = 6;

/** Inclusive random integer — used for 4–8 snapshot rows / automation batch size. */
export function randomIntInclusive(min, max) {
  const a = Math.ceil(Number(min));
  const b = Math.floor(Number(max));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return KEYWORDS_TARGET_COUNT;
  return a + Math.floor(Math.random() * (b - a + 1));
}

function getSharedOpenAiClient() {
  try {
    const shared = require('../../../../config/openai.js');
    if (shared && shared.chat?.completions?.create) return shared;
  } catch {
    // fall through to env-based client
  }
  return null;
}

function heuristicCountryFromLocations(locations = []) {
  const text = locations.map((x) => String(x || '').toLowerCase()).join(' | ');
  if (!text) return null;
  if (/\b(india|in)\b/.test(text)) return 'India';
  if (/\b(united states|usa|us)\b/.test(text)) return 'United States';
  if (/\b(united kingdom|uk|england|scotland|wales)\b/.test(text)) return 'United Kingdom';
  if (/\b(canada|ontario|alberta|british columbia)\b/.test(text)) return 'Canada';
  if (/\b(australia|nsw|victoria|queensland)\b/.test(text)) return 'Australia';
  if (/\b(spain|españa)\b/.test(text)) return 'Spain';
  if (/\b(germany|deutschland)\b/.test(text)) return 'Germany';
  return null;
}

/**
 * Merge deterministic "category + area" keywords with AI suggestions.
 * Preserves order: base first, then AI. De-duplicates case-insensitively.
 *
 * @param {string[]} baseKeywords
 * @param {string[]} aiKeywords
 * @returns {string[]}
 */
export function mergeKeywordLists(baseKeywords = [], aiKeywords = []) {
  const seen = new Set();
  const out = [];
  for (const k of [...baseKeywords, ...aiKeywords]) {
    const t = String(k ?? '').trim();
    if (!t) continue;
    const low = t.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(t);
  }
  return out;
}

/**
 * Parse plain list from Chat Completions: one keyword per line, strip numbering/bullets.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseKeywordsFromOpenAiText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];

  const lines = raw.includes('\n')
    ? raw.split(/\r?\n/)
    : raw.split(',').map((s) => s.trim());

  const cleaned = [];
  for (let line of lines) {
    line = String(line).trim();
    if (!line) continue;
    // "1. keyword", "2) keyword", "- keyword", "* keyword"
    line = line.replace(/^\s*\d+[\s.)[\]-]+\s*/i, '').trim();
    line = line.replace(/^[-*•]+\s*/, '').trim();
    line = line.replace(/^["']|["']$/g, '').trim();
    if (line.length > 240) line = line.slice(0, 240);
    if (line) cleaned.push(line);
  }

  const seen = new Set();
  const deduped = [];
  for (const k of cleaned) {
    const low = k.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    deduped.push(k);
  }
  // Target ~30 from prompt; allow headroom for 25–40 quality range without runaway lists
  return deduped.slice(0, 40);
}

function buildPrompt(businessName, service, locationsText, count = KEYWORDS_TARGET_COUNT) {
  const isGeneric = !locationsText || locationsText.toLowerCase() === 'usa' || locationsText.toLowerCase() === 'spain' || locationsText.toLowerCase() === 'local area' || locationsText.trim() === '';
  const n = Math.max(4, Math.min(20, Number(count) || KEYWORDS_TARGET_COUNT));
  const minLoc = Math.min(n, Math.max(1, Math.min(4, Math.floor(n * 0.65))));

  return `You are a local SEO expert.

Generate high-quality, real-world search keywords that people actually type on Google for this specific business.

Business Name: ${businessName}
Business type: ${service}
Locations/Service Area: ${locationsText || 'Local area'}

Guidelines:
- Return exactly ${n} keywords.
- PRIORITY: maximize local rank potential by keeping keywords natural, short (3-7 words), and high intent.
- Use only realistic buying intent modifiers: best, top rated, affordable, emergency, same day, near [city].
- Do NOT create random variants or fluff. Avoid broad low-intent phrasing.
- Include location in at least ${minLoc} keywords when locations are available.
- Keep at most 1 "near me" keyword.
- Format: "intent + service + city/area" OR "service + city/area".

${isGeneric ? '- Since specific city is not provided, keep strong service-intent keywords without hallucinating cities.' : '- Use these exact service areas naturally where relevant: ' + locationsText}

Return as a clean plain list without numbering, bullets, or explanation. One keyword per line.`;
}

/**
 * Tight prompt: service (category) + location only — short phrases people type in Google Maps / local search.
 * Avoids long "AI marketing" style keyword spam. Used when KEYWORDS_AI_SERVICE_LOCATION_STRICT=true (default).
 */
function buildPromptServiceLocationStrict(
  businessName,
  service,
  locationsText,
  count = KEYWORDS_TARGET_COUNT,
  { manualDeep = false } = {}
) {
  const loc = String(locationsText || '').trim() || 'Local area';
  const svc = String(service || '').trim() || 'local business';
  const name = String(businessName || '').trim() || 'Business';
  const n = Math.max(4, Math.min(20, Number(count) || KEYWORDS_TARGET_COUNT));

  const manualBlock =
    manualDeep && n >= 10
      ? `

MANUAL RANKING RUN (${n} keywords): diversify across BOTH distinct services implied in "${svc}" AND distinct cities/areas from the list. Favor SEO shapes like:
"best [trade] in [City, ST]", "affordable [service] [Neighborhood]", "[service] near [Suburb]", "top rated [service] [City] USA".
Still keep 3–7 words per line; no paragraphs.`
      : '';

  return `You help with Google Maps / local pack keyword ideas.

Business name (reference only — do not copy long): ${name}
Core service type (use this meaning, keep wording short): ${svc}
Service areas / cities to use (spread across lines): ${loc}

TASK: Return exactly ${n} keywords. Each line must be a SHORT local search query.

STRICT RULES:
- Every line MUST combine: (core service idea matching "${svc}") + (a place from the list above OR "near me" for at most ONE line).
- Length: 3–6 words per line. Never more than 7 words.
- Style examples (follow this density only): "plumber in Miami", "roofing contractor Houston Heights", "pressure washing Palm Bay", "best painter in Midland, TX USA".
- Use at most one light modifier per line from: best, affordable, emergency, top rated, same day — not all lines need a modifier.
- Forbidden: long sentences, rhetorical questions, duplicate concepts with tiny word swaps, fluffy adjectives, invented services not implied by the service type, hashtags, brand slogans.
- Do not output the business legal name as the whole keyword unless it is a normal local query.
${manualBlock}
Output: plain text, one keyword per line, no numbers, no bullets, no blank lines, no explanation.`;
}

/**
 * Generate SEO search keywords via OpenAI. On any failure, returns [] so callers
 * can fall back to deterministic keywords only.
 *
 * @param {string} businessName - Name of the business
 * @param {string} service - Primary category / service type (e.g. "Plumbing contractor")
 * @param {string[]} locations - Cities or service areas (e.g. ["Viera, FL", "Palm Bay, FL"])
 * @param {{ targetCount?: number; manualDeep?: boolean }} [options] — targetCount defaults to 6; use 10–15 for manual-run lists
 * @returns {Promise<string[]>}
 */
export async function generateKeywords(businessName, service, locations, options = {}) {
  /**
   * When true, skip OpenAI and return [] so callers use only deterministic
   * `RankingService.buildKeywords(category, areas)` style “service + area” phrases.
   * @see KEYWORDS_AI_DISABLED or SIMPLE_LOCAL_KEYWORDS_ONLY in server .env
   */
  const aiOff =
    String(process.env.KEYWORDS_AI_DISABLED || process.env.SIMPLE_LOCAL_KEYWORDS_ONLY || '')
      .trim()
      .toLowerCase() === 'true' || process.env.KEYWORDS_AI_DISABLED === '1';
  if (aiOff) return [];

  const sharedClient = getSharedOpenAiClient();
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!sharedClient && !apiKey) return [];

  const bizNameStr = String(businessName ?? '').trim();
  const serviceStr = String(service ?? '').trim();
  const locList = Array.isArray(locations)
    ? locations.map((l) => String(l).trim()).filter(Boolean)
    : [];

  if (!serviceStr || locList.length === 0) return [];

  const locationsText = locList.join(', ');
  const model = (process.env.OPENAI_MODEL || DEFAULT_MODEL).trim();

  const rawTc = Number(options?.targetCount);
  const targetCount = Number.isFinite(rawTc)
    ? Math.max(4, Math.min(20, Math.floor(rawTc)))
    : KEYWORDS_TARGET_COUNT;
  const manualDeep = Boolean(options?.manualDeep);

  const legacyPrompt =
    String(process.env.KEYWORDS_AI_LEGACY_PROMPT || '')
      .trim()
      .toLowerCase() === 'true' || process.env.KEYWORDS_AI_LEGACY_PROMPT === '1';

  const strictSl =
    String(process.env.KEYWORDS_AI_SERVICE_LOCATION_STRICT || 'true')
      .trim()
      .toLowerCase() !== 'false' &&
    process.env.KEYWORDS_AI_SERVICE_LOCATION_STRICT !== '0';

  let promptBody;
  let temperature;
  if (legacyPrompt) {
    promptBody = buildPrompt(bizNameStr, serviceStr, locationsText, targetCount);
    temperature = 0.6;
  } else if (strictSl) {
    promptBody = buildPromptServiceLocationStrict(bizNameStr, serviceStr, locationsText, targetCount, {
      manualDeep,
    });
    temperature = manualDeep && targetCount >= 10 ? 0.4 : 0.35;
  } else {
    promptBody = buildPrompt(bizNameStr, serviceStr, locationsText, targetCount);
    temperature = 0.55;
  }

  const client =
    sharedClient ||
    new OpenAI({
      apiKey,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 1,
    });

  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: promptBody }],
      temperature,
    });

    const text = completion.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) {
      console.warn('[KeywordGen] Empty completion content');
      return [];
    }

    const parsed = parseKeywordsFromOpenAiText(text);
    if (parsed.length < Math.min(4, targetCount)) {
      console.warn('[KeywordGen] Parsed very few keywords; model output may be malformed');
    }
    return parsed.slice(0, targetCount);
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[KeywordGen] OpenAI request failed:', msg);
    return [];
  }
}

/**
 * Infer country from service-area strings (AI + heuristic fallback).
 *
 * @param {string[]} locations
 * @returns {Promise<string|null>}
 */
export async function inferCountryFromLocations(locations = []) {
  const locList = Array.isArray(locations)
    ? locations.map((l) => String(l || '').trim()).filter(Boolean)
    : [];
  if (!locList.length) return null;

  const heuristic = heuristicCountryFromLocations(locList);
  if (heuristic) return heuristic;

  const sharedClient = getSharedOpenAiClient();
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!sharedClient && !apiKey) return null;

  const model = (process.env.OPENAI_MODEL || DEFAULT_MODEL).trim();
  const client =
    sharedClient ||
    new OpenAI({
      apiKey,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 1,
    });

  try {
    const completion = await client.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: `Infer the country from these service areas.\nService areas: ${locList.join(', ')}\nReturn only JSON: {"country": string|null}\nUse full English country name. If unknown return null.`,
        },
      ],
      temperature: 0.1,
    });
    const text = completion.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    const parsed = JSON.parse(text);
    const country = String(parsed?.country || '').trim();
    return country || null;
  } catch {
    return null;
  }
}
