import { useEffect, useRef, useState } from 'react';
import { api, describeError, ensureSession } from '../api';
import { Badge, Markdown, Notice } from '../components';

interface ChatReply {
  sessionId: string; step: string; messages: string[]; caseRunId: string;
  outcome?: { governedOutcome: string; primaryReasonCode: string; humanReviewRequired: boolean; provisionalOutcome: string; governanceOverride: boolean; toolsCalled: string[] };
  evidenceRequest?: { evidenceRequestId: string; evidenceChannel: string; requestedItems: string[]; status: string; attemptCount: number; maxAttempts: number; uploadUrl?: string };
}
interface Turn { role: 'user' | 'agent'; text: string; meta?: ChatReply; }
interface CaseSummary { caseRunId: string; businessName: string; }

const welcome = 'Welcome to the Authorised Representative Decisioning Agent.\n\nThis synthetic prototype evaluates business, document, identity, authority, system, financial and final-verification evidence.\n\nEnter a request such as: Evaluate AUTH-001';

export function ChatPage() {
  const [turns, setTurns] = useState<Turn[]>([{ role: 'agent', text: welcome }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [session, setSession] = useState('');
  const [step, setStep] = useState('IDLE');
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [request, setRequest] = useState<ChatReply['evidenceRequest']>();
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => { void ensureSession().then((value) => setSession(value.sessionId)); void api<{ cases: CaseSummary[] }>('/api/cases').then((body) => setCases(body.cases)).catch(() => undefined); }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [turns]);

  async function send(message: string) {
    if (!message.trim() || busy) return;
    setBusy(true); setError(''); setInput('');
    setTurns((current) => [...current, { role: 'user', text: message }]);
    try {
      const reply = await api<ChatReply>('/api/chat', { body: { message } });
      setStep(reply.step); setRequest(reply.evidenceRequest); setSession(reply.sessionId);
      setTurns((current) => [...current, ...reply.messages.map((text, index): Turn => ({ role: 'agent', text, meta: index === reply.messages.length - 1 ? reply : undefined }))]);
    } catch (caught) { setError(describeError(caught)); } finally { setBusy(false); }
  }

  const quick = step === 'AWAITING_METHOD' ? ['TEXT', 'UPLOAD', 'CANCEL'] : step === 'AWAITING_UPLOAD' ? ['UPLOADED', 'CANCEL'] : step === 'AWAITING_TEXT' ? ['CANCEL'] : [];
  return (
    <section aria-labelledby="chat-title" className="page">
      <h2 id="chat-title">Customer assessment</h2>
      <p className="lead">Evaluate a synthetic case and, when more evidence is needed, provide it in the conversation or through the upload page. Responses are curated business summaries; prompts, rules and raw tool output are never shown.</p>
      <div className="chat" role="log" aria-live="polite" aria-label="Conversation" data-testid="chat-log">
        {turns.map((turn, index) => (
          <div key={index} className={`turn turn-${turn.role}`}>
            <div className="turn-label">{turn.role === 'user' ? 'You' : 'Assessment agent'}</div>
            <Markdown text={turn.text} />
            {turn.meta?.outcome ? (
              <div className="turn-meta" data-testid="outcome-meta">
                <Badge value={turn.meta.outcome.governedOutcome} />
                <span>Governed outcome · reason <code>{turn.meta.outcome.primaryReasonCode}</code></span>
                {turn.meta.outcome.governanceOverride ? <span className="override">Agent recommended {turn.meta.outcome.provisionalOutcome.replaceAll('_', ' ')}; deterministic policy applied.</span> : null}
                <span className="trace">Tools called: {turn.meta.outcome.toolsCalled.length ? turn.meta.outcome.toolsCalled.join(' → ') : 'none (resumed from persisted results)'}</span>
              </div>
            ) : null}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      {request ? (
        <div className="evidence-card" data-testid="evidence-card">
          <strong>Evidence request</strong> <code>{request.evidenceRequestId}</code> <Badge value={request.status} />
          <span> attempt {request.attemptCount} of {request.maxAttempts}</span>
          <ul>{request.requestedItems.map((item) => <li key={item}>{item}</li>)}</ul>
          {request.evidenceChannel !== 'CHAT_TEXT' ? <a className="button-link" href={`/upload?evidence_request_id=${encodeURIComponent(request.evidenceRequestId)}&case_run_id=${encodeURIComponent(turns.at(-1)?.meta?.caseRunId ?? '')}`} target="_blank" rel="noreferrer">Open the evidence upload page</a> : null}
        </div>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="quick" aria-label="Quick replies">
        {quick.map((value) => <button key={value} type="button" className="chip" disabled={busy} onClick={() => void send(value)}>{value}</button>)}
        {step === 'IDLE' || step === 'DONE' ? cases.slice(0, 11).map((entry) => <button key={entry.caseRunId} type="button" className="chip" disabled={busy} title={entry.businessName} onClick={() => void send(`Evaluate ${entry.caseRunId}`)}>{entry.caseRunId}</button>) : null}
      </div>
      <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(input); }}>
        <label className="sr-only" htmlFor="chat-input">Message</label>
        <input id="chat-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Enter a request, for example: Evaluate AUTH-001" autoComplete="off" maxLength={10000} />
        <button className="primary" type="submit" disabled={busy || !input.trim()}>{busy ? 'Working…' : 'Send'}</button>
      </form>
      <p className="muted small">Conversation session <code data-testid="session-id">{session || '…'}</code></p>
    </section>
  );
}
