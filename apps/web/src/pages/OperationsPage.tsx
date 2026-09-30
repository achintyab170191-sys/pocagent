import { useEffect, useState } from 'react';
import { api, describeError } from '../api';
import { Badge, Notice } from '../components';
import { Icon } from '../icons';

interface StageOverview { id: string; name: string; order: number; summary: string; covers: string[]; build: 'LIVE' | 'ROUTED' | 'NOT_BUILT'; queue: string; requestTypes: Array<{ id: string; label: string; automated: boolean }>; captured: number; assessed: number; }
interface Captured { caseRunId: string; requestTypeId: string; requestLabel: string; stage: string; stageName: string; queue: string; businessName: string; representativeName: string; capturedAt: string; }
interface Lead { caseRunId: string; businessName: string; representativeName: string; onboardingStatus: string; queue: string; createdAt: string; }
interface PipelineStep { key: string; label: string; count: number; }
interface Activity { timestamp: string; caseRunId: string; actor: string; eventType: string; newState: string; reasonCode: string; }
interface Overview { stages: StageOverview[]; captured: Captured[]; leads: Lead[]; pipeline: PipelineStep[]; activity: Activity[]; newLeads: number; loaCases: number; openReviews: number; syntheticDataDisclaimer: true; }

const buildText: Record<StageOverview['build'], string> = { LIVE: 'Live', ROUTED: 'Routed', NOT_BUILT: 'Not built' };
const pipelineTone: Record<string, string> = { DOCUMENTS: 'info', SPECIALIST: 'warn', PENDING_REJECTION: 'warn', APPROVED: 'good', REJECTED: 'bad', REOPENED: 'muted' };
const when = (value: string): string => (value ? new Date(value).toLocaleString() : '—');
const stageCount = (stage: StageOverview): number => (stage.id === 'PROFILING' ? stage.assessed + stage.captured : stage.captured);

export function OperationsPage() {
  const [overview, setOverview] = useState<Overview>();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('PROFILING');
  const load = () => api<Overview>('/api/operations').then((body) => { setOverview(body); setError(''); }).catch((caught) => setError(describeError(caught)));
  useEffect(() => { void load(); }, []);
  const stage = overview?.stages.find((entry) => entry.id === selected);
  const pipelineTotal = overview ? Math.max(1, overview.pipeline.reduce((sum, step) => sum + step.count, 0)) : 1;

  return (
    <section aria-labelledby="ops-title" className="page">
      <div className="page-head" id="ops-title-wrap">
        <h2 id="ops-title">Operations overview</h2>
        <p className="lead">The B2B telco operating model, end to end: profiling → verifier task → processing, watched by the control tower, assured by governance and summarised by reporting. Only profiling’s New LOA process runs end to end; the other request types are captured and routed to the team that owns them.</p>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}

      <div className="kpis" data-testid="kpis">
        <div className="kpi"><span className="kpi-value">{overview?.loaCases ?? '–'}</span><span className="kpi-label">New LOA cases assessed</span></div>
        <div className="kpi"><span className="kpi-value">{overview?.openReviews ?? '–'}</span><span className="kpi-label">Open specialist reviews</span></div>
        <div className="kpi"><span className="kpi-value">{overview?.newLeads ?? '–'}</span><span className="kpi-label">New leads · onboarding pending</span></div>
        <div className="kpi"><span className="kpi-value">{overview?.captured.length ?? '–'}</span><span className="kpi-label">Requests captured &amp; routed</span></div>
      </div>

      <div className="dash-toolbar"><h3>Operating model</h3><button type="button" className="link" onClick={() => void load()}><Icon name="refresh" /> Refresh</button></div>
      <ol className="stepper" data-testid="pipeline" aria-label="Operating-model stages">
        {overview?.stages.map((entry) => (
          <li key={entry.id} className={`step ${entry.build.toLowerCase()} ${entry.id === selected ? 'selected' : ''}`}>
            <button type="button" onClick={() => setSelected(entry.id)} aria-current={entry.id === selected ? 'step' : undefined} data-testid={`stage-${entry.id}`}>
              <span className="step-dot" aria-hidden="true">{entry.order}</span>
              <span className="step-name">{entry.name}</span>
              <span className={`step-state step-${entry.build.toLowerCase()}`}>{buildText[entry.build]}</span>
              {entry.build !== 'NOT_BUILT' ? <span className="step-count"><strong>{stageCount(entry)}</strong> {entry.id === 'PROFILING' ? 'cases' : 'routed'}</span> : <span className="step-count muted">no workload</span>}
            </button>
          </li>
        ))}
      </ol>

      {stage ? (
        <article className="card stage-detail" data-testid="stage-detail" aria-live="polite">
          <header>
            <h3>{stage.order}. {stage.name} <Badge value={stage.build} /></h3>
            <p className="muted">{stage.summary}</p>
          </header>
          <div className="detail-cols">
            <div>
              <h4>What this stage covers</h4>
              <ul className="bullets">{stage.covers.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
            <div>
              <h4>Request types</h4>
              {stage.requestTypes.length ? <div className="chips">{stage.requestTypes.map((entry) => <span key={entry.id} className={`chip ${entry.automated ? 'chip-live' : ''}`}>{entry.automated ? <Icon name="check" /> : null} {entry.label}</span>)}</div> : <p className="muted">No customer request types start here.</p>}
              {stage.requestTypes.some((entry) => entry.automated) ? <p className="small"><Icon name="check" /> Automated: {stage.requestTypes.filter((entry) => entry.automated).map((entry) => entry.label).join(', ')}</p> : null}
              <p className="small muted">Queue: <code>{stage.queue}</code> · {stage.id === 'PROFILING' ? `${stage.assessed + stage.captured} cases in this stage` : `${stage.captured} requests routed here`}</p>
            </div>
          </div>
        </article>
      ) : null}

      <div className="dash-toolbar"><h3>New LOA pipeline</h3><span className="muted small">Every New LOA case by where it stands now</span></div>
      <div className="funnel" data-testid="loa-pipeline">
        <div className="funnel-bar" role="img" aria-label="Distribution of New LOA cases">
          {overview?.pipeline.filter((step) => step.count > 0).map((step) => <span key={step.key} className={`seg seg-${pipelineTone[step.key]}`} style={{ flexGrow: step.count / pipelineTotal }} title={`${step.label}: ${step.count}`} />)}
        </div>
        <ul className="funnel-legend">
          {overview?.pipeline.map((step) => <li key={step.key}><span className={`swatch seg-${pipelineTone[step.key]}`} aria-hidden="true" /><span>{step.label}</span><strong>{step.count}</strong></li>)}
        </ul>
      </div>

      <div className="dash-toolbar"><h3>New leads</h3><span className="muted small">Companies not on record — a representative will get back to onboard them</span></div>
      <div className="table-wrap">
        <table className="dash" data-testid="leads-table">
          <thead><tr><th scope="col">Lead case</th><th scope="col">Company</th><th scope="col">Contact</th><th scope="col">Onboarding status</th><th scope="col">Queue</th><th scope="col">Created</th></tr></thead>
          <tbody>
            {overview?.leads.map((row) => (
              <tr key={row.caseRunId}><th scope="row"><code>{row.caseRunId}</code></th><td>{row.businessName}</td><td>{row.representativeName}</td><td><Badge value={row.onboardingStatus} /></td><td><code>{row.queue}</code></td><td>{when(row.createdAt)}</td></tr>
            ))}
            {overview && overview.leads.length === 0 ? <tr><td colSpan={6} className="muted">No new leads yet. Introduce a company that is not on record in the Assessment chat and confirm its name.</td></tr> : null}
            {!overview ? <tr><td colSpan={6} className="muted">Loading…</td></tr> : null}
          </tbody>
        </table>
      </div>

      <div className="dash-toolbar"><h3>Captured requests</h3></div>
      <div className="table-wrap">
        <table className="dash" data-testid="captured-table">
          <thead><tr><th scope="col">Case</th><th scope="col">Request</th><th scope="col">Routed to</th><th scope="col">Queue</th><th scope="col">Company</th><th scope="col">Customer</th><th scope="col">Captured</th></tr></thead>
          <tbody>
            {overview?.captured.map((row) => (
              <tr key={row.caseRunId}><th scope="row"><code>{row.caseRunId}</code></th><td>{row.requestLabel}</td><td><Badge value="ROUTED" /> {row.stageName}</td><td><code>{row.queue}</code></td><td>{row.businessName}</td><td>{row.representativeName}</td><td>{when(row.capturedAt)}</td></tr>
            ))}
            {overview && overview.captured.length === 0 ? <tr><td colSpan={7} className="muted">No requests captured yet. Start one from the Assessment chat — for example “I want to port our mobile numbers”.</td></tr> : null}
            {!overview ? <tr><td colSpan={7} className="muted">Loading…</td></tr> : null}
          </tbody>
        </table>
      </div>
      <p className="muted small">Captured requests have not been checked, approved or changed: there is no automation for them yet.</p>

      <div className="dash-toolbar"><h3>Recent activity</h3></div>
      <ol className="activity" data-testid="activity">
        {overview?.activity.map((event, index) => (
          <li key={`${event.caseRunId}-${event.timestamp}-${index}`}><span className="activity-dot" aria-hidden="true" /><div><strong>{event.eventType.replaceAll('_', ' ').toLowerCase()}</strong> <code>{event.caseRunId}</code> <span className="muted">· {event.actor}{event.reasonCode ? ` · ${event.reasonCode}` : ''}</span><div className="small muted">{when(event.timestamp)}</div></div></li>
        ))}
        {overview && overview.activity.length === 0 ? <li className="muted">No activity yet.</li> : null}
      </ol>
    </section>
  );
}
