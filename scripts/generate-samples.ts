/**
 * Writes the synthetic sample documents of every demo persona to apps/web/public/samples/<persona>/<file>.pdf, so a tester can attach
 * real files in the chat. The text is exactly what the checks read (see packages/domain/src/loa-personas.ts). Run: npm run samples
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { documentText, personas } from '@sbo/domain';
import { makePdf } from '@sbo/testkit';

const root = join('apps', 'web', 'public', 'samples');
let written = 0;
for (const persona of personas) {
  const directory = join(root, persona.slug);
  mkdirSync(directory, { recursive: true });
  for (const document of persona.documents) { writeFileSync(join(directory, document.fileName), makePdf(documentText(document))); written += 1; }
}
writeFileSync(join(root, 'README.txt'), `Synthetic sample documents for the demo personas (${personas.length} personas, ${written} files).\nAll content is fictional. Introduce yourself in the chat as the persona, then attach these files when asked.\n`);
console.log(`Wrote ${written} sample documents for ${personas.length} personas to ${root}`);
