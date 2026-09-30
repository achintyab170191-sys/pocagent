/**
 * Content review of the supporting documents (Emirates ID, Trade License, Establishment Card, proof of address), in the same spirit as the
 * authority-document assessment: before a document is accepted the agent reads it — are the details it must show present, valid and
 * consistent with the request and with the other documents? — and, when they are not, the customer is told exactly what is wrong and asked to
 * upload again ("insufficient evidence"). Deterministic (no model); the document is data, never instructions.
 *
 * What a review does NOT do: it never decides a fact the registers decide. A licence that is inactive or expired, an Emirates ID whose number
 * is registered to someone else, an adverse credit result — those stay with the checks (and a rejection stays a human's to confirm). A review
 * only reports what the customer can fix by attaching a better document, or that the content cannot be trusted (an embedded instruction).
 */
import { businessNamesMatch, parseDocumentDate, sameName, type DocumentFields, type DocumentType, type EmiratesIdRecord, type TradeLicenseRecord } from './loa.js';
import { findEmbeddedInstruction } from './authority.js';

export type GapCode = 'MISSING' | 'FORMAT' | 'MISMATCH' | 'EXPIRED' | 'INCONSISTENT' | 'UNACCEPTABLE' | 'STALE';
export interface DocumentGap { code: GapCode; text: string; }
export interface DocumentReview {
  documentType: DocumentType;
  verdict: 'SUFFICIENT' | 'INSUFFICIENT' | 'UNCERTAIN';
  gaps: DocumentGap[];
  /** Facts that were checked and found in order (shown to the reviewer, and as supported facts on an accepted request). */
  facts: string[];
  /** UNCERTAIN: why a human must look. */
  reasons: string[];
  securityFinding: boolean;
}
export interface ReviewedDocument { fields: DocumentFields; text?: string; }
export interface DocumentReviewContext {
  representativeName: string; businessName: string; asOf: Date;
  /** The latest document of each type in the case (for consistency between documents). */
  documents: Partial<Record<DocumentType, ReviewedDocument>>;
  /** The licence record the documents point to (by licence number or QR code), when it is on record. */
  license?: TradeLicenseRecord;
  /** The identity-register record for the Emirates ID number that was printed, when there is one. */
  idRecord?: EmiratesIdRecord;
}

const clean = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] : value)?.toString().trim() ?? '';
const day = 86_400_000;
const acceptedAddressKinds = /utility|electricity|water|gas|dewa|sewa|addc|etisalat|\bdu\b|telecom|internet|tenancy|ejari|lease|rent|bank\s+statement|title\s+deed/i;

function review(documentType: DocumentType, document: ReviewedDocument, build: (gap: (code: GapCode, text: string) => void, fact: (text: string) => void) => void): DocumentReview {
  const gaps: DocumentGap[] = []; const facts: string[] = []; const reasons: string[] = [];
  const injected = findEmbeddedInstruction(document.text ?? '');
  if (injected) reasons.push('The document contains text that tries to instruct the review process; it was ignored and a specialist should look at it.');
  build((code, text) => gaps.push({ code, text }), (text) => facts.push(text));
  return { documentType, verdict: reasons.length > 0 ? 'UNCERTAIN' : gaps.length > 0 ? 'INSUFFICIENT' : 'SUFFICIENT', gaps, facts, reasons, securityFinding: Boolean(injected) };
}

function reviewEmiratesId(document: ReviewedDocument, context: DocumentReviewContext): DocumentReview {
  return review('EMIRATES_ID', document, (gap, fact) => {
    const number = clean(document.fields.idNumber); const name = clean(document.fields.fullName); const expiry = clean(document.fields.expiryDate);
    if (!number) gap('MISSING', 'The Emirates ID does not show a readable ID number.');
    else if (!/^784-\d{4}-\d{7}-\d$/.test(number)) gap('FORMAT', `The ID number ${number} is not a valid Emirates ID number (expected 784-YYYY-NNNNNNN-N).`);
    else if (Number(number.split('-')[1]) < 1900 || Number(number.split('-')[1]) > context.asOf.getUTCFullYear()) gap('FORMAT', `The birth year in the ID number ${number} is not plausible.`);
    else fact(`The ID number ${number.replace(/^(\d{3}-\d{4}-)\d{7}(-\d)$/, '$1•••••••$2')} is well formed.`);
    if (!name) gap('MISSING', 'The Emirates ID does not show a readable name.');
    if (!expiry) gap('MISSING', 'The Emirates ID does not show a readable expiry date.');
    else if (!parseDocumentDate(expiry)) gap('FORMAT', `The expiry date on the Emirates ID (${expiry}) could not be read.`);
    else if ((parseDocumentDate(expiry)?.getTime() ?? Infinity) < context.asOf.getTime()) gap('EXPIRED', `The Emirates ID expired on ${expiry}.`);
    else fact(`The Emirates ID is valid until ${expiry}.`);
    // A genuine ID of somebody else: the register knows this number and the printed name agrees with it, but it is not the person asking.
    if (name && context.idRecord && sameName(context.idRecord.fullName, name) && !sameName(name, context.representativeName)) gap('MISMATCH', `The Emirates ID belongs to ${name}, but the request is from ${context.representativeName}. Please attach the representative's own Emirates ID.`);
    else if (name && sameName(name, context.representativeName)) fact(`The name on the Emirates ID matches ${context.representativeName}.`);
  });
}

function reviewTradeLicense(document: ReviewedDocument, context: DocumentReviewContext): DocumentReview {
  return review('TRADE_LICENSE', document, (gap, fact) => {
    const number = clean(document.fields.licenseNumber); const qr = clean(document.fields.qrCode); const business = clean(document.fields.businessName);
    const holder = clean(document.fields.licenseHolder); const expiry = clean(document.fields.expiryDate);
    if (!number && !qr) gap('MISSING', 'The Trade License shows neither a readable licence number nor a scannable QR code.');
    if (!business) gap('MISSING', 'The Trade License does not show the business name.');
    else if (context.license && !businessNamesMatch(context.license.businessName, business)) { /* the printed name contradicts the register: the licence check decides */ }
    else if (!businessNamesMatch(business, context.businessName)) gap('MISMATCH', `The Trade License is for ${business}, but the request is for ${context.businessName}.`);
    else fact(`The Trade License is issued to ${business}.`);
    if (!holder) gap('MISSING', 'The Trade License does not name the licence holder.');
    if (!expiry) gap('MISSING', 'The Trade License does not show an expiry date.');
    else if (!parseDocumentDate(expiry)) gap('FORMAT', `The expiry date on the Trade License (${expiry}) could not be read.`);
  });
}

function reviewEstablishmentCard(document: ReviewedDocument, context: DocumentReviewContext): DocumentReview {
  return review('ESTABLISHMENT_CARD', document, (gap, fact) => {
    const business = clean(document.fields.businessName); const number = clean(document.fields.licenseNumber); const expiry = clean(document.fields.expiryDate);
    const signatories = Array.isArray(document.fields.signatories) ? document.fields.signatories : [clean(document.fields.signatories)].filter(Boolean);
    if (!business) gap('MISSING', 'The Establishment Card does not show the business name.');
    else if (!businessNamesMatch(business, context.businessName)) gap('MISMATCH', `The Establishment Card is for ${business}, but the request is for ${context.businessName}.`);
    else fact(`The Establishment Card is issued to ${business}.`);
    const licenceNumber = clean(context.documents.TRADE_LICENSE?.fields.licenseNumber);
    if (number && licenceNumber && number.toUpperCase() !== licenceNumber.toUpperCase()) gap('INCONSISTENT', `The Establishment Card refers to Trade License ${number}, but the Trade License provided is ${licenceNumber}. Please attach the Establishment Card that belongs to this licence.`);
    else if (number && licenceNumber) fact(`The Establishment Card and the Trade License refer to the same licence (${number}).`);
    if (signatories.length === 0) gap('MISSING', 'The Establishment Card lists no authorised signatory.');
    if (expiry) {
      const until = parseDocumentDate(expiry);
      if (!until) gap('FORMAT', `The expiry date on the Establishment Card (${expiry}) could not be read.`);
      else if (until.getTime() < context.asOf.getTime()) gap('EXPIRED', `The Establishment Card expired on ${expiry}.`);
    }
  });
}

function reviewAddressProof(document: ReviewedDocument, context: DocumentReviewContext): DocumentReview {
  return review('ADDRESS_PROOF', document, (gap, fact) => {
    const holder = clean(document.fields.holderName); const address = clean(document.fields.address); const kind = clean(document.fields.documentKind); const issued = clean(document.fields.issueDate);
    if (!kind) gap('MISSING', 'The proof of address does not say what kind of document it is.');
    else if (!acceptedAddressKinds.test(kind)) gap('UNACCEPTABLE', `A ${kind} is not accepted as proof of address (a utility bill, tenancy contract or bank statement is).`);
    else fact(`The proof of address is a ${kind}.`);
    if (!address) gap('MISSING', 'The proof of address does not show an address.');
    if (!holder) gap('MISSING', 'The proof of address does not show the name it is issued to.');
    else if (!(businessNamesMatch(holder, context.businessName) || (context.license !== undefined && sameName(holder, context.license.ownerName)))) gap('MISMATCH', `The proof of address is in the name of ${holder}, not the business or its owner.`);
    else fact(`The proof of address is in the name of ${holder}.`);
    if (issued) {
      const date = parseDocumentDate(issued);
      if (!date) gap('FORMAT', `The date on the proof of address (${issued}) could not be read.`);
      else if (date.getTime() > context.asOf.getTime() + day) gap('INCONSISTENT', `The proof of address is dated in the future (${issued}).`);
      else if (context.asOf.getTime() - date.getTime() > 92 * day) gap('STALE', `The proof of address is dated ${issued}, which is more than three months old; please attach a recent one.`);
    }
  });
}

export const reviewableTypes: DocumentType[] = ['EMIRATES_ID', 'TRADE_LICENSE', 'ESTABLISHMENT_CARD', 'ADDRESS_PROOF'];

export function reviewDocument(type: DocumentType, document: ReviewedDocument, context: DocumentReviewContext): DocumentReview | undefined {
  switch (type) {
    case 'EMIRATES_ID': return reviewEmiratesId(document, context);
    case 'TRADE_LICENSE': return reviewTradeLicense(document, context);
    case 'ESTABLISHMENT_CARD': return reviewEstablishmentCard(document, context);
    case 'ADDRESS_PROOF': return reviewAddressProof(document, context);
    default: return undefined; // authority documents: authority.ts
  }
}

export interface DocumentsReview {
  reviews: DocumentReview[];
  /** Every gap, in customer-safe words. */
  gaps: string[];
  /** The document types whose content must be replaced. */
  replace: DocumentType[];
  uncertain: DocumentReview | undefined;
  facts: string[];
}

/** Reviews the documents of the given types that are present. `ignore` leaves out gap codes a check decides for itself (for example an expired Emirates ID). */
export function reviewDocuments(types: DocumentType[], context: DocumentReviewContext, ignore: GapCode[] = []): DocumentsReview {
  const reviews = types.flatMap((type) => { const document = context.documents[type]; const result = document ? reviewDocument(type, document, context) : undefined; return result ? [result] : []; });
  const kept = reviews.map((entry) => ({ ...entry, gaps: entry.gaps.filter((gap) => !ignore.includes(gap.code)) }));
  const withGaps = kept.filter((entry) => entry.gaps.length > 0);
  return { reviews: kept, gaps: withGaps.flatMap((entry) => entry.gaps.map((gap) => gap.text)), replace: withGaps.map((entry) => entry.documentType), uncertain: kept.find((entry) => entry.verdict === 'UNCERTAIN'), facts: kept.flatMap((entry) => entry.facts) };
}
