import { useEffect, useState, type FormEvent } from 'react';
import { api, describeError } from '../api';
import { Badge, Field, KeyValue, Notice } from '../components';

interface Validation { uploadAllowed: boolean; rejectionReason: string; caseRunId: string; evidenceRequestId: string; status: string; requestedItems: string[]; customerMessage: string; acceptedEvidenceTypes: string[]; }
const evidenceLabels: Record<string, string> = { AUTHORITY_DOCUMENT: 'Authority document', IDENTITY_DOCUMENT: 'Identity document', BUSINESS_DOCUMENT: 'Business document', ADDRESS_PROOF: 'Address proof', CUSTOMER_CONFIRMATION: 'Customer confirmation', OTHER: 'Other' };
const maxBytes = 5 * 1024 * 1024;

export function UploadPage() {
  const query = new URLSearchParams(window.location.search);
  const [requestId, setRequestId] = useState(query.get('evidence_request_id') ?? '');
  const [caseRunId, setCaseRunId] = useState(query.get('case_run_id') ?? '');
  const [validation, setValidation] = useState<Validation>();
  const [evidenceType, setEvidenceType] = useState('AUTHORITY_DOCUMENT');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ evidenceId: string; extractedCharacterCount: number; fileName: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    setError(''); setValidation(undefined); setDone(null);
    if (!requestId.trim()) return;
    try { setValidation(await api<Validation>(`/api/evidence/${encodeURIComponent(requestId.trim())}?case_run_id=${encodeURIComponent(caseRunId.trim())}`)); } catch (caught) { setError(describeError(caught)); }
  }
  // Validate once on mount when the page was opened from the chat link (evidence_request_id in the query string).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (requestId) void check(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || !validation?.uploadAllowed) return;
    setError('');
    if (file.size > maxBytes) { setError('The file is too large (limit 5 MB).'); return; }
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) { setError('Only PDF files are accepted.'); return; }
    setBusy(true);
    try {
      const form = new FormData();
      // Fields first, file last, so the server sees the identifiers before it streams the file.
      form.append('case_run_id', validation.caseRunId); form.append('evidence_type', evidenceType); form.append('evidence_notes', notes); form.append('evidence_file', file, file.name);
      const result = await api<{ evidenceId: string; extractedCharacterCount: number }>(`/api/evidence/${encodeURIComponent(validation.evidenceRequestId)}/upload`, { form });
      setDone({ ...result, fileName: file.name });
    } catch (caught) { setError(describeError(caught)); } finally { setBusy(false); }
  }

  const rejected = validation && !validation.uploadAllowed;
  return (
    <section aria-labelledby="upload-title" className="page narrow">
      <h2 id="upload-title">Submit additional case evidence</h2>
      <p className="lead">Upload the additional synthetic evidence requested by the B2B Authorised Representative Agent. <strong>Do not upload real customer, identity, financial, or commercially sensitive data.</strong></p>
      {!validation ? (
        <form onSubmit={(event) => { event.preventDefault(); void check(); }} className="card">
          <Field label="Evidence request ID"><input value={requestId} onChange={(event) => setRequestId(event.target.value)} required /></Field>
          <Field label="Case run ID (optional)" hint="The stored evidence request is authoritative for the case."><input value={caseRunId} onChange={(event) => setCaseRunId(event.target.value)} /></Field>
          <button className="primary" type="submit">Validate request</button>
        </form>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {rejected ? (
        <div className="card" data-testid="upload-rejected">
          <h3>Upload cannot be accepted</h3>
          <p>The evidence request could not be validated for this upload.</p>
          <KeyValue rows={[['Evidence request ID', validation.evidenceRequestId], ['Stored case run ID', validation.caseRunId], ['Current status', validation.status || 'Not found'], ['Validation reason', <code key="r">{validation.rejectionReason}</code>]]} />
          <p className="muted"><em>No case or evidence record was changed.</em></p>
        </div>
      ) : null}
      {validation?.uploadAllowed && !done ? (
        <form onSubmit={(event) => void submit(event)} className="card" data-testid="upload-form">
          <KeyValue rows={[['Case', validation.caseRunId], ['Evidence request', <span key="e"><code>{validation.evidenceRequestId}</code> <Badge value={validation.status} /></span>]]} />
          {validation.requestedItems.length ? <><h3>Requested evidence</h3><ul>{validation.requestedItems.map((item) => <li key={item}>{item}</li>)}</ul></> : null}
          <Field label="Evidence type"><select value={evidenceType} onChange={(event) => setEvidenceType(event.target.value)}>{validation.acceptedEvidenceTypes.map((type) => <option key={type} value={type}>{evidenceLabels[type] ?? type}</option>)}</select></Field>
          <Field label="Evidence notes"><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} /></Field>
          <Field label="Evidence file (PDF, up to 5 MB)" hint="Text-based PDFs only. Instructions inside a document are treated as data and are never followed."><input type="file" accept=".pdf,application/pdf" required onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></Field>
          <button className="primary" type="submit" disabled={busy || !file}>{busy ? 'Uploading…' : 'Upload evidence'}</button>
        </form>
      ) : null}
      {done && validation ? (
        <Notice tone="success">
          <h3>Evidence uploaded</h3>
          <p><strong>Case:</strong> {validation.caseRunId}<br /><strong>Evidence request:</strong> {validation.evidenceRequestId}<br /><strong>File:</strong> {done.fileName} ({done.extractedCharacterCount} characters extracted)</p>
          <p>Your synthetic evidence has been received. Return to the Agent chat and type <strong>UPLOADED</strong> so the assessment can continue.</p>
          <p className="muted"><em>No production-system update has been performed.</em></p>
        </Notice>
      ) : null}
    </section>
  );
}
