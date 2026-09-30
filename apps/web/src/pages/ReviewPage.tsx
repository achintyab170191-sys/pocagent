import { useState, type FormEvent } from 'react';
import { api, describeError } from '../api';
import { Badge, Field, KeyValue, Notice } from '../components';

interface ReviewPackage {
  reviewId: string; caseRunId: string; reviewQueue: string; reviewStatus: string; agentRecommendation: string; requestedAt: string; originalOutcome: string; originalPrimaryReasonCode: string; originalCustomerSafeSummary: string; originalConflicts: string[]; originalMissingInformation: string[];
  businessName: string; businessIdentifier: string; representativeName: string; representativeRole: string; requestedAuthority: string; country: string;
}
interface Completion { reviewId: string; reviewStatus: string; outcome: string; nextAction: string; targetQueue: string; communication: { subject: string; body: string; status: string }; }
const decisions = ['APPROVE', 'NEED_MORE_INFORMATION', 'REJECT'] as const;

export function ReviewPage() {
  const [reviewId, setReviewId] = useState(new URLSearchParams(window.location.search).get('review_id') ?? '');
  const [pack, setPack] = useState<ReviewPackage>();
  const [name, setName] = useState('');
  const [decision, setDecision] = useState<(typeof decisions)[number]>('APPROVE');
  const [comments, setComments] = useState('');
  const [override, setOverride] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<Completion>();
  const [busy, setBusy] = useState(false);

  async function open(event?: FormEvent) {
    event?.preventDefault(); setError(''); setPack(undefined); setDone(undefined);
    try { setPack((await api<{ review: ReviewPackage }>(`/api/reviews/${encodeURIComponent(reviewId.trim())}`)).review); } catch (caught) { setError(describeError(caught)); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!pack || busy) return; setBusy(true); setError('');
    try { setDone(await api<Completion>(`/api/reviews/${encodeURIComponent(pack.reviewId)}/complete`, { body: { reviewerName: name, reviewerDecision: decision, reviewerComments: comments, overrideReason: override } })); setPack(undefined); } catch (caught) { setError(describeError(caught)); } finally { setBusy(false); }
  }
  const needsOverride = pack?.agentRecommendation.toUpperCase() === 'REJECT' && decision !== 'REJECT';

  return (
    <section aria-labelledby="review-title" className="page narrow">
      <h2 id="review-title">Human review</h2>
      <p className="lead">Enter the Review ID assigned to the case. Synthetic prototype only. No production-system action will be performed.</p>
      <form onSubmit={(event) => void open(event)} className="card inline-form">
        <Field label="Review ID"><input value={reviewId} onChange={(event) => setReviewId(event.target.value)} required placeholder="e.g. REV-AUTH-005-1" /></Field>
        <button className="primary" type="submit">Open review</button>
      </form>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {pack ? (
        <form onSubmit={(event) => void submit(event)} className="card" data-testid="review-form">
          <h3>Review case {pack.caseRunId}</h3>
          <KeyValue rows={[['Review ID', pack.reviewId], ['Country', pack.country], ['Business', `${pack.businessName} (${pack.businessIdentifier})`], ['Representative', `${pack.representativeName}, ${pack.representativeRole}`], ['Requested authority', pack.requestedAuthority],
            ['Agent recommendation', <Badge key="a" value={pack.agentRecommendation} />], ['Primary reason', <code key="p">{pack.originalPrimaryReasonCode}</code>], ['Review queue', pack.reviewQueue], ['Current summary', pack.originalCustomerSafeSummary],
            ['Conflicts', pack.originalConflicts.length ? <ul key="c">{pack.originalConflicts.map((item) => <li key={item}>{item}</li>)}</ul> : 'None recorded'], ['Missing information', pack.originalMissingInformation.length ? pack.originalMissingInformation.join(', ') : 'None recorded']]} />
          <hr />
          <Field label="Reviewer name"><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} /></Field>
          <Field label="Reviewer decision"><select value={decision} onChange={(event) => setDecision(event.target.value as (typeof decisions)[number])}>{decisions.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></Field>
          <Field label="Reviewer comments"><textarea rows={4} value={comments} onChange={(event) => setComments(event.target.value)} required maxLength={10000} /></Field>
          <Field label={needsOverride ? 'Override reason (required)' : 'Override reason'} hint={needsOverride ? 'The agent recommended REJECT; explain why you are choosing another disposition.' : undefined}><textarea rows={3} value={override} onChange={(event) => setOverride(event.target.value)} required={needsOverride} maxLength={10000} /></Field>
          <button className="primary" type="submit" disabled={busy}>{busy ? 'Submitting…' : 'Complete review'}</button>
        </form>
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
    </section>
  );
}
