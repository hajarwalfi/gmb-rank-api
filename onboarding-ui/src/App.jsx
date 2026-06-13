import { useEffect, useMemo, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE || 'https://click.acquisition-central.com';

const CHECKLIST_LABELS = {
  websiteWalkthrough: 'Step 1 - Website Walkthrough',
  leadConnectorAccess: 'Step 2 - LeadConnector Access',
  smsTest: 'Step 3 - SMS Test',
  googleReviewsReferral: 'Step 4 - Google Reviews & Referral',
  gmbOptimization: 'Step 5 - GMB Optimization',
  a2pMessaging: 'Step 6 - A2P / Messaging System',
  socialProofResults: 'Step 7 - Social Proof / Results',
  formSubmission: 'Step 8 - Form Submission',
  pipelineSetup: 'Step 9 - Pipeline Setup',
};

const TEXT = {
  usa: {
    title: 'Onboarding Auto Scoring',
    subtitle: 'Submit call link, auto-transcript, checklist scoring, and real score out of 10.',
    business: 'Business Name',
    gmb: 'GMB Profile',
    call: 'Onboarding Call Link',
    submit: 'Submit',
    statusLoadingBusinesses: 'Loading businesses...',
    statusLoadingGmb: 'Loading GMB profiles...',
    statusSubmitting: 'Submitting onboarding call...',
    statusPolling: 'Transcript processing, fetching report...',
    statusDone: 'Report ready.',
    statusBoundTask: 'Bound Task ID',
    errorRouteMissing: 'Report route is not available on this deployment yet. Backend deploy required.',
  },
  spanish: {
    title: 'Puntuacion Automatica de Onboarding',
    subtitle: 'Envia el link de llamada para transcripcion, checklist y puntuacion real de 10.',
    business: 'Nombre del Negocio',
    gmb: 'Perfil de GMB',
    call: 'Link de Llamada de Onboarding',
    submit: 'Enviar',
    statusLoadingBusinesses: 'Cargando negocios...',
    statusLoadingGmb: 'Cargando perfiles GMB...',
    statusSubmitting: 'Enviando llamada de onboarding...',
    statusPolling: 'Procesando transcripcion, obteniendo reporte...',
    statusDone: 'Reporte listo.',
    statusBoundTask: 'Task ID vinculado',
    errorRouteMissing: 'La ruta de reporte no esta desplegada todavia. Se requiere deploy de backend.',
  },
};

function normalizeBusinessTasks(payload) {
  const list = Array.isArray(payload?.tasks) ? payload.tasks : Array.isArray(payload) ? payload : [];
  return list
    .map((item) => ({
      taskId: String(item?.taskId || item?.task_id || item?.id || '').trim(),
      name: String(item?.name || item?.taskName || '').trim(),
      bizOwnerName: String(item?.bizOwnerName || item?.biz_owner_name || '').trim(),
    }))
    .filter((item) => item.taskId && item.name)
    .map((item) => ({
      ...item,
      label: item.bizOwnerName ? `${item.name} (${item.bizOwnerName})` : item.name,
    }));
}

function normalizeGmbNames(payload) {
  const list = Array.isArray(payload?.names) ? payload.names : Array.isArray(payload) ? payload : [];
  return list.map((name) => String(name || '').trim()).filter(Boolean);
}

function scoreStatus(score) {
  if (score >= 8) return 'Good';
  if (score >= 5) return 'Average';
  return 'Poor';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function App() {
  const [lang, setLang] = useState('usa');
  const [businessTasks, setBusinessTasks] = useState([]);
  const [gmbNames, setGmbNames] = useState([]);
  const [businessInput, setBusinessInput] = useState('');
  const [gmbInput, setGmbInput] = useState('');
  const [callLink, setCallLink] = useState('');
  const [selectedTask, setSelectedTask] = useState(null);
  const [selectedGmb, setSelectedGmb] = useState('');
  const [showBizMenu, setShowBizMenu] = useState(false);
  const [showGmbMenu, setShowGmbMenu] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [report, setReport] = useState(null);

  const t = TEXT[lang];

  const businessEndpoint =
    lang === 'spanish'
      ? '/api/clickup-client-tracking-names-spanish'
      : '/api/clickup-client-tracking-names';

  useEffect(() => {
    let active = true;
    async function loadBusinesses() {
      setIsError(false);
      setMessage(t.statusLoadingBusinesses);
      try {
        const res = await fetch(`${API_BASE}${businessEndpoint}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Failed loading business names');
        if (!active) return;
        setBusinessTasks(normalizeBusinessTasks(data));
        setMessage('');
      } catch (error) {
        if (!active) return;
        setIsError(true);
        setMessage(error.message || 'Failed loading business names');
      }
    }
    loadBusinesses();
    return () => {
      active = false;
    };
  }, [businessEndpoint, t.statusLoadingBusinesses]);

  useEffect(() => {
    let active = true;
    async function loadGmbNames() {
      setIsError(false);
      setMessage(t.statusLoadingGmb);
      try {
        const res = await fetch(`${API_BASE}/api/gmb-profile-names`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Failed loading GMB profile names');
        if (!active) return;
        setGmbNames(normalizeGmbNames(data));
        setMessage('');
      } catch (error) {
        if (!active) return;
        setIsError(true);
        setMessage(error.message || 'Failed loading GMB profile names');
      }
    }
    loadGmbNames();
    return () => {
      active = false;
    };
  }, [t.statusLoadingGmb]);

  const filteredBusinesses = useMemo(() => {
    const q = businessInput.toLowerCase().trim();
    if (!q) return businessTasks.slice(0, 80);
    return businessTasks
      .filter((item) => item.label.toLowerCase().includes(q) || item.name.toLowerCase().includes(q))
      .slice(0, 80);
  }, [businessInput, businessTasks]);

  const filteredGmb = useMemo(() => {
    const q = gmbInput.toLowerCase().trim();
    if (!q) return gmbNames.slice(0, 80);
    return gmbNames.filter((name) => name.toLowerCase().includes(q)).slice(0, 80);
  }, [gmbInput, gmbNames]);

  async function fetchReport(taskId) {
    const res = await fetch(`${API_BASE}/onboarding-report/${encodeURIComponent(taskId)}`);
    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }

    if (res.status === 202 || data?.pending === true) {
      return { pending: true, data };
    }

    if (res.status === 404 && data?.error === 'Route not found') {
      const err = new Error(t.errorRouteMissing);
      err.code = 'ROUTE_MISSING';
      throw err;
    }

    if (!res.ok) {
      throw new Error(data?.error || 'Failed fetching onboarding report');
    }

    return { pending: false, data };
  }

  async function pollForReport(taskId) {
    for (let i = 0; i < 18; i += 1) {
      const result = await fetchReport(taskId);
      if (!result.pending) return result.data;
      await delay(7000);
    }
    throw new Error('Report not ready yet. Please try again shortly.');
  }

  function onBusinessPick(item) {
    setBusinessInput(item.label);
    setSelectedTask(item);
    setShowBizMenu(false);
  }

  function onGmbPick(name) {
    setGmbInput(name);
    setSelectedGmb(name);
    setShowGmbMenu(false);
  }

  async function onSubmit(event) {
    event.preventDefault();
    setIsError(false);
    setReport(null);

    const taskId = selectedTask?.taskId;
    if (!taskId) {
      setIsError(true);
      setMessage('Please select Business Name from dropdown.');
      return;
    }
    if (!callLink.trim()) {
      setIsError(true);
      setMessage('Onboarding Call Link is required.');
      return;
    }

    setSubmitting(true);
    try {
      setMessage(t.statusSubmitting);
      const submitRes = await fetch(`${API_BASE}/onboarding-form-submission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId,
          OnboardingCallLink: callLink.trim(),
          gmbProfileName: selectedGmb || gmbInput.trim() || undefined,
        }),
      });

      const submitData = await submitRes.json();
      if (!submitRes.ok) {
        throw new Error(submitData?.error || 'Onboarding submission failed');
      }

      setMessage(t.statusPolling);
      const reportData = await pollForReport(taskId);
      setReport(reportData);
      setMessage(t.statusDone);
    } catch (error) {
      setIsError(true);
      setMessage(error.message || 'Unexpected error');
    } finally {
      setSubmitting(false);
    }
  }

  const checklist = report?.checklist || report?.checklist_results || {};
  const score = typeof report?.score === 'number' ? report.score : null;
  const avgRank = report?.average_rank || (report?.average_rank === 0 ? 0 : null);
  const status = report?.status || (score != null ? scoreStatus(score) : null);
  const completed = report?.completed ?? 0;
  const total = report?.total ?? Object.keys(CHECKLIST_LABELS).length;

  return (
    <div className="page">
      <div className="card">
        <h1>{t.title}</h1>
        <p className="subtitle">{t.subtitle}</p>

        <div className="tabs">
          <button
            type="button"
            className={`tab ${lang === 'usa' ? 'active' : ''}`}
            onClick={() => {
              setLang('usa');
              setSelectedTask(null);
              setBusinessInput('');
            }}
          >
            USA
          </button>
          <button
            type="button"
            className={`tab ${lang === 'spanish' ? 'active' : ''}`}
            onClick={() => {
              setLang('spanish');
              setSelectedTask(null);
              setBusinessInput('');
            }}
          >
            Espanol
          </button>
        </div>

        <form onSubmit={onSubmit} autoComplete="off">
          <div className="formGrid">
            <label>{t.business} *</label>
            <div className="autocomplete">
              <input
                value={businessInput}
                onChange={(e) => {
                  setBusinessInput(e.target.value);
                  setSelectedTask(null);
                }}
                onFocus={() => setShowBizMenu(true)}
                placeholder="Search and select..."
                required
              />
              {showBizMenu && (
                <div className="menu" onMouseLeave={() => setShowBizMenu(false)}>
                  {filteredBusinesses.length === 0 ? (
                    <div className="menuItem">No results</div>
                  ) : (
                    filteredBusinesses.map((item) => (
                      <button key={item.taskId} type="button" className="menuItem menuButton" onMouseDown={() => onBusinessPick(item)}>
                        {item.label}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            <label>{t.gmb}</label>
            <div className="autocomplete">
              <input
                value={gmbInput}
                onChange={(e) => {
                  setGmbInput(e.target.value);
                  setSelectedGmb('');
                }}
                onFocus={() => setShowGmbMenu(true)}
                placeholder="Search and select..."
              />
              {showGmbMenu && (
                <div className="menu" onMouseLeave={() => setShowGmbMenu(false)}>
                  {filteredGmb.length === 0 ? (
                    <div className="menuItem">No results</div>
                  ) : (
                    filteredGmb.map((name) => (
                      <button key={name} type="button" className="menuItem menuButton" onMouseDown={() => onGmbPick(name)}>
                        {name}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            <label>{t.call} *</label>
            <input value={callLink} onChange={(e) => setCallLink(e.target.value)} placeholder="https://..." required />
          </div>

          <p className="hint">
            {selectedTask ? `${t.statusBoundTask}: ${selectedTask.taskId}` : 'Select Business Name to bind task.'}
          </p>

          <div className="actions">
            <button className="submitBtn" type="submit" disabled={submitting}>
              {submitting ? 'Processing...' : t.submit}
            </button>
          </div>
        </form>

        {message && <p className={`message ${isError ? 'error' : 'ok'}`}>{message}</p>}
      </div>

      {report && (
        <div className="card">
          <div className="scoreHeader">
            <div>
              <h2>Onboarding Score</h2>
              <p className="muted">
                {report?.business_name || selectedTask?.name || 'Business'} | Task ID: {report?.taskId || selectedTask?.taskId}
              </p>
            </div>
            <div className="scorePanel">
              <div className="scoreItem">
                <div className="scoreLabel">FINAL SCORE</div>
                <div className="scoreValue">{score != null ? `${score}/10` : '-'}</div>
              </div>
              <div className="scoreItem">
                <div className="scoreLabel">AVG RANK</div>
                <div className="scoreValue small">{avgRank != null ? `${avgRank}/5` : '-'}</div>
              </div>
              <div className={`status ${String(status || '').toLowerCase()}`}>{status || '-'}</div>
            </div>
          </div>

          <div className="metaRow">
            Completed: {completed} / {total}
          </div>

          <div className="checklist">
            {Object.entries(CHECKLIST_LABELS).map(([key, label]) => {
              const item = checklist?.[key] || {};
              const rank = item.rank || 0;
              const reason = item.reason || 'Not analyzed';
              const rankClass = rank >= 4 ? 'yes' : rank >= 2 ? 'neutral' : 'no';
              
              return (
                <div key={key} className="checkItem ranked">
                  <div className="checkHeader">
                    <div className="left">
                      <span className="stepLabel">{label}</span>
                    </div>
                    <div className="right">
                      <span className={`badge rank-badge ${rankClass}`}>RANK: {rank}/5</span>
                    </div>
                  </div>
                  <div className="reasonText">
                    <strong>Evidence:</strong> {reason}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
