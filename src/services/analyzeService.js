/**
 * AI Checklist Analyzer using OpenAI GPT-4o.
 * Analyzes a transcript against the 92 checklist items.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const openai = require('../../config/openai.js'); // Root config CommonJS

import { CHECKLIST_DATA, flattenChecklist, buildAnalysisFromFlatResults } from '../config/checklistData.js';

/**
 * Extract speaker roles from transcript.
 * Speaker 1 = Meeting Conductor (Agent)
 * Speaker 2 = Business Man (Client)
 */
export function identifySpeakers(transcript) {
  const lines = transcript.split('\n').filter(l => l.trim().length > 0);
  const speakers = [];

  // Matches Fathom styles: "0:00 - Name" or "[00:00:00] Name"
  const nameRegex = /^(?:\d+:\d+(?::\d+)?\s*-\s*|\[\d+:\d+(?::\d+)?\]\s*)([^(:\n]+)(?:\s*\([^)]*\))?/;

  for (const line of lines) {
    const match = line.match(nameRegex);
    if (match) {
      const name = match[1].trim();
      if (!speakers.includes(name)) {
        speakers.push(name);
      }
      if (speakers.length >= 2) break;
    }
  }

  return {
    conductor: speakers[0] || 'Meeting Conductor (Agent)',
    client: speakers[1] || 'Business Man (Client)'
  };
}

/**
 * Helper to analyze a specific chunk of checklist items.
 */
async function analyzeChunk(client, transcript, conductor, clientName, chunkName, items, isRefinement = false) {
  const itemsList = items.map((item, idx) => `${idx + 1}. ${item.itemText}`).join('\n');

  const prompt = `You are a Senior Quality Auditor. YOUR GOAL IS 100% ACCURACY for the section: "${chunkName}".
${isRefinement ? 'REFINEMENT PASS: These were items where the first pass was unsure. Scan the transcript with EXTREME focus.' : ''}

Roles:
- AGENT: ${conductor}
- CLIENT: ${clientName}

STRICT AUDIT PROTOCOL:
1. "covered: true" ONLY if the AGENT (${conductor}) clearly took the action.
2. DECISIVE CONFIDENCE: Use 1.0 if evidence is found or certain it's missing.
3. CHAIN OF THOUGHT: In your 'reason', briefly explain your logic step-by-step before citing the quote.
4. SYNONYMS: Be smart—if they say "it's set up" instead of "verified," it counts.

Transcript:
${transcript}

Items to Audit (YOU MUST RETURN EXACTLY ${items.length} RESULTS):
${itemsList}

Return exactly ${items.length} results as JSON:
{
  "results": [
    {
      "covered": boolean,
      "confidence": 1.0 or 0.0,
      "timestamp": "MM:SS",
      "reason": "Explain your logic, then cite specific transcript proof."
    }
  ]
}`;

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: `You are an expert auditor. You MUST return exactly ${items.length} results. Respond only with JSON.` },
        { role: 'user', content: prompt }
      ],
      temperature: 0,
      response_format: { type: 'json_object' }
    });

    const content = completion.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    let results = parsed.results || parsed.items || [];

    // Ensure exact length
    if (results.length !== items.length) {
      console.warn(`[analyzeService] Chunk "${chunkName}" returned ${results.length} results, expected ${items.length}. Fixing...`);
      if (results.length > items.length) {
        results = results.slice(0, items.length);
      } else {
        while (results.length < items.length) {
          results.push({ covered: false, confidence: 0, timestamp: null, reason: 'AI failed to analyze this item in this pass' });
        }
      }
    }

    return results;
  } catch (err) {
    console.error(`[analyzeService] Error in chunk "${chunkName}":`, err.message);
    return items.map(() => ({ covered: false, confidence: 0, timestamp: null, reason: 'Analysis failed' }));
  }
}

/**
 * Returns the list of logical chunks (Required Tabs, GMB, Steps, etc.) to the caller.
 * Used for multi-stage frontend progress tracking.
 */
export function getAnalysisChunks() {
  const allItems = flattenChecklist();
  const chunks = [];
  chunks.push({ name: 'Required Tabs', items: allItems.filter(i => i.category === 'requiredTabs') });
  chunks.push({ name: 'GMB Checkup', items: allItems.filter(i => i.category === 'gmbCheckup') });
  for (const step of CHECKLIST_DATA.steps) {
    chunks.push({ name: step.label, items: allItems.filter(i => i.category === 'steps' && i.stepKey === step.key) });
  }
  chunks.push({ name: 'Close the Call', items: allItems.filter(i => i.category === 'closeCall') });
  return chunks;
}

/**
 * Analyzes a specific chunk (0-13) based on its index.
 */
export async function analyzeSpecificBatch(openaiClient, transcript, conductor, clientName, chunkIndex) {
  const chunks = getAnalysisChunks();
  if (chunkIndex < 0 || chunkIndex >= chunks.length) {
    throw new Error(`Invalid chunk index: ${chunkIndex}`);
  }

  const chunk = chunks[chunkIndex];
  console.log(`[analyzeService] Step-by-Step: Analyzing ${chunk.name} (${chunk.items.length} items)...`);

  const results = await analyzeChunk(openaiClient, transcript, conductor, clientName, chunk.name, chunk.items, true);
  
  // Return with metadata for later reconstruction
  return results.map((r, idx) => ({
    ...r,
    _originalItem: chunk.items[idx]
  }));
}

/**
 * Performs refinement on low-confidence results for a batch.
 */
export async function refineBatchResults(openaiClient, transcript, conductor, clientName, batchResults) {
  const lowConfidence = batchResults.filter(r => r.confidence < 0.9);
  if (lowConfidence.length === 0) return batchResults;

  console.log(`[analyzeService] Refinement: Processing ${lowConfidence.length} low-confidence items...`);
  const itemsToRefine = lowConfidence.map(r => r._originalItem);
  const refined = await analyzeChunk(openaiClient, transcript, conductor, clientName, 'Refinement Pass', itemsToRefine, true);
  
  const finalResults = [...batchResults];
  refined.forEach((ref, idx) => {
    const originalIdx = finalResults.findIndex(r => r._originalItem.itemText === itemsToRefine[idx].itemText);
    if (originalIdx !== -1) {
      finalResults[originalIdx] = { ...ref, _originalItem: itemsToRefine[idx] };
    }
  });
  return finalResults;
}

/**
 * Analyze a transcript using a Two-Stage High-Precision Audit.
 */
export async function analyzeTranscript(transcript) {
  if (!transcript || typeof transcript !== 'string') {
    throw new Error('Transcript is required for analysis');
  }

  const { conductor, client: clientName } = identifySpeakers(transcript);
  const openaiClient = typeof openai.getClient === 'function' ? openai.getClient() : openai;
  const chunks = getAnalysisChunks();

  console.log(`[analyzeService] Stage 1: Initial Multi-Pass Audit (14 passes)...`);
  let results = [];

  for (const chunk of chunks) {
    console.log(`[analyzeService] Auditing chunk: ${chunk.name} (${chunk.items.length} items)...`);
    const chunkResults = await analyzeChunk(openaiClient, transcript, conductor, clientName, chunk.name, chunk.items);
    // Guarantee mapping to original items
    results.push(...chunkResults.map((r, idx) => ({ ...r, _originalItem: chunk.items[idx] })));
  }

  // --- STAGE 2: Refinement Pass for Low-Confidence Items ---
  const lowConfidenceIndices = results
    .map((r, i) => (r.confidence < 0.9 ? i : -1))
    .filter(i => i !== -1);

  if (lowConfidenceIndices.length > 0) {
    console.log(`[analyzeService] Stage 2: Refining ${lowConfidenceIndices.length} low-confidence items...`);
    const itemsToRefine = lowConfidenceIndices.map(i => results[i]._originalItem);

    // Process refinement in controlled batches of 10
    for (let i = 0; i < itemsToRefine.length; i += 10) {
      const batch = itemsToRefine.slice(i, i + 10);
      try {
        const refinedBatch = await analyzeChunk(openaiClient, transcript, conductor, clientName, 'Refinement Pass', batch, true);

        refinedBatch.forEach((refinedItem, batchIdx) => {
          const originalIdx = lowConfidenceIndices[i + batchIdx];
          if (originalIdx !== undefined && refinedItem) {
            results[originalIdx] = { ...refinedItem, _originalItem: batch[batchIdx] };
          }
        });
      } catch (err) {
        console.error('[analyzeService] Refinement batch failed:', err.message);
      }
    }
  }



  // Final length safety check
  if (results.length !== 92) {
    console.error(`[analyzeService] FATAL: Final results length is ${results.length}, expected 92.`);
    // Emergency trim or pad to avoid crash
    if (results.length > 92) results = results.slice(0, 92);
    else while (results.length < 92) results.push({ covered: false, confidence: 0, timestamp: null, reason: 'Critical mismatch' });
  }

  const analysis = buildAnalysisFromFlatResults(results);
  analysis.conductor = conductor;
  analysis.client = clientName;
  analysis.transcript = transcript;

  return analysis;
}
