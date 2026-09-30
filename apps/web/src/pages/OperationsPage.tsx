import { useEffect, useState } from 'react';
import { api, describeError } from '../api';
import { Badge, Notice } from '../components';
import { Icon } from '../icons';

interface StageOverview { id: string; name: string; order: number; summary: string; covers: string[]; build: 'LIVE' | 'ROUTED' | 'NOT_BUILT'; queue: string; requestTypes: Array<{ id: string; label: string; automated: boolean }>; captured: number; assessed: number; }
interface Captured { caseRunId: string; requestTypeId: string; requestLabel: string; stage: string; stageName: string; queue: string; businessName: string; representativeName: string; capturedAt: string; }
interface Overview { stages: StageOverview[]; captured: Captured[]; newLeads: number; loaCases: number; syntheticDataDisclaimer: true; }

const buildLabel: Record<StageOverview['build'], string> = { LIVE: 'LIVE', ROUTED: 'ROUTED', NOT_BUILT: 'NOT BUILT' };

export function OperationsPage() {
  const [overview, setOverview] = useState<Overview>();
  const [error, setError] = useState('');
  const load = () => api<Overview>('/api/operations').then((body) => { setOverview(body); setError(''); }).catch((caught) => setError(describeError(caught)));
  useEffect(() => { void load(); }, []);

  return (
    <section aria-labelledby="ops-title" className="page">
      <div className="page-head" id="ops-title-wrap">
        <h2 id="ops-title">Operations overview</h2>
        <p className="lead">The B2B telco operating model: profiling → verifier task → processing, watched by the control tower, assured by governance and summarised by reporting. Only profiling’s New LOA process runs end to end; the other request types are captured and routed to the team that owns them.</p>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="stat-row" style={{ marginBottom: '0.4rem' }}>
        <div className="card" style={{ margin: 0 }}><div className="count" style={{ fontSize: '1.6rem', fontWeight: 800 }}>{overview?.loaCases ?? '–'}</div><span>New LOA cases assessed</span></div>
        <div className="card" style={{ margin: 0 }}><div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{overview?.captured.length ?? '–'}</div><span>Requests captured &amp; routed</span></div>
        <div className="card" style={{ margin: 0 }}><div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{overview?.newLeads ?? '–'}</div><span>New leads</span></div>
      </div>

      <h3 style={{ margin: '1rem 0 0.2rem' }}>Stages</h3>
      <div className="pipeline" data-testid="pipeline">
        {overview?.stages.map((stage) => (
          <article key={stage.id} className={`stage ${stage.build === 'LIVE' ? 'live' : stage.build === 'ROUTED' ? 'routed' : ''}`} data-testid={`stage-${stage.id}`}>
            <h3>{stage.name}<Badge value={buildLabel[stage.build].replace(' ', '_')} /></h3>
            <p>{stage.summary}</p>
            {stage.build !== 'NOT_BUILT' ? <div className="stat-row"><strong className="count">{stage.id === 'PROFILING' ? stage.assessed + stage.captured : stage.captured}</strong><span>{stage.id === 'PROFILING' ? 'cases in this stage' : 'requests routed here'}</span></div> : null}
            <ul>{stage.covers.slice(0, 6).map((item) => <li key={item}>{item}</li>)}{stage.covers.length > 6 ? <li>+ {stage.covers.length - 6} more</li> : null}</ul>
            {stage.requestTypes.some((entry) => entry.automated) ? <p className="small"><Icon name="check" /> Automated: {stage.requestTypes.filter((entry) => entry.automated).map((entry) => entry.label).join(', ')}</p> : null}
          </article>
        ))}
      </div>

      <div className="dash-toolbar"><h3>Captured requests</h3><button type="button" className="link" onClick={() => void load()}>Refresh</button></div>
      <div className="table-wrap">
        <table className="dash" data-testid="captured-table">
          <thead><tr><th scope="col">Case</th><th scope="col">Request</th><th scope="col">Routed to</th><th scope="col">Queue</th><th scope="col">Company</th><th scope="col">Customer</th><th scope="col">Captured</th></tr></thead>
          <tbody>
            {overview?.captured.map((row) => (
              <tr key={row.caseRunId}><th scope="row"><code>{row.caseRunId}</code></th><td>{row.requestLabel}</td><td><Badge value={row.stage === 'PROFILING' ? 'ROUTED' : 'ROUTED'} /> {row.stageName}</td><td><code>{row.queue}</code></td><td>{row.businessName}</td><td>{row.representativeName}</td><td>{new Date(row.capturedAt).toLocaleString()}</td></tr>
            ))}
            {overview && overview.captured.length === 0 ? <tr><td colSpan={7} className="muted">No requests captured yet. Start one from the Assessment chat — for example “I want to port our mobile numbers”.</td></tr> : null}
            {!overview ? <tr><td colSpan={7} className="muted">Loading…</td></tr> : null}
          </tbody>
        </table>
      </div>
      <p className="muted small">Captured requests have not been checked, approved or changed: there is no automation for them yet.</p>
    </section>
  );
}
