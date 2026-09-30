/**
 * Authority-document assessment (POA / MOA / authorised-representative letter).
 *
 * The check reads what the document actually says, clause by clause, before anything is accepted or rejected — the same "minute level" the n8n
 * evidence resolution applied — but deterministically (no model): regular expressions over sentences, with negation, superseded-document and
 * limitation handling. A document is data: text that tries to instruct the process is a finding, never an instruction.
 *
 *   SUFFICIENT    the company, representative, signatory, validity and every required clause are present and consistent → the check passes
 *   INSUFFICIENT  the customer can fix it by uploading again (name mismatch, wrong company, unrecorded signatory, expired, a required clause
 *                 is not mentioned) → "insufficient evidence": the customer is told exactly what is missing and asked for a revised document
 *   UNCERTAIN     the content does not inspire confidence (contradictory clauses, a limitation that needs interpreting, an embedded instruction,
 *                 nothing readable) → a human decides
 *   ADVERSE       the document says the authority is revoked / withdrawn → a rejection is recommended (a human still confirms it)
 */
import { businessNamesMatch, parseDocumentDate, requiredAuthorityScopes, sameName, type DocumentFields } from './loa.js';

export type AuthorityScope = (typeof requiredAuthorityScopes)[number];
export type AuthorityVerdict = 'SUFFICIENT' | 'INSUFFICIENT' | 'UNCERTAIN' | 'ADVERSE';

export const authorityScopeLabels: Record<AuthorityScope, string> = {
  MANAGE_ACCOUNT: 'manage the account',
  ORDER_SERVICES: 'order services',
  APPROVE_PLAN_CHANGES: 'approve plan or service changes',
  SIGN_COMMITMENTS: 'sign or approve commercial commitments and agreements',
};

export interface AuthorityExpectations {
  representativeName: string; businessName: string; asOf: Date;
  /** Is this person recorded (owner, manager, authorised signatory) with authority to grant authority? undefined = the company is not on record. */
  isRecordedSigner?: (name: string) => boolean;
}
export interface AuthorityFinding { key: string; status: 'OK' | 'GAP' | 'UNCERTAIN' | 'ADVERSE'; detail: string; }
export interface AuthorityAssessment {
  verdict: AuthorityVerdict; confidence: number;
  form: 'LETTER' | 'STRUCTURED';
  company: string; representative: string; signatory: string; signatoryTitle: string; issueDate: string; validUntil: string;
  /** The clause (sentence) that grants each scope. */
  granted: Partial<Record<AuthorityScope, string>>;
  /** Scopes accepted without their own clause because broader explicit authority implies them. */
  implied: AuthorityScope[];
  missingScopes: AuthorityScope[];
  findings: AuthorityFinding[];
  /** Customer-safe sentences describing what must be fixed (INSUFFICIENT). */
  gaps: string[];
  /** Why a human must look (UNCERTAIN / ADVERSE). */
  reasons: string[];
  /** The gap is about the basic details (names, signatory, dates), not the clauses. */
  detailsMismatch: boolean;
  securityFinding: boolean;
}

// ------------------------------------------------------------------------------------------------------------------
// Reading a free-form authority letter
// ------------------------------------------------------------------------------------------------------------------

/** Headings of documents that grant authority in prose rather than in a labelled form. */
export const looksLikeAuthorityLetter = (head: string): boolean => /AUTHORI[SZ]ED\s+REPRESENTATIVE\s+LETTER|LETTER\s+OF\s+AUTHORI(?:TY|[SZ]ATION)|AUTHORI(?:TY|[SZ]ATION)\s+LETTER|BOARD\s+RESOLUTION/i.test(head);

const junkValue = /^(?:letter|declaration|details?|information|role|name|scope|confirmation)$/i;
function labelled(text: string, label: string): string {
  const pattern = new RegExp(`^[ \\t]*(?:${label})[ \\t]*[:\\-]?[ \\t]+(\\S[^\\r\\n]*?)[ \\t]*$`, 'gim');
  for (const match of text.matchAll(pattern)) { const value = (match[1] ?? '').trim(); if (value && !junkValue.test(value)) return value; }
  return '';
}

const looksLikeName = (value: string): boolean => /^[\p{Lu}][\p{L}'’.-]+(?:\s+[\p{Lu}][\p{L}'’.-]+)+$/u.test(value.trim());
const companyForm = '(?:Pty\\.?\\s+Ltd\\.?|Limited|Ltd\\.?|LLC|L\\.L\\.C\\.?|Inc\\.?|FZ-?LLC|FZE|FZCO|Company|Corporation|Corp\\.?|Group|Holdings|Trading|Services|Solutions|Enterprises)';

/** Company, representative, signatory, dates and reference from a letter written as "Label value" lines and/or prose. */
export function readAuthorityLetterFields(text: string): DocumentFields {
  const fields: DocumentFields = {};
  const set = (key: string, value: string): void => { if (value) fields[key] = value; };
  set('businessName', labelled(text, 'Company(?: name)?|Business name'));
  set('grantee', labelled(text, 'Authori[sz]ed representative|Representative(?!\\s+role)(?: name)?'));
  set('representativeRole', labelled(text, 'Representative role'));
  set('issueDate', labelled(text, 'Issue date|Date of issue|Dated'));
  set('validUntil', labelled(text, 'Valid until|Valid to|Expiry date|Expires(?: on)?'));
  set('reference', labelled(text, 'Case reference|Reference|Ref'));
  // Prose: "<Company> [hereby] appoints [and expressly authorises] <Person> to/as …"
  const prose = text.replace(/\s+/g, ' ').replace(/(?:revised\s+)?(?:letter\s+of\s+authori(?:ty|[sz]ation)|authori[sz]ed\s+representative\s+letter|authori(?:ty|[sz]ation)\s+letter)/gi, ' ').match(new RegExp(`([\\p{Lu}][\\p{L}\\p{N}&.,'’ -]{1,80}?\\s${companyForm})\\s+(?:hereby\\s+)?(?:appoints|authori[sz]es|empowers|nominates)\\b[^.]{0,40}?\\b([\\p{Lu}][\\p{L}'’-]+(?:\\s+[\\p{Lu}][\\p{L}'’-]+){1,3})\\s+(?:to|as)\\b`, 'u'));
  if (prose) { if (!fields.businessName) set('businessName', (prose[1] ?? '').replace(/^(?:the\s+)?/i, '').trim()); if (!fields.grantee) set('grantee', (prose[2] ?? '').trim()); }
  // Signature: "Signed for and on behalf of the company <Name> - <Title>", "Signed by <Name>, <Title>", "Signed: <Title>, <date>"
  const signed = text.match(/sign(?:ed)?\s+(?:for\s+and\s+)?on\s+behalf\s+of\s+the\s+company\s*:?\s*[\r\n\s]*([^\r\n]+)/i) ?? text.match(/signed(?:\s+by)?\s*:?\s*[\r\n\s]*([^\r\n]+)/i);
  if (signed?.[1]) {
    const parts = signed[1].trim().split(/\s+[-–—]\s+|,\s+/).map((part) => part.trim()).filter(Boolean);
    const [first = '', ...rest] = parts;
    if (looksLikeName(first)) { set('grantor', first); set('signatoryTitle', rest.filter((part) => !/\d{4}/.test(part)).join(' - ')); }
    else set('signatoryTitle', first); // a title with no name: nobody can be identified as the signatory
    if (!fields.issueDate) { const date = signed[1].match(/\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/); if (date) set('issueDate', date[0]); }
  }
  return fields;
}
// ------------------------------------------------------------------------------------------------------------------
// Clause analysis
// ------------------------------------------------------------------------------------------------------------------

const scopePatterns: Record<AuthorityScope, RegExp> = {
  MANAGE_ACCOUNT: /\bmanag\w*\b[^.;]{0,60}\baccounts?\b|\baccount\s+(?:administration|management)\b|\badminister\w*\b[^.;]{0,40}\baccounts?\b/,
  ORDER_SERVICES: /\border(?:s|ing)?\s+(?:of\s+)?(?:new\s+|additional\s+)?(?:\w+\s+){0,2}(?:services?|products?|connections?|lines?|plans?)\b|\bplace\s+(?:\w+\s+)?orders?\b|\bservice\s+ordering\b|\bnew\s+service\s+connections?\b|\b(?:submit|place|raise|create|initiate|approve)\b[^.;]{0,40}\bservice\s+orders?\b/,
  APPROVE_PLAN_CHANGES: /\b(?:plan|service|subscription)\s+changes?\b|\bchange\w*\s+(?:the\s+|our\s+)?(?:plans?|services?)\b|\bupgrad\w*|\bdowngrad\w*|\bmigrat\w*|\bmodif\w*\s+(?:the\s+)?(?:plans?|services?)\b/,
  SIGN_COMMITMENTS: /\b(?:sign\w*|execut\w*|countersign\w*|approv\w*|accept\w*)\b[^.;]{0,70}\b(?:agreements?|contracts?|commitments?|commercial\s+(?:terms|conditions)|quotes?|forms)\b|\bcommercial\s+commitments?\b|\b(?:agreements?|contracts?)\s+signing\b/,
};
const generalAuthority = /\b(?:full|general|unlimited|complete|plenary)\s+(?:authority|powers?)\b|\bany\s+and\s+all\s+(?:acts|matters|things)\b/;
const grantCue = /\b(?:authori[sz]e[sd]?|authori[sz]ing|appoint\w*|empower\w*|permit\w*|entitle\w*|grant\w*|delegat\w*|may|allowed|has\s+authority|have\s+authority|is\s+able\s+to|can)\b/;
const actionStart = /^(?:and\s+|to\s+)?(?:order|place|approve|request|execute|sign|manage|administer|change|modify|upgrade|downgrade|add|remove|migrate|submit|accept|coordinate|communicate|act|transact|commit|purchase|activate|amend|renew|raise|create|initiate)\b/;
const negation = /\b(?:not|no|never|neither|nor|without|excluding|except|excluded|cannot|can't|unable|prohibited|forbidden|doesn't|didn't|isn't|aren't)\b/;
const historical = /\b(?:supersed\w*|replac(?:e|es|ed|ing)|earlier|previous(?:ly)?|prior|former|amends?)\b/;
const limitation = /\b(?:jointly|joint(?:ly)?\s+with|co-?sign\w*|countersign\w*|two\s+(?:signatures|signatories|directors)|together\s+with\s+(?:another|a\s+second)|subject\s+to\s+(?:the\s+)?(?:prior\s+|written\s+)?(?:approval|consent|ratification)|only\s+if|up\s+to\s+(?:an\s+amount\s+of\s+|a\s+maximum\s+of\s+)?(?:aed|usd|aud|nzd|\$|€)|not\s+exceeding|maximum\s+of|capped\s+at)\b/;
const revoked = /\b(?:this\s+(?:letter|authority|authori[sz]ation|appointment|power\s+of\s+attorney)|the\s+authority)\b[^.]{0,60}\b(?:is|has\s+been|are)\s+(?:hereby\s+)?(?:revoked|withdrawn|terminated|cancelled|void)\b|\bhereby\s+revokes?\b|\bno\s+longer\s+(?:valid|authori[sz]ed)\b/;
const embeddedInstruction = /\bignore\b[^.]{0,40}\b(?:instructions?|rules?|checks?)\b|\bsystem\s+prompt\b|\bdisregard\b[^.]{0,30}\b(?:above|previous|prior|rules?)\b|\b(?:approve|accept)\s+(?:this|the)\s+(?:request|case|document)\s+(?:immediately|automatically)\b|\bmark\s+(?:this|the)\s+(?:case|request)\b|\byou\s+(?:are|must)\s+now\b|\bdo\s+not\s+(?:flag|escalate|review)\b/;

/** The clause text of a document: header/notes removed, wrapped lines joined, split into sentences and list items. */
function sentencesOf(text: string): string[] {
  let body = text.replace(/\r/g, '');
  const note = body.search(/prototype\s+note/i); // commentary added to test documents is not a clause
  if (note >= 0) body = body.slice(0, note);
  return body
    .replace(/\n(?!\s*(?:\d+[.)]\s|[-•*]\s))/g, ' ')
    .split(/(?<=[.;:!?])\s+|\s+(?=\d+[.)]\s+[A-Z])|\s+(?=[-•*]\s+[A-Za-z])/)
    .map((sentence) => sentence.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, '').replace(/\s+/g, ' ').trim())
    .filter((sentence) => sentence.length > 3);
}

/** The first sentence of a document that tries to instruct the review process (a prompt injection), or an empty string. */
export function findEmbeddedInstruction(text: string): string {
  return sentencesOf(text).find((sentence) => embeddedInstruction.test(sentence.toLowerCase().replace(/-/g, ' '))) ?? '';
}

const clean = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] : value)?.toString().trim() ?? '';
const list = (items: string[]): string => items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join('; ')}; and ${items.at(-1)}`;

export function assessAuthorityDocument(document: { text: string; fields: DocumentFields }, expectations: AuthorityExpectations): AuthorityAssessment {
  const text = document.text || '';
  const labelledForm = /\b(?:grantee|grantor)\s*:/i.test(text); // a form with "Grantor: … Grantee: …" labels, as opposed to a letter
  const noun = labelledForm ? 'document' : 'letter';
  const letter = readAuthorityLetterFields(text);
  const field = (key: string): string => clean(document.fields[key]) || clean(letter[key]);
  const company = field('businessName'); const representative = field('grantee'); const signatory = field('grantor');
  const signatoryTitle = field('signatoryTitle'); const issueDate = field('issueDate'); const validUntil = field('validUntil');

  // --- clauses -----------------------------------------------------------------------------------------------
  const granted: Partial<Record<AuthorityScope, string>> = {};
  const denied: Partial<Record<AuthorityScope, string>> = {};
  const limitations: string[] = []; const revocations: string[] = [];
  let general = false; let injected = '';
  for (const raw of sentencesOf(text)) {
    const sentence = raw.toLowerCase().replace(/-/g, ' ').replace(/\bnot\s+limited\s+to\b/g, 'including');
    if (embeddedInstruction.test(sentence)) injected = injected || raw;
    if (historical.test(sentence)) continue; // it describes another document
    if (revoked.test(sentence)) { revocations.push(raw); continue; }
    const negated = negation.test(sentence);
    const isClause = grantCue.test(sentence) || actionStart.test(sentence);
    if (!isClause && !negated) continue;
    for (const scope of requiredAuthorityScopes) {
      if (!scopePatterns[scope].test(sentence)) continue;
      if (negated) denied[scope] = denied[scope] ?? raw; else granted[scope] = granted[scope] ?? raw;
    }
    if (!negated && grantCue.test(sentence) && generalAuthority.test(sentence)) general = true;
    if (!negated && isClause && limitation.test(sentence)) limitations.push(raw);
  }
  if (general) for (const scope of requiredAuthorityScopes) granted[scope] = granted[scope] ?? 'General authority is granted.';
  const explicit = requiredAuthorityScopes.filter((scope) => scope !== 'MANAGE_ACCOUNT' && granted[scope]);
  const implied: AuthorityScope[] = !granted.MANAGE_ACCOUNT && explicit.length >= 2 ? ['MANAGE_ACCOUNT'] : []; // ordering + changing + signing is managing the account
  const missingScopes = requiredAuthorityScopes.filter((scope) => !granted[scope] && !implied.includes(scope));
  const contradictions = requiredAuthorityScopes.filter((scope) => granted[scope] && denied[scope]);

  // --- basic details -----------------------------------------------------------------------------------------
  const findings: AuthorityFinding[] = []; const gaps: string[] = []; const reasons: string[] = [];
  let detailsMismatch = false;
  const detail = (key: string, status: AuthorityFinding['status'], message: string, gap = false): void => { findings.push({ key, status, detail: message }); if (gap) { gaps.push(message); detailsMismatch = true; } };

  if (!company) detail('COMPANY', 'GAP', `The ${noun} does not name the company it is issued for.`, true);
  else if (!businessNamesMatch(company, expectations.businessName)) detail('COMPANY', 'GAP', `The ${noun} is for ${company}, but the request is for ${expectations.businessName}.`, true);
  else detail('COMPANY', 'OK', `Issued for ${company}.`);

  if (!representative) detail('REPRESENTATIVE', 'GAP', `The ${noun} does not name the person who is being authorised.`, true);
  else if (!sameName(representative, expectations.representativeName)) detail('REPRESENTATIVE', 'GAP', `The ${noun} authorises ${representative}, but the request is from ${expectations.representativeName}.`, true);
  else detail('REPRESENTATIVE', 'OK', `Names ${representative} as the authorised representative.`);

  if (!signatory) detail('SIGNATORY', 'GAP', `The ${noun} is not signed for and on behalf of the company by a named officer.`, true);
  else if (expectations.isRecordedSigner && !expectations.isRecordedSigner(signatory)) detail('SIGNATORY', 'GAP', `The ${noun} is signed by ${signatory}, who is not recorded as an owner, manager or authorised signatory of the company.`, true);
  else detail('SIGNATORY', 'OK', `Signed for the company by ${signatory}${signatoryTitle ? ` (${signatoryTitle})` : ''}.`);

  const issued = parseDocumentDate(issueDate); const until = parseDocumentDate(validUntil);
  const asOf = expectations.asOf.getTime();
  if (validUntil && until && until.getTime() < asOf) detail('VALIDITY', 'GAP', `The ${noun} expired on ${validUntil}.`, true);
  else if (validUntil && until) detail('VALIDITY', 'OK', `Valid until ${validUntil}.`);
  else if (issued && issued.getTime() > asOf + 86_400_000) detail('VALIDITY', 'GAP', `The ${noun} is dated in the future (${issueDate}).`, true);
  else if (issued && asOf - issued.getTime() > 366 * 86_400_000) detail('VALIDITY', 'GAP', `The ${noun} states no validity period and was issued more than a year ago (${issueDate}).`, true);
  else if (issued) detail('VALIDITY', 'OK', `Issued ${issueDate}; no expiry stated.`);
  else detail('VALIDITY', 'GAP', `The ${noun} shows neither an issue date nor a validity period.`, true);

  // --- clauses vs what was requested -------------------------------------------------------------------------
  for (const scope of requiredAuthorityScopes) {
    if (granted[scope]) findings.push({ key: `CLAUSE_${scope}`, status: 'OK', detail: `Explicitly authorised to ${authorityScopeLabels[scope]}.` });
    else if (implied.includes(scope)) findings.push({ key: `CLAUSE_${scope}`, status: 'OK', detail: `Authority to ${authorityScopeLabels[scope]} follows from the ordering, change and signing authority granted.` });
    else findings.push({ key: `CLAUSE_${scope}`, status: 'GAP', detail: `Nothing in the letter authorises the representative to ${authorityScopeLabels[scope]}.` });
  }
  if (missingScopes.length > 0) {
    const covers = requiredAuthorityScopes.filter((scope) => granted[scope]).map((scope) => authorityScopeLabels[scope]);
    gaps.push(`The ${noun} does not explicitly authorise the representative to ${list(missingScopes.map((scope) => authorityScopeLabels[scope]))}.${covers.length ? ` It only covers: ${list(covers)}.` : ''}`);
  }

  // --- confidence and verdict ---------------------------------------------------------------------------------
  const unreadable = !company && !representative && !signatory && Object.keys(granted).length === 0;
  const securityFinding = Boolean(injected);
  if (securityFinding) reasons.push('The document contains text that tries to instruct the review process; it was ignored and a specialist should look at it.');
  for (const scope of contradictions) reasons.push(`The letter both grants and excludes the authority to ${authorityScopeLabels[scope]}.`);
  for (const sentence of limitations) reasons.push(`The letter attaches a limitation that needs interpreting: "${sentence.slice(0, 160)}".`);
  if (unreadable) reasons.push('None of the key details (company, representative, signatory, authority clauses) could be read from the document.');
  for (const sentence of revocations) reasons.push(`The letter states the authority is withdrawn: "${sentence.slice(0, 160)}".`);

  let verdict: AuthorityVerdict;
  if (revocations.length > 0 && !securityFinding) verdict = 'ADVERSE';
  else if (reasons.length > 0) verdict = 'UNCERTAIN';
  else if (gaps.length > 0) verdict = 'INSUFFICIENT';
  else verdict = 'SUFFICIENT';
  const confidence = Math.round((verdict === 'SUFFICIENT' ? Math.max(0.8, 0.95 - (implied.length ? 0.05 : 0) - (validUntil ? 0 : 0.03)) : verdict === 'INSUFFICIENT' ? 0.9 : verdict === 'ADVERSE' ? 0.85 : 0.5) * 100) / 100;
  return { verdict, confidence, form: labelledForm ? 'STRUCTURED' : 'LETTER', company, representative, signatory, signatoryTitle, issueDate, validUntil, granted, implied, missingScopes, findings, gaps, reasons, detailsMismatch, securityFinding };
}
