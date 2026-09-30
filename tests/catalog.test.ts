import { describe, expect, it } from 'vitest';
import { featuredQueries, matchRequestType, requestCategories, requestTypeById, requestTypes, stages } from '@sbo/domain';
import { getOperationsOverview, handleChatMessage } from '@sbo/workflows';
import { newStore, ScriptedRuntime } from '@sbo/testkit';

const deps = (store: ReturnType<typeof newStore>) => ({ repository: store, agentRuntime: new ScriptedRuntime(), appBaseUrl: 'x' });

describe('operating model and request catalog', () => {
  it('has the six stages in order, with only profiling live', () => {
    expect(stages.map((stage) => stage.id)).toEqual(['PROFILING', 'VERIFIER', 'PROCESSING', 'CONTROL_TOWER', 'GOVERNANCE', 'REPORTING']);
    expect(stages.filter((stage) => stage.build === 'LIVE').map((stage) => stage.id)).toEqual(['PROFILING']);
  });
  it('offers the eight customer-facing categories, every listed request exists, and only New LOA is automated', () => {
    expect(requestCategories.map((category) => category.title)).toEqual(['Authorised representative & company profile', 'Correct or verify customer data', 'Mobile and SIM requests', 'New service requests', 'Change an existing service', 'Move, transfer or port a service', 'Renew or cease a service', 'Verification, compliance or legal support']);
    for (const category of requestCategories) for (const id of category.requests) expect(requestTypeById(id), id).toBeDefined();
    expect(requestTypes.filter((entry) => entry.automated).map((entry) => entry.id)).toEqual(['NEW_LOA']);
    expect(new Set(requestTypes.map((entry) => entry.id)).size).toBe(requestTypes.length);
    expect(featuredQueries).toHaveLength(8);
  });
  it('assigns request types to the stage that owns them', () => {
    expect(requestTypeById('MNP')?.stage).toBe('VERIFIER');
    expect(requestTypeById('AVCV')?.stage).toBe('VERIFIER');
    expect(requestTypeById('TRANSFER_OF_OWNERSHIP')?.stage).toBe('VERIFIER');
    expect(requestTypeById('NEW_LOA')?.stage).toBe('PROFILING');
    expect(requestTypeById('CHANGE_PLAN')?.stage).toBe('PROCESSING');
  });
  it.each([
    ['I want to port our mobile numbers to you', 'MNP'], ['We lost a SIM card', 'SIM_REPLACEMENT'], ['Please renew our service', 'RENEW_SERVICE'], ['I want to add an authorised representative', 'NEW_LOA'],
    ['Can you cancel a service for us', 'CEASE_SERVICE'], ['I need an eSIM', 'ESIM'], ['transfer ownership of this line', 'TRANSFER_OF_OWNERSHIP'],
  ])('recognises "%s" as %s', (text, id) => { expect(matchRequestType(text)?.id).toBe(id); });
  it('does not mistake an introduction or small talk for a request', () => {
    expect(matchRequestType('hello')).toBeUndefined();
    for (const entry of requestTypes) expect(matchRequestType(entry.query)?.id, entry.id).toBe(entry.id);
  });
});

describe('starting a request in the chat', () => {
  it('a chosen request that is not automated is captured and routed after the customer introduces themselves — nothing is checked or approved', async () => {
    const store = newStore();
    const first = await handleChatMessage(deps(store), { sessionId: 's', message: 'I want to port our mobile numbers to you from another operator.', intent: 'MNP' });
    expect(first).toMatchObject({ step: 'INTAKE', requestType: { id: 'MNP', stageName: 'Verifier task', automated: false } });
    expect(first.messages[0]).toContain('not automated in this prototype yet');
    expect((await handleChatMessage(deps(store), { sessionId: 's', message: 'Fatima Al Mansoori' })).step).toBe('INTAKE');
    const done = await handleChatMessage(deps(store), { sessionId: 's', message: 'Al Noor Trading LLC' });
    expect(done.step).toBe('DONE');
    expect(done.messages[0]).toContain('captured **Mobile number portability (porting)**');
    expect(done.messages[0]).toContain('no checks have been run and nothing has been approved or changed');
    expect(done.outcome).toBeUndefined();
    const runtime = await store.getRuntimeCase(done.caseRunId);
    expect(runtime).toMatchObject({ status: 'REQUEST_CAPTURED', targetQueue: 'VERIFIER_OPERATIONS', requestType: 'MNP' });
    expect(await store.getRuntimeResults(done.caseRunId, 1)).toEqual([]);
    expect(await store.getDecision(done.caseRunId)).toBeUndefined();
    expect((await store.getAudit(done.caseRunId)).find((event) => event.eventType === 'REQUEST_CAPTURED')).toMatchObject({ actor: 'SBO.01', details: { requestTypeId: 'MNP', stage: 'VERIFIER', automated: false } });
  });

  it('a request typed in words is recognised, and a single message can carry request and introduction', async () => {
    const store = newStore();
    const one = await handleChatMessage(deps(store), { sessionId: 'a', message: 'We lost a SIM card' });
    expect(one).toMatchObject({ step: 'INTAKE', requestType: { id: 'SIM_REPLACEMENT' } });
    const two = await handleChatMessage(deps(store), { sessionId: 'b', message: 'My name is Fatima Al Mansoori and I represent Al Noor Trading LLC and I need to renew a service', intent: 'RENEW_SERVICE' });
    expect(two).toMatchObject({ step: 'DONE', requestType: { id: 'RENEW_SERVICE', stage: 'PROCESSING' } });
  });

  it('choosing New LOA (automated) goes straight into the document flow', async () => {
    const store = newStore();
    const first = await handleChatMessage(deps(store), { sessionId: 's', message: 'I want to add an authorised representative for my company.', intent: 'NEW_LOA' });
    expect(first).toMatchObject({ step: 'INTAKE', requestType: { id: 'NEW_LOA', automated: true } });
    expect(first.messages[0]).not.toContain('not automated');
    const opened = await handleChatMessage(deps(store), { sessionId: 's', message: 'My name is Fatima Al Mansoori and I represent Al Noor Trading LLC' });
    expect(opened.step).toBe('AWAITING_EVIDENCE');
  });

  it('a company that is not on record is a new lead whatever was requested', async () => {
    const store = newStore();
    await handleChatMessage(deps(store), { sessionId: 's', message: 'I want to port our numbers', intent: 'MNP' });
    const reply = await handleChatMessage(deps(store), { sessionId: 's', message: 'My name is Zed Nobody and I represent Acme Imaginary Holdings Ltd' });
    expect(reply.messages[0]).toContain('new lead case');
    expect(await store.getRuntimeCase(reply.caseRunId)).toBeUndefined();
  });

  it('the operations overview counts captured requests per stage, leads and LOA cases', async () => {
    const store = newStore();
    await handleChatMessage(deps(store), { sessionId: 'a', message: 'My name is Fatima Al Mansoori and I represent Al Noor Trading LLC', intent: 'MNP' });
    await handleChatMessage(deps(store), { sessionId: 'b', message: 'My name is Omar Haddad and I represent Gulf Horizon Contracting LLC', intent: 'CHANGE_PLAN' });
    await handleChatMessage(deps(store), { sessionId: 'c', message: 'My name is Zed Nobody and I represent Acme Imaginary Holdings Ltd' });
    await handleChatMessage(deps(store), { sessionId: 'd', message: 'My name is Noura Al Falasi and I represent Marina Bay Catering LLC' });
    const overview = await getOperationsOverview(store);
    expect(overview).toMatchObject({ newLeads: 1, loaCases: 1, automatedRequestTypes: ['NEW_LOA'] });
    expect(overview.captured.map((row) => [row.requestTypeId, row.stage, row.queue])).toEqual([['CHANGE_PLAN', 'PROCESSING', 'PROCESSING_ORDERS'], ['MNP', 'VERIFIER', 'VERIFIER_OPERATIONS']]);
    expect(overview.stages.find((stage) => stage.id === 'VERIFIER')?.captured).toBe(1);
    expect(overview.stages.find((stage) => stage.id === 'PROFILING')?.assessed).toBe(1);
  });
});