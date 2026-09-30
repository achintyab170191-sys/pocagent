import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { extractPdfText } from './pdf.js';

/**
 * Evidence document reader: PDF (text layer), Word `.docx` (body text) and images (OCR). Customer files are hostile input, so:
 *  - the type comes from the file's MAGIC BYTES, never from its name or declared MIME type;
 *  - every format has hard limits (pages, zip entries / inflated size, pixels, time, output length);
 *  - heavy parsing runs in worker threads (PDF, Word) or Tesseract's own worker (images), never on the request thread;
 *  - failures are returned as explicit codes; nothing inside a document is ever executed or obeyed — only its text is read.
 * Extension of the n8n form (which accepted only `.pdf`): docs/07 G-33.
 */
export type DocumentKind = 'pdf' | 'docx' | 'png' | 'jpeg' | 'gif' | 'bmp' | 'webp';
export const mimeByKind: Record<DocumentKind, string> = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
};
export const acceptedFileTypesHint = 'PDF, Word (.docx) or image (PNG, JPEG, GIF, BMP, WebP)';

export interface DocumentLimits {
  timeoutMs: number; maxChars: number; maxPdfPages: number; maxZipEntries: number; maxInflatedBytes: number; maxImagePixels: number; maxImageSide: number; minOcrConfidence: number;
}
export const defaultDocumentLimits: DocumentLimits = { timeoutMs: 20_000, maxChars: 200_000, maxPdfPages: 50, maxZipEntries: 2_000, maxInflatedBytes: 50 * 1024 * 1024, maxImagePixels: 16_000_000, maxImageSide: 10_000, minOcrConfidence: 35 };

export type SniffResult = { kind: DocumentKind } | { rejected: 'LEGACY_WORD' | 'UNSUPPORTED' };

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0): boolean => signature.every((value, index) => bytes[offset + index] === value);
const ascii = (bytes: Uint8Array, start: number, end: number): string => Buffer.from(bytes.subarray(start, end)).toString('latin1');

interface ZipDirectory { names: string[]; inflatedBytes: number; }
/** Reads the zip central directory only (no inflation). Returns undefined for anything malformed, zip64, or over the entry limit. */
export function readZipDirectory(bytes: Uint8Array, maxEntries: number): ZipDirectory | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 22 - 65_535); index -= 1) if (view.getUint32(index, true) === 0x06054b50) { end = index; break; }
  if (end < 0) return undefined;
  const entries = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (entries === 0xffff || offset === 0xffffffff || entries > maxEntries) return undefined;
  const names: string[] = [];
  let inflated = 0;
  for (let entry = 0; entry < entries; entry += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) return undefined;
    const size = view.getUint32(offset + 24, true);
    if (size === 0xffffffff) return undefined;
    inflated += size;
    const nameLength = view.getUint16(offset + 28, true);
    names.push(ascii(bytes, offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return { names, inflatedBytes: inflated };
}

export function sniffDocument(bytes: Uint8Array, limits: DocumentLimits = defaultDocumentLimits): SniffResult {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: 'pdf' };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'png' };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: 'jpeg' };
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return { kind: 'gif' };
  if (startsWith(bytes, [0x42, 0x4d])) return { kind: 'bmp' };
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return { kind: 'webp' };
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { rejected: 'LEGACY_WORD' };
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const directory = readZipDirectory(bytes, limits.maxZipEntries);
    return directory && directory.names.includes('word/document.xml') && directory.names.includes('[Content_Types].xml') ? { kind: 'docx' } : { rejected: 'UNSUPPORTED' };
  }
  return { rejected: 'UNSUPPORTED' };
}

/** Pixel dimensions from the image header, or undefined when the header is unreadable. */
export function imageDimensions(bytes: Uint8Array, kind: DocumentKind): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (kind === 'png') return { width: view.getUint32(16), height: view.getUint32(20) };
    if (kind === 'gif') return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    if (kind === 'bmp') return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
    if (kind === 'webp') {
      const chunk = ascii(bytes, 12, 16);
      if (chunk === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
      if (chunk === 'VP8L') { const bits = view.getUint32(21, true); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
      if (chunk === 'VP8X') return { width: (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16)) + 1, height: (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16)) + 1 };
      return undefined;
    }
    if (kind === 'jpeg') {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (view.getUint8(offset) !== 0xff) return undefined;
        const marker = view.getUint8(offset + 1);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
        offset += 2 + view.getUint16(offset + 2);
      }
    }
  } catch { return undefined; }
  return undefined;
}

export type ExtractionError = 'DOCUMENT_TOO_COMPLEX' | 'DOCUMENT_TEXT_UNAVAILABLE';
export interface ExtractedDocument { kind: DocumentKind; mimeType: string; text: string; error?: ExtractionError; detail?: string; }

const DOCX_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const mammoth = require(workerData.mammoth);
  const result = await mammoth.extractRawText({ buffer: Buffer.from(workerData.bytes) });
  parentPort.postMessage({ text: String(result.value).slice(0, workerData.maxChars) });
})().catch((error) => parentPort.postMessage({ error: 'UNREADABLE', detail: String((error && error.message) || error).slice(0, 120) }));
`;

function extractDocx(bytes: Uint8Array, limits: DocumentLimits): Promise<{ text: string; error?: ExtractionError; detail?: string }> {
  const directory = readZipDirectory(bytes, limits.maxZipEntries);
  if (!directory || directory.inflatedBytes > limits.maxInflatedBytes) return Promise.resolve({ text: '', error: 'DOCUMENT_TOO_COMPLEX', detail: 'archive limits' });
  const mammoth = createRequire(import.meta.url).resolve('mammoth');
  return new Promise((resolve) => {
    const worker = new Worker(DOCX_WORKER, { eval: true, workerData: { bytes: new Uint8Array(bytes), mammoth, maxChars: limits.maxChars }, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } });
    let settled = false;
    const finish = (value: { text: string; error?: ExtractionError; detail?: string }): void => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); resolve(value); };
    const timer = setTimeout(() => finish({ text: '', error: 'DOCUMENT_TOO_COMPLEX', detail: 'timeout' }), limits.timeoutMs);
    worker.once('message', (message: { text?: string; error?: string; detail?: string }) => finish(message.error ? { text: '', error: 'DOCUMENT_TEXT_UNAVAILABLE', detail: message.detail } : { text: (message.text ?? '').trim() }));
    worker.once('error', (error) => finish({ text: '', error: /memory|heap/i.test(String(error?.message)) ? 'DOCUMENT_TOO_COMPLEX' : 'DOCUMENT_TEXT_UNAVAILABLE', detail: String(error?.message ?? '').slice(0, 120) }));
    worker.once('exit', () => finish({ text: '', error: 'DOCUMENT_TEXT_UNAVAILABLE', detail: 'worker exited' }));
  });
}

// At most two OCR runs at once: each holds a WebAssembly engine and a decoded bitmap.
let ocrRunning = 0;
const ocrQueue: Array<() => void> = [];
async function withOcrSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (ocrRunning >= 2) await new Promise<void>((release) => ocrQueue.push(release));
  ocrRunning += 1;
  try { return await operation(); } finally { ocrRunning -= 1; ocrQueue.shift()?.(); }
}

async function extractImage(bytes: Uint8Array, kind: DocumentKind, limits: DocumentLimits): Promise<{ text: string; error?: ExtractionError; detail?: string }> {
  const size = imageDimensions(bytes, kind);
  if (!size || size.width < 1 || size.height < 1) return { text: '', error: 'DOCUMENT_TEXT_UNAVAILABLE', detail: 'unreadable image header' };
  if (size.width * size.height > limits.maxImagePixels || size.width > limits.maxImageSide || size.height > limits.maxImageSide) return { text: '', error: 'DOCUMENT_TOO_COMPLEX', detail: 'image dimensions' };
  return withOcrSlot(async () => {
    const { createWorker } = await import('tesseract.js');
    // English data ships in @tesseract.js-data/eng: OCR works offline with no download at runtime.
    const langPath = join(dirname(createRequire(import.meta.url).resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
    const worker = await createWorker('eng', 1, { langPath, cacheMethod: 'none', gzip: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        worker.recognize(Buffer.from(bytes)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('OCR_TIMEOUT')), limits.timeoutMs); }),
      ]);
      const text = result.data.text.replace(/\s+\n/g, '\n').trim().slice(0, limits.maxChars);
      // A photo with no legible text yields low-confidence noise; do not hand noise to the evidence assessor as if it were a document.
      if (result.data.confidence < limits.minOcrConfidence) return { text: '', error: 'DOCUMENT_TEXT_UNAVAILABLE', detail: 'no legible text' };
      return { text };
    } catch (error) {
      return { text: '', error: error instanceof Error && error.message === 'OCR_TIMEOUT' ? 'DOCUMENT_TOO_COMPLEX' : 'DOCUMENT_TEXT_UNAVAILABLE', detail: error instanceof Error ? error.message.slice(0, 120) : 'ocr failed' };
    } finally { if (timer) clearTimeout(timer); await worker.terminate().catch(() => undefined); }
  });
}

/** Throws `UNSUPPORTED_FILE_TYPE` (or `LEGACY_WORD_NOT_SUPPORTED`); everything else is reported through `error`. */
export async function extractDocumentText(bytes: Uint8Array, overrides: Partial<DocumentLimits> = {}): Promise<ExtractedDocument> {
  const limits = { ...defaultDocumentLimits, ...overrides };
  const sniffed = sniffDocument(bytes, limits);
  if ('rejected' in sniffed) throw new Error(sniffed.rejected === 'LEGACY_WORD' ? 'LEGACY_WORD_NOT_SUPPORTED' : 'UNSUPPORTED_FILE_TYPE');
  const { kind } = sniffed;
  const base = { kind, mimeType: mimeByKind[kind] };
  if (kind === 'pdf') {
    const pdf = await extractPdfText(bytes, { maxPages: limits.maxPdfPages, timeoutMs: limits.timeoutMs, maxChars: limits.maxChars });
    return pdf.error ? { ...base, text: '', error: pdf.error === 'PDF_TOO_COMPLEX' ? 'DOCUMENT_TOO_COMPLEX' : 'DOCUMENT_TEXT_UNAVAILABLE', detail: pdf.detail } : { ...base, text: pdf.text };
  }
  const result = kind === 'docx' ? await extractDocx(bytes, limits) : await extractImage(bytes, kind, limits);
  return { ...base, ...result };
}
