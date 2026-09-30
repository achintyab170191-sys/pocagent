import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { makePdf } from '@sbo/testkit';

const samples = (slug: string, ...files: string[]): string[] => files.map((file) => join(process.cwd(), 'apps', 'web', 'public', 'samples', slug, file));
const intakeFiles = ['emirates-id.pdf', 'trade-license.pdf', 'establishment-card.pdf'];
test.beforeEach(async ({ request }) => { await request.get(`http://127.0.0.1:${process.env.E2E_API_PORT ?? 3100}/__test/reset`); });

async function say(page: Page, message: string) {
  await page.getByLabel('Message').fill(message);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function introduce(page: Page, name: string, company: string) {
  await page.goto('/');
  await say(page, `My name is ${name} and I represent ${company}.`);
  await expect(page.getByTestId('chat-log')).toContainText(/opened case\s+AUTH-1\d\d|new lead case/);
}
async function sendDocuments(page: Page, paths: string[]) {
  await page.getByTestId('file-input').setInputFiles(paths);
  await page.getByRole('button', { name: 'Send documents' }).click();
}
const lastMeta = (page: Page) => page.getByTestId('outcome-meta').last();

test.describe('customer chat (To-Be New LOA process)', () => {
  test('a new customer starts with a name and a company — no case id, nothing to type but the introduction', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('chat-log')).toContainText('tell me your name and the company you represent');
    await say(page, 'hello');
    await expect(page.getByTestId('chat-log')).toContainText('the company you represent');
    await say(page, 'Hi, my name is Fatima Al Mansoori');
    await expect(page.getByTestId('chat-log')).toContainText('Which company are you representing?');
    await say(page, 'Al Noor Trading LLC');
    await expect(page.getByTestId('chat-log')).toContainText(/opened case\s+AUTH-1\d\d/);
    await expect(page.getByTestId('evidence-card')).toContainText('Emirates ID of the representative');
    await expect(page.getByTestId('evidence-card')).toContainText('Trade License of the business');
    await expect(page.getByTestId('evidence-card')).toContainText('Establishment Card of the business');
    await expect(page.getByTestId('chat-log')).not.toContainText(/reply UPLOADED|Reply TEXT|type UPLOAD/i);
  });

  test('documents only: while a document request is open there is no text box, only attach', async ({ page }) => {
    await introduce(page, 'Fatima Al Mansoori', 'Al Noor Trading LLC');
    await expect(page.getByLabel('Message')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Attach documents' })).toBeVisible();
    await expect(page.getByText('typed text is not accepted as evidence')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send documents' })).toBeDisabled();
  });

  test('Fatima attaches her three documents in the same window: five checks pass in order and she is approved', async ({ page }) => {
    await introduce(page, 'Fatima Al Mansoori', 'Al Noor Trading LLC');
    await page.getByTestId('file-input').setInputFiles(samples('fatima-al-noor', ...intakeFiles));
    await expect(page.getByLabel('Attached files')).toContainText('emirates-id.pdf');
    await expect(page.getByLabel('Attached files')).toContainText('establishment-card.pdf');
    await page.getByRole('button', { name: 'Send documents' }).click();
    await expect(page.getByRole('heading', { name: /Eligible to proceed/ })).toBeVisible();
    await expect(lastMeta(page)).toContainText('APPROVE');
    await expect(lastMeta(page)).toContainText('Trade License Check → Identity Validation → POA/MOA Check → Bad Debt Check → AVCV Verification');
    await expect(page.getByTestId('chat-log')).toContainText('Trade License and Establishment Card — Passed');
    const text = await page.getByTestId('chat-log').innerText();
    expect(text).not.toMatch(/TL-DEMO|784-1985|PD-DEMO|CTRL-|FINAL-001|rule_ids|systemMessage|prompt/i);
    await expect(page.getByRole('note')).toContainText('Synthetic data');
  });

  test('only the key word of a company asks "Did you mean …?" once (the page polling never repeats it), and yes continues with that company', async ({ page }) => {
    await page.goto('/');
    await say(page, 'My name is Achintya Bundelkhandi and I represent Bluegum');
    const log = page.getByTestId('chat-log');
    await expect(log).toContainText('Did you mean Bluegum Vector Demo Pty Ltd?');
    await page.waitForTimeout(6500); // longer than the 5 s server poll
    await expect(log.getByText(/Did you mean/)).toHaveCount(1);
    await say(page, 'yes');
    await expect(log).toContainText(/opened case\s+AUTH-1\d\d/);
    await expect(log).toContainText('Bluegum Vector Demo Pty Ltd');
  });

  test('an authority letter that does not cover the requested clauses is read and asked for again with the exact gaps, instead of being rejected', async ({ page }) => {
    await introduce(page, 'Liam Chen', 'Bluegum Vector Demo Pty Ltd');
    await sendDocuments(page, samples('n8n-liam-chen-bluegum-vector', ...intakeFiles));
    await expect(page.getByTestId('chat-log')).toContainText('Power of Attorney or Memorandum of Association is required');
    await sendDocuments(page, [join(process.cwd(), 'tests', 'fixtures', 'authority-letter-v1.pdf')]);
    const log = page.getByTestId('chat-log');
    await expect(log).toContainText('does not explicitly authorise the representative to order services');
    await expect(log).not.toContainText(/Awaiting specialist confirmation|not approved/);
    await expect(page.getByTestId('evidence-card')).toContainText('INSUFFICIENT');
    await expect(page.getByTestId('evidence-card')).toContainText('attempt 1 of 3');
  });
  test('a guided scenario: the wrong Emirates ID is explained and the right one is accepted; the scenarios are listed with their files', async ({ page }) => {
    await page.goto('/');
    const guided = page.getByTestId('guided-scenarios');
    await guided.locator('summary').click();
    await expect(guided.locator('li[data-testid^="guided-"]')).toHaveCount(10);
    await expect(guided).toContainText('Authority letter: insufficient, then corrected');
    const scenario = (...files: string[]): string[] => files.map((file) => join(process.cwd(), 'apps', 'web', 'public', 'samples', 'scenarios', 'noura-emirates-id-three-attempts', file));
    await say(page, 'My name is Noura Al Falasi and I represent Marina Bay Catering LLC.');
    await expect(page.getByTestId('chat-log')).toContainText(/opened case\s+AUTH-1\d\d/);
    await sendDocuments(page, scenario('emirates-id-v2.pdf', 'trade-license.pdf', 'establishment-card.pdf'));
    await expect(page.getByTestId('chat-log')).toContainText('The Emirates ID belongs to Mariam Saeed, but the request is from Noura Al Falasi.');
    await expect(page.getByTestId('evidence-card')).toContainText('attempt 1 of 3');
    await sendDocuments(page, scenario('emirates-id-v3.pdf'));
    await expect(lastMeta(page)).toContainText('APPROVE');
  });
  test('the demo panel labels each authority document so insufficient evidence can be tested: Liam gets the n8n V1 (insufficient) and V2 (corrected) letters, Marcus his V1 and V2', async ({ page }) => {
    await page.goto('/');
    await page.locator('details.demo', { hasText: 'Demo: synthetic customers and sample documents' }).locator('summary').click();
    const liam = page.getByTestId('persona-n8n-liam-chen-bluegum-vector');
    await expect(liam.getByRole('link', { name: /Authority letter V1 \(n8n AUTH-003\)/ })).toHaveAttribute('href', '/samples/n8n-liam-chen-bluegum-vector/authority-letter-v1.pdf');
    await expect(liam.getByRole('link', { name: /Authority letter V2 \(n8n AUTH-003, revised\)/ })).toHaveAttribute('href', '/samples/n8n-liam-chen-bluegum-vector/authority-letter-v2.pdf');
    await expect(liam).toContainText('test insufficient evidence');
    await expect(liam).toContainText('corrected');
    const marcus = page.getByTestId('persona-n8n-marcus-lee-harbour-quartz');
    await expect(marcus.getByRole('link', { name: /Authority letter V1 \(n8n AUTH-008-V1\)/ })).toBeVisible();
    await expect(marcus.getByRole('link', { name: /Authority letter V2 \(n8n AUTH-008-V2\)/ })).toBeVisible();
    await expect(page.getByTestId('persona-omar-gulf-horizon')).toContainText('day-to-day enquiries only: insufficient evidence (test file)');
  });
  test('a returning customer is told the case is already in progress and carries on in the same case; a closed case is offered for reopening', async ({ page, context }) => {
    await introduce(page, 'Fatima Al Mansoori', 'Al Noor Trading LLC');
    await sendDocuments(page, samples('fatima-al-noor', 'emirates-id.pdf'));
    await expect(page.getByTestId('chat-log')).toContainText('Trade License of the business is still needed');
    // a new conversation (no cookies), the same person and company
    await context.clearCookies();
    await page.goto('/');
    await say(page, 'My name is Fatima Al Mansoori and I represent Al Noor Trading LLC.');
    const log = page.getByTestId('chat-log');
    await expect(log).toContainText('already in progress');
    await expect(log).toContainText('Trade License of the business');
    await expect(page.getByTestId('evidence-card')).toBeVisible();
    await sendDocuments(page, samples('fatima-al-noor', 'trade-license.pdf', 'establishment-card.pdf'));
    await expect(lastMeta(page)).toContainText('APPROVE');
    await expect(log).toContainText(/Case:\s*AUTH-1\d\d/);
    // cancelling a document request closes the case; coming back asks whether to reopen it
    await context.clearCookies();
    await introduce(page, 'Noura Al Falasi', 'Marina Bay Catering LLC');
    await page.getByRole('button', { name: 'Cancel request' }).click();
    await expect(log).toContainText('cancelled');
    await context.clearCookies();
    await page.goto('/');
    await say(page, 'My name is Noura Al Falasi and I represent Marina Bay Catering LLC.');
    await expect(log).toContainText('Would you like to reopen it');
    await say(page, 'yes');
    await expect(log).toContainText('reopened case');
    await expect(page.getByTestId('evidence-card')).toBeVisible();
  });
  test('a company that is not on record is confirmed first and becomes a new lead with onboarding pending', async ({ page }) => {
    await page.goto('/');
    await say(page, 'My name is Zed Nobody and I represent Acme Imaginary Holdings Ltd.');
    await expect(page.getByTestId('chat-log')).toContainText('please confirm');
    await expect(page.getByTestId('chat-log')).not.toContainText('new lead case');
    await say(page, 'yes');
    await expect(page.getByTestId('chat-log')).toContainText('new lead case');
    await expect(page.getByTestId('chat-log')).toContainText('Onboarding status: Pending');
    await expect(page.getByTestId('chat-log')).toContainText('nothing has been approved');
    await expect(page.getByTestId('outcome-meta')).toHaveCount(0);
    await expect(page.getByTestId('evidence-card')).toHaveCount(0);
    await page.getByRole('link', { name: 'Operations' }).click();
    await expect(page.getByTestId('leads-table')).toContainText('Acme Imaginary Holdings Ltd');
    await expect(page.getByTestId('leads-table')).toContainText('PENDING');
  });

  test('Omar is not the licence owner: the chat asks for a POA in the same window, then resumes and approves', async ({ page }) => {
    await introduce(page, 'Omar Haddad', 'Gulf Horizon Contracting LLC');
    await sendDocuments(page, samples('omar-gulf-horizon', ...intakeFiles));
    await expect(page.getByTestId('chat-log')).toContainText('not the licence owner');
    await expect(lastMeta(page)).toContainText('POA_MOA_MISSING');
    await expect(page.getByTestId('evidence-card')).toContainText('Power of Attorney (POA) or Memorandum of Association (MOA)');
    await expect(page.getByLabel('Message')).toHaveCount(0);
    await sendDocuments(page, samples('omar-gulf-horizon', 'authority-letter.pdf'));
    await expect(page.getByRole('heading', { name: /Eligible to proceed/ })).toBeVisible();
    await expect(lastMeta(page)).toContainText('Tools called: POA/MOA Check → Bad Debt Check → AVCV Verification');
  });

  test('missing documents are named and the same prompt stays open for a re-upload', async ({ page }) => {
    await introduce(page, 'Fatima Al Mansoori', 'Al Noor Trading LLC');
    await sendDocuments(page, samples('fatima-al-noor', 'emirates-id.pdf', 'trade-license.pdf'));
    await expect(page.getByTestId('chat-log')).toContainText('Establishment Card of the business is still needed');
    await expect(page.getByTestId('evidence-card')).toContainText('attempt 1 of 3');
    await sendDocuments(page, samples('fatima-al-noor', 'establishment-card.pdf'));
    await expect(page.getByRole('heading', { name: /Eligible to proceed/ })).toBeVisible();
  });

  for (const [slug, name, company, reason] of [
    ['sara-desert-bloom', 'Sara Khan', 'Desert Bloom Cafe LLC', 'TRADE_LICENSE_EXPIRED'],
    ['rashid-falcon', 'Rashid Al Ketbi', 'Falcon Logistics LLC', 'IDENTITY_MISMATCH'],
    ['layla-pearl-coast', 'Layla Nasser', 'Pearl Coast Real Estate LLC', 'BAD_DEBT_OBSERVED'],
    ['yousef-oasis-tech', 'Yousef Ibrahim', 'Oasis Tech Solutions FZ-LLC', 'AVCV_ADVERSE'],
  ] as const) {
    test(`${name}: a rejection is recommended (${reason}) but the customer only sees that a specialist will confirm`, async ({ page }) => {
      await introduce(page, name, company);
      await sendDocuments(page, samples(slug, ...intakeFiles));
      await expect(page.getByRole('heading', { name: /Awaiting specialist confirmation/ })).toBeVisible();
      await expect(lastMeta(page)).toContainText('PENDING CONFIRMATION');
      await expect(lastMeta(page)).not.toContainText(/APPROVE|REJECT/);
      await expect(page.getByTestId('chat-log')).not.toContainText(/PD-DEMO|reject|expired|mismatch|adverse/i);
      const caseRunId = (await lastMeta(page).locator('code').last().innerText()).trim();
      await page.getByRole('link', { name: 'Review dashboard' }).click();
      await expect(page.getByTestId('review-table').getByRole('row', { name: new RegExp(caseRunId) })).toContainText(reason);
    });
  }

  test('Layth is recorded as a manager with full authority: no POA is asked for and he is approved', async ({ page }) => {
    await introduce(page, 'Layth Barakat', 'Al Noor Trading LLC');
    await sendDocuments(page, samples('layth-al-noor', ...intakeFiles));
    await expect(page.getByRole('heading', { name: /Eligible to proceed/ })).toBeVisible();
    await expect(page.getByTestId('chat-log')).not.toContainText('not the licence owner');
  });

  test('Adel: AVCV lacks information, so the chat asks for proof of address in the same window, then approves', async ({ page }) => {
    await introduce(page, 'Adel Mansour', 'Coral Reef Diving LLC');
    await sendDocuments(page, samples('adel-coral-reef', ...intakeFiles));
    await expect(page.getByTestId('chat-log')).toContainText('More information is needed to verify the address');
    await expect(page.getByTestId('evidence-card')).toContainText('Proof of address');
    await sendDocuments(page, samples('adel-coral-reef', 'proof-of-address.pdf'));
    await expect(page.getByRole('heading', { name: /Eligible to proceed/ })).toBeVisible();
  });

  test('Jamal has a recorded limitation on his authority and Reem could not be verified: both go to a specialist, neither is rejected', async ({ page }) => {
    await introduce(page, 'Jamal Farouk', 'Falcon Logistics LLC');
    await sendDocuments(page, samples('jamal-falcon', ...intakeFiles));
    await expect(page.getByRole('heading', { name: /Specialist review required/ })).toBeVisible();
    await expect(page.getByTestId('chat-log')).toContainText('A limitation is recorded on your authority');
    await introduce(page, 'Reem Al Hosani', 'Palm Grove Hospitality LLC');
    await sendDocuments(page, samples('reem-palm-grove', ...intakeFiles));
    await expect(page.getByTestId('chat-log')).toContainText('This is not a failure');
  });

  test('Noura: the DUL API is down, so the licence is verified via the government portal and she still passes', async ({ page }) => {
    await introduce(page, 'Noura Al Falasi', 'Marina Bay Catering LLC');
    await sendDocuments(page, samples('noura-marina-bay', ...intakeFiles));
    await expect(page.getByRole('heading', { name: /Eligible to proceed/ })).toBeVisible();
    await expect(page.getByTestId('chat-log')).toContainText('Passed with a flag');
  });

  test('unsupported and unrecognised files get a clear message and the customer can try again in the same window', async ({ page }) => {
    await introduce(page, 'Fatima Al Mansoori', 'Al Noor Trading LLC');
    await page.getByTestId('file-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('plain text') });
    await expect(page.getByRole('alert')).toContainText('not a supported file');
    await page.getByTestId('file-input').setInputFiles({ name: 'menu.pdf', mimeType: 'application/pdf', buffer: makePdf('Restaurant menu: starters, mains and desserts for the whole family to enjoy.') });
    await page.getByRole('button', { name: 'Send documents' }).click();
    await expect(page.getByRole('alert')).toContainText("couldn't recognise");
    await expect(page.getByRole('alert')).toContainText('Your request remains open.');
    await page.getByRole('button', { name: /Remove menu.pdf/ }).click();
    await sendDocuments(page, samples('fatima-al-noor', ...intakeFiles));
    await expect(page.getByRole('heading', { name: /Eligible to proceed/ })).toBeVisible();
  });

  test('Cancel request stops the document request', async ({ page }) => {
    await introduce(page, 'Fatima Al Mansoori', 'Al Noor Trading LLC');
    await page.getByRole('button', { name: 'Cancel request' }).click();
    await expect(page.getByTestId('chat-log')).toContainText('The document request has been cancelled.');
  });

  test('the assistant offers eight topics; picking a request that is not automated is captured and routed, and shows up on the Operations page', async ({ page }) => {
    await page.goto('/');
    const picker = page.getByTestId('intent-picker');
    await expect(picker.getByRole('button')).toHaveCount(8);
    await expect(picker).toContainText('Move, transfer or port a service');
    await picker.getByRole('button', { name: /Move, transfer or port a service/ }).click();
    await page.getByRole('group', { name: 'Requests in this topic' }).getByRole('button', { name: 'Mobile number portability (porting)' }).click();
    await expect(page.getByTestId('chat-log')).toContainText('not automated in this prototype yet');
    await expect(page.getByTestId('chat-log')).toContainText('Verifier task');
    await say(page, 'Fatima Al Mansoori');
    await say(page, 'Al Noor Trading LLC');
    await expect(page.getByTestId('chat-log')).toContainText('no checks have been run and nothing has been approved or changed');
    await expect(page.getByTestId('outcome-meta')).toHaveCount(0);
    await page.getByRole('link', { name: 'Operations' }).click();
    const row = page.getByTestId('captured-table').getByRole('row', { name: /Mobile number portability/ });
    await expect(row).toContainText('VERIFIER_OPERATIONS');
    await expect(row).toContainText('Al Noor Trading LLC');
    await page.getByTestId('stage-VERIFIER').click();
    await expect(page.getByTestId('stage-detail')).toContainText('1 requests routed here');
  });

  test('pre-populated standard queries start a request in one click', async ({ page }) => {
    await page.goto('/');
    const quick = page.getByTestId('quick-queries');
    await expect(quick.getByRole('button')).toHaveCount(8);
    await quick.getByRole('button', { name: 'I want to add an authorised representative for my company.' }).click();
    await expect(page.getByTestId('chat-log')).toContainText('Happy to help with New authorised representative (LOA)');
    await expect(page.getByTestId('chat-log')).not.toContainText('not automated');
    await say(page, 'My name is Fatima Al Mansoori and I represent Al Noor Trading LLC');
    await expect(page.getByTestId('evidence-card')).toContainText('Emirates ID of the representative');
  });

  test('typing a request in your own words is recognised', async ({ page }) => {
    await page.goto('/');
    await say(page, 'We lost a SIM card and need it replaced');
    await expect(page.getByTestId('chat-log')).toContainText('Happy to help with SIM replacement');
    await expect(page.getByTestId('chat-log')).toContainText('Verifier task');
  });

  test('the Operations page shows the six stages of the operating model with only profiling live', async ({ page }) => {
    await page.goto('/operations');
    const pipeline = page.getByTestId('pipeline');
    for (const name of ['Profiling', 'Verifier task', 'Processing', 'Control tower', 'Governance', 'Reporting']) await expect(pipeline).toContainText(name);
    await expect(page.getByRole('list', { name: 'Operating-model stages' }).getByRole('listitem')).toHaveCount(6);
    await expect(page.getByTestId('stage-PROFILING')).toContainText('Live');
    await expect(page.getByTestId('stage-PROFILING')).toHaveAttribute('aria-current', 'step');
    await expect(page.getByTestId('stage-detail')).toContainText('Automated: New authorised representative (LOA)');
    await page.getByTestId('stage-CONTROL_TOWER').click();
    await expect(page.getByTestId('stage-CONTROL_TOWER')).toContainText('Not built');
    await expect(page.getByTestId('stage-detail')).toContainText('Control tower');
    await expect(page.getByTestId('loa-pipeline')).toContainText('Awaiting documents');
    await expect(page.getByTestId('kpis')).toContainText('New leads');
  });

  test('the demo panel lists every synthetic customer with downloadable sample documents; there is no upload page or resubmission page', async ({ page }) => {
    await page.goto('/');
    await page.getByText('Demo: synthetic customers and sample documents').click();
    await expect(page.locator('[data-testid^="persona-"]')).toHaveCount(27);
    await expect(page.getByTestId('persona-omar-gulf-horizon')).toContainText('Power of Attorney');
    await expect(page.getByTestId('persona-omar-gulf-horizon').getByRole('link', { name: /Authority letter - explicit clauses/ })).toHaveAttribute('href', '/samples/omar-gulf-horizon/authority-letter.pdf');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.getByRole('link', { name: /upload|resubmi/i })).toHaveCount(0);
    await expect(nav.getByRole('link')).toHaveText(['Assessment chat', 'Operations', 'Review dashboard', 'Case status']);
  });
});

test.describe('review dashboard and the reopen workflow', () => {
  async function rejected(page: Page, slug = 'sara-desert-bloom', name = 'Sara Khan', company = 'Desert Bloom Cafe LLC') {
    await introduce(page, name, company);
    await sendDocuments(page, samples(slug, ...intakeFiles));
    await expect(page.getByRole('heading', { name: /Awaiting specialist confirmation/ })).toBeVisible();
    return (await lastMeta(page).locator('code').last().innerText()).trim();
  }

  test('an empty dashboard says so', async ({ page }) => {
    await page.goto('/review');
    await expect(page.getByRole('heading', { name: 'Review dashboard' })).toBeVisible();
    await expect(page.getByTestId('review-table')).toContainText(/No open reviews|Loading|REV-/);
  });

  test('the dashboard lists the review with its Review ID; opening it shows checks, documents and the root-cause analysis; a rejection is confirmed once', async ({ page }) => {
    const caseRunId = await rejected(page);
    await page.getByRole('link', { name: 'Review dashboard' }).click();
    const row = page.getByTestId('review-table').getByRole('row', { name: new RegExp(caseRunId) });
    await expect(row).toContainText(`REV-${caseRunId}-1`);
    await expect(row).toContainText('Desert Bloom Cafe LLC');
    await expect(row).toContainText('TRADE_LICENSE_EXPIRED');
    await expect(row).toContainText('PENDING REJECTION CONFIRMATION');
    await row.getByRole('button', { name: /Open review/ }).click();
    const detail = page.getByTestId('review-detail');
    await expect(detail).toContainText('Trade License Check');
    await expect(detail).toContainText('TRADE LICENSE — trade-license.pdf');
    await expect(detail).toContainText('Root-cause analysis (SBO.20)');
    await expect(detail).toContainText('The trade licence had expired');
    await detail.getByLabel('Reviewer name').fill('Riley Reviewer');
    const form = page.getByTestId('review-form');
    await form.getByLabel('Reviewer decision').selectOption('REJECT');
    await form.getByLabel('Reviewer comments').fill('Confirmed: the licence has expired.');
    await form.getByRole('button', { name: 'Complete review' }).click();
    await expect(page.getByRole('heading', { name: 'Human review completed' })).toBeVisible();
    await expect(page.getByText('The communication remains a draft and has not been sent.')).toBeVisible();
    await page.getByRole('button', { name: 'Closed' }).click();
    await expect(page.getByTestId('review-table').getByRole('row', { name: new RegExp(caseRunId) })).toContainText('COMPLETED');
  });

  test('overturning a rejection requires an override reason', async ({ page }) => {
    await rejected(page, 'tariq-sahara', 'Tariq Mahmood', 'Sahara Staffing Services LLC');
    await page.goto('/review');
    await page.getByRole('button', { name: /Open review/ }).first().click();
    const detail = page.getByTestId('review-detail');
    await detail.getByLabel('Reviewer name').fill('Riley Reviewer');
    const form = page.getByTestId('review-form');
    await form.getByLabel('Reviewer decision').selectOption('APPROVE');
    await expect(form.getByLabel('Override reason (required)')).toBeVisible();
  });

  test("reopen: the reviewer reopens a rejected case with a note; the customer's chat asks for documents again — no separate form — and answers there", async ({ page }) => {
    const caseRunId = await rejected(page);
    await page.goto('/review');
    await page.getByRole('button', { name: `Open review REV-${caseRunId}-1` }).click();
    const reopenForm = page.getByTestId('reopen-form');
    await expect(reopenForm).toContainText(`${caseRunId}-V2`);
    await page.getByTestId('review-detail').getByLabel('Reviewer name').fill('Riley Reviewer');
    await reopenForm.getByLabel('Note to the customer').fill('Please send the renewed Trade License.');
    await reopenForm.getByRole('button', { name: 'Reopen case' }).click();
    await expect(page.getByRole('heading', { name: 'Case reopened' })).toBeVisible();
    // back in the chat (same browser session): the page picks up the new document request
    await page.getByRole('link', { name: 'Assessment chat' }).click();
    await expect(page.getByTestId('chat-log')).toContainText('A reviewer reopened your request');
    await expect(page.getByTestId('chat-log')).toContainText('Please send the renewed Trade License.');
    await expect(page.getByTestId('evidence-card')).toContainText('Trade License of the business');
    await sendDocuments(page, samples('sara-desert-bloom', ...intakeFiles));
    await expect(lastMeta(page)).toContainText(`${caseRunId}-V2`);
    await page.goto(`/status?case_run_id=${caseRunId}`);
    await expect(page.getByTestId('status-view')).toContainText('REOPENED AS NEW VERSION');
  });

  test('the old resubmission page is gone', async ({ page }) => {
    await page.goto('/resubmit');
    await expect(page.getByRole('heading', { name: 'Customer assessment' })).toBeVisible(); // unknown routes fall back to the chat
  });
});

test.describe('case status page', () => {
  test('shows a case waiting for documents, then the persisted decision, the drafted communication and its evidence', async ({ page }) => {
    await introduce(page, 'Fatima Al Mansoori', 'Al Noor Trading LLC');
    const caseRunId = (await page.getByTestId('chat-log').innerText()).match(/AUTH-1\d\d/)![0];
    await page.goto(`/status?case_run_id=${caseRunId}`);
    const before = page.getByTestId('status-view');
    await expect(before).toContainText('WAITING FOR EVIDENCE');
    await expect(before).toContainText('Emirates ID of the representative');
    await expect(before).toContainText('All data shown is synthetic.');
    await page.goto('/');
    await expect(page.getByTestId('evidence-card')).toBeVisible(); // the open request is picked up again after a reload
    await sendDocuments(page, samples('fatima-al-noor', ...intakeFiles));
    await expect(page.getByRole('heading', { name: /Eligible to proceed/ })).toBeVisible();
    await page.goto(`/status?case_run_id=${caseRunId}`);
    const after = page.getByTestId('status-view');
    await expect(after).toContainText('READY TO PROCEED');
    await expect(after).toContainText('ALL_CHECKS_PASSED');
    await expect(after).toContainText('COMM-APPROVE');
    await expect(after).toContainText('Drafts are never sent.');
  });

  test('reports unknown cases without an error page', async ({ page }) => {
    await page.goto('/status');
    await page.getByLabel('Case run ID').fill('AUTH-404');
    await page.getByRole('button', { name: 'View status' }).click();
    await expect(page.getByRole('alert')).toContainText('was not found');
  });
});

test.describe('layout and accessibility', () => {
  for (const path of ['/', '/operations', '/review', '/status']) {
    test(`${path} has landmarks, a synthetic banner and no horizontal scroll on a phone`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(path);
      await expect(page.getByRole('banner')).toBeVisible();
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
      await expect(page.getByRole('note')).toContainText('Synthetic data');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }

  test('primary navigation is keyboard operable and marks the current page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Case status' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/status$/);
    await expect(page.getByRole('link', { name: 'Case status' })).toHaveAttribute('aria-current', 'page');
  });
});
