import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '@sbo/persistence';
import { createToolbox, evaluateCase, executeUtility, utilityCatalog } from '@sbo/workflows';
import { caseWithDocuments, newStore, ScriptedRuntime } from '@sbo/testkit';

describe('runtime result persistence contract (case_run_id + submission_version + check_type)', () => {
  it('one utility cannot overwrite another utility\'s row', async () => {
    const { store, caseRunId } = await caseWithDocuments('fatima-al-noor');
    await executeUtility(store, { caseRunId, submissionVersion: 1, checkType: 'TRADE_LICENSE_CHECK' });
    await executeUtility(store, { caseRunId, submissionVersion: 1, checkType: 'IDENTITY_VALIDATION' });
    expect((await store.getRuntimeResults(caseRunId, 1)).map((row) => row.checkType)).toEqual(['TRADE_LICENSE_CHECK', 'IDENTITY_VALIDATION']);
  });

  it('rerunning the same utility is idempotent: one row, latest content wins', async () => {
    const { store, caseRunId } = await caseWithDocuments('fatima-al-noor');
    await executeUtility(store, { caseRunId, submissionVersion: 1, checkType: 'TRADE_LICENSE_CHECK' });
    await store.upsertUtilityResult({ ...(await store.getRuntimeResults(caseRunId, 1))[0]!, status: 'CHANGED' });
    await executeUtility(store, { caseRunId, submissionVersion: 1, checkType: 'TRADE_LICENSE_CHECK' });
    const rows = await store.getRuntimeResults(caseRunId, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('PASS');
  });

  it('the key includes submission_version: the same case and check at two versions coexist', async () => {
    const { store, caseRunId } = await caseWithDocuments('fatima-al-noor');
    const first = await executeUtility(store, { caseRunId, submissionVersion: 1, checkType: 'TRADE_LICENSE_CHECK' });
    await store.upsertUtilityResult({ ...first, submissionVersion: 2 });
    expect(await store.getRuntimeResults(caseRunId, 1)).toHaveLength(1);
    expect(await store.getRuntimeResults(caseRunId, 2)).toHaveLength(1);
  });

  it('the key includes case_run_id: different cases never collide', async () => {
    const one = await caseWithDocuments('fatima-al-noor');
    const two = await caseWithDocuments('sara-desert-bloom', undefined, one.store);
    await executeUtility(one.store, { caseRunId: one.caseRunId, submissionVersion: 1, checkType: 'TRADE_LICENSE_CHECK' });
    await executeUtility(one.store, { caseRunId: two.caseRunId, submissionVersion: 1, checkType: 'TRADE_LICENSE_CHECK' });
    expect((await one.store.getRuntimeResults(one.caseRunId, 1))[0]?.status).toBe('PASS');
    expect((await one.store.getRuntimeResults(two.caseRunId, 1))[0]?.status).toBe('FAIL');
  });

  it('five checks remain five unique check types for a clean case', async () => {
    const { store, caseRunId } = await caseWithDocuments('fatima-al-noor');
    await evaluateCase(store, new ScriptedRuntime(), caseRunId, 's');
    const rows = await store.getRuntimeResults(caseRunId, 1);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.checkType)).size).toBe(5);
    expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it('the assessment entry reset deletes only the exact case_run_id + submission_version rows', async () => {
    const { store, caseRunId } = await caseWithDocuments('fatima-al-noor');
    const other = await caseWithDocuments('noura-marina-bay', undefined, store);
    await evaluateCase(store, new ScriptedRuntime(), other.caseRunId, 's');
    await evaluateCase(store, new ScriptedRuntime(), caseRunId, 's');
    await store.deleteRuntimeResults(caseRunId, 1);
    expect(await store.getRuntimeResults(caseRunId, 1)).toEqual([]);
    expect(await store.getRuntimeResults(other.caseRunId, 1)).toHaveLength(5);
  });

  it('a failed transaction leaves no partial runtime state', async () => {
    const { store, caseRunId } = await caseWithDocuments('fatima-al-noor');
    await expect(store.transaction(async (transaction) => {
      await executeUtility(transaction, { caseRunId, submissionVersion: 1, checkType: 'TRADE_LICENSE_CHECK' });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await store.getRuntimeResults(caseRunId, 1)).toEqual([]);
    expect((await store.getAudit(caseRunId)).some((event) => event.eventType === 'UTILITY_CHECK_COMPLETED')).toBe(false);
  });

  it('resetRuntime clears every runtime table and restarts case numbering; the registers, rules and templates live in code and survive', async () => {
    const { store, caseRunId } = await caseWithDocuments('fatima-al-noor');
    await evaluateCase(store, new ScriptedRuntime(), caseRunId, 's');
    expect(caseRunId).toBe('AUTH-101');
    await store.resetRuntime();
    expect(await store.listCases()).toEqual([]);
    expect(await store.getRuntimeResults(caseRunId, 1)).toEqual([]);
    expect((await store.getRules()).length).toBeGreaterThan(20);
    expect(await store.getTemplate('COMM-APPROVE')).toBeDefined();
    expect((await caseWithDocuments('fatima-al-noor', undefined, store)).caseRunId).toBe('AUTH-101');
  });

  it('an unsupported check type and an unknown case are refused', async () => {
    const { store, caseRunId } = await caseWithDocuments('fatima-al-noor');
    await expect(executeUtility(store, { caseRunId, submissionVersion: 1, checkType: 'SYSTEM_DATA_CHECK' })).rejects.toThrow('UNSUPPORTED_CHECK_TYPE');
    await expect(executeUtility(store, { caseRunId: 'AUTH-999', submissionVersion: 1, checkType: 'TRADE_LICENSE_CHECK' })).rejects.toThrow('CASE_NOT_FOUND');
  });

  it('a check reads only the documents of its own submission version', async () => {
    const { store, caseRunId } = await caseWithDocuments('fatima-al-noor');
    const result = await executeUtility(store, { caseRunId, submissionVersion: 2, checkType: 'TRADE_LICENSE_CHECK' });
    expect(result).toMatchObject({ status: 'INCONCLUSIVE', reasonCodes: ['DOCUMENT_UNREADABLE'] }); // no documents exist for version 2
  });
});

describe('toolbox (the agent\'s only capability)', () => {
  it('exposes exactly the five specialist tools and nothing else', async () => {
    const { store, caseRunId } = await caseWithDocuments('fatima-al-noor');
    const toolbox = createToolbox(store, (await store.getCase(caseRunId))!);
    expect(toolbox.tools.map((tool) => tool.name)).toEqual(['Trade License Check', 'Identity Validation', 'POA/MOA Check', 'Bad Debt Check', 'AVCV Verification']);
    expect(utilityCatalog).toHaveLength(5);
    expect(await toolbox.call('Delete Everything')).toMatchObject({ allowed: false, message: 'UNKNOWN_TOOL:Delete Everything' });
  });

  it('refuses to skip an incomplete earlier check and persists nothing', async () => {
    const { store, caseRunId } = await caseWithDocuments('fatima-al-noor');
    const toolbox = createToolbox(store, (await store.getCase(caseRunId))!);
    expect(await toolbox.call('AVCV Verification')).toMatchObject({ allowed: false, message: expect.stringContaining('EARLIER_CHECK_INCOMPLETE:TRADE_LICENSE_CHECK') });
    expect(await store.getRuntimeResults(caseRunId, 1)).toEqual([]);
  });

  it('never repeats a passed check', async () => {
    const { store, caseRunId } = await caseWithDocuments('fatima-al-noor');
    const toolbox = createToolbox(store, (await store.getCase(caseRunId))!);
    expect((await toolbox.call('Trade License Check')).allowed).toBe(true);
    expect(await toolbox.call('Trade License Check')).toMatchObject({ allowed: false, message: expect.stringContaining('already has a passing result') });
  });

  it('stops after a terminal result: later tools are refused', async () => {
    const { store, caseRunId } = await caseWithDocuments('sara-desert-bloom');
    const toolbox = createToolbox(store, (await store.getCase(caseRunId))!);
    expect(await toolbox.call('Trade License Check')).toMatchObject({ allowed: true, result: { is_terminal: true, terminal_outcome: 'REJECT' } });
    expect(await toolbox.call('Identity Validation')).toMatchObject({ allowed: false, message: expect.stringContaining('TERMINAL_RESULT_ALREADY_RETURNED') });
  });

  it('returns typed utility result fields (findings, reason codes, rule ids, evidence references, terminal flags)', async () => {
    const { store, caseRunId } = await caseWithDocuments('fatima-al-noor');
    const toolbox = createToolbox(store, (await store.getCase(caseRunId))!);
    const observation = await toolbox.call('Trade License Check');
    expect(observation.result).toMatchObject({ case_run_id: caseRunId, sequence: 1, agent_id: 'SBO.06', utility_name: 'Trade License Check', check_type: 'TRADE_LICENSE_CHECK', status: 'PASS', reason_codes: ['TRADE_LICENSE_VALID'], rule_ids: ['TL-000'], is_terminal: false, terminal_outcome: 'CONTINUE', prototype_data: true });
    expect((observation.result?.evidence_references as string[]).length).toBe(2);
  });
});

describe('in-memory repository basics', () => {
  it('assigns sequential case ids and versions and refuses duplicates', async () => {
    const store: InMemoryRepository = newStore();
    const record = { submissionVersion: 1, country: 'AE', requestType: 'X', channel: 'T', businessName: 'B', businessIdentifier: '', customerId: '', representativeName: 'R', representativeRole: '', requestedAuthority: '', requestNarrative: '', documentsSubmitted: '', submittedAt: '', processingPriority: '', syntheticOnly: true };
    expect((await store.createIntakeCase({ record })).caseRunId).toBe('AUTH-101');
    expect((await store.createIntakeCase({ record })).caseRunId).toBe('AUTH-102');
    await store.createIntakeCase({ record: { ...record, caseRunId: 'AUTH-101-V2', caseId: 'AUTH-101', submissionVersion: 2 } });
    await expect(store.createIntakeCase({ record: { ...record, caseRunId: 'AUTH-101-V2' } })).rejects.toThrow('CASE_ALREADY_EXISTS');
    expect((await store.listCases()).map((entry) => entry.caseRunId)).toEqual(['AUTH-101', 'AUTH-102', 'AUTH-101-V2']);
  });
});
