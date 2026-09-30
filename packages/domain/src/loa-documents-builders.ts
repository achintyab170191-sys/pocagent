/**
 * Text builders for realistic-format synthetic documents (the layout of the n8n authority letters: a banner, "Label value" lines, prose clauses,
 * signature references). Used by the guided scenarios and by the demo personas' authority letters. Pure text: no dependency on the checks.
 * Dates are relative to `scenarioToday()` (SAMPLE_TODAY at generation time; the committed samples use the reference date).
 */
export const scenarioReferenceDate = '2026-09-30';
/** The day the sample documents are dated from: SAMPLE_TODAY (yyyy-mm-dd) when regenerating for a deployment, otherwise the reference date. */
export const scenarioToday = (): string => (typeof process !== 'undefined' && /^\d{4}-\d{2}-\d{2}$/.test(process.env.SAMPLE_TODAY ?? '') ? process.env.SAMPLE_TODAY! : scenarioReferenceDate) as string;
export const shiftDays = (days: number): string => new Date(Date.parse(`${scenarioToday()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const banner = (title: string): string[] => ['ANZ B2B AGENT PROTOTYPE - SYNTHETIC DOCUMENT', title, 'SYNTHETIC POC DATA ONLY - NOT A REAL CUSTOMER, BUSINESS, IDENTITY, GOVERNMENT RECORD,', 'CREDIT RESULT, OR LEGAL DOCUMENT.'];
const doc = (lines: string[]): string => `${lines.join('\n')}\n`;

export const emiratesIdText = (o: { id: string; name: string; expiry: string; note?: string; nationality?: string; born?: string }): string => doc([
  ...banner('Emirates ID (Synthetic Specimen)'), `ID Number ${o.id}`, `Full Name ${o.name}`, `Nationality ${o.nationality ?? 'United Arab Emirates'}`, `Date of Birth ${o.born ?? '1988-03-14'}`, `Issue Date ${shiftDays(-1200)}`, `Expiry Date ${o.expiry}`, ...(o.note ? [`Prototype note: ${o.note}`] : []),
]);
export const tradeLicenseText = (o: { number: string; business: string; holder: string; expiry?: string; note?: string }): string => doc([
  ...banner('Trade License (Synthetic Specimen)'), `License Number ${o.number}`, `Business Name ${o.business}`, `License Holder ${o.holder}`, 'Issuing Authority Demo Department of Economic Development', `Expiry Date ${o.expiry ?? shiftDays(900)}`, `QR Code QR-${o.number.replace('DEMO-', '')}`, 'Activity Telecommunications and IT consultancy (synthetic)', ...(o.note ? [`Prototype note: ${o.note}`] : []),
]);
export const establishmentCardText = (o: { number: string; business: string; license: string; signatories: string[]; expiry?: string; note?: string; injected?: string }): string => doc([
  ...banner('Establishment Card (Synthetic Specimen)'), `Establishment Number ${o.number}`, `Business Name ${o.business}`, `Trade License Number ${o.license}`, `Authorised Signatory ${o.signatories.join('; ')}`, `Expiry Date ${o.expiry ?? shiftDays(700)}`, ...(o.injected ? [o.injected] : []), ...(o.note ? [`Prototype note: ${o.note}`] : []),
]);
export const proofOfAddressText = (o: { holder: string; address: string; kind: string; issued: string; note?: string }): string => doc([
  ...banner('Proof of Address (Synthetic Specimen)'), `Holder Name ${o.holder}`, `Address ${o.address}`, `Document Type ${o.kind}`, `Issue Date ${o.issued}`, ...(o.note ? [`Prototype note: ${o.note}`] : []),
]);
export const authorityLetterText = (o: { company: string; rep: string; role: string; signer: string; signerTitle: string; issued: string; validUntil?: string; body: string[]; revised?: boolean; note?: string; ref: string; caseReference?: string }): string => doc([
  ...banner(`${o.revised ? 'Revised ' : ''}Authorised Representative Letter`),
  `Company ${o.company}`, ...(o.caseReference ? [`Case reference ${o.caseReference}`] : []), `Issue date ${o.issued}`, ...(o.validUntil ? [`Valid until ${o.validUntil}`] : []), `Representative ${o.rep}`, `Representative role ${o.role}`, 'To: B2B Telecommunications Operations - Prototype', ...o.body,
  'Signed for and on behalf of the company:', `${o.signer} - ${o.signerTitle}`, `Synthetic signature reference ${o.ref}`, ...(o.note ? [`Prototype note: ${o.note}`] : []),
]);

/** A letter that states each requested permission explicitly (the V2 layout). */
export const explicitClauses = (company: string, rep: string): string[] => [
  `${company} hereby appoints and expressly authorises ${rep} to act on behalf of the company for the telecommunications permissions stated below.`,
  'Explicit authority scope',
  '1. Order new telecommunications services, including new service connections and associated service requests.',
  '2. Approve commercial commitments associated with those services, including quoted charges and service terms.',
  '3. Request and approve service or plan changes, including additions, removals, migrations, upgrades and downgrades.',
  `4. Execute and sign telecommunications service agreements and related documentation on behalf of ${company}.`,
];
/** A letter that only covers day-to-day enquiries and administration (the V1 layout): insufficient for the requested permissions. */
export const enquiriesOnly = (rep: string): string[] => [`${rep} is authorised to manage day-to-day telecommunications enquiries, communicate with the service provider, and coordinate account administration.`, 'Prototype note: The letter does not explicitly mention ordering services or signing/approving commitments.'];

/** The two authority letters of the n8n AUTH-003 case (Liam Chen at Bluegum Vector), verbatim as the customer supplied them (apps/web/public/samples/n8n-liam-chen-bluegum-vector/authority-letter-v1.pdf and -v2.pdf). */
export const bluegumLetterV1Text = "ANZ B2B AGENT PROTOTYPE - SYNTHETIC DOCUMENT\nAuthorised Representative Letter\nSYNTHETIC POC DATA ONLY - NOT A REAL CUSTOMER, BUSINESS, IDENTITY, GOVERNMENT RECORD,\nCREDIT RESULT, OR LEGAL DOCUMENT.\nCompany Bluegum Vector Demo Pty Ltd\nSynthetic business identifier AU-DEMO-BIZ-1002\nIssue date 2026-08-15\nSubmission version 1\nRepresentative Liam Chen\nRepresentative role Office Manager\nTo: B2B Telecommunications Operations - Prototype\nLiam Chen is authorised to manage day-to-day telecommunications enquiries, communicate with the service\nprovider,\nand coordinate account administration.\nPrototype note: The letter does not explicitly mention ordering services or signing/approving commitments.\nSigned for and on behalf of the company:\nOlivia Martin - Demo Director\nSynthetic signature reference: SIGN-DEMO-001";
export const bluegumLetterV2Text = "ANZ B2B AGENT PROTOTYPE - SYNTHETIC DOCUMENT\nRevised Authorised Representative Letter\nSYNTHETIC POC DATA ONLY - NOT A REAL CUSTOMER, BUSINESS, IDENTITY, GOVERNMENT RECORD,\nCREDIT RESULT, OR LEGAL DOCUMENT.\nCompany Bluegum Vector Demo Pty Ltd\nSynthetic business identifier AU-DEMO-BIZ-1002\nCase reference AUTH-003\nSubmission version 1\nIssue date 2026-09-29\nValid until 2027-09-28\nAuthorised representative Liam Chen\nRepresentative role Office Manager\nTo: B2B Telecommunications Operations - Prototype\nBluegum Vector Demo Pty Ltd hereby appoints and expressly authorises Liam Chen to act on behalf of the company for\nthe telecommunications permissions stated below.\nExplicit authority scope\n1. Order new telecommunications services, including new service connections, product orders, and associated service\nrequests.\n2. Approve commercial commitments associated with those services, including quoted charges, service terms, and\napproved commercial conditions.\n3. Request and approve service or plan changes, including additions, removals, migrations, upgrades, downgrades,\nand other authorised service changes.\n4. Execute and sign telecommunications service agreements and related service-order documentation on behalf of\nBluegum Vector Demo Pty Ltd.\nAuthority confirmation\nThis authority applies specifically to authorised-representative case AUTH-003. The permissions above are intentional,\ncurrent, and are not limited to general enquiries or account administration.\nFor this synthetic POC, this revised letter supersedes the earlier synthetic authority letter that allowed day-to-day\nenquiries and account administration but did not explicitly grant service-ordering or agreement-signing authority.\nCompany declaration\nThe undersigned synthetic company officer confirms that Liam Chen is authorised to exercise all permissions listed above\nduring the validity period of this document.\nSigned for and on behalf of the company Olivia Martin - Demo Director\nSynthetic signature reference SIGN-DEMO-003-REV1\nSynthetic approval reference AUTH-003-APPROVAL-PATH-001\nPrototype note: Intentionally drafted to resolve AUTHORITY_SCOPE_AMBIGUOUS in the AUTH-003 synthetic test case. Not a real legal\ninstrument.";
