import type {
  KnownOperationOutcomeStatus,
  OperationCompatibilityDiagnostic,
  OperationOutcomeStatus,
  TestSessionOperationRecord,
  TestSessionOperationTailResult,
} from '../../types/operation-contracts';
import {
  TEST_SESSION_OPERATION_KIND,
  TEST_SESSION_OPERATION_SCHEMA_VERSION,
} from '../../types/operation-contracts';

export const LEGACY_OPERATION_RESULT_SUMMARY = '旧记录未采集操作结果';
export const OPERATION_PAGE_LIMIT = 80;

type LegacyStepLike = {
  id?: string;
  stepId?: string;
  operationId?: string;
  sessionId?: string;
  timestampMs?: number;
  occurredAtMs?: number;
  startedAtMs?: number;
  endedAtMs?: number;
  relativeMsFromSessionStart?: number;
  sequence?: number;
  action?: string;
  title?: string;
  x?: number;
  y?: number;
  logicalX?: number;
  logicalY?: number;
  displayId?: string;
  processName?: string;
  windowTitle?: string;
  windowHwnd?: string;
  windowPid?: number;
  eventId?: string;
  fullImagePath?: string;
  thumbImagePath?: string;
  edited?: boolean;
  ignored?: boolean;
  businessAlias?: string;
  manualNote?: string;
  note?: string;
};

export type OperationReviewStatus =
  | 'ready'
  | 'empty'
  | 'partial'
  | 'corrupt'
  | 'futureSchema'
  | 'unavailable'
  | 'loading';

export type OperationReviewModel = {
  status: OperationReviewStatus;
  operations: TestSessionOperationRecord[];
  diagnostics: OperationCompatibilityDiagnostic[];
  nextCursor?: string;
  reset: boolean;
  totalCount: number;
};

export type OperationStatusTone =
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'muted'
  | 'neutral';

export type OperationStatusPresentation = {
  status: OperationOutcomeStatus;
  label: string;
  tone: OperationStatusTone;
  shortLabel: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function actionKind(action?: string): TestSessionOperationRecord['action']['kind'] {
  const normalized = (action ?? '').toLowerCase();
  if (normalized.includes('double')) {
    return 'doubleClick';
  }
  if (normalized.includes('right')) {
    return 'rightClick';
  }
  if (normalized.includes('scroll')) {
    return 'scroll';
  }
  if (normalized.includes('type') || normalized.includes('key')) {
    return 'typeSummary';
  }
  if (normalized.includes('click') || normalized.includes('lbutton')) {
    return 'click';
  }
  return 'manualMark';
}

export function adaptLegacyStepToOperation(
  step: unknown,
  sessionId?: string,
  index = 0,
): TestSessionOperationRecord {
  const record = asRecord(step);
  const stepId = stringValue(record, 'id') ?? stringValue(record, 'stepId') ?? `legacy-step-${index + 1}`;
  const operationId = stringValue(record, 'operationId') ?? stepId;
  const occurredAtMs =
    numberValue(record, 'timestampMs') ??
    numberValue(record, 'occurredAtMs') ??
    numberValue(record, 'startedAtMs') ??
    Date.now();
  const endedAtMs = numberValue(record, 'endedAtMs') ?? occurredAtMs;
  const actionText = stringValue(record, 'action') ?? stringValue(record, 'title') ?? 'Legacy step';
  const title = stringValue(record, 'title') ?? actionText;
  const x = numberValue(record, 'x') ?? numberValue(record, 'logicalX');
  const y = numberValue(record, 'y') ?? numberValue(record, 'logicalY');
  const windowTitle = stringValue(record, 'windowTitle');
  const processName = stringValue(record, 'processName');
  const windowHwnd = stringValue(record, 'windowHwnd');
  const sourceId = stringValue(record, 'eventId') ?? stepId;

  return {
    schemaVersion: TEST_SESSION_OPERATION_SCHEMA_VERSION,
    kind: TEST_SESSION_OPERATION_KIND,
    operationId,
    sessionId: stringValue(record, 'sessionId') ?? sessionId ?? '',
    sequence: numberValue(record, 'sequence') ?? index + 1,
    startedAtMs: occurredAtMs,
    endedAtMs,
    relativeMsFromSessionStart: numberValue(record, 'relativeMsFromSessionStart') ?? 0,
    action: {
      actionId: stringValue(record, 'actionId') ?? `legacy-action-${operationId}`,
      kind: actionKind(actionText),
      occurredAtMs,
      endedAtMs,
      target:
        windowTitle || processName || windowHwnd
          ? {
              runtimeId: null,
              processId: numberValue(record, 'windowPid') ?? null,
              windowHwnd: windowHwnd ?? null,
              name: windowTitle ?? processName ?? null,
              automationId: null,
              controlType: null,
              localizedControlType: null,
              className: null,
              frameworkId: null,
              parentPath: [],
              boundingRect: null,
            }
          : null,
      stateBefore: null,
      coordinate:
        x !== undefined && y !== undefined
          ? { x, y, displayId: stringValue(record, 'displayId') ?? null }
          : null,
      sourceEventIds: [sourceId],
      targetReasonCodes: ['legacy-step-adapter'],
      confidence: { target: null, temporal: null, overall: null },
    },
    outcome: {
      outcomeId: `legacy-outcome-${operationId}`,
      status: 'legacyUnknown',
      summary: LEGACY_OPERATION_RESULT_SUMMARY,
      observedAtMs: endedAtMs,
      latencyMs: Math.max(0, endedAtMs - occurredAtMs),
      primaryTransitionId: null,
      candidateTransitionIds: [],
      reasonCodes: ['legacy-step-adapter'],
      confidence: {
        temporal: null,
        identity: null,
        transition: null,
        evidence: null,
        overall: null,
      },
    },
    completionCandidates: [],
    transitions: [],
    evidence: [
      {
        evidenceId: `legacy-evidence-${operationId}`,
        kind: 'rawEvent',
        role: 'context',
        sourceId,
        occurredAtMs,
        artifactRef: stringValue(record, 'fullImagePath') ?? stringValue(record, 'thumbImagePath') ?? null,
        videoRange: null,
        reasonCode: 'legacy-step-adapter',
      },
    ],
    title,
    resultSummary: LEGACY_OPERATION_RESULT_SUMMARY,
    displaySummary: `${title} -> ${LEGACY_OPERATION_RESULT_SUMMARY}`,
    precisionLevel: 'legacy-step-adapter',
    outcomeSelectionSource: 'auto',
    edited: booleanValue(record, 'edited') ?? false,
    ignored: booleanValue(record, 'ignored') ?? false,
    businessAlias: stringValue(record, 'businessAlias') ?? null,
    manualNote: stringValue(record, 'manualNote') ?? stringValue(record, 'note') ?? null,
  };
}

export function normalizeOperationRecord(
  raw: unknown,
  sessionId?: string,
  index = 0,
): TestSessionOperationRecord {
  const record = asRecord(raw);
  if (!stringValue(record, 'operationId') && !stringValue(record, 'title') && !asRecord(record.action).kind) {
    return adaptLegacyStepToOperation(raw, sessionId, index);
  }

  const actionRecord = asRecord(record.action);
  const outcomeRecord = asRecord(record.outcome);
  const operationId =
    stringValue(record, 'operationId') ?? stringValue(record, 'id') ?? `operation-${index + 1}`;
  const startedAtMs =
    numberValue(record, 'startedAtMs') ??
    numberValue(actionRecord, 'occurredAtMs') ??
    numberValue(record, 'occurredAtMs') ??
    0;
  const endedAtMs = numberValue(record, 'endedAtMs') ?? numberValue(outcomeRecord, 'observedAtMs') ?? startedAtMs;
  const title = stringValue(record, 'title') ?? '操作';
  const resultSummary =
    stringValue(record, 'resultSummary') ??
    stringValue(outcomeRecord, 'summary') ??
    LEGACY_OPERATION_RESULT_SUMMARY;
  const status = (stringValue(outcomeRecord, 'status') ?? 'incomplete') as OperationOutcomeStatus;

  return {
    schemaVersion: TEST_SESSION_OPERATION_SCHEMA_VERSION,
    kind: TEST_SESSION_OPERATION_KIND,
    operationId,
    sessionId: stringValue(record, 'sessionId') ?? sessionId ?? '',
    sequence: numberValue(record, 'sequence') ?? index + 1,
    startedAtMs,
    endedAtMs,
    relativeMsFromSessionStart: numberValue(record, 'relativeMsFromSessionStart') ?? 0,
    action: {
      actionId: stringValue(actionRecord, 'actionId') ?? `action-${operationId}`,
      kind: (stringValue(actionRecord, 'kind') as TestSessionOperationRecord['action']['kind'] | undefined) ?? 'click',
      occurredAtMs: numberValue(actionRecord, 'occurredAtMs') ?? startedAtMs,
      endedAtMs: numberValue(actionRecord, 'endedAtMs') ?? endedAtMs,
      target: (actionRecord.target as TestSessionOperationRecord['action']['target']) ?? null,
      stateBefore: (actionRecord.stateBefore as TestSessionOperationRecord['action']['stateBefore']) ?? null,
      coordinate: (actionRecord.coordinate as TestSessionOperationRecord['action']['coordinate']) ?? null,
      sourceEventIds: stringArray(actionRecord.sourceEventIds),
      targetReasonCodes: stringArray(actionRecord.targetReasonCodes),
      confidence: {
        target: numberValue(asRecord(actionRecord.confidence), 'target') ?? null,
        temporal: numberValue(asRecord(actionRecord.confidence), 'temporal') ?? null,
        overall: numberValue(asRecord(actionRecord.confidence), 'overall') ?? null,
      },
    },
    outcome: {
      outcomeId: stringValue(outcomeRecord, 'outcomeId') ?? `outcome-${operationId}`,
      status,
      summary: stringValue(outcomeRecord, 'summary') ?? resultSummary,
      observedAtMs: numberValue(outcomeRecord, 'observedAtMs') ?? endedAtMs,
      latencyMs: numberValue(outcomeRecord, 'latencyMs') ?? Math.max(0, endedAtMs - startedAtMs),
      primaryTransitionId: stringValue(outcomeRecord, 'primaryTransitionId') ?? null,
      candidateTransitionIds: stringArray(outcomeRecord.candidateTransitionIds),
      reasonCodes: stringArray(outcomeRecord.reasonCodes),
      confidence: {
        temporal: numberValue(asRecord(outcomeRecord.confidence), 'temporal') ?? null,
        identity: numberValue(asRecord(outcomeRecord.confidence), 'identity') ?? null,
        transition: numberValue(asRecord(outcomeRecord.confidence), 'transition') ?? null,
        evidence: numberValue(asRecord(outcomeRecord.confidence), 'evidence') ?? null,
        overall: numberValue(asRecord(outcomeRecord.confidence), 'overall') ?? null,
      },
    },
    completionCandidates: Array.isArray(record.completionCandidates)
      ? (record.completionCandidates as TestSessionOperationRecord['completionCandidates'])
      : [],
    transitions: Array.isArray(record.transitions)
      ? (record.transitions as TestSessionOperationRecord['transitions'])
      : [],
    evidence: Array.isArray(record.evidence)
      ? (record.evidence as TestSessionOperationRecord['evidence'])
      : [],
    title,
    resultSummary,
    displaySummary:
      stringValue(record, 'displaySummary') ??
      `${title} -> ${resultSummary}${numberValue(outcomeRecord, 'latencyMs') !== undefined ? `，耗时 ${numberValue(outcomeRecord, 'latencyMs')}ms` : ''}`,
    precisionLevel: stringValue(record, 'precisionLevel') ?? 'l0',
    outcomeSelectionSource:
      (stringValue(record, 'outcomeSelectionSource') as TestSessionOperationRecord['outcomeSelectionSource'] | undefined) ??
      'auto',
    edited: booleanValue(record, 'edited') ?? false,
    ignored: booleanValue(record, 'ignored') ?? false,
    businessAlias: stringValue(record, 'businessAlias') ?? null,
    manualNote: stringValue(record, 'manualNote') ?? stringValue(record, 'note') ?? null,
  };
}

export function buildOperationReviewModel(
  tail: TestSessionOperationTailResult | null | undefined,
  legacySteps: unknown[] = [],
  sessionId?: string,
): OperationReviewModel {
  const diagnostics = tail?.diagnostics ?? [];
  const operations = tail?.items?.length
    ? tail.items.map((item, index) => normalizeOperationRecord(item, sessionId, index))
    : legacySteps.map((step, index) => adaptLegacyStepToOperation(step, sessionId, index));
  const hasLegacyFallback = !tail?.items?.length && legacySteps.length > 0;
  const nextDiagnostics = hasLegacyFallback
    ? [
        ...diagnostics,
        {
          code: 'legacyStepsAdapter',
          severity: 'info' as const,
          message: '旧会话只有 steps 记录，已按 legacyUnknown 操作结果只读适配。',
        },
      ]
    : diagnostics;
  const status = resolveOperationReviewStatus(operations, nextDiagnostics);

  return {
    status,
    operations,
    diagnostics: nextDiagnostics,
    nextCursor: tail?.nextCursor,
    reset: tail?.reset ?? true,
    totalCount: tail?.totalCount ?? operations.length,
  };
}

export function mergeOperationPages(
  previous: TestSessionOperationRecord[],
  nextPage: TestSessionOperationRecord[],
  reset: boolean,
): TestSessionOperationRecord[] {
  if (reset || previous.length === 0) {
    return nextPage;
  }
  const seen = new Set(previous.map((item) => item.operationId));
  const merged = [...previous];
  for (const item of nextPage) {
    if (seen.has(item.operationId)) {
      continue;
    }
    seen.add(item.operationId);
    merged.push(item);
  }
  return merged;
}

export function resolveOperationReviewStatus(
  operations: TestSessionOperationRecord[],
  diagnostics: OperationCompatibilityDiagnostic[],
): OperationReviewStatus {
  if (diagnostics.some((diagnostic) => diagnostic.code === 'futureSchema')) {
    return 'futureSchema';
  }
  if (diagnostics.some((diagnostic) => diagnostic.code === 'corruptTail')) {
    return operations.length > 0 ? 'partial' : 'corrupt';
  }
  if (diagnostics.some((diagnostic) => diagnostic.code === 'unavailable')) {
    return 'unavailable';
  }
  return operations.length > 0 ? 'ready' : 'empty';
}

export function operationStatusPresentation(
  status: OperationOutcomeStatus | string | undefined,
): OperationStatusPresentation {
  const normalized = (status ?? 'incomplete').toString();
  switch (normalized) {
    case 'confirmed':
      return { status: 'confirmed', label: '结果已确认', shortLabel: '已确认', tone: 'success' };
    case 'candidate':
      return { status: 'candidate', label: '候选结果', shortLabel: '候选', tone: 'warning' };
    case 'ambiguous':
      return { status: 'ambiguous', label: '多个候选需确认', shortLabel: '待确认', tone: 'warning' };
    case 'incomplete':
      return { status: 'incomplete', label: '未观测到明确结果', shortLabel: '未完成', tone: 'muted' };
    case 'observerDegraded':
      return { status: 'observerDegraded', label: '观测降级', shortLabel: '降级', tone: 'danger' };
    case 'legacyUnknown':
      return { status: 'legacyUnknown', label: '旧记录未采集结果', shortLabel: '旧记录', tone: 'info' };
    default:
      return {
        status: normalized,
        label: `结果状态 ${normalized}`,
        shortLabel: normalized,
        tone: 'neutral',
      };
  }
}

export function shouldShowConfidenceBadge(operation: TestSessionOperationRecord): boolean {
  const status = operation.outcome?.status;
  if (status === 'candidate' || status === 'ambiguous' || status === 'observerDegraded' || status === 'incomplete') {
    return true;
  }
  const overall = operation.outcome?.confidence?.overall ?? operation.action?.confidence?.overall;
  return typeof overall === 'number' && overall < 0.75;
}

export function formatRelativeOperationTime(relativeMs: number): string {
  const safeMs = Number.isFinite(relativeMs) ? Math.max(0, relativeMs) : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  if (totalSeconds < 60) {
    const seconds = safeMs / 1000;
    return `+${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `+${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatActionKindLabel(kind: string | undefined): string {
  const labels: Record<string, string> = {
    click: '单击',
    doubleClick: '双击',
    rightClick: '右键',
    toggle: '切换',
    select: '选择',
    expand: '展开',
    collapse: '折叠',
    typeSummary: '输入',
    shortcut: '快捷键',
    scroll: '滚动',
    windowSwitch: '切窗',
    manualMark: '标记',
  };
  return labels[kind ?? ''] ?? (kind ? kind : '操作');
}

export function operationContextLine(operation: TestSessionOperationRecord): string {
  const target = operation.action?.target;
  const parts = [
    target?.name,
    target?.controlType ?? target?.localizedControlType,
    target?.windowHwnd ? undefined : undefined,
  ].filter((value): value is string => !!value && value.trim().length > 0);

  // Prefer explicit window-ish name from target; fall back to process/window fields if present on target path.
  const parentWindow = target?.parentPath?.find((entry) => entry.controlType === 'Window')?.name;
  const context = [parentWindow, target?.frameworkId].filter((value): value is string => !!value && value.trim().length > 0);
  const latency =
    typeof operation.outcome?.latencyMs === 'number' ? `耗时 ${operation.outcome.latencyMs}ms` : undefined;
  return [...parts.slice(0, 1), ...context, latency].filter(Boolean).join(' · ');
}

export function operationWindowLabel(operation: TestSessionOperationRecord): string | undefined {
  const target = operation.action?.target;
  const fromPath = target?.parentPath?.find((entry) => {
    const type = (entry.controlType ?? '').toLowerCase();
    return type.includes('window') || type.includes('dialog');
  })?.name;
  return fromPath ?? target?.name ?? undefined;
}

export function buildOperationReproText(input: {
  sessionId?: string | null;
  operations: TestSessionOperationRecord[];
  defectNote?: string;
  windowStartMs?: number;
  windowEndMs?: number;
  markedAtMs?: number;
}): string {
  const lines: string[] = [];
  if (input.sessionId) {
    lines.push(`会话: ${input.sessionId}`);
  }
  if (typeof input.markedAtMs === 'number') {
    lines.push(`缺陷标记时间: ${input.markedAtMs}`);
  }
  if (typeof input.windowStartMs === 'number' && typeof input.windowEndMs === 'number') {
    lines.push(`时间窗: ${input.windowStartMs} ~ ${input.windowEndMs}`);
  }
  if (input.defectNote?.trim()) {
    lines.push(`缺陷说明: ${input.defectNote.trim()}`);
  }
  lines.push('');
  lines.push('复现步骤:');

  const operations = input.operations.filter((operation) => !operation.ignored);
  if (operations.length === 0) {
    lines.push('1. （时间窗内未聚合到可复现操作，请结合视频与截图确认）');
    lines.push('');
    return lines.join('\n');
  }

  operations.forEach((operation, index) => {
    const status = operationStatusPresentation(operation.outcome?.status);
    const latency =
      typeof operation.outcome?.latencyMs === 'number' ? `，耗时 ${operation.outcome.latencyMs}ms` : '';
    // Honest wording: never rewrite incomplete/degraded as success.
    if (status.status === 'confirmed' || status.status === 'candidate') {
      lines.push(
        `${index + 1}. ${operation.title} -> ${operation.resultSummary}${latency}`,
      );
    } else if (status.status === 'ambiguous') {
      lines.push(`${index + 1}. ${operation.title} -> ${status.label}${latency}`);
    } else {
      lines.push(`${index + 1}. ${operation.title} -> ${status.label}${latency}`);
    }
  });
  lines.push('');
  return lines.join('\n');
}

export function filterOperationsByWindow(
  operations: TestSessionOperationRecord[],
  windowStartMs?: number,
  windowEndMs?: number,
): TestSessionOperationRecord[] {
  if (windowStartMs === undefined || windowEndMs === undefined) {
    return operations;
  }
  return operations.filter(
    (operation) => operation.startedAtMs >= windowStartMs && operation.startedAtMs <= windowEndMs,
  );
}

export function reviewStatusMessage(status: OperationReviewStatus): string {
  switch (status) {
    case 'loading':
      return '正在加载操作记录…';
    case 'empty':
      return '当前会话尚无操作记录。完成点击/输入后可重新生成。';
    case 'partial':
      return '操作记录部分可读：检测到损坏尾行，已加载完整前缀。';
    case 'corrupt':
      return '操作记录损坏，无法读取有效前缀。';
    case 'futureSchema':
      return '该会话使用了更高版本 schema，当前版本只读打开，禁止覆盖重建。';
    case 'unavailable':
      return '操作记录接口不可用，已尝试降级到旧步骤适配。';
    default:
      return '';
  }
}

export type ManualOutcomeChoice = {
  transitionId: string;
  label: string;
  status: KnownOperationOutcomeStatus;
};

export function listManualOutcomeChoices(
  operation: TestSessionOperationRecord,
): ManualOutcomeChoice[] {
  const byId = new Map(operation.transitions.map((transition) => [transition.transitionId, transition]));
  const ids = new Set<string>();
  if (operation.outcome.primaryTransitionId) {
    ids.add(operation.outcome.primaryTransitionId);
  }
  for (const id of operation.outcome.candidateTransitionIds) {
    ids.add(id);
  }
  for (const candidate of operation.completionCandidates) {
    if (candidate.primaryTransitionId) {
      ids.add(candidate.primaryTransitionId);
    }
    for (const id of candidate.candidateTransitionIds) {
      ids.add(id);
    }
  }

  return [...ids].map((transitionId) => {
    const transition = byId.get(transitionId);
    const property = transition?.property ?? '状态变化';
    const after =
      transition?.after === null || transition?.after === undefined
        ? ''
        : typeof transition.after === 'string'
          ? transition.after
          : JSON.stringify(transition.after);
    const label = after ? `${property}: ${after}` : property;
    return {
      transitionId,
      label,
      status: 'confirmed',
    };
  });
}

// Keep legacy type export used by tests/fixtures.
export type { LegacyStepLike };
