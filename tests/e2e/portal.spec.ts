import { expect, test, type Page } from '@playwright/test';
import { makePdf } from '@sbo/testkit';

const authorityText = 'The signed authority letter grants account management, service ordering, plan changes and contract approval.';

async function send(page: Page, message: string) {
  await page.getByLabel('Message').fill(message);
  await page.getByRole('button', { name: 'Send' }).click();
}
async function evaluate(page: Page, caseRunId: string) {
  await page.goto('/');
  await page.getByRole('button', { name: caseRunId, exact: true }).click();
}
const lastAgentTurn = (page: Page) => page.locator('.turn-agent').last();

test.describe('chat', () => {
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

  test('unknown input and unknown cases get safe messages', async ({ page }) => {
    await page.goto('/');
    await send(page, 'hello');
    await expect(page.getByTestId('chat-log')).toContainText('I could not find a supported synthetic Case Run ID.');
    await send(page, 'Evaluate AUTH-999');
    await expect(page.getByTestId('chat-log')).toContainText('was not found. No assessment was performed.');
  });

  test('AUTH-003 evidence loop: TEXT evidence is accepted and the assessment resumes from the next incomplete check', async ({ page }) => {
    await evaluate(page, 'AUTH-003');
    await expect(page.getByTestId('chat-log')).toContainText('Reply TEXT to enter the clarification directly in this chat.');
    await expect(page.getByTestId('evidence-card')).toContainText('Exact authority clause or revised authority document');
    await page.getByRole('button', { name: 'TEXT', exact: true }).click();
    await expect(page.getByTestId('chat-log')).toContainText('Type CANCEL to stop this evidence request.');
    await send(page, authorityText);
    await expect(page.getByTestId('chat-log')).toContainText('Thank you. The additional evidence has resolved the identified gap.');
    await expect(page.getByTestId('outcome-meta').last()).toContainText('Tools called: System Data Check');
    await expect(page.getByTestId('chat-log')).toContainText('Authority validation — Passed');
    expect(await page.getByTestId('chat-log').innerText()).not.toContain(authorityText.slice(0, 40) + 'X');
  });

  test('AUTH-003 evidence loop: contradictory evidence is escalated to a human evidence reviewer', async ({ page }) => {
    await evaluate(page, 'AUTH-003');
    await page.getByRole('button', { name: 'TEXT', exact: true }).click();
    await send(page, 'The representative left the company and this CONTRADICTS the earlier letter.');
    await expect(page.getByTestId('chat-log')).toContainText('The new evidence conflicts with previously validated case information.');
    await expect(page.getByTestId('chat-log')).toContainText('No automated reconciliation or final adverse decision has been made.');
  });

  test('AUTH-003 evidence loop: cancel stops the request', async ({ page }) => {
    await evaluate(page, 'AUTH-003');
    await page.getByRole('button', { name: 'TEXT', exact: true }).click();
    await page.getByRole('button', { name: 'CANCEL', exact: true }).click();
    await expect(page.getByTestId('chat-log')).toContainText('The additional-evidence request has been cancelled.');
  });
});

test.describe('evidence upload page', () => {
  async function openUploadRequest(page: Page, caseRunId = 'AUTH-002') {
    await evaluate(page, caseRunId);
    const card = page.getByTestId('evidence-card');
    await expect(card).toBeVisible();
    const requestId = (await card.locator('code').first().innerText()).trim();
    return requestId;
  }

  test('accepts a text PDF, shows what was received, and the chat can continue with UPLOADED', async ({ page }) => {
    const requestId = await openUploadRequest(page);
    await expect(page.getByTestId('chat-log')).toContainText('reply UPLOADED');
    await page.goto(`/upload?evidence_request_id=${encodeURIComponent(requestId)}&case_run_id=AUTH-002`);
    await expect(page.getByTestId('upload-form')).toContainText('Authority letter or approved delegation evidence');
    await page.getByLabel('Evidence type').selectOption('AUTHORITY_DOCUMENT');
    await page.getByLabel('Evidence notes').fill('Signed letter of authority');
    await page.getByLabel(/Evidence file/).setInputFiles({ name: 'authority letter.pdf', mimeType: 'application/pdf', buffer: makePdf(authorityText) });
    await page.getByRole('button', { name: 'Upload evidence' }).click();
    await expect(page.getByRole('heading', { name: 'Evidence uploaded' })).toBeVisible();
    await expect(page.getByText('authority letter.pdf')).toBeVisible();
    await expect(page.getByText('Return to the Agent chat and type')).toBeVisible();
    // back in the chat (fresh page load starts a fresh UI, but the server session cookie persists)
    await page.goto('/');
    await send(page, 'UPLOADED');
    await expect(page.getByTestId('chat-log')).toContainText('Thank you. The additional evidence has resolved the identified gap.');
  });

  test('rejects an unknown request and a mismatched case with the stored row as authority', async ({ page }) => {
    await page.goto('/upload?evidence_request_id=EVID-NOPE');
    await expect(page.getByTestId('upload-rejected')).toContainText('EVIDENCE_REQUEST_NOT_FOUND');
    await expect(page.getByTestId('upload-rejected')).toContainText('No case or evidence record was changed.');
    const requestId = await openUploadRequest(page, 'AUTH-002');
    await page.goto(`/upload?evidence_request_id=${encodeURIComponent(requestId)}&case_run_id=AUTH-005`);
    await expect(page.getByTestId('upload-rejected')).toContainText('CASE_RUN_ID_MISMATCH');
    await expect(page.getByTestId('upload-rejected')).toContainText('AUTH-002');
  });

  test('rejects non-PDF files and PDFs without readable text, leaving the request open', async ({ page }) => {
    const requestId = await openUploadRequest(page, 'AUTH-002');
    await page.goto(`/upload?evidence_request_id=${encodeURIComponent(requestId)}&case_run_id=AUTH-002`);
    await page.getByLabel(/Evidence file/).setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('plain text') });
    await page.getByRole('button', { name: 'Upload evidence' }).click();
    await expect(page.getByRole('alert')).toContainText('Only PDF files are accepted.');
    await page.getByLabel(/Evidence file/).setInputFiles({ name: 'blank.pdf', mimeType: 'application/pdf', buffer: makePdf('x') });
    await page.getByRole('button', { name: 'Upload evidence' }).click();
    await expect(page.getByRole('alert')).toContainText('did not contain enough extractable text');
    await expect(page.getByRole('alert')).toContainText('The evidence request remains open.');
    await expect(page.getByTestId('upload-form')).toBeVisible();
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
  for (const path of ['/', '/upload', '/review', '/status', '/resubmit']) {
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
