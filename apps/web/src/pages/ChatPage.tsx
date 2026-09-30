import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import { api, describeError, ensureSession } from '../api';
import { Badge, Markdown, Notice } from '../components';
import { Icon } from '../icons';

type Step = 'IDLE' | 'INTAKE' | 'AWAITING_EVIDENCE' | 'DONE';
interface RequestInfo { id: string; label: string; stage: string; stageName: string; automated: boolean; }
interface ChatReply {
  sessionId: string; step: Step; messages: string[]; caseRunId: string; requestType?: RequestInfo;
  outcome?: { governedOutcome: string; primaryReasonCode: string; humanReviewRequired: boolean; provisionalOutcome: string; governanceOverride: boolean; toolsCalled: string[] };
  evidenceRequest?: { evidenceRequestId: string; evidenceChannel: string; requestedItems: string[]; status: string; attemptCount: number; maxAttempts: number };
}
interface Turn { role: 'user' | 'agent'; text: string; attachments?: string[]; meta?: ChatReply; }
interface Guided { slug: string; title: string; representativeName: string; businessName: string; story: string; files: Array<{ fileName: string; type: string; note: string; path: string }>; steps: Array<{ attach: string[]; expect: string }>; }
interface Persona { slug: string; representativeName: string; businessName: string; story: string; expectedOutcome: string; documents: Array<{ type: string; fileName: string; path: string; note?: string; kind?: 'INSUFFICIENT' | 'CORRECTED' | 'OTHER' }>; }
interface CatalogRequest { id: string; label: string; stage: string; automated: boolean; query: string; }
interface Category { id: string; title: string; description: string; icon: string; requests: string[]; }
interface Catalog { stages: Array<{ id: string; name: string }>; categories: Category[]; requests: CatalogRequest[]; featuredQueries: Array<{ requestId: string; text: string }>; }

const welcome = 'Hello! I can help with your company\'s telecom requests.\n\nChoose what you need below, or just type it. To get started on adding an authorised representative, tell me **your name** and **the company you represent** — for example: "My name is Fatima Al Mansoori and I represent Al Noor Trading LLC."';
const acceptedTypes = '.pdf,.docx,.png,.jpg,.jpeg,.gif,.bmp,.webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*';
const allowedExtension = /\.(pdf|docx|png|jpe?g|gif|bmp|webp)$/i;
const maxFiles = 3;
const maxBytes = 5 * 1024 * 1024;
const size = (bytes: number): string => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const documentNames: Record<string, string> = { EMIRATES_ID: 'Emirates ID', TRADE_LICENSE: 'Trade License', ESTABLISHMENT_CARD: 'Establishment Card', POA_MOA: 'POA / MOA', ADDRESS_PROOF: 'Proof of address' };

export function ChatPage() {
  const [turns, setTurns] = useState<Turn[]>([{ role: 'agent', text: welcome }]);
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [session, setSession] = useState('');
  const [step, setStep] = useState<Step>('IDLE');
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [guided, setGuided] = useState<Guided[]>([]);
  const [catalog, setCatalog] = useState<Catalog>();
  const [openCategory, setOpenCategory] = useState('');
  const [active, setActive] = useState<RequestInfo>();
  const [request, setRequest] = useState<ChatReply['evidenceRequest']>();
  const [dragging, setDragging] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const textbox = useRef<HTMLTextAreaElement>(null);
  const awaitingRef = useRef(false);
  const initialSync = useRef(false); // React StrictMode runs effects twice in development: restore the waiting state once

  const awaitingEvidence = step === 'AWAITING_EVIDENCE';
  awaitingRef.current = awaitingEvidence;
  const fresh = turns.length <= 1;

  /** The conversation may be waiting on the server side too (e.g. a reviewer reopened the case): pick that up on load and every few seconds. */
  async function syncFromServer(initial = false) {
    try {
      const { state } = await api<{ state: ChatReply | null }>('/api/chat/state');
      if (!state || awaitingRef.current) return;
      // Only a document request can newly appear while the page is open (a reviewer reopened the case). Any other waiting state is already on screen: replaying it every few seconds repeated the same question.
      if (!initial && state.step !== 'AWAITING_EVIDENCE') return;
      setStep(state.step); setRequest(state.evidenceRequest);
      setTurns((current) => [...current, ...state.messages.map((text, index): Turn => ({ role: 'agent', text, meta: index === state.messages.length - 1 ? state : undefined }))]);
    } catch { /* offline or no session yet: nothing to sync */ }
  }
  useEffect(() => {
    void ensureSession().then((value) => setSession(value.sessionId));
    void api<{ scenarios: Persona[]; guided?: Guided[] }>('/api/scenarios').then((body) => { setPersonas(body.scenarios); setGuided(body.guided ?? []); }).catch(() => undefined);
    void api<Catalog>('/api/catalog').then(setCatalog).catch(() => undefined);
    if (!initialSync.current) { initialSync.current = true; void syncFromServer(true); }
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void syncFromServer(); }, 5000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [turns, busy]);

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

  async function send(message: string, attached: File[] = [], intent?: string) {
    if ((!message.trim() && attached.length === 0) || busy) return;
    setBusy(true); setError('');
    setTurns((current) => [...current, { role: 'user', text: message.trim(), attachments: attached.map((file) => `${file.name} (${size(file.size)})`) }]);
    try {
      let reply: ChatReply;
      if (attached.length > 0) {
        const form = new FormData();
        for (const file of attached) form.append('evidence_file', file, file.name);
        reply = await api<ChatReply>('/api/chat/evidence', { form });
      } else reply = await api<ChatReply>('/api/chat', { body: intent ? { message, intent } : { message } });
      setInput(''); setFiles([]);
      setStep(reply.step); setRequest(reply.evidenceRequest); setSession(reply.sessionId);
      if (reply.requestType) setActive(reply.requestType);
      if (reply.step === 'DONE' && reply.requestType === undefined) setActive(undefined);
      setTurns((current) => [...current, ...reply.messages.map((text, index): Turn => ({ role: 'agent', text, meta: index === reply.messages.length - 1 ? reply : undefined }))]);
    } catch (caught) {
      // A refused message stays in the box (and its files stay attached) so the customer can fix it and try again.
      setTurns((current) => current.slice(0, -1));
      setError(describeError(caught));
    } finally { setBusy(false); textbox.current?.focus(); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void send(input, files); }
  function fillPersona(persona: { representativeName: string; businessName: string }) { setInput(`My name is ${persona.representativeName} and I represent ${persona.businessName}.`); textbox.current?.focus(); }
  const choose = (entry: CatalogRequest) => void send(entry.query, [], entry.id);
  const byId = new Map((catalog?.requests ?? []).map((entry) => [entry.id, entry]));
  const canPick = !busy && !awaitingEvidence;

  const pill = awaitingEvidence ? { cls: 'wait', text: 'Waiting for your documents' } : step === 'INTAKE' ? { cls: 'live', text: 'Getting to know you' } : step === 'DONE' ? { cls: 'done', text: 'Request handled' } : { cls: '', text: 'Ready' };
  const subtitle = active ? `${active.stageName} · ${active.label}${active.automated ? '' : ' · routed, not automated yet'}` : 'Requests, documents and answers in one place';

  return (
    <section aria-labelledby="chat-title" className="page">
      <div className="page-head">
        <h2 id="chat-title">Customer assessment</h2>
        <p className="lead">Tell the assistant what you need and who you are. When documents are needed, attach them right here (PDF, Word or image files). Responses are curated business summaries; prompts, rules and raw tool output are never shown.</p>
      </div>
      <div className="workspace">
        <div>
          <div className="chat-shell">
            <div className="chat-head">
              <span className="avatar"><Icon name="spark" /></span>
              <div><h2>Assessment assistant</h2><p>{subtitle}</p></div>
              <span className={`status-pill ${pill.cls}`}>{pill.text}</span>
            </div>
            <div className={`chat${dragging ? ' chat-drop' : ''}`} role="log" aria-live="polite" aria-label="Conversation" data-testid="chat-log"
              onDragOver={(event) => { if (awaitingEvidence) { event.preventDefault(); setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
              {turns.map((turn, index) => (
                <div key={index} className={`turn turn-${turn.role}`}>
                  <span className="avatar">{turn.role === 'agent' ? <Icon name="spark" /> : <Icon name="user" />}</span>
                  <div className="bubble">
                    <div className="turn-label">{turn.role === 'user' ? 'You' : 'Assessment agent'}</div>
                    {turn.text ? <Markdown text={turn.text} /> : null}
                    {turn.attachments?.length ? <ul className="attachments">{turn.attachments.map((name) => <li key={name}><Icon name="clip" /> {name}</li>)}</ul> : null}
                    {turn.meta?.outcome ? (
                      <div className="turn-meta" data-testid="outcome-meta">
                        <div><Badge value={turn.meta.outcome.governedOutcome} /></div>
                        <span>Governed outcome · reason <code>{turn.meta.outcome.primaryReasonCode}</code>{turn.meta.caseRunId ? <> · case <code>{turn.meta.caseRunId}</code></> : null}</span>
                        {turn.meta.outcome.governanceOverride ? <span className="override">Agent recommended {turn.meta.outcome.provisionalOutcome.replaceAll('_', ' ')}; deterministic policy applied.</span> : null}
                        <span className="trace">Tools called: {turn.meta.outcome.toolsCalled.length ? turn.meta.outcome.toolsCalled.join(' → ') : 'none (resumed from persisted results)'}</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
              {fresh && catalog ? (
                <div className="hero" data-testid="intent-picker">
                  <h3>What can I help you with?</h3>
                  <p>Pick a topic, then a request — or type your own.</p>
                  <div className="cat-grid">
                    {catalog.categories.map((category) => (
                      <button key={category.id} type="button" className={`cat-card${openCategory === category.id ? ' open' : ''}`} aria-expanded={openCategory === category.id} disabled={!canPick} onClick={() => setOpenCategory(openCategory === category.id ? '' : category.id)}>
                        <span className="cat-icon"><Icon name={category.icon} /></span><strong>{category.title}</strong><span className="d">{category.description}</span>
                      </button>
                    ))}
                  </div>
                  {openCategory ? (
                    <div className="req-list" role="group" aria-label="Requests in this topic">
                      {(catalog.categories.find((category) => category.id === openCategory)?.requests ?? []).map((id) => byId.get(id)).filter((entry): entry is CatalogRequest => Boolean(entry)).map((entry) => <button key={entry.id} type="button" className="chip" disabled={!canPick} onClick={() => choose(entry)}>{entry.label}</button>)}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {busy ? <div className="turn turn-agent" aria-live="polite"><span className="avatar"><Icon name="spark" /></span><div className="bubble"><span className="typing" aria-hidden="true"><i /><i /><i /></span><span className="sr-only">Working on it…</span><p className="muted small" style={{ margin: 0 }}>{files.length ? 'Reading your documents and running the checks…' : ''}</p></div></div> : null}
              <div ref={bottom} />
            </div>

            {request && awaitingEvidence ? (
              <div className="evidence-card" data-testid="evidence-card">
                <strong>Documents needed</strong> <Badge value={request.status} /> <span className="muted small">attempt {request.attemptCount} of {request.maxAttempts}</span>
                <ul>{request.requestedItems.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
            ) : null}

            {!awaitingEvidence && catalog ? (
              <div className="suggest" data-testid="quick-queries">
                <p className="eyebrow">Try one of these</p>
                <div className="suggest-row">{catalog.featuredQueries.map((entry) => { const info = byId.get(entry.requestId); return info ? <button key={entry.requestId} type="button" className="chip" disabled={busy} onClick={() => choose(info)}>{entry.text}</button> : null; })}</div>
              </div>
            ) : null}
            {error ? <div style={{ padding: '0 1.1rem' }}><Notice tone="error">{error}</Notice></div> : null}

            <form className={`composer${dragging ? ' composer-drop' : ''}`} onSubmit={submit} data-testid="composer">
              {files.length ? (
                <ul className="file-chips" aria-label="Attached files">
                  {files.map((file) => <li key={`${file.name}-${file.size}`}><Icon name="clip" /><span>{file.name} <span className="muted">({size(file.size)})</span></span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((entry) => entry !== file))}><Icon name="x" /></button></li>)}
                </ul>
              ) : null}
              <div className="composer-row">
                {awaitingEvidence ? (
                  <>
                    <input ref={picker} type="file" multiple accept={acceptedTypes} onChange={onPick} className="sr-only" aria-label="Choose files" data-testid="file-input" tabIndex={-1} />
                    <button type="button" className="attach" onClick={() => picker.current?.click()} disabled={busy || files.length >= maxFiles} title="Attach PDF, Word or image files (up to 3, 5 MB each)"><Icon name="clip" />Attach documents</button>
                    <p className="muted small grow">Documents only — typed text is not accepted as evidence.</p>
                  </>
                ) : (
                  <>
                    <label className="sr-only" htmlFor="chat-input">Message</label>
                    <textarea id="chat-input" ref={textbox} rows={1} value={input} onChange={(event) => setInput(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(input, files); } }}
                      placeholder={step === 'INTAKE' ? 'Type your reply…' : 'Tell me what you need, your name and your company…'} maxLength={10000} />
                  </>
                )}
                <button className="primary" type="submit" disabled={busy || (awaitingEvidence ? files.length === 0 : !input.trim())}><Icon name="send" />{busy ? 'Working…' : awaitingEvidence ? 'Send documents' : 'Send'}</button>
              </div>
              {awaitingEvidence ? (
                <div className="composer-foot">
                  <span className="muted small">PDF, Word (.docx) or image files · up to {maxFiles} files, 5 MB each · you can also drag files onto the chat</span>
                  <button type="button" className="link" disabled={busy} onClick={() => void send('Cancel request')}>Cancel request</button>
                </div>
              ) : null}
            </form>
          </div>
          <p className="muted small" style={{ margin: '0.6rem 0 0' }}>Conversation session <code data-testid="session-id">{session || '…'}</code></p>
        </div>

        <aside className="rail" aria-label="Requests and demo customers">
          <div className="card">
            <h3><Icon name="layers" />What we can help with</h3>
            <p className="muted small">Every request type from the operating model. Only <strong>New authorised representative (LOA)</strong> is automated end to end; the rest are captured and routed to the team that owns them.</p>
            {catalog?.categories.map((category) => (
              <details key={category.id} className="acc">
                <summary><span className="cat-icon" style={{ width: 28, height: 28 }}><Icon name={category.icon} /></span>{category.title}</summary>
                {category.requests.map((id) => byId.get(id)).filter((entry): entry is CatalogRequest => Boolean(entry)).map((entry) => (
                  <button key={entry.id} type="button" className="rail-req" disabled={!canPick} onClick={() => choose(entry)}>{entry.label}<Badge value={entry.automated ? 'LIVE' : entry.stage === 'PROFILING' ? 'ROUTED' : 'ROUTED'} /></button>
                ))}
              </details>
            ))}
          </div>

          <details className="card demo" data-testid="guided-scenarios">
            <summary>Guided scenarios: wrong documents, then corrected ones</summary>
            <p className="muted small">Each scenario shows the assistant reading the documents, saying exactly what is wrong and asking again — a person is only involved when a document cannot be trusted. Introduce yourself as the customer, then attach the files listed for each step.</p>
            <ul className="persona-list">
              {guided.map((scenario) => (
                <li key={scenario.slug} data-testid={`guided-${scenario.slug}`}>
                  <div className="persona-head"><button type="button" className="chip" disabled={busy || awaitingEvidence} onClick={() => fillPersona(scenario)}>{scenario.representativeName} · {scenario.businessName}</button></div>
                  <p className="small"><strong>{scenario.title}</strong></p>
                  <p className="muted small">{scenario.story}</p>
                  <ol className="small guided-steps">
                    {scenario.steps.map((step, index) => (
                      <li key={index}>Attach {step.attach.map((name, position) => { const file = scenario.files.find((entry) => entry.fileName === name); return <span key={name}>{position > 0 ? ', ' : ''}{file ? <a href={file.path} download title={file.note}>{name}</a> : name}</span>; })} → <span className="muted">{step.expect}</span></li>
                    ))}
                  </ol>
                </li>
              ))}
            </ul>
          </details>
          <details className="card demo">
            <summary>Demo: synthetic customers and sample documents</summary>
            <p className="muted small">Introduce yourself as one of these people, then attach their sample documents when asked. Any company not on this list is treated as a new lead and nothing is verified or approved.</p>
            <ul className="persona-list">
              {personas.map((persona) => (
                <li key={persona.slug} data-testid={`persona-${persona.slug}`}>
                  <div className="persona-head"><button type="button" className="chip" disabled={busy || awaitingEvidence} onClick={() => fillPersona(persona)}>{persona.representativeName} · {persona.businessName}</button> <Badge value={persona.expectedOutcome === 'NEED_MORE_INFORMATION_THEN_APPROVE' ? 'NEEDS A DOCUMENT, THEN APPROVE' : persona.expectedOutcome === 'REJECT' ? 'REJECTION RECOMMENDED' : persona.expectedOutcome} /></div>
                  <p className="muted small">{persona.story}</p>
                  <ul className="doc-links small" aria-label={`Sample documents for ${persona.representativeName}`}>{persona.documents.map((document) => { const weak = document.kind === 'INSUFFICIENT' || /insufficient|expired/i.test(document.note ?? ''); return <li key={document.path}><a href={document.path} download title={document.fileName}>{document.note ?? documentNames[document.type] ?? document.type}</a>{weak ? <span className="doc-tag doc-tag-weak">test insufficient evidence</span> : document.kind === 'CORRECTED' ? <span className="doc-tag doc-tag-ok">corrected</span> : null}</li>; })}</ul>
                </li>
              ))}
            </ul>
          </details>
        </aside>
      </div>
    </section>
  );
}
