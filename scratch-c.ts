import { handleChatEvidenceUpload, handleChatMessage } from '@sbo/workflows';
import { newStore, personaAttachments, ScriptedRuntime } from '@sbo/testkit';
import { personas, documentText } from '@sbo/domain';

for (const slug of ['n8n-sophie-williams-aoraki-lantern', 'hessa-al-noor']) {
  const persona = personas.find((entry) => entry.slug === slug)!;
  const poa = persona.documents.find((document) => document.type === 'POA_MOA')!;
  console.log('==', slug, '\n', documentText(poa));
  const deps = { repository: newStore(), agentRuntime: new ScriptedRuntime(), appBaseUrl: 'x' };
  await handleChatMessage(deps, { sessionId: 'r', message: `My name is ${persona.representativeName} and I represent ${persona.businessName}` });
  let reply = await handleChatEvidenceUpload(deps, { sessionId: 'r', files: personaAttachments(slug, ['EMIRATES_ID', 'TRADE_LICENSE', 'ESTABLISHMENT_CARD']) });
  reply = await handleChatEvidenceUpload(deps, { sessionId: 'r', files: personaAttachments(slug, ['POA_MOA']) });
  console.log(reply.step, JSON.stringify(reply.outcome), '\n', reply.messages.join('\n---\n'));
}
