import { fetchJsonWithRetry, sleep, resolveDataForSeoLocation } from './rankAndScreenshot.service.js';

/**
 * DataForSEO Labs API: Keyword Overview
 * Uses United States (Location 2840) and English (Language 'en') as standard.
 */
function buildKeywordOverviewPayload({ keywords, location_code, language_code }) {
  // Default to US if not provided
  const loc = location_code || 2840;
  const lang = language_code || 'en';
  return [
    {
      keywords: keywords,
      location_code: loc,
      language_code: lang,
      include_serp_info: false,
      include_clickstream_data: false,
    },
  ];
}

export async function fetchKeywordOverviewApiResponse({ keywords, location_code, language_code }) {
  const login = (process.env.DATAFORSEO_LOGIN || '').trim();
  const password = (process.env.DATAFORSEO_PASSWORD || '').trim();
  if (!login || !password) throw new Error('DataForSEO credentials missing');

  const auth = Buffer.from(`${login}:${password}`).toString('base64');
  const payload = buildKeywordOverviewPayload({ keywords, location_code, language_code });

  console.log(`[DataForSEO Labs] Fetching overview for: ${keywords.join(', ')}`);

  const { response, data } = await fetchJsonWithRetry(
    'https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_overview/live',
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }
  );

  return { response, data, payload };
}

export function parseKeywordOverviewApiResponse(data) {
  /**
   * DataForSEO Labs returns either:
   * - New format (most common): { tasks: [ { result: [ { items: [...] } ] } ] }
   * - Legacy format (older docs/examples): { result: [ { items: [...] } ] }
   */
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const legacyResults = Array.isArray(data?.result) ? data.result : [];

  const allKeywordItems =
    tasks.length > 0
      ? tasks.flatMap((t) => (t?.result || [])).flatMap((r) => r?.items || [])
      : legacyResults.flatMap((r) => r?.items || []);

  return allKeywordItems.map((item) => {
    let monthlyVolume = 0;
    let daysInMonth = 30;
    let sourceMonth = 'N/A';

    // USER REQUEST: Get the LATEST month data (e.g. index 0 in monthly_searches)
    if (item.keyword_info?.monthly_searches?.length > 0) {
      const latest = item.keyword_info.monthly_searches[0];
      monthlyVolume = latest.search_volume || 0;
      const year = latest.year;
      const month = latest.month;
      sourceMonth = `${month}/${year}`;

      // Dynamic days in month
      daysInMonth = new Date(year, month, 0).getDate();
    } else {
      monthlyVolume = item.keyword_info?.search_volume || 0;
    }

    const dailyAverage = Math.round((monthlyVolume / daysInMonth) * 10) / 10;

    return {
      keyword: item.keyword,
      monthlyVolume: monthlyVolume,
      dailyAverage: dailyAverage,
      month: sourceMonth,
      days: daysInMonth,
      raw: item,
    };
  });
}

export async function fetchKeywordOverview({ keywords, location_code, language_code }) {
  const { response, data } = await fetchKeywordOverviewApiResponse({ keywords, location_code, language_code });

  if (!response.ok || data.status_code !== 20000) {
    throw new Error(`Labs API Error: ${data.status_message || response.statusText}`);
  }
  return parseKeywordOverviewApiResponse(data);
}
