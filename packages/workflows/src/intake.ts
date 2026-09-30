/**
 * Intake adapter (TARGET-SIDE, not in the n8n export — docs/07 G-32).
 *
 * The n8n chat starts from a known Case Run ID ("Evaluate AUTH-001"). Here a new customer can simply say who they are and which company they
 * represent; a case is opened and assessed. No business rule is invented: the case is assessed against the pre-computed utility results of
 * the SYNTHETIC SCENARIO whose business + representative it matches (the same fixtures the source uses). When nothing matches, every utility
 * reports UNRESOLVED_SOURCE_GAP and the governed result is MANUAL_REVIEW — never an invented pass or fail.
 */
import { type CaseRecord, type IntakeDetails } from '@sbo/domain';
import { type Repository, now } from '@sbo/persistence';

export const intakeChannel = 'CHAT_INTAKE';
export const standardAuthority = 'Manage account; order services; approve plan changes; sign/approve telecom commitments';

export const introMessage = 'Hello! I can help you become an authorised representative for a business.\n\nTo get started, please tell me **your name** and **the company you represent** — for example: "My name is Hana Rangi and I represent Kauri Harbour Demo Digital Limited."';

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
// Scenario matching
// ------------------------------------------------------------------------------------------------------------------

const businessStopWords = new Set(['pty', 'ltd', 'limited', 'the', 'company', 'co', 'inc', 'llc', 'corp', 'corporation', 'and', 'of']);
const tokens = (value: string, stop: Set<string>): string[] => value.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter((token) => token && !stop.has(token));

export function businessMatches(candidate: string, requested: string): boolean {
  const left = tokens(candidate, businessStopWords);
  const right = tokens(requested, businessStopWords);
  if (!left.length || !right.length) return false;
  if (left.join(' ') === right.join(' ')) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= 2 && shorter.every((token) => longer.includes(token));
}

export function nameMatches(candidate: string, requested: string): boolean {
  const left = tokens(candidate, new Set());
  const right = tokens(requested, new Set());
  if (!left.length || !right.length) return false;
  if (left.join(' ') === right.join(' ')) return true;
  return left.length >= 2 && right.length >= 2 && left[0] === right[0] && left.at(-1) === right.at(-1);
}

const isScenario = (record: CaseRecord): boolean => record.channel !== intakeChannel;

/** The scenario (fixture case) whose business AND representative match; the lowest submission version of a logical case is used. */
export async function findScenario(repository: Repository, details: IntakeDetails): Promise<CaseRecord | undefined> {
  const scenarios = (await repository.listCases()).filter(isScenario);
  const matching = scenarios.filter((entry) => {
    const businessOk = businessMatches(entry.businessName, details.businessName) || (details.businessIdentifier !== '' && entry.businessIdentifier.toUpperCase() === details.businessIdentifier.toUpperCase());
    return businessOk && nameMatches(entry.representativeName, details.representativeName);
  });
  return matching.sort((left, right) => left.submissionVersion - right.submissionVersion)[0];
}

export interface ScenarioSummary { caseRunId: string; representativeName: string; businessName: string; businessIdentifier: string; }
/** Demo aid: the synthetic identities that will match a scenario (first version of each logical case). */
export async function listScenarios(repository: Repository): Promise<ScenarioSummary[]> {
  const scenarios = (await repository.listCases()).filter(isScenario);
  const firstVersions = scenarios.filter((entry) => !scenarios.some((other) => other.caseId === entry.caseId && other.submissionVersion < entry.submissionVersion));
  return firstVersions.map((entry) => ({ caseRunId: entry.caseRunId, representativeName: entry.representativeName, businessName: entry.businessName, businessIdentifier: entry.businessIdentifier }));
}

/**
 * The canned pipeline used when the company is on record but the person is not one of its recorded representatives:
 * AUTH-003's "authority must be evidenced" path (checks run, then the customer supplies authority evidence, then the assessment resumes).
 */
export const unrecognisedRepresentativeTemplate = 'AUTH-003';

export type IntakeKind = 'KNOWN_CUSTOMER' | 'UNRECOGNISED_REPRESENTATIVE' | 'NEW_LEAD';
export interface OpenedCase { caseRecord: CaseRecord; scenario?: CaseRecord; kind: IntakeKind; }

/** A company already on record = any scenario whose business name (or identifier) matches, whoever the representative is. */
export async function findKnownBusiness(repository: Repository, details: IntakeDetails): Promise<CaseRecord | undefined> {
  return (await repository.listCases()).filter(isScenario).sort((left, right) => left.submissionVersion - right.submissionVersion)
    .find((entry) => businessMatches(entry.businessName, details.businessName) || (details.businessIdentifier !== '' && entry.businessIdentifier.toUpperCase() === details.businessIdentifier.toUpperCase()));
}

/**
 * Opens the customer's case (docs/07 G-33, G-35):
 *  - company AND representative on record        → case backed by that scenario, full assessment;
 *  - company on record, representative not       → case for the recorded company, assessed via the authority-evidence path;
 *  - company not on record                       → a NEW_LEAD case only: nothing is verified, no checks or decision are run.
 */
export async function openIntakeCase(repository: Repository, details: IntakeDetails): Promise<OpenedCase> {
  const matched = await findScenario(repository, details);
  const knownBusiness = matched ?? await findKnownBusiness(repository, details);
  const template = matched ?? (knownBusiness ? await repository.getCase(unrecognisedRepresentativeTemplate) : undefined);
  const representativeName = cleanText(details.representativeName, 120);
  const businessName = knownBusiness ? knownBusiness.businessName : cleanText(details.businessName, 160);
  const caseRecord = await repository.createIntakeCase({
    templateCaseRunId: template?.caseRunId ?? '',
    record: {
      submissionVersion: 1, country: knownBusiness?.country ?? '', requestType: 'NEW_AUTHORISED_REPRESENTATIVE', channel: intakeChannel,
      businessName, businessIdentifier: details.businessIdentifier || knownBusiness?.businessIdentifier || '', customerId: knownBusiness?.customerId ?? '',
      representativeName, representativeRole: matched?.representativeRole ?? '', requestedAuthority: matched?.requestedAuthority ?? standardAuthority,
      requestNarrative: `Please add ${representativeName} as an authorised representative for ${businessName} with the requested account, ordering, plan-change, and approval permissions.`,
      documentsSubmitted: template?.documentsSubmitted ?? '', submittedAt: now(), processingPriority: 'STANDARD', syntheticOnly: true,
    },
  });
  return { caseRecord, scenario: matched, kind: matched ? 'KNOWN_CUSTOMER' : knownBusiness ? 'UNRECOGNISED_REPRESENTATIVE' : 'NEW_LEAD' };
}
// ------------------------------------------------------------------------------------------------------------------
// Versioned resubmission target
// ------------------------------------------------------------------------------------------------------------------

/** The next version of the same logical case in the synthetic scenarios, if the source data defines one (e.g. AUTH-008-V1 → AUTH-008-V2). */
export async function nextVersionScenario(repository: Repository, caseRunId: string): Promise<CaseRecord | undefined> {
  const current = await repository.getCase(caseRunId);
  if (!current) return undefined;
  const scenario = await repository.getCase(await repository.getScenarioFor(caseRunId));
  if (!scenario) return undefined;
  return (await repository.listCases()).filter(isScenario).filter((entry) => entry.caseId === scenario.caseId && entry.submissionVersion > scenario.submissionVersion).sort((left, right) => left.submissionVersion - right.submissionVersion)[0];
}

/** Returns the case run to resubmit to: the fixture itself for fixture cases, or a new later-version intake case backed by the next scenario. */
export async function ensureRevisedCase(repository: Repository, original: CaseRecord): Promise<CaseRecord | undefined> {
  const next = await nextVersionScenario(repository, original.caseRunId);
  if (!next) return undefined;
  if (isScenario(original)) return next;
  const revisedRunId = `${original.caseId}-V${next.submissionVersion}`;
  return (await repository.getCase(revisedRunId)) ?? repository.createIntakeCase({ templateCaseRunId: next.caseRunId, record: { ...original, caseRunId: revisedRunId, caseId: original.caseId, submissionVersion: next.submissionVersion, documentsSubmitted: next.documentsSubmitted, submittedAt: now() } });
}
