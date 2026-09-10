export type RecorderTargetCaptureMode =
  | 'foreground_window'
  | 'target_window'
  | 'process_bind'
  | 'desktop'
  | 'target_display'
  | 'all_displays';

export type RecorderTuningProfile = 'stability' | 'latency' | 'size';

export type TestSessionLogCategory = 'recording' | 'system' | 'operation' | 'app';

export type TestSessionStatus = 'active' | 'paused' | 'stopped';

export type TestSessionVideoStreamStatus = 'planned' | 'active' | 'stopped';

export type TestSessionVideoSegmentStatus = 'planned' | 'ready' | 'missing';

export interface TestSessionDisplayTarget {
  displayId: string;
  label: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  isPrimary: boolean;
}

export type TestSessionTimelineEventType =
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

export type StructuredStepAction = 'click' | 'double_click' | 'right_click' | 'scroll' | 'unknown';

export interface StructuredStepContext {
  stepId: string;
  timestampMs: number;
  action: StructuredStepAction;
  position: { x: number; y: number };
  windowTitle?: string;
  processName?: string;
  captureBackend?: string;
  hasImage: boolean;
  privacyFiltered: boolean;
}

export interface RecorderStep {
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
  imageBytes?: number;
  captureLatencyMs?: number;
  encodeLatencyMs?: number;
  source?: 'hook' | 'raw_input';
  captureBackend?: 'dxgi' | 'wgc';
  structuredContext?: StructuredStepContext;
  [key: string]: unknown;
}

export interface RecorderStepMeta {
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
  imageBytes?: number;
  captureLatencyMs?: number;
  encodeLatencyMs?: number;
  source?: 'hook' | 'raw_input';
  captureBackend?: 'dxgi' | 'wgc';
  [key: string]: unknown;
}

export interface RecorderStepImageRef {
  stepId: string;
  variant: 'thumb' | 'full';
  mimeType: 'image/webp';
  [key: string]: unknown;
}

export interface RecorderMaskRegionPayload {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
}

export type ReplayStepProviderName = 'disabled' | 'mock' | 'openai_compatible';

export interface OpenAiCompatibleConfigPayload {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
}

export interface ReplayStepGenerateInput {
  provider?: ReplayStepProviderName;
  contexts?: StructuredStepContext[];
  aiEnabled?: boolean;
  privacyAcknowledgedAt?: string;
  openAiCompatible?: OpenAiCompatibleConfigPayload;
  [key: string]: unknown;
}

export interface ReplayStepGenerateResult {
  provider: ReplayStepProviderName;
  steps: string[];
  generatedAtMs: number;
  model?: string;
  [key: string]: unknown;
}

export interface RecorderConfigPayload {
  recordingWindowSeconds?: number;
  segmentDurationSeconds?: number;
  recordingProfile?: 'efficiency' | 'balanced' | 'smooth';
  encoderPreference?: 'auto' | 'hardware' | 'software';
  showMouseInVideo?: boolean;
  targetCaptureMode?: RecorderTargetCaptureMode;
  targetDisplayId?: string;
  targetDisplayIds?: string[];
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
  privacyEnabled?: boolean;
  /** When true, capture UIA/keyboard summaries and build defect steps. Default false. */
  defectEvidenceEnabled?: boolean;
  /** Total switch for operation semantic recording. Falls back to defectEvidenceEnabled for legacy settings. */
  semanticRecordingEnabled?: boolean;
  /** Enables the bounded target-process UIA observer. Default false until the observer is available. */
  uiaObserverEnabled?: boolean;
  /** Enables operations.ndjson generation. Default false until the v1 builder is available. */
  operationBuilderEnabled?: boolean;
  /** Enables the operation review v2 UI. Default false during rollout. */
  operationReviewV2Enabled?: boolean;
  /** Explicit opt-in for non-password plaintext input. Default false. */
  semanticPlaintextInputEnabled?: boolean;
  defectPreWindowSeconds?: number;
  defectPostWindowSeconds?: number;
  aiReplayProvider?: ReplayStepProviderName;
  aiReplayOpenAiBaseUrl?: string;
  aiReplayOpenAiApiKey?: string;
  aiReplayOpenAiModel?: string;
  aiReplayOpenAiTimeoutMs?: number;
  aiReplayEnabled?: boolean;
  excludedWindowTitleKeywords?: string[];
  excludedProcessNames?: string[];
  maskRegions?: RecorderMaskRegionPayload[];
  shortcutStartRecording?: string;
  shortcutStopRecording?: string;
  [key: string]: unknown;
}


/** Imported semantic profile persisted in app settings (survives restarts). */
/** One imported semantic profile entry (multi-app library). */
export interface SemanticProfileImportRecord {
  /** Stable id for tabs / activation (defaults to profile.profileId or generated). */
  id: string;
  sourceFileName: string;
  sourcePath?: string;
  importedAtMs: number;
  updatedAtMs?: number;
  /** Normalized profile object (alias/scenario rules, target process, etc.). */
  profile: Record<string, unknown>;
}

export interface RecorderPersistedSettings {
  config?: RecorderConfigPayload;
  autoApplyLastRecommendedProfile?: boolean;
  lastRecommendedProfile?: RecorderTuningProfile;
  lastRecommendationReason?: string;
  /**
   * @deprecated Prefer semanticProfiles + activeSemanticProfileId.
   * Kept for migration of single-profile settings.
   */
  semanticProfile?: SemanticProfileImportRecord | null;
  /** Library of imported profiles (one tab per entry / software). */
  semanticProfiles?: SemanticProfileImportRecord[];
  /** Currently active profile id (loaded into native binding). */
  activeSemanticProfileId?: string | null;
  [key: string]: unknown;
}

export interface TestSessionStartInput {
  name?: string;
  storageDir?: string;
  targetCaptureMode?: RecorderTargetCaptureMode;
  bufferWindowSeconds?: number;
  segmentDurationSeconds?: number;
  showMouseInVideo?: boolean;
  targetProcessName?: string;
  targetPid?: number;
  targetHwnd?: string;
  targetDisplayId?: string;
  targetDisplayIds?: string[];
  recordingProfile?: 'efficiency' | 'balanced' | 'smooth';
  encoderPreference?: 'auto' | 'hardware' | 'software';
  [key: string]: unknown;
}

export interface TestSessionState {
  schemaVersion: 1;
  kind: 'reqcase.test-session';
  sessionId: string;
  name?: string;
  status: TestSessionStatus;
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
  targetCaptureMode: RecorderTargetCaptureMode;
  [key: string]: unknown;
}

export interface TestSessionVideoStream {
  schemaVersion: 1;
  kind: 'reqcase.test-session-video-stream';
  streamId: string;
  sessionId: string;
  label: string;
  status: TestSessionVideoStreamStatus;
  targetCaptureMode: RecorderTargetCaptureMode;
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
  [key: string]: unknown;
}

export interface TestSessionVideoSegment {
  schemaVersion: 1;
  kind: 'reqcase.test-session-video-segment';
  segmentId: string;
  sessionId: string;
  streamId: string;
  status: TestSessionVideoSegmentStatus;
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
  playbackUrl?: string;
  [key: string]: unknown;
}

export interface TestSessionVideoSegmentTailResult {
  items: TestSessionVideoSegment[];
  nextCursor?: string;
  reset: boolean;
  totalCount: number;
}

export interface TestSessionPlaybackFocus {
  sessionId: string;
  eventId?: string;
  occurredAtMs?: number;
  displayId?: string;
  [key: string]: unknown;
}

export interface TestSessionTimelineEvent {
  schemaVersion: 1;
  kind: 'reqcase.test-session-event';
  eventId: string;
  sessionId: string;
  eventType: TestSessionTimelineEventType;
  logCategory: TestSessionLogCategory;
  occurredAtMs: number;
  status?: TestSessionStatus;
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
  structuredContext?: StructuredStepContext;
  [key: string]: unknown;
}

export interface TestSessionTimelineEventTailResult {
  items: TestSessionTimelineEvent[];
  nextCursor?: string;
  reset: boolean;
  totalCount: number;
}

export interface TestSessionNoteInput {
  title?: string;
  message?: string;
  [key: string]: unknown;
}

export interface TestSessionLogInput {
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  source?: string;
  message?: string;
  [key: string]: unknown;
}

export interface TestSessionEvidenceExportInput {
  sessionId?: string;
  targetDir: string;
  bundleName?: string;
  zipFileName?: string;
  outputMode?: 'directory' | 'zip';
  privacyAcknowledgedAt?: string;
  [key: string]: unknown;
}

export interface TestSessionEvidenceExportResult {
  sessionId: string;
  outputMode: 'directory' | 'zip';
  bundleRootName: string;
  artifactPath: string;
  generatedAtMs?: number;
  privacyAcknowledgedAt?: string;
  exportDir?: string;
  zipPath?: string;
  videoDirPath?: string;
  videoDirRelativePath?: string;
  eventsLogPath?: string;
  eventsLogRelativePath?: string;
  sessionCopyDir?: string;
  manifestPath?: string;
  manifestV2Path?: string;
  manifestV2RelativePath?: string;
  summaryHtmlPath?: string;
  summaryHtmlRelativePath?: string;
  operationsJsonPath?: string;
  operationsJsonRelativePath?: string;
  operationsCsvPath?: string;
  operationsCsvRelativePath?: string;
  checksumManifestPath?: string;
  checksumManifestRelativePath?: string;
  checksumEntryCount?: number;
  artifactSha256Path?: string;
  artifactSha256?: string;
  eventCount?: number;
  stepEventCount?: number;
  videoStreamCount?: number;
  videoSegmentCount?: number;
  playableVideoSegmentCount?: number;
  copiedFileCount?: number;
  copiedBytes?: number;
  [key: string]: unknown;
}

export interface ReportTuningSummary {
  profile: RecorderTuningProfile;
  reason: string;
  triggerTags?: string[];
  autoApplyLastRecommendedProfile?: boolean;
  notes?: string;
  config?: RecorderConfigPayload;
  metrics?: RecorderMetrics;
  [key: string]: unknown;
}

export interface TuningSnapshotExportInput {
  targetDir: string;
  profile: RecorderTuningProfile;
  reason: string;
  config: RecorderConfigPayload;
  metrics: RecorderMetrics;
  autoApplyLastRecommendedProfile?: boolean;
  triggerTags?: string[];
  notes?: string;
  generatedAtMs?: number;
  [key: string]: unknown;
}

export interface TuningSnapshotExportResult {
  snapshotPath: string;
  generatedAtMs: number;
  profile: RecorderTuningProfile;
  [key: string]: unknown;
}

export interface RecorderMetrics {
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
  [key: string]: unknown;
}

export interface RecorderResourceUsage {
  capturedAtMs: number;
  sampleWindowMs: number;
  rootCpuPercent: number;
  ffmpegCpuPercent: number;
  totalCpuPercent: number;
  rootWorkingSetMb: number;
  ffmpegWorkingSetMb: number;
  totalWorkingSetMb: number;
  ffmpegProcessCount: number;
  [key: string]: unknown;
}

export interface RecorderRuntimeHealth {
  recording: boolean;
  paused: boolean;
  captureBackend: RecorderConfigPayload['captureBackend'];
  strictBackend: boolean;
  transportMode: RecorderConfigPayload['transportMode'];
  streamPayload: RecorderConfigPayload['streamPayload'];
  deltaMode: RecorderConfigPayload['deltaMode'];
  effectiveDeltaMode?: RecorderConfigPayload['deltaMode'];
  dirtyRectSupported?: boolean;
  metrics: RecorderMetrics;
  resourceUsage?: RecorderResourceUsage | null;
  [key: string]: unknown;
}

export interface TimelineItem {
  id: string;
  timeText: string;
  actionText: string;
  appText: string;
  previewDataUrl: string;
  markerX: number;
  markerY: number;
  timestampMs: number;
  annotation?: string;
  [key: string]: unknown;
}

export {
  KNOWN_OPERATION_ACTION_KINDS,
  KNOWN_OPERATION_EVIDENCE_KINDS,
  KNOWN_OPERATION_EVIDENCE_ROLES,
  KNOWN_OPERATION_OUTCOME_SELECTION_SOURCES,
  KNOWN_OPERATION_OUTCOME_STATUSES,
  KNOWN_OPERATION_PRIVACY_CLASSES,
  KNOWN_STATE_TRANSITION_KINDS,
} from './operation-contracts';

export type {
  KnownOperationActionKind,
  KnownOperationOutcomeStatus,
  OperationCompatibilityDiagnostic,
  OperationAction,
  OperationActionConfidence,
  OperationActionKind,
  OperationCoordinate,
  OperationEvidence,
  OperationEvidenceKind,
  OperationEvidenceRole,
  OperationOutcome,
  OperationOutcomeConfidence,
  OperationOutcomeSelectionSource,
  OperationOutcomeStatus,
  OperationPrivacyClass,
  OperationUiBoundingRect,
  OperationUiElementIdentity,
  OperationUiElementPathEntry,
  OperationUiStateSnapshot,
  OperationVideoRange,
  StateTransition,
  StateTransitionConfidence,
  StateTransitionKind,
  TestSessionOperationDetailInput,
  TestSessionOperationListInput,
  TestSessionOperationRebuildInput,
  TestSessionOperationRecord,
  TestSessionOperationTailResult,
  TestSessionOperationUpdateInput,
} from './operation-contracts';
