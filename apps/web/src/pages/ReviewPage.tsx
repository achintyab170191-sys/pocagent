import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, describeError } from '../api';
import { Badge, Field, KeyValue, Notice } from '../components';

interface Row { reviewId: string; caseRunId: string; businessName: string; representativeName: string; reviewStatus: string; reviewOpen: boolean; agentRecommendation: string; reviewQueue: string; primaryReasonCode: string; requestedAt: string; completedAt: string; }
interface ReviewPackage {
  reviewId: string; caseRunId: string; reviewQueue: string; reviewStatus: string; reviewOpen: boolean; agentRecommendation: string; requestedAt: string; submissionVersion: number;
  reviewerName: string; reviewerDecision: string; reviewerComments: string; completedAt: string;
  originalOutcome: string; originalPrimaryReasonCode: string; originalCustomerSafeSummary: string; originalNextAction: string; originalConflicts: string[]; originalMissingInformation: string[];
  businessName: string; representativeName: string; requestedAuthority: string; country: string;
  checks: Array<{ sequence: number; agentId: string; utilityName: string; checkType: string; status: string; reasonCodes: string[] }>;
  documents: Array<{ documentType: string; fileName: string; validationStatus: string }>;
  rootCause: { failedCheck: string; rootCause: string; recommendedAction: string } | null;
  decisionAvailable: boolean; reopenAvailable: boolean;
}
interface Completion { reviewId: string; reviewStatus: string; outcome: string; nextAction: string; targetQueue: string; communication: { subject: string; body: string; status: string }; }
interface Reopened { originalCaseRunId: string; reopenedCaseRunId: string; customerNotified: boolean; }
const decisions = ['APPROVE', 'NEED_MORE_INFORMATION', 'REJECT'] as const;
type Filter = 'ALL' | 'OPEN' | 'CLOSED';

export function ReviewPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState<Filter>('OPEN');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new URLSearchParams(window.location.search).get('review_id') ?? '');
  const [pack, setPack] = useState<ReviewPackage>();
  const [name, setName] = useState('');
  const [decision, setDecision] = useState<(typeof decisions)[number]>('REJECT');
  const [comments, setComments] = useState('');
  const [override, setOverride] = useState('');
  const [reopenNote, setReopenNote] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<Completion>();
  const [reopened, setReopened] = useState<Reopened>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setRows((await api<{ reviews: Row[] }>('/api/reviews')).reviews); setError(''); } catch (caught) { setError(describeError(caught)); } finally { setLoading(false); }
  }, []);
  const open = useCallback(async (reviewId: string) => {
    setSelected(reviewId); setError(''); setDone(undefined); setReopened(undefined); setPack(undefined);
    try {
      const body = await api<{ review: ReviewPackage }>(`/api/reviews/${encodeURIComponent(reviewId)}`);
      setPack(body.review); setDecision(body.review.agentRecommendation === 'APPROVE' ? 'APPROVE' : body.review.agentRecommendation === 'NEED_MORE_INFORMATION' ? 'NEED_MORE_INFORMATION' : 'REJECT');
    } catch (caught) { setError(describeError(caught)); }
  }, []);
  const initialReview = useRef(selected);
  useEffect(() => { void load(); if (initialReview.current) void open(initialReview.current); }, [load, open]);

  async function complete(event: FormEvent) {
    event.preventDefault(); if (!pack || busy) return; setBusy(true); setError('');
    try { setDone(await api<Completion>(`/api/reviews/${encodeURIComponent(pack.reviewId)}/complete`, { body: { reviewerName: name, reviewerDecision: decision, reviewerComments: comments, overrideReason: override } })); setPack(undefined); void load(); } catch (caught) { setError(describeError(caught)); } finally { setBusy(false); }
  }
  async function reopen(event: FormEvent) {
    event.preventDefault(); if (!pack || busy) return; setBusy(true); setError('');
    try { setReopened(await api<Reopened>(`/api/cases/${encodeURIComponent(pack.caseRunId)}/reopen`, { body: { reviewerName: name, comments: reopenNote } })); setPack(undefined); void load(); } catch (caught) { setError(describeError(caught)); } finally { setBusy(false); }
  }
  const needsOverride = pack?.agentRecommendation.toUpperCase() === 'REJECT' && decision !== 'REJECT';
  const visible = rows.filter((row) => filter === 'ALL' || (filter === 'OPEN' ? row.reviewOpen : !row.reviewOpen));
  const openCount = rows.filter((row) => row.reviewOpen).length;

  return (
    <section aria-labelledby="review-title" className="page">
      <h2 id="review-title">Review dashboard</h2>
      <p className="lead">Every review raised by the assessment: rejections waiting for confirmation, cases that need a specialist, and requests that stopped for missing documents. Synthetic prototype only. No production-system action is performed.</p>
      <div className="dash-toolbar">
        <div role="group" aria-label="Filter reviews" className="quick">
          {(['OPEN', 'CLOSED', 'ALL'] as const).map((value) => <button key={value} type="button" className={`chip${filter === value ? ' chip-active' : ''}`} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'OPEN' ? `Open (${openCount})` : value === 'CLOSED' ? 'Closed' : 'All'}</button>)}
        </div>
        <button type="button" className="link" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="table-wrap">
        <table className="dash" data-testid="review-table">
          <thead><tr><th scope="col">Review ID</th><th scope="col">Case</th><th scope="col">Business</th><th scope="col">Representative</th><th scope="col">Recommendation</th><th scope="col">Reason</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.reviewId} className={row.reviewId === selected ? 'row-selected' : undefined}>
                <th scope="row"><code>{row.reviewId}</code></th><td>{row.caseRunId}</td><td>{row.businessName}</td><td>{row.representativeName}</td>
                <td><Badge value={row.agentRecommendation} /></td><td>{row.primaryReasonCode ? <code>{row.primaryReasonCode}</code> : <span className="muted">no checks run</span>}</td>
                <td><Badge value={row.reviewStatus} /></td>
                <td><button type="button" className="chip" onClick={() => void open(row.reviewId)} aria-label={`Open review ${row.reviewId}`}>Open</button></td>
              </tr>
            ))}
            {visible.length === 0 ? <tr><td colSpan={8} className="muted">{loading ? 'Loading…' : filter === 'OPEN' ? 'No open reviews. Cases that are approved or still with the customer do not appear here.' : 'No reviews to show.'}</td></tr> : null}
          </tbody>
        </table>
      </div>

      {pack ? (
        <div className="card" data-testid="review-detail">
          <h3>Review {pack.reviewId} — case {pack.caseRunId}</h3>
          <KeyValue rows={[
            ['Business', pack.businessName], ['Representative', pack.representativeName], ['Requested authority', pack.requestedAuthority],
            ['Agent recommendation', <Badge key="a" value={pack.agentRecommendation} />], ['Review status', <Badge key="s" value={pack.reviewStatus} />],
            ['Primary reason', pack.originalPrimaryReasonCode ? <code key="p">{pack.originalPrimaryReasonCode}</code> : 'No checks were run: the requested documents were not received.'],
            ['Review queue', pack.reviewQueue], ['Summary', pack.originalCustomerSafeSummary], ['Next action', pack.originalNextAction],
            ['Exceptions', pack.originalConflicts.length ? <ul key="c">{pack.originalConflicts.map((item) => <li key={item}>{item}</li>)}</ul> : 'None recorded'],
            ...(pack.reviewOpen ? [] : [['Reviewer', `${pack.reviewerName || '—'} · ${pack.reviewerDecision || '—'}`] as [string, string], ['Reviewer comments', pack.reviewerComments] as [string, string]]),
          ]} />
          <h4>Checks</h4>
          {pack.checks.length ? <ul className="check-list">{pack.checks.map((check) => <li key={check.checkType}><strong>{check.sequence}. {check.utilityName}</strong> ({check.agentId}) <Badge value={check.status} /> <span className="muted">{check.reasonCodes.join(', ')}</span></li>)}</ul> : <p className="muted">None run.</p>}
          <h4>Documents received</h4>
          {pack.documents.length ? <ul>{pack.documents.map((document, index) => <li key={`${document.fileName}-${index}`}>{document.documentType.replaceAll('_', ' ')} — {document.fileName} <Badge value={document.validationStatus} /></li>)}</ul> : <p className="muted">None.</p>}
          {pack.rootCause ? (<><h4>Root-cause analysis (SBO.20)</h4><KeyValue rows={[['Failed check', pack.rootCause.failedCheck.replaceAll('_', ' ')], ['Root cause', pack.rootCause.rootCause], ['Recommended action', pack.rootCause.recommendedAction]]} /></>) : null}

          <hr />
          <Field label="Reviewer name"><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} /></Field>
          {pack.reviewOpen && pack.decisionAvailable ? (
            <form onSubmit={(event) => void complete(event)} data-testid="review-form">
              <h4>Confirm or change the decision</h4>
              <Field label="Reviewer decision"><select value={decision} onChange={(event) => setDecision(event.target.value as (typeof decisions)[number])}>{decisions.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></Field>
              <Field label="Reviewer comments"><textarea rows={3} value={comments} onChange={(event) => setComments(event.target.value)} required maxLength={10000} /></Field>
              <Field label={needsOverride ? 'Override reason (required)' : 'Override reason'} hint={needsOverride ? 'The agent recommended REJECT; explain why you are choosing another disposition.' : undefined}><textarea rows={2} value={override} onChange={(event) => setOverride(event.target.value)} required={needsOverride} maxLength={10000} /></Field>
              <button className="primary" type="submit" disabled={busy || !name.trim()}>{busy ? 'Submitting…' : 'Complete review'}</button>
            </form>
          ) : null}
          {pack.reopenAvailable ? (
            <form onSubmit={(event) => void reopen(event)} data-testid="reopen-form">
              <h4>Reopen for corrected documents</h4>
              <p className="muted small">Creates a new version of this case ({pack.caseRunId}-V{pack.submissionVersion + 1}), closes this one, and asks the customer for their documents again in the chat. No separate form for the customer.</p>
              <Field label="Note to the customer"><textarea rows={3} value={reopenNote} onChange={(event) => setReopenNote(event.target.value)} required maxLength={10000} placeholder="e.g. Please send the renewed Trade License." /></Field>
              <button type="submit" disabled={busy || !name.trim()}>{busy ? 'Reopening…' : 'Reopen case'}</button>
            </form>
          ) : null}
          {!pack.reviewOpen && !pack.reopenAvailable ? <p className="muted">This review is closed and the case cannot be reopened.</p> : null}
        </div>
      ) : null}

      {done ? (
        <Notice tone="success">
          <h3>Human review completed</h3>
          <KeyValue rows={[['Review ID', done.reviewId], ['Final outcome', <Badge key="o" value={done.outcome} />], ['Next action', done.nextAction], ['Target queue', done.targetQueue]]} />
          <h4>Updated communication draft</h4>
          <p><strong>Subject:</strong> {done.communication.subject}</p><p>{done.communication.body}</p>
          <p className="muted"><em>The communication remains a {done.communication.status.toLowerCase()} and has not been sent. No production-system action was performed.</em></p>
        </Notice>
      ) : null}
      {reopened ? (
        <Notice tone="success">
          <h3>Case reopened</h3>
          <p>{reopened.originalCaseRunId} is closed and <strong>{reopened.reopenedCaseRunId}</strong> is open. {reopened.customerNotified ? 'The customer\'s chat now asks for their documents again.' : 'The customer will be asked for documents the next time they start a chat.'}</p>
        </Notice>
      ) : null}
    </section>
  );
}
