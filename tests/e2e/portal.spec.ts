import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';
import { makePdf } from '@sbo/testkit';

const authorityText = 'The signed authority letter grants account management, service ordering, plan changes and contract approval.';

async function send(page: Page, message: string) {
  await page.getByLabel('Message').fill(message);
  await page.getByRole('button', { name: 'Send' }).click();
}
async function evaluate(page: Page, caseRunId: string) {
  await page.goto('/');
  await page.getByText('Demo: synthetic identities you can use').click();
  await page.getByRole('button', { name: caseRunId, exact: true }).click();
}
async function introduce(page: Page, name: string, company: string) {
  await page.goto('/');
  await send(page, `My name is ${name} and I represent ${company}.`);
}
const lastAgentTurn = (page: Page) => page.locator('.turn-agent').last();
const wordFile = async (text: string) => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
};

test.describe('chat', () => {
  test('a new customer introduces themselves; a case is opened and assessed', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('chat-log')).toContainText('tell me your name and the company you represent');
    await send(page, 'hello');
    await expect(page.getByTestId('chat-log')).toContainText('the company you represent');
    await send(page, 'Hi, my name is Liam Chen');
    await expect(page.getByTestId('chat-log')).toContainText('Which company are you representing?');
    await send(page, 'Bluegum Vector Demo Pty Ltd');
    await expect(page.getByTestId('chat-log')).toContainText(/opened case\s+AUTH-1\d\d/);
    await expect(page.getByTestId('evidence-card')).toContainText('Exact authority clause or revised authority document');
    await expect(page.getByTestId('chat-log')).not.toContainText(/reply UPLOADED|Reply TEXT/i);
  });

  test('AUTH-001 returns a curated approval with a visible tool trace and synthetic banners', async ({ page }) => {
    await evaluate(page, 'AUTH-001');
    const reply = lastAgentTurn(page);
    await expect(reply.getByRole('heading', { name: /Eligible to proceed/ })).toBeVisible();
    await expect(reply.getByText('All mandatory checks completed successfully.')).toBeVisible();
    await expect(page.getByTestId('outcome-meta')).toContainText('APPROVE');
    await expect(page.getByTestId('outcome-meta')).toContainText('Document Checks → Business Validation → Identity Validation → Authority Validation → System Data Check → Financial Check → Final Verification');
    await expect(page.getByRole('note')).toContainText('Synthetic data');
    const text = await page.getByTestId('chat-log').innerText();
    expect(text).not.toMatch(/CTRL-|FINAL-001|findings|rule_ids|systemMessage|prompt/i);
    await expect(page.getByTestId('session-id')).not.toHaveText('…');
  });

  test('AUTH-005 is explained as a specialist review with its operational route', async ({ page }) => {
    await evaluate(page, 'AUTH-005');
    const reply = lastAgentTurn(page);
    await expect(reply.getByRole('heading', { name: /Specialist review required/ })).toBeVisible();
    await expect(reply).toContainText('Conflicting customer or party records require reconciliation.');
    await expect(reply).toContainText('Customer Data Reconciliation');
    await expect(page.getByTestId('outcome-meta')).toContainText('DUPLICATE_RECORD_CONFLICT');
  });

  test('AUTH-010 (TBD policy) is routed to policy review and never approved', async ({ page }) => {
    await evaluate(page, 'AUTH-010');
    await expect(lastAgentTurn(page)).toContainText('The case requires review by the relevant policy owner.');
    await expect(page.getByTestId('outcome-meta')).toContainText('TBD_POLICY');
    await expect(page.getByTestId('outcome-meta')).not.toContainText('APPROVE');
  });

  test('an unknown case id gets a safe message', async ({ page }) => {
    await page.goto('/');
    await send(page, 'Evaluate AUTH-999');
    await expect(page.getByTestId('chat-log')).toContainText('was not found. No assessment was performed.');
  });

  test('an unrecognised customer is routed to a specialist instead of being approved', async ({ page }) => {
    await introduce(page, 'Zed Nobody', 'Acme Imaginary Holdings Ltd');
    await expect(page.getByTestId('outcome-meta')).toContainText('MANUAL REVIEW');
    await expect(page.getByTestId('outcome-meta')).not.toContainText('APPROVE');
  });

  test('evidence loop: the customer just types the answer (no TEXT/UPLOAD/UPLOADED words) and the assessment resumes', async ({ page }) => {
    await evaluate(page, 'AUTH-003');
    await expect(page.getByTestId('evidence-card')).toContainText('Exact authority clause or revised authority document');
    await expect(page.getByTestId('chat-log')).toContainText('attach documents (PDF, Word or image files)');
    await send(page, authorityText);
    await expect(page.getByTestId('chat-log')).toContainText('Thank you. The additional evidence has resolved the identified gap.');
    await expect(page.getByTestId('outcome-meta').last()).toContainText('Tools called: System Data Check');
    await expect(page.getByTestId('chat-log')).toContainText('Authority validation — Passed');
  });

  test('evidence loop: contradictory evidence is escalated to a human evidence reviewer', async ({ page }) => {
    await evaluate(page, 'AUTH-003');
    await send(page, 'The representative left the company and this CONTRADICTS the earlier letter.');
    await expect(page.getByTestId('chat-log')).toContainText('The new evidence conflicts with previously validated case information.');
    await expect(page.getByTestId('chat-log')).toContainText('No automated reconciliation or final adverse decision has been made.');
  });

  test('evidence loop: Cancel request stops the request', async ({ page }) => {
    await evaluate(page, 'AUTH-003');
    await page.getByRole('button', { name: 'Cancel request' }).click();
    await expect(page.getByTestId('chat-log')).toContainText('The additional-evidence request has been cancelled.');
  });

  test('documents are attached in the same chat window: several formats at once, listed before sending', async ({ page }) => {
    await introduce(page, 'Hana Rangi', 'Kauri Harbour Demo Digital Limited');
    await expect(page.getByTestId('evidence-card')).toBeVisible();
    expect(page.url()).toMatch(/\/$/);
    await page.getByTestId('file-input').setInputFiles([
      { name: 'authority letter.pdf', mimeType: 'application/pdf', buffer: makePdf(authorityText) },
      { name: 'authority letter.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await wordFile(authorityText) },
    ]);
    await expect(page.getByLabel('Attached files')).toContainText('authority letter.pdf');
    await expect(page.getByLabel('Attached files')).toContainText('authority letter.docx');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('chat-log')).toContainText('authority letter.pdf');
    await expect(page.getByTestId('chat-log')).toContainText('Thank you. The additional evidence has resolved the identified gap.');
  });

  test('an unsupported or unreadable file is refused with a clear message and the customer can try again in the same window', async ({ page }) => {
    await introduce(page, 'Hana Rangi', 'Kauri Harbour Demo Digital Limited');
    await page.getByTestId('file-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('plain text') });
    await expect(page.getByRole('alert')).toContainText('not a supported file');
    await page.getByTestId('file-input').setInputFiles({ name: 'blank.pdf', mimeType: 'application/pdf', buffer: makePdf('x') });
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('alert')).toContainText("couldn't read enough text");
    await expect(page.getByRole('alert')).toContainText('Your request remains open.');
    // still attached, still able to fix it: replace with a good document and send again
    await page.getByRole('button', { name: /Remove blank.pdf/ }).click();
    await page.getByTestId('file-input').setInputFiles({ name: 'letter.pdf', mimeType: 'application/pdf', buffer: makePdf(authorityText) });
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('chat-log')).toContainText('Thank you. The additional evidence has resolved the identified gap.');
  });

  test('there is no separate upload page or navigation entry', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /upload/i })).toHaveCount(0);
  });
});
test.describe('human review portal', () => {
  test('completes a review once and blocks the duplicate submission', async ({ page }) => {
    await evaluate(page, 'AUTH-005');
    await page.goto('/review?review_id=REV-AUTH-005-1');
    await page.getByRole('button', { name: 'Open review' }).click();
    const form = page.getByTestId('review-form');
    await expect(form).toContainText('Review case AUTH-005');
    await expect(form).toContainText('DUPLICATE_RECORD_CONFLICT');
    await expect(form).toContainText('Conflicting legal names exist across CRM records.');
    await form.getByLabel('Reviewer name').fill('Riley Reviewer');
    await form.getByLabel('Reviewer decision').selectOption('NEED_MORE_INFORMATION');
    await form.getByLabel('Reviewer comments').fill('Please supply the reconciled CRM account name.');
    await form.getByRole('button', { name: 'Complete review' }).click();
    await expect(page.getByRole('heading', { name: 'Human review completed' })).toBeVisible();
    await expect(page.getByText('The communication remains a draft and has not been sent.')).toBeVisible();
    await expect(page.getByText('Please supply the reconciled CRM account name.').first()).toBeVisible();
    // opening it again is refused
    await page.getByLabel('Review ID').fill('REV-AUTH-005-1');
    await page.getByRole('button', { name: 'Open review' }).click();
    await expect(page.getByRole('alert')).toContainText('already been completed');
    await expect(page.getByTestId('review-form')).toHaveCount(0);
  });

  test('requires an override reason when changing a REJECT recommendation and reports unknown reviews', async ({ page }) => {
    await evaluate(page, 'AUTH-004');
    await page.goto('/review?review_id=REV-AUTH-004-1');
    await page.getByRole('button', { name: 'Open review' }).click();
    const form = page.getByTestId('review-form');
    await form.getByLabel('Reviewer name').fill('Riley Reviewer');
    await form.getByLabel('Reviewer decision').selectOption('APPROVE');
    await expect(form.getByLabel('Override reason (required)')).toBeVisible();
    await form.getByLabel('Reviewer comments').fill('Register looked stale.');
    await form.getByRole('button', { name: 'Complete review' }).click();
    // the native required attribute blocks the submit until the override reason is provided
    await expect(form).toBeVisible();
    await form.getByLabel('Override reason (required)').fill('Verified active by manual register check.');
    await form.getByRole('button', { name: 'Complete review' }).click();
    await expect(page.getByRole('heading', { name: 'Human review completed' })).toBeVisible();
    await page.getByLabel('Review ID').fill('REV-NOPE');
    await page.getByRole('button', { name: 'Open review' }).click();
    await expect(page.getByRole('alert')).toContainText('could not be located');
  });
});

test.describe('case status page', () => {
  test('shows an unassessed case, then the full persisted state after assessment', async ({ page }) => {
    await page.goto('/status?case_run_id=AUTH-007');
    const before = page.getByTestId('status-view');
    await expect(before).toContainText('INITIAL');
    await expect(before).toContainText('has not been assessed');
    await expect(before).toContainText('All data shown is synthetic.');
    await evaluate(page, 'AUTH-007');
    await page.goto('/status?case_run_id=AUTH-007');
    const after = page.getByTestId('status-view');
    await expect(after).toContainText('REVIEW PENDING');
    await expect(after).toContainText('REGISTRY_UNAVAILABLE');
    await expect(after).toContainText('REGISTRY_VERIFICATION');
    await expect(after).toContainText('REV-AUTH-007-1');
    await expect(after).toContainText('Drafts are never sent.');
    await expect(after).toContainText('Workflow 93 was absent');
  });

  test('reports unknown cases without an error page', async ({ page }) => {
    await page.goto('/status');
    await page.getByLabel('Case run ID').fill('AUTH-404');
    await page.getByRole('button', { name: 'View status' }).click();
    await expect(page.getByRole('alert')).toContainText('was not found');
  });
});

test.describe('resubmission', () => {
  test('AUTH-008-V1 → AUTH-008-V2: revised case is approved and the original is superseded', async ({ page }) => {
    await evaluate(page, 'AUTH-008-V1');
    await expect(lastAgentTurn(page)).toBeVisible();
    await page.goto('/resubmit');
    await page.getByLabel('Resubmission comments').fill('Updated authority letter attached.');
    await page.getByRole('button', { name: 'Submit resubmission' }).click();
    await expect(page.getByRole('heading', { name: 'Revised assessment completed' })).toBeVisible();
    await expect(page.getByText('APPROVE', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('The original submission has been marked as superseded.')).toBeVisible();
    await page.goto('/status?case_run_id=AUTH-008-V1');
    await expect(page.getByTestId('status-view')).toContainText('SUPERSEDED BY RESUBMISSION');
    await page.goto('/resubmit');
    await page.getByLabel('Resubmission comments').fill('again');
    await page.getByRole('button', { name: 'Submit resubmission' }).click();
    await expect(page.getByRole('alert')).toContainText('already been resubmitted');
  });
});

test.describe('layout and accessibility', () => {
  for (const path of ['/', '/review', '/status', '/resubmit']) {
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
