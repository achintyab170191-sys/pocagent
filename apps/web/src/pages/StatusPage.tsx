import { useEffect, useState, type FormEvent } from 'react';
import { api, describeError } from '../api';
import { Badge, Field, KeyValue, Notice } from '../components';

interface Status {
  caseIdentifiers: { caseRunId: string; caseId: string; submissionVersion: number };
  currentStatus: string; currentStage: string; outcome: string; primaryReason: string; summary: string; nextAction: string; targetQueue: string;
  humanReview: { reviewId: string; status: string; queue: string } | null;
  latestEvidenceRequest: { evidenceRequestId: string; status: string; evidenceChannel: string; requestedItems: string[]; attemptCount: number; maxAttempts: number } | null;
  latestEvidence: { evidenceId: string; evidenceType: string; evidenceSource: string; validationStatus: string; providedAt: string } | null;
  latestCommunication: { communicationId: string; templateId: string; subject: string; body: string; status: string } | null;
  dataQualityWarnings: string[];
}

export function StatusPage() {
  const [caseRunId, setCaseRunId] = useState(new URLSearchParams(window.location.search).get('case_run_id') ?? 'AUTH-101');
  const [cases, setCases] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  useEffect(() => { void api<{ cases: Array<{ caseRunId: string }> }>('/api/cases').then((body) => setCases(body.cases.map((entry) => entry.caseRunId))).catch(() => undefined); }, []);
  async function load(event?: FormEvent) {
    event?.preventDefault(); setError(''); setStatus(undefined);
    try { setStatus(await api<Status>(`/api/cases/${encodeURIComponent(caseRunId.trim())}/status`)); } catch (caught) { setError(describeError(caught)); }
  }
  // Load once on mount when the page was opened with ?case_run_id=...
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (new URLSearchParams(window.location.search).get('case_run_id')) void load(); }, []);

  return (
    <section aria-labelledby="status-title" className="page">
      <h2 id="status-title">Case status</h2>
      <p className="lead">Read-only view of the persisted state of a synthetic case.</p>
      <form onSubmit={(event) => void load(event)} className="card inline-form">
        <Field label="Case run ID"><input list="case-list" value={caseRunId} onChange={(event) => setCaseRunId(event.target.value)} required /><datalist id="case-list">{cases.map((id) => <option key={id} value={id} />)}</datalist></Field>
        <button className="primary" type="submit">View status</button>
      </form>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {status ? (
        <div className="grid" data-testid="status-view">
          <div className="card">
            <h3>{status.caseIdentifiers.caseRunId} <Badge value={status.outcome} /></h3>
            <KeyValue rows={[['Logical case', status.caseIdentifiers.caseId], ['Submission version', String(status.caseIdentifiers.submissionVersion)], ['Status', <Badge key="s" value={status.currentStatus} />], ['Stage', status.currentStage.replaceAll('_', ' ')], ['Primary reason', status.primaryReason ? <code key="r">{status.primaryReason}</code> : ''], ['Summary', status.summary], ['Next action', status.nextAction], ['Target queue', status.targetQueue]]} />
          </div>
          <div className="card"><h3>Human review</h3>{status.humanReview ? <KeyValue rows={[['Review ID', status.humanReview.reviewId], ['Status', <Badge key="h" value={status.humanReview.status} />], ['Queue', status.humanReview.queue]]} /> : <p className="muted">No review record.</p>}</div>
          <div className="card"><h3>Latest evidence request</h3>{status.latestEvidenceRequest ? <KeyValue rows={[['Request', status.latestEvidenceRequest.evidenceRequestId], ['Status', <Badge key="e" value={status.latestEvidenceRequest.status} />], ['Channel', status.latestEvidenceRequest.evidenceChannel], ['Attempts', `${status.latestEvidenceRequest.attemptCount} of ${status.latestEvidenceRequest.maxAttempts}`], ['Requested', status.latestEvidenceRequest.requestedItems.join('; ')]]} /> : <p className="muted">No evidence request.</p>}
            <h4>Latest evidence</h4>{status.latestEvidence ? <KeyValue rows={[['Evidence', status.latestEvidence.evidenceId], ['Type', status.latestEvidence.evidenceType], ['Source', status.latestEvidence.evidenceSource], ['Validation', <Badge key="v" value={status.latestEvidence.validationStatus} />]]} /> : <p className="muted">No evidence received.</p>}</div>
          <div className="card"><h3>Latest communication</h3>{status.latestCommunication ? <><p><strong>{status.latestCommunication.subject}</strong> <Badge value={status.latestCommunication.status} /></p><p>{status.latestCommunication.body}</p><p className="muted small">Template {status.latestCommunication.templateId}. Drafts are never sent.</p></> : <p className="muted">No communication drafted.</p>}</div>
          <div className="card wide"><h3>Data-quality warnings</h3><ul>{status.dataQualityWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>
        </div>
      ) : null}
    </section>
  );
}
