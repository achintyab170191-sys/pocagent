/**
 * Writes the synthetic sample documents of every demo persona to apps/web/public/samples/<persona>/<file>.pdf, so a tester can attach
 * real files in the chat. The text is exactly what the checks read (see packages/domain/src/loa-personas.ts). The guided scenarios
 * (loa-scenarios.ts: realistic-format documents in flawed -> corrected pairs) are written to samples/scenarios/<scenario>/<file>.pdf.
 * Run: npm run samples   (SAMPLE_TODAY=yyyy-mm-dd dates the scenario documents from that day; a deployment build passes today's date)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { documentText, generatedScenarioFiles, guidedScenarios, personas, scenarioToday } from '@sbo/domain';
import { makePdf } from '@sbo/testkit';

const root = join('apps', 'web', 'public', 'samples');
let written = 0;
for (const persona of personas) {
  const directory = join(root, persona.slug);
  mkdirSync(directory, { recursive: true });
  for (const document of persona.documents) { writeFileSync(join(directory, document.fileName), makePdf(documentText(document))); written += 1; }
}
let scenarioFiles = 0;
for (const scenario of guidedScenarios) {
  const directory = join(root, 'scenarios', scenario.slug);
  mkdirSync(directory, { recursive: true });
  for (const file of generatedScenarioFiles(scenario)) { writeFileSync(join(directory, file.fileName), makePdf(file.text ?? '')); scenarioFiles += 1; }
}
writeFileSync(join(root, 'README.txt'), `Synthetic sample documents for the demo personas (${personas.length} personas, ${written} files) and ${guidedScenarios.length} guided scenarios (${scenarioFiles} generated files, dated from ${scenarioToday()}).\nAll content is fictional. Introduce yourself in the chat as the persona, then attach these files when asked.\n`);
console.log(`Wrote ${written} sample documents for ${personas.length} personas and ${scenarioFiles} files for ${guidedScenarios.length} guided scenarios to ${root}`);