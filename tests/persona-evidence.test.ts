import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyDocument, documentText, personas, scenarioReferenceDate, type Persona, type PersonaVariant } from '@sbo/domain';
import { handleChatEvidenceUpload, handleChatMessage, listScenarios } from '@sbo/workflows';
import { newStore, personaAttachments, ScriptedRuntime } from '@sbo/testkit';
import { extractDocumentText } from '../apps/api/src/documents.js';

const samples = join('apps', 'web', 'public', 'samples');
const intakeTypes = ['EMIRATES_ID', 'TRADE_LICENSE', 'ESTABLISHMENT_CARD'];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(`${scenarioReferenceDate}T09:00:00Z`)); });
afterEach(() => { vi.useRealTimers(); });

const textOf = async (persona: Persona, fileName: string, text?: string): Promise<string> => text ?? (await extractDocumentText(readFileSync(join(samples, persona.slug, fileName)))).text;
const weakDocument = (persona: Persona): { fileName: string; text?: string } | undefined => {
  const variant = persona.variants?.find((entry) => entry.kind === 'INSUFFICIENT');
  if (variant) return variant;
  const own = persona.documents.find((entry) => entry.type === 'POA_MOA' && /insufficient|expired/i.test(entry.note ?? ''));
  return own ? { fileName: own.fileName, text: own.text } : undefined;
};
const correctedDocument = (persona: Persona): { fileName: string; text?: string } | undefined => {
  const variant = persona.variants?.find((entry): entry is PersonaVariant => entry.kind === 'CORRECTED');
  if (variant) return variant;
  const own = persona.documents.find((entry) => entry.type === 'POA_MOA' && !/insufficient|expired/i.test(entry.note ?? ''));
  return own ? { fileName: own.fileName, text: own.text ?? documentText(own) } : undefined;
};

describe('the demo personas offer the documents to test insufficient evidence with', () => {
  it('every persona sample file (documents and variants) exists and is read as the type it claims to be', async () => {
    for (const persona of personas) {
      for (const file of [...persona.documents, ...(persona.variants ?? [])]) {
        expect(existsSync(join(samples, persona.slug, file.fileName)), `${persona.slug}/${file.fileName}`).toBe(true);
        expect(classifyDocument(await textOf(persona, file.fileName))?.documentType, `${persona.slug}/${file.fileName}`).toBe(file.type);
      }
    }
  }, 180_000);

  it('the demo list labels each authority document (insufficient / corrected) instead of listing look-alike files', () => {
    const liam = listScenarios().find((entry) => entry.slug === 'n8n-liam-chen-bluegum-vector')!;
    const letters = liam.documents.filter((entry) => entry.type === 'POA_MOA');
    expect(letters.map((entry) => entry.fileName)).toEqual(['authority-letter-v1.pdf', 'authority-letter-v2.pdf']);
    expect(letters[0]!.note).toContain('insufficient evidence');
    expect(letters[1]).toMatchObject({ kind: 'CORRECTED' });
    expect(letters[1]!.note).toContain('accepted');
    const marcus = listScenarios().find((entry) => entry.slug === 'n8n-marcus-lee-harbour-quartz')!;
    expect(marcus.documents.filter((entry) => entry.type === 'POA_MOA').map((entry) => entry.fileName)).toEqual(['authority-letter-v1.pdf', 'authority-letter.pdf']); // n8n AUTH-008: V1 (insufficient) then V2
    const hessa = listScenarios().find((entry) => entry.slug === 'hessa-al-noor')!;
    expect(hessa.documents.filter((entry) => entry.type === 'POA_MOA').map((entry) => entry.note)).toEqual([expect.stringContaining('expired'), expect.stringContaining('current')]);
  });

  const testable = personas.filter((persona) => weakDocument(persona) && correctedDocument(persona));
  it('covers every persona whose journey reaches the authority check', () => {
    expect(testable.map((persona) => persona.slug)).toEqual(expect.arrayContaining(['omar-gulf-horizon', 'hessa-al-noor', 'ahmed-gulf-horizon', 'n8n-liam-chen-bluegum-vector', 'n8n-marcus-lee-harbour-quartz', 'n8n-emma-wilson-wattle-ridge', 'n8n-noah-patel-coral-grid', 'n8n-aroha-kingi-fernline-demo', 'n8n-jack-morgan-red-earth', 'n8n-hana-rangi-kauri-harbour', 'achintya-bluegum-vector']));
  });

  it.each(testable.map((persona) => [persona.slug, persona] as const))('%s: the insufficient document is read and explained, then the corrected one moves the case on', async (_slug, persona) => {
    const store = newStore();
    const deps = { repository: store, agentRuntime: new ScriptedRuntime(), appBaseUrl: 'x' };
    await handleChatMessage(deps, { sessionId: 's', message: `My name is ${persona.representativeName} and I represent ${persona.businessName}.` });
    const opened = await handleChatEvidenceUpload(deps, { sessionId: 's', files: personaAttachments(persona.slug, intakeTypes) });
    expect(opened.outcome, 'the authority document is asked for').toMatchObject({ governedOutcome: 'NEED_MORE_INFORMATION', primaryReasonCode: 'POA_MOA_MISSING' });
    const weak = weakDocument(persona)!; const good = correctedDocument(persona)!;
    const file = async (entry: { fileName: string; text?: string }) => ({ fileName: entry.fileName, mimeType: 'application/pdf', storageUrl: 'x', extractedText: await textOf(persona, entry.fileName, entry.text) });
    const insufficient = await handleChatEvidenceUpload(deps, { sessionId: 's', files: [await file(weak)] });
    expect(insufficient.step).toBe('AWAITING_EVIDENCE');
    expect(insufficient.outcome, 'no decision, no rejection: the request stays open').toBeUndefined();
    expect(insufficient.evidenceRequest).toMatchObject({ status: 'INSUFFICIENT', attemptCount: 1 });
    expect(insufficient.messages.join(' ')).toMatch(/does not explicitly authorise|expired on/);
    const corrected = await handleChatEvidenceUpload(deps, { sessionId: 's', files: [await file(good)] });
    expect(corrected.outcome?.primaryReasonCode).not.toBe('AUTHORITY_SCOPE_INSUFFICIENT');
    const expected = persona.expectedOutcome === 'NEED_MORE_INFORMATION_THEN_APPROVE' ? 'APPROVE' : persona.expectedOutcome;
    if (expected === 'APPROVE' || expected === 'REJECT' || expected === 'MANUAL_REVIEW') expect(corrected.outcome?.governedOutcome, `${persona.slug} after the corrected document`).toBe(expected);
    else expect(corrected.step, `${persona.slug} moved on from the authority request`).not.toBe('AWAITING_EVIDENCE');
  }, 120_000);
});
