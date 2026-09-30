import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import { api, describeError, ensureSession } from '../api';
import { Badge, Markdown, Notice } from '../components';

interface ChatReply {
  sessionId: string; step: 'IDLE' | 'INTAKE' | 'AWAITING_EVIDENCE' | 'DONE'; messages: string[]; caseRunId: string;
  outcome?: { governedOutcome: string; primaryReasonCode: string; humanReviewRequired: boolean; provisionalOutcome: string; governanceOverride: boolean; toolsCalled: string[] };
  evidenceRequest?: { evidenceRequestId: string; evidenceChannel: string; requestedItems: string[]; status: string; attemptCount: number; maxAttempts: number };
  actions?: { resubmit: boolean };
}
interface Turn { role: 'user' | 'agent'; text: string; attachments?: string[]; meta?: ChatReply; }
interface Scenario { caseRunId: string; representativeName: string; businessName: string; }
interface CaseSummary { caseRunId: string; businessName: string; }

const welcome = 'Hello! I can help you become an authorised representative for a business.\n\nTo get started, please tell me **your name** and **the company you represent** — for example: "My name is Hana Rangi and I represent Kauri Harbour Demo Digital Limited."';
const acceptedTypes = '.pdf,.docx,.png,.jpg,.jpeg,.gif,.bmp,.webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*';
const allowedExtension = /\.(pdf|docx|png|jpe?g|gif|bmp|webp)$/i;
const maxFiles = 3;
const maxBytes = 5 * 1024 * 1024;
const size = (bytes: number): string => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function ChatPage() {
  const [turns, setTurns] = useState<Turn[]>([{ role: 'agent', text: welcome }]);
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [session, setSession] = useState('');
  const [step, setStep] = useState<ChatReply['step']>('IDLE');
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [request, setRequest] = useState<ChatReply['evidenceRequest']>();
  const [canResubmit, setCanResubmit] = useState(false);
  const [dragging, setDragging] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const textbox = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void ensureSession().then((value) => setSession(value.sessionId));
    void api<{ scenarios: Scenario[] }>('/api/scenarios').then((body) => setScenarios(body.scenarios)).catch(() => undefined);
    void api<{ cases: CaseSummary[] }>('/api/cases').then((body) => setCases(body.cases.filter((entry) => /^AUTH-0/.test(entry.caseRunId)))).catch(() => undefined);
  }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [turns]);

  const awaitingEvidence = step === 'AWAITING_EVIDENCE';

  function addFiles(selected: File[]) {
    setError('');
    const accepted: File[] = [];
    for (const file of selected) {
      if (!allowedExtension.test(file.name)) { setError(`"${file.name}" is not a supported file. Please attach a PDF, Word (.docx) or image file.`); continue; }
      if (file.size > maxBytes) { setError(`"${file.name}" is larger than 5 MB.`); continue; }
      accepted.push(file);
    }
    setFiles((current) => { const next = [...current, ...accepted]; if (next.length > maxFiles) setError(`You can attach up to ${maxFiles} files at a time.`); return next.slice(0, maxFiles); });
  }
  function onPick(event: ChangeEvent<HTMLInputElement>) { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }
  function onDrop(event: DragEvent) { event.preventDefault(); setDragging(false); if (awaitingEvidence) addFiles(Array.from(event.dataTransfer.files)); }

  async function send(message: string, attached: File[] = []) {
    if ((!message.trim() && attached.length === 0) || busy) return;
    setBusy(true); setError('');
    setTurns((current) => [...current, { role: 'user', text: message.trim(), attachments: attached.map((file) => `${file.name} (${size(file.size)})`) }]);
    try {
      let reply: ChatReply;
      if (attached.length > 0) {
        const form = new FormData();
        form.append('message', message.trim());
        for (const file of attached) form.append('evidence_file', file, file.name);
        reply = await api<ChatReply>('/api/chat/evidence', { form });
      } else reply = await api<ChatReply>('/api/chat', { body: { message } });
      setInput(''); setFiles([]);
      setStep(reply.step); setRequest(reply.evidenceRequest); setSession(reply.sessionId); setCanResubmit(reply.actions?.resubmit === true);
      setTurns((current) => [...current, ...reply.messages.map((text, index): Turn => ({ role: 'agent', text, meta: index === reply.messages.length - 1 ? reply : undefined }))]);
    } catch (caught) {
      // A refused message stays in the box (and its files stay attached) so the customer can fix it and try again.
      setTurns((current) => current.slice(0, -1));
      setError(describeError(caught));
    } finally { setBusy(false); textbox.current?.focus(); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void send(input, files); }
  function fillScenario(scenario: Scenario) { setInput(`My name is ${scenario.representativeName} and I represent ${scenario.businessName}.`); textbox.current?.focus(); }

  return (
    <section aria-labelledby="chat-title" className="page">
      <h2 id="chat-title">Customer assessment</h2>
      <p className="lead">Tell the assistant who you are and which company you represent. If more evidence is needed you can answer right here — type a reply, attach documents, or both. Responses are curated business summaries; prompts, rules and raw tool output are never shown.</p>
      <div className={`chat${dragging ? ' chat-drop' : ''}`} role="log" aria-live="polite" aria-label="Conversation" data-testid="chat-log"
        onDragOver={(event) => { if (awaitingEvidence) { event.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
        {turns.map((turn, index) => (
          <div key={index} className={`turn turn-${turn.role}`}>
            <div className="turn-label">{turn.role === 'user' ? 'You' : 'Assessment agent'}</div>
            {turn.text ? <Markdown text={turn.text} /> : null}
            {turn.attachments?.length ? <ul className="attachments">{turn.attachments.map((name) => <li key={name}>📎 {name}</li>)}</ul> : null}
            {turn.meta?.outcome ? (
              <div className="turn-meta" data-testid="outcome-meta">
                <Badge value={turn.meta.outcome.governedOutcome} />
                <span>Governed outcome · reason <code>{turn.meta.outcome.primaryReasonCode}</code>{turn.meta.caseRunId ? <> · case <code>{turn.meta.caseRunId}</code></> : null}</span>
                {turn.meta.outcome.governanceOverride ? <span className="override">Agent recommended {turn.meta.outcome.provisionalOutcome.replaceAll('_', ' ')}; deterministic policy applied.</span> : null}
                <span className="trace">Tools called: {turn.meta.outcome.toolsCalled.length ? turn.meta.outcome.toolsCalled.join(' → ') : 'none (resumed from persisted results)'}</span>
              </div>
            ) : null}
          </div>
        ))}
        {busy ? <div className="turn turn-agent" aria-live="polite"><div className="turn-label">Assessment agent</div><p className="muted">{files.length ? 'Reading your documents and assessing the evidence…' : 'Working on it…'}</p></div> : null}
        <div ref={bottom} />
      </div>

      {request && awaitingEvidence ? (
        <div className="evidence-card" data-testid="evidence-card">
          <strong>Evidence needed</strong> <Badge value={request.status} /> <span className="muted">attempt {request.attemptCount} of {request.maxAttempts}</span>
          <ul>{request.requestedItems.map((item) => <li key={item}>{item}</li>)}</ul>
        </div>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {(awaitingEvidence || step === 'DONE') && canResubmit ? (
        <div className="quick"><button type="button" className="chip" disabled={busy} onClick={() => void send('Submit a corrected version (resubmit)')}>Submit a corrected version instead</button></div>
      ) : null}

      <form className={`composer${dragging ? ' composer-drop' : ''}`} onSubmit={submit} data-testid="composer">
        {files.length ? (
          <ul className="file-chips" aria-label="Attached files">
            {files.map((file) => <li key={`${file.name}-${file.size}`}><span>📎 {file.name} <span className="muted">({size(file.size)})</span></span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((entry) => entry !== file))}>×</button></li>)}
          </ul>
        ) : null}
        <div className="composer-row">
          {awaitingEvidence ? (
            <>
              <input ref={picker} type="file" multiple accept={acceptedTypes} onChange={onPick} className="sr-only" aria-label="Attach documents" data-testid="file-input" tabIndex={-1} />
              <button type="button" className="attach" onClick={() => picker.current?.click()} disabled={busy || files.length >= maxFiles} title="Attach PDF, Word or image files (up to 3, 5 MB each)">📎 Attach</button>
            </>
          ) : null}
          <label className="sr-only" htmlFor="chat-input">Message</label>
          <textarea id="chat-input" ref={textbox} rows={2} value={input} onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(input, files); } }}
            placeholder={awaitingEvidence ? 'Type your answer, or attach documents…' : step === 'INTAKE' ? 'Type your reply…' : 'Tell me your name and the company you represent…'} maxLength={10000} />
          <button className="primary" type="submit" disabled={busy || (!input.trim() && files.length === 0)}>{busy ? 'Working…' : 'Send'}</button>
        </div>
        {awaitingEvidence ? (
          <div className="composer-foot">
            <span className="muted small">PDF, Word (.docx) or image files · up to {maxFiles} files, 5 MB each · you can also drag files onto the chat</span>
            <button type="button" className="link" disabled={busy} onClick={() => void send('Cancel request')}>Cancel request</button>
          </div>
        ) : null}
      </form>
      <p className="muted small">Conversation session <code data-testid="session-id">{session || '…'}</code></p>

      <details className="demo">
        <summary>Demo: synthetic identities you can use</summary>
        <p className="muted small">This is a synthetic prototype: results come from pre-computed scenarios. Introduce yourself as one of these people to see a scenario; any other name and company is opened as a case and routed to a specialist because no scenario matches.</p>
        <ul className="scenario-list">
          {scenarios.map((scenario) => <li key={scenario.caseRunId}><button type="button" className="chip" onClick={() => fillScenario(scenario)}>{scenario.representativeName} · {scenario.businessName}</button></li>)}
        </ul>
        {cases.length ? <>
          <p className="muted small">Developer shortcuts — evaluate a scenario case directly:</p>
          <div className="quick">{cases.map((entry) => <button key={entry.caseRunId} type="button" className="chip" disabled={busy || awaitingEvidence} title={entry.businessName} onClick={() => void send(`Evaluate ${entry.caseRunId}`)}>{entry.caseRunId}</button>)}</div>
        </> : null}
      </details>
    </section>
  );
}
