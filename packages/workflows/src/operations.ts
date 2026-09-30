/** Operations overview: the operating-model stages, what runs on each, and the requests captured and routed so far. */
import { requestTypeById, requestTypes, stageById, stages, type StageId } from '@sbo/domain';
import { type Repository } from '@sbo/persistence';
import { capturedStatus } from './capture.js';

export interface CapturedRow { caseRunId: string; requestTypeId: string; requestLabel: string; stage: StageId; stageName: string; queue: string; businessName: string; representativeName: string; capturedAt: string; }
export interface StageOverview { id: StageId; name: string; order: number; summary: string; covers: string[]; build: 'LIVE' | 'ROUTED' | 'NOT_BUILT'; queue: string; requestTypes: Array<{ id: string; label: string; automated: boolean }>; captured: number; assessed: number; }
export interface OperationsOverview { stages: StageOverview[]; captured: CapturedRow[]; newLeads: number; loaCases: number; automatedRequestTypes: string[]; syntheticDataDisclaimer: true; }

export async function getOperationsOverview(repository: Repository): Promise<OperationsOverview> {
  const cases = await repository.listCases();
  const captured: CapturedRow[] = [];
  let newLeads = 0; let loaCases = 0;
  for (const caseRecord of cases) {
    if (caseRecord.requestType === 'NEW_LEAD') { newLeads += 1; continue; }
    const runtime = await repository.getRuntimeCase(caseRecord.caseRunId);
    if (runtime?.status === capturedStatus) {
      const requestType = requestTypeById(caseRecord.requestType);
      const stage = stageById(requestType?.stage ?? '');
      captured.push({ caseRunId: caseRecord.caseRunId, requestTypeId: caseRecord.requestType, requestLabel: requestType?.label ?? caseRecord.requestType, stage: (stage?.id ?? 'PROFILING') as StageId, stageName: stage?.name ?? '', queue: runtime.targetQueue, businessName: caseRecord.businessName, representativeName: caseRecord.representativeName, capturedAt: runtime.createdAt });
    } else loaCases += 1;
  }
  captured.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt) || right.caseRunId.localeCompare(left.caseRunId));
  return {
    stages: stages.map((stage) => ({ ...stage, requestTypes: requestTypes.filter((entry) => entry.stage === stage.id).map((entry) => ({ id: entry.id, label: entry.label, automated: entry.automated })), captured: captured.filter((row) => row.stage === stage.id).length, assessed: stage.id === 'PROFILING' ? loaCases : 0 })),
    captured, newLeads, loaCases, automatedRequestTypes: requestTypes.filter((entry) => entry.automated).map((entry) => entry.id), syntheticDataDisclaimer: true,
  };
}