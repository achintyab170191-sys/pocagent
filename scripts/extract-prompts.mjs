import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Extracts the exact prompt and parser-schema fields from the preserved n8n exports (read-only on source files).
const root = process.cwd();
const output = join(root, 'packages', 'agent-runtime', 'prompts');
mkdirSync(output, { recursive: true });

function node(workflow, name) {
  const parsed = JSON.parse(readFileSync(join(root, workflow), 'utf8'));
  const selected = parsed.nodes.find((entry) => entry.name === name);
  if (!selected) throw new Error(`Missing source node ${name} in ${workflow}`);
  return selected;
}

const orchestrator = '03 - SBO.02 - Agentic Reasoning Orchestrator.json';
const evidenceWorkflow = '95 - Evidence Resolution Utility.json';
const agent = node(orchestrator, 'SBO.02 Agentic Reasoning Super Agent');
const structuring = node(orchestrator, 'Structure Agent Recommendation');
const recommendationParser = node(orchestrator, 'Structured Output Parser');
const evidence = node(evidenceWorkflow, 'Resolve Additional Evidence');
const evidenceParser = node(evidenceWorkflow, 'Structured Evidence Resolution Parser');

writeFileSync(join(output, 'sbo02-system.md'), String(agent.parameters.options.systemMessage));
writeFileSync(join(output, 'sbo02-user-template.md'), String(agent.parameters.text));
writeFileSync(join(output, 'sbo02-structuring.md'), String(structuring.parameters.text));
writeFileSync(join(output, 'evidence-resolution.md'), String(evidence.parameters.text));
writeFileSync(join(output, 'sbo02-recommendation.schema.json'), JSON.stringify(JSON.parse(recommendationParser.parameters.inputSchema), null, 2));
writeFileSync(join(output, 'evidence-resolution.schema.json'), JSON.stringify(JSON.parse(evidenceParser.parameters.inputSchema), null, 2));
const toolNodes = ['Document Checks', 'Business Validation', 'Identity Validation', 'Authority Validation', 'System Data Check', 'Financial Check', 'Final Verification'];
const tools = toolNodes.map((name) => ({ name, description: String(node(orchestrator, `Tool - ${name}`).parameters.description) }));
writeFileSync(join(output, 'sbo02-tools.json'), JSON.stringify(tools, null, 2));
console.log('Extracted exact source prompts and parser schemas into packages/agent-runtime/prompts.');
