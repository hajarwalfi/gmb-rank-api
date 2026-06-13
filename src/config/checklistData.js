/**
 * Onboarding checklist data - 92 items total.
 * Synchronized with frontend OLD_UI_STEP_TEMPLATES.
 */
const CHECKLIST_DATA = {
  requiredTabs: [
    "Agency Sub Account tab is open",
    "Client Sub Account tab is open",
    "Client Website (Netlify) tab is open",
    "Client Google My Business profile tab is open",
    "Fathom connected to Google Meet and recording"
  ],
  gmbCheckup: [
    "Verify GMB listing is connected in sub account",
    "Confirm business info is accurate (name, address, phone)",
    "Check GMB reviews are syncing properly",
    "Ensure Google Posts are enabled and scheduled"
  ],
  steps: [
    {
      key: "leadConnectorAccess",
      label: "Step 1 - LeadConnector Access",
      items: [
        "Client logs into LeadConnector",
        "Add client as Staff in Client Sub Account (Settings -> Staff)",
        "Set password for client",
        "Client confirms successful login"
      ]
    },
    {
      key: "websiteWalkthrough",
      label: "Step 2 - Website Walkthrough",
      items: [
        "Walk client through every page",
        "Ask for specific design/content changes",
        "Write ALL changes live in Google Doc",
        "Explain Blog Strategy (SEO & Traffic)",
        "Submit Google Doc to builders"
      ]
    },
    {
      key: "formSmsTest",
      label: "Step 3 - Form & SMS Test",
      items: [
        "Submit website form live",
        "Check conversations in Sub Account",
        "Confirm client received SMS notification",
        "Client saves contact as 'Business Notification'",
        "Client replies from LeadConnector app",
        "Reply appears in CRM Conversations",
        "'System Update' contact saved by client"
      ]
    },
    {
      key: "googleReviewsReferral",
      label: "Step 4 - Google Reviews & Referral",
      items: [
        "Open 1 Year Follow Up Form Builder",
        "Send integration link to client",
        "Submit test form (Own Name/Number)",
        "Show 5-star link vs Private Feedback logic",
        "Review Review/Referral workflow",
        "Explain 8-day wait / 8-week recurring",
        "Request past customer database (CSV)",
        "Explain 4-week SMS cadence logic"
      ]
    },
    {
      key: "gmbOptimization",
      label: "Step 5 - GMB Optimization & Integrity",
      items: [
        "Profile Completion: All fields filled; description keyword-rich",
        "Services: All core services added with clear descriptions",
        "Photos: Logo, cover, team, and work photos (NO STOCK)",
        "Business Info: Correct hours, phone, and website link",
        "Profile Health: Green check status; no errors/suspensions",
        "Service Areas: Specific geographic areas added correctly",
        "Auto Review Replies: Mention we auto-reply to reviews",
        "Weekly Google Posts: Mention daily posts created weekly"
      ]
    },
    {
      key: "cardVerification",
      label: "Step 6 - Card Verification",
      items: [
        "Manually rebill client $1 activation fee for subscription",
        "If $1 charge succeeds — card is verified",
        "If $1 charge fails — switch to another subscription/card",
        "Confirm a valid, working card is on file",
        "Inform client A2P registration fee is $20 (we cover it)",
        "If client declines A2P: Stop sharing, buy toll-free number",
        "Have client save toll-free number as contact",
        "Have client save TextGrid number as contact",
        "Total contacts saved: 2 numbers (Toll-free and TextGrid)",
        "Confirm both numbers are saved as contacts"
      ]
    },
    {
      key: "a2pMessaging",
      label: "Step 7 - A2P Client Briefing",
      items: [
        "Tell client we will eventually switch to A2P",
        "Explain A2P benefits: reply stops reduced, deliverability",
        "Explain A2P registration for automated messages",
        "Show client what A2P registration is (Google live)",
        "Mention we fill out A2P Registration form on their behalf",
        "Tell client form costs $20 but we cover it",
        "Explain the only con: ~$10–15/month extra cost",
        "Tell client: will provide stronger number once complete"
      ]
    },
    {
      key: "socialProofResults",
      label: "Step 8 - Social Proof / Results",
      items: [
        "Google a relevant keyword live (e.g. 'plumber city state')",
        "Show client a top-ranked example business",
        "Explain reviews are the reason for high leads",
        "Point out Google review count and rating",
        "Google another relevant keyword live",
        "Show client another top-ranked example",
        "Explain reviews drove them to the top",
        "Point out Google review count and rating",
        "Key message: leads come from reviews",
        "Explain: more reviews = higher ranking = more leads",
        "Tell client: this is exactly what we are building for them",
        "Emphasize: getting reviews is most important growth factor"
      ]
    },
    {
      key: "updateForm",
      label: "Step 9 - Update Form",
      items: [
        "Open the Onboarding Form",
        "Choose between English or Spanish before filling",
        "Fill in all required fields and submit form",
        "Confirm form submission was successful",
        "Open Client Tracking Editor after submitting form",
        "Verify client business name is correct",
        "Verify client phone number is correct",
        "Verify client email address is correct",
        "Verify website URL is correct",
        "Update any website change notes for builders",
        "Confirm all tracking details are accurate and saved",
        "Create call recording ticket with Fathom"
      ]
    },
    {
      key: "pipelineSetup",
      label: "Step 10 - Update GoHighLevel Pipeline",
      items: [
        "Open client card in GoHighLevel",
        "Move card to correct pipeline stage",
        "Verify all contact details are up to date",
        "Confirm pipeline stage reflects completion"
      ]
    },
    {
      key: "regularUpdates",
      label: "Step 11 - Regular Updates",
      items: [
        "Watch the Regular Updates walkthrough video",
        "Understand update workflow and frequency",
        "Confirm how to submit regular updates going forward"
      ]
    }
  ],
  closeCall: [
    "Questions Answered",
    "Texted Kurtis with client name"
  ]
};

// Count verification: requiredTabs(5) + gmbCheckup(4) + steps(81) + closeCall(2) = 92 total.

/**
 * Flatten the checklist into a single array for AI processing.
 * Returns array of { category, index, itemText }
 */
function flattenChecklist() {
  const items = [];
  for (let i = 0; i < CHECKLIST_DATA.requiredTabs.length; i++) {
    items.push({ category: 'requiredTabs', index: i, itemText: CHECKLIST_DATA.requiredTabs[i] });
  }
  for (let i = 0; i < CHECKLIST_DATA.gmbCheckup.length; i++) {
    items.push({ category: 'gmbCheckup', index: i, itemText: CHECKLIST_DATA.gmbCheckup[i] });
  }
  for (const step of CHECKLIST_DATA.steps) {
    for (let i = 0; i < step.items.length; i++) {
      items.push({ category: 'steps', stepKey: step.key, index: i, itemText: step.items[i] });
    }
  }
  for (let i = 0; i < CHECKLIST_DATA.closeCall.length; i++) {
    items.push({ category: 'closeCall', index: i, itemText: CHECKLIST_DATA.closeCall[i] });
  }
  return items;
}

/**
 * Reconstruct nested analysis result from flat AI decisions.
 */
function buildAnalysisFromFlatResults(flatResults) {
  const analysis = {
    requiredTabs: [],
    gmbCheckup: [],
    steps: [],
    closeCall: []
  };
  const flatten = flattenChecklist();
  
  if (flatResults.length !== flatten.length) {
    console.warn(`[checklistData] AI returned ${flatResults.length} results, expected ${flatten.length}.`);
  }
  
  const stepMap = new Map();

  for (const stepDef of CHECKLIST_DATA.steps) {
    const stepObj = {
      stepKey: stepDef.key,
      stepName: stepDef.label,
      items: new Array(stepDef.items.length).fill(null)
    };
    stepMap.set(stepDef.key, stepObj);
    analysis.steps.push(stepObj);
  }

  const processCount = Math.min(flatten.length, flatResults.length);
  for (let i = 0; i < processCount; i++) {
    const { category, stepKey, index } = flatten[i];
    const result = flatResults[i];
    const itemText = flatten[i].itemText;
    const item = {
      itemText,
      covered: result?.covered === true,
      confidence: typeof result?.confidence === 'number' ? Math.min(1, Math.max(0, result.confidence)) : 0,
      timestamp: typeof result?.timestamp === 'string' ? result.timestamp : null,
      reason: typeof result?.reason === 'string' ? result.reason : ''
    };

    if (category === 'requiredTabs') {
      analysis.requiredTabs[index] = item;
    } else if (category === 'gmbCheckup') {
      analysis.gmbCheckup[index] = item;
    } else if (category === 'steps') {
      const step = stepMap.get(stepKey);
      if (step) step.items[index] = item;
    } else if (category === 'closeCall') {
      analysis.closeCall[index] = item;
    }
  }

  const defaultItem = (itemText) => ({
    itemText, covered: false, confidence: 0, timestamp: null, reason: ''
  });

  analysis.requiredTabs = analysis.requiredTabs.map((item, idx) => item || defaultItem(CHECKLIST_DATA.requiredTabs[idx]));
  analysis.gmbCheckup = analysis.gmbCheckup.map((item, idx) => item || defaultItem(CHECKLIST_DATA.gmbCheckup[idx]));
  analysis.closeCall = analysis.closeCall.map((item, idx) => item || defaultItem(CHECKLIST_DATA.closeCall[idx]));
  
  analysis.steps = analysis.steps.map((step) => {
    const stepDef = CHECKLIST_DATA.steps.find((s) => s.key === step.stepKey);
    return {
      ...step,
      items: step.items.map((item, idx) => item || defaultItem(stepDef?.items?.[idx] || `Item ${idx + 1}`))
    };
  });
  
  return analysis;
}

function getTotalItemCount() {
  return 92;
}

export { CHECKLIST_DATA, flattenChecklist, buildAnalysisFromFlatResults, getTotalItemCount };
