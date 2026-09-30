import { useEffect, useState, type FormEvent } from 'react';
import { api, describeError } from '../api';
import { Badge, Field, KeyValue, Markdown, Notice } from '../components';

interface Result { revisedCaseRunId: string; submissionVersion: number; outcome: string; primaryReasonCode: string; summary: string; nextAction: string; communication: { subject: string; body: string; status: string }; curated: string; }

export function ResubmissionPage() {
  const [original, setOriginal] = useState('AUTH-008-V1');
  const [revised, setRevised] = useState('AUTH-008-V2');
  const [comments, setComments] = useState('');
  const [cases, setCases] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api<{ cases: Array<{ caseRunId: string }> }>('/api/cases').then((body) => setCases(body.cases.map((entry) => entry.caseRunId))).catch(() => undefined); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setResult(undefined);
    try { setResult(await api<Result>('/api/resubmissions', { body: { originalCaseRunId: original.trim(), revisedCaseRunId: revised.trim(), resubmissionComments: comments } })); } catch (caught) { setError(describeError(caught)); } finally { setBusy(false); }
  }
  return (
    <section aria-labelledby="resubmit-title" className="page narrow">
      <h2 id="resubmit-title">Submit revised authority evidence</h2>
      <p className="lead">Synthetic prototype only. Use this form to resubmit a case whose <strong>latest</strong> outcome is NEED MORE INFORMATION as a later version of the same logical case (for example AUTH-008-V1 → AUTH-008-V2). If you are chatting, you can also use the "Submit a corrected version" button in the chat. A case whose evidence has already been accepted (so its outcome changed) can no longer be resubmitted.</p>
      <form onSubmit={(event) => void submit(event)} className="card">
        <Field label="Original case run ID"><input value={original} onChange={(event) => setOriginal(event.target.value)} required /></Field>
        <Field label="Revised case run ID"><input list="revised-list" value={revised} onChange={(event) => setRevised(event.target.value)} required /><datalist id="revised-list">{cases.map((id) => <option key={id} value={id} />)}</datalist></Field>
        <Field label="Resubmission comments"><textarea rows={3} value={comments} onChange={(event) => setComments(event.target.value)} required maxLength={10000} /></Field>
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Assessing…' : 'Submit resubmission'}</button>
      </form>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {result ? (
        <Notice tone="success">
          <h3>Revised assessment completed</h3>
          <KeyValue rows={[['Revised case', result.revisedCaseRunId], ['Submission version', String(result.submissionVersion)], ['Outcome', <Badge key="o" value={result.outcome} />], ['Primary reason', <code key="r">{result.primaryReasonCode}</code>], ['Summary', result.summary], ['Next action', result.nextAction]]} />
          <h4>Updated draft communication</h4><p><strong>Subject:</strong> {result.communication.subject}</p><p>{result.communication.body}</p>
          <details><summary>Curated assessment</summary><Markdown text={result.curated} /></details>
          <p className="muted"><em>The original submission has been marked as superseded. This is a synthetic prototype. No production-system action was performed.</em></p>
        </Notice>
      ) : null}
    </section>
  );
}
