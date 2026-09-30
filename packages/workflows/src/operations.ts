/** Operations overview: the operating-model stages, what runs on each, the New LOA pipeline, new leads awaiting onboarding, requests captured and routed, and recent activity. */
import { requestTypeById, requestTypes, stageById, stages, type StageId } from '@sbo/domain';
import { type Repository } from '@sbo/persistence';
import { capturedStatus } from './capture.js';
import { reviewOpenStatuses } from './human-review.js';
import { reopenedStatus } from './super-agent.js';

export interface CapturedRow { caseRunId: string; requestTypeId: string; requestLabel: string; stage: StageId; stageName: string; queue: string; businessName: string; representativeName: string; capturedAt: string; }
export interface LeadRow { caseRunId: string; businessName: string; representativeName: string; onboardingStatus: 'PENDING'; queue: string; createdAt: string; }
export interface StageOverview { id: StageId; name: string; order: number; summary: string; covers: string[]; build: 'LIVE' | 'ROUTED' | 'NOT_BUILT'; queue: string; requestTypes: Array<{ id: string; label: string; automated: boolean }>; captured: number; assessed: number; }
export type PipelineKey = 'DOCUMENTS' | 'SPECIALIST' | 'PENDING_REJECTION' | 'APPROVED' | 'REJECTED' | 'REOPENED';
export interface PipelineStep { key: PipelineKey; label: string; count: number; }
export interface ActivityRow { timestamp: string; caseRunId: string; actor: string; eventType: string; newState: string; reasonCode: string; }
export interface OperationsOverview {
  stages: StageOverview[]; captured: CapturedRow[]; leads: LeadRow[]; pipeline: PipelineStep[]; activity: ActivityRow[];
  newLeads: number; loaCases: number; openReviews: number; automatedRequestTypes: string[]; syntheticDataDisclaimer: true;
}

const pipelineLabels: Record<PipelineKey, string> = { DOCUMENTS: 'Awaiting documents', SPECIALIST: 'With a specialist', PENDING_REJECTION: 'Rejection awaiting confirmation', APPROVED: 'Approved', REJECTED: 'Rejected & closed', REOPENED: 'Reopened as new version' };

export async function getOperationsOverview(repository: Repository): Promise<OperationsOverview> {
  const cases = await repository.listCases();
  const captured: CapturedRow[] = [];
  const leads: LeadRow[] = [];
  const counts: Record<PipelineKey, number> = { DOCUMENTS: 0, SPECIALIST: 0, PENDING_REJECTION: 0, APPROVED: 0, REJECTED: 0, REOPENED: 0 };
  const activity: ActivityRow[] = [];
  let loaCases = 0;
  for (const caseRecord of cases) {
    const [runtime, decision, audit] = await Promise.all([repository.getRuntimeCase(caseRecord.caseRunId), repository.getDecision(caseRecord.caseRunId), repository.getAudit(caseRecord.caseRunId)]);
    for (const event of audit) activity.push({ timestamp: event.timestamp, caseRunId: caseRecord.caseRunId, actor: event.actor, eventType: event.eventType, newState: event.newState, reasonCode: event.reasonCode });
    if (caseRecord.requestType === 'NEW_LEAD') { leads.push({ caseRunId: caseRecord.caseRunId, businessName: caseRecord.businessName, representativeName: caseRecord.representativeName, onboardingStatus: 'PENDING', queue: runtime?.targetQueue ?? '', createdAt: runtime?.createdAt ?? '' }); continue; }
    if (runtime?.status === capturedStatus) {
      const requestType = requestTypeById(caseRecord.requestType);
      const stage = stageById(requestType?.stage ?? '');
      captured.push({ caseRunId: caseRecord.caseRunId, requestTypeId: caseRecord.requestType, requestLabel: requestType?.label ?? caseRecord.requestType, stage: (stage?.id ?? 'PROFILING') as StageId, stageName: stage?.name ?? '', queue: runtime.targetQueue, businessName: caseRecord.businessName, representativeName: caseRecord.representativeName, capturedAt: runtime.createdAt });
      continue;
    }
    loaCases += 1;
    if (runtime?.status === reopenedStatus) counts.REOPENED += 1;
    else if (!decision) counts.DOCUMENTS += 1;
    else if (decision.outcome === 'APPROVE') counts.APPROVED += 1;
    else if (decision.outcome === 'REJECT') counts[decision.humanReviewRequired ? 'PENDING_REJECTION' : 'REJECTED'] += 1;
    else counts.SPECIALIST += 1;
  }
  captured.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt) || right.caseRunId.localeCompare(left.caseRunId));
  leads.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.caseRunId.localeCompare(left.caseRunId));
  activity.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  const openReviews = (await repository.listReviews()).filter((review) => reviewOpenStatuses.includes(review.reviewStatus.toUpperCase())).length;
  return {
    stages: stages.map((stage) => ({ ...stage, requestTypes: requestTypes.filter((entry) => entry.stage === stage.id).map((entry) => ({ id: entry.id, label: entry.label, automated: entry.automated })), captured: captured.filter((row) => row.stage === stage.id).length, assessed: stage.id === 'PROFILING' ? loaCases + leads.length : 0 })),
    captured, leads, pipeline: (Object.keys(pipelineLabels) as PipelineKey[]).map((key) => ({ key, label: pipelineLabels[key], count: counts[key] })), activity: activity.slice(0, 12),
    newLeads: leads.length, loaCases, openReviews, automatedRequestTypes: requestTypes.filter((entry) => entry.automated).map((entry) => entry.id), syntheticDataDisclaimer: true,
  };
}
