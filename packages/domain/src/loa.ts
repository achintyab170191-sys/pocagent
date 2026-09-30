/**
 * To-Be "New LOA Processing" (letter of authority) process, triggered by the customer through the conversational chatbot.
 * Source of truth: the E&SMB-BO To-Be process diagrams (profiling, pages 12-13), NOT the earlier n8n export (docs/09).
 *
 *   SBO.01 orchestrator  → ticket + document request
 *   SBO.02 super agent   → calls, in order:
 *     SBO.06 Trade License Check   (TL / EC validity, EC + TL name vs EID name; DUL API, QR fallback, government portal via UAE Pass)
 *     SBO.07 Identity Validation   (EID / EC cross-check with the TL name)
 *     POA/MOA check                (only when the representative is not the licence owner / authorised signatory)
 *     SBO.09 Bad Debt Check        (via SBO.08 duplicate-PD cross-check in BCRM; bad debt and blue-collar behaviour)
 *     SBO.10 AVCV verification
 *   → APPROVE (SBO.11 communication) or REJECT (SBO.11 communication + SBO.20 RCA agent).
 *
 * Everything here is SYNTHETIC. There is no DUL API, government portal, BCRM or AVCV service: the registers below stand in for them.
 * The pure functions have no I/O; the caller supplies the documents the customer uploaded and the reference date.
 */
import type { CommunicationTemplate, DecisionRule } from './index.js';

// ------------------------------------------------------------------------------------------------------------------
// Mandatory checks (governed order)
// ------------------------------------------------------------------------------------------------------------------

export const loaCheckCatalog = [
  { sequence: 1, checkType: 'TRADE_LICENSE_CHECK', toolName: 'Trade License Check', agentId: 'SBO.06', label: 'Trade License and Establishment Card check' },
  { sequence: 2, checkType: 'IDENTITY_VALIDATION', toolName: 'Identity Validation', agentId: 'SBO.07', label: 'Identity validation (Emirates ID vs licence records)' },
  { sequence: 3, checkType: 'POA_MOA_CHECK', toolName: 'POA/MOA Check', agentId: 'SBO.02', label: 'Power of Attorney / Memorandum of Association check' },
  { sequence: 4, checkType: 'BAD_DEBT_CHECK', toolName: 'Bad Debt Check', agentId: 'SBO.09', label: 'Bad debt and blue-collar behaviour check' },
  { sequence: 5, checkType: 'AVCV_VERIFICATION', toolName: 'AVCV Verification', agentId: 'SBO.10', label: 'AVCV verification' },
] as const;
export type LoaCheckType = (typeof loaCheckCatalog)[number]['checkType'];

// ------------------------------------------------------------------------------------------------------------------
// Documents (evidence is documents only: no free-text evidence)
// ------------------------------------------------------------------------------------------------------------------

export const documentTypes = ['EMIRATES_ID', 'TRADE_LICENSE', 'ESTABLISHMENT_CARD', 'POA_MOA', 'ADDRESS_PROOF'] as const;
export type DocumentType = (typeof documentTypes)[number];
export const documentLabels: Record<DocumentType, string> = {
  EMIRATES_ID: 'Emirates ID of the representative',
  TRADE_LICENSE: 'Trade License of the business',
  ESTABLISHMENT_CARD: 'Establishment Card of the business',
  POA_MOA: 'Power of Attorney (POA) or Memorandum of Association (MOA) authorising the representative',
  ADDRESS_PROOF: 'Proof of address for the business (utility bill or tenancy contract)',
};
/** The documents the chatbot asks for up front. */
export const intakeDocumentTypes: readonly DocumentType[] = ['EMIRATES_ID', 'TRADE_LICENSE', 'ESTABLISHMENT_CARD'];

/** Which documents an evidence request needs, by the check that asked for it. */
export function requiredDocumentTypes(originatingCheckType: string): DocumentType[] {
  switch (originatingCheckType.toUpperCase()) {
    case 'TRADE_LICENSE_CHECK': return ['TRADE_LICENSE'];
    case 'IDENTITY_VALIDATION': return ['EMIRATES_ID'];
    case 'POA_MOA_CHECK': return ['POA_MOA'];
    case 'AVCV_VERIFICATION': return ['ADDRESS_PROOF'];
    default: return [...intakeDocumentTypes];
  }
}

const fieldLabels: Record<DocumentType, Record<string, string>> = {
  EMIRATES_ID: { idNumber: 'ID Number', fullName: 'Full Name', nationality: 'Nationality', expiryDate: 'Expiry Date' },
  TRADE_LICENSE: { licenseNumber: 'License Number', businessName: 'Business Name', licenseHolder: 'License Holder', issuingAuthority: 'Issuing Authority', expiryDate: 'Expiry Date', qrCode: 'QR Code' },
  ESTABLISHMENT_CARD: { establishmentNumber: 'Establishment Number', businessName: 'Business Name', licenseNumber: 'Trade License Number', signatories: 'Authorised Signatory', expiryDate: 'Expiry Date' },
  POA_MOA: { reference: 'Reference', grantor: 'Grantor', grantee: 'Grantee', businessName: 'Business Name', scope: 'Scope', validUntil: 'Valid Until' },
  ADDRESS_PROOF: { holderName: 'Holder Name', address: 'Address', documentKind: 'Document Type' },
};
const multiValued = new Set(['signatories']);

export interface DocumentFields { [field: string]: string | string[] | undefined; }
export interface ClassifiedDocument { documentType: DocumentType; fields: DocumentFields; }

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Reads `Label: value` pairs. Works whether the text has one line per field or (as PDF/OCR often produce) everything on one line. */
export function extractFields(documentType: DocumentType, text: string): DocumentFields {
  const labels = fieldLabels[documentType];
  const labelPattern = Object.values(labels).map(escapeRegex).join('|');
  const pair = new RegExp(`(?<![A-Za-z])(${labelPattern})\\s*:\\s*([^\\n\\r]*?)(?=\\s+(?<![A-Za-z])(?:${labelPattern})\\s*:|[\\n\\r]|$)`, 'gi');
  const byLabel = new Map<string, string[]>();
  for (const match of text.matchAll(pair)) {
    const key = (match[1] ?? '').toLowerCase();
    const value = (match[2] ?? '').trim().replace(/[;,.\s]+$/, '');
    if (value) byLabel.set(key, [...(byLabel.get(key) ?? []), value]);
  }
  const fields: DocumentFields = {};
  for (const [field, label] of Object.entries(labels)) {
    const values = byLabel.get(label.toLowerCase());
    if (values?.length) fields[field] = multiValued.has(field) ? values.flatMap((value) => value.split(/\s*;\s*/)).filter(Boolean) : values[0];
  }
  return fields;
}

/** Document type from its heading (the first part of the text); a document that is none of the four supported types returns undefined. */
export function classifyDocument(text: string): ClassifiedDocument | undefined {
  const head = text.slice(0, 200).toUpperCase();
  const whole = text.toUpperCase();
  const detect = (haystack: string): DocumentType | undefined => {
    if (/PROOF OF ADDRESS|UTILITY BILL|TENANCY CONTRACT/.test(haystack)) return 'ADDRESS_PROOF';
    if (/POWER OF ATTORNEY|MEMORANDUM OF ASSOCIATION/.test(haystack)) return 'POA_MOA';
    if (/ESTABLISHMENT CARD/.test(haystack)) return 'ESTABLISHMENT_CARD';
    if (/EMIRATES ID/.test(haystack)) return 'EMIRATES_ID';
    if (/TRADE LICEN[SC]E/.test(haystack)) return 'TRADE_LICENSE';
    return undefined;
  };
  const documentType = detect(head) ?? detect(whole);
  return documentType ? { documentType, fields: extractFields(documentType, text) } : undefined;
}

// ------------------------------------------------------------------------------------------------------------------
// Dates and names
// ------------------------------------------------------------------------------------------------------------------

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** ISO (2027-06-30), DD/MM/YYYY and "30 Jun 2027". Returns undefined when the value is not a date. */
export function parseDocumentDate(value: string | undefined): Date | undefined {
  const text = (value ?? '').trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59));
  match = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (match) return new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]), 23, 59, 59));
  match = text.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
  const month = match ? months.indexOf((match[2] ?? '').toLowerCase()) : -1;
  return match && month >= 0 ? new Date(Date.UTC(Number(match[3]), month, Number(match[1]), 23, 59, 59)) : undefined;
}

const normalise = (value: string): string[] => value.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
const companyStopWords = new Set(['pty', 'ltd', 'limited', 'the', 'company', 'co', 'inc', 'corp', 'corporation', 'and', 'of']);
/** People: same words in any order ("Fatima Al Mansoori" = "Al Mansoori Fatima"), otherwise different. */
export function sameName(left: string | undefined, right: string | undefined): boolean {
  const a = normalise(left ?? '').sort().join(' ');
  const b = normalise(right ?? '').sort().join(' ');
  return a !== '' && a === b;
}
/** Companies: legal-form words ignored; one name may be a prefix-subset of the other only when it still has two distinctive words. */
export function businessNamesMatch(left: string | undefined, right: string | undefined): boolean {
  const a = normalise(left ?? '').filter((token) => !companyStopWords.has(token));
  const b = normalise(right ?? '').filter((token) => !companyStopWords.has(token));
  if (!a.length || !b.length) return false;
  if (a.join(' ') === b.join(' ')) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 2 && shorter.every((token) => longer.includes(token));
}

// ------------------------------------------------------------------------------------------------------------------
// Synthetic registers (stand-ins for the DUL API / government portal, BCRM, Emirates ID lookup, AVCV service)
// ------------------------------------------------------------------------------------------------------------------

export type AvcvOutcome = 'POSITIVE' | 'NEGATIVE' | 'DISCREPANCY' | 'UNABLE_TO_VERIFY' | 'REFER' | 'INSUFFICIENT_INFORMATION';
export type PersonCapacity = 'OWNER' | 'MANAGER' | 'AUTHORISED_SIGNATORY' | 'LISTED_NO_AUTHORITY';
/** A person recorded in the approved source (trade licence / company registration) with the capacity and permissions that record gives them. */
export interface RecordedPerson { name: string; capacity: PersonCapacity; scopes: string[]; /** A limitation or conflicting evidence on the person's authority (e.g. "joint signature required"). */ limitation?: string; }
export interface TradeLicenseRecord { licenseNumber: string; qrToken: string; businessName: string; ownerName: string; status: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED'; expiryDate: string; dulApiAvailable: boolean; establishmentNumber: string; persons: RecordedPerson[]; }
export interface EmiratesIdRecord { idNumber: string; fullName: string; expiryDate: string; }
export interface PoaRecord { reference: string; grantor: string; grantee: string; businessName: string; scopes: string[]; validUntil: string; }
export interface PartyRecord { partyId: string; licenseNumber: string; holderName: string; badDebtAed: number; blueCollarFlag: boolean; }
/** AVCV = Address Verification and Credit Verification: one outcome for the address, one for the credit profile. */
export interface AvcvRecord { licenseNumber: string; address: AvcvOutcome; credit: AvcvOutcome; }

export const requiredAuthorityScopes = ['MANAGE_ACCOUNT', 'ORDER_SERVICES', 'APPROVE_PLAN_CHANGES', 'SIGN_COMMITMENTS'] as const;

const FAR = '2099-12-31';
const PAST = '2020-01-31';
const all = [...requiredAuthorityScopes];
const owner = (name: string): RecordedPerson => ({ name, capacity: 'OWNER', scopes: all });
const licenseOf = (n: number, businessName: string, ownerName: string, extra: Partial<TradeLicenseRecord> & { persons?: RecordedPerson[] } = {}): TradeLicenseRecord => ({ licenseNumber: `TL-DEMO-${n}`, qrToken: `QR-TL-${n}`, businessName, ownerName, status: 'ACTIVE', expiryDate: FAR, dulApiAvailable: true, establishmentNumber: `EC-DEMO-${n}`, persons: [owner(ownerName)], ...extra });
export const tradeLicenseRegister: TradeLicenseRecord[] = [
  licenseOf(100201, 'Al Noor Trading LLC', 'Fatima Al Mansoori', { persons: [owner('Fatima Al Mansoori'), { name: 'Layth Barakat', capacity: 'MANAGER', scopes: all }] }),
  licenseOf(100202, 'Gulf Horizon Contracting LLC', 'Khalid Al Suwaidi', { persons: [owner('Khalid Al Suwaidi'), { name: 'Ahmed Yusuf', capacity: 'MANAGER', scopes: ['MANAGE_ACCOUNT', 'ORDER_SERVICES'] }] }),
  licenseOf(100203, 'Desert Bloom Cafe LLC', 'Sara Khan', { expiryDate: PAST }),
  licenseOf(100204, 'Falcon Logistics LLC', 'Rashid Al Ketbi', { persons: [owner('Rashid Al Ketbi'), { name: 'Jamal Farouk', capacity: 'AUTHORISED_SIGNATORY', scopes: all, limitation: 'Joint signature with the owner is required for commitments.' }] }),
  licenseOf(100205, 'Pearl Coast Real Estate LLC', 'Layla Nasser'),
  licenseOf(100206, 'Oasis Tech Solutions FZ-LLC', 'Yousef Ibrahim'),
  licenseOf(100207, 'Marina Bay Catering LLC', 'Noura Al Falasi', { dulApiAvailable: false }),
  licenseOf(100208, 'Sahara Staffing Services LLC', 'Tariq Mahmood'),
  licenseOf(100209, 'Dune Ridge Engineering LLC', 'Mariam Saeed'),
  licenseOf(100210, 'Cedar Point Consulting LLC', 'Ibrahim Karam'),
  licenseOf(100211, 'Palm Grove Hospitality LLC', 'Reem Al Hosani'),
  licenseOf(100212, 'Coral Reef Diving LLC', 'Adel Mansour'),
];

const eid = (index: number, year: number, name: string): EmiratesIdRecord => ({ idNumber: `784-${year}-${String(1111111 * index).slice(0, 7)}-${index % 10}`, fullName: name, expiryDate: FAR });
export const emiratesIdRegister: EmiratesIdRecord[] = [
  { idNumber: '784-1985-1234567-1', fullName: 'Fatima Al Mansoori', expiryDate: FAR },
  { idNumber: '784-1978-2345678-2', fullName: 'Khalid Al Suwaidi', expiryDate: FAR },
  { idNumber: '784-1990-3456789-3', fullName: 'Omar Haddad', expiryDate: FAR },
  { idNumber: '784-1989-4567890-4', fullName: 'Sara Khan', expiryDate: FAR },
  { idNumber: '784-1982-5678901-5', fullName: 'Rashid Al Ketbi', expiryDate: FAR },
  { idNumber: '784-1987-6789012-6', fullName: 'Layla Nasser', expiryDate: FAR },
  { idNumber: '784-1984-7890123-7', fullName: 'Yousef Ibrahim', expiryDate: FAR },
  { idNumber: '784-1991-8901234-8', fullName: 'Noura Al Falasi', expiryDate: FAR },
  { idNumber: '784-1980-9012345-9', fullName: 'Tariq Mahmood', expiryDate: FAR },
  { idNumber: '784-1993-1122334-0', fullName: 'Hessa Al Ameri', expiryDate: FAR },
  { idNumber: '784-1988-2233445-1', fullName: 'Mariam Saeed', expiryDate: FAR },
  eid(1, 1986, 'Layth Barakat'), eid(2, 1992, 'Ahmed Yusuf'), eid(3, 1983, 'Jamal Farouk'),
  eid(4, 1979, 'Ibrahim Karam'), eid(5, 1990, 'Reem Al Hosani'), eid(6, 1981, 'Adel Mansour'),
];

export const poaRegister: PoaRecord[] = [
  { reference: 'POA-DEMO-2001', grantor: 'Khalid Al Suwaidi', grantee: 'Omar Haddad', businessName: 'Gulf Horizon Contracting LLC', scopes: [...requiredAuthorityScopes], validUntil: FAR },
  { reference: 'POA-DEMO-2002', grantor: 'Fatima Al Mansoori', grantee: 'Hessa Al Ameri', businessName: 'Al Noor Trading LLC', scopes: [...requiredAuthorityScopes], validUntil: PAST },
  { reference: 'POA-DEMO-2003', grantor: 'Khalid Al Suwaidi', grantee: 'Ahmed Yusuf', businessName: 'Gulf Horizon Contracting LLC', scopes: [...requiredAuthorityScopes], validUntil: FAR },
];

const party = (id: string, license: number, name: string, extra: Partial<PartyRecord> = {}): PartyRecord => ({ partyId: id, licenseNumber: `TL-DEMO-${license}`, holderName: name, badDebtAed: 0, blueCollarFlag: false, ...extra });
export const partyRegister: PartyRecord[] = [
  party('PD-DEMO-1001', 100201, 'Fatima Al Mansoori'), party('PD-DEMO-1002', 100202, 'Khalid Al Suwaidi'), party('PD-DEMO-1003', 100203, 'Sara Khan'), party('PD-DEMO-1004', 100204, 'Rashid Al Ketbi'),
  party('PD-DEMO-5001', 100205, 'Layla Nasser'), party('PD-DEMO-5002', 100205, 'Layla Nasser', { badDebtAed: 12500 }),
  party('PD-DEMO-1006', 100206, 'Yousef Ibrahim'), party('PD-DEMO-1007', 100207, 'Noura Al Falasi'), party('PD-DEMO-1008', 100208, 'Tariq Mahmood', { blueCollarFlag: true }),
  party('PD-DEMO-1009', 100209, 'Mariam Saeed'), party('PD-DEMO-1010', 100210, 'Ibrahim Karam'), party('PD-DEMO-1011', 100211, 'Reem Al Hosani'), party('PD-DEMO-1012', 100212, 'Adel Mansour'),
];

const avcv = (license: number, address: AvcvOutcome = 'POSITIVE', credit: AvcvOutcome = 'POSITIVE'): AvcvRecord => ({ licenseNumber: `TL-DEMO-${license}`, address, credit });
export const avcvRegister: AvcvRecord[] = [
  avcv(100201), avcv(100202), avcv(100203), avcv(100204), avcv(100205), avcv(100206, 'POSITIVE', 'NEGATIVE'), avcv(100207), avcv(100208), avcv(100209),
  avcv(100210, 'DISCREPANCY'), avcv(100211, 'UNABLE_TO_VERIFY'), avcv(100212, 'INSUFFICIENT_INFORMATION'),
];

/** The chatbot recognises a company only if it is in the trade-licence register (otherwise the customer is a new lead). */
export function findKnownBusiness(businessName: string): TradeLicenseRecord | undefined {
  return tradeLicenseRegister.find((entry) => businessNamesMatch(entry.businessName, businessName));
}

// ------------------------------------------------------------------------------------------------------------------
// The five checks (pure)
// ------------------------------------------------------------------------------------------------------------------

export interface StoredDocument { evidenceId: string; fields: DocumentFields; }
export interface CheckContext {
  businessName: string; representativeName: string; asOf: Date;
  /** Latest accepted or received document of each type (uploaded by the customer in the chat). */
  documents: Partial<Record<DocumentType, StoredDocument>>;
}
export interface CheckOutcome {
  status: 'PASS' | 'PASS_WITH_FLAG' | 'FAIL' | 'INCONCLUSIVE';
  ruleIds: string[]; reasonCodes: string[]; findings: Record<string, unknown>; confidence: number; recommendedNextStep: string; humanReviewRequired: boolean; evidenceReferences: string[];
}

const text = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] : value) ?? '';
const references = (context: CheckContext, ...types: DocumentType[]): string[] => types.map((type) => context.documents[type]?.evidenceId).filter((id): id is string => Boolean(id));
const expired = (date: string | undefined, asOf: Date): boolean => { const parsed = parseDocumentDate(date); return parsed !== undefined && parsed.getTime() < asOf.getTime(); };
const maskId = (value: string): string => value.replace(/^(\d{3}-\d{4}-)\d{7}(-\d)$/, '$1•••••••$2');

function outcome(status: CheckOutcome['status'], ruleId: string, reasonCode: string, findings: Record<string, unknown>, recommendedNextStep: string, evidence: string[], options: { confidence?: number; humanReview?: boolean } = {}): CheckOutcome {
  return { status, ruleIds: [ruleId], reasonCodes: [reasonCode], findings, confidence: options.confidence ?? (status === 'PASS' ? 0.95 : 0.9), recommendedNextStep, humanReviewRequired: options.humanReview ?? status === 'FAIL', evidenceReferences: evidence };
}

/** The licence record the customer's documents point to: by licence number, else by the licence's QR code (the "TL not readable → QR check" branch). */
function resolveLicense(context: CheckContext): { record?: TradeLicenseRecord; via: 'LICENSE_NUMBER' | 'QR_CODE' | 'NONE'; printedNumber: string } {
  const licence = context.documents.TRADE_LICENSE?.fields ?? {};
  const printedNumber = text(licence.licenseNumber) || text(context.documents.ESTABLISHMENT_CARD?.fields.licenseNumber);
  const byNumber = printedNumber ? tradeLicenseRegister.find((entry) => entry.licenseNumber.toUpperCase() === printedNumber.toUpperCase()) : undefined;
  if (byNumber) return { record: byNumber, via: 'LICENSE_NUMBER', printedNumber };
  const qr = text(licence.qrCode);
  const byQr = qr ? tradeLicenseRegister.find((entry) => entry.qrToken.toUpperCase() === qr.toUpperCase()) : undefined;
  return byQr ? { record: byQr, via: 'QR_CODE', printedNumber } : { via: 'NONE', printedNumber };
}

const hasRepresentativeAuthority = (person: RecordedPerson | undefined): person is RecordedPerson => person !== undefined && person.capacity !== 'LISTED_NO_AUTHORITY';
const recordedPerson = (record: TradeLicenseRecord, name: string): RecordedPerson | undefined => record.persons.find((person) => sameName(person.name, name));
/** Whether the approved source records this person as someone who may grant authority (owner, manager with representative authority, authorised signatory). */
const canGrantAuthority = (record: TradeLicenseRecord, name: string): boolean => hasRepresentativeAuthority(recordedPerson(record, name));
function tradeLicenseCheck(context: CheckContext): CheckOutcome {
  const licence = context.documents.TRADE_LICENSE;
  const card = context.documents.ESTABLISHMENT_CARD;
  const evidence = references(context, 'TRADE_LICENSE', 'ESTABLISHMENT_CARD');
  const resolved = resolveLicense(context);
  if (!licence || (!text(licence.fields.licenseNumber) && !text(licence.fields.qrCode))) {
    return outcome('INCONCLUSIVE', 'TL-001', 'DOCUMENT_UNREADABLE', { missing: ['TRADE_LICENSE'], conflicts: [], licence_number_readable: false, qr_code_readable: false }, 'Ask the customer for a readable Trade License (or one with a scannable QR code).', evidence, { confidence: 0.6 });
  }
  const record = resolved.record;
  if (!record) return outcome('INCONCLUSIVE', 'TL-005', 'LICENSE_NOT_VERIFIABLE', { printed_license_number: resolved.printedNumber, verified: false, conflicts: [] }, 'The licence could not be matched in the licence register; route to a specialist. An unavailable or unmatched lookup is never treated as proof the business is invalid.', evidence, { confidence: 0.5, humanReview: true });
  const channel = record.dulApiAvailable ? 'DUL_API' : 'GOVERNMENT_PORTAL_UAE_PASS';
  const findings: Record<string, unknown> = { license_number: record.licenseNumber, matched_via: resolved.via, verification_channel: channel, dul_api_available: record.dulApiAvailable, register_expiry_date: record.expiryDate, register_status: record.status, conflicts: [] as string[] };
  const conflicts = findings.conflicts as string[];
  const printedNames = [licence.fields.businessName, card?.fields.businessName].map(text).filter(Boolean);
  const nameOk = businessNamesMatch(record.businessName, context.businessName) && printedNames.every((name) => businessNamesMatch(record.businessName, name));
  const cardMatches = !card || !text(card.fields.licenseNumber) || text(card.fields.licenseNumber).toUpperCase() === record.licenseNumber.toUpperCase();
  if (record.status !== 'ACTIVE') { conflicts.push(`The trade licence status is ${record.status}.`); return outcome('FAIL', 'TL-003', 'TRADE_LICENSE_INACTIVE', findings, 'Reject the request: the trade licence is not active. Draft the customer email and request root-cause analysis.', evidence); }
  if (expired(record.expiryDate, context.asOf) || expired(text(licence.fields.expiryDate), context.asOf)) { conflicts.push('The trade licence has expired.'); return outcome('FAIL', 'TL-002', 'TRADE_LICENSE_EXPIRED', findings, 'Reject the request: the trade licence has expired. Draft the customer email and request root-cause analysis.', evidence); }
  if (!nameOk || !cardMatches) { conflicts.push('The business name on the Trade License / Establishment Card does not match the request or the licence register.'); return outcome('FAIL', 'TL-004', 'BUSINESS_NAME_MISMATCH', findings, 'Reject the request: the business name does not match. Draft the customer email and request root-cause analysis.', evidence); }
  return outcome(record.dulApiAvailable ? 'PASS' : 'PASS_WITH_FLAG', 'TL-000', record.dulApiAvailable ? 'TRADE_LICENSE_VALID' : 'TRADE_LICENSE_VALID_VIA_PORTAL', findings, 'Continue with identity validation.', evidence);
}

function identityValidation(context: CheckContext): CheckOutcome {
  const card = context.documents.EMIRATES_ID;
  const evidence = references(context, 'EMIRATES_ID', 'TRADE_LICENSE', 'ESTABLISHMENT_CARD');
  const printedNumber = text(card?.fields.idNumber);
  const printedName = text(card?.fields.fullName);
  if (!card || !printedNumber || !printedName) return outcome('INCONCLUSIVE', 'ID-004', 'EID_UNREADABLE', { missing: ['EMIRATES_ID'], conflicts: [] }, 'Ask the customer for a readable Emirates ID.', evidence, { confidence: 0.6 });
  const record = emiratesIdRegister.find((entry) => entry.idNumber === printedNumber);
  if (!record) return outcome('INCONCLUSIVE', 'ID-003', 'IDENTITY_NOT_VERIFIABLE', { verified: false, emirates_id: maskId(printedNumber), conflicts: [] }, 'The Emirates ID could not be matched in the identity register; route to a specialist.', evidence, { confidence: 0.5, humanReview: true });
  const findings: Record<string, unknown> = { emirates_id: maskId(printedNumber), name_on_id_matches_register: sameName(record.fullName, printedName), name_on_id_matches_request: sameName(printedName, context.representativeName), conflicts: [] as string[] };
  const conflicts = findings.conflicts as string[];
  if (!sameName(record.fullName, printedName)) conflicts.push('The name printed on the Emirates ID does not match the identity register.');
  if (!sameName(printedName, context.representativeName)) conflicts.push('The name on the Emirates ID does not match the name given in the request.');
  const license = resolveLicense(context).record;
  if (license) findings.recorded_capacity = recordedPerson(license, printedName)?.capacity ?? 'NOT_RECORDED';
  if (conflicts.length > 0) return outcome('FAIL', 'ID-001', 'IDENTITY_MISMATCH', findings, 'Reject the request: the Emirates ID, licence records and request names do not match. Draft the customer email and request root-cause analysis.', evidence);
  if (expired(record.expiryDate, context.asOf) || expired(text(card.fields.expiryDate), context.asOf)) { conflicts.push('The Emirates ID has expired.'); return outcome('INCONCLUSIVE', 'ID-002', 'EID_EXPIRED', { ...findings, missing: ['EMIRATES_ID'] }, 'Ask the customer for a valid (unexpired) Emirates ID.', evidence, { confidence: 0.85, humanReview: false }); }
  return outcome('PASS', 'ID-000', 'IDENTITY_VERIFIED', findings, 'Continue with the POA/MOA check.', evidence);
}

/**
 * A person is authorised WITHOUT a separate POA/MOA only when all five hold: (1) the ID is verified (this check runs after identity), (2) the
 * approved source records them as owner, manager with representative authority or authorised signatory, (3) that capacity covers the requested
 * action, (4) the licence and registration are current and consistent (the Trade License check has passed), (5) there is no conflicting evidence
 * or limitation on their authority. Otherwise a POA/MOA is required, and a recorded limitation is a specialist decision, not something a POA overrides.
 */
function poaMoaCheck(context: CheckContext): CheckOutcome {
  const printedName = text(context.documents.EMIRATES_ID?.fields.fullName) || context.representativeName;
  const license = resolveLicense(context).record;
  const evidence = references(context, 'EMIRATES_ID', 'POA_MOA');
  const person = license ? recordedPerson(license, printedName) : undefined;
  if (person?.limitation) return outcome('INCONCLUSIVE', 'POA-004', 'AUTHORITY_LIMITED', { poa_moa_required: false, recorded_capacity: person.capacity, conflicts: ['A limitation is recorded on this person\'s authority.'] }, 'A limitation or conflicting evidence is recorded on the person\'s authority; a specialist decides.', evidence, { confidence: 0.6, humanReview: true });
  const missingScopes = person ? requiredAuthorityScopes.filter((scope) => !person.scopes.includes(scope)) : [...requiredAuthorityScopes];
  if (hasRepresentativeAuthority(person) && missingScopes.length === 0) return outcome('PASS', 'POA-000', 'POA_MOA_NOT_REQUIRED', { poa_moa_required: false, recorded_capacity: person.capacity, basis: 'The approved record gives this person a capacity that covers the requested actions.', conflicts: [] }, 'Continue with the bad debt check.', evidence);
  const why = !person ? 'The person is not recorded with representative authority.' : !hasRepresentativeAuthority(person) ? 'The person is listed without representative authority.' : 'The recorded capacity does not cover every requested action.';
  const poa = context.documents.POA_MOA;
  if (!poa) return outcome('INCONCLUSIVE', 'POA-001', 'POA_MOA_MISSING', { poa_moa_required: true, poa_moa_reason: why, recorded_capacity: person?.capacity ?? 'NOT_RECORDED', missing: ['POA_MOA'], conflicts: [] }, 'Ask the customer for a Power of Attorney or Memorandum of Association authorising the representative.', evidence, { confidence: 0.9, humanReview: false });
  const reference = text(poa.fields.reference);
  const record = poaRegister.find((entry) => entry.reference.toUpperCase() === reference.toUpperCase());
  if (!record) return outcome('INCONCLUSIVE', 'POA-003', 'POA_MOA_NOT_VERIFIABLE', { poa_moa_required: true, reference, verified: false, conflicts: [] }, 'The POA/MOA reference could not be matched; route to a specialist.', evidence, { confidence: 0.5, humanReview: true });
  const conflicts: string[] = [];
  if (!sameName(record.grantee, printedName)) conflicts.push('The POA/MOA was not granted to this representative.');
  if (license && !businessNamesMatch(record.businessName, license.businessName)) conflicts.push('The POA/MOA is for a different business.');
  if (license && !canGrantAuthority(license, record.grantor)) conflicts.push('The POA/MOA was not granted by a person recorded with authority to grant it.');
  if (expired(record.validUntil, context.asOf) || expired(text(poa.fields.validUntil), context.asOf)) conflicts.push('The POA/MOA has expired.');
  const uncovered = requiredAuthorityScopes.filter((scope) => !record.scopes.includes(scope));
  if (uncovered.length > 0) conflicts.push('The POA/MOA does not cover every requested permission.');
  const findings = { poa_moa_required: true, poa_moa_reason: why, reference: record.reference, conflicts, missing_scopes: uncovered };
  if (conflicts.length > 0) return outcome('FAIL', 'POA-002', 'POA_MOA_NOT_CLEARED', findings, 'Reject the request: the POA/MOA checks were not cleared. Draft the customer email and request root-cause analysis.', evidence);
  return outcome('PASS', 'POA-000', 'POA_MOA_CLEARED', findings, 'Continue with the bad debt check.', evidence);
}
function badDebtCheck(context: CheckContext): CheckOutcome {
  const printedName = text(context.documents.EMIRATES_ID?.fields.fullName) || context.representativeName;
  const licenseNumber = resolveLicense(context).record?.licenseNumber ?? '';
  const parties = partyRegister.filter((party) => (licenseNumber !== '' && party.licenseNumber === licenseNumber) || sameName(party.holderName, printedName));
  const evidence = references(context, 'EMIRATES_ID', 'TRADE_LICENSE');
  const owing = parties.filter((party) => party.badDebtAed > 0);
  const findings: Record<string, unknown> = { party_ids_checked: parties.map((party) => party.partyId), duplicate_party_ids: parties.length > 1, parties_with_bad_debt: owing.map((party) => party.partyId), conflicts: [] as string[] };
  const conflicts = findings.conflicts as string[];
  if (owing.length > 0) { conflicts.push('Outstanding bad debt exists on an account linked to this business or person.'); return outcome('FAIL', 'BD-001', 'BAD_DEBT_OBSERVED', findings, 'Reject the request: bad debt was observed. Draft the customer email and request root-cause analysis.', evidence); }
  if (parties.some((party) => party.blueCollarFlag)) { conflicts.push('Blue-collar behaviour was observed on a linked party.'); return outcome('FAIL', 'BD-002', 'BLUE_COLLAR_OBSERVED', findings, 'Reject the request: blue-collar behaviour was observed. Draft the customer email and request root-cause analysis.', evidence); }
  return outcome('PASS', 'BD-000', 'NO_BAD_DEBT', findings, 'Continue with AVCV verification.', evidence);
}

/**
 * AVCV = Address Verification and Credit Verification. Each half has an outcome: POSITIVE (verified), NEGATIVE (adverse), DISCREPANCY (details do not
 * match), UNABLE_TO_VERIFY (could not be established: NOT a failure), REFER (needs review) or INSUFFICIENT_INFORMATION (more evidence needed).
 * Only an adverse result is a rejection; everything else asks for a document or goes to a specialist.
 */
function avcvVerification(context: CheckContext): CheckOutcome {
  const record = resolveLicense(context).record;
  const avcvRecord = avcvRegister.find((entry) => entry.licenseNumber === record?.licenseNumber);
  const evidence = references(context, 'TRADE_LICENSE', 'ADDRESS_PROOF');
  const proof = context.documents.ADDRESS_PROOF;
  const proofMatches = proof !== undefined && Boolean(record) && (businessNamesMatch(text(proof.fields.holderName), record!.businessName) || sameName(text(proof.fields.holderName), record!.ownerName));
  const results = avcvRecord ? [avcvRecord.address, avcvRecord.credit] : [];
  const findings = { address_result: avcvRecord?.address ?? 'NOT_AVAILABLE', credit_result: avcvRecord?.credit ?? 'NOT_AVAILABLE', address_proof_received: proof !== undefined, conflicts: [] as string[] };
  if (!avcvRecord) return outcome('INCONCLUSIVE', 'AV-002', 'AVCV_UNVERIFIED', findings, 'AVCV could not be established; route to a specialist. This is not a failure.', evidence, { confidence: 0.5, humanReview: true });
  if (results.includes('NEGATIVE')) { findings.conflicts.push('Address or credit verification returned an adverse result.'); return outcome('FAIL', 'AV-001', 'AVCV_ADVERSE', findings, 'Reject the request: the address or credit verification is adverse. Draft the customer email and request root-cause analysis.', evidence); }
  if (results.includes('DISCREPANCY')) { findings.conflicts.push('Address or credit details do not match.'); return outcome('INCONCLUSIVE', 'AV-003', 'AVCV_DISCREPANCY', findings, 'A discrepancy was found in the address or credit details; a specialist reviews it.', evidence, { confidence: 0.6, humanReview: true }); }
  if (results.includes('REFER') || results.includes('UNABLE_TO_VERIFY')) return outcome('INCONCLUSIVE', 'AV-002', 'AVCV_UNVERIFIED', findings, 'AVCV could not be completed (unable to verify, or referred for review); a specialist decides. Unable to verify is not a failure.', evidence, { confidence: 0.5, humanReview: true });
  if (results.includes('INSUFFICIENT_INFORMATION') && !proofMatches) return outcome('INCONCLUSIVE', 'AV-004', 'AVCV_INSUFFICIENT_INFORMATION', { ...findings, missing: ['ADDRESS_PROOF'] }, 'Ask the customer for proof of address so the verification can be completed.', evidence, { confidence: 0.85, humanReview: false });
  return outcome('PASS', 'AV-000', 'AVCV_POSITIVE', findings, 'Approve the request and share the communication with the stakeholders.', evidence);
}
export function evaluateLoaCheck(checkType: string, context: CheckContext): CheckOutcome {
  switch (checkType.toUpperCase()) {
    case 'TRADE_LICENSE_CHECK': return tradeLicenseCheck(context);
    case 'IDENTITY_VALIDATION': return identityValidation(context);
    case 'POA_MOA_CHECK': return poaMoaCheck(context);
    case 'BAD_DEBT_CHECK': return badDebtCheck(context);
    case 'AVCV_VERIFICATION': return avcvVerification(context);
    default: throw new Error(`UNSUPPORTED_CHECK_TYPE:${checkType}`);
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Decision rules and SBO.11 communication templates
// ------------------------------------------------------------------------------------------------------------------

function rule(priority: number, ruleId: string, stage: string, condition: string, finalOutcome: string, reasonCode: string, options: { review?: boolean; next?: string; queue?: string; template?: string; agent?: string } = {}): DecisionRule {
  return { priority, ruleId, stage, condition, requiredEvidence: '', utilityAgent: options.agent ?? '', checkResult: '', finalOutcome, reasonCode, humanReviewRequired: options.review ?? false, nextAction: options.next ?? '', targetQueue: options.queue ?? '', communicationTemplateId: options.template ?? 'COMM-REVIEW', ruleOwner: 'To-Be process (E&SMB-BO)', ruleStatus: 'CONFIRMED_POC', notes: 'Derived from the To-Be process diagrams (docs/09).' };
}
const reject = (queue = 'REJECTION_REVIEW'): { review: boolean; queue: string; template: string } => ({ review: true, queue, template: 'COMM-REJECT' });
export const loaDecisionRules: DecisionRule[] = [
  rule(10, 'TL-001', 'TRADE_LICENSE_CHECK', 'Trade licence not readable and no scannable QR code', 'NEED_MORE_INFORMATION', 'DOCUMENT_UNREADABLE', { next: 'Ask the customer to re-upload a readable Trade License.', queue: 'CUSTOMER_FOLLOW_UP', template: 'COMM-NEED-INFO', agent: 'SBO.06' }),
  rule(11, 'TL-002', 'TRADE_LICENSE_CHECK', 'Trade licence expired', 'REJECT', 'TRADE_LICENSE_EXPIRED', { ...reject(), next: 'Confirm the rejection, send the drafted email (SBO.11) and review the root-cause analysis (SBO.20).', agent: 'SBO.06' }),
  rule(12, 'TL-003', 'TRADE_LICENSE_CHECK', 'Trade licence not active', 'REJECT', 'TRADE_LICENSE_INACTIVE', { ...reject(), next: 'Confirm the rejection, send the drafted email (SBO.11) and review the root-cause analysis (SBO.20).', agent: 'SBO.06' }),
  rule(13, 'TL-004', 'TRADE_LICENSE_CHECK', 'Business name on the licence / Establishment Card does not match', 'REJECT', 'BUSINESS_NAME_MISMATCH', { ...reject(), next: 'Confirm the rejection, send the drafted email (SBO.11) and review the root-cause analysis (SBO.20).', agent: 'SBO.06' }),
  rule(14, 'TL-005', 'TRADE_LICENSE_CHECK', 'Licence could not be matched in the register', 'MANUAL_REVIEW', 'LICENSE_NOT_VERIFIABLE', { review: true, queue: 'TRADE_LICENSE_REVIEW', next: 'A specialist verifies the licence manually.', agent: 'SBO.06' }),
  rule(15, 'TL-000', 'TRADE_LICENSE_CHECK', 'Trade licence valid and names match', 'CONTINUE', 'TRADE_LICENSE_VALID', { agent: 'SBO.06' }),
  rule(20, 'ID-004', 'IDENTITY_VALIDATION', 'Emirates ID not readable', 'NEED_MORE_INFORMATION', 'EID_UNREADABLE', { next: 'Ask the customer to re-upload a readable Emirates ID.', queue: 'CUSTOMER_FOLLOW_UP', template: 'COMM-NEED-INFO', agent: 'SBO.07' }),
  rule(21, 'ID-002', 'IDENTITY_VALIDATION', 'Emirates ID expired', 'NEED_MORE_INFORMATION', 'EID_EXPIRED', { next: 'Ask the customer for a valid Emirates ID.', queue: 'CUSTOMER_FOLLOW_UP', template: 'COMM-NEED-INFO', agent: 'SBO.07' }),
  rule(22, 'ID-001', 'IDENTITY_VALIDATION', 'EID, licence records and request names do not match', 'REJECT', 'IDENTITY_MISMATCH', { ...reject(), next: 'Confirm the rejection, send the drafted email (SBO.11) and review the root-cause analysis (SBO.20).', agent: 'SBO.07' }),
  rule(23, 'ID-003', 'IDENTITY_VALIDATION', 'Emirates ID not found in the identity register', 'MANUAL_REVIEW', 'IDENTITY_NOT_VERIFIABLE', { review: true, queue: 'IDENTITY_REVIEW', next: 'A specialist verifies the identity manually.', agent: 'SBO.07' }),
  rule(24, 'ID-000', 'IDENTITY_VALIDATION', 'Identity verified', 'CONTINUE', 'IDENTITY_VERIFIED', { agent: 'SBO.07' }),
  rule(30, 'POA-001', 'POA_MOA_CHECK', 'Representative is not the owner/signatory and no POA/MOA was provided', 'NEED_MORE_INFORMATION', 'POA_MOA_MISSING', { next: 'Ask the customer for a POA or MOA.', queue: 'CUSTOMER_FOLLOW_UP', template: 'COMM-NEED-INFO', agent: 'SBO.02' }),
  rule(31, 'POA-002', 'POA_MOA_CHECK', 'POA/MOA checks not cleared', 'REJECT', 'POA_MOA_NOT_CLEARED', { ...reject(), next: 'Confirm the rejection, send the drafted email (SBO.11) and review the root-cause analysis (SBO.20).', agent: 'SBO.02' }),
  rule(32, 'POA-003', 'POA_MOA_CHECK', 'POA/MOA reference not found', 'MANUAL_REVIEW', 'POA_MOA_NOT_VERIFIABLE', { review: true, queue: 'POA_MOA_REVIEW', next: 'A specialist verifies the POA/MOA manually.', agent: 'SBO.02' }),
  rule(34, 'POA-004', 'POA_MOA_CHECK', 'A limitation or conflicting evidence is recorded on the person\'s authority', 'MANUAL_REVIEW', 'AUTHORITY_LIMITED', { review: true, queue: 'AUTHORITY_REVIEW', next: 'A specialist reviews the recorded limitation.', agent: 'SBO.02' }),
  rule(33, 'POA-000', 'POA_MOA_CHECK', 'POA/MOA not required or cleared', 'CONTINUE', 'POA_MOA_CLEARED', { agent: 'SBO.02' }),
  rule(40, 'BD-001', 'BAD_DEBT_CHECK', 'Bad debt observed on a linked party', 'REJECT', 'BAD_DEBT_OBSERVED', { ...reject(), next: 'Confirm the rejection, send the drafted email (SBO.11) and review the root-cause analysis (SBO.20).', agent: 'SBO.09' }),
  rule(41, 'BD-002', 'BAD_DEBT_CHECK', 'Blue-collar behaviour observed', 'REJECT', 'BLUE_COLLAR_OBSERVED', { ...reject(), next: 'Confirm the rejection, send the drafted email (SBO.11) and review the root-cause analysis (SBO.20).', agent: 'SBO.09' }),
  rule(42, 'BD-000', 'BAD_DEBT_CHECK', 'No bad debt or blue-collar behaviour', 'CONTINUE', 'NO_BAD_DEBT', { agent: 'SBO.09' }),
  rule(50, 'AV-001', 'AVCV_VERIFICATION', 'Address or credit verification adverse', 'REJECT', 'AVCV_ADVERSE', { ...reject(), next: 'Confirm the rejection, send the drafted email (SBO.11) and review the root-cause analysis (SBO.20).', agent: 'SBO.10' }),
  rule(51, 'AV-002', 'AVCV_VERIFICATION', 'AVCV unable to verify or referred (not a failure)', 'MANUAL_REVIEW', 'AVCV_UNVERIFIED', { review: true, queue: 'AVCV_REVIEW', next: 'A specialist completes the address and credit verification.', agent: 'SBO.10' }),
  rule(53, 'AV-003', 'AVCV_VERIFICATION', 'Address or credit discrepancy', 'MANUAL_REVIEW', 'AVCV_DISCREPANCY', { review: true, queue: 'AVCV_REVIEW', next: 'A specialist reviews the discrepancy.', agent: 'SBO.10' }),
  rule(54, 'AV-004', 'AVCV_VERIFICATION', 'Insufficient information to verify the address', 'NEED_MORE_INFORMATION', 'AVCV_INSUFFICIENT_INFORMATION', { next: 'Ask the customer for proof of address.', queue: 'CUSTOMER_FOLLOW_UP', template: 'COMM-NEED-INFO', agent: 'SBO.10' }),
  rule(52, 'AV-000', 'AVCV_VERIFICATION', 'Address and credit verification positive', 'CONTINUE', 'AVCV_POSITIVE', { agent: 'SBO.10' }),  rule(900, 'CTRL-001', 'GOVERNANCE', 'A rule marked TBD was reached: never approve or reject on it', 'MANUAL_REVIEW', 'TBD_POLICY', { review: true, queue: 'POLICY_REVIEW', next: 'Route to the policy owner.', template: 'COMM-REVIEW' }),
  rule(901, 'CTRL-002', 'GOVERNANCE', 'No persisted utility results exist for this case', 'MANUAL_REVIEW', 'AGENT_TOOL_RESULTS_MISSING', { review: true, queue: 'AGENT_OPERATIONS_REVIEW', next: 'Route to agent operations and rerun the assessment.', template: 'COMM-REVIEW' }),
  rule(902, 'CTRL-003', 'GOVERNANCE', 'A mandatory check has not run', 'MANUAL_REVIEW', 'MANDATORY_CHECKS_INCOMPLETE', { review: true, queue: 'AGENT_OPERATIONS_REVIEW', next: 'Route to agent operations and rerun all mandatory checks.', template: 'COMM-REVIEW' }),
  rule(999, 'FINAL-001', 'FINAL', 'Every mandatory check passed', 'APPROVE', 'ALL_CHECKS_PASSED', { queue: 'ORDER_READINESS', next: 'Proceed to the controlled operational step. No production write-back has been performed.', template: 'COMM-APPROVE' }),
];

export const loaCommunicationTemplates: CommunicationTemplate[] = [
  { templateId: 'COMM-APPROVE', outcome: 'APPROVE', audience: 'CUSTOMER', subjectTemplate: 'Authorised representative request {case_id}: approved to proceed', bodyTemplate: 'Dear {representative_name}, the request for {business_name} (case {case_id}) has passed every check and can proceed to the next step. This is a synthetic draft and has not been sent.', approvalRequired: true },
  { templateId: 'COMM-NEED-INFO', outcome: 'NEED_MORE_INFORMATION', audience: 'CUSTOMER', subjectTemplate: 'Authorised representative request {case_id}: more information needed', bodyTemplate: 'Dear {representative_name}, to continue the request for {business_name} (case {case_id}) please provide: {missing_items}. This is a synthetic draft and has not been sent.', approvalRequired: true },
  { templateId: 'COMM-REVIEW', outcome: 'MANUAL_REVIEW', audience: 'CUSTOMER', subjectTemplate: 'Authorised representative request {case_id}: under specialist review', bodyTemplate: 'Dear {representative_name}, your request for {business_name} (case {case_id}) has been passed to a specialist ({queue}). This is a synthetic draft and has not been sent.', approvalRequired: true },
  { templateId: 'COMM-REJECT', outcome: 'REJECT', audience: 'CUSTOMER', subjectTemplate: 'Authorised representative request {case_id}: unable to proceed', bodyTemplate: 'Dear {representative_name}, we are unable to proceed with the request for {business_name} (case {case_id}). Reason: {reason_code}. This is a synthetic draft pending human confirmation and has not been sent.', approvalRequired: true },
];

// ------------------------------------------------------------------------------------------------------------------
// SBO.20 root-cause analysis (deterministic summary of why a request was rejected)
// ------------------------------------------------------------------------------------------------------------------

const rootCauses: Record<string, { cause: string; action: string }> = {
  TRADE_LICENSE_EXPIRED: { cause: 'The trade licence had expired when the request was made.', action: 'Customer renews the licence, then a new request is opened.' },
  TRADE_LICENSE_INACTIVE: { cause: 'The trade licence is suspended or cancelled.', action: 'Customer resolves the licence status with the licensing authority.' },
  BUSINESS_NAME_MISMATCH: { cause: 'The business name on the request, Trade License and Establishment Card is inconsistent.', action: 'Customer supplies matching, current documents.' },
  IDENTITY_MISMATCH: { cause: 'The name on the Emirates ID does not agree with the identity register or the request.', action: 'Customer supplies the correct Emirates ID or corrects the request.' },
  POA_MOA_NOT_CLEARED: { cause: 'The POA/MOA is expired, was not granted to this person, is for another business, or does not cover the requested permissions.', action: 'Customer supplies a valid POA/MOA.' },
  BAD_DEBT_OBSERVED: { cause: 'Outstanding bad debt exists on a party linked to the licence or the person.', action: 'Customer settles the debt; account team reviews.' },
  BLUE_COLLAR_OBSERVED: { cause: 'Blue-collar behaviour was observed on a linked party.', action: 'Compliance team reviews before any new request.' },
  AVCV_ADVERSE: { cause: 'The address or credit verification returned an adverse result.', action: 'Account team reviews the address and credit findings with the customer.' },
};
export interface RootCauseAnalysis { reasonCode: string; failedCheck: string; rootCause: string; recommendedAction: string; }
export function buildRootCauseAnalysis(reasonCode: string, failedCheck: string): RootCauseAnalysis {
  const known = rootCauses[reasonCode];
  return { reasonCode, failedCheck, rootCause: known?.cause ?? 'The request did not meet a mandatory condition.', recommendedAction: known?.action ?? 'A specialist reviews the case.' };
}
