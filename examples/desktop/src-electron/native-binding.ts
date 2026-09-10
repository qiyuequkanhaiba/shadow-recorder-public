import { existsSync } from 'node:fs';
import path from 'node:path';

import { deriveInternalMaxSteps } from '../types/recording-defaults';
import type {
  ReqCaseShadowRecorderConfig,
  ReqCaseShadowRecorderDisplayTarget,
  ReqCaseShadowRecorderMetrics,
  ReqCaseShadowRecorderResourceUsage,
  ReqCaseShadowRecorderRuntimeHealth,
  ReqCaseShadowRecorderStep,
  ReqCaseShadowRecorderTestSessionLogInput,
  ReqCaseShadowRecorderTestSessionNoteInput,
  ReqCaseShadowRecorderTestSessionStartInput,
  ReqCaseShadowRecorderTestSessionTimelineEventTailResult,
  ReqCaseShadowRecorderTestSessionVideoSegment,
  ReqCaseShadowRecorderTestSessionVideoSegmentTailResult,
  ReqCaseShadowRecorderTestSessionVideoStream,
  ReqCaseShadowRecorderTestSessionState,
  ReqCaseShadowRecorderTestSessionTimelineEvent,
  ReqCaseShadowRecorderTestSessionOperationRecord,
  ReqCaseShadowRecorderTestSessionOperationTailResult,
  ReqCaseShadowRecorderTestSessionOperationUpdateInput,
} from './modules/reqcase-shadow-recorder';

type NativeStepRow = {
  id: string;
  timestampMs: number;
  action: string;
  x: number;
  y: number;
  logicalX?: number;
  logicalY?: number;
  windowLeft: number;
  windowTop: number;
  windowRight: number;
  windowBottom: number;
  logicalWindowLeft?: number;
  logicalWindowTop?: number;
  logicalWindowRight?: number;
  logicalWindowBottom?: number;
  displayId?: string;
  dpiScale?: number;
  processName: string;
  windowTitle: string;
  imageWebpBase64: string;
  imageBytes: number;
  captureLatencyMs: number;
  encodeLatencyMs: number;
  source: 'hook' | 'raw_input';
  captureBackend: 'dxgi' | 'wgc';
};

type NativeBinding = {
  startRecording: () => void;
  stopRecording: () => void;
  listTestSessionDisplayTargets?: () => NativeDisplayTargetRow[];
  startTestSession?: (
    options?: ReqCaseShadowRecorderTestSessionStartInput,
  ) => NativeTestSessionRow;
  stopTestSession?: () => NativeTestSessionRow;
  pauseTestSession?: () => NativeTestSessionRow;
  resumeTestSession?: () => NativeTestSessionRow;
  getActiveTestSession?: () => NativeTestSessionRow | null | undefined;
  updateActiveTestSessionVideoConfig?: (
    config: Pick<
      ReqCaseShadowRecorderConfig,
      'recordingProfile' | 'encoderPreference' | 'showMouseInVideo'
    >,
  ) => NativeTestSessionRow | null | undefined;
  listTestSessions?: () => NativeTestSessionRow[];
  getTestSessionVideoStreams?: (sessionId?: string) => NativeTestSessionVideoStreamRow[];
  getTestSessionVideoSegments?: (
    sessionId?: string,
    streamId?: string,
    limit?: number,
  ) => NativeTestSessionVideoSegmentRow[];
  getTestSessionVideoSegmentsTail?: (
    sessionId?: string,
    streamId?: string,
    afterSegmentId?: string,
    limit?: number,
  ) => NativeTestSessionVideoSegmentTailRow;
  getTestSessionVideoSegmentsForTimestamp?: (
    sessionId?: string,
    occurredAtMs?: number,
    displayId?: string,
    limit?: number,
  ) => NativeTestSessionVideoSegmentRow[];
  getTestSessionEvents?: (
    sessionId?: string,
    limit?: number,
  ) => NativeTestSessionEventRow[];
  getTestSessionEventsTail?: (
    sessionId?: string,
    afterEventId?: string,
    limit?: number,
  ) => NativeTestSessionEventTailRow;
  getTestSessionOperations?: (
    sessionId?: string,
    cursor?: string,
    limit?: number,
  ) => NativeTestSessionOperationTailRow;
  rebuildTestSessionOperations?: (sessionId?: string) => NativeTestSessionOperationRecord[];
  updateTestSessionOperation?: (
    input?: ReqCaseShadowRecorderTestSessionOperationUpdateInput,
  ) => NativeTestSessionOperationRecord;
  appendTestSessionNote?: (
    input?: ReqCaseShadowRecorderTestSessionNoteInput,
  ) => NativeTestSessionEventRow;
  appendTestSessionLog?: (
    input?: ReqCaseShadowRecorderTestSessionLogInput,
  ) => NativeTestSessionEventRow | null | undefined;
  clearBuffer: () => void;
  subscribeSteps: (callback: (step: NativeStepRow) => void) => void;
  subscribeStepsV2?: (
    options: { streamPayload?: 'meta_only' | 'meta_plus_thumb' | 'full' } | undefined,
    callback: (step: NativeStepRow) => void,
  ) => void;
  unsubscribeSteps: () => void;
  getMetrics: () => {
    capturedStepsTotal: number;
    droppedStepsTotal: number;
    inputChannelFullDropTotal: number;
    captureQueueDropTotal?: number;
    encodeQueueDropTotal?: number;
    pushDispatchDropTotal: number;
    bufferSteps: number;
    bufferBytes: number;
    lastCaptureLatencyMs: number;
    lastEncodeLatencyMs: number;
    streamBackpressureMs?: number;
    lastImageBytes: number;
    currentEffectiveQuality: number;
    qualityAdjustDownCount: number;
    qualityAdjustUpCount: number;
    wgcCaptureCount: number;
    dxgiCaptureCount: number;
    effectiveInputMode?: 'hook' | 'raw_input';
    effectiveDeltaMode?: 'off' | 'hash_dedup' | 'dirty_rect';
    dirtyRectSupported?: boolean;
    dirtyRectUpdateFramesTotal?: number;
    dirtyRectEmptyFramesTotal?: number;
    dirtyRectEncodeSkipTotal?: number;
    dirtyRegionFrameTotal?: number;
    dirtyRegionEmptyFrameTotal?: number;
    dirtyRegionCoverageAvg?: number;
    backendFallbackTotal?: number;
    captureContextResetTotal?: number;
  };
  getBuffer: () => NativeStepRow[];
  getBufferSince: (lastId: string) => NativeStepRow[];
  getBufferPage?: (
    cursor?: string,
    limit?: number,
    includeImage?: boolean,
  ) => NativeStepRow[];
  getStepImage?: (stepId: string, variant?: 'thumb' | 'full') => string | null | undefined;
  setConfig: (config: {
    maxSteps?: number;
    maxBufferBytes?: number;
    debounceMs?: number;
    webpQuality?: number;
    thumbWebpQuality?: number;
    adaptiveQualityEnabled?: boolean;
    adaptiveBufferHighRatio?: number;
    adaptiveBufferLowRatio?: number;
    adaptiveLatencyHighMs?: number;
    adaptiveLatencyLowMs?: number;
    adaptiveTargetImageKb?: number;
    adaptiveStepDown?: number;
    adaptiveStepUp?: number;
    adaptiveMinQuality?: number;
    adaptiveMaxQuality?: number;
    inputMode?: 'auto' | 'hook' | 'raw_input';
    captureBackend?: 'auto' | 'dxgi' | 'wgc';
    strictBackend?: boolean;
    deltaMode?: 'off' | 'hash_dedup' | 'dirty_rect';
    transportMode?: 'poll' | 'push';
    streamPayload?: 'meta_only' | 'meta_plus_thumb' | 'full';
    captureReuseEnabled?: boolean;
  }) => void;
  pauseRecording?: () => void;
  resumeRecording?: () => void;
  isRecordingPaused?: () => boolean;
};

type NativeTestSessionRow = {
  schemaVersion: 1;
  kind: 'reqcase.test-session';
  sessionId: string;
  name?: string;
  status: 'active' | 'paused' | 'stopped';
  startedAtMs: number;
  updatedAtMs: number;
  endedAtMs?: number;
  storageRootDir?: string;
  sessionDir?: string;
  manifestPath?: string;
  bufferWindowSeconds: number;
  segmentDurationSeconds: number;
  recordingProfile: 'efficiency' | 'balanced' | 'smooth';
  encoderPreference: 'auto' | 'hardware' | 'software';
  showMouseInVideo?: boolean;
  notes?: string;
  targetProcessName?: string;
  targetPid?: number;
  targetHwnd?: string;
  targetDisplayId?: string;
  targetDisplayIds?: string[];
  targetCaptureMode:
    | 'foreground_window'
    | 'target_window'
    | 'process_bind'
    | 'desktop'
    | 'target_display'
    | 'all_displays';
};

type NativeDisplayTargetRow = {
  displayId: string;
  label: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  isPrimary: boolean;
};

type NativeTestSessionVideoStreamRow = {
  schemaVersion: 1;
  kind: 'reqcase.test-session-video-stream';
  streamId: string;
  sessionId: string;
  label: string;
  status: 'planned' | 'active' | 'stopped';
  targetCaptureMode:
    | 'foreground_window'
    | 'target_window'
    | 'process_bind'
    | 'desktop'
    | 'target_display'
    | 'all_displays';
  displayId?: string;
  displayLabel?: string;
  width?: number;
  height?: number;
  monitorLeft?: number;
  monitorTop?: number;
  monitorRight?: number;
  monitorBottom?: number;
  startedAtMs: number;
  updatedAtMs: number;
  segmentDurationSeconds: number;
  segmentCount: number;
  playableSegmentCount: number;
  pendingSegmentCount: number;
  totalSegmentBytes: number;
  retainedSegmentBytes: number;
  lastSegmentBytes?: number;
  lastSegmentDurationMs?: number;
  lastSegmentFrameCount?: number;
  lastCaptureLatencyMs?: number;
  lastEncodeLatencyMs?: number;
  sampleIntervalMs: number;
  targetFps: number;
  encoderAvailable: boolean;
  warningCount: number;
  lastWarning?: string;
  streamDir?: string;
  manifestPath?: string;
  playlistPath?: string;
};

type NativeTestSessionVideoSegmentRow = {
  schemaVersion: 1;
  kind: 'reqcase.test-session-video-segment';
  segmentId: string;
  sessionId: string;
  streamId: string;
  status: 'planned' | 'ready' | 'missing';
  displayId?: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  relativePath?: string;
  filePath?: string;
  manifestPath?: string;
  sizeBytes?: number;
  frameCount?: number;
  codec?: string;
  container?: string;
  mimeType?: string;
  encoderName?: string;
  isPlayable: boolean;
};

type NativeTestSessionVideoSegmentTailRow = {
  items: NativeTestSessionVideoSegmentRow[];
  nextCursor?: string;
  reset: boolean;
  totalCount: number;
};

type NativeTestSessionEventRow = {
  schemaVersion: 1;
  kind: 'reqcase.test-session-event';
  eventId: string;
  sessionId: string;
  eventType:
    | 'session_started'
    | 'session_paused'
    | 'session_resumed'
    | 'session_stopped'
    | 'step_captured'
    | 'note_added'
    | 'app_log_added'
    | 'window_foreground_changed'
    | 'window_focus_changed'
    | 'window_shown'
    | 'window_hidden'
    | 'window_title_changed'
    | 'clipboard_updated';
  logCategory: 'recording' | 'system' | 'operation' | 'app';
  occurredAtMs: number;
  status?: 'active' | 'paused' | 'stopped';
  stepId?: string;
  action?: string;
  x?: number;
  y?: number;
  logicalX?: number;
  logicalY?: number;
  windowLeft?: number;
  windowTop?: number;
  windowRight?: number;
  windowBottom?: number;
  logicalWindowLeft?: number;
  logicalWindowTop?: number;
  logicalWindowRight?: number;
  logicalWindowBottom?: number;
  displayId?: string;
  dpiScale?: number;
  processName?: string;
  windowTitle?: string;
  title?: string;
  message?: string;
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  logSource?: string;
  systemSource?: 'win_event' | 'clipboard';
  windowHwnd?: string;
  windowPid?: number;
  clipboardContentType?: 'text' | 'image' | 'file_list' | 'html' | 'unknown';
  imageBytes?: number;
  captureLatencyMs?: number;
  encodeLatencyMs?: number;
  source?: 'hook' | 'raw_input';
  captureBackend?: 'dxgi' | 'wgc';
  fullImagePath?: string;
  thumbImagePath?: string;
};

type NativeTestSessionEventTailRow = {
  items: NativeTestSessionEventRow[];
  nextCursor?: string;
  reset: boolean;
  totalCount: number;
};

type NativeTestSessionOperationRecord = ReqCaseShadowRecorderTestSessionOperationRecord;

type NativeTestSessionOperationTailRow = {
  items: NativeTestSessionOperationRecord[];
  nextCursor?: string;
  reset: boolean;
  totalCount: number;
  diagnostics?: {
    code: string;
    severity: string;
    lineNumber?: number;
    schemaVersion?: number;
    message: string;
  }[];
};

const warnedMissingNativeApis = new Set<string>();
const MEDIA_PROTOCOL = 'reqcase-media';

function warnMissingNativeApi(apiName: string): void {
  if (warnedMissingNativeApis.has(apiName)) {
    return;
  }
  warnedMissingNativeApis.add(apiName);
  console.warn(
    `[shadow-recorder] Native addon API '${apiName}' is unavailable. ` +
      'This usually means shadow_recorder.node is stale. Run scripts/windows-build-native.ps1.',
  );
}

function toRendererMediaUrl(filePath?: string): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const resolvedPath = path.resolve(filePath);
  if (!existsSync(resolvedPath)) {
    return undefined;
  }
  return `${MEDIA_PROTOCOL}://local/?path=${encodeURIComponent(resolvedPath)}`;
}

function findRepoRoot(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    const cargoToml = path.join(current, 'Cargo.toml');
    const srcDir = path.join(current, 'src');
    if (existsSync(cargoToml) && existsSync(srcDir)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveBindingPath(): string {
  if (process.versions && process.versions.electron) {
    const { app } = require('electron');
    if (app && app.isPackaged && process.resourcesPath) {
      const packagedPath = path.join(process.resourcesPath, 'shadow_recorder.node');
      if (existsSync(packagedPath)) {
        return packagedPath;
      }
    }
  }

  const targetTriples = ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'];
  const profiles = ['debug', 'release'];
  const candidateRoots = new Set<string>();
  const repoRootFromDir = findRepoRoot(__dirname);
  const repoRootFromCwd = findRepoRoot(process.cwd());

  if (repoRootFromDir) {
    candidateRoots.add(path.join(repoRootFromDir, 'target'));
  }
  if (repoRootFromCwd) {
    candidateRoots.add(path.join(repoRootFromCwd, 'target'));
  }

  // Fallback for legacy path layouts when repo root probing is unavailable.
  candidateRoots.add(path.resolve(__dirname, '../../../target'));
  candidateRoots.add(path.resolve(__dirname, '../../../../target'));

  const candidates = new Set<string>();
  for (const root of candidateRoots) {
    for (const triple of targetTriples) {
      for (const profile of profiles) {
        candidates.add(path.resolve(root, triple, profile, 'shadow_recorder.node'));
      }
    }
    for (const profile of profiles) {
      candidates.add(path.resolve(root, profile, 'shadow_recorder.node'));
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Cannot find shadow_recorder.node. Checked:\n${Array.from(candidates).join('\n')}`,
  );
}

let native: NativeBinding | null = null;

function getBinding(): NativeBinding {
  if (!native) {
    const bindingPath = resolveBindingPath();
    native = require(bindingPath) as NativeBinding;
  }
  return native;
}

export function isNativeBindingLoaded(): boolean {
  return native !== null;
}

export function startRecording(): void {
  (getBinding() as any).startRecording();
}

export function stopRecording(): void {
  (getBinding() as any).stopRecording();
}

export function listAvailableDisplays(): ReqCaseShadowRecorderDisplayTarget[] {
  const binding = getBinding() as any;
  if (typeof binding.listTestSessionDisplayTargets !== 'function') {
    warnMissingNativeApi('listTestSessionDisplayTargets');
    return [];
  }
  return binding.listTestSessionDisplayTargets().map(mapNativeDisplayTarget);
}

function mapNativeTestSession(row: NativeTestSessionRow): ReqCaseShadowRecorderTestSessionState {
  return {
    schemaVersion: row.schemaVersion,
    kind: row.kind,
    sessionId: row.sessionId,
    name: row.name,
    status: row.status,
    startedAtMs: row.startedAtMs,
    updatedAtMs: row.updatedAtMs,
    endedAtMs: row.endedAtMs,
    storageRootDir: row.storageRootDir,
    sessionDir: row.sessionDir,
    manifestPath: row.manifestPath,
    bufferWindowSeconds: row.bufferWindowSeconds,
    segmentDurationSeconds: row.segmentDurationSeconds,
    recordingProfile: row.recordingProfile,
    encoderPreference: row.encoderPreference,
    showMouseInVideo: row.showMouseInVideo ?? false,
    notes: row.notes,
    targetProcessName: row.targetProcessName,
    targetPid: row.targetPid,
    targetHwnd: row.targetHwnd,
    targetDisplayId: row.targetDisplayId,
    targetDisplayIds: row.targetDisplayIds,
    targetCaptureMode: row.targetCaptureMode,
  };
}

function mapNativeDisplayTarget(row: NativeDisplayTargetRow): ReqCaseShadowRecorderDisplayTarget {
  return {
    displayId: row.displayId,
    label: row.label,
    left: row.left,
    top: row.top,
    right: row.right,
    bottom: row.bottom,
    width: row.width,
    height: row.height,
    isPrimary: row.isPrimary,
  };
}

function mapNativeTestSessionVideoStream(
  row: NativeTestSessionVideoStreamRow,
): ReqCaseShadowRecorderTestSessionVideoStream {
  return {
    schemaVersion: row.schemaVersion,
    kind: row.kind,
    streamId: row.streamId,
    sessionId: row.sessionId,
    label: row.label,
    status: row.status,
    targetCaptureMode: row.targetCaptureMode,
    displayId: row.displayId,
    displayLabel: row.displayLabel,
    width: row.width,
    height: row.height,
    monitorLeft: row.monitorLeft,
    monitorTop: row.monitorTop,
    monitorRight: row.monitorRight,
    monitorBottom: row.monitorBottom,
    startedAtMs: row.startedAtMs,
    updatedAtMs: row.updatedAtMs,
    segmentDurationSeconds: row.segmentDurationSeconds,
    segmentCount: row.segmentCount,
    playableSegmentCount: row.playableSegmentCount,
    pendingSegmentCount: row.pendingSegmentCount,
    totalSegmentBytes: row.totalSegmentBytes,
    retainedSegmentBytes: row.retainedSegmentBytes,
    lastSegmentBytes: row.lastSegmentBytes,
    lastSegmentDurationMs: row.lastSegmentDurationMs,
    lastSegmentFrameCount: row.lastSegmentFrameCount,
    lastCaptureLatencyMs: row.lastCaptureLatencyMs,
    lastEncodeLatencyMs: row.lastEncodeLatencyMs,
    sampleIntervalMs: row.sampleIntervalMs,
    targetFps: row.targetFps,
    encoderAvailable: row.encoderAvailable,
    warningCount: row.warningCount,
    lastWarning: row.lastWarning,
    streamDir: row.streamDir,
    manifestPath: row.manifestPath,
    playlistPath: toRendererMediaUrl(row.playlistPath),
  };
}

function mapNativeTestSessionVideoSegment(
  row: NativeTestSessionVideoSegmentRow,
): ReqCaseShadowRecorderTestSessionVideoSegment {
  return {
    schemaVersion: row.schemaVersion,
    kind: row.kind,
    segmentId: row.segmentId,
    sessionId: row.sessionId,
    streamId: row.streamId,
    status: row.status,
    displayId: row.displayId,
    startedAtMs: row.startedAtMs,
    endedAtMs: row.endedAtMs,
    durationMs: row.durationMs,
    relativePath: row.relativePath,
    filePath: row.filePath,
    manifestPath: row.manifestPath,
    sizeBytes: row.sizeBytes,
    frameCount: row.frameCount,
    codec: row.codec,
    container: row.container,
    mimeType: row.mimeType,
    encoderName: row.encoderName,
    isPlayable: row.isPlayable,
    playbackUrl: toRendererMediaUrl(row.filePath),
  };
}

function mapNativeTestSessionVideoSegmentTail(
  row: NativeTestSessionVideoSegmentTailRow,
): ReqCaseShadowRecorderTestSessionVideoSegmentTailResult {
  return {
    items: row.items.map(mapNativeTestSessionVideoSegment),
    nextCursor: row.nextCursor,
    reset: row.reset,
    totalCount: row.totalCount,
  };
}

function mapNativeTestSessionEvent(
  row: NativeTestSessionEventRow,
): ReqCaseShadowRecorderTestSessionTimelineEvent {
  return {
    schemaVersion: row.schemaVersion,
    kind: row.kind,
    eventId: row.eventId,
    sessionId: row.sessionId,
    eventType: row.eventType,
    logCategory: row.logCategory,
    occurredAtMs: row.occurredAtMs,
    status: row.status,
    stepId: row.stepId,
    action: row.action,
    x: row.x,
    y: row.y,
    logicalX: row.logicalX,
    logicalY: row.logicalY,
    windowLeft: row.windowLeft,
    windowTop: row.windowTop,
    windowRight: row.windowRight,
    windowBottom: row.windowBottom,
    logicalWindowLeft: row.logicalWindowLeft,
    logicalWindowTop: row.logicalWindowTop,
    logicalWindowRight: row.logicalWindowRight,
    logicalWindowBottom: row.logicalWindowBottom,
    displayId: row.displayId,
    dpiScale: row.dpiScale,
    processName: row.processName,
    windowTitle: row.windowTitle,
    title: row.title,
    message: row.message,
    logLevel: row.logLevel,
    logSource: row.logSource,
    systemSource: row.systemSource,
    windowHwnd: row.windowHwnd,
    windowPid: row.windowPid,
    clipboardContentType: row.clipboardContentType,
    imageBytes: row.imageBytes,
    captureLatencyMs: row.captureLatencyMs,
    encodeLatencyMs: row.encodeLatencyMs,
    source: row.source,
    captureBackend: row.captureBackend,
    fullImagePath: row.fullImagePath,
    thumbImagePath: row.thumbImagePath,
  };
}

function mapNativeTestSessionEventTail(
  row: NativeTestSessionEventTailRow,
): ReqCaseShadowRecorderTestSessionTimelineEventTailResult {
  return {
    items: row.items.map(mapNativeTestSessionEvent),
    nextCursor: row.nextCursor,
    reset: row.reset,
    totalCount: row.totalCount,
  };
}

function mapNativeTestSessionOperation(
  row: NativeTestSessionOperationRecord,
): ReqCaseShadowRecorderTestSessionOperationRecord {
  return row;
}

function mapNativeTestSessionOperationTail(
  row: NativeTestSessionOperationTailRow,
): ReqCaseShadowRecorderTestSessionOperationTailResult {
  return {
    items: row.items.map(mapNativeTestSessionOperation),
    nextCursor: row.nextCursor,
    reset: row.reset,
    totalCount: row.totalCount,
    diagnostics: row.diagnostics ?? [],
  };
}

export function startTestSession(
  options: ReqCaseShadowRecorderTestSessionStartInput = {},
): ReqCaseShadowRecorderTestSessionState {
  const binding = getBinding() as any;
  if (typeof binding.startTestSession !== 'function') {
    warnMissingNativeApi('startTestSession');
    throw new Error('Native addon API startTestSession is unavailable.');
  }
  return mapNativeTestSession(binding.startTestSession(options));
}

export function stopTestSession(): ReqCaseShadowRecorderTestSessionState {
  const binding = getBinding() as any;
  if (typeof binding.stopTestSession !== 'function') {
    warnMissingNativeApi('stopTestSession');
    throw new Error('Native addon API stopTestSession is unavailable.');
  }
  return mapNativeTestSession(binding.stopTestSession());
}

export function pauseTestSession(): ReqCaseShadowRecorderTestSessionState {
  const binding = getBinding() as any;
  if (typeof binding.pauseTestSession !== 'function') {
    warnMissingNativeApi('pauseTestSession');
    throw new Error('Native addon API pauseTestSession is unavailable.');
  }
  return mapNativeTestSession(binding.pauseTestSession());
}

export function resumeTestSession(): ReqCaseShadowRecorderTestSessionState {
  const binding = getBinding() as any;
  if (typeof binding.resumeTestSession !== 'function') {
    warnMissingNativeApi('resumeTestSession');
    throw new Error('Native addon API resumeTestSession is unavailable.');
  }
  return mapNativeTestSession(binding.resumeTestSession());
}

export function getActiveTestSession(): ReqCaseShadowRecorderTestSessionState | null {
  const binding = getBinding() as any;
  if (typeof binding.getActiveTestSession !== 'function') {
    warnMissingNativeApi('getActiveTestSession');
    return null;
  }
  const session = binding.getActiveTestSession();
  return session ? mapNativeTestSession(session) : null;
}

export function updateActiveTestSessionVideoConfig(
  config: Pick<
    ReqCaseShadowRecorderConfig,
    'recordingProfile' | 'encoderPreference' | 'showMouseInVideo'
  >,
): ReqCaseShadowRecorderTestSessionState | null {
  const binding = getBinding() as any;
  if (typeof binding.updateActiveTestSessionVideoConfig !== 'function') {
    warnMissingNativeApi('updateActiveTestSessionVideoConfig');
    return null;
  }
  const session = binding.updateActiveTestSessionVideoConfig(config);
  return session ? mapNativeTestSession(session) : null;
}

export function listTestSessions(): ReqCaseShadowRecorderTestSessionState[] {
  const binding = getBinding() as any;
  if (typeof binding.listTestSessions !== 'function') {
    warnMissingNativeApi('listTestSessions');
    return [];
  }
  return binding.listTestSessions().map(mapNativeTestSession);
}

export function getTestSessionVideoStreams(
  sessionId?: string,
): ReqCaseShadowRecorderTestSessionVideoStream[] {
  const binding = getBinding() as any;
  if (typeof binding.getTestSessionVideoStreams !== 'function') {
    warnMissingNativeApi('getTestSessionVideoStreams');
    return [];
  }
  return binding
    .getTestSessionVideoStreams(sessionId)
    .map(mapNativeTestSessionVideoStream);
}

export function getTestSessionVideoSegments(
  sessionId?: string,
  streamId?: string,
  limit?: number,
): ReqCaseShadowRecorderTestSessionVideoSegment[] {
  const binding = getBinding() as any;
  if (typeof binding.getTestSessionVideoSegments !== 'function') {
    warnMissingNativeApi('getTestSessionVideoSegments');
    return [];
  }
  return binding
    .getTestSessionVideoSegments(sessionId, streamId, limit)
    .map(mapNativeTestSessionVideoSegment);
}

export function getTestSessionVideoSegmentsTail(
  sessionId?: string,
  streamId?: string,
  afterSegmentId?: string,
  limit?: number,
): ReqCaseShadowRecorderTestSessionVideoSegmentTailResult {
  const binding = getBinding() as any;
  if (typeof binding.getTestSessionVideoSegmentsTail !== 'function') {
    warnMissingNativeApi('getTestSessionVideoSegmentsTail');
    return {
      items: [],
      nextCursor: afterSegmentId,
      reset: true,
      totalCount: 0,
    };
  }
  return mapNativeTestSessionVideoSegmentTail(
    binding.getTestSessionVideoSegmentsTail(sessionId, streamId, afterSegmentId, limit),
  );
}

export function getTestSessionVideoSegmentsForTimestamp(
  sessionId?: string,
  occurredAtMs?: number,
  displayId?: string,
  limit?: number,
): ReqCaseShadowRecorderTestSessionVideoSegment[] {
  const binding = getBinding() as any;
  if (typeof binding.getTestSessionVideoSegmentsForTimestamp !== 'function') {
    warnMissingNativeApi('getTestSessionVideoSegmentsForTimestamp');
    return [];
  }
  return binding
    .getTestSessionVideoSegmentsForTimestamp(sessionId, occurredAtMs, displayId, limit)
    .map(mapNativeTestSessionVideoSegment);
}

export function getTestSessionEvents(
  sessionId?: string,
  limit?: number,
): ReqCaseShadowRecorderTestSessionTimelineEvent[] {
  const binding = getBinding() as any;
  if (typeof binding.getTestSessionEvents !== 'function') {
    warnMissingNativeApi('getTestSessionEvents');
    return [];
  }
  return binding
    .getTestSessionEvents(sessionId, limit)
    .map(mapNativeTestSessionEvent);
}

export function getTestSessionEventsTail(
  sessionId?: string,
  afterEventId?: string,
  limit?: number,
): ReqCaseShadowRecorderTestSessionTimelineEventTailResult {
  const binding = getBinding() as any;
  if (typeof binding.getTestSessionEventsTail !== 'function') {
    warnMissingNativeApi('getTestSessionEventsTail');
    return {
      items: [],
      nextCursor: afterEventId,
      reset: true,
      totalCount: 0,
    };
  }
  return mapNativeTestSessionEventTail(
    binding.getTestSessionEventsTail(sessionId, afterEventId, limit),
  );
}

export function appendTestSessionNote(
  input: ReqCaseShadowRecorderTestSessionNoteInput = {},
): ReqCaseShadowRecorderTestSessionTimelineEvent {
  const binding = getBinding() as any;
  if (typeof binding.appendTestSessionNote !== 'function') {
    warnMissingNativeApi('appendTestSessionNote');
    throw new Error('Native addon API appendTestSessionNote is unavailable.');
  }
  return mapNativeTestSessionEvent(binding.appendTestSessionNote(input));
}

export function appendTestSessionLog(
  input: ReqCaseShadowRecorderTestSessionLogInput = {},
): ReqCaseShadowRecorderTestSessionTimelineEvent | null {
  const binding = getBinding() as any;
  if (typeof binding.appendTestSessionLog !== 'function') {
    warnMissingNativeApi('appendTestSessionLog');
    return null;
  }
  const event = binding.appendTestSessionLog(input);
  return event ? mapNativeTestSessionEvent(event) : null;
}

export function hasTestSessionOperationListApi(): boolean {
  const binding = getBinding() as any;
  return typeof binding.getTestSessionOperations === 'function';
}

export function hasTestSessionOperationRebuildApi(): boolean {
  const binding = getBinding() as any;
  return typeof binding.rebuildTestSessionOperations === 'function';
}

export function hasTestSessionOperationUpdateApi(): boolean {
  const binding = getBinding() as any;
  return typeof binding.updateTestSessionOperation === 'function';
}

export function getTestSessionOperations(
  sessionId?: string,
  cursor?: string,
  limit?: number,
): ReqCaseShadowRecorderTestSessionOperationTailResult {
  const binding = getBinding() as any;
  if (typeof binding.getTestSessionOperations !== 'function') {
    warnMissingNativeApi('getTestSessionOperations');
    return {
      items: [],
      nextCursor: cursor,
      reset: true,
      totalCount: 0,
    };
  }
  return mapNativeTestSessionOperationTail(
    binding.getTestSessionOperations(sessionId, cursor, limit),
  );
}

export function rebuildTestSessionOperations(
  sessionId?: string,
): ReqCaseShadowRecorderTestSessionOperationRecord[] {
  const binding = getBinding() as any;
  if (typeof binding.rebuildTestSessionOperations !== 'function') {
    warnMissingNativeApi('rebuildTestSessionOperations');
    throw new Error('Native addon API rebuildTestSessionOperations is unavailable.');
  }
  return binding
    .rebuildTestSessionOperations(sessionId)
    .map(mapNativeTestSessionOperation);
}

export function updateTestSessionOperation(
  input: ReqCaseShadowRecorderTestSessionOperationUpdateInput,
): ReqCaseShadowRecorderTestSessionOperationRecord {
  const binding = getBinding() as any;
  if (typeof binding.updateTestSessionOperation !== 'function') {
    warnMissingNativeApi('updateTestSessionOperation');
    throw new Error('Native addon API updateTestSessionOperation is unavailable.');
  }
  return mapNativeTestSessionOperation(binding.updateTestSessionOperation(input));
}

export function clearRecorderBuffer(): void {
  (getBinding() as any).clearBuffer();
}

export function subscribeRecorderSteps(handler: (step: ReqCaseShadowRecorderStep) => void): void {
  (getBinding() as any).subscribeSteps((row: any) => {
    handler({
      id: row.id,
      timestampMs: row.timestampMs,
      action: row.action,
      x: row.x,
      y: row.y,
      logicalX: row.logicalX,
      logicalY: row.logicalY,
      windowLeft: row.windowLeft,
      windowTop: row.windowTop,
      windowRight: row.windowRight,
      windowBottom: row.windowBottom,
      logicalWindowLeft: row.logicalWindowLeft,
      logicalWindowTop: row.logicalWindowTop,
      logicalWindowRight: row.logicalWindowRight,
      logicalWindowBottom: row.logicalWindowBottom,
      displayId: row.displayId,
      dpiScale: row.dpiScale,
      processName: row.processName,
      windowTitle: row.windowTitle,
      imageWebpBase64: row.imageWebpBase64,
      imageBytes: row.imageBytes,
      captureLatencyMs: row.captureLatencyMs,
      encodeLatencyMs: row.encodeLatencyMs,
      source: row.source,
      captureBackend: row.captureBackend,
    });
  });
}

export function subscribeRecorderStepsV2(
  options: { streamPayload?: 'meta_only' | 'meta_plus_thumb' | 'full' } | undefined,
  handler: (step: ReqCaseShadowRecorderStep) => void,
): void {
  const binding = getBinding() as any;
  if (typeof binding.subscribeStepsV2 === 'function') {
    binding.subscribeStepsV2(options, (row: any) => {
      handler({
        id: row.id,
        timestampMs: row.timestampMs,
        action: row.action,
        x: row.x,
        y: row.y,
        logicalX: row.logicalX,
        logicalY: row.logicalY,
        windowLeft: row.windowLeft,
        windowTop: row.windowTop,
        windowRight: row.windowRight,
        windowBottom: row.windowBottom,
        logicalWindowLeft: row.logicalWindowLeft,
        logicalWindowTop: row.logicalWindowTop,
        logicalWindowRight: row.logicalWindowRight,
        logicalWindowBottom: row.logicalWindowBottom,
        displayId: row.displayId,
        dpiScale: row.dpiScale,
        processName: row.processName,
        windowTitle: row.windowTitle,
        imageWebpBase64: row.imageWebpBase64,
        imageBytes: row.imageBytes,
        captureLatencyMs: row.captureLatencyMs,
        encodeLatencyMs: row.encodeLatencyMs,
        source: row.source,
        captureBackend: row.captureBackend,
      });
    });
    return;
  }

  subscribeRecorderSteps(handler);
}

export function unsubscribeRecorderSteps(): void {
  (getBinding() as any).unsubscribeSteps();
}

export function pauseRecording(): void {
  const binding = getBinding() as any;
  if (typeof binding.pauseRecording === 'function') {
    binding.pauseRecording();
    return;
  }
  warnMissingNativeApi('pauseRecording');
}

export function resumeRecording(): void {
  const binding = getBinding() as any;
  if (typeof binding.resumeRecording === 'function') {
    binding.resumeRecording();
    return;
  }
  warnMissingNativeApi('resumeRecording');
}

export function isRecordingPaused(): boolean {
  const binding = getBinding() as any;
  if (typeof binding.isRecordingPaused === 'function') {
    return binding.isRecordingPaused();
  }
  warnMissingNativeApi('isRecordingPaused');
  return false;
}

export function setRecorderConfig(config: ReqCaseShadowRecorderConfig): void {
  const semanticRecordingEnabled =
    !!(config.semanticRecordingEnabled ?? config.defectEvidenceEnabled);
  // Single UI switch enables full UIA + operation pipeline.
  const uiaObserverEnabled = semanticRecordingEnabled;
  const operationBuilderEnabled = semanticRecordingEnabled;
  (getBinding() as any).setConfig({
    maxSteps: config.maxSteps ?? deriveInternalMaxSteps(config.recordingWindowSeconds),
    maxBufferBytes: config.maxBufferBytes,
    debounceMs: config.debounceMs,
    webpQuality: config.webpQuality,
    thumbWebpQuality: config.thumbWebpQuality,
    adaptiveQualityEnabled: config.adaptiveQualityEnabled,
    adaptiveBufferHighRatio: config.adaptiveBufferHighRatio,
    adaptiveBufferLowRatio: config.adaptiveBufferLowRatio,
    adaptiveLatencyHighMs: config.adaptiveLatencyHighMs,
    adaptiveLatencyLowMs: config.adaptiveLatencyLowMs,
    adaptiveTargetImageKb: config.adaptiveTargetImageKb,
    adaptiveStepDown: config.adaptiveStepDown,
    adaptiveStepUp: config.adaptiveStepUp,
    adaptiveMinQuality: config.adaptiveMinQuality,
    adaptiveMaxQuality: config.adaptiveMaxQuality,
    inputMode: config.inputMode,
    captureBackend: config.captureBackend,
    strictBackend: config.strictBackend,
    deltaMode: config.deltaMode,
    transportMode: config.transportMode,
    streamPayload: config.streamPayload,
    captureReuseEnabled: config.captureReuseEnabled,
    privacyEnabled: config.privacyEnabled,
    defectEvidenceEnabled: config.defectEvidenceEnabled ?? semanticRecordingEnabled,
    semanticRecordingEnabled,
    uiaObserverEnabled,
    operationBuilderEnabled,
    operationReviewV2Enabled: config.operationReviewV2Enabled,
    semanticPlaintextInputEnabled: config.semanticPlaintextInputEnabled,
    defectPreWindowSeconds: config.defectPreWindowSeconds,
    defectPostWindowSeconds: config.defectPostWindowSeconds,
  });
}

export function getRecorderBuffer(): ReqCaseShadowRecorderStep[] {
  const rows = (getBinding() as any).getBuffer();
  return rows.map((row: any) => ({
    id: row.id,
    timestampMs: row.timestampMs,
    action: row.action,
    x: row.x,
    y: row.y,
    logicalX: row.logicalX,
    logicalY: row.logicalY,
    windowLeft: row.windowLeft,
    windowTop: row.windowTop,
    windowRight: row.windowRight,
    windowBottom: row.windowBottom,
    logicalWindowLeft: row.logicalWindowLeft,
    logicalWindowTop: row.logicalWindowTop,
    logicalWindowRight: row.logicalWindowRight,
    logicalWindowBottom: row.logicalWindowBottom,
    displayId: row.displayId,
    dpiScale: row.dpiScale,
    processName: row.processName,
    windowTitle: row.windowTitle,
    imageWebpBase64: row.imageWebpBase64,
    imageBytes: row.imageBytes,
    captureLatencyMs: row.captureLatencyMs,
    encodeLatencyMs: row.encodeLatencyMs,
    source: row.source,
    captureBackend: row.captureBackend,
  }));
}

export function getRecorderBufferSince(lastId: string): ReqCaseShadowRecorderStep[] {
  const rows = (getBinding() as any).getBufferSince(lastId);
  return rows.map((row: any) => ({
    id: row.id,
    timestampMs: row.timestampMs,
    action: row.action,
    x: row.x,
    y: row.y,
    logicalX: row.logicalX,
    logicalY: row.logicalY,
    windowLeft: row.windowLeft,
    windowTop: row.windowTop,
    windowRight: row.windowRight,
    windowBottom: row.windowBottom,
    logicalWindowLeft: row.logicalWindowLeft,
    logicalWindowTop: row.logicalWindowTop,
    logicalWindowRight: row.logicalWindowRight,
    logicalWindowBottom: row.logicalWindowBottom,
    displayId: row.displayId,
    dpiScale: row.dpiScale,
    processName: row.processName,
    windowTitle: row.windowTitle,
    imageWebpBase64: row.imageWebpBase64,
    imageBytes: row.imageBytes,
    captureLatencyMs: row.captureLatencyMs,
    encodeLatencyMs: row.encodeLatencyMs,
    source: row.source,
    captureBackend: row.captureBackend,
  }));
}

export function getRecorderBufferPage(
  cursor: string,
  limit: number,
  includeImage: boolean,
): ReqCaseShadowRecorderStep[] {
  const binding = getBinding() as any;
  if (typeof binding.getBufferPage !== 'function') {
    return getRecorderBufferSince(cursor);
  }
  const rows = binding.getBufferPage(cursor, limit, includeImage);
  return rows.map((row: any) => ({
    id: row.id,
    timestampMs: row.timestampMs,
    action: row.action,
    x: row.x,
    y: row.y,
    logicalX: row.logicalX,
    logicalY: row.logicalY,
    windowLeft: row.windowLeft,
    windowTop: row.windowTop,
    windowRight: row.windowRight,
    windowBottom: row.windowBottom,
    logicalWindowLeft: row.logicalWindowLeft,
    logicalWindowTop: row.logicalWindowTop,
    logicalWindowRight: row.logicalWindowRight,
    logicalWindowBottom: row.logicalWindowBottom,
    displayId: row.displayId,
    dpiScale: row.dpiScale,
    processName: row.processName,
    windowTitle: row.windowTitle,
    imageWebpBase64: row.imageWebpBase64,
    imageBytes: row.imageBytes,
    captureLatencyMs: row.captureLatencyMs,
    encodeLatencyMs: row.encodeLatencyMs,
    source: row.source,
    captureBackend: row.captureBackend,
  }));
}

export function getRecorderStepImage(stepId: string, variant: 'thumb' | 'full' = 'full'): string | null {
  const binding = getBinding() as any;
  if (typeof binding.getStepImage !== 'function') {
    return null;
  }
  return binding.getStepImage(stepId, variant) ?? null;
}

export function getRecorderMetrics(): ReqCaseShadowRecorderMetrics {
  const row = (getBinding() as any).getMetrics();
  return {
    capturedStepsTotal: row.capturedStepsTotal,
    droppedStepsTotal: row.droppedStepsTotal,
    inputChannelFullDropTotal: row.inputChannelFullDropTotal,
    captureQueueDropTotal: row.captureQueueDropTotal ?? 0,
    encodeQueueDropTotal: row.encodeQueueDropTotal ?? 0,
    pushDispatchDropTotal: row.pushDispatchDropTotal,
    bufferSteps: row.bufferSteps,
    bufferBytes: row.bufferBytes,
    lastCaptureLatencyMs: row.lastCaptureLatencyMs,
    lastEncodeLatencyMs: row.lastEncodeLatencyMs,
    streamBackpressureMs: row.streamBackpressureMs ?? 0,
    lastImageBytes: row.lastImageBytes,
    currentEffectiveQuality: row.currentEffectiveQuality,
    qualityAdjustDownCount: row.qualityAdjustDownCount,
    qualityAdjustUpCount: row.qualityAdjustUpCount,
    wgcCaptureCount: row.wgcCaptureCount,
    dxgiCaptureCount: row.dxgiCaptureCount,
    effectiveInputMode: row.effectiveInputMode,
    effectiveDeltaMode: row.effectiveDeltaMode,
    dirtyRectSupported: row.dirtyRectSupported ?? false,
    dirtyRectUpdateFramesTotal: row.dirtyRectUpdateFramesTotal ?? 0,
    dirtyRectEmptyFramesTotal: row.dirtyRectEmptyFramesTotal ?? 0,
    dirtyRectEncodeSkipTotal: row.dirtyRectEncodeSkipTotal ?? 0,
    dirtyRegionFrameTotal: row.dirtyRegionFrameTotal ?? 0,
    dirtyRegionEmptyFrameTotal: row.dirtyRegionEmptyFrameTotal ?? 0,
    dirtyRegionCoverageAvg: row.dirtyRegionCoverageAvg ?? 0,
    backendFallbackTotal: row.backendFallbackTotal,
    captureContextResetTotal: row.captureContextResetTotal,
  };
}

export function buildRuntimeHealthSnapshot(input: {
  recording: boolean;
  paused: boolean;
  config: ReqCaseShadowRecorderConfig;
  metrics: ReqCaseShadowRecorderMetrics;
  resourceUsage?: ReqCaseShadowRecorderResourceUsage | null;
}): ReqCaseShadowRecorderRuntimeHealth {
  return {
    recording: input.recording,
    paused: input.paused,
    captureBackend: input.config.captureBackend,
    strictBackend: !!input.config.strictBackend,
    transportMode: input.config.transportMode,
    streamPayload: input.config.streamPayload,
    deltaMode: input.config.deltaMode,
    effectiveDeltaMode: input.metrics.effectiveDeltaMode,
    dirtyRectSupported: input.metrics.dirtyRectSupported,
    metrics: input.metrics,
    resourceUsage: input.resourceUsage ?? null,
  };
}


export function markTestDefect(input?: {
  sessionId?: string;
  note?: string;
  expected?: string;
  actual?: string;
  markedAtMs?: number;
  preWindowSeconds?: number;
  postWindowSeconds?: number;
}): {
  event: any;
  markedAtMs: number;
  windowStartMs: number;
  windowEndMs: number;
  preWindowSeconds: number;
  postWindowSeconds: number;
  note?: string;
  expected?: string;
  actual?: string;
  stepCount: number;
} {
  const binding = getBinding() as any;
  if (typeof binding.markTestDefect !== 'function') {
    throw new Error('markTestDefect is unavailable in native binding');
  }
  return binding.markTestDefect(input);
}

export function getTestSessionSteps(
  sessionId?: string | { sessionId?: string; session_id?: string; limit?: number },
  limit?: number,
): any[] {
  try {
    const binding = getBinding() as any;
    if (typeof binding.getTestSessionSteps !== 'function') {
      warnMissingNativeApi('getTestSessionSteps');
      return [];
    }
    let sid: string | undefined;
    let lim: number | undefined = limit;
    if (sessionId && typeof sessionId === 'object') {
      sid = sessionId.sessionId ?? sessionId.session_id;
      lim = sessionId.limit ?? limit;
    } else if (typeof sessionId === 'string') {
      sid = sessionId;
    }
    const rows = binding.getTestSessionSteps(sid, lim);
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not active|SessionNotFound|no active|not found/i.test(message)) {
      return [];
    }
    throw error;
  }
}

export function rebuildTestSessionSteps(sessionId?: string): any[] {
  const binding = getBinding() as any;
  if (typeof binding.rebuildTestSessionSteps !== 'function') {
    throw new Error('rebuildTestSessionSteps is unavailable in native binding');
  }
  return binding.rebuildTestSessionSteps(sessionId) ?? [];
}

export function renderTestSessionReproSteps(
  sessionId?: string,
  windowStartMs?: number,
  windowEndMs?: number,
  defectNote?: string,
): string {
  const binding = getBinding() as any;
  if (typeof binding.renderTestSessionReproSteps !== 'function') {
    throw new Error('renderTestSessionReproSteps is unavailable in native binding');
  }
  return binding.renderTestSessionReproSteps(sessionId, windowStartMs, windowEndMs, defectNote) ?? '';
}

export function exportTestDefectPack(input?: {
  sessionId?: string;
  targetDir?: string;
  markedAtMs?: number;
  preWindowSeconds?: number;
  postWindowSeconds?: number;
  note?: string;
  expected?: string;
  actual?: string;
}): any {
  const binding = getBinding() as any;
  if (typeof binding.exportTestDefectPack !== 'function') {
    throw new Error('exportTestDefectPack is unavailable in native binding');
  }
  return binding.exportTestDefectPack(input);
}


export function updateTestSessionStep(input?: any) {
  const binding = getBinding() as any;
  if (typeof binding.updateTestSessionStep !== 'function') {
    throw new Error('updateTestSessionStep is unavailable in native binding');
  }
  return binding.updateTestSessionStep(input);
}

export function setSemanticAliasProfile(profile?: any) {
  const binding = getBinding() as any;
  if (typeof binding.setSemanticAliasProfile !== 'function') {
    throw new Error('setSemanticAliasProfile is unavailable in native binding');
  }
  return binding.setSemanticAliasProfile(profile ?? null);
}

export function getSemanticAliasProfile() {
  const binding = getBinding() as any;
  if (typeof binding.getSemanticAliasProfile !== 'function') {
    throw new Error('getSemanticAliasProfile is unavailable in native binding');
  }
  return binding.getSemanticAliasProfile();
}

export function loadSemanticProfile(profilePath: string) {
  const binding = getBinding() as any;
  if (typeof binding.loadSemanticProfile !== 'function') {
    throw new Error('loadSemanticProfile is unavailable in native binding');
  }
  return binding.loadSemanticProfile(profilePath);
}

export function getSemanticProfileJson() {
  const binding = getBinding() as any;
  if (typeof binding.getSemanticProfileJson !== 'function') {
    return null;
  }
  return binding.getSemanticProfileJson();
}

export function clearSemanticProfile() {
  const binding = getBinding() as any;
  if (typeof binding.clearSemanticProfile !== 'function') {
    throw new Error('clearSemanticProfile is unavailable in native binding');
  }
  return binding.clearSemanticProfile();
}



export function setSemanticProfileJson(content: string): string {
  const binding = getBinding() as any;
  if (typeof binding.setSemanticProfileJson !== 'function') {
    throw new Error('setSemanticProfileJson is unavailable in native binding');
  }
  return binding.setSemanticProfileJson(content);
}
