/**
 * Conformance report. Runs the unit, SQL-integration and browser suites, replays every demo persona through the chat, and joins the results to
 * the To-Be process map (scripts/process-map.ts). A step counts as VERIFIED only when every test referenced for it exists and passed.
 * Writes artifacts/conformance-report.json and docs/conformance-report.md.   Flags: --skip-e2e  --skip-integration
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { handleChatEvidenceUpload, handleChatMessage } from '@sbo/workflows';
import { personas } from '@sbo/domain';
import { newStore, personaAttachments, ScriptedRuntime } from '@sbo/testkit';
import { steps } from './process-map.js';

interface SuiteResult { name: string; ran: boolean; passed: number; failed: number; skipped: number; passedTitles: string[]; failedTitles: string[]; command: string; }

const flag = (name: string): boolean => process.argv.includes(name);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
mkdirSync('artifacts', { recursive: true });

function run(command: string[], env: Record<string, string> = {}): number {
  const result = spawnSync(npx, command, { shell: true, stdio: 'inherit', env: { ...process.env, ...env } });
  return result.status ?? 1;
}

function vitestSuite(name: string, extra: string[]): SuiteResult {
  const file = `artifacts/.${name}.json`;
  rmSync(file, { force: true });
  run(['vitest', 'run', ...extra, '--reporter=json', `--outputFile=${file}`]);
  const suite: SuiteResult = { name, ran: true, passed: 0, failed: 0, skipped: 0, passedTitles: [], failedTitles: [], command: `npx vitest run ${extra.join(' ')}`.trim() };
  if (!existsSync(file)) return suite;
  const json = JSON.parse(readFileSync(file, 'utf8')) as { testResults: Array<{ assertionResults: Array<{ fullName: string; status: string }> }> };
  for (const file2 of json.testResults) for (const test of file2.assertionResults) {
    if (test.status === 'passed') { suite.passed += 1; suite.passedTitles.push(test.fullName); }
    else if (test.status === 'failed') { suite.failed += 1; suite.failedTitles.push(test.fullName); } else suite.skipped += 1;
  }
  rmSync(file, { force: true });
  return suite;
}

function playwrightSuite(): SuiteResult {
  const file = 'artifacts/.playwright.json';
  rmSync(file, { force: true });
  run(['playwright', 'test', '--reporter=json'], { PLAYWRIGHT_JSON_OUTPUT_NAME: file });
  const suite: SuiteResult = { name: 'e2e', ran: true, passed: 0, failed: 0, skipped: 0, passedTitles: [], failedTitles: [], command: 'npx playwright test' };
  if (!existsSync(file)) return suite;
  interface PwSuite { title: string; suites?: PwSuite[]; specs?: Array<{ title: string; ok: boolean; tests: Array<{ results: Array<{ status: string }> }> }> }
  const walk = (node: PwSuite, prefix: string[]): void => {
    const path = node.title && !node.title.endsWith('.spec.ts') ? [...prefix, node.title] : prefix;
    for (const spec of node.specs ?? []) {
      const title = [...path, spec.title].join(' › ');
      const status = spec.tests[0]?.results.at(-1)?.status;
      if (spec.ok && status === 'passed') { suite.passed += 1; suite.passedTitles.push(title); } else if (status === 'skipped') suite.skipped += 1; else { suite.failed += 1; suite.failedTitles.push(title); }
    }
    for (const child of node.suites ?? []) walk(child, path);
  };
  const json = JSON.parse(readFileSync(file, 'utf8')) as { suites: PwSuite[] };
  for (const top of json.suites) walk(top, []);
  rmSync(file, { force: true });
  return suite;
}

// ---- persona replay (in-memory, real checks and registers; independent of the vitest run) ----
const personaRows: Array<{ slug: string; customer: string; expected: string; actual: string; reason: string; tools: number; matches: boolean }> = [];
for (const persona of personas) {
  const store = newStore();
  const deps = { repository: store, agentRuntime: new ScriptedRuntime(), appBaseUrl: 'report' };
  await handleChatMessage(deps, { sessionId: 'r', message: `My name is ${persona.representativeName} and I represent ${persona.businessName}` });
  const intake = ['EMIRATES_ID', 'TRADE_LICENSE', 'ESTABLISHMENT_CARD'];
  let reply = await handleChatEvidenceUpload(deps, { sessionId: 'r', files: personaAttachments(persona.slug, intake) });
  const extras = persona.documents.map((document) => document.type).filter((type) => !intake.includes(type));
  if (reply.step === 'AWAITING_EVIDENCE' && extras.length > 0) reply = await handleChatEvidenceUpload(deps, { sessionId: 'r', files: personaAttachments(persona.slug, extras) });
  // A document that was read and found insufficient keeps the request open (needs more information) rather than reaching a decision.
  const actual = reply.outcome?.governedOutcome ?? (reply.step === 'AWAITING_EVIDENCE' ? 'NEED_MORE_INFORMATION' : reply.step);
  const expected = persona.expectedOutcome === 'NEED_MORE_INFORMATION_THEN_APPROVE' ? 'APPROVE' : persona.expectedOutcome;
  personaRows.push({ slug: persona.slug, customer: `${persona.representativeName} / ${persona.businessName}`, expected: persona.expectedOutcome, actual, reason: reply.outcome?.primaryReasonCode ?? (reply.evidenceRequest ? 'DOCUMENT_INSUFFICIENT' : ''), tools: reply.outcome?.toolsCalled.length ?? 0, matches: actual === expected });
}

// ---- suites ----
const suites: SuiteResult[] = [vitestSuite('unit', [])];
suites.push(flag('--skip-integration') ? { name: 'integration', ran: false, passed: 0, failed: 0, skipped: 0, passedTitles: [], failedTitles: [], command: 'skipped' } : vitestSuite('integration', ['--config', 'vitest.integration.config.ts']));
suites.push(flag('--skip-e2e') ? { name: 'e2e', ran: false, passed: 0, failed: 0, skipped: 0, passedTitles: [], failedTitles: [], command: 'skipped' } : playwrightSuite());

// ---- join to the process map ----
const passed = suites.flatMap((suite) => suite.passedTitles);
const failed = suites.flatMap((suite) => suite.failedTitles);
const toRegex = (title: string): RegExp => new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('%s', '.+').replaceAll('%i', '\\d+'));
const anyRan = suites.some((suite) => suite.ran);
const rows = steps.map((step) => {
  if (step.status === 'OUT_OF_SCOPE') return { ...step, verification: 'OUT_OF_SCOPE' as const, missing: [] as string[] };
  const missing: string[] = [];
  for (const [file, title] of step.tests) {
    const pattern = toRegex(title);
    const matchedPassed = passed.some((name) => pattern.test(name));
    const matchedFailed = failed.some((name) => pattern.test(name));
    if (!matchedPassed || matchedFailed) missing.push(`${file} › ${title}${matchedFailed ? ' (FAILED)' : ' (not run / not found)'}`);
  }
  return { ...step, verification: (missing.length === 0 && anyRan ? 'VERIFIED' : 'UNVERIFIED') as 'VERIFIED' | 'UNVERIFIED', missing };
});
const verified = rows.filter((row) => row.verification === 'VERIFIED').length;
const outOfScope = rows.filter((row) => row.verification === 'OUT_OF_SCOPE');
const unverified = rows.filter((row) => row.verification === 'UNVERIFIED');
const inScope = rows.length - outOfScope.length;
const percentage = inScope === 0 ? 0 : Math.round((verified / inScope) * 1000) / 10;
const report = {
  generatedAt: new Date().toISOString(), node: process.version,
  totals: { steps: rows.length, verified, unverified: unverified.length, outOfScope: outOfScope.length, conformancePercentageOfInScopeSteps: percentage },
  suites: suites.map(({ passedTitles: _p, failedTitles, ...rest }) => ({ ...rest, failedTitles })),
  personas: personaRows,
  unverifiedSteps: unverified.map((row) => ({ id: row.id, step: row.step, missing: row.missing })),
  steps: rows.map((row) => ({ id: row.id, lane: row.lane, step: row.step, status: row.status, verification: row.verification, module: row.module, tests: row.tests.map(([file, title]) => `${file} › ${title}`) })),
};
writeFileSync('artifacts/conformance-report.json', JSON.stringify(report, null, 2));

const md = `# Conformance report

Generated ${report.generatedAt} on Node ${report.node} by \`npm run report:conformance\`. Machine-readable copy: \`artifacts/conformance-report.json\`.
The behaviour under test is the **To-Be New LOA process** (docs/09), not the earlier n8n export.

## Result

| Measure | Value |
| --- | ---: |
| Process steps mapped (docs/05) | ${rows.length} |
| Steps **verified** (implemented + every referenced test passed) | ${verified} |
| Steps out of scope (in the diagrams, not built) | ${outOfScope.length} |
| Steps unverified | ${unverified.length} |
| **Conformance of in-scope steps** | **${percentage}%** (${verified}/${inScope}) |

"Verified" means a mapped implementation exists and every test title referenced in \`docs/05\` matched at least one passing test in this run. Steps marked SIMULATED run against a synthetic stand-in for an external system; they prove the process logic, not a real integration.

## Test suites

| Suite | Command | Passed | Failed | Skipped |
| --- | --- | ---: | ---: | ---: |
${suites.map((suite) => `| ${suite.name}${suite.ran ? '' : ' (not run)'} | \`${suite.command}\` | ${suite.passed} | ${suite.failed} | ${suite.skipped} |`).join('\n')}
${failed.length ? `\nFailing tests:\n${failed.map((name) => `- ${name}`).join('\n')}\n` : ''}
## Demo personas (replayed through the chat with their sample documents)

| Customer | Story expectation | Governed outcome | Reason | Tools called | Matches |
| --- | --- | --- | --- | ---: | --- |
${personaRows.map((row) => `| ${row.customer} | ${row.expected} | ${row.actual} | ${row.reason || '—'} | ${row.tools} | ${row.matches ? 'yes' : '**NO**'} |`).join('\n')}

## Out of scope

${outOfScope.map((row) => `- **${row.id}** ${row.step} — ${row.note ?? ''}`).join('\n') || 'None.'}

## Unverified steps

${unverified.length ? unverified.map((row) => `- **${row.id}** ${row.step}: ${row.missing.join('; ')}`).join('\n') : 'None — every in-scope step maps to passing tests.'}

## What this report does not prove

- No live Claude call was made; the agent runtime is exercised against an SDK test double.
- The DUL API, government portal / UAE Pass, BCRM and AVCV are synthetic registers, not integrations.
- SQL ran on embedded PostgreSQL (PGlite), not a Docker PostgreSQL server; browser tests ran on Microsoft Edge.
- The diagrams were read from photographs of a screen; docs/09 lists the interpretation and the open questions.
`;
writeFileSync('docs/conformance-report.md', md);
console.log(`Conformance: ${verified}/${inScope} in-scope steps verified (${percentage}%); ${outOfScope.length} out of scope; ${unverified.length} unverified. Tests failed: ${failed.length}. Personas matching: ${personaRows.filter((row) => row.matches).length}/${personaRows.length}.`);
process.exit(failed.length > 0 || personaRows.some((row) => !row.matches) ? 1 : 0);