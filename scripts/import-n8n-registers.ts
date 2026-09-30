/**
 * Retains the archived n8n data in the To-Be app. Reads the preserved dt_*.csv exports (never modified) and writes
 * packages/domain/src/n8n-registers.ts: the n8n businesses, people, authority letters, financial and CRM facts, expressed as the synthetic
 * registers the five checks read, plus one demo persona (with sample documents) per n8n scenario.
 *
 *   npm run import:n8n        (then npm run samples)
 *
 * Mapping (documented, deterministic, no invention beyond what a register needs to exist):
 *   dt_business_register   → trade-licence record  (INACTIVE → CANCELLED; lookup UNAVAILABLE → not verifiable → specialist)
 *   dt_crm_accounts        → the recorded person (Existing_Authorised_Contact, Director → OWNER); a business with no named contact gets a synthetic
 *                            "<Business> Director" so a record holder exists; CONFLICT / duplicate group → party data conflict
 *   dt_financial_records   → bad debt only when written off or aged 90+ days; Credit_Hold / REVIEW → AVCV credit REFER
 *   dt_documents_index     → an AUTHORITY_LETTER becomes a POA/MOA (grantee = the representative, scopes read from the letter text,
 *                            valid until its expiry; PROMPT_INJECTION security flag → specialist review); no letter → no POA
 *   dt_mock_utility_results→ FINAL_VERIFICATION FAIL → AVCV credit NEGATIVE
 * The representatives in dt_synthetic_cases are people asking to be authorised: they are NOT recorded on the licence, so a POA/MOA is needed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseCsv } from '@sbo/persistence';

const table = (name: string) => parseCsv(readFileSync(`${name}.csv`, 'utf8').replace(/^\uFEFF/, ''));
const businesses = table('dt_business_register');
const cases = table('dt_synthetic_cases');
const crm = table('dt_crm_accounts');
const financial = table('dt_financial_records');
const documents = table('dt_documents_index');
const mock = table('dt_mock_utility_results');

const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const licenseNumberOf = (businessId: string): string => `TL-N8N-${businessId.replace(/^[A-Z]{2}-DEMO-BIZ-/, '')}`;
const dateOnly = (value: string): string => value.slice(0, 10) || '2099-12-31';
const scopesOf = (text: string): string[] => {
  const lower = text.toLowerCase();
  const scopes: string[] = [];
  if (/manage/.test(lower)) scopes.push('MANAGE_ACCOUNT');
  if (/order/.test(lower)) scopes.push('ORDER_SERVICES');
  if (/plan change/.test(lower)) scopes.push('APPROVE_PLAN_CHANGES');
  if (/sign|commercial commitments/.test(lower)) scopes.push('SIGN_COMMITMENTS');
  return scopes;
};

interface Person { name: string; idNumber: string; }
const people = new Map<string, Person>();
let personIndex = 0;
const person = (name: string): Person => {
  const existing = people.get(name);
  if (existing) return existing;
  personIndex += 1;
  const created = { name, idNumber: `784-${1960 + personIndex}-${String(7000000 + personIndex * 1111).padStart(7, '0')}-${personIndex % 10}` };
  people.set(name, created);
  return created;
};

const licenses: unknown[] = []; const parties: unknown[] = []; const avcv: unknown[] = []; const poas: unknown[] = []; const personas: unknown[] = [];
const ownerByBusiness = new Map<string, string>(); const nameByBusiness = new Map<string, string>();

for (const business of businesses) {
  const id = business.Business_Identifier ?? '';
  const submitted = cases.find((entry) => entry.Business_Identifier_Submitted === id)?.Business_Name_Submitted ?? '';
  const name = business.Registered_Name || submitted || crm.find((entry) => entry.Business_Identifier === id)?.Account_Name || id;
  const contacts = crm.filter((entry) => entry.Business_Identifier === id && entry.Existing_Authorised_Contact);
  const owner = contacts.find((entry) => /director/i.test(entry.Contact_Role ?? ''))?.Existing_Authorised_Contact ?? `${(business.Trading_Name || name).replace(/ (Demo )?(Pty Ltd|Limited)$/i, '')} Director`;
  ownerByBusiness.set(id, owner); nameByBusiness.set(id, name);
  person(owner);
  const unavailable = business.Lookup_Status === 'UNAVAILABLE';
  licenses.push({ licenseNumber: licenseNumberOf(id), qrToken: `QR-${licenseNumberOf(id)}`, businessName: name, ownerName: owner, status: business.Registration_Status === 'INACTIVE' ? 'CANCELLED' : 'ACTIVE', expiryDate: '2099-12-31', dulApiAvailable: !unavailable, lookupAvailable: !unavailable, establishmentNumber: `EC-N8N-${id.replace(/^[A-Z]{2}-DEMO-BIZ-/, '')}`, persons: [{ name: owner, capacity: 'OWNER', scopes: ['MANAGE_ACCOUNT', 'ORDER_SERVICES', 'APPROVE_PLAN_CHANGES', 'SIGN_COMMITMENTS'] }] });
  for (const account of crm.filter((entry) => entry.Business_Identifier === id)) {
    const money = financial.find((entry) => entry.PID === account.PID);
    const aged = Number(money?.Oldest_Aging_Days ?? 0) >= 90 || money?.Write_Off_Flag === 'YES';
    parties.push({ partyId: account.PID, licenseNumber: licenseNumberOf(id), holderName: owner, badDebtAed: aged ? Number(money?.Outstanding_Amount ?? 0) : 0, blueCollarFlag: false, dataConflict: account.Data_Consistency_Status === 'CONFLICT' || Boolean(account.Duplicate_Group_ID) });
  }
  const money = financial.filter((entry) => crm.some((account) => account.Business_Identifier === id && account.PID === entry.PID));
  const caseRuns = cases.filter((entry) => entry.Business_Identifier_Submitted === id).map((entry) => entry.Case_Run_ID);
  const finalFailed = mock.some((row) => caseRuns.includes(row.Case_Run_ID ?? '') && row.Check_Type === 'FINAL_VERIFICATION' && row.Status === 'FAIL');
  const creditHold = money.some((entry) => entry.Credit_Hold === 'YES' || entry.Check_Status === 'REVIEW_REQUIRED');
  avcv.push({ licenseNumber: licenseNumberOf(id), address: 'POSITIVE', credit: finalFailed ? 'NEGATIVE' : creditHold ? 'REFER' : 'POSITIVE' });
}

const stories: Record<string, { story: string; expected: string }> = {
  'AUTH-001': { story: 'Clean n8n scenario: a valid POA/MOA is needed (the person is not on the licence record), then all checks pass.', expected: 'NEED_MORE_INFORMATION_THEN_APPROVE' },
  'AUTH-002': { story: 'n8n scenario: the authority document is missing, so the chat keeps asking for the POA/MOA.', expected: 'NEED_MORE_INFORMATION' },
  'AUTH-003': { story: 'n8n scenario: the authority letter only covers day-to-day enquiries, not every requested action: POA/MOA not cleared, rejection recommended.', expected: 'REJECT' },
  'AUTH-004': { story: 'n8n scenario: the business is inactive, so the licence is not active: rejection recommended.', expected: 'REJECT' },
  'AUTH-005': { story: 'n8n scenario: conflicting duplicate CRM records (two party IDs for one company): a specialist reconciles them.', expected: 'MANUAL_REVIEW' },
  'AUTH-006': { story: 'n8n scenario: the final verification fails, shown here as an adverse credit verification: rejection recommended.', expected: 'REJECT' },
  'AUTH-007': { story: 'n8n scenario: the registry lookup is unavailable: not treated as invalid, a specialist verifies.', expected: 'MANUAL_REVIEW' },
  'AUTH-008-V2': { story: 'n8n scenario (corrected V2 letter): a valid POA/MOA covers every requested action, then all checks pass.', expected: 'NEED_MORE_INFORMATION_THEN_APPROVE' },
  'AUTH-009': { story: 'n8n scenario: the authority letter carries an embedded instruction (prompt injection): treated as data, and a specialist reviews the document.', expected: 'MANUAL_REVIEW' },
  'AUTH-010': { story: 'n8n scenario: a credit hold and outstanding balance (policy TBD): the credit verification is referred to a specialist.', expected: 'MANUAL_REVIEW' },
};

for (const entry of cases.filter((row) => row.Case_Run_ID !== 'AUTH-008-V1')) {
  const caseRun = entry.Case_Run_ID ?? '';
  const id = entry.Business_Identifier_Submitted ?? '';
  const rep = entry.Representative_Name ?? '';
  const info = stories[caseRun];
  if (!info) continue;
  const owner = ownerByBusiness.get(id) ?? '';
  const name = nameByBusiness.get(id) ?? entry.Business_Name_Submitted ?? '';
  const letter = documents.find((row) => row.Case_Run_ID === caseRun && /^AUTHORITY_LETTER/.test(row.Document_Type ?? '') && row.Present === 'true' && row.Readable === 'true');
  const repId = person(rep); person(owner);
  const licence = licenseNumberOf(id); const establishment = `EC-N8N-${id.replace(/^[A-Z]{2}-DEMO-BIZ-/, '')}`;
  const files: unknown[] = [
    { type: 'EMIRATES_ID', fileName: 'emirates-id.pdf', fields: { idNumber: repId.idNumber, fullName: rep, nationality: 'Synthetic', expiryDate: '2099-12-31' } },
    { type: 'TRADE_LICENSE', fileName: 'trade-license.pdf', fields: { licenseNumber: licence, businessName: name, licenseHolder: owner, issuingAuthority: 'Demo Registry (n8n data)', expiryDate: '2099-12-31', qrCode: `QR-${licence}` } },
    { type: 'ESTABLISHMENT_CARD', fileName: 'establishment-card.pdf', fields: { establishmentNumber: establishment, businessName: name, licenseNumber: licence, signatories: [owner], expiryDate: '2099-12-31' } },
  ];
  if (letter) {
    const reference = `POA-N8N-${caseRun}`;
    const scopes = scopesOf(letter.Authority_Scope_Summary ?? '');
    const flagged = (letter.Security_Flag ?? 'NONE') !== 'NONE';
    poas.push({ reference, grantor: owner, grantee: rep, businessName: name, scopes, validUntil: dateOnly(letter.Expiry_Date ?? ''), securityFlag: flagged ? letter.Security_Flag : undefined });
    files.push({ type: 'POA_MOA', fileName: 'power-of-attorney.pdf', fields: { reference, grantor: owner, grantee: rep, businessName: name, scope: `${(letter.Authority_Scope_Summary ?? '').replace(/\.$/, '')}${flagged ? ' [document contains an embedded instruction that must be ignored]' : ''}`, validUntil: dateOnly(letter.Expiry_Date ?? '') } });
  }
  personas.push({ slug: `n8n-${slug(rep)}-${slug(name).split('-').slice(0, 2).join('-')}`, representativeName: rep, businessName: name, story: `${info.story} (n8n ${caseRun})`, expectedOutcome: info.expected, documents: files });
}

const literal = (value: unknown): string => JSON.stringify(value, null, 2);
const out = `/**
 * GENERATED by scripts/import-n8n-registers.ts from the archived n8n exports (dt_*.csv). Do not edit by hand; run \`npm run import:n8n\`.
 * Keeps the n8n businesses, people, authority letters, financial and CRM facts in the To-Be app as synthetic register data.
 */
import type { AvcvRecord, EmiratesIdRecord, PoaRecord, PartyRecord, TradeLicenseRecord } from './loa.js';
import type { Persona } from './loa-personas.js';

export const n8nLicenses: TradeLicenseRecord[] = ${literal(licenses)};
export const n8nEmiratesIds: EmiratesIdRecord[] = ${literal([...people.values()].map((entry) => ({ idNumber: entry.idNumber, fullName: entry.name, expiryDate: '2099-12-31' })))};
export const n8nPoas: PoaRecord[] = ${literal(poas)};
export const n8nParties: PartyRecord[] = ${literal(parties)};
export const n8nAvcv: AvcvRecord[] = ${literal(avcv)};
export const n8nPersonas: Persona[] = ${literal(personas)};
`;
writeFileSync('packages/domain/src/n8n-registers.ts', out);
console.log(`Imported ${licenses.length} businesses, ${people.size} people, ${poas.length} authority letters, ${parties.length} parties, ${personas.length} personas from the n8n exports.`);
