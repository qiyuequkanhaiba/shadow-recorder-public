import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type {
  ReqCaseShadowRecorderStep,
  ReqCaseShadowRecorderTestSessionOperationRecord,
  ReqCaseShadowRecorderTestSessionOperationTailResult,
  ReqCaseShadowRecorderTestSessionState,
  ReqCaseShadowRecorderTestSessionTimelineEvent,
  ReqCaseShadowRecorderTestSessionTimelineEventTailResult,
  ReqCaseShadowRecorderTestSessionVideoSegment,
  ReqCaseShadowRecorderTestSessionVideoSegmentTailResult,
  ReqCaseShadowRecorderTestSessionVideoStream,
} from './types';

const CURRENT_OPERATION_SCHEMA_VERSION = 1;
const LEGACY_OPERATION_RESULT_SUMMARY = '旧记录未采集操作结果';

const SESSION_STATUSES = new Set(['active', 'paused', 'stopped']);
const RECORDING_PROFILES = new Set(['efficiency', 'balanced', 'smooth']);
const ENCODER_PREFERENCES = new Set(['auto', 'hardware', 'software']);
const TARGET_CAPTURE_MODES = new Set([
  'foreground_window',
  'target_window',
  'process_bind',
  'desktop',
  'target_display',
  'all_displays',
]);
const VIDEO_STREAM_STATUSES = new Set(['planned', 'active', 'stopped']);
const VIDEO_SEGMENT_STATUSES = new Set(['planned', 'ready', 'missing']);
const EVENT_TYPES = new Set([
  'session_started',
  'session_paused',
  'session_resumed',
  'session_stopped',
  'step_captured',
  'note_added',
  'app_log_added',
  'window_foreground_changed',
  'window_focus_changed',
  'window_shown',
  'window_hidden',
  'window_title_changed',
  'clipboard_updated',
]);
const LOG_CATEGORIES = new Set(['recording', 'system', 'operation', 'app']);
const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error']);

type TailItem = {
  id: string;
};

type OperationDiagnostic = NonNullable<ReqCaseShadowRecorderTestSessionOperationTailResult['diagnostics']>[number];

function asRecord(value: unknown): Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
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

function stringArrayValue(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const next = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return next.length > 0 ? next : undefined;
}

function stringChoice<T extends string>(
  record: Record<string, unknown>,
  key: string,
  choices: Set<string>,
  fallback: T,
): T {
  const value = stringValue(record, key);
  return value && choices.has(value) ? value as T : fallback;
}

function readJsonFile(filePath: string): unknown | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readNdjsonFile(filePath: string): unknown[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  const records: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      break;
    }
  }
  return records;
}

function toPosixRelative(value: string): string {
  return value.replace(/\\/g, '/');
}

function resolveSessionDir(session: ReqCaseShadowRecorderTestSessionState): string | null {
  if (!session.sessionDir) {
    return null;
  }
  return existsSync(session.sessionDir) ? path.resolve(session.sessionDir) : null;
}

function normalizeHistoricalSession(
  value: unknown,
  rootDir: string,
  sessionDir: string,
  manifestPath: string,
): ReqCaseShadowRecorderTestSessionState | null {
  const record = asRecord(value);
  const sessionId = stringValue(record, 'sessionId') ?? path.basename(sessionDir);
  if (!sessionId) {
    return null;
  }

  const fallbackTime = statSync(manifestPath).mtimeMs;
  const startedAtMs = numberValue(record, 'startedAtMs') ?? fallbackTime;
  const updatedAtMs = numberValue(record, 'updatedAtMs') ?? numberValue(record, 'endedAtMs') ?? startedAtMs;

  return {
    ...record,
    schemaVersion: 1,
    kind: 'reqcase.test-session',
    sessionId,
    name: stringValue(record, 'name'),
    status: stringChoice(record, 'status', SESSION_STATUSES, 'stopped'),
    startedAtMs,
    updatedAtMs,
    endedAtMs: numberValue(record, 'endedAtMs'),
    storageRootDir: stringValue(record, 'storageRootDir') ?? rootDir,
    sessionDir,
    manifestPath,
    bufferWindowSeconds: numberValue(record, 'bufferWindowSeconds') ?? 90,
    segmentDurationSeconds: numberValue(record, 'segmentDurationSeconds') ?? 5,
    recordingProfile: stringChoice(record, 'recordingProfile', RECORDING_PROFILES, 'balanced'),
    encoderPreference: stringChoice(record, 'encoderPreference', ENCODER_PREFERENCES, 'auto'),
    showMouseInVideo: booleanValue(record, 'showMouseInVideo') ?? false,
    notes: stringValue(record, 'notes'),
    targetProcessName: stringValue(record, 'targetProcessName'),
    targetPid: numberValue(record, 'targetPid'),
    targetHwnd: stringValue(record, 'targetHwnd'),
    targetDisplayId: stringValue(record, 'targetDisplayId'),
    targetDisplayIds: stringArrayValue(record, 'targetDisplayIds'),
    targetCaptureMode: stringChoice(record, 'targetCaptureMode', TARGET_CAPTURE_MODES, 'target_display'),
    historicalSource: 'disk-scan',
  };
}

export function readHistoricalTestSessionFromDir(
  rootDir: string,
  sessionDir: string,
): ReqCaseShadowRecorderTestSessionState | null {
  const resolvedSessionDir = path.resolve(sessionDir);
  const manifestPath = path.join(resolvedSessionDir, 'session.json');
  const manifest = readJsonFile(manifestPath);
  if (!manifest) {
    return null;
  }
  return normalizeHistoricalSession(manifest, path.resolve(rootDir), resolvedSessionDir, manifestPath);
}

export function listHistoricalTestSessions(
  rootDir: string,
  existingSessions: ReqCaseShadowRecorderTestSessionState[] = [],
): ReqCaseShadowRecorderTestSessionState[] {
  const resolvedRoot = path.resolve(rootDir);
  if (!existsSync(resolvedRoot)) {
    return [];
  }

  const existingIds = new Set(existingSessions.map((session) => session.sessionId));
  return readdirSync(resolvedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readHistoricalTestSessionFromDir(resolvedRoot, path.join(resolvedRoot, entry.name)))
    .filter((session): session is ReqCaseShadowRecorderTestSessionState =>
      !!session && !existingIds.has(session.sessionId))
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

export function findHistoricalTestSession(
  rootDir: string,
  sessionId?: string,
): ReqCaseShadowRecorderTestSessionState | null {
  const sessions = listHistoricalTestSessions(rootDir);
  if (!sessionId) {
    return sessions[0] ?? null;
  }
  return sessions.find((session) => session.sessionId === sessionId) ?? null;
}

function normalizeHistoricalEvent(
  value: unknown,
  session: ReqCaseShadowRecorderTestSessionState,
  index: number,
): ReqCaseShadowRecorderTestSessionTimelineEvent {
  const record = asRecord(value);
  const hasStepShape = !!stringValue(record, 'stepId') || !!stringValue(record, 'action');
  const occurredAtMs = numberValue(record, 'occurredAtMs') ?? numberValue(record, 'timestampMs') ?? session.startedAtMs;
  const eventType = stringChoice(
    record,
    'eventType',
    EVENT_TYPES,
    hasStepShape ? 'step_captured' : 'app_log_added',
  );

  return {
    ...record,
    schemaVersion: 1,
    kind: 'reqcase.test-session-event',
    eventId: stringValue(record, 'eventId') ?? stringValue(record, 'id') ?? `historical-event-${index + 1}`,
    sessionId: stringValue(record, 'sessionId') ?? session.sessionId,
    eventType,
    logCategory: stringChoice(record, 'logCategory', LOG_CATEGORIES, eventType === 'step_captured' ? 'operation' : 'app'),
    occurredAtMs,
    status: stringChoice(record, 'status', SESSION_STATUSES, session.status),
    stepId: stringValue(record, 'stepId'),
    action: stringValue(record, 'action'),
    x: numberValue(record, 'x'),
    y: numberValue(record, 'y'),
    logicalX: numberValue(record, 'logicalX'),
    logicalY: numberValue(record, 'logicalY'),
    displayId: stringValue(record, 'displayId'),
    processName: stringValue(record, 'processName'),
    windowTitle: stringValue(record, 'windowTitle'),
    title: stringValue(record, 'title'),
    message: stringValue(record, 'message'),
    logLevel: stringChoice(record, 'logLevel', LOG_LEVELS, 'info'),
    fullImagePath: stringValue(record, 'fullImagePath'),
    thumbImagePath: stringValue(record, 'thumbImagePath'),
  };
}

export function readHistoricalSessionEvents(
  session: ReqCaseShadowRecorderTestSessionState,
  limit?: number,
): ReqCaseShadowRecorderTestSessionTimelineEvent[] {
  const sessionDir = resolveSessionDir(session);
  if (!sessionDir) {
    return [];
  }
  const events = readNdjsonFile(path.join(sessionDir, 'events.ndjson'))
    .map((event, index) => normalizeHistoricalEvent(event, session, index))
    .sort((left, right) => left.occurredAtMs - right.occurredAtMs);
  return applyLimit(events, limit);
}

function normalizeHistoricalStep(
  value: unknown,
  session: ReqCaseShadowRecorderTestSessionState,
  index: number,
): Record<string, unknown> {
  const record = asRecord(value);
  const timestampMs = numberValue(record, 'timestampMs')
    ?? numberValue(record, 'startedAtMs')
    ?? numberValue(record, 'occurredAtMs')
    ?? session.startedAtMs;
  const id = stringValue(record, 'id') ?? stringValue(record, 'stepId') ?? `step-${session.sessionId}-${index + 1}`;
  const action = stringValue(record, 'action') ?? stringValue(record, 'stepType') ?? stringValue(record, 'title') ?? 'Legacy step';

  return {
    ...record,
    id,
    stepId: stringValue(record, 'stepId') ?? id,
    sessionId: stringValue(record, 'sessionId') ?? session.sessionId,
    timestampMs,
    startedAtMs: numberValue(record, 'startedAtMs') ?? timestampMs,
    endedAtMs: numberValue(record, 'endedAtMs') ?? timestampMs,
    action,
    title: stringValue(record, 'title') ?? stringValue(record, 'summary') ?? action,
    x: numberValue(record, 'x') ?? numberValue(record, 'logicalX') ?? 0,
    y: numberValue(record, 'y') ?? numberValue(record, 'logicalY') ?? 0,
    windowLeft: numberValue(record, 'windowLeft') ?? 0,
    windowTop: numberValue(record, 'windowTop') ?? 0,
    windowRight: numberValue(record, 'windowRight') ?? 0,
    windowBottom: numberValue(record, 'windowBottom') ?? 0,
    displayId: stringValue(record, 'displayId'),
    processName: stringValue(record, 'processName') ?? '',
    windowTitle: stringValue(record, 'windowTitle') ?? '',
    imageWebpBase64: stringValue(record, 'imageWebpBase64') ?? '',
    imageBytes: numberValue(record, 'imageBytes') ?? 0,
    fullImagePath: stringValue(record, 'fullImagePath'),
    thumbImagePath: stringValue(record, 'thumbImagePath'),
    edited: booleanValue(record, 'edited') ?? false,
    ignored: booleanValue(record, 'ignored') ?? false,
    businessAlias: stringValue(record, 'businessAlias'),
    manualNote: stringValue(record, 'manualNote') ?? stringValue(record, 'note'),
  };
}

export function readHistoricalSessionSteps(
  session: ReqCaseShadowRecorderTestSessionState,
  limit?: number,
): ReqCaseShadowRecorderStep[] {
  const sessionDir = resolveSessionDir(session);
  if (!sessionDir) {
    return [];
  }

  const storedSteps = readNdjsonFile(path.join(sessionDir, 'steps.ndjson'));
  const steps = storedSteps.length > 0
    ? storedSteps.map((step, index) => normalizeHistoricalStep(step, session, index))
    : readHistoricalSessionEvents(session)
      .filter((event) => event.eventType === 'step_captured')
      .map((event, index) => normalizeHistoricalStep({
        id: event.stepId ?? event.eventId,
        eventId: event.eventId,
        sessionId: event.sessionId,
        timestampMs: event.occurredAtMs,
        action: event.action,
        title: event.title ?? event.action,
        x: event.x,
        y: event.y,
        displayId: event.displayId,
        processName: event.processName,
        windowTitle: event.windowTitle,
        imageBytes: event.imageBytes,
        fullImagePath: event.fullImagePath,
        thumbImagePath: event.thumbImagePath,
      }, session, index));

  return applyLimit(steps as ReqCaseShadowRecorderStep[], limit);
}

function normalizeHistoricalVideoStream(
  value: unknown,
  session: ReqCaseShadowRecorderTestSessionState,
  index: number,
): ReqCaseShadowRecorderTestSessionVideoStream {
  const record = asRecord(value);
  const streamId = stringValue(record, 'streamId') ?? `vs-${index + 1}`;
  const startedAtMs = numberValue(record, 'startedAtMs') ?? session.startedAtMs;
  const updatedAtMs = numberValue(record, 'updatedAtMs') ?? session.updatedAtMs;

  return {
    ...record,
    schemaVersion: 1,
    kind: 'reqcase.test-session-video-stream',
    streamId,
    sessionId: stringValue(record, 'sessionId') ?? session.sessionId,
    label: stringValue(record, 'label') ?? stringValue(record, 'displayLabel') ?? streamId,
    status: stringChoice(record, 'status', VIDEO_STREAM_STATUSES, session.status === 'stopped' ? 'stopped' : 'active'),
    targetCaptureMode: stringChoice(record, 'targetCaptureMode', TARGET_CAPTURE_MODES, session.targetCaptureMode),
    displayId: stringValue(record, 'displayId'),
    displayLabel: stringValue(record, 'displayLabel'),
    width: numberValue(record, 'width'),
    height: numberValue(record, 'height'),
    startedAtMs,
    updatedAtMs,
    segmentDurationSeconds: numberValue(record, 'segmentDurationSeconds') ?? session.segmentDurationSeconds,
    segmentCount: numberValue(record, 'segmentCount') ?? 0,
    playableSegmentCount: numberValue(record, 'playableSegmentCount') ?? 0,
    pendingSegmentCount: numberValue(record, 'pendingSegmentCount') ?? 0,
    totalSegmentBytes: numberValue(record, 'totalSegmentBytes') ?? 0,
    retainedSegmentBytes: numberValue(record, 'retainedSegmentBytes') ?? 0,
    sampleIntervalMs: numberValue(record, 'sampleIntervalMs') ?? 250,
    targetFps: numberValue(record, 'targetFps') ?? 4,
    encoderAvailable: booleanValue(record, 'encoderAvailable') ?? true,
    warningCount: numberValue(record, 'warningCount') ?? 0,
    streamDir: stringValue(record, 'streamDir'),
    manifestPath: stringValue(record, 'manifestPath'),
  };
}

export function readHistoricalSessionVideoStreams(
  session: ReqCaseShadowRecorderTestSessionState,
): ReqCaseShadowRecorderTestSessionVideoStream[] {
  const sessionDir = resolveSessionDir(session);
  if (!sessionDir) {
    return [];
  }
  const value = readJsonFile(path.join(sessionDir, 'video', 'streams.json'));
  const streams = Array.isArray(value)
    ? value.map((stream, index) => normalizeHistoricalVideoStream(stream, session, index))
    : [];
  if (streams.length > 0) {
    return streams;
  }

  const segments = readHistoricalSessionVideoSegments(session);
  const streamIds = [...new Set(segments.map((segment) => segment.streamId))];
  return streamIds.map((streamId, index) => normalizeHistoricalVideoStream({
    streamId,
    label: streamId,
    status: 'stopped',
    segmentCount: segments.filter((segment) => segment.streamId === streamId).length,
    playableSegmentCount: segments.filter((segment) => segment.streamId === streamId && segment.isPlayable).length,
  }, session, index));
}

function normalizeHistoricalVideoSegment(
  value: unknown,
  session: ReqCaseShadowRecorderTestSessionState,
  index: number,
): ReqCaseShadowRecorderTestSessionVideoSegment {
  const record = asRecord(value);
  const sessionDir = resolveSessionDir(session) ?? '';
  const relativePath = stringValue(record, 'relativePath');
  const rawFilePath = stringValue(record, 'filePath');
  const filePath = rawFilePath
    ? path.resolve(sessionDir, rawFilePath)
    : relativePath
      ? path.resolve(sessionDir, relativePath)
      : undefined;
  const fileStats = filePath ? statSafe(filePath) : null;
  const startedAtMs = numberValue(record, 'startedAtMs') ?? session.startedAtMs;
  const durationMs = numberValue(record, 'durationMs') ?? 0;
  const endedAtMs = numberValue(record, 'endedAtMs') ?? startedAtMs + durationMs;
  const status = stringChoice(record, 'status', VIDEO_SEGMENT_STATUSES, fileStats?.isFile() ? 'ready' : 'missing');

  return {
    ...record,
    schemaVersion: 1,
    kind: 'reqcase.test-session-video-segment',
    segmentId: stringValue(record, 'segmentId') ?? `segment-${index + 1}`,
    sessionId: stringValue(record, 'sessionId') ?? session.sessionId,
    streamId: stringValue(record, 'streamId') ?? 'vs-primary',
    status,
    displayId: stringValue(record, 'displayId'),
    startedAtMs,
    endedAtMs,
    durationMs: numberValue(record, 'durationMs') ?? Math.max(0, endedAtMs - startedAtMs),
    relativePath: relativePath ? toPosixRelative(relativePath) : undefined,
    filePath,
    manifestPath: stringValue(record, 'manifestPath'),
    sizeBytes: numberValue(record, 'sizeBytes') ?? fileStats?.size,
    frameCount: numberValue(record, 'frameCount'),
    codec: stringValue(record, 'codec'),
    container: stringValue(record, 'container') ?? (filePath ? path.extname(filePath).replace(/^\./, '') : undefined),
    mimeType: stringValue(record, 'mimeType'),
    encoderName: stringValue(record, 'encoderName'),
    isPlayable: booleanValue(record, 'isPlayable') ?? (status === 'ready' && !!fileStats?.isFile()),
  };
}

export function readHistoricalSessionVideoSegments(
  session: ReqCaseShadowRecorderTestSessionState,
  streamId?: string,
  limit?: number,
): ReqCaseShadowRecorderTestSessionVideoSegment[] {
  const sessionDir = resolveSessionDir(session);
  if (!sessionDir) {
    return [];
  }
  const segments = readNdjsonFile(path.join(sessionDir, 'video', 'segments.ndjson'))
    .map((segment, index) => normalizeHistoricalVideoSegment(segment, session, index))
    .filter((segment) => !streamId || segment.streamId === streamId)
    .sort((left, right) => left.startedAtMs - right.startedAtMs);
  return applyLimit(segments, limit);
}

export function readHistoricalSessionEventsTail(
  session: ReqCaseShadowRecorderTestSessionState,
  afterEventId?: string,
  limit?: number,
): ReqCaseShadowRecorderTestSessionTimelineEventTailResult {
  const events = readHistoricalSessionEvents(session);
  return buildTailResult(
    events.map((event) => ({ id: event.eventId, item: event })),
    afterEventId,
    limit,
  );
}

export function readHistoricalSessionVideoSegmentsTail(
  session: ReqCaseShadowRecorderTestSessionState,
  streamId?: string,
  afterSegmentId?: string,
  limit?: number,
): ReqCaseShadowRecorderTestSessionVideoSegmentTailResult {
  const segments = readHistoricalSessionVideoSegments(session, streamId);
  return buildTailResult(
    segments.map((segment) => ({ id: segment.segmentId, item: segment })),
    afterSegmentId,
    limit,
  );
}

export function findHistoricalVideoSegmentsForTimestamp(
  session: ReqCaseShadowRecorderTestSessionState,
  occurredAtMs?: number,
  displayId?: string,
  limit?: number,
): ReqCaseShadowRecorderTestSessionVideoSegment[] {
  const MAX_MATCH_DISTANCE_MS = 3_000;
  const timestamp = occurredAtMs ?? Date.now();
  return readHistoricalSessionVideoSegments(session)
    .map((segment) => {
      const distanceMs =
        timestamp < segment.startedAtMs
          ? segment.startedAtMs - timestamp
          : timestamp > segment.endedAtMs
            ? timestamp - segment.endedAtMs
            : 0;
      const displayPenalty =
        displayId && segment.displayId && segment.displayId !== displayId ? 1 : 0;
      return { segment, distanceMs, displayPenalty };
    })
    .filter((entry) => entry.distanceMs <= MAX_MATCH_DISTANCE_MS)
    .sort((left, right) =>
      left.displayPenalty - right.displayPenalty
      || left.distanceMs - right.distanceMs
      || right.segment.startedAtMs - left.segment.startedAtMs)
    .slice(0, limit ?? 8)
    .map((entry) => entry.segment);
}

function mapHistoricalOperationActionKind(action?: string): ReqCaseShadowRecorderTestSessionOperationRecord['action']['kind'] {
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

function adaptHistoricalStepToOperation(
  step: unknown,
  sessionId: string | undefined,
  index: number,
): ReqCaseShadowRecorderTestSessionOperationRecord {
  const record = asRecord(step);
  const stepId = stringValue(record, 'id') ?? stringValue(record, 'stepId') ?? `legacy-step-${index + 1}`;
  const operationId = stringValue(record, 'operationId') ?? stepId;
  const occurredAtMs = numberValue(record, 'timestampMs')
    ?? numberValue(record, 'occurredAtMs')
    ?? numberValue(record, 'startedAtMs')
    ?? Date.now();
  const endedAtMs = numberValue(record, 'endedAtMs') ?? occurredAtMs;
  const actionText = stringValue(record, 'action') ?? stringValue(record, 'title') ?? 'Legacy step';
  const title = stringValue(record, 'title') ?? actionText;
  const x = numberValue(record, 'x') ?? numberValue(record, 'logicalX');
  const y = numberValue(record, 'y') ?? numberValue(record, 'logicalY');
  const windowTitle = stringValue(record, 'windowTitle');
  const processName = stringValue(record, 'processName');
  const windowHwnd = stringValue(record, 'windowHwnd');
  const resultSummary = stringValue(record, 'resultSummary') ?? LEGACY_OPERATION_RESULT_SUMMARY;
  const sourceId = stringValue(record, 'eventId') ?? stepId;

  return {
    schemaVersion: 1,
    kind: 'reqcase.test-session-operation',
    operationId,
    sessionId: stringValue(record, 'sessionId') ?? sessionId ?? '',
    sequence: numberValue(record, 'sequence') ?? index + 1,
    startedAtMs: occurredAtMs,
    endedAtMs,
    relativeMsFromSessionStart: numberValue(record, 'relativeMsFromSessionStart') ?? 0,
    action: {
      actionId: stringValue(record, 'actionId') ?? `legacy-action-${operationId}`,
      kind: mapHistoricalOperationActionKind(actionText),
      occurredAtMs,
      endedAtMs,
      target: windowTitle || processName || windowHwnd
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
      coordinate: x !== undefined && y !== undefined
        ? { x, y, displayId: stringValue(record, 'displayId') ?? null }
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
      artifactRef: stringValue(record, 'fullImagePath') ?? stringValue(record, 'thumbImagePath') ?? null,
      videoRange: null,
      reasonCode: 'legacy-step-adapter',
    }],
    title,
    resultSummary,
    displaySummary: title === resultSummary ? title : `${title} -> ${resultSummary}`,
    precisionLevel: 'legacy-step-adapter',
    outcomeSelectionSource: 'auto',
    edited: booleanValue(record, 'edited') ?? false,
    ignored: booleanValue(record, 'ignored') ?? false,
    businessAlias: stringValue(record, 'businessAlias') ?? null,
    manualNote: stringValue(record, 'manualNote') ?? stringValue(record, 'note') ?? null,
  };
}

function normalizeOperationRecord(
  value: unknown,
  sessionId: string,
  index: number,
): ReqCaseShadowRecorderTestSessionOperationRecord {
  const record = asRecord(value);
  const actionRecord = asRecord(record.action);
  const outcomeRecord = asRecord(record.outcome);
  const startedAtMs = numberValue(record, 'startedAtMs') ?? numberValue(actionRecord, 'occurredAtMs') ?? Date.now();
  const endedAtMs = numberValue(record, 'endedAtMs') ?? numberValue(outcomeRecord, 'observedAtMs') ?? startedAtMs;
  const operationId = stringValue(record, 'operationId') ?? stringValue(record, 'id') ?? `operation-historical-${index + 1}`;
  const title = stringValue(record, 'title') ?? stringValue(actionRecord, 'kind') ?? 'Historical operation';
  const resultSummary = stringValue(record, 'resultSummary')
    ?? stringValue(outcomeRecord, 'summary')
    ?? LEGACY_OPERATION_RESULT_SUMMARY;

  return {
    ...record,
    schemaVersion: 1,
    kind: 'reqcase.test-session-operation',
    operationId,
    sessionId: stringValue(record, 'sessionId') ?? sessionId,
    sequence: numberValue(record, 'sequence') ?? index + 1,
    startedAtMs,
    endedAtMs,
    relativeMsFromSessionStart: numberValue(record, 'relativeMsFromSessionStart') ?? 0,
    action: {
      ...actionRecord,
      actionId: stringValue(actionRecord, 'actionId') ?? `action-${operationId}`,
      kind: (stringValue(actionRecord, 'kind') as ReqCaseShadowRecorderTestSessionOperationRecord['action']['kind'] | undefined)
        ?? mapHistoricalOperationActionKind(title),
      occurredAtMs: numberValue(actionRecord, 'occurredAtMs') ?? startedAtMs,
      endedAtMs: numberValue(actionRecord, 'endedAtMs') ?? endedAtMs,
      target: (actionRecord.target as ReqCaseShadowRecorderTestSessionOperationRecord['action']['target'] | undefined) ?? null,
      stateBefore: (actionRecord.stateBefore as ReqCaseShadowRecorderTestSessionOperationRecord['action']['stateBefore'] | undefined) ?? null,
      coordinate: (actionRecord.coordinate as ReqCaseShadowRecorderTestSessionOperationRecord['action']['coordinate'] | undefined) ?? null,
      sourceEventIds: stringArrayValue(actionRecord, 'sourceEventIds') ?? [],
      targetReasonCodes: stringArrayValue(actionRecord, 'targetReasonCodes') ?? ['historical-operation-adapter'],
      confidence: asRecord(actionRecord.confidence),
    },
    outcome: {
      ...outcomeRecord,
      outcomeId: stringValue(outcomeRecord, 'outcomeId') ?? `outcome-${operationId}`,
      status: (stringValue(outcomeRecord, 'status') as ReqCaseShadowRecorderTestSessionOperationRecord['outcome']['status'] | undefined)
        ?? 'legacyUnknown',
      summary: stringValue(outcomeRecord, 'summary') ?? resultSummary,
      observedAtMs: numberValue(outcomeRecord, 'observedAtMs') ?? endedAtMs,
      latencyMs: numberValue(outcomeRecord, 'latencyMs') ?? Math.max(0, endedAtMs - startedAtMs),
      primaryTransitionId: stringValue(outcomeRecord, 'primaryTransitionId') ?? null,
      candidateTransitionIds: stringArrayValue(outcomeRecord, 'candidateTransitionIds') ?? [],
      reasonCodes: stringArrayValue(outcomeRecord, 'reasonCodes') ?? ['historical-operation-adapter'],
      confidence: asRecord(outcomeRecord.confidence),
    },
    completionCandidates: Array.isArray(record.completionCandidates) ? record.completionCandidates as any : [],
    transitions: Array.isArray(record.transitions) ? record.transitions as any : [],
    evidence: Array.isArray(record.evidence) ? record.evidence as any : [],
    title,
    resultSummary,
    displaySummary: stringValue(record, 'displaySummary') ?? (title === resultSummary ? title : `${title} -> ${resultSummary}`),
    precisionLevel: stringValue(record, 'precisionLevel') ?? 'historical-operation-adapter',
    outcomeSelectionSource: (stringValue(record, 'outcomeSelectionSource') as ReqCaseShadowRecorderTestSessionOperationRecord['outcomeSelectionSource'] | undefined)
      ?? 'auto',
    edited: booleanValue(record, 'edited') ?? false,
    ignored: booleanValue(record, 'ignored') ?? false,
    businessAlias: stringValue(record, 'businessAlias') ?? null,
    manualNote: stringValue(record, 'manualNote') ?? null,
  };
}

export function readHistoricalSessionOperationsTail(
  session: ReqCaseShadowRecorderTestSessionState,
  cursor?: string,
  limit?: number,
): ReqCaseShadowRecorderTestSessionOperationTailResult {
  const sessionDir = resolveSessionDir(session);
  if (!sessionDir) {
    return { items: [], reset: true, totalCount: 0, diagnostics: [] };
  }

  const operationsPath = path.join(sessionDir, 'operations.ndjson');
  const operations: ReqCaseShadowRecorderTestSessionOperationRecord[] = [];
  const diagnostics: OperationDiagnostic[] = [];
  if (existsSync(operationsPath)) {
    const lines = readFileSync(operationsPath, 'utf8').split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        const record = asRecord(parsed);
        const schemaVersion = numberValue(record, 'schemaVersion') ?? CURRENT_OPERATION_SCHEMA_VERSION;
        if (schemaVersion > CURRENT_OPERATION_SCHEMA_VERSION) {
          diagnostics.push({
            code: 'futureSchema',
            severity: 'warning',
            lineNumber: index + 1,
            schemaVersion,
            message: `operation line ${index + 1} uses future schemaVersion ${schemaVersion}; opened read-only`,
          });
          operations.push(parsed as ReqCaseShadowRecorderTestSessionOperationRecord);
          continue;
        }
        if (schemaVersion < CURRENT_OPERATION_SCHEMA_VERSION) {
          diagnostics.push({
            code: 'legacySchema',
            severity: 'info',
            lineNumber: index + 1,
            schemaVersion,
            message: `operation line ${index + 1} uses legacy schemaVersion ${schemaVersion}; adapted in memory`,
          });
        }
        operations.push(normalizeOperationRecord(parsed, session.sessionId, operations.length));
      } catch (error) {
        diagnostics.push({
          code: 'corruptTail',
          severity: 'warning',
          lineNumber: index + 1,
          message: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
  }

  const finalOperations = operations.length > 0
    ? operations
    : readHistoricalSessionSteps(session)
      .map((step, index) => adaptHistoricalStepToOperation(step, session.sessionId, index));

  const finalDiagnostics = operations.length > 0 || finalOperations.length === 0
    ? diagnostics
    : [
      ...diagnostics,
      {
        code: 'legacyStepsAdapter',
        severity: 'info',
        message: '旧会话只有 steps 记录，已按 legacyUnknown 操作结果只读适配。',
      },
    ];

  return {
    ...buildTailResult(
      finalOperations.map((operation) => ({ id: operation.operationId, item: operation })),
      cursor,
      limit,
    ),
    diagnostics: finalDiagnostics,
  };
}

export function renderHistoricalReproSteps(
  session: ReqCaseShadowRecorderTestSessionState,
  windowStartMs?: number,
  windowEndMs?: number,
  defectNote?: string,
): string {
  const operationsTail = readHistoricalSessionOperationsTail(session, undefined, 10_000);
  const operations = (operationsTail.items ?? []).filter((operation) => {
    if (operation.ignored) {
      return false;
    }
    if (windowStartMs !== undefined && operation.startedAtMs < windowStartMs) {
      return false;
    }
    if (windowEndMs !== undefined && operation.startedAtMs > windowEndMs) {
      return false;
    }
    return true;
  });

  const title = session.name?.trim() || session.sessionId;
  const lines = [`# ${title} 复现步骤`, ''];
  if (defectNote?.trim()) {
    lines.push(`缺陷备注：${defectNote.trim()}`, '');
  }

  if (operations.length > 0) {
    for (const [index, operation] of operations.entries()) {
      const status = operation.outcome?.status ?? 'incomplete';
      const latency =
        typeof operation.outcome?.latencyMs === 'number'
          ? `，耗时 ${operation.outcome.latencyMs}ms`
          : '';
      const result =
        status === 'confirmed' || status === 'candidate'
          ? operation.resultSummary || operation.outcome?.summary || status
          : status === 'ambiguous'
            ? '观测到多个可能结果，需人工确认'
            : status === 'observerDegraded'
              ? 'UIA 观测降级，无法判断结果'
              : status === 'legacyUnknown'
                ? LEGACY_OPERATION_RESULT_SUMMARY
                : '未观测到明确结果';
      lines.push(`${index + 1}. ${operation.title} -> ${result}${latency}`);
    }
    return lines.join('\n');
  }

  const steps = readHistoricalSessionSteps(session)
    .filter((step) => {
      const record = asRecord(step);
      const timestampMs = numberValue(record, 'timestampMs') ?? numberValue(record, 'startedAtMs') ?? 0;
      if (windowStartMs !== undefined && timestampMs < windowStartMs) {
        return false;
      }
      if (windowEndMs !== undefined && timestampMs > windowEndMs) {
        return false;
      }
      return true;
    });

  if (steps.length === 0) {
    lines.push('没有可用步骤。');
    return lines.join('\n');
  }

  for (const [index, step] of steps.entries()) {
    const record = asRecord(step);
    const action = stringValue(record, 'title') ?? stringValue(record, 'action') ?? `步骤 ${index + 1}`;
    const target = [stringValue(record, 'windowTitle'), stringValue(record, 'processName')]
      .filter((value): value is string => !!value)
      .join(' / ');
    lines.push(
      `${index + 1}. ${target ? `${action}（${target}）` : action} -> ${LEGACY_OPERATION_RESULT_SUMMARY}`,
    );
  }
  return lines.join('\n');
}

function statSafe(filePath: string): { size: number; isFile: () => boolean } | null {
  try {
    const stats = statSync(filePath);
    return {
      size: Number(stats.size),
      isFile: () => stats.isFile(),
    };
  } catch {
    return null;
  }
}

function applyLimit<T>(items: T[], limit?: number): T[] {
  if (limit === undefined) {
    return items;
  }
  if (limit <= 0) {
    return [];
  }
  if (items.length <= limit) {
    return items;
  }
  return items.slice(items.length - limit);
}

function buildTailResult<T>(
  entries: Array<TailItem & { item: T }>,
  cursor?: string,
  limit?: number,
): { items: T[]; nextCursor?: string; reset: boolean; totalCount: number } {
  const totalCount = entries.length;
  const normalizedCursor = cursor?.trim();
  let reset = true;
  let startIndex = 0;

  if (normalizedCursor) {
    const cursorIndex = entries.findIndex((entry) => entry.id === normalizedCursor);
    if (cursorIndex >= 0) {
      reset = false;
      startIndex = cursorIndex + 1;
    }
  }

  const tailEntries = applyLimit(entries.slice(startIndex), limit);
  const items = tailEntries.map((entry) => entry.item);
  const nextCursor = tailEntries.length > 0
    ? tailEntries[tailEntries.length - 1]?.id
    : normalizedCursor || undefined;

  return {
    items,
    nextCursor,
    reset,
    totalCount,
  };
}
