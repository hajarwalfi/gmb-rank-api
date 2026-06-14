import * as FathomService from '../services/fathomService.js';
import * as AnalyzeService from '../services/analyzeService.js';
import * as ScoreCalculator from '../services/scoreCalculator.js';
import * as Repository from '../repositories/fathomOnboarding.repository.js';
import { buildAnalysisFromFlatResults } from '../config/checklistData.js';
import { createRequire } from 'module';
import axios from 'axios';
const require = createRequire(import.meta.url);
const openai = require('../../config/openai.js');

const FATHOM_API_BASE = 'https://api.fathom.ai/external/v1';
// Fathom API Keys from .env
const FATHOM_API_KEY = process.env.FATHOM_API_KEY || 'yZEBjejqs93ibjBdxKIl1Q.eM8OPv70cu5BPy1NunrVILWBnaFme863rlsRDr0Y0Xw';
const FATHOM_API_KEY_BACKUP = process.env.FATHOM_API_KEY_BACKUP || 'zdgdbNyIH49tM1HhRBMXTA.zhlx1FGF-EuzWghoh6Td-r0lcrkm3I6opFDMEpQAH6U';

// Helper for Fathom API with Rotate/Backup support
async function callFathomApi(endpoint, options = {}) {
  const keys = [FATHOM_API_KEY, FATHOM_API_KEY_BACKUP].filter(Boolean);
  let lastError;

  for (const key of keys) {
    try {
      console.log(`[Fathom] Attempting call to ${endpoint} with key starting with: ${key.substring(0, 10)}...`);
      const response = await axios({
        url: `${FATHOM_API_BASE}${endpoint}`,
        headers: { 'X-Api-Key': key },
        timeout: 60000,
        ...options
      });
      return response.data;
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      console.warn(`[Fathom] Call failed with key ${key.substring(0, 10)}... Status: ${status || err.message}`);
      // If it's a 401/403, it's definitely the key's problem, try next. 
      // If it's a 404, the meeting might not exist on this key's account. Try next.
      if (![401, 403, 404].includes(status)) {
        // For other errors (like timeouts), maybe don't retry with another key? 
        // Actually, let's try the next key anyway just in case.
      }
    }
  }
  throw lastError;
}

// Log on startup to verify keys are loaded
console.log(`[Fathom] Keys loaded: Primary: ${FATHOM_API_KEY ? 'Yes' : 'NO'}, Backup: ${FATHOM_API_KEY_BACKUP ? 'Yes' : 'NO'}`);


/**
 * PHASE 1: Initialize Analysis
 * Checks cache or fetches transcript.
 */
export async function initOnboardingAnalysis(req, res) {
  try {
    const { callLink, taskId, businessName, gmbProfileName, rawTranscript } = req.body;

    if (!taskId) return res.status(400).json({ error: 'taskId is required' });

    // 1. Check Cache
    if (callLink) {
      const cached = Repository.findFirstByFathomLink(callLink);
      if (cached) {
        console.log(`[controller] Cache Hit: ${callLink}. Linking to task: ${taskId}`);
        const saved = await Repository.saveReport({
          taskId,
          businessName: businessName || cached.businessName,
          gmbProfileName: gmbProfileName || cached.gmbProfileName,
          fathomLink: callLink,
          transcriptSource: 'cached',
          transcript: cached.transcript,
          analysis: cached.analysis,
          score: cached.score,
          status: cached.status,
          passedItems: cached.passedItems,
          totalItems: cached.totalItems,
          confidenceAvg: cached.confidenceAvg
        });
        return res.json({
          status: 'cached',
          reportId: saved.id,
          report: saved
        });
      }
    }

    // 2. Fetch Transcript
    let transcript = '';
    if (rawTranscript) {
      transcript = rawTranscript;
    } else if (callLink) {
      transcript = await FathomService.fetchTranscript(callLink);
    } else {
      return res.status(400).json({ error: 'Link or transcript required' });
    }

    const { conductor, client } = AnalyzeService.identifySpeakers(transcript);
    const chunks = AnalyzeService.getAnalysisChunks();

    return res.json({
      status: 'pending',
      transcript,
      conductor,
      client,
      totalBatches: chunks.length,
      batchNames: chunks.map(c => c.name)
    });
  } catch (err) {
    console.error('[controller] init error:', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * PHASE 2: Analyze a specific batch
 */
export async function analyzeOnboardingBatch(req, res) {
  try {
    const { transcript, conductor, client, batchIndex } = req.body;
    const openaiClient = typeof openai.getClient === 'function' ? openai.getClient() : openai;

    const batchResults = await AnalyzeService.analyzeSpecificBatch(
      openaiClient,
      transcript,
      conductor,
      client,
      batchIndex
    );

    // Optional: Refinement within the batch
    const refined = await AnalyzeService.refineBatchResults(
      openaiClient,
      transcript,
      conductor,
      client,
      batchResults
    );

    return res.json({ results: refined });
  } catch (err) {
    console.error('[controller] batch error:', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * PHASE 3: Finalize and Save
 */
export async function finalizeOnboardingReport(req, res) {
  try {
    const { taskId, businessName, gmbProfileName, fathomLink, transcript, allResults } = req.body;

    // allResults is a flat array of all 92 items with metadata
    const scoreResult = ScoreCalculator.calculateScoreFromFlatResults(allResults);
    const analysis = buildAnalysisFromFlatResults(allResults);

    const saved = await Repository.saveReport({
      taskId,
      businessName,
      gmbProfileName,
      fathomLink,
      transcriptSource: 'fathom',
      transcript,
      analysis,
      score: scoreResult.score,
      status: scoreResult.status,
      passedItems: scoreResult.passedItems,
      totalItems: scoreResult.totalItems,
      confidenceAvg: scoreResult.confidenceAvg
    });

    return res.json({
      status: 'complete',
      reportId: saved.id,
      taskId
    });
  } catch (err) {
    console.error('[controller] finalize error:', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /onboarding-form-submission
 * Body: { taskId, OnboardingCallLink?, rawTranscript?, gmbProfileName?, businessName? }
 * - If rawTranscript is provided, it will be used directly (skip Fathom fetch)
 * - Otherwise, OnboardingCallLink is required and transcript is fetched from Fathom
 */
export async function handleFormSubmission(req, res) {
  try {
    const { taskId, OnboardingCallLink, rawTranscript, gmbProfileName, businessName } = req.body || {};

    if (!taskId) {
      return res.status(400).json({
        error: 'Missing required field: taskId is required'
      });
    }

    // Either rawTranscript or OnboardingCallLink must be provided
    if (!rawTranscript && !OnboardingCallLink) {
      return res.status(400).json({
        error: 'Either OnboardingCallLink or rawTranscript is required'
      });
    }

    // 1. Check for cached result if OnboardingCallLink provided
    let cachedReport = null;
    if (OnboardingCallLink) {
      cachedReport = Repository.findFirstByFathomLink(OnboardingCallLink);
      if (cachedReport) {
        console.log(`[controller] Found existing analysis for link: ${OnboardingCallLink}. Reusing transcript and score.`);
      }
    }

    // 2. Get transcript - either from raw input, cache, or fetch from Fathom
    let transcript;

    if (cachedReport) {
      transcript = cachedReport.transcript;
    } else if (rawTranscript && typeof rawTranscript === 'string' && rawTranscript.trim().length > 50) {
      // Use the pasted transcript directly
      transcript = rawTranscript.trim();
      console.log(`[controller] Using pasted transcript (${transcript.length} chars)`);
    } else if (OnboardingCallLink) {
      // Fetch transcript from Fathom
      try {
        transcript = await FathomService.fetchTranscript(OnboardingCallLink);
      } catch (err) {
        const status = Number.isInteger(err?.statusCode) ? err.statusCode : 400;
        return res.status(status).json({
          ok: false,
          code: err?.code || 'ONBOARDING_TRANSCRIPT_FETCH_FAILED',
          error: err?.message || 'Failed to fetch transcript',
          hint: err?.hint || null,
          details: err?.details || null
        });
      }
    } else {
      return res.status(400).json({
        error: 'Transcript text is too short (minimum 50 characters required)'
      });
    }

    // 3. Analyze transcript against checklist (or use cache)
    let analysis;
    let scoreResult;

    if (cachedReport) {
      analysis = cachedReport.analysis;
      scoreResult = {
        score: cachedReport.score,
        status: cachedReport.status,
        passedItems: cachedReport.passedItems,
        totalItems: cachedReport.totalItems,
        confidenceAvg: cachedReport.confidenceAvg || 0
      };
    } else {
      try {
        analysis = await AnalyzeService.analyzeTranscript(transcript);
        // Calculate score and status
        scoreResult = ScoreCalculator.calculateScore(analysis);
      } catch (err) {
        console.error('[controller] Analysis failed:', err);
        return res.status(500).json({ error: 'Failed to analyze transcript: ' + err.message });
      }
    }

    // 4. Save report (linking it to current taskId)
    const saved = await Repository.saveReport({
      taskId,
      businessName: businessName || (cachedReport ? cachedReport.businessName : null),
      gmbProfileName: gmbProfileName || (cachedReport ? cachedReport.gmbProfileName : null),
      fathomLink: OnboardingCallLink || null,
      transcriptSource: cachedReport ? 'cached' : (rawTranscript ? 'pasted' : 'fathom'),
      transcript,
      analysis,
      score: scoreResult.score,
      status: scoreResult.status,
      passedItems: scoreResult.passedItems,
      totalItems: scoreResult.totalItems,
      confidenceAvg: scoreResult.confidenceAvg,
    });

    // Respond with success (frontend will redirect to report page)
    return res.json({
      taskId,
      message: saved.updated ? 'Analysis refreshed' : 'Analysis complete',
      reportId: saved.id
    });

  } catch (err) {
    console.error('[controller] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/onboarding-grades?taskId=...
 * Returns array of grade objects for the taskId, newest first.
 * Each grade object shape: { gradedAt, requiredTabs, gmbCheckup, steps, score, status, passedItems, totalItems, confidenceAvg, transcript }
 */
export function getOnboardingGrades(req, res) {
  try {
    const { taskId } = req.query;
    if (!taskId) {
      return res.status(400).json({ error: 'taskId query parameter is required' });
    }

    const reports = Repository.getByTaskId(taskId);
    // Transform to grade objects expected by frontend
    const grades = reports.map(report => ({
      id: report.id,
      taskId: report.taskId,
      gradedAt: report.createdAt,
      requiredTabs: report.analysis?.requiredTabs || [],
      gmbCheckup: report.analysis?.gmbCheckup || [],
      steps: report.analysis?.steps || [],
      score: report.score,
      status: report.status,
      passedItems: report.passedItems,
      totalItems: report.totalItems,
      confidenceAvg: report.confidenceAvg || 0,
      transcript: report.transcript || '',
      businessName: report.businessName,
      gmbProfileName: report.gmbProfileName,
      fathomLink: report.fathomLink
    }));

    return res.json({ grades });
  } catch (err) {
    console.error('[controller] getGrades error:', err);
    return res.status(500).json({ error: 'Failed to fetch grades' });
  }
}

/**
 * GET /api/onboarding/report/:taskId
 * Returns the latest report for the specified taskId.
 */
export function getOnboardingReportByTaskId(req, res) {
  try {
    const { taskId } = req.params;
    if (!taskId) {
      return res.status(400).json({ error: 'taskId parameter is required' });
    }

    const reports = Repository.getByTaskId(taskId);
    if (!reports || reports.length === 0) {
      return res.status(404).json({ error: 'Report not found for this taskId' });
    }

    const report = reports[0]; // Latest report (sorted by createdAt descending)
    return res.json({
      id: report.id,
      taskId: report.taskId,
      gradedAt: report.createdAt,
      requiredTabs: report.analysis?.requiredTabs || [],
      gmbCheckup: report.analysis?.gmbCheckup || [],
      steps: report.analysis?.steps || [],
      score: report.score,
      status: report.status,
      passedItems: report.passedItems,
      totalItems: report.totalItems,
      confidenceAvg: report.confidenceAvg || 0,
      transcript: report.transcript || '',
      businessName: report.businessName,
      gmbProfileName: report.gmbProfileName,
      fathomLink: report.fathomLink
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch report' });
  }
}

/**
 * GET /api/onboarding/report-by-id/:reportId
 * Returns the report with the specified ID.
 */
export function getOnboardingReportById(req, res) {
  try {
    const { reportId } = req.params;
    if (!reportId) {
      return res.status(400).json({ error: 'reportId parameter is required' });
    }

    const report = Repository.getById(reportId);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    return res.json({
      id: report.id,
      taskId: report.taskId,
      gradedAt: report.createdAt || report.gradedAt,
      requiredTabs: report.analysis?.requiredTabs || [],
      gmbCheckup: report.analysis?.gmbCheckup || [],
      steps: report.analysis?.steps || [],
      score: report.score,
      status: report.status,
      passedItems: report.passedItems,
      totalItems: report.totalItems,
      confidenceAvg: report.confidenceAvg || 0,
      transcript: report.transcript || '',
      businessName: report.businessName,
      gmbProfileName: report.gmbProfileName,
      fathomLink: report.fathomLink
    });
  } catch (err) {
    console.error('[controller] getReportById error:', err);
    return res.status(500).json({ error: 'Failed to fetch report by ID' });
  }
}

/**
 * POST /api/onboarding/fathom-api-key
 * Validates Fathom API key, validates call link, fetches transcript, and initializes analysis.
 * Body: { apiKey, callLink }
 */
export async function initWithFathomApiKey(req, res) {
  try {
    const { callLink, taskId, businessName, gmbProfileName } = req.body;

    // STEP 1: Validate Call Link FORMAT
    if (!callLink || typeof callLink !== 'string' || !callLink.includes('fathom.video')) {
      return res.status(400).json({
        error: 'Invalid Call Link. Please enter a valid Fathom call link.'
      });
    }

    const trimmedLink = callLink.trim();

    // Extract call ID from the link (e.g., https://fathom.video/calls/617986707 -> 617986707)
    const callIdMatch = trimmedLink.match(/\/calls\/(\d+)/);
    const requestedCallId = callIdMatch ? callIdMatch[1] : null;

    if (!requestedCallId) {
      return res.status(400).json({
        error: 'Invalid Call Link format. Please enter a valid Fathom call link (e.g., https://fathom.video/calls/123456789).'
      });
    }

    console.log(`[Fathom] Requested call ID from link: ${requestedCallId}`);

    // STEP 2: CHECK CACHE - Skip AI analysis if same Fathom link was analyzed before
    const cachedReport = Repository.findFirstByFathomLink(trimmedLink);
    if (cachedReport && cachedReport.analysis) {
      console.log(`[Fathom] CACHE HIT! Linking cached report to task: ${taskId}`);

      // Save a copy for the current taskId/business so the report page finds it instantly
      const saved = await Repository.saveReport({
        taskId: taskId || 'unknown',
        businessName: businessName || cachedReport.businessName,
        gmbProfileName: gmbProfileName || cachedReport.gmbProfileName,
        fathomLink: trimmedLink,
        transcript: cachedReport.transcript,
        analysis: cachedReport.analysis,
        score: cachedReport.score,
        status: cachedReport.status,
        passedItems: cachedReport.passedItems,
        totalItems: cachedReport.totalItems,
        confidenceAvg: cachedReport.confidenceAvg || 0
      });

      return res.json({
        status: 'cached',
        cached: true,
        reportId: saved.id,
        report: { ...cachedReport, id: saved.id, taskId, businessName, gmbProfileName }
      });
    }
    console.log(`[Fathom] No cache found, proceeding with multi-stage analysis queue...`);

    // STEP 3: Fetch meetings using Rotate fallback
    console.log('[Fathom] Fetching meetings list...');
    let meetingsData;
    try {
      meetingsData = await callFathomApi('/meetings');
    } catch (err) {
      console.error('[Fathom] All API keys failed to fetch meetings:', err.message);
      return res.status(err.response?.status || 400).json({
        error: 'Failed to connect to Fathom with any available API key.'
      });
    }

    // Step 4: Get meetings list
    const meetings = meetingsData?.items || meetingsData?.meetings || meetingsData?.calls || (Array.isArray(meetingsData) ? meetingsData : []);
    console.log(`[Fathom] Found ${meetings.length} total meetings in this account.`);

    if (meetings.length === 0) {
      return res.status(404).json({
        error: 'No meetings found in your Fathom account. Please ensure the recording is available.'
      });
    }

    // Step 5: Find the specific meeting from the call link
    const targetMeeting = meetings.find(m => {
      const meetingUrl = m.url || '';
      const meetingId = m.id || m.meeting_id || '';
      return String(meetingUrl).includes(requestedCallId) || String(meetingId) === requestedCallId;
    });

    if (!targetMeeting) {
      console.log(`[Fathom] Call ID ${requestedCallId} not found in meetings list.`);
      return res.status(400).json({
        error: 'The Onboarding Call Link was not found in your Fathom recordings. Please check the link.'
      });
    }

    console.log('[Fathom] Found matching meeting:', targetMeeting.title);

    const recordingId = targetMeeting.recording_id || targetMeeting.recordingId || targetMeeting.id || targetMeeting.meeting_id;
    if (!recordingId) {
      return res.status(400).json({
        error: 'Could not find a valid recording ID. Please try again.'
      });
    }

    // Step 6: Fetch transcript for the meeting
    console.log(`[Fathom] Fetching transcript for recording: ${recordingId}`);
    let transcriptData;
    try {
      transcriptData = await callFathomApi(`/recordings/${recordingId}/transcript`);
    } catch (err) {
      console.error('[Fathom] All API keys failed to fetch transcript:', err.message);
      if (err.response?.status === 404) {
        return res.status(404).json({
          error: 'Transcript not available yet. Please wait for Fathom to finish processing the call.'
        });
      }
      return res.status(400).json({
        error: 'Failed to fetch transcript from Fathom.'
      });
    }

    // Step 5: Process transcript
    let transcript = '';

    console.log('[Fathom API Key] Transcript data received.');

    if (typeof transcriptData === 'string') {
      transcript = transcriptData;
    } else if (Array.isArray(transcriptData?.transcript)) {
      // Fathom format: { transcript: [{ speaker: { display_name: "..." }, text: "..." }, ...] }
      transcript = transcriptData.transcript.map(seg => {
        const speaker = seg.speaker?.display_name || seg.speaker?.name || seg.speaker || 'Unknown';
        const text = seg.text || seg.content || '';
        return `${speaker}: ${text}`;
      }).join('\n');
    } else if (typeof transcriptData?.transcript === 'string') {
      transcript = transcriptData.transcript;
    } else if (transcriptData?.text) {
      transcript = transcriptData.text;
    } else if (Array.isArray(transcriptData?.segments)) {
      transcript = transcriptData.segments.map(seg => {
        const speaker = seg.speaker?.display_name || seg.speaker?.name || seg.speaker || 'Unknown';
        const text = seg.text || seg.content || '';
        return `${speaker}: ${text}`;
      }).join('\n');
    } else if (Array.isArray(transcriptData?.items)) {
      transcript = transcriptData.items.map(seg => {
        const speaker = seg.speaker?.display_name || seg.speaker?.name || seg.speaker || 'Unknown';
        const text = seg.text || seg.content || '';
        return `${speaker}: ${text}`;
      }).join('\n');
    } else if (Array.isArray(transcriptData)) {
      transcript = transcriptData.map(seg => {
        const speaker = seg.speaker?.display_name || seg.speaker?.name || seg.speaker || 'Unknown';
        const text = seg.text || seg.content || '';
        return `${speaker}: ${text}`;
      }).join('\n');
    }

    // If transcript exists (even if short), proceed
    if (!transcript || (typeof transcript === 'string' && transcript.trim().length === 0)) {
      return res.status(400).json({
        error: 'Transcript not available yet. Please wait for Fathom to finish processing the call.'
      });
    }

    console.log(`[Fathom API Key] Got transcript: ${transcript.length} chars`);
    console.log(`[Fathom API Key] Transcript found successfully!`);

    // Step 6: Initialize analysis (same as regular flow)
    const { conductor, client } = AnalyzeService.identifySpeakers(transcript);
    const chunks = AnalyzeService.getAnalysisChunks();

    return res.json({
      status: 'ready',
      meeting: {
        id: targetMeeting.meeting_id || targetMeeting.id || recordingId,
        recording_id: recordingId,
        title: targetMeeting.title || 'Untitled Meeting',
        created_at: targetMeeting.created_at || targetMeeting.createdAt,
        share_url: targetMeeting.share_url || targetMeeting.shareUrl || null
      },
      transcript,
      conductor,
      client,
      totalBatches: chunks.length,
      batchNames: chunks.map(c => c.name)
    });

  } catch (err) {
    console.error('[Fathom API Key] Unexpected error:', err);
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

/**
 * GET /api/onboarding/fathom-meetings
 * Fetches all meetings for a given Fathom API key.
 * Query: ?apiKey=xxx
 */
export async function getFathomMeetings(req, res) {
  try {
    const { apiKey } = req.query;

    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
      return res.status(400).json({ error: 'API key is required' });
    }

    const trimmedKey = apiKey.trim();

    const meetingsResponse = await axios.get(`${FATHOM_API_BASE}/meetings`, {
      headers: { 'X-Api-Key': trimmedKey },
      timeout: 30000
    });

    const meetings = meetingsResponse.data?.items || meetingsResponse.data?.meetings || meetingsResponse.data?.calls || meetingsResponse.data || [];

    const sortedMeetings = [...meetings].sort((a, b) => {
      const dateA = new Date(a.created_at || a.createdAt || 0);
      const dateB = new Date(b.created_at || b.createdAt || 0);
      return dateB - dateA;
    });

    return res.json({
      meetings: sortedMeetings.map(m => ({
        id: m.id || m.call_id,
        title: m.title || 'Untitled',
        created_at: m.created_at || m.createdAt,
        share_url: m.share_url || m.shareUrl || null
      }))
    });

  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    return res.status(500).json({ error: 'Failed to fetch meetings' });
  }
}
