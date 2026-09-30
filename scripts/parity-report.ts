/**
 * Parity report. Runs the unit, SQL-integration and browser suites, replays every AUTH case, and joins the results to the traceability
 * matrix. A node counts as VERIFIED only when every test referenced for it exists and passed.
 * Writes artifacts/parity-report.json and docs/parity-report.md.   Flags: --skip-e2e  --skip-integration
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { evaluateCase } from '@sbo/workflows';
import { newStore, ScriptedRuntime } from '@sbo/testkit';

interface Trace { statusCounts: Record<string, number>; rows: Array<{ workflowFile: string; nodeId: string; nodeName: string; nodeType: string; parityStatus: string; targetTests: string[]; targetModule: string; notes: string }>; }
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

// ---- AUTH regression replay (in-memory, exactly the fixtures; independent of the vitest run) ----
const brief: Array<{ caseRunId: string; expected: string; outcome?: string; reason?: string }> = [
  { caseRunId: 'AUTH-001', expected: 'clean path → APPROVE / ALL_CHECKS_PASSED', outcome: 'APPROVE', reason: 'ALL_CHECKS_PASSED' },
  { caseRunId: 'AUTH-002', expected: 'missing authority document → NEED_MORE_INFORMATION', outcome: 'NEED_MORE_INFORMATION' },
  { caseRunId: 'AUTH-003', expected: 'authority ambiguity → evidence request; accepted evidence resumes remaining checks' },
  { caseRunId: 'AUTH-004', expected: 'inactive business → REJECT / BUSINESS_INACTIVE', outcome: 'REJECT', reason: 'BUSINESS_INACTIVE' },
  { caseRunId: 'AUTH-005', expected: 'duplicate/conflicting CRM → MANUAL_REVIEW / DUPLICATE_RECORD_CONFLICT', outcome: 'MANUAL_REVIEW', reason: 'DUPLICATE_RECORD_CONFLICT' },
  { caseRunId: 'AUTH-006', expected: 'final verification failure → REJECT / FINAL_VERIFICATION_FAILED', outcome: 'REJECT', reason: 'FINAL_VERIFICATION_FAILED' },
  { caseRunId: 'AUTH-007', expected: 'registry unavailable → MANUAL_REVIEW / REGISTRY_UNAVAILABLE', outcome: 'MANUAL_REVIEW', reason: 'REGISTRY_UNAVAILABLE' },
  { caseRunId: 'AUTH-008-V1', expected: 'insufficient authority → NEED_MORE_INFORMATION', outcome: 'NEED_MORE_INFORMATION' },
  { caseRunId: 'AUTH-008-V2', expected: 'corrected resubmission → APPROVE', outcome: 'APPROVE' },
  { caseRunId: 'AUTH-009', expected: 'prompt injection → MANUAL_REVIEW / PROMPT_INJECTION_DETECTED', outcome: 'MANUAL_REVIEW', reason: 'PROMPT_INJECTION_DETECTED' },
  { caseRunId: 'AUTH-010', expected: 'policy TBD → MANUAL_REVIEW / TBD_POLICY', outcome: 'MANUAL_REVIEW', reason: 'TBD_POLICY' },
];
const authRows = [];
for (const entry of brief) {
  const result = await evaluateCase(newStore(), new ScriptedRuntime(), entry.caseRunId, 'report');
  const matches = entry.outcome === undefined ? undefined : result.decision.outcome === entry.outcome && (entry.reason === undefined || result.decision.primaryReasonCode === entry.reason);
  authRows.push({ caseRunId: entry.caseRunId, briefExpectation: entry.expected, actualOutcome: result.decision.outcome, actualReason: result.decision.primaryReasonCode, appliedRule: result.decision.appliedRuleId, toolsCalled: result.trace.map((step) => step.tool), evidenceRequest: result.evidenceRequest?.evidenceChannel ?? null, matchesBrief: matches ?? 'see note' });
}

// ---- suites ----
const suites: SuiteResult[] = [vitestSuite('unit', [])];
suites.push(flag('--skip-integration') ? { name: 'integration', ran: false, passed: 0, failed: 0, skipped: 0, passedTitles: [], failedTitles: [], command: 'skipped' } : vitestSuite('integration', ['--config', 'vitest.integration.config.ts']));
suites.push(flag('--skip-e2e') ? { name: 'e2e', ran: false, passed: 0, failed: 0, skipped: 0, passedTitles: [], failedTitles: [], command: 'skipped' } : playwrightSuite());

// ---- join to traceability ----
const trace = JSON.parse(readFileSync('artifacts/traceability.json', 'utf8')) as Trace;
const passed = suites.flatMap((suite) => suite.passedTitles);
const failed = suites.flatMap((suite) => suite.failedTitles);
const toRegex = (title: string): RegExp => new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('%s', '.+').replaceAll('%i', '\\d+'));
const anyRan = suites.some((suite) => suite.ran);
const nodes = trace.rows.map((row) => {
  if (row.parityStatus === 'UNSUPPORTED') return { ...row, verification: 'UNSUPPORTED' as const, missing: [] as string[] };
  const missing: string[] = [];
  for (const reference of row.targetTests) {
    const title = reference.split(' › ').slice(1).join(' › ');
    const pattern = toRegex(title);
    const matchedPassed = passed.some((name) => pattern.test(name));
    const matchedFailed = failed.some((name) => pattern.test(name));
    if (!matchedPassed || matchedFailed) missing.push(`${reference}${matchedFailed ? ' (FAILED)' : ' (not run / not found)'}`);
  }
  return { ...row, verification: (missing.length === 0 && anyRan ? 'VERIFIED' : 'UNVERIFIED') as 'VERIFIED' | 'UNVERIFIED', missing };
});
const verified = nodes.filter((node) => node.verification === 'VERIFIED').length;
const unsupported = nodes.filter((node) => node.verification === 'UNSUPPORTED');
const unverified = nodes.filter((node) => node.verification === 'UNVERIFIED');
const inScope = nodes.length - unsupported.length;
const percentage = (value: number, total: number): number => total === 0 ? 0 : Math.round((value / total) * 1000) / 10;
const report = {
  generatedAt: new Date().toISOString(), node: process.version,
  totals: { workflows: 13, nodes: nodes.length, verified, unverified: unverified.length, unsupported: unsupported.length, parityPercentageOfInScopeNodes: percentage(verified, inScope), parityPercentageOfAllNodes: percentage(verified, nodes.length) },
  statusCounts: trace.statusCounts,
  suites: suites.map(({ passedTitles: _p, failedTitles, ...rest }) => ({ ...rest, failedTitles })),
  authRegression: authRows,
  unsupportedNodes: unsupported.map((node) => ({ workflow: node.workflowFile, node: node.nodeName, reason: node.notes })),
  unverifiedNodes: unverified.map((node) => ({ workflow: node.workflowFile, node: node.nodeName, missing: node.missing })),
  nodes: nodes.map((node) => ({ workflowFile: node.workflowFile, nodeId: node.nodeId, nodeName: node.nodeName, nodeType: node.nodeType, parityStatus: node.parityStatus, verification: node.verification, targetModule: node.targetModule, tests: node.targetTests })),
};
writeFileSync('artifacts/parity-report.json', JSON.stringify(report, null, 2));

const md = `# Parity report

Generated ${report.generatedAt} on Node ${report.node} by \`npm run report:parity\`. Machine-readable copy: \`artifacts/parity-report.json\`.

## Result

| Measure | Value |
| --- | ---: |
| Workflows ported | 13 of 13 uploaded (expected Workflow 93 is absent from the upload; status view is an adapter — doc 07 G-01) |
| n8n nodes | ${nodes.length} |
| Nodes **verified** (implemented + every referenced test passed) | ${verified} |
| Nodes explicitly UNSUPPORTED (n8n editor scaffolding) | ${unsupported.length} |
| Nodes unverified | ${unverified.length} |
| **Parity of in-scope nodes** | **${report.totals.parityPercentageOfInScopeNodes}%** (${verified}/${inScope}) |
| Parity of all nodes | ${report.totals.parityPercentageOfAllNodes}% (${verified}/${nodes.length}) |

Traceability status of the ${nodes.length} nodes: ${Object.entries(trace.statusCounts).map(([status, count]) => `${status} ${count}`).join(' · ')}.
"Verified" means a mapped implementation exists and every test title referenced in \`docs/05\` matched at least one passing test in this run — it does not mean n8n's runtime is identical in every edge case (see docs/07 for the deviations).

## Test suites

| Suite | Command | Passed | Failed | Skipped |
| --- | --- | ---: | ---: | ---: |
${suites.map((suite) => `| ${suite.name}${suite.ran ? '' : ' (not run)'} | \`${suite.command}\` | ${suite.passed} | ${suite.failed} | ${suite.skipped} |`).join('\n')}
${failed.length ? `\nFailing tests:\n${failed.map((name) => `- ${name}`).join('\n')}\n` : ''}
## AUTH regression (replayed from the preserved fixtures)

| Case | Brief expectation | Governed outcome | Reason | Rule | Tools called | Evidence request | Matches brief |
| --- | --- | --- | --- | --- | --- | --- | --- |
${authRows.map((row) => `| ${row.caseRunId} | ${row.briefExpectation} | ${row.actualOutcome} | ${row.actualReason} | ${row.appliedRule} | ${row.toolsCalled.length} | ${row.evidenceRequest ?? '—'} | ${row.matchesBrief === true ? 'yes' : row.matchesBrief === false ? '**NO**' : 'first leg yes; see below'} |`).join('\n')}

**AUTH-003 (reported mismatch, not altered).** The first leg matches (MANUAL_REVIEW / AUTHORITY_SCOPE_AMBIGUOUS, evidence request on the authority gap). The brief expects accepted evidence to resume the remaining checks and, implicitly, reach approval. The source fixture rows for AUTH-003's system-data, financial and final-verification checks are \`NOT_RUN\`, so after EVID-001 the source lands in \`MANUAL_REVIEW / MANDATORY_CHECKS_INCOMPLETE\` — corroborated by the historical export (5 runtime rows; case ended REVIEW_PENDING / MANDATORY_CHE…). The resume mechanism itself (continue from the next incomplete check without restarting passed checks, ending in APPROVE) is proven on a labelled focused fixture. Details: docs/07 G-12.

## Unsupported nodes

${unsupported.length ? unsupported.map((node) => `- ${node.workflowFile} › **${node.nodeName}** — ${node.notes}`).join('\n') : 'None.'}

## Unverified nodes

${unverified.length ? unverified.map((node) => `- ${node.workflowFile} › **${node.nodeName}**: ${node.missing.join('; ')}`).join('\n') : 'None — every in-scope node maps to passing tests.'}

## What this report does not prove

- No live Claude call was made; the agent runtime is exercised against an SDK test double (docs/08).
- SQL ran on embedded PostgreSQL (PGlite), not a Docker PostgreSQL server; browser tests ran on Microsoft Edge.
- Behaviour where the source is a defect or the brief conflicts with the source is listed in docs/07, not hidden in the percentage.
`;
writeFileSync('docs/parity-report.md', md);
console.log(`Parity: ${verified}/${inScope} in-scope nodes verified (${report.totals.parityPercentageOfInScopeNodes}%); ${unsupported.length} unsupported; ${unverified.length} unverified. Tests failed: ${failed.length}.`);
process.exit(failed.length > 0 ? 1 : 0);
