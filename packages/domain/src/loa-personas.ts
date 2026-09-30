/**
 * Demo personas and their synthetic sample documents. The documents are what a customer would upload in the chat; several deliberately
 * disagree with the registers (expired licence, wrong name on the Emirates ID ...) so every branch of the To-Be process can be tried.
 */
import { type DocumentFields, type DocumentType } from './loa.js';
import { n8nPersonas } from './n8n-registers.js';

const HEADINGS: Record<DocumentType, string> = {
  EMIRATES_ID: 'UNITED ARAB EMIRATES - EMIRATES ID (SYNTHETIC SPECIMEN)',
  TRADE_LICENSE: 'TRADE LICENSE (SYNTHETIC SPECIMEN)',
  ESTABLISHMENT_CARD: 'ESTABLISHMENT CARD (SYNTHETIC SPECIMEN)',
  POA_MOA: 'POWER OF ATTORNEY (SYNTHETIC SPECIMEN)',
  ADDRESS_PROOF: 'PROOF OF ADDRESS - UTILITY BILL (SYNTHETIC SPECIMEN)',
};
const ORDER: Record<DocumentType, Array<[string, string]>> = {
  EMIRATES_ID: [['idNumber', 'ID Number'], ['fullName', 'Full Name'], ['nationality', 'Nationality'], ['expiryDate', 'Expiry Date']],
  TRADE_LICENSE: [['licenseNumber', 'License Number'], ['businessName', 'Business Name'], ['licenseHolder', 'License Holder'], ['issuingAuthority', 'Issuing Authority'], ['expiryDate', 'Expiry Date'], ['qrCode', 'QR Code']],
  ESTABLISHMENT_CARD: [['establishmentNumber', 'Establishment Number'], ['businessName', 'Business Name'], ['licenseNumber', 'Trade License Number'], ['signatories', 'Authorised Signatory'], ['expiryDate', 'Expiry Date']],
  POA_MOA: [['reference', 'Reference'], ['grantor', 'Grantor'], ['grantee', 'Grantee'], ['businessName', 'Business Name'], ['scope', 'Scope'], ['validUntil', 'Valid Until']],
  ADDRESS_PROOF: [['holderName', 'Holder Name'], ['address', 'Address'], ['documentKind', 'Document Type']],
};

/** One field per line, after a heading. */
export function renderDocumentText(type: DocumentType, fields: DocumentFields): string {
  const lines = [HEADINGS[type], 'Synthetic proof-of-concept document. Not a real record.'];
  for (const [key, label] of ORDER[type]) {
    const value = fields[key];
    for (const item of Array.isArray(value) ? value : value ? [value] : []) lines.push(`${label}: ${item}`);
  }
  return lines.join('\n');
}

export interface SampleDocument { type: DocumentType; fileName: string; fields: DocumentFields; }
/** A ready-made file that is not generated from the persona's fields (for example a real-format authority letter), listed with the persona's sample documents. */
export interface StaticSampleDocument { type: DocumentType; fileName: string; note: string; }
export interface Persona {
  slug: string; representativeName: string; businessName: string;
  /** What this persona demonstrates. */
  story: string;
  expectedOutcome: 'APPROVE' | 'REJECT' | 'MANUAL_REVIEW' | 'NEED_MORE_INFORMATION' | 'NEED_MORE_INFORMATION_THEN_APPROVE';
  documents: SampleDocument[];
  /** Extra ready-made files (not read by the replay): shown next to the sample documents. */
  staticDocuments?: StaticSampleDocument[];
}

const FAR = '2099-12-31';
const eid = (idNumber: string, fullName: string, extra: DocumentFields = {}): SampleDocument => ({ type: 'EMIRATES_ID', fileName: 'emirates-id.pdf', fields: { idNumber, fullName, nationality: 'UAE', expiryDate: FAR, ...extra } });
const licence = (licenseNumber: string, businessName: string, licenseHolder: string, extra: DocumentFields = {}): SampleDocument => ({ type: 'TRADE_LICENSE', fileName: 'trade-license.pdf', fields: { licenseNumber, businessName, licenseHolder, issuingAuthority: 'Demo Department of Economic Development', expiryDate: FAR, qrCode: `QR-${licenseNumber.replace('DEMO-', '')}`, ...extra } });
const card = (establishmentNumber: string, businessName: string, licenseNumber: string, signatories: string[]): SampleDocument => ({ type: 'ESTABLISHMENT_CARD', fileName: 'establishment-card.pdf', fields: { establishmentNumber, businessName, licenseNumber, signatories, expiryDate: FAR } });
const poa = (reference: string, grantor: string, grantee: string, businessName: string, validUntil: string): SampleDocument => ({ type: 'POA_MOA', fileName: 'power-of-attorney.pdf', fields: { reference, grantor, grantee, businessName, scope: 'Manage account; order services; approve plan changes; sign telecom commitments', validUntil } });

const addressProof = (holderName: string, address: string): SampleDocument => ({ type: 'ADDRESS_PROOF', fileName: 'proof-of-address.pdf', fields: { holderName, address, documentKind: 'Utility bill' } });

const corePersonas: Persona[] = [
  { slug: 'fatima-al-noor', representativeName: 'Fatima Al Mansoori', businessName: 'Al Noor Trading LLC', story: 'Licence owner with valid documents: every check passes.', expectedOutcome: 'APPROVE',
    documents: [eid('784-1985-1234567-1', 'Fatima Al Mansoori'), licence('TL-DEMO-100201', 'Al Noor Trading LLC', 'Fatima Al Mansoori'), card('EC-DEMO-100201', 'Al Noor Trading LLC', 'TL-DEMO-100201', ['Fatima Al Mansoori'])] },
  { slug: 'noura-marina-bay', representativeName: 'Noura Al Falasi', businessName: 'Marina Bay Catering LLC', story: 'The DUL API is down, so the licence is verified through the government portal with UAE Pass (passes with a flag).', expectedOutcome: 'APPROVE',
    documents: [eid('784-1991-8901234-8', 'Noura Al Falasi'), licence('TL-DEMO-100207', 'Marina Bay Catering LLC', 'Noura Al Falasi'), card('EC-DEMO-100207', 'Marina Bay Catering LLC', 'TL-DEMO-100207', ['Noura Al Falasi'])] },
  { slug: 'mariam-dune-ridge', representativeName: 'Mariam Saeed', businessName: 'Dune Ridge Engineering LLC', story: 'The licence number is not readable, so the QR code is used instead.', expectedOutcome: 'APPROVE',
    documents: [eid('784-1988-2233445-1', 'Mariam Saeed'), licence('TL-DEMO-100209', 'Dune Ridge Engineering LLC', 'Mariam Saeed', { licenseNumber: undefined }), card('EC-DEMO-100209', 'Dune Ridge Engineering LLC', '', ['Mariam Saeed'])] },
  { slug: 'omar-gulf-horizon', representativeName: 'Omar Haddad', businessName: 'Gulf Horizon Contracting LLC', story: 'Not the licence owner: the chat asks for a Power of Attorney, then approves. The POA is in the sample pack.', expectedOutcome: 'NEED_MORE_INFORMATION_THEN_APPROVE',
    documents: [eid('784-1990-3456789-3', 'Omar Haddad'), licence('TL-DEMO-100202', 'Gulf Horizon Contracting LLC', 'Khalid Al Suwaidi'), card('EC-DEMO-100202', 'Gulf Horizon Contracting LLC', 'TL-DEMO-100202', ['Khalid Al Suwaidi']), poa('POA-DEMO-2001', 'Khalid Al Suwaidi', 'Omar Haddad', 'Gulf Horizon Contracting LLC', FAR)] },
  { slug: 'hessa-al-noor', representativeName: 'Hessa Al Ameri', businessName: 'Al Noor Trading LLC', story: 'Acts under a Power of Attorney that has expired: the document is read, found insufficient (expired) and the customer is asked to upload a current one; after three failed attempts a human decides.', expectedOutcome: 'NEED_MORE_INFORMATION',
    documents: [eid('784-1993-1122334-0', 'Hessa Al Ameri'), licence('TL-DEMO-100201', 'Al Noor Trading LLC', 'Fatima Al Mansoori'), card('EC-DEMO-100201', 'Al Noor Trading LLC', 'TL-DEMO-100201', ['Fatima Al Mansoori']), poa('POA-DEMO-2002', 'Fatima Al Mansoori', 'Hessa Al Ameri', 'Al Noor Trading LLC', '2020-01-31')] },
  { slug: 'sara-desert-bloom', representativeName: 'Sara Khan', businessName: 'Desert Bloom Cafe LLC', story: 'The Trade License has expired: rejected, with a drafted email and a root-cause analysis.', expectedOutcome: 'REJECT',
    documents: [eid('784-1989-4567890-4', 'Sara Khan'), licence('TL-DEMO-100203', 'Desert Bloom Cafe LLC', 'Sara Khan', { expiryDate: '2020-01-31' }), card('EC-DEMO-100203', 'Desert Bloom Cafe LLC', 'TL-DEMO-100203', ['Sara Khan'])] },
  { slug: 'rashid-falcon', representativeName: 'Rashid Al Ketbi', businessName: 'Falcon Logistics LLC', story: 'The name printed on the Emirates ID does not match the identity register: mismatch, rejected.', expectedOutcome: 'REJECT',
    documents: [eid('784-1982-5678901-5', 'Rasheed Al Kaabi'), licence('TL-DEMO-100204', 'Falcon Logistics LLC', 'Rashid Al Ketbi'), card('EC-DEMO-100204', 'Falcon Logistics LLC', 'TL-DEMO-100204', ['Rashid Al Ketbi'])] },
  { slug: 'layla-pearl-coast', representativeName: 'Layla Nasser', businessName: 'Pearl Coast Real Estate LLC', story: 'Two party IDs exist for the licence; one carries bad debt: rejection recommended for a human to confirm.', expectedOutcome: 'REJECT',
    documents: [eid('784-1987-6789012-6', 'Layla Nasser'), licence('TL-DEMO-100205', 'Pearl Coast Real Estate LLC', 'Layla Nasser'), card('EC-DEMO-100205', 'Pearl Coast Real Estate LLC', 'TL-DEMO-100205', ['Layla Nasser'])] },
  { slug: 'tariq-sahara', representativeName: 'Tariq Mahmood', businessName: 'Sahara Staffing Services LLC', story: 'Blue-collar behaviour is observed on a linked party: rejected.', expectedOutcome: 'REJECT',
    documents: [eid('784-1980-9012345-9', 'Tariq Mahmood'), licence('TL-DEMO-100208', 'Sahara Staffing Services LLC', 'Tariq Mahmood'), card('EC-DEMO-100208', 'Sahara Staffing Services LLC', 'TL-DEMO-100208', ['Tariq Mahmood'])] },
  { slug: 'yousef-oasis-tech', representativeName: 'Yousef Ibrahim', businessName: 'Oasis Tech Solutions FZ-LLC', story: 'Everything passes until AVCV: the credit verification is adverse, so the agent recommends rejection for a human to confirm.', expectedOutcome: 'REJECT',
    documents: [eid('784-1984-7890123-7', 'Yousef Ibrahim'), licence('TL-DEMO-100206', 'Oasis Tech Solutions FZ-LLC', 'Yousef Ibrahim'), card('EC-DEMO-100206', 'Oasis Tech Solutions FZ-LLC', 'TL-DEMO-100206', ['Yousef Ibrahim'])] },
  { slug: 'layth-al-noor', representativeName: 'Layth Barakat', businessName: 'Al Noor Trading LLC', story: 'Not the owner, but recorded as a manager with full representative authority on the licence: no POA is needed.', expectedOutcome: 'APPROVE',
    documents: [eid('784-1986-1111111-1', 'Layth Barakat'), licence('TL-DEMO-100201', 'Al Noor Trading LLC', 'Fatima Al Mansoori'), card('EC-DEMO-100201', 'Al Noor Trading LLC', 'TL-DEMO-100201', ['Fatima Al Mansoori', 'Layth Barakat'])] },
  { slug: 'ahmed-gulf-horizon', representativeName: 'Ahmed Yusuf', businessName: 'Gulf Horizon Contracting LLC', story: 'A recorded manager, but his capacity covers only account management and ordering, not plan changes or signing: a POA is required, then approval.', expectedOutcome: 'NEED_MORE_INFORMATION_THEN_APPROVE',
    documents: [eid('784-1992-2222222-2', 'Ahmed Yusuf'), licence('TL-DEMO-100202', 'Gulf Horizon Contracting LLC', 'Khalid Al Suwaidi'), card('EC-DEMO-100202', 'Gulf Horizon Contracting LLC', 'TL-DEMO-100202', ['Khalid Al Suwaidi', 'Ahmed Yusuf']), poa('POA-DEMO-2003', 'Khalid Al Suwaidi', 'Ahmed Yusuf', 'Gulf Horizon Contracting LLC', FAR)] },
  { slug: 'jamal-falcon', representativeName: 'Jamal Farouk', businessName: 'Falcon Logistics LLC', story: 'An authorised signatory whose record carries a limitation (joint signature required): a specialist decides; a POA cannot override it.', expectedOutcome: 'MANUAL_REVIEW',
    documents: [eid('784-1983-3333333-3', 'Jamal Farouk'), licence('TL-DEMO-100204', 'Falcon Logistics LLC', 'Rashid Al Ketbi'), card('EC-DEMO-100204', 'Falcon Logistics LLC', 'TL-DEMO-100204', ['Rashid Al Ketbi', 'Jamal Farouk'])] },
  { slug: 'ibrahim-cedar-point', representativeName: 'Ibrahim Karam', businessName: 'Cedar Point Consulting LLC', story: 'AVCV finds a discrepancy in the address details: a specialist reviews it (not a rejection).', expectedOutcome: 'MANUAL_REVIEW',
    documents: [eid('784-1979-4444444-4', 'Ibrahim Karam'), licence('TL-DEMO-100210', 'Cedar Point Consulting LLC', 'Ibrahim Karam'), card('EC-DEMO-100210', 'Cedar Point Consulting LLC', 'TL-DEMO-100210', ['Ibrahim Karam'])] },
  { slug: 'reem-palm-grove', representativeName: 'Reem Al Hosani', businessName: 'Palm Grove Hospitality LLC', story: 'AVCV is unable to verify (premises locked): this is not a failure, so a specialist decides.', expectedOutcome: 'MANUAL_REVIEW',
    documents: [eid('784-1990-5555555-5', 'Reem Al Hosani'), licence('TL-DEMO-100211', 'Palm Grove Hospitality LLC', 'Reem Al Hosani'), card('EC-DEMO-100211', 'Palm Grove Hospitality LLC', 'TL-DEMO-100211', ['Reem Al Hosani'])] },
  { slug: 'adel-coral-reef', representativeName: 'Adel Mansour', businessName: 'Coral Reef Diving LLC', story: 'AVCV has insufficient information: the chat asks for proof of address (a utility bill) in the same window, then approves.', expectedOutcome: 'NEED_MORE_INFORMATION_THEN_APPROVE',
    documents: [eid('784-1981-6666666-6', 'Adel Mansour'), licence('TL-DEMO-100212', 'Coral Reef Diving LLC', 'Adel Mansour'), card('EC-DEMO-100212', 'Coral Reef Diving LLC', 'TL-DEMO-100212', ['Adel Mansour']), addressProof('Coral Reef Diving LLC', 'Unit 4, Marina Walk, Demo City')] },
];

/** The demo personas plus one per archived n8n scenario (scripts/import-n8n-registers.ts). */
/** Hand-written test persona on top of the retained n8n business Bluegum: valid documents, and an authority letter that covers every requested action. */
const achintyaBluegum: Persona = {
  slug: 'achintya-bluegum-vector', representativeName: 'Achintya Bundelkhandi', businessName: 'Bluegum Vector Demo Pty Ltd',
  story: 'Acts for Bluegum Vector under a full Power of Attorney. Try attaching only one document first (the request stays open and asks for the rest), then the full set: the checks run through to a decision.', expectedOutcome: 'APPROVE',
  documents: [eid('784-1995-4455667-7', 'Achintya Bundelkhandi'), licence('TL-N8N-1002', 'Bluegum Vector Demo Pty Ltd', 'Olivia Martin', { issuingAuthority: 'Demo Registry (n8n data)', qrCode: 'QR-TL-N8N-1002' }), card('EC-N8N-1002', 'Bluegum Vector Demo Pty Ltd', 'TL-N8N-1002', ['Olivia Martin']), poa('POA-DEMO-2101', 'Olivia Martin', 'Achintya Bundelkhandi', 'Bluegum Vector Demo Pty Ltd', FAR)],
};

/** The two real-format authority letters of the n8n AUTH-003 case: V1 is insufficient (day-to-day only), V2 explicitly grants the requested authority. */
const liamLetters: StaticSampleDocument[] = [
  { type: 'POA_MOA', fileName: 'authority-letter-v1.pdf', note: 'V1 - covers day-to-day enquiries only: insufficient evidence, the assistant asks for a revised letter' },
  { type: 'POA_MOA', fileName: 'authority-letter-v2.pdf', note: 'V2 - explicitly authorises ordering, plan changes, commitments and signing: accepted' },
];
export const personas: Persona[] = [...corePersonas, ...n8nPersonas.map((persona) => persona.slug === 'n8n-liam-chen-bluegum-vector' ? { ...persona, staticDocuments: liamLetters } : persona), achintyaBluegum];

export function documentText(document: SampleDocument): string { return renderDocumentText(document.type, document.fields); }
