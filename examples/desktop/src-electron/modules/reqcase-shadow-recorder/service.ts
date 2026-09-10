import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import {
  resolveRecordingWindowSeconds,
  resolveSegmentDurationSeconds,
} from '../../../types/recording-defaults';
import {
  appendTestSessionLog,
  markTestDefect as nativeMarkTestDefect,
  getTestSessionOperations as nativeGetTestSessionOperations,
  hasTestSessionOperationListApi,
  hasTestSessionOperationRebuildApi,
  hasTestSessionOperationUpdateApi,
  rebuildTestSessionOperations as nativeRebuildTestSessionOperations,
  updateTestSessionOperation as nativeUpdateTestSessionOperation,
  getTestSessionSteps as nativeGetTestSessionSteps,
  rebuildTestSessionSteps as nativeRebuildTestSessionSteps,
  renderTestSessionReproSteps as nativeRenderTestSessionReproSteps,
  exportTestDefectPack as nativeExportTestDefectPack,
  updateTestSessionStep as nativeUpdateTestSessionStep,
  setSemanticAliasProfile as nativeSetSemanticAliasProfile,
  getSemanticAliasProfile as nativeGetSemanticAliasProfile,
  loadSemanticProfile as nativeLoadSemanticProfile,
  getSemanticProfileJson as nativeGetSemanticProfileJson,
  clearSemanticProfile as nativeClearSemanticProfile,
  setSemanticProfileJson as nativeSetSemanticProfileJson,
  appendTestSessionNote,
  buildRuntimeHealthSnapshot,
  clearRecorderBuffer,
  getActiveTestSession,
  getRecorderBuffer,
  getRecorderBufferPage,
  getRecorderBufferSince,
  getRecorderMetrics,
  getRecorderStepImage,
  isNativeBindingLoaded,
  getTestSessionEvents,
  getTestSessionEventsTail,
  getTestSessionVideoSegments,
  getTestSessionVideoSegmentsTail,
  getTestSessionVideoSegmentsForTimestamp,
  getTestSessionVideoStreams,
  isRecordingPaused,
  listAvailableDisplays,
  listTestSessions,
  pauseRecording,
  pauseTestSession,
  resumeRecording,
  resumeTestSession,
  setRecorderConfig,
  startTestSession,
  stopRecording,
  stopTestSession,
  subscribeRecorderStepsV2,
  unsubscribeRecorderSteps,
  updateActiveTestSessionVideoConfig,
} from '../../native-binding';
import { configureBundledFfmpegEnv } from '../../ffmpeg-resource';
import {
  createDisabledReplayStepProvider,
  createMockReplayStepProvider,
  createOpenAiCompatibleReplayStepProvider,
} from './ai-provider';
import { exportTestSessionEvidence } from './evidence-export';
import {
  findHistoricalTestSession,
  findHistoricalVideoSegmentsForTimestamp,
  listHistoricalTestSessions,
  readHistoricalSessionEvents,
  readHistoricalSessionEventsTail,
  readHistoricalSessionOperationsTail,
  readHistoricalSessionSteps,
  readHistoricalSessionVideoSegments,
  readHistoricalSessionVideoSegmentsTail,
  readHistoricalSessionVideoStreams,
  renderHistoricalReproSteps,
} from './historical-session-reader';
import {
  applyAndPersistHistoricalOperationAliases,
  applyProfileAliasesToOperations,
  loadSemanticProfileSnapshot,
} from './semantic-alias-apply';
import { exportShadowRecorderReport } from './report-export';
import { RecorderResourceUsageMonitor } from './runtime-resource-usage';
import { buildStructuredStepContext, buildStructuredStepContextFromEvent } from './step-context';
import { exportTuningSnapshot } from './tuning-snapshot';
import { exportTuningSnapshotInUtilityProcess } from './utility-maintenance';
import type {
  ReqCaseShadowRecorderConfig,
  ReqCaseShadowRecorderDisplayTarget,
  ReqCaseShadowRecorderExportInput,
  ReqCaseShadowRecorderExportResult,
  ReqCaseShadowRecorderMetrics,
  ReqCaseShadowRecorderReplayStepGenerateInput,
  ReqCaseShadowRecorderReplayStepGenerateResult,
  ReqCaseShadowRecorderRuntimeHealth,
  ReqCaseShadowRecorderStep,
  ReqCaseShadowRecorderTestSessionEvidenceExportInput,
  ReqCaseShadowRecorderTestSessionEvidenceExportResult,
  ReqCaseShadowRecorderTestSessionLogInput,
  ReqCaseShadowRecorderTestSessionNoteInput,
  ReqCaseShadowRecorderTestSessionOperationDetailInput,
  ReqCaseShadowRecorderTestSessionOperationListInput,
  ReqCaseShadowRecorderTestSessionOperationRebuildInput,
  ReqCaseShadowRecorderTestSessionOperationRecord,
  ReqCaseShadowRecorderTestSessionOperationTailResult,
  ReqCaseShadowRecorderTestSessionOperationUpdateInput,
  ReqCaseShadowRecorderTestSessionStartInput,
  ReqCaseShadowRecorderTestSessionState,
  ReqCaseShadowRecorderTestSessionTimelineEvent,
  ReqCaseShadowRecorderTestSessionTimelineEventTailResult,
  ReqCaseShadowRecorderTestSessionVideoSegment,
  ReqCaseShadowRecorderTestSessionVideoSegmentTailResult,
  ReqCaseShadowRecorderTestSessionVideoStream,
  ReqCaseShadowRecorderTuningSnapshotExportInput,
  ReqCaseShadowRecorderTuningSnapshotExportResult,
} from './types';

function asLegacyRecord(value: unknown): Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function legacyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function legacyNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function legacyBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function mapLegacyOperationActionKind(
  action?: string,
): ReqCaseShadowRecorderTestSessionOperationRecord['action']['kind'] {
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

export class ReqCaseShadowRecorderService {
  private recording = false;
  private currentConfig: ReqCaseShadowRecorderConfig = {
    targetCaptureMode: 'target_display',
    recordingProfile: 'balanced',
    encoderPreference: 'auto',
    showMouseInVideo: false,
    captureBackend: 'dxgi',
    debounceMs: 90,
    recordingWindowSeconds: 90,
    segmentDurationSeconds: 5,
  };
  private pushPublisher: ((step: ReqCaseShadowRecorderStep) => void) | null = null;
  private pushBound = false;
  private readonly resourceUsageMonitor = new RecorderResourceUsageMonitor();

  public constructor() {
    configureBundledFfmpegEnv();
  }

  private resolveDesktopRoot(): string {
    return path.resolve(__dirname, '../../../');
  }

  private resolveReportsRoot(): string {
    if (app.isPackaged) {
      return path.resolve(app.getPath('userData'), 'reports');
    }
    return path.resolve(this.resolveDesktopRoot(), 'reports');
  }

  private resolveTestSessionsRoot(): string {
    return path.resolve(this.resolveReportsRoot(), 'test-sessions');
  }

  private getNativeSessionsSafe(): ReqCaseShadowRecorderTestSessionState[] {
    try {
      return listTestSessions();
    } catch {
      return [];
    }
  }

  private isNativeSessionKnown(sessionId?: string): boolean {
    if (!sessionId) {
      return false;
    }
    return this.getNativeSessionsSafe().some((session) => session.sessionId === sessionId);
  }

  private findHistoricalSession(sessionId?: string): ReqCaseShadowRecorderTestSessionState | null {
    return findHistoricalTestSession(this.resolveTestSessionsRoot(), sessionId);
  }

  private isWithinRoot(rootDir: string, targetDir: string): boolean {
    const relative = path.relative(rootDir, targetDir);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private resolveSafeReportDir(targetDir: string): string {
    const desktopRoot = this.resolveDesktopRoot();
    const reportsRoot = this.resolveReportsRoot();
    const resolved = path.isAbsolute(targetDir)
      ? path.resolve(targetDir)
      : path.resolve(desktopRoot, targetDir);

    if (!this.isWithinRoot(reportsRoot, resolved)) {
      throw new Error(
        `Invalid report targetDir: ${resolved}. Allowed root: ${reportsRoot}`,
      );
    }

    return resolved;
  }

  private resolveSafeSessionDir(storageDir?: string): string {
    const desktopRoot = this.resolveDesktopRoot();
    const sessionsRoot = this.resolveTestSessionsRoot();
    const requested = storageDir && storageDir.trim().length > 0
      ? storageDir
      : sessionsRoot;
    const resolved = path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(desktopRoot, requested);

    if (!this.isWithinRoot(this.resolveReportsRoot(), resolved)) {
      throw new Error(
        `Invalid session storageDir: ${resolved}. Allowed root: ${this.resolveReportsRoot()}`,
      );
    }

    return resolved;
  }

  private resolveEvidenceExportDir(targetDir: string): string {
    const desktopRoot = this.resolveDesktopRoot();
    const requested = targetDir.trim();
    if (!requested) {
      throw new Error('Evidence export targetDir is required.');
    }
    return path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(desktopRoot, requested);
  }

  private buildDefaultSessionName(): string {
    return `循环录制 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
  }

  private buildSessionStartInput(
    input: ReqCaseShadowRecorderTestSessionStartInput = {},
  ): ReqCaseShadowRecorderTestSessionStartInput {
    const bufferWindowSeconds = input.bufferWindowSeconds
      ?? resolveRecordingWindowSeconds(this.currentConfig.recordingWindowSeconds);
    const segmentDurationSeconds = input.segmentDurationSeconds
      ?? resolveSegmentDurationSeconds(this.currentConfig.segmentDurationSeconds, bufferWindowSeconds);
    const targetDisplayIds = this.resolveConfiguredDisplayIds(
      input.targetDisplayIds ?? this.currentConfig.targetDisplayIds,
    );
    const targetDisplayId = input.targetDisplayId
      ?? this.currentConfig.targetDisplayId
      ?? targetDisplayIds?.[0];

    return {
      ...input,
      name: input.name?.trim() || this.buildDefaultSessionName(),
      storageDir: this.resolveSafeSessionDir(input.storageDir),
      targetCaptureMode: input.targetCaptureMode ?? this.currentConfig.targetCaptureMode ?? 'target_display',
      targetDisplayId,
      targetDisplayIds,
      bufferWindowSeconds,
      segmentDurationSeconds,
      recordingProfile: input.recordingProfile ?? this.currentConfig.recordingProfile ?? 'balanced',
      encoderPreference: input.encoderPreference ?? this.currentConfig.encoderPreference ?? 'auto',
      showMouseInVideo: input.showMouseInVideo ?? this.currentConfig.showMouseInVideo ?? false,
    };
  }

  private resolveConfiguredDisplayIds(
    value?: string[],
  ): string[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const next = value
      .map((displayId) => displayId.trim())
      .filter((displayId, index, displayIds) => displayId.length > 0 && displayIds.indexOf(displayId) === index);

    return next.length > 0 ? next : undefined;
  }

  public start(): void {
    if (this.recording) {
      return;
    }

    if (this.getActiveSession()) {
      this.recording = true;
      return;
    }

    if (this.currentConfig.captureBackend !== 'dxgi') {
      this.currentConfig = {
        ...this.currentConfig,
        captureBackend: 'dxgi',
      };
    }
    setRecorderConfig(this.currentConfig);
    startTestSession(this.buildSessionStartInput());
    this.recording = true;
  }

  public stop(): void {
    this.unsubscribePush();
    if (this.getActiveSession()) {
      stopTestSession();
    } else {
      stopRecording();
    }
    this.recording = false;
  }

  public isRecording(): boolean {
    return this.recording || this.getActiveSession() !== null;
  }

  public pause(): void {
    if (this.getActiveSession()) {
      pauseTestSession();
      return;
    }
    pauseRecording();
  }

  public resume(): void {
    if (this.getActiveSession()) {
      resumeTestSession();
      return;
    }
    resumeRecording();
  }

  public isPaused(): boolean {
    return isRecordingPaused();
  }

  public getActiveSession(): ReqCaseShadowRecorderTestSessionState | null {
    try {
      return getActiveTestSession();
    } catch {
      return null;
    }
  }

  public listAvailableDisplays(): ReqCaseShadowRecorderDisplayTarget[] {
    return listAvailableDisplays();
  }

  public listSessions(): ReqCaseShadowRecorderTestSessionState[] {
    const nativeSessions = this.getNativeSessionsSafe();
    const merged = [
      ...nativeSessions,
      ...listHistoricalTestSessions(this.resolveTestSessionsRoot(), nativeSessions),
    ];
    const seen = new Set<string>();
    const visible: ReqCaseShadowRecorderTestSessionState[] = [];
    for (const session of merged) {
      if (seen.has(session.sessionId)) {
        continue;
      }
      seen.add(session.sessionId);
      const isLive = session.status === 'active' || session.status === 'paused';
      if (!isLive && session.sessionDir) {
        const sessionDir = path.resolve(session.sessionDir);
        if (!existsSync(sessionDir)) {
          continue;
        }
      }
      visible.push(session);
    }
    return visible;
  }

  public getSessionEvents(
    sessionId?: string,
    limit?: number,
  ): ReqCaseShadowRecorderTestSessionTimelineEvent[] {
    const historical = this.findHistoricalSession(sessionId);
    if (sessionId && historical && !this.isNativeSessionKnown(historical.sessionId)) {
      return readHistoricalSessionEvents(historical, limit)
        .map((event) => this.attachStructuredEventContext(event));
    }

    try {
      return getTestSessionEvents(sessionId, limit)
        .map((event) => this.attachStructuredEventContext(event));
    } catch (error) {
      if (historical) {
        return readHistoricalSessionEvents(historical, limit)
          .map((event) => this.attachStructuredEventContext(event));
      }
      throw error;
    }
  }

  public getSessionEventsTail(
    sessionId?: string,
    afterEventId?: string,
    limit?: number,
  ): ReqCaseShadowRecorderTestSessionTimelineEventTailResult {
    const historical = this.findHistoricalSession(sessionId);
    if (sessionId && historical && !this.isNativeSessionKnown(historical.sessionId)) {
      const result = readHistoricalSessionEventsTail(historical, afterEventId, limit);
      return {
        ...result,
        items: result.items.map((event) => this.attachStructuredEventContext(event)),
      };
    }

    let result: ReqCaseShadowRecorderTestSessionTimelineEventTailResult;
    try {
      result = getTestSessionEventsTail(sessionId, afterEventId, limit);
    } catch (error) {
      if (!historical) {
        throw error;
      }
      result = readHistoricalSessionEventsTail(historical, afterEventId, limit);
    }
    return {
      ...result,
      items: result.items.map((event) => this.attachStructuredEventContext(event)),
    };
  }

  public getSessionVideoStreams(
    sessionId?: string,
  ): ReqCaseShadowRecorderTestSessionVideoStream[] {
    const historical = this.findHistoricalSession(sessionId);
    if (sessionId && historical && !this.isNativeSessionKnown(historical.sessionId)) {
      return readHistoricalSessionVideoStreams(historical);
    }

    try {
      return getTestSessionVideoStreams(sessionId);
    } catch (error) {
      if (historical) {
        return readHistoricalSessionVideoStreams(historical);
      }
      throw error;
    }
  }

  public getSessionVideoSegments(
    sessionId?: string,
    streamId?: string,
    limit?: number,
  ): ReqCaseShadowRecorderTestSessionVideoSegment[] {
    const historical = this.findHistoricalSession(sessionId);
    if (sessionId && historical && !this.isNativeSessionKnown(historical.sessionId)) {
      return readHistoricalSessionVideoSegments(historical, streamId, limit);
    }

    try {
      return getTestSessionVideoSegments(sessionId, streamId, limit);
    } catch (error) {
      if (historical) {
        return readHistoricalSessionVideoSegments(historical, streamId, limit);
      }
      throw error;
    }
  }

  public getSessionVideoSegmentsTail(
    sessionId?: string,
    streamId?: string,
    afterSegmentId?: string,
    limit?: number,
  ): ReqCaseShadowRecorderTestSessionVideoSegmentTailResult {
    const historical = this.findHistoricalSession(sessionId);
    if (sessionId && historical && !this.isNativeSessionKnown(historical.sessionId)) {
      return readHistoricalSessionVideoSegmentsTail(historical, streamId, afterSegmentId, limit);
    }

    try {
      return getTestSessionVideoSegmentsTail(sessionId, streamId, afterSegmentId, limit);
    } catch (error) {
      if (historical) {
        return readHistoricalSessionVideoSegmentsTail(historical, streamId, afterSegmentId, limit);
      }
      throw error;
    }
  }

  public getSessionVideoSegmentsForTimestamp(
    sessionId?: string,
    occurredAtMs?: number,
    displayId?: string,
    limit?: number,
  ): ReqCaseShadowRecorderTestSessionVideoSegment[] {
    const historical = this.findHistoricalSession(sessionId);
    if (sessionId && historical && !this.isNativeSessionKnown(historical.sessionId)) {
      return findHistoricalVideoSegmentsForTimestamp(historical, occurredAtMs, displayId, limit);
    }

    try {
      const segments = getTestSessionVideoSegmentsForTimestamp(sessionId, occurredAtMs, displayId, limit);
      if (segments.length > 0 || !historical) {
        return segments;
      }
      return findHistoricalVideoSegmentsForTimestamp(historical, occurredAtMs, displayId, limit);
    } catch (error) {
      if (historical) {
        return findHistoricalVideoSegmentsForTimestamp(historical, occurredAtMs, displayId, limit);
      }
      throw error;
    }
  }

  public appendSessionNote(
    input: ReqCaseShadowRecorderTestSessionNoteInput,
  ): ReqCaseShadowRecorderTestSessionTimelineEvent {
    return appendTestSessionNote(input);
  }

  public appendSessionLog(
    input: ReqCaseShadowRecorderTestSessionLogInput,
  ): ReqCaseShadowRecorderTestSessionTimelineEvent | null {
    return appendTestSessionLog(input);
  }

  private toLegacyOperationRecord(
    step: unknown,
    sessionId: string | undefined,
    index: number,
  ): ReqCaseShadowRecorderTestSessionOperationRecord {
    const record = asLegacyRecord(step);
    const stepId = legacyString(record, 'id') ?? legacyString(record, 'stepId') ?? `legacy-step-${index + 1}`;
    const operationId = legacyString(record, 'operationId') ?? stepId;
    const occurredAtMs = legacyNumber(record, 'timestampMs')
      ?? legacyNumber(record, 'occurredAtMs')
      ?? legacyNumber(record, 'startedAtMs')
      ?? Date.now();
    const endedAtMs = legacyNumber(record, 'endedAtMs') ?? occurredAtMs;
    const actionText = legacyString(record, 'action') ?? legacyString(record, 'title') ?? 'Legacy step';
    const title = legacyString(record, 'title') ?? actionText;
    const legacyResultSummary = '旧记录未采集操作结果';
    const resultSummary = legacyString(record, 'resultSummary') ?? legacyResultSummary;
    const x = legacyNumber(record, 'x') ?? legacyNumber(record, 'logicalX');
    const y = legacyNumber(record, 'y') ?? legacyNumber(record, 'logicalY');
    const windowTitle = legacyString(record, 'windowTitle');
    const processName = legacyString(record, 'processName');
    const windowHwnd = legacyString(record, 'windowHwnd');
    const target = windowTitle || processName || windowHwnd
      ? {
        runtimeId: null,
        processId: legacyNumber(record, 'windowPid') ?? null,
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
      : null;
    const sourceId = legacyString(record, 'eventId') ?? stepId;

    return {
      schemaVersion: 1,
      kind: 'reqcase.test-session-operation',
      operationId,
      sessionId: legacyString(record, 'sessionId') ?? sessionId ?? '',
      sequence: legacyNumber(record, 'sequence') ?? index + 1,
      startedAtMs: occurredAtMs,
      endedAtMs,
      relativeMsFromSessionStart: legacyNumber(record, 'relativeMsFromSessionStart') ?? 0,
      action: {
        actionId: legacyString(record, 'actionId') ?? `legacy-action-${operationId}`,
        kind: mapLegacyOperationActionKind(actionText),
        occurredAtMs,
        endedAtMs,
        target,
        stateBefore: null,
        coordinate: x !== undefined && y !== undefined
          ? { x, y, displayId: legacyString(record, 'displayId') ?? null }
          : null,
        sourceEventIds: [sourceId],
        targetReasonCodes: ['legacy-step-adapter'],
        confidence: { target: null, temporal: null, overall: null },
      },
      outcome: {
        outcomeId: `legacy-outcome-${operationId}`,
        status: 'legacyUnknown',
        summary: resultSummary,
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
      evidence: [{
        evidenceId: `legacy-evidence-${operationId}`,
        kind: 'rawEvent',
        role: 'context',
        sourceId,
        occurredAtMs,
        artifactRef: legacyString(record, 'fullImagePath') ?? legacyString(record, 'thumbImagePath') ?? null,
        videoRange: null,
        reasonCode: 'legacy-step-adapter',
      }],
      title,
      resultSummary,
      displaySummary: title === resultSummary ? title : `${title} -> ${resultSummary}`,
      precisionLevel: 'legacy-step-adapter',
      outcomeSelectionSource: 'auto',
      edited: legacyBoolean(record, 'edited') ?? false,
      ignored: legacyBoolean(record, 'ignored') ?? false,
      businessAlias: legacyString(record, 'businessAlias') ?? null,
      manualNote: legacyString(record, 'manualNote') ?? legacyString(record, 'note') ?? null,
    };
  }

  private buildLegacyOperations(sessionId?: string): ReqCaseShadowRecorderTestSessionOperationRecord[] {
    return this.getTestSessionSteps(sessionId, undefined)
      .map((step: unknown, index: number) => this.toLegacyOperationRecord(step, sessionId, index));
  }

  private buildLegacyOperationsTail(
    input: ReqCaseShadowRecorderTestSessionOperationListInput,
  ): ReqCaseShadowRecorderTestSessionOperationTailResult {
    const operations = this.buildLegacyOperations(input.sessionId);
    let startIndex = 0;
    let reset = false;
    if (input.cursor) {
      const cursorIndex = operations.findIndex((operation) => operation.operationId === input.cursor);
      if (cursorIndex >= 0) {
        startIndex = cursorIndex + 1;
      } else {
        reset = true;
      }
    }
    const limit = input.limit ?? 100;
    const items = operations.slice(startIndex, startIndex + limit);
    const nextOffset = startIndex + items.length;
    return {
      items,
      nextCursor: nextOffset < operations.length ? items[items.length - 1]?.operationId : undefined,
      reset,
      totalCount: operations.length,
      diagnostics: operations.length > 0 ? [{
        code: 'legacyStepsAdapter',
        severity: 'info',
        message: '旧会话只有 steps 记录，已按 legacyUnknown 操作结果只读适配。',
      }] : [],
    };
  }

  private findNativeOperationById(
    sessionId: string | undefined,
    operationId: string,
  ): ReqCaseShadowRecorderTestSessionOperationRecord | null {
    let cursor: string | undefined;
    for (let page = 0; page < 200; page += 1) {
      const result = nativeGetTestSessionOperations(sessionId, cursor, 1000);
      const found = result.items.find((operation) => operation.operationId === operationId);
      if (found) {
        return found;
      }
      if (!result.nextCursor || result.nextCursor === cursor) {
        return null;
      }
      cursor = result.nextCursor;
    }
    throw new Error('operation detail lookup failed: pagination guard reached');
  }

  public getSessionOperations(
    input: ReqCaseShadowRecorderTestSessionOperationListInput,
  ): ReqCaseShadowRecorderTestSessionOperationTailResult {
    const historical = this.findHistoricalSession(input.sessionId);
    if (input.sessionId && historical && !this.isNativeSessionKnown(historical.sessionId)) {
      const tail = readHistoricalSessionOperationsTail(historical, input.cursor, input.limit);
      const sessionDir = historical.sessionDir || '';
      if (sessionDir) {
        const enriched = applyAndPersistHistoricalOperationAliases(sessionDir, tail.items || []);
        return { ...tail, items: enriched as typeof tail.items };
      }
      return tail;
    }

    let hasNativeListApi = false;
    try {
      hasNativeListApi = hasTestSessionOperationListApi();
    } catch {
      hasNativeListApi = false;
    }

    if (!hasNativeListApi) {
      if (historical) {
        return readHistoricalSessionOperationsTail(historical, input.cursor, input.limit);
      }
      return this.buildLegacyOperationsTail(input);
    }

    try {
      const result = nativeGetTestSessionOperations(input.sessionId, input.cursor, input.limit);
      if (historical && result.items.length === 0 && (result.diagnostics?.length ?? 0) === 0) {
        return readHistoricalSessionOperationsTail(historical, input.cursor, input.limit);
      }
      return result;
    } catch (error) {
      if (historical) {
        return readHistoricalSessionOperationsTail(historical, input.cursor, input.limit);
      }
      throw error;
    }
  }

  public getSessionOperation(
    input: ReqCaseShadowRecorderTestSessionOperationDetailInput,
  ): ReqCaseShadowRecorderTestSessionOperationRecord | null {
    const historical = this.findHistoricalSession(input.sessionId);
    if (input.sessionId && historical && !this.isNativeSessionKnown(historical.sessionId)) {
      return readHistoricalSessionOperationsTail(historical, undefined, 1000)
        .items
        .find((operation) => operation.operationId === input.operationId) ?? null;
    }

    try {
      if (hasTestSessionOperationListApi()) {
        return this.findNativeOperationById(input.sessionId, input.operationId);
      }
    } catch (error) {
      if (!historical) {
        throw error;
      }
    }
    return (historical
      ? readHistoricalSessionOperationsTail(historical, undefined, 1000).items
      : this.buildLegacyOperations(input.sessionId))
      .find((operation) => operation.operationId === input.operationId) ?? null;
  }

  public rebuildSessionOperations(
    input: ReqCaseShadowRecorderTestSessionOperationRebuildInput,
  ): ReqCaseShadowRecorderTestSessionOperationRecord[] {
    const historical = this.findHistoricalSession(input.sessionId);
    if (input.sessionId && historical && !this.isNativeSessionKnown(historical.sessionId)) {
      const items = readHistoricalSessionOperationsTail(historical, undefined, 1000).items || [];
      const sessionDir = historical.sessionDir || '';
      if (sessionDir) {
        return applyAndPersistHistoricalOperationAliases(sessionDir, items) as typeof items;
      }
      return items;
    }

    let hasNativeRebuildApi = false;
    try {
      hasNativeRebuildApi = hasTestSessionOperationRebuildApi();
    } catch {
      hasNativeRebuildApi = false;
    }

    if (!hasNativeRebuildApi) {
      if (historical) {
        return readHistoricalSessionOperationsTail(historical, undefined, 1000).items;
      }
      return this.buildLegacyOperations(input.sessionId);
    }
    try {
      const rebuilt = nativeRebuildTestSessionOperations(input.sessionId);
      const sessionDir = historical?.sessionDir
        || this.findHistoricalSession(input.sessionId)?.sessionDir
        || '';
      if (sessionDir) {
        return applyAndPersistHistoricalOperationAliases(sessionDir, rebuilt || []) as typeof rebuilt;
      }
      return rebuilt;
    } catch (error) {
      if (historical) {
        return readHistoricalSessionOperationsTail(historical, undefined, 1000).items;
      }
      throw error;
    }
  }

  public updateSessionOperation(
    input: ReqCaseShadowRecorderTestSessionOperationUpdateInput,
  ): ReqCaseShadowRecorderTestSessionOperationRecord {
    const historical = this.findHistoricalSession(input.sessionId);
    if (input.sessionId && historical && !this.isNativeSessionKnown(historical.sessionId)) {
      throw new Error('operation update unavailable: historical disk session is opened read-only.');
    }

    try {
      if (hasTestSessionOperationUpdateApi()) {
        return nativeUpdateTestSessionOperation(input);
      }
    } catch (error) {
      if (historical) {
        throw new Error('operation update unavailable: historical disk session is opened read-only.');
      }
      throw error;
    }

    const summary = input.resultSummary ?? input.note;
    if (input.title === undefined && summary === undefined) {
      throw new Error(
        'operation update unavailable: legacy steps adapter can only persist title/resultSummary/note fields.',
      );
    }

    const updatedStep = this.updateTestSessionStep({
      sessionId: input.sessionId,
      stepId: input.operationId,
      title: input.title,
      summary,
    });
    return this.toLegacyOperationRecord(updatedStep, input.sessionId, 0);
  }

  public updateTestSessionStep(input: any = {}) {
    return nativeUpdateTestSessionStep(input);
  }

  public setSemanticAliasProfile(profile?: any) {
    return nativeSetSemanticAliasProfile(profile ?? null);
  }

  public getSemanticAliasProfile() {
    return nativeGetSemanticAliasProfile();
  }

  resolveSemanticProfileActivePath(): string {
    return path.join(app.getPath('userData'), 'semantic-profiles', 'active.json');
  }

  loadSemanticProfile(profilePath: string) {
    return nativeLoadSemanticProfile(profilePath);
  }

  /**
   * Import a profile file: validate via native load, copy into userData, return normalized JSON.
   */
  importSemanticProfileFromPath(sourcePath: string): {
    profileJson: string;
    profile: Record<string, unknown>;
    activePath: string;
  } {
    const profileJson = nativeLoadSemanticProfile(sourcePath);
    const profile = JSON.parse(profileJson) as Record<string, unknown>;
    const activePath = this.resolveSemanticProfileActivePath();
    mkdirSync(path.dirname(activePath), { recursive: true });
    writeFileSync(activePath, JSON.stringify(profile, null, 2), 'utf-8');
    // Reload from managed copy so runtime always pins to userData path.
    nativeLoadSemanticProfile(activePath);
    return {
      profileJson: nativeGetSemanticProfileJson() ?? profileJson,
      profile,
      activePath,
    };
  }

  restoreSemanticProfileObject(profile: Record<string, unknown>): string {
    const activePath = this.resolveSemanticProfileActivePath();
    mkdirSync(path.dirname(activePath), { recursive: true });
    writeFileSync(activePath, JSON.stringify(profile, null, 2), 'utf-8');
    return nativeLoadSemanticProfile(activePath);
  }

  getSemanticProfileJson() {
    return nativeGetSemanticProfileJson();
  }

  clearSemanticProfile() {
    nativeClearSemanticProfile();
    try {
      const activePath = this.resolveSemanticProfileActivePath();
      if (existsSync(activePath)) {
        unlinkSync(activePath);
      }
    } catch {
      // best-effort cleanup of managed copy
    }
  }

  /**
   * Activate profile from JSON content (profile object or elements_selected array) and pin managed copy.
   */
  setSemanticProfileJson(content: string): {
    profileJson: string;
    profile: Record<string, unknown>;
    activePath: string;
  } {
    const profileJson = nativeSetSemanticProfileJson(content);
    const profile = JSON.parse(profileJson) as Record<string, unknown>;
    const activePath = this.resolveSemanticProfileActivePath();
    mkdirSync(path.dirname(activePath), { recursive: true });
    writeFileSync(activePath, JSON.stringify(profile, null, 2), 'utf-8');
    nativeLoadSemanticProfile(activePath);
    return {
      profileJson: nativeGetSemanticProfileJson() ?? profileJson,
      profile,
      activePath,
    };
  }

  saveSemanticProfileObject(profile: Record<string, unknown>): {
    profileJson: string;
    profile: Record<string, unknown>;
    activePath: string;
  } {
    return this.setSemanticProfileJson(JSON.stringify(profile));
  }

  public markTestDefect(input: {
    sessionId?: string;
    note?: string;
    expected?: string;
    actual?: string;
    markedAtMs?: number;
    preWindowSeconds?: number;
    postWindowSeconds?: number;
  } = {}) {
    // Always forward sessionId so stopped sessions can be marked without requiring active recording.
    return nativeMarkTestDefect({
      sessionId: input.sessionId,
      note: input.note,
      expected: input.expected,
      actual: input.actual,
      markedAtMs: input.markedAtMs,
      preWindowSeconds: input.preWindowSeconds,
      postWindowSeconds: input.postWindowSeconds,
    });
  }

  private resolveManagedSessionDir(sessionId: string): string | null {
    const nativeMatch = this.getNativeSessionsSafe().find((session) => session.sessionId === sessionId);
    const historical = this.findHistoricalSession(sessionId);
    const sessionDir = nativeMatch?.sessionDir || historical?.sessionDir || '';
    if (!sessionDir) {
      return null;
    }
    const resolved = path.resolve(sessionDir);
    if (!this.isWithinRoot(this.resolveTestSessionsRoot(), resolved)) {
      return null;
    }
    return resolved;
  }

  public purgeTestSessionEvents(sessionId?: string): { sessionId: string; cleared: boolean } {
    const id = sessionId?.trim();
    if (!id) {
      throw new Error('sessionId is required');
    }
    const sessionDir = this.resolveManagedSessionDir(id);
    if (!sessionDir) {
      return { sessionId: id, cleared: false };
    }
    const eventsPath = path.join(sessionDir, 'events.ndjson');
    if (existsSync(eventsPath)) {
      writeFileSync(eventsPath, '');
    }
    return { sessionId: id, cleared: true };
  }

  public deleteTestSession(sessionId?: string): { sessionId: string; deleted: boolean } {
    const id = sessionId?.trim();
    if (!id) {
      throw new Error('sessionId is required');
    }
    try {
      const active = getActiveTestSession();
      if (active?.sessionId === id && active.status !== 'stopped') {
        throw new Error('不能删除当前录制会话，请先停止录制');
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('不能删除当前录制会话')) {
        throw error;
      }
    }
    const sessionDir = this.resolveManagedSessionDir(id);
    if (!sessionDir || !existsSync(sessionDir)) {
      return { sessionId: id, deleted: false };
    }
    rmSync(sessionDir, { recursive: true, force: true });
    return { sessionId: id, deleted: true };
  }

  public deleteTestSessions(sessionIds: string[]): { deleted: string[]; skipped: string[] } {
    const deleted: string[] = [];
    const skipped: string[] = [];
    for (const sessionId of sessionIds) {
      try {
        const result = this.deleteTestSession(sessionId);
        if (result.deleted) {
          deleted.push(result.sessionId);
        } else {
          skipped.push(sessionId);
        }
      } catch {
        skipped.push(sessionId);
      }
    }
    return { deleted, skipped };
  }

  public getTestSessionSteps(sessionId?: any, limit?: number) {
    const resolvedSessionId = sessionId && typeof sessionId === 'object'
      ? sessionId.sessionId ?? sessionId.session_id
      : typeof sessionId === 'string'
        ? sessionId
        : undefined;
    const resolvedLimit = sessionId && typeof sessionId === 'object'
      ? sessionId.limit ?? limit
      : limit;
    const historical = this.findHistoricalSession(resolvedSessionId);
    if (resolvedSessionId && historical && !this.isNativeSessionKnown(historical.sessionId)) {
      return readHistoricalSessionSteps(historical, resolvedLimit);
    }

    try {
      if (sessionId && typeof sessionId === 'object') {
        return nativeGetTestSessionSteps(sessionId.sessionId ?? sessionId.session_id, sessionId.limit ?? limit) ?? [];
      }
      return nativeGetTestSessionSteps(sessionId, limit) ?? [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (historical) {
        return readHistoricalSessionSteps(historical, resolvedLimit);
      }
      if (/not active|SessionNotFound|no active|not found/i.test(message)) {
        return [];
      }
      throw error;
    }
  }

  public rebuildTestSessionSteps(sessionId?: string) {
    return nativeRebuildTestSessionSteps(sessionId);
  }

  public renderTestSessionReproSteps(
    sessionId?: string,
    windowStartMs?: number,
    windowEndMs?: number,
    defectNote?: string,
  ) {
    const historical = this.findHistoricalSession(sessionId);
    if (sessionId && historical && !this.isNativeSessionKnown(historical.sessionId)) {
      return renderHistoricalReproSteps(historical, windowStartMs, windowEndMs, defectNote);
    }

    try {
      return nativeRenderTestSessionReproSteps(sessionId, windowStartMs, windowEndMs, defectNote);
    } catch (error) {
      if (historical) {
        return renderHistoricalReproSteps(historical, windowStartMs, windowEndMs, defectNote);
      }
      throw error;
    }
  }

  public exportTestDefectPack(input: {
    sessionId?: string;
    targetDir?: string;
    markedAtMs?: number;
    preWindowSeconds?: number;
    postWindowSeconds?: number;
    note?: string;
    expected?: string;
    actual?: string;
  }) {
    return nativeExportTestDefectPack(input);
  }

  public async exportSessionEvidence(
    input: ReqCaseShadowRecorderTestSessionEvidenceExportInput,
  ): Promise<ReqCaseShadowRecorderTestSessionEvidenceExportResult> {
    const sessions = this.listSessions();
    const session = input.sessionId
      ? sessions.find((candidate) => candidate.sessionId === input.sessionId)
      : this.getActiveSession() ?? sessions[0];

    if (!session) {
      throw new Error('No recording session is available for evidence export.');
    }

    const targetDir = this.resolveEvidenceExportDir(input.targetDir);
    return exportTestSessionEvidence(
      {
        ...input,
        sessionId: session.sessionId,
        targetDir,
      },
      {
        session,
        events: this.getSessionEvents(session.sessionId),
        videoStreams: this.getSessionVideoStreams(session.sessionId),
        videoSegments: this.getSessionVideoSegments(session.sessionId, undefined, undefined),
      },
    );
  }

  public setConfig(config: ReqCaseShadowRecorderConfig): void {
    const previousVideoConfig = {
      recordingProfile: this.currentConfig.recordingProfile ?? 'balanced',
      encoderPreference: this.currentConfig.encoderPreference ?? 'auto',
      showMouseInVideo: this.currentConfig.showMouseInVideo ?? false,
    };
    const nextVideoConfig = {
      recordingProfile: config.recordingProfile ?? 'balanced',
      encoderPreference: config.encoderPreference ?? 'auto',
      showMouseInVideo: config.showMouseInVideo ?? false,
    };

    this.currentConfig = config;
    setRecorderConfig(config);

    if (
      previousVideoConfig.recordingProfile !== nextVideoConfig.recordingProfile ||
      previousVideoConfig.encoderPreference !== nextVideoConfig.encoderPreference ||
      previousVideoConfig.showMouseInVideo !== nextVideoConfig.showMouseInVideo
    ) {
      updateActiveTestSessionVideoConfig(nextVideoConfig);
    }
  }

  private attachStructuredStepContext(
    step: ReqCaseShadowRecorderStep,
  ): ReqCaseShadowRecorderStep {
    return {
      ...step,
      structuredContext: buildStructuredStepContext(step),
    };
  }

  private attachStructuredEventContext(
    event: ReqCaseShadowRecorderTestSessionTimelineEvent,
  ): ReqCaseShadowRecorderTestSessionTimelineEvent {
    const structuredContext = buildStructuredStepContextFromEvent(event);
    if (!structuredContext) {
      return event;
    }

    return {
      ...event,
      structuredContext,
    };
  }

  public clearBuffer(): void {
    clearRecorderBuffer();
  }

  public getBuffer(): ReqCaseShadowRecorderStep[] {
    return getRecorderBuffer().map((step) => this.attachStructuredStepContext(step));
  }

  public getBufferSince(lastId: string): ReqCaseShadowRecorderStep[] {
    return getRecorderBufferSince(lastId).map((step) => this.attachStructuredStepContext(step));
  }

  public getBufferPage(
    cursor: string,
    limit: number,
    includeImage: boolean,
  ): ReqCaseShadowRecorderStep[] {
    return getRecorderBufferPage(cursor, limit, includeImage)
      .map((step) => this.attachStructuredStepContext(step));
  }

  public getStepImage(stepId: string, variant: 'thumb' | 'full' = 'full'): string | null {
    return getRecorderStepImage(stepId, variant);
  }

  public setPushPublisher(publisher: (step: ReqCaseShadowRecorderStep) => void): void {
    this.pushPublisher = publisher;
  }

  public subscribePush(
    streamPayloadOverride?: ReqCaseShadowRecorderConfig['streamPayload'],
  ): void {
    if (this.pushBound || !this.pushPublisher) {
      return;
    }

    const publisher = this.pushPublisher;
    const streamPayload = streamPayloadOverride ?? this.currentConfig.streamPayload ?? 'meta_only';
    subscribeRecorderStepsV2({ streamPayload }, (step) => {
      publisher(this.attachStructuredStepContext(step));
    });
    this.pushBound = true;
  }

  public unsubscribePush(): void {
    if (!this.pushBound) {
      return;
    }

    unsubscribeRecorderSteps();
    this.pushBound = false;
  }

  public getMetrics(): ReqCaseShadowRecorderMetrics {
    return getRecorderMetrics();
  }

  public isNativeLoaded(): boolean {
    return isNativeBindingLoaded();
  }

  public async getRuntimeHealth(): Promise<ReqCaseShadowRecorderRuntimeHealth> {
    const paused = this.isPaused();
    const resourceUsage = await this.resourceUsageMonitor.getSnapshot(this.isRecording() && !paused);
    return buildRuntimeHealthSnapshot({
      recording: this.isRecording(),
      paused,
      config: this.currentConfig,
      metrics: this.getMetrics(),
      resourceUsage,
    });
  }

  public generateReplaySteps(
    input: ReqCaseShadowRecorderReplayStepGenerateInput,
  ): Promise<ReqCaseShadowRecorderReplayStepGenerateResult> {
    const providerName = input.provider ?? this.currentConfig.aiReplayProvider ?? 'disabled';
    const provider = providerName === 'mock'
      ? createMockReplayStepProvider()
      : providerName === 'openai_compatible'
        ? createOpenAiCompatibleReplayStepProvider({
          baseUrl: input.openAiCompatible?.baseUrl ?? this.currentConfig.aiReplayOpenAiBaseUrl ?? '',
          apiKey: input.openAiCompatible?.apiKey ?? this.currentConfig.aiReplayOpenAiApiKey,
          model: input.openAiCompatible?.model ?? this.currentConfig.aiReplayOpenAiModel ?? '',
          timeoutMs: input.openAiCompatible?.timeoutMs ?? this.currentConfig.aiReplayOpenAiTimeoutMs ?? 30_000,
        })
        : createDisabledReplayStepProvider();

    return provider.generate({
      contexts: input.contexts ?? [],
      aiEnabled: input.aiEnabled === true || this.currentConfig.aiReplayEnabled === true,
      privacyAcknowledgedAt: input.privacyAcknowledgedAt,
    });
  }

  public async exportReport(
    input: ReqCaseShadowRecorderExportInput,
  ): Promise<ReqCaseShadowRecorderExportResult> {
    const sessions = this.listSessions();
    const session = this.getActiveSession() ?? sessions[0];

    if (session) {
      const evidence = await this.exportSessionEvidence({
        sessionId: session.sessionId,
        targetDir: this.resolveEvidenceExportDir(input.targetDir),
        bundleName: input.title,
        outputMode: 'zip',
      });

      return {
        htmlPath: evidence.summaryHtmlPath ?? evidence.artifactPath,
        manifestPath: evidence.manifestPath ?? evidence.artifactPath,
        imageCount: evidence.stepEventCount ?? 0,
        sessionId: evidence.sessionId,
        outputMode: evidence.outputMode,
        bundleRootName: evidence.bundleRootName,
        artifactPath: evidence.artifactPath,
        zipPath: evidence.zipPath,
        exportDir: evidence.exportDir,
        sessionCopyDir: evidence.sessionCopyDir,
        summaryHtmlPath: evidence.summaryHtmlPath,
        operationsJsonPath: evidence.operationsJsonPath,
        operationsCsvPath: evidence.operationsCsvPath,
        checksumManifestPath: evidence.checksumManifestPath,
        checksumManifestRelativePath: evidence.checksumManifestRelativePath,
        checksumEntryCount: evidence.checksumEntryCount,
        artifactSha256Path: evidence.artifactSha256Path,
        artifactSha256: evidence.artifactSha256,
        generatedAtMs: evidence.generatedAtMs,
        eventCount: evidence.eventCount,
        stepEventCount: evidence.stepEventCount,
        videoStreamCount: evidence.videoStreamCount,
        videoSegmentCount: evidence.videoSegmentCount,
        playableVideoSegmentCount: evidence.playableVideoSegmentCount,
        copiedFileCount: evidence.copiedFileCount,
        copiedBytes: evidence.copiedBytes,
      };
    }

    const safeInput = this.buildSafeReportInput(input);
    return exportShadowRecorderReport(safeInput, this.getBuffer());
  }

  public buildSafeReportInput(input: ReqCaseShadowRecorderExportInput): ReqCaseShadowRecorderExportInput {
    return {
      ...input,
      targetDir: this.resolveSafeReportDir(input.targetDir),
    };
  }

  public async exportTuningSnapshot(
    input: ReqCaseShadowRecorderTuningSnapshotExportInput,
  ): Promise<ReqCaseShadowRecorderTuningSnapshotExportResult> {
    const safeInput = {
      ...input,
      targetDir: this.resolveSafeReportDir(input.targetDir),
    };

    try {
      return await exportTuningSnapshotInUtilityProcess(safeInput);
    } catch (utilityError) {
      console.warn('[utility-maintenance] fallback to main process tuning snapshot export:', utilityError);
      return exportTuningSnapshot(safeInput);
    }
  }
}
