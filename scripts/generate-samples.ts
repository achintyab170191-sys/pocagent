/**
 * Writes the synthetic sample documents of every demo persona to apps/web/public/samples/<persona>/<file>.pdf, so a tester can attach
 * real files in the chat. The text is exactly what the checks read (see packages/domain/src/loa-personas.ts). Each persona that reaches the
 * authority check also gets a document to test INSUFFICIENT evidence with (and the corrected one); customer-supplied files (`existing`) are
 * left alone. The guided scenarios (loa-scenarios.ts: realistic-format documents in flawed -> corrected pairs) are written to
 * samples/scenarios/<scenario>/<file>.pdf. Files no longer described by a persona or scenario are removed.
 * Run: npm run samples   (SAMPLE_TODAY=yyyy-mm-dd dates the generated letters and scenarios from that day; a deployment build passes today's date)
 */
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { documentText, generatedScenarioFiles, guidedScenarios, personas, scenarioToday } from '@sbo/domain';
import { makePdf } from '@sbo/testkit';

const root = join('apps', 'web', 'public', 'samples');
let written = 0; let variantFiles = 0;
for (const persona of personas) {
  const directory = join(root, persona.slug);
  mkdirSync(directory, { recursive: true });
  const expected = new Set<string>();
  for (const document of persona.documents) {
    expected.add(document.fileName);
    if (!document.existing) { writeFileSync(join(directory, document.fileName), makePdf(documentText(document))); written += 1; }
  }
  for (const variant of persona.variants ?? []) {
    expected.add(variant.fileName);
    if (variant.text !== undefined && !variant.existing) { writeFileSync(join(directory, variant.fileName), makePdf(variant.text)); variantFiles += 1; }
    else if (!existsSync(join(directory, variant.fileName))) throw new Error(`Missing customer-supplied sample ${persona.slug}/${variant.fileName}`);
  }
  for (const entry of readdirSync(directory)) if (entry.endsWith('.pdf') && !expected.has(entry)) unlinkSync(join(directory, entry));
}
let scenarioFiles = 0;
for (const scenario of guidedScenarios) {
  const directory = join(root, 'scenarios', scenario.slug);
  mkdirSync(directory, { recursive: true });
  for (const file of generatedScenarioFiles(scenario)) { writeFileSync(join(directory, file.fileName), makePdf(file.text ?? '')); scenarioFiles += 1; }
}
writeFileSync(join(root, 'README.txt'), `Synthetic sample documents for the demo personas (${personas.length} personas, ${written} documents, ${variantFiles} insufficient/corrected test files) and ${guidedScenarios.length} guided scenarios (${scenarioFiles} generated files, dated from ${scenarioToday()}).\nAll content is fictional. Introduce yourself in the chat as the persona, then attach these files when asked. Files marked insufficient are for testing insufficient evidence.\n`);
console.log(`Wrote ${written} persona documents and ${variantFiles} test variants for ${personas.length} personas, and ${scenarioFiles} files for ${guidedScenarios.length} guided scenarios, to ${root}`);