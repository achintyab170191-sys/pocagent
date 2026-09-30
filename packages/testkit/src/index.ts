import { DeterministicAgentRuntime, type AgentRuntime, type EvidenceResolutionRequest, type SuperAgentContext, type SuperAgentRun, type UtilityToolbox } from '@sbo/agent-runtime';
import { type EvidenceResolution } from '@sbo/domain';
import { InMemoryRepository, loadSourceData, type SourceData } from '@sbo/persistence';

let cachedSource: SourceData | undefined;
/** Loads the preserved source CSVs once; each test gets its own clean in-memory runtime (no stale runtime history is seeded). */
export function newStore(): InMemoryRepository {
  cachedSource ??= loadSourceData(process.cwd());
  return new InMemoryRepository(cachedSource);
}

/** A store over a modified deep copy of the source fixtures (the preserved CSVs are never touched). */
export function newStoreWith(mutate: (source: SourceData) => void): InMemoryRepository {
  cachedSource ??= loadSourceData(process.cwd());
  const source = structuredClone(cachedSource);
  mutate(source);
  return new InMemoryRepository(source);
}

/**
 * FOCUSED FIXTURE (not source data): dt_mock_utility_results has NOT_RUN rows for AUTH-003 after AUTHORITY_VALIDATION, so the real source
 * lands in MANDATORY_CHECKS_INCOMPLETE after EVID-001. This fixture copies AUTH-001's passing downstream rows to prove the continuation
 * mechanism (resume from the next incomplete check without restarting passed checks) would reach APPROVE if the fixture were complete.
 */
export function completeAuth003Downstream(source: SourceData): void {
  for (const checkType of ['SYSTEM_DATA_CHECK', 'FINANCIAL_CHECK', 'FINAL_VERIFICATION']) {
    const passing = source.mockResults.get(`AUTH-001|${checkType}`);
    if (!passing) throw new Error(`fixture AUTH-001|${checkType} missing`);
    source.mockResults.set(`AUTH-003|${checkType}`, { ...passing, caseRunId: 'AUTH-003' });
  }
}

/** Builds a minimal valid text-based PDF (one page, Helvetica) so PDF extraction can be exercised without binary fixtures. */
export function makePdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

export const resolved: EvidenceResolution = { resolutionStatus: 'RESOLVED', supportedFacts: ['The signed authority letter expressly grants the requested authority.'], remainingGaps: [], reasonCodes: [], confidence: 0.95, recommendedNextAction: 'Resume processing from the next incomplete mandatory check.' };
export const insufficient: EvidenceResolution = { resolutionStatus: 'INSUFFICIENT', supportedFacts: [], remainingGaps: ['Signed authority wording is still missing.'], reasonCodes: [], confidence: 0.4, recommendedNextAction: 'Request the specific remaining evidence.' };
export const contradictory: EvidenceResolution = { resolutionStatus: 'CONTRADICTORY', supportedFacts: [], remainingGaps: [], reasonCodes: [], confidence: 0.8, recommendedNextAction: 'Route to human evidence review.' };

/**
 * Test agent: runs the governed sequence deterministically and plays back scripted evidence resolutions.
 * It records every tool call (including refused ones) so tests can assert exact call sequences.
 */
export class ScriptedRuntime implements AgentRuntime {
  public readonly resolutionRequests: EvidenceResolutionRequest[] = [];
  public readonly refusedCalls: string[] = [];
  private readonly inner = new DeterministicAgentRuntime();
  public constructor(private readonly resolutions: Array<EvidenceResolution | Error> = [], private readonly superAgent?: (context: SuperAgentContext, toolbox: UtilityToolbox) => Promise<SuperAgentRun>) {}
  public async runSuperAgent(context: SuperAgentContext, toolbox: UtilityToolbox): Promise<SuperAgentRun> {
    if (this.superAgent) return this.superAgent(context, toolbox);
    return this.inner.runSuperAgent(context, toolbox);
  }
  public async resolveEvidence(request: EvidenceResolutionRequest): Promise<EvidenceResolution> {
    this.resolutionRequests.push(request);
    const next = this.resolutions.shift();
    if (!next) throw new Error('ScriptedRuntime: no scripted evidence resolution left');
    if (next instanceof Error) throw next;
    return next;
  }
}
