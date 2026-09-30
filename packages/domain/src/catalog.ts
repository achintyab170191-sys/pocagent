/**
 * The B2B telco operating model and the customer-facing request catalog (docs/09, product-owner definitions).
 *
 *   Profiling -> Verifier task -> Processing, watched by the Control tower, assured by Governance, summarised by Reporting.
 *
 * Only ONE request type is automated end to end today: New LOA (profiling). Every other request type can be started in the chat: it is
 * captured as a case and routed to the stage that owns it, and the customer is told plainly that it is not automated in this prototype.
 */

export type StageId = 'PROFILING' | 'VERIFIER' | 'PROCESSING' | 'CONTROL_TOWER' | 'GOVERNANCE' | 'REPORTING';
export interface Stage { id: StageId; name: string; order: number; summary: string; covers: string[]; queue: string; /** 'LIVE' = a request type runs end to end; 'ROUTED' = requests are captured and routed only; 'NOT_BUILT' = shown for the operating model. */ build: 'LIVE' | 'ROUTED' | 'NOT_BUILT'; }

export const stages: Stage[] = [
  { id: 'PROFILING', name: 'Profiling', order: 1, build: 'LIVE', queue: 'PROFILING_OPERATIONS', summary: 'Establishes who the customer and the company are, and who may act for them.', covers: ['New LOA processing', 'POA / MOA / AOA approval', 'Mobile re-registration', 'Data quality assurance', 'Document update', 'Regularization', 'MOL approval', 'TRN', 'Address verification'] },
  { id: 'VERIFIER', name: 'Verifier task', order: 2, build: 'ROUTED', queue: 'VERIFIER_OPERATIONS', summary: 'Activities that need operational or physical verification, specialist coordination or manual completion.', covers: ['Mobile number portability', 'New activation (prepaid, reprovision)', 'Transfer of ownership', 'SIM replacement', 'Mobile registration', 'Blank SIM', 'AVCV', 'Legal letter collection', 'Address verification', 'Biometric or field verification'] },
  { id: 'PROCESSING', name: 'Processing', order: 3, build: 'ROUTED', queue: 'PROCESSING_ORDERS', summary: 'The downstream execution stage once profiling and verification controls are passed: order creation, quality checks, commercial and contract validation, service delivery and lifecycle tracking.', covers: ['Order creation', 'Quality checks', 'Commercial and contract validation', 'Service delivery', 'Lifecycle tracking'] },
  { id: 'CONTROL_TOWER', name: 'Control tower', order: 4, build: 'NOT_BUILT', queue: 'CONTROL_TOWER', summary: 'A cross-process monitoring and orchestration layer.', covers: ['OCR and intelligent automation', 'ML and fraud analytics', 'Entity monitoring', 'User management', 'Bad debt monitoring', 'RPA monitoring', 'Fraud investigation', 'Performance and efficiency tracking', 'SLA and ageing monitoring', 'Exception and escalation management'] },
  { id: 'GOVERNANCE', name: 'Governance', order: 5, build: 'NOT_BUILT', queue: 'GOVERNANCE', summary: 'Oversight and assurance across profiling, verifier and processing.', covers: ['Auditing', 'Validation and monitoring', 'Process alignment', 'Training', 'Compliance'] },
  { id: 'REPORTING', name: 'Reporting', order: 6, build: 'NOT_BUILT', queue: 'REPORTING', summary: 'Converts operational and governance data into management information.', covers: ['Management information', 'Operational and governance reports'] },
];
export const stageById = (id: string): Stage | undefined => stages.find((stage) => stage.id === id);

export interface RequestType {
  id: string; label: string; stage: StageId; automated: boolean;
  /** Lower-case substrings that suggest this request in free text. */
  keywords: string[];
  /** A ready-made customer sentence for the "standard queries" chips. */
  query: string;
}
export interface RequestCategory { id: string; title: string; description: string; icon: string; requests: string[]; }

const request = (id: string, label: string, stage: StageId, query: string, keywords: string[], automated = false): RequestType => ({ id, label, stage, automated, query, keywords });
export const requestTypes: RequestType[] = [
  // Profiling
  request('NEW_LOA', 'New authorised representative (LOA)', 'PROFILING', 'I want to add an authorised representative for my company.', ['authorised representative', 'authorized representative', 'letter of authority', ' loa', 'add a representative', 'add an authorised'], true),
  request('POA_MOA_AOA', 'POA / MOA / AOA approval', 'PROFILING', 'I need a power of attorney or memorandum of association approved.', ['power of attorney', 'memorandum', 'articles of association', ' poa', ' moa', ' aoa']),
  request('DOCUMENT_UPDATE', 'Document update', 'PROFILING', 'I need to update a company document on my account.', ['update a document', 'document update', 'update my trade licen', 'update my licen', 'new trade licen']),
  request('RE_REGISTRATION', 'Mobile re-registration', 'PROFILING', 'I need to re-register some of our mobile numbers.', ['re-register', 'reregister', 're-registration']),
  request('REGULARIZATION', 'Regularization', 'PROFILING', 'Some of our lines need to be regularized.', ['regulariz', 'regularis']),
  request('TRN', 'Tax registration number (TRN)', 'PROFILING', 'I need to add or update our tax registration number.', [' trn', 'tax registration', 'vat number']),
  request('MOL_APPROVAL', 'MOL approval', 'PROFILING', 'I need a Ministry of Labour (MOL) approval on our account.', [' mol ', 'ministry of labour', 'labour approval']),
  request('DATA_QUALITY', 'Data-quality correction', 'PROFILING', 'Some details on our account are wrong and need correcting.', ['data quality', 'wrong details', 'incorrect details', 'correct our data', 'correct my data']),
  request('DUPLICATE_RECORDS', 'Duplicate records', 'PROFILING', 'We seem to have duplicate records for the same company.', ['duplicate']),
  request('COMPANY_NAME_CORRECTION', 'Company-name correction', 'PROFILING', 'Our company name is spelt wrongly on the account.', ['company name', 'name correction', 'name change']),
  request('BUSINESS_DOCUMENT_UPDATE', 'Business-document update', 'PROFILING', 'I want to replace the business documents on our account.', ['business document']),
  request('ADDRESS_VERIFICATION', 'Address verification', 'PROFILING', 'I need our business address verified.', ['address verification', 'verify our address', 'verify my address']),
  // Verifier task
  request('MNP', 'Mobile number portability (porting)', 'VERIFIER', 'I want to port our mobile numbers to you from another operator.', ['portability', 'porting', ' port ', ' mnp', 'port our', 'port my']),
  request('NEW_MOBILE_ACTIVATION', 'New mobile activation', 'VERIFIER', 'I want to activate new mobile lines for our staff.', ['new mobile', 'activate new mobile', 'mobile activation', 'activate mobile']),
  request('SIM_REPLACEMENT', 'SIM replacement', 'VERIFIER', 'A SIM card was lost or damaged and needs replacing.', ['sim replacement', 'replace a sim', 'replace my sim', 'lost sim', 'damaged sim', 'lost my sim', 'lost a sim', 'sim card']),
  request('ESIM', 'eSIM', 'VERIFIER', 'I want to move a line to an eSIM.', ['esim', 'e-sim']),
  request('BLANK_SIM', 'Blank SIM', 'VERIFIER', 'I need blank SIMs for our team.', ['blank sim']),
  request('EMERGENCY_MOBILE_REGISTRATION', 'Emergency mobile registration', 'VERIFIER', 'I need an emergency mobile registration.', ['emergency mobile', 'emergency registration']),
  request('TRANSFER_OF_OWNERSHIP', 'Transfer of ownership', 'VERIFIER', 'I want to transfer ownership of a line to another company.', ['transfer of ownership', 'transfer ownership', 'ownership transfer']),
  request('AVCV', 'Address and credit verification (AVCV)', 'VERIFIER', 'I need an address and credit verification completed.', ['avcv', 'credit verification']),
  request('LEGAL_LETTER', 'Legal letter collection', 'VERIFIER', 'I need to collect or submit a legal letter.', ['legal letter']),
  request('BAD_DEBT_DOCUMENTATION', 'Bad-debt documentation', 'VERIFIER', 'I need documentation for an outstanding bad debt.', ['bad debt', 'bad-debt']),
  request('SPECIAL_VERIFICATION', 'Special verification (biometric or field)', 'VERIFIER', 'I need a biometric or field verification arranged.', ['biometric', 'field verification', 'special verification']),
  request('EMERGENCY_CASE', 'Emergency case', 'VERIFIER', 'This is an emergency and needs urgent handling.', ['emergency', 'urgent']),
  // Processing
  request('NEW_ACTIVATION', 'New activation', 'PROCESSING', 'I want to activate a new service for our company.', ['new activation', 'new service', 'new line']),
  request('DATA_PRODUCTS', 'Data products', 'PROCESSING', 'I am interested in a data product for our business.', ['data product', 'data plan', 'internet', 'broadband']),
  request('PREPAID_ACTIVATION', 'Prepaid activation', 'PROCESSING', 'I want to activate prepaid lines.', ['prepaid']),
  request('REPROVISIONING', 'Reprovisioning', 'PROCESSING', 'A service needs to be reprovisioned.', ['reprovision']),
  request('CHANGE_PLAN', 'Change or upgrade plan', 'PROCESSING', 'I want to change or upgrade our plan.', ['upgrade', 'change plan', 'change our plan', 'change my plan', 'downgrade']),
  request('ADDON_CHANGE', 'Add or remove add-ons', 'PROCESSING', 'I want to add or remove an add-on.', ['add-on', 'addon', 'add on']),
  request('MIGRATION', 'Migration', 'PROCESSING', 'I want to migrate to a different plan or platform.', ['migrate', 'migration']),
  request('RENEW_SERVICE', 'Renew a service', 'PROCESSING', 'I want to renew a service.', ['renew']),
  request('CEASE_SERVICE', 'Cease a service', 'PROCESSING', 'I want to cancel or cease a service.', ['cease', 'cancel a service', 'cancel our service', 'terminate']),
];
export const requestTypeById = (id: string): RequestType | undefined => requestTypes.find((entry) => entry.id === id);

export const requestCategories: RequestCategory[] = [
  { id: 'authorised-representative', title: 'Authorised representative & company profile', description: 'Who may act for your company, and your company records.', icon: 'building', requests: ['NEW_LOA', 'POA_MOA_AOA', 'DOCUMENT_UPDATE', 'RE_REGISTRATION', 'REGULARIZATION', 'TRN', 'MOL_APPROVAL'] },
  { id: 'customer-data', title: 'Correct or verify customer data', description: 'Fix records, remove duplicates, verify your address.', icon: 'check', requests: ['DATA_QUALITY', 'DUPLICATE_RECORDS', 'COMPANY_NAME_CORRECTION', 'BUSINESS_DOCUMENT_UPDATE', 'ADDRESS_VERIFICATION'] },
  { id: 'mobile-sim', title: 'Mobile and SIM requests', description: 'Activations, replacements, eSIM and registrations.', icon: 'phone', requests: ['NEW_MOBILE_ACTIVATION', 'SIM_REPLACEMENT', 'ESIM', 'BLANK_SIM', 'RE_REGISTRATION', 'EMERGENCY_MOBILE_REGISTRATION'] },
  { id: 'new-service', title: 'New service requests', description: 'Start a new line, data product or prepaid service.', icon: 'plus', requests: ['NEW_ACTIVATION', 'DATA_PRODUCTS', 'PREPAID_ACTIVATION', 'REPROVISIONING'] },
  { id: 'change-service', title: 'Change an existing service', description: 'Plans, add-ons and migrations.', icon: 'sliders', requests: ['CHANGE_PLAN', 'ADDON_CHANGE', 'MIGRATION'] },
  { id: 'move-transfer-port', title: 'Move, transfer or port a service', description: 'Ownership transfers and number portability.', icon: 'arrows', requests: ['TRANSFER_OF_OWNERSHIP', 'MNP'] },
  { id: 'renew-cease', title: 'Renew or cease a service', description: 'Keep a service going, or end it.', icon: 'refresh', requests: ['RENEW_SERVICE', 'CEASE_SERVICE'] },
  { id: 'verification-compliance', title: 'Verification, compliance or legal support', description: 'AVCV, legal letters, special and emergency cases.', icon: 'shield', requests: ['AVCV', 'LEGAL_LETTER', 'BAD_DEBT_DOCUMENTATION', 'SPECIAL_VERIFICATION', 'EMERGENCY_CASE'] },
];

/** One ready-made question per category, shown as quick replies. */
export const featuredQueries: Array<{ requestId: string; text: string }> = ['NEW_LOA', 'DATA_QUALITY', 'SIM_REPLACEMENT', 'NEW_ACTIVATION', 'CHANGE_PLAN', 'MNP', 'RENEW_SERVICE', 'AVCV'].map((requestId) => ({ requestId, text: requestTypeById(requestId)!.query }));

/** The request a free-text message most likely asks for (keyword hits; the longest matching keyword wins ties). Undefined when nothing matches. */
export function matchRequestType(message: string): RequestType | undefined {
  const text = ` ${message.toLowerCase().replace(/\s+/g, ' ')} `;
  // A ready-made question (a standard-query chip, typed or clicked) always means exactly its own request.
  const canned = requestTypes.find((entry) => entry.query.toLowerCase() === message.trim().toLowerCase());
  if (canned) return canned;
  let best: { entry: RequestType; score: number } | undefined;
  for (const entry of requestTypes) {
    const score = entry.keywords.reduce((total, keyword) => (text.includes(keyword) ? total + keyword.trim().length : total), 0);
    if (score > 0 && (!best || score > best.score)) best = { entry, score };
  }
  return best?.entry;
}
