import { Worker } from 'node:worker_threads';

/**
 * Text extraction for text-based PDFs (Workflow 96 "Extract PDF Text" + "Check Extracted PDF").
 *
 * Uses unpdf (a maintained pdf.js build). The source's n8n Extract From File node is replaced because pdf-parse@1.x (pdf.js 1.10) throws
 * "bad XRef entry" on every PDF under Node 24 — a platform constraint, not a behaviour change.
 *
 * Hardening (security review SEC-01): pdf.js is CPU- and memory-hungry on hostile input (a 2 MB PDF with 20,000 empty pages blocked the
 * event loop for ~69 s; a 50 KB flate bomb inflates ~1000:1). Parsing therefore runs in a worker thread with a hard timeout, a JS-heap cap,
 * a page-count pre-check on the raw bytes, and an output cap. A timeout or limit hit is reported as an explicit extraction error, never thrown.
 * Content is only ever read as text; nothing inside the file is executed.
 */
export interface PdfExtraction { text: string; error?: 'PDF_TOO_COMPLEX' | 'PDF_UNREADABLE'; detail?: string; }
export interface PdfLimits { timeoutMs: number; maxPages: number; maxChars: number; maxHeapMb: number; }
export const defaultPdfLimits: PdfLimits = { timeoutMs: 8_000, maxPages: 50, maxChars: 200_000, maxHeapMb: 256 };

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { extractText, getDocumentProxy } = await import(workerData.unpdf);
  const document = await getDocumentProxy(new Uint8Array(workerData.bytes));
  if (document.numPages > workerData.maxPages) { parentPort.postMessage({ error: 'PDF_TOO_COMPLEX', detail: 'page limit' }); return; }
  const result = await extractText(document, { mergePages: true });
  parentPort.postMessage({ text: String(result.text).slice(0, workerData.maxChars) });
})().catch((error) => parentPort.postMessage({ error: 'PDF_UNREADABLE', detail: String((error && error.message) || error).slice(0, 120) }));
`;

function unpdfSpecifier(): string {
  try { return import.meta.resolve('unpdf'); } catch { return 'unpdf'; }
}

/** Cheap structural pre-check: refuse page trees that declare more pages than allowed before any real parsing happens. */
export function declaredPageCount(bytes: Uint8Array): number {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  let max = 0;
  for (const match of text.matchAll(/\/Count\s+(\d{1,9})/g)) max = Math.max(max, Number(match[1]));
  return max;
}

export async function extractPdfText(bytes: Uint8Array, overrides: Partial<PdfLimits> = {}): Promise<PdfExtraction> {
  const limits = { ...defaultPdfLimits, ...overrides };
  if (declaredPageCount(bytes) > limits.maxPages) return { text: '', error: 'PDF_TOO_COMPLEX', detail: 'declared page count' };
  return new Promise<PdfExtraction>((resolve) => {
    // The worker receives a private copy: pdf.js may detach the buffer it is given.
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { bytes: new Uint8Array(bytes), unpdf: unpdfSpecifier(), maxPages: limits.maxPages, maxChars: limits.maxChars }, resourceLimits: { maxOldGenerationSizeMb: limits.maxHeapMb, maxYoungGenerationSizeMb: 32 } });
    let settled = false;
    const finish = (value: PdfExtraction): void => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); resolve(value); };
    const timer = setTimeout(() => finish({ text: '', error: 'PDF_TOO_COMPLEX', detail: 'timeout' }), limits.timeoutMs);
    worker.once('message', (message: { text?: string; error?: PdfExtraction['error']; detail?: string }) => finish(message.error ? { text: '', error: message.error, detail: message.detail } : { text: (message.text ?? '').trim() }));
    worker.once('error', (error) => finish({ text: '', error: /memory|heap/i.test(String(error?.message)) ? 'PDF_TOO_COMPLEX' : 'PDF_UNREADABLE', detail: String(error?.message ?? '').slice(0, 120) }));
    worker.once('exit', () => finish({ text: '', error: 'PDF_UNREADABLE', detail: 'worker exited' }));
  });
}
