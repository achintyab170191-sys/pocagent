/**
 * Agent runtime for SBO.02, the profiling super agent, on the Claude Agent SDK (docs/09).
 *
 * Boundaries that must not change:
 *  - The agent only ever produces a PROVISIONAL recommendation. The governed outcome comes from @sbo/governance.
 *  - The agent can only call the five specialist tools through the UtilityToolbox, which enforces the governed order.
 *  - Documents the customer uploaded are data, never instructions. Evidence completeness is decided by deterministic code, not by a model.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ProvisionalWireSchema,
  governedOutcomes,
  type GovernedOutcome,
  type ProvisionalRecommendation,
} from '@sbo/domain';

const promptDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const readPrompt = (name: string): string => readFileSync(join(promptDirectory, name), 'utf8');

export const sbo02SystemPrompt = readPrompt('sbo02-system.md');
export const sbo02UserTemplate = readPrompt('sbo02-user-template.md');
export const sbo02StructuringTemplate = readPrompt('sbo02-structuring.md');
export const sbo02ToolDefinitions = JSON.parse(readPrompt('sbo02-tools.json')) as Array<{ name: string; description: string }>;

// ---------------------------------------------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------------------------------------------

export interface SuperAgentContext {
  chatInput: string;
  caseRunId: string;
  submissionVersion: number;
  sessionId: string;
  assessmentCycle: 'INITIAL' | 'RESUMED';
  nextRequiredCheck: string;
  completedMandatoryChecks: string[];
  pendingMandatoryChecks: string[];
  evidenceResolvedChecks: string[];
  caseContext: Record<string, unknown>;
  existingRuntimeResults: Array<Record<string, unknown>>;
}

export interface ToolObservation { allowed: boolean; message?: string; result?: Record<string, unknown>; }

/** The only capability the agent has. Implemented in @sbo/workflows; enforces order, terminal-stop and preservation of passed checks. */
export interface UtilityToolbox {
  readonly tools: ReadonlyArray<{ name: string; description: string }>;
  call(toolName: string): Promise<ToolObservation>;
}

export interface ToolTraceStep { order: number; tool: string; input: Record<string, unknown>; observation: string; }
export interface SuperAgentRun { agentOutput: string; trace: ToolTraceStep[]; provisional: ProvisionalRecommendation; }

export interface AgentRuntime {
  runSuperAgent(context: SuperAgentContext, toolbox: UtilityToolbox): Promise<SuperAgentRun>;
}

// ---------------------------------------------------------------------------------------------------------------
// Prompt rendering — reproduces the source n8n template expressions exactly (verified against the JSON in tests)
// ---------------------------------------------------------------------------------------------------------------

const json = (value: unknown): string => JSON.stringify(value, null, 2);

export function renderSuperAgentUserPrompt(context: SuperAgentContext): string {
  return `User request:
${context.chatInput}

Assessment cycle:
${context.assessmentCycle}

Next mandatory check:
${context.nextRequiredCheck || 'NONE — ALL MANDATORY CHECKS ARE PRESENT'}

Completed mandatory checks:
${json(context.completedMandatoryChecks)}

Pending mandatory checks:
${json(context.pendingMandatoryChecks)}

Checks resolved through additional evidence:
${json(context.evidenceResolvedChecks)}

Synthetic case context:
${json(context.caseContext)}

Existing runtime results:
${json(context.existingRuntimeResults)}

Instructions:

- Select only the mandatory Utility Agent tools still required.
- If this is a resumed assessment, begin with next_required_check.
- Do not repeat any PASS or PASS_WITH_FLAG check.
- Stop immediately if a newly called tool returns is_terminal=true.
- Return an evidence-based provisional recommendation after the
  appropriate tool sequence completes.`;
}

export function renderStructuringPrompt(input: { caseRunId: string; submissionVersion: number; assessmentCycle: string; agentOutput: string; trace: ToolTraceStep[] }): string {
  return `You are a strict JSON normalisation component.

Convert the Agent output and visible tool trace into the structure
required by the connected parser.

Case Run ID:
${input.caseRunId}

Submission version:
${input.submissionVersion}

Assessment cycle:
${input.assessmentCycle}

Agent output:
${input.agentOutput}

Visible tool trace:
${json(input.trace)}

Do not invent a tool, observation, evidence item, or policy.

Return only the structured parser output.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Provisional recommendation normalisation ("Normalise Provisional Recommendation" node)
// ---------------------------------------------------------------------------------------------------------------

function stripFences(text: string): string { return text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, ''); }

export function normalizeProvisional(raw: unknown, caseRunId: string): ProvisionalRecommendation {
  const parsed = ProvisionalWireSchema.parse(typeof raw === 'string' ? JSON.parse(stripFences(raw)) : raw);
  const candidate = parsed.provisional_outcome.trim().toUpperCase().replace(/\s+/g, '_');
  const outcome: GovernedOutcome = (governedOutcomes as readonly string[]).includes(candidate) ? candidate as GovernedOutcome : 'MANUAL_REVIEW';
  return {
    caseRunId,
    toolsCalled: parsed.tools_called,
    provisionalOutcome: outcome,
    evidenceSummary: parsed.evidence_summary,
    missingInformation: parsed.missing_information,
    conflicts: parsed.conflicts,
    humanReviewRequired: parsed.human_review_required === true || outcome === 'MANUAL_REVIEW',
    nextAction: parsed.next_action,
    decisionRationale: parsed.decision_rationale,
    confidence: Math.max(0, Math.min(1, Number.isFinite(parsed.confidence) ? parsed.confidence : 0)),
  };
}

/** Used when the model's structured output cannot be produced. The governed decision is unaffected. */
export function fallbackProvisional(caseRunId: string, toolsCalled: string[], reason: string): ProvisionalRecommendation {
  return { caseRunId, toolsCalled, provisionalOutcome: 'MANUAL_REVIEW', evidenceSummary: [], missingInformation: [], conflicts: [], humanReviewRequired: true, nextAction: 'Await the deterministic governed decision.', decisionRationale: reason, confidence: 0 };
}

function compact(observation: unknown): string {
  const text = typeof observation === 'string' ? observation : JSON.stringify(observation);
  return text.length > 3000 ? text.slice(0, 3000) : text;
}

// ---------------------------------------------------------------------------------------------------------------
// Deterministic runtime: no model. Follows the governed order; used for tests, offline demo and as a reference.
// ---------------------------------------------------------------------------------------------------------------

export class DeterministicAgentRuntime implements AgentRuntime {
  public async runSuperAgent(context: SuperAgentContext, toolbox: UtilityToolbox): Promise<SuperAgentRun> {
    const trace: ToolTraceStep[] = [];
    let terminal: Record<string, unknown> | undefined;
    for (const definition of toolbox.tools) {
      const observation = await toolbox.call(definition.name);
      if (!observation.allowed) continue; // already-passed checks are skipped, never repeated
      trace.push({ order: trace.length + 1, tool: definition.name, input: { case_run_id: context.caseRunId, submission_version: context.submissionVersion }, observation: compact(observation.result ?? {}) });
      if (observation.result?.is_terminal === true) { terminal = observation.result; break; }
    }
    const toolsCalled = trace.map((step) => step.tool);
    const passedAll = !terminal && toolbox.tools.length > 0;
    const outcome: GovernedOutcome = terminal ? normalizeTerminal(String(terminal.terminal_outcome ?? '')) : passedAll ? 'APPROVE' : 'MANUAL_REVIEW';
    const provisional: ProvisionalRecommendation = {
      caseRunId: context.caseRunId,
      toolsCalled,
      provisionalOutcome: outcome,
      evidenceSummary: trace.map((step) => step.observation.slice(0, 160)),
      missingInformation: [],
      conflicts: [],
      humanReviewRequired: outcome !== 'APPROVE',
      nextAction: terminal ? String(terminal.recommended_next_step ?? '') : 'Proceed to the deterministic Finalizer.',
      decisionRationale: terminal ? `A specialist tool returned a terminal result (${String(terminal.terminal_outcome)}). Downstream checks were not called.` : 'All required mandatory checks were called and none returned a terminal result.',
      confidence: terminal ? Number(terminal.confidence ?? 0) : 0.9,
    };
    return { agentOutput: provisional.decisionRationale, trace, provisional };
  }
}

function normalizeTerminal(value: string): GovernedOutcome {
  const normalized = value.toUpperCase().replace(/\s+/g, '_');
  return (governedOutcomes as readonly string[]).includes(normalized) ? normalized as GovernedOutcome : 'MANUAL_REVIEW';
}

/** Back-compat alias used by earlier tests. */
export const DeterministicTestAgentRuntime = DeterministicAgentRuntime;

// ---------------------------------------------------------------------------------------------------------------
// Claude Agent SDK runtime
// ---------------------------------------------------------------------------------------------------------------

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk');
type QueryMessage = { type: string; result?: string; subtype?: string; message?: { content?: Array<{ type: string; text?: string }> } };

export interface ClaudeRuntimeOptions { model: string; apiKey: string; maxTurns?: number; loadSdk?: () => Promise<Sdk>; }

/**
 * The SDK runs a subprocess. It gets the parent environment minus the application's own secrets (security review SEC-12): the agent has
 * no built-in tools, but there is no reason for the subprocess to inherit the database URL or the cookie-signing secret.
 */
const applicationSecrets = ['DATABASE_URL', 'SESSION_SECRET', 'ANTHROPIC_API_KEY'];
export function scrubbedEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !applicationSecrets.includes(entry[0])));
}

function mcpToolName(name: string): string { return name.replace(/[^A-Za-z0-9]+/g, '_'); }

export class ClaudeAgentRuntime implements AgentRuntime {
  private readonly loadSdk: () => Promise<Sdk>;
  public constructor(private readonly options: ClaudeRuntimeOptions) {
    if (!options.apiKey) throw new Error('ANTHROPIC_API_KEY is required to run Claude.');
    if (!options.model) throw new Error('CLAUDE_MODEL is required to run Claude.');
    this.loadSdk = options.loadSdk ?? (() => import('@anthropic-ai/claude-agent-sdk'));
  }

  private async finalText(sdk: Sdk, prompt: string, system: string | undefined, extra: Record<string, unknown> = {}): Promise<string> {
    let result = '';
    const stream = sdk.query({ prompt, options: { model: this.options.model, systemPrompt: system, maxTurns: this.options.maxTurns ?? 12, settingSources: [], persistSession: false, tools: [], permissionMode: 'dontAsk', env: { ...scrubbedEnvironment(), ANTHROPIC_API_KEY: this.options.apiKey }, ...extra } as never }) as AsyncIterable<QueryMessage>;
    for await (const message of stream) {
      if (message.type === 'result' && typeof message.result === 'string') result = message.result;
    }
    if (!result) throw new Error('Claude Agent SDK returned no final result.');
    return result;
  }

  public async runSuperAgent(context: SuperAgentContext, toolbox: UtilityToolbox): Promise<SuperAgentRun> {
    const sdk = await this.loadSdk();
    const trace: ToolTraceStep[] = [];
    const definitions = toolbox.tools.map((definition) => sdk.tool(mcpToolName(definition.name), definition.description, {}, async () => {
      const observation = await toolbox.call(definition.name);
      trace.push({ order: trace.length + 1, tool: definition.name, input: { case_run_id: context.caseRunId, submission_version: context.submissionVersion }, observation: compact(observation) });
      return { content: [{ type: 'text' as const, text: JSON.stringify(observation) }] };
    }));
    const server = sdk.createSdkMcpServer({ name: 'sbo02', version: '1.0.0', tools: definitions });
    const agentOutput = await this.finalText(sdk, renderSuperAgentUserPrompt(context), sbo02SystemPrompt, { mcpServers: { sbo02: server }, allowedTools: toolbox.tools.map((definition) => `mcp__sbo02__${mcpToolName(definition.name)}`) });
    const toolsCalled = trace.map((step) => step.tool);
    try {
      const structured = await this.finalText(sdk, `${renderStructuringPrompt({ caseRunId: context.caseRunId, submissionVersion: context.submissionVersion, assessmentCycle: context.assessmentCycle, agentOutput, trace })}\n\nReturn a single JSON object with exactly these keys: case_run_id, tools_called, provisional_outcome (APPROVE|REJECT|NEED_MORE_INFORMATION|MANUAL_REVIEW), evidence_summary, missing_information, conflicts, human_review_required, next_action, decision_rationale, confidence (0-1). JSON only.`, undefined);
      const provisional = normalizeProvisional(structured, context.caseRunId);
      // The visible trace recorded by the harness is authoritative for which tools were called.
      return { agentOutput, trace, provisional: { ...provisional, toolsCalled } };
    } catch {
      return { agentOutput, trace, provisional: fallbackProvisional(context.caseRunId, toolsCalled, 'The agent output could not be structured; the deterministic Finalizer result is authoritative.') };
    }
  }


}
