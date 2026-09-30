import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { classifyDocument, documentText, personas } from '@sbo/domain';
import { buildApp } from '../apps/api/src/app.js';
import { extractDocumentText, sniffDocument } from '../apps/api/src/documents.js';
import { makePdf, newStore, ScriptedRuntime } from '@sbo/testkit';

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

const ocrFixture = readFileSync(join(__dirname, 'fixtures', 'authority-letter.png'));
const blankPng = readFileSync(join(__dirname, 'fixtures', 'blank-photo.png'));
const wordType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** A real .docx: one paragraph per line, as Word would write it. */
async function makeDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  const escape = (line: string): string => line.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text.split('\n').map((line) => `<w:p><w:r><w:t>${escape(line)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function start() {
  const uploadDirectory = mkdtempSync(join(tmpdir(), 'sbo-att-'));
  const store = newStore();
  const app = await buildApp({ repository: store, agentRuntime: new ScriptedRuntime(), config: { appBaseUrl: 'http://localhost:5173', sessionSecret: 'a-test-secret-that-is-at-least-32-chars-long', uploadDirectory } });
  apps.push(app);
  const session = await app.inject({ method: 'GET', url: '/api/session' });
  const { csrfToken } = session.json() as { csrfToken: string };
  const cookie = session.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ');
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as never, headers: { cookie, 'x-csrf-token': csrfToken } });
  const attach = (files: Array<{ name: string; type: string; content: Buffer }>) => {
    const boundary = '----sbo-att-boundary';
    const parts: Buffer[] = [];
    for (const file of files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="evidence_file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.content, Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return app.inject({ method: 'POST', url: '/api/chat/evidence', payload: Buffer.concat(parts), headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  };
  return { store, uploadDirectory, post, attach };
}

describe('the generated sample documents (apps/web/public/samples) are readable by the real extractor and recognised', () => {
  const samples = personas.flatMap((persona) => persona.documents.map((document) => ({ persona, document, path: join('apps', 'web', 'public', 'samples', persona.slug, document.fileName) })));
  it('every persona document exists on disk (run `npm run samples` after changing personas)', () => {
    expect(samples.length).toBeGreaterThan(20);
    for (const sample of samples) expect(existsSync(sample.path), sample.path).toBe(true);
  });
  it.each(samples.map((sample) => ({ name: `${sample.persona.slug}/${sample.document.fileName}`, sample })))('$name is read and recognised', async ({ sample }) => {
    const extracted = await extractDocumentText(readFileSync(sample.path));
    expect(extracted.error).toBeUndefined();
    const classified = classifyDocument(extracted.text);
    expect(classified?.documentType).toBe(sample.document.type);
    for (const [key, value] of Object.entries(sample.document.fields)) if (value !== undefined && value !== '') expect(classified?.fields[key], key).toEqual(value);
  });
});

describe('document reading (PDF, Word, images)', () => {
  it('sniffs by magic bytes, never by name or declared type', async () => {
    expect(sniffDocument(makePdf('x'.repeat(40)))).toEqual({ kind: 'pdf' });
    expect(sniffDocument(await makeDocx('x'.repeat(40)))).toEqual({ kind: 'docx' });
    expect(sniffDocument(ocrFixture)).toEqual({ kind: 'png' });
    expect(sniffDocument(Buffer.from('MZ\u0090\u0000 executable bytes here'))).toEqual({ rejected: 'UNSUPPORTED' });
    expect(sniffDocument(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]))).toEqual({ rejected: 'LEGACY_WORD' });
  });

  it('a Word document reads back the same fields as the PDF of the same document', async () => {
    for (const document of personas[0]!.documents) {
      const fromWord = await extractDocumentText(await makeDocx(documentText(document)));
      expect(fromWord.error).toBeUndefined();
      expect(classifyDocument(fromWord.text)?.documentType).toBe(document.type);
      expect(classifyDocument(fromWord.text)?.fields).toEqual(classifyDocument(documentText(document))?.fields);
    }
  });

  it('an image is read with offline OCR; a photo with no text is DOCUMENT_TEXT_UNAVAILABLE', async () => {
    const image = await extractDocumentText(ocrFixture);
    expect(image.error).toBeUndefined();
    expect(image.text.length).toBeGreaterThan(20);
    expect(await extractDocumentText(blankPng)).toMatchObject({ error: 'DOCUMENT_TEXT_UNAVAILABLE' });
  }, 60_000);
});

describe('POST /api/chat/evidence (attachments in the chat window)', () => {
  const intro = { message: 'My name is Fatima Al Mansoori and I represent Al Noor Trading LLC' };
  const fatima = () => personas.find((persona) => persona.slug === 'fatima-al-noor')!.documents;

  it('documents in different formats (a Word file and two PDFs) are accepted together, stored, assessed and approved', async () => {
    const ctx = await start();
    const opened = (await ctx.post('/api/chat', intro)).json();
    const [eid, licence, card] = fatima();
    const response = await ctx.attach([
      { name: 'emirates-id.docx', type: wordType, content: await makeDocx(documentText(eid!)) },
      { name: 'trade-license.pdf', type: 'application/pdf', content: makePdf(documentText(licence!)) },
      { name: 'establishment-card.pdf', type: 'application/pdf', content: makePdf(documentText(card!)) },
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ step: 'DONE', outcome: { governedOutcome: 'APPROVE' } });
    const rows = await ctx.store.getEvidence(opened.evidenceRequest.evidenceRequestId);
    expect(rows.map((row) => row.mimeType).sort()).toEqual(['application/pdf', 'application/pdf', wordType]);
    expect(rows.map((row) => row.evidenceType).sort()).toEqual(['EMIRATES_ID', 'ESTABLISHMENT_CARD', 'TRADE_LICENSE']);
    expect(readdirSync(ctx.uploadDirectory)).toHaveLength(3);
  });

  it('a photo of an unrelated page, or of nothing, is refused with a clear code, nothing is stored, and the request stays open for a retry', async () => {
    const ctx = await start();
    const opened = (await ctx.post('/api/chat', intro)).json();
    const unrelated = await ctx.attach([{ name: 'letter.png', type: 'image/png', content: ocrFixture }]);
    expect(unrelated.statusCode).toBe(400);
    expect(unrelated.json()).toEqual({ error: 'DOCUMENT_TYPE_NOT_RECOGNISED', detail: 'letter.png' });
    const blank = await ctx.attach([{ name: 'photo.png', type: 'image/png', content: blankPng }]);
    expect(blank.json().error).toBe('DOCUMENT_TEXT_UNAVAILABLE');
    expect(await ctx.store.getEvidence(opened.evidenceRequest.evidenceRequestId)).toEqual([]);
    expect(readdirSync(ctx.uploadDirectory)).toEqual([]);
    const [eid, licence, card] = fatima();
    const good = await ctx.attach([eid!, licence!, card!].map((document) => ({ name: document.fileName, type: 'application/pdf', content: makePdf(documentText(document)) })));
    expect(good.statusCode).toBe(200);
  }, 60_000);

  it('rejects executables and legacy .doc files', async () => {
    const ctx = await start();
    await ctx.post('/api/chat', intro);
    const exe = await ctx.attach([{ name: 'evil.pdf', type: 'application/pdf', content: Buffer.from('MZ\u0090\u0000 not a pdf at all, just some bytes here') }]);
    expect(exe.json().error).toBe('UNSUPPORTED_FILE_TYPE');
    const doc = await ctx.attach([{ name: 'old.doc', type: 'application/msword', content: Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]) }]);
    expect(doc.json().error).toBe('LEGACY_WORD_NOT_SUPPORTED');
    expect(readdirSync(ctx.uploadDirectory)).toEqual([]);
  });

  it('re-upload is always possible: a missing document is asked for again in the same chat until the set is complete', async () => {
    const ctx = await start();
    await ctx.post('/api/chat', intro);
    const [eid, licence, card] = fatima();
    const pdf = (document: NonNullable<typeof eid>) => ({ name: document.fileName, type: 'application/pdf', content: makePdf(documentText(document)) });
    const one = (await ctx.attach([pdf(eid!), pdf(licence!)])).json();
    expect(one).toMatchObject({ step: 'AWAITING_EVIDENCE', evidenceRequest: { status: 'INSUFFICIENT', attemptCount: 1 } });
    expect(one.messages[0]).toContain('Establishment Card of the business is still needed');
    expect(one.messages.join('\n')).not.toMatch(/upload link|\/upload/i);
    const two = (await ctx.attach([pdf(card!)])).json();
    expect(two).toMatchObject({ step: 'DONE', outcome: { governedOutcome: 'APPROVE' } });
  });
});
