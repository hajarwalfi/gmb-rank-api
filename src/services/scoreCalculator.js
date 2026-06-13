/**
 * Calculates the onboarding performance score from analysis results.
 * Expects analysis object with requiredTabs, gmbCheckup, steps arrays.
 * Each item has: covered (boolean), confidence (0-1).
 * Returns score, status, passedItems, totalItems, confidenceAvg.
 */

export function calculateScore(analysis) {
  let passed = 0;
  let totalConfidence = 0;
  let itemCount = 0;
  const TOTAL_CHECKLIST_ITEMS = 92;

  function processItems(arr) {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (!item) continue;
      itemCount += 1;
      if (item.covered === true) passed += 1;
      if (typeof item.confidence === 'number') {
        totalConfidence += item.confidence;
      }
    }
  }

  processItems(analysis.requiredTabs);
  processItems(analysis.gmbCheckup);
  if (Array.isArray(analysis.steps)) {
    for (const step of analysis.steps) {
      processItems(step.items);
    }
  }
  processItems(analysis.closeCall);

  // Safeguard against accidental over-counting.
  if (passed > TOTAL_CHECKLIST_ITEMS) passed = TOTAL_CHECKLIST_ITEMS;

  const rawScore = (passed / TOTAL_CHECKLIST_ITEMS) * 10;
  const score = Number(Math.min(10, rawScore).toFixed(1));

  const confidenceAvg = itemCount > 0 
    ? Number((totalConfidence / itemCount).toFixed(2)) 
    : 0;

  let status;
  if (score >= 8.5) status = 'EXCELLENT';
  else if (score >= 7) status = 'GOOD';
  else if (score >= 5) status = 'AVERAGE';
  else if (score >= 3) status = 'POOR';
  else status = 'VERY POOR';

  return { 
    score, 
    status, 
    passedItems: passed, 
    totalItems: TOTAL_CHECKLIST_ITEMS,
    confidenceAvg
  };
}

/**
 * Calculates score directly from the flat array of 92 items.
 */
export function calculateScoreFromFlatResults(flatResults) {
  let passed = 0;
  let totalConfidence = 0;
  const TOTAL = 92;

  for (const item of flatResults) {
    if (item.covered === true) passed += 1;
    if (typeof item.confidence === 'number') {
      totalConfidence += item.confidence;
    }
  }

  const rawScore = (passed / TOTAL) * 10;
  const score = Number(Math.min(10, rawScore).toFixed(1));
  const confidenceAvg = flatResults.length > 0 
    ? Number((totalConfidence / flatResults.length).toFixed(2)) 
    : 0;

  let status;
  if (score >= 8.5) status = 'EXCELLENT';
  else if (score >= 7) status = 'GOOD';
  else if (score >= 5) status = 'AVERAGE';
  else if (score >= 3) status = 'POOR';
  else status = 'VERY POOR';

  return { score, status, passedItems: passed, totalItems: TOTAL, confidenceAvg };
}
