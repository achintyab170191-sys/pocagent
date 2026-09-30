/**
 * Customer-first intake (SBO.01 orchestrator, docs/09): the customer says who they are and which company they represent; the orchestrator
 * opens a case and asks for the documents. A company that is NOT in the trade-licence register is only a NEW LEAD (a case is recorded but
 * nothing is verified or approved); a company on record proceeds to document collection and the five checks.
 */
import { type CaseRecord, type IntakeDetails, documentLabels, findKnownBusiness, guidedScenarios, intakeDocumentTypes, personas } from '@sbo/domain';
import { type Repository, now } from '@sbo/persistence';

export const intakeChannel = 'CHAT_INTAKE';
export const standardAuthority = 'Manage account; order services; approve plan changes; sign/approve telecom commitments';

export const introMessage = 'Hello! I can help you become an authorised representative for a business.\n\nTo get started, please tell me **your name** and **the company you represent** — for example: "My name is Fatima Al Mansoori and I represent Al Noor Trading LLC."';

export function documentRequestMessage(representativeName: string, businessName: string): string {
  return `Thanks ${representativeName}. I found ${businessName} in our records. To check your request I need these documents — please attach them here (PDF, Word or image files, up to 3 at a time):\n${intakeDocumentTypes.map((type) => `- ${documentLabels[type]}`).join('\n')}`;
}

// ------------------------------------------------------------------------------------------------------------------
// Free-text extraction (deterministic, no model: customer text is untrusted and only ever read for a name and a company)
// ------------------------------------------------------------------------------------------------------------------

const nonNameWords = new Set(['representing', 'represent', 'here', 'looking', 'writing', 'calling', 'contacting', 'trying', 'applying', 'requesting', 'the', 'a', 'an', 'authorised', 'authorized', 'owner', 'director', 'manager', 'from', 'with', 'working', 'work', 'new', 'not', 'happy', 'sorry', 'interested', 'enquiring', 'inquiring', 'submitting', 'seeking', 'wanting', 'hoping', 'emailing', 'part', 'one', 'also', 'currently', 'and', 'at', 'of', 'who', 'as', 'for', 'to', 'in', 'on', 'so', 'because', 'i', 'my', 'we', 'our', 'hi', 'hello', 'hey', 'yes', 'no', 'ok', 'okay', 'please', 'thanks', 'thank']);
const wordPattern = /^[\p{L}][\p{L}'’-]*$/u;

export function cleanText(value: string, maxLength: number): string {
  return value.normalize('NFKC').replace(/[^\p{L}\p{N} .,'’&()/-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function titleCase(value: string): string {
  return value.split(' ').map((word) => (word === word.toLowerCase() || word === word.toUpperCase()) ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word).join(' ');
}

/** Reads up to four leading name-like words, stopping at connectors, punctuation or a non-name word. */
function takeNameWords(fragment: string): string {
  const words: string[] = [];
  for (const token of fragment.trim().split(/\s+/)) {
    const clean = token.replace(/[.,;:!?]+$/u, '');
    if (!wordPattern.test(clean) || nonNameWords.has(clean.toLowerCase())) break;
    words.push(clean);
    if (clean !== token || words.length === 4) break;
  }
  return words.length ? titleCase(words.join(' ')) : '';
}

const namePatterns = [/\bmy (?:full )?name(?:'s|’s| is)\s+(.+)/i, /\bname\s*[:=-]\s*(.+)/i, /\bthis is\s+(.+)/i, /\b(?:i am|i'm|i’m|im)\s+(.+)/i];
const companyPatterns = [
  /\b(?:representing|represents?)\s+(?:the\s+)?(?:company\s+|business\s+|firm\s+|organi[sz]ation\s+)?(.+)/i,
  /\bon behalf of\s+(?:the\s+)?(?:company\s+|business\s+)?(.+)/i,
  /\b(?:work(?:ing|s)?\s+(?:for|at|with)|employed\s+(?:by|at)|(?:owner|director|manager|founder|partner|officer|employee|contact)\s+(?:of|at|for))\s+(?:the\s+)?(?:company\s+)?(.+)/i,
  /\b(?:my|our) (?:company|business|organi[sz]ation)\s+(?:is|name is|called|named)\s+(.+)/i,
  /\b(?:company|business)(?: name)?\s*[:=-]\s*(.+)/i,
  /\bfrom\s+(?:the\s+)?(?:company\s+)?(.+)/i,
];
const fillerCompanies = new Set(['a company', 'the company', 'company', 'business', 'a business', 'my company', 'my business', 'our company', 'our business', 'it', 'them']);

function cutCompany(fragment: string): string {
  const sentence = fragment.split(/[,;!?\n]|\.(?=\s|$)/u)[0] ?? '';
  const connector = sentence.search(/\s+(?:and\s+(?:i|we|my|would|need|want|am|have)\b|because\b|so that\b|to\s+(?:add|be|get|become|register|apply)\b|as\s+(?:an?|the)\b|who\b|which\b|in order\b|please\b|i\s+(?:need|want|would|am|have|'d)\b|we\s+(?:need|want)\b)/i);
  return (connector >= 0 ? sentence.slice(0, connector) : sentence).trim();
}

export function extractIntake(text: string): Partial<IntakeDetails> {
  const clean = text.replace(/\s+/g, ' ').trim();
  const result: Partial<IntakeDetails> = {};
  const identifier = clean.match(/\b([A-Za-z]{2}-DEMO-BIZ-\d{3,6})\b/);
  if (identifier?.[1]) result.businessIdentifier = identifier[1].toUpperCase();
  for (const pattern of namePatterns) {
    const fragment = clean.match(pattern)?.[1];
    const name = fragment ? takeNameWords(fragment) : '';
    if (name) { result.representativeName = cleanText(name, 120); break; }
  }
  for (const pattern of companyPatterns) {
    const fragment = clean.match(pattern)?.[1];
    const company = fragment ? cleanText(cutCompany(fragment).replace(/\(?\s*[A-Za-z]{2}-DEMO-BIZ-\d{3,6}\s*\)?/gi, ' ').replace(/\(\s*\)/g, ' '), 160) : '';
    if (company.length >= 2 && /\p{L}/u.test(company) && !fillerCompanies.has(company.toLowerCase())) { result.businessName = company; break; }
  }
  return result;
}

/** A full name has at least a first and a last name (the chatbot asks again for a single word). */
export const isFullName = (name: string): boolean => name.trim().split(/\s+/).filter(Boolean).length >= 2;

/** A bare reply to "What is your full name?" — a short run of name-like words and nothing else. */
export function looksLikeBareName(text: string): string {
  const trimmed = text.trim().replace(/[.!]+$/u, '');
  const words = trimmed.split(/\s+/);
  return words.length >= 1 && words.length <= 4 && words.every((word) => wordPattern.test(word) && !nonNameWords.has(word.toLowerCase())) ? cleanText(titleCase(words.join(' ')), 120) : '';
}

/** A bare reply to "Which company are you representing?" */
export function looksLikeBareCompany(text: string): string {
  const stripped = cleanText(cutCompany(text.replace(/^(?:the\s+)?(?:company\s+|business\s+)?(?:is\s+|called\s+|named\s+)?/i, '')), 160);
  return stripped.length >= 2 && stripped.split(' ').length <= 12 && /\p{L}/u.test(stripped) && !fillerCompanies.has(stripped.toLowerCase()) ? stripped : '';
}


// ------------------------------------------------------------------------------------------------------------------
// Opening the case
// ------------------------------------------------------------------------------------------------------------------

export interface ScenarioSummary { slug: string; representativeName: string; businessName: string; story: string; expectedOutcome: string; documents: Array<{ type: string; fileName: string; path: string }>; }
/** Demo aid: the synthetic personas a tester can introduce themselves as, with links to their sample documents. */
export function listScenarios(): ScenarioSummary[] {
  return personas.map((persona) => ({ slug: persona.slug, representativeName: persona.representativeName, businessName: persona.businessName, story: persona.story, expectedOutcome: persona.expectedOutcome, documents: [...persona.documents.map((document) => ({ type: document.type, fileName: document.fileName, path: `/samples/${persona.slug}/${document.fileName}` })), ...(persona.staticDocuments ?? []).map((document) => ({ type: document.type, fileName: document.fileName, path: `/samples/${persona.slug}/${document.fileName}` }))] }));
}

export type IntakeKind = 'KNOWN_BUSINESS' | 'NEW_LEAD';
export interface OpenedCase { caseRecord: CaseRecord; kind: IntakeKind; }

export async function openIntakeCase(repository: Repository, details: IntakeDetails, requestTypeId = ''): Promise<OpenedCase> {
  const known = findKnownBusiness(details.businessName);
  const representativeName = cleanText(details.representativeName, 120);
  const businessName = known ? known.businessName : cleanText(details.businessName, 160);
  const caseRecord = await repository.createIntakeCase({
    record: {
      submissionVersion: 1, country: known ? 'AE' : '', requestType: known ? (requestTypeId && requestTypeId !== 'NEW_LOA' ? requestTypeId : 'NEW_LOA_PROCESSING') : 'NEW_LEAD', channel: intakeChannel,
      businessName, businessIdentifier: '', customerId: '', representativeName, representativeRole: '', requestedAuthority: standardAuthority,
      requestNarrative: `Please add ${representativeName} as an authorised representative for ${businessName} with the requested account, ordering, plan-change, and approval permissions.`,
      documentsSubmitted: '', submittedAt: now(), processingPriority: 'STANDARD', syntheticOnly: true,
    },
  });
  return { caseRecord, kind: known ? 'KNOWN_BUSINESS' : 'NEW_LEAD' };
}
export interface GuidedScenarioSummary {
  slug: string; title: string; representativeName: string; businessName: string; story: string;
  files: Array<{ fileName: string; type: string; note: string; path: string }>;
  steps: Array<{ attach: string[]; expect: string }>;
}
/** The guided scenarios (flawed → corrected documents) with links to their sample files and a one-line expectation per step. */
export function listGuidedScenarios(): GuidedScenarioSummary[] {
  return guidedScenarios.map((scenario) => ({
    slug: scenario.slug, title: scenario.title, representativeName: scenario.representativeName, businessName: scenario.businessName, story: scenario.story,
    files: scenario.files.map((file) => ({ fileName: file.fileName, type: file.type, note: file.note, path: file.existing ? `/samples/${file.existing}` : `/samples/scenarios/${scenario.slug}/${file.fileName}` })),
    steps: scenario.steps.map((step) => ({ attach: step.upload, expect: step.expect.step === 'DONE' ? `Decision: ${step.expect.outcome ?? 'handled'}${step.expect.reason ? ` (${step.expect.reason})` : ''}` : step.expect.outcome ? `Asks for more: ${step.expect.reason ?? step.expect.outcome}` : `Still insufficient${step.expect.includes?.[0] ? `: “${step.expect.includes[0]}”` : ''}` })),
  }));
}