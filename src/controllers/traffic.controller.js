import {
    fetchKeywordOverviewApiResponse,
    parseKeywordOverviewApiResponse,
} from '../services/dataforseo.service.js';
import { cleanKeyword } from '../utils/trafficCalculator.js';

/**
 * Analyzes search demand for a list of keywords.
 * Strips location terms and fetches bulk volume from DataForSEO.
 */
export async function analyzeDemand(req, res) {
    const { keywords, locationContext } = req.body;

    if (!Array.isArray(keywords) || keywords.length === 0) {
        return res.status(400).json({ error: 'Keywords array is required' });
    }

    try {
        console.log(`[TrafficCtrl] Analyzing demand for ${keywords.length} keywords...`);
        
        // Step 1: Clean Keywords
        const cleanedKeywords = [...new Set(keywords.map(kw => cleanKeyword(kw, locationContext)))];
        
        console.log(`[TrafficCtrl] Cleaned to unique service intents: ${cleanedKeywords.join(', ')}`);

        // Step 2: Fetch Bulk Volume
        const demandData = await fetchKeywordOverview({
            keywords: cleanedKeywords,
            location_name: 'United States', // Standard for demand analysis
            language_code: 'en'
        });

        // Step 3: Format for UI
        const results = demandData.map(item => ({
            keyword: item.keyword,
            monthlyVolume: item.monthlyVolume,
            dailyAverage: item.dailyAverage,
            month: item.month
        }));

        return res.json({
            ok: true,
            businessName: req.body.businessName || 'Unknown Business',
            count: results.length,
            results
        });

    } catch (error) {
        console.error('[TrafficCtrl] analyzeDemand Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
}

/**
 * Fetches volume for a single keyword with minimal terminal logging.
 */
export async function getVolumeLight(req, res) {
    const { keyword, locationContext } = req.body;
    if (!keyword) return res.status(400).json({ error: 'Keyword is required' });

    try {
        console.log('[TrafficCtrl] /traffic-tracker', { keyword });
        const cleaned = cleanKeyword(keyword, locationContext || '');
        /**
         * IMPORTANT (playground parity):
         * DataForSEO Playground splits comma-separated input into multiple keywords (e.g. "...Whittier, CA 90604, USA").
         * If we only send the full phrase, Labs can legitimately return items_count: 0, which means no monthly_searches.
         */
        const original = String(keyword).trim();
        const commaParts = original
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        const commaPartsLower = commaParts.map((s) => s.toLowerCase());

        // Also try removing common modifiers that can prevent matches in Labs DB
        const deMod = cleaned
            .replace(/\b(best|affordable|cheap|top|near)\b/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        // Candidate priority: exact original → cleaned → comma parts (playground) → demod cleaned
        const candidates = [
            original,
            cleaned,
            ...commaParts,
            ...commaPartsLower,
            deMod,
        ]
            .map((s) => String(s || '').trim())
            .filter(Boolean);

        const uniqueCandidates = [...new Set(candidates)];
        // Default: return full playground-style response (can be disabled with full=0)
        const full = !(
            req.query?.full === '0' ||
            req.query?.full === 0 ||
            req.body?.full === false ||
            req.body?.full === 0 ||
            req.body?.full === '0'
        );

        const apiMeta = await fetchKeywordOverviewApiResponse({
            keywords: uniqueCandidates,
            location_code: 2840,
            language_code: 'en',
        });
        if (!apiMeta.response.ok || apiMeta.data?.status_code !== 20000) {
            throw new Error(`Labs API Error: ${apiMeta.data?.status_message || apiMeta.response.statusText}`);
        }
        const demandData = parseKeywordOverviewApiResponse(apiMeta.data);

        const byKw = new Map(
            (demandData || []).map((d) => [String(d.keyword || '').trim().toLowerCase(), d])
        );
        const picked =
            byKw.get(original.toLowerCase()) ||
            byKw.get(String(cleaned).trim().toLowerCase()) ||
            // Try playground-style comma parts (e.g. "usa")
            commaPartsLower.map((p) => byKw.get(p)).find(Boolean) ||
            byKw.get(deMod.toLowerCase()) ||
            // last resort: first returned item
            ((demandData && demandData.length) ? demandData[0] : null) ||
            null;
        const item = picked || { keyword: cleaned, monthlyVolume: 0, dailyAverage: 0, month: 'N/A', raw: null };
        
        // USER REQUEST: Specific terminal log format (Keyword "search_volume": XXX)
        console.log(`${keyword} "search_volume": ${item.monthlyVolume}`);
        console.log(`${keyword} "month": ${item.month}`);

        return res.json({
            ok: true,
            keyword: item.keyword || cleaned,
            volume: item.monthlyVolume,
            month: item.month,
            dailyAverage: item.dailyAverage,
            raw: item.raw,
            dataforseo_full_response: full ? apiMeta.data : null,
            dataforseo_payload: full ? apiMeta.payload : null
        });
    } catch (error) {
        console.error('[TrafficCtrl] getVolumeLight Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
}
