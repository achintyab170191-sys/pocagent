import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp } from '../apps/api/src/app.js';
import { extractDocumentText, sniffDocument } from '../apps/api/src/documents.js';
import { insufficient, makePdf, newStore, resolved, ScriptedRuntime } from '@sbo/testkit';

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

const letter = 'Signed authority letter: Liam Chen may manage the account, order services, approve plan changes and sign telecom commitments.';
const png = readFileSync(join(__dirname, 'fixtures', 'authority-letter.png'));
const blankPng = readFileSync(join(__dirname, 'fixtures', 'blank-photo.png'));

async function makeDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function start(runtime = new ScriptedRuntime()) {
  const uploadDirectory = mkdtempSync(join(tmpdir(), 'sbo-att-'));
  const store = newStore();
  const app = await buildApp({ repository: store, agentRuntime: runtime, config: { appBaseUrl: 'http://localhost:5173', sessionSecret: 'a-test-secret-that-is-at-least-32-chars-long', uploadDirectory } });
  apps.push(app);
  const session = await app.inject({ method: 'GET', url: '/api/session' });
  const { csrfToken } = session.json() as { csrfToken: string };
  const cookie = session.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ');
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as never, headers: { cookie, 'x-csrf-token': csrfToken } });
  const attach = (message: string, files: Array<{ name: string; type: string; content: Buffer }>) => {
    const boundary = '----sbo-att-boundary';
    const parts: Buffer[] = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n${message}\r\n`)];
    for (const file of files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="evidence_file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.content, Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return app.inject({ method: 'POST', url: '/api/chat/evidence', payload: Buffer.concat(parts), headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  };
  return { store, uploadDirectory, post, attach, runtime };
}

describe('document reading (PDF, Word, images)', () => {
  it('sniffs by magic bytes, never by name or declared type', async () => {
    expect(sniffDocument(makePdf(letter))).toEqual({ kind: 'pdf' });
    expect(sniffDocument(await makeDocx(letter))).toEqual({ kind: 'docx' });
    expect(sniffDocument(png)).toEqual({ kind: 'png' });
    expect(sniffDocument(Buffer.from('MZ\u0090\u0000 executable bytes here'))).toEqual({ rejected: 'UNSUPPORTED' });
    expect(sniffDocument(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]))).toEqual({ rejected: 'LEGACY_WORD' });
  });
  it('extracts text from PDF, DOCX and an image (OCR)', async () => {
    expect((await extractDocumentText(makePdf(letter))).text).toContain('Liam Chen');
    expect((await extractDocumentText(await makeDocx(letter))).text).toContain('Liam Chen');
    const image = await extractDocumentText(png);
    expect(image.error).toBeUndefined();
    expect(image.text.length).toBeGreaterThan(20);
  }, 60_000);
  it('a photo with no readable text yields DOCUMENT_TEXT_UNAVAILABLE', async () => {
    expect(await extractDocumentText(blankPng)).toMatchObject({ error: 'DOCUMENT_TEXT_UNAVAILABLE' });
  }, 60_000);
});

describe('POST /api/chat/evidence (attachments in the chat window)', () => {
  it('several files of different formats are stored, assessed together, and the case resumes', async () => {
    const ctx = await start(new ScriptedRuntime([resolved]));
    const first = (await ctx.post('/api/chat', { message: 'Evaluate AUTH-002' })).json();
    const response = await ctx.attach('', [
      { name: 'letter.pdf', type: 'application/pdf', content: makePdf(letter) },
      { name: 'letter.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: await makeDocx(letter) },
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.json().messages[0]).toContain('Thank you. The additional evidence has resolved the identified gap.');
    const rows = await ctx.store.getEvidence(first.evidenceRequest.evidenceRequestId);
    expect(rows.map((row) => row.mimeType).sort()).toEqual(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
    expect(readdirSync(ctx.uploadDirectory)).toHaveLength(2);
    expect(response.body).not.toContain(letter);
  });

  it('an unreadable file is refused with nothing stored, the request stays open and can be retried in the same chat', async () => {
    const ctx = await start(new ScriptedRuntime([resolved]));
    const first = (await ctx.post('/api/chat', { message: 'Evaluate AUTH-002' })).json();
    const bad = await ctx.attach('', [{ name: 'photo.png', type: 'image/png', content: blankPng }]);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('DOCUMENT_TEXT_UNAVAILABLE');
    expect(await ctx.store.getEvidence(first.evidenceRequest.evidenceRequestId)).toEqual([]);
    expect(readdirSync(ctx.uploadDirectory)).toEqual([]);
    const good = await ctx.attach('', [{ name: 'letter.pdf', type: 'application/pdf', content: makePdf(letter) }]);
    expect(good.statusCode).toBe(200);
  }, 60_000);

  it('rejects executables, legacy .doc files, and a request with no pending evidence', async () => {
    const ctx = await start();
    expect((await ctx.attach('x', [{ name: 'a.pdf', type: 'application/pdf', content: makePdf(letter) }])).json().error).toBe('NO_EVIDENCE_REQUEST_PENDING');
    await ctx.post('/api/chat', { message: 'Evaluate AUTH-002' });
    const exe = await ctx.attach('', [{ name: 'evil.pdf', type: 'application/pdf', content: Buffer.from('MZ\u0090\u0000 not a pdf at all, just some bytes here') }]);
    expect(exe.json().error).toBe('UNSUPPORTED_FILE_TYPE');
    const doc = await ctx.attach('', [{ name: 'old.doc', type: 'application/msword', content: Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]) }]);
    expect(doc.json().error).toBe('LEGACY_WORD_NOT_SUPPORTED');
    expect(readdirSync(ctx.uploadDirectory)).toEqual([]);
  });

  it('insufficient files keep the same prompt open: upload again is possible', async () => {
    const ctx = await start(new ScriptedRuntime([insufficient, resolved]));
    await ctx.post('/api/chat', { message: 'Evaluate AUTH-002' });
    const one = (await ctx.attach('', [{ name: 'a.pdf', type: 'application/pdf', content: makePdf(letter) }])).json();
    expect(one).toMatchObject({ step: 'AWAITING_EVIDENCE', evidenceRequest: { attemptCount: 1 } });
    expect(one.messages.join('\n')).not.toMatch(/upload link|\/upload/i);
    const two = (await ctx.attach('', [{ name: 'b.pdf', type: 'application/pdf', content: makePdf(letter) }])).json();
    expect(two.messages[0]).toContain('Thank you. The additional evidence has resolved the identified gap.');
  });

  it('a new customer can introduce themselves over HTTP', async () => {
    const ctx = await start();
    const body = (await ctx.post('/api/chat', { message: 'My name is Hana Rangi and I represent Kauri Harbour Demo Digital Limited' })).json();
    expect(body.caseRunId).toMatch(/^AUTH-1\d\d$/);
    expect(body.messages[0]).toContain('opened case');
  });
});
