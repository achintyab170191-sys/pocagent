import { DeterministicAgentRuntime, type AgentRuntime, type SuperAgentContext, type SuperAgentRun, type UtilityToolbox } from '@sbo/agent-runtime';
import { type Persona, documentText, personas } from '@sbo/domain';
import { InMemoryRepository, type Repository } from '@sbo/persistence';
import { handleChatMessage, resolveEvidence, submitDocumentEvidence } from '@sbo/workflows';

/** A clean in-memory runtime store: the To-Be process keeps its registers and rules in @sbo/domain, so there is nothing to load. */
export function newStore(): InMemoryRepository {
  return new InMemoryRepository();
}

/**
 * Builds a minimal valid text-based PDF (Helvetica). Lines are separated by newlines, so a document can carry one field per line,
 * and the PDF text extractor can be exercised without binary fixtures.
 */
export function makePdf(text: string): Buffer {
  const escape = (line: string): string => line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const lines = text.split('\n').map(escape);
  const stream = `BT /F1 11 Tf 14 TL 56 740 Td ${lines.map((line) => `(${line}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

export function persona(slug: string): Persona {
  const found = personas.find((entry) => entry.slug === slug);
  if (!found) throw new Error(`Unknown persona ${slug}`);
  return found;
}

/** The persona's sample documents as attachments (already text-extracted), plus the PDF bytes for API uploads. */
export function personaAttachments(slug: string, only?: string[]): Array<{ fileName: string; mimeType: string; storageUrl: string; extractedText: string; bytes: Buffer; type: string }> {
  return persona(slug).documents.filter((document) => !only || only.includes(document.type)).map((document) => {
    const extractedText = documentText(document);
    return { fileName: document.fileName, mimeType: 'application/pdf', storageUrl: `test-${slug}-${document.fileName}`, extractedText, bytes: makePdf(extractedText), type: document.type };
  });
}

/**
 * Test agent: runs the governed sequence deterministically. It records every tool call so tests can assert exact call sequences.
 */
export class ScriptedRuntime implements AgentRuntime {
  public readonly refusedCalls: string[] = [];
  private readonly inner = new DeterministicAgentRuntime();
  public constructor(private readonly superAgent?: (context: SuperAgentContext, toolbox: UtilityToolbox) => Promise<SuperAgentRun>) {}
  public async runSuperAgent(context: SuperAgentContext, toolbox: UtilityToolbox): Promise<SuperAgentRun> {
    if (this.superAgent) return this.superAgent(context, toolbox);
    return this.inner.runSuperAgent(context, toolbox);
  }
}

/**
 * A case whose intake documents are recorded and accepted (the document request is resolved) but which has NOT been assessed yet: the state
 * SBO.02 starts from. `types` selects which of the persona's sample documents are attached.
 */
export async function caseWithDocuments<R extends Repository = InMemoryRepository>(slug: string, types: string[] = ['EMIRATES_ID', 'TRADE_LICENSE', 'ESTABLISHMENT_CARD'], store: R = newStore() as unknown as R): Promise<{ store: R; caseRunId: string; sessionId: string }> {
  const sessionId = `s-${slug}`;
  const opened = await handleChatMessage({ repository: store, agentRuntime: new ScriptedRuntime(), appBaseUrl: 'http://localhost:5173' }, { sessionId, message: `My name is ${persona(slug).representativeName} and I represent ${persona(slug).businessName}` });
  const requestId = opened.evidenceRequest!.evidenceRequestId;
  for (const file of personaAttachments(slug, types)) await submitDocumentEvidence(store, requestId, { fileName: file.fileName, mimeType: file.mimeType, storageUrl: file.storageUrl, extractedText: file.extractedText, allowReceived: true });
  await resolveEvidence(store, requestId, opened.caseRunId, 1);
  return { store, caseRunId: opened.caseRunId, sessionId };
}