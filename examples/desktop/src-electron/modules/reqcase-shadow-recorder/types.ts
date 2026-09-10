import type {
  RecorderConfigPayload,
  RecorderMetrics,
  RecorderPersistedSettings,
  ReplayStepGenerateInput,
  ReplayStepGenerateResult,
  TestSessionLogInput,
  TestSessionNoteInput,
  TestSessionDisplayTarget,
  TestSessionStartInput,
  TestSessionState,
  TestSessionTimelineEvent,
  TestSessionTimelineEventTailResult,
  TestSessionPlaybackFocus,
  TestSessionVideoSegment,
  TestSessionVideoSegmentTailResult,
  TestSessionVideoStream,
  TestSessionEvidenceExportInput,
  TestSessionEvidenceExportResult,
  TestSessionOperationDetailInput,
  TestSessionOperationListInput,
  TestSessionOperationRebuildInput,
  TestSessionOperationRecord,
  TestSessionOperationTailResult,
  TestSessionOperationUpdateInput,
  ReportTuningSummary,
  StructuredStepAction,
  StructuredStepContext,
  RecorderStep,
  RecorderResourceUsage,
  RecorderRuntimeHealth,
  TuningSnapshotExportInput,
  TuningSnapshotExportResult,
  RecorderTuningProfile,
} from '../../../types/contracts';

export type ReqCaseShadowRecorderConfig = RecorderConfigPayload;
export type ReqCaseShadowRecorderStructuredStepAction = StructuredStepAction;
export type ReqCaseShadowRecorderStructuredStepContext = StructuredStepContext;
export type ReqCaseShadowRecorderStep = RecorderStep;
export type ReqCaseShadowRecorderResourceUsage = RecorderResourceUsage;
export type ReqCaseShadowRecorderRuntimeHealth = RecorderRuntimeHealth;
export type ReqCaseShadowRecorderTuningProfile = RecorderTuningProfile;
export type ReqCaseShadowRecorderPersistedSettings = RecorderPersistedSettings;
export type ReqCaseShadowRecorderReplayStepGenerateInput = ReplayStepGenerateInput;
export type ReqCaseShadowRecorderReplayStepGenerateResult = ReplayStepGenerateResult;
export type ReqCaseShadowRecorderTestSessionLogInput = TestSessionLogInput;
export type ReqCaseShadowRecorderTestSessionNoteInput = TestSessionNoteInput;
export type ReqCaseShadowRecorderDisplayTarget = TestSessionDisplayTarget;
export type ReqCaseShadowRecorderTestSessionStartInput = TestSessionStartInput;
export type ReqCaseShadowRecorderTestSessionState = TestSessionState;
export type ReqCaseShadowRecorderTestSessionTimelineEvent = TestSessionTimelineEvent;
export type ReqCaseShadowRecorderTestSessionTimelineEventTailResult = TestSessionTimelineEventTailResult;
export type ReqCaseShadowRecorderTestSessionPlaybackFocus = TestSessionPlaybackFocus;
export type ReqCaseShadowRecorderTestSessionVideoStream = TestSessionVideoStream;
export type ReqCaseShadowRecorderTestSessionVideoSegment = TestSessionVideoSegment;
export type ReqCaseShadowRecorderTestSessionVideoSegmentTailResult = TestSessionVideoSegmentTailResult;
export type ReqCaseShadowRecorderTestSessionEvidenceExportInput = TestSessionEvidenceExportInput;
export type ReqCaseShadowRecorderTestSessionEvidenceExportResult = TestSessionEvidenceExportResult;
export type ReqCaseShadowRecorderTestSessionOperationRecord = TestSessionOperationRecord;
export type ReqCaseShadowRecorderTestSessionOperationTailResult = TestSessionOperationTailResult;
export type ReqCaseShadowRecorderTestSessionOperationDetailInput = TestSessionOperationDetailInput;
export type ReqCaseShadowRecorderTestSessionOperationListInput = TestSessionOperationListInput;
export type ReqCaseShadowRecorderTestSessionOperationRebuildInput = TestSessionOperationRebuildInput;
export type ReqCaseShadowRecorderTestSessionOperationUpdateInput = TestSessionOperationUpdateInput;
export type ReqCaseShadowRecorderTuningSnapshotExportInput = TuningSnapshotExportInput;
export type ReqCaseShadowRecorderTuningSnapshotExportResult = TuningSnapshotExportResult;

export interface ReqCaseShadowRecorderExportInput {
  targetDir: string;
  title?: string;
  tuningSummary?: ReportTuningSummary;
  manifestMode?: 'full' | 'lite';
  generatedAtMs?: number;
}

export interface ReqCaseShadowRecorderExportResult {
  htmlPath: string;
  manifestPath: string;
  imageCount: number;
  tuningSnapshotPath?: string;
  sessionId?: string;
  outputMode?: 'directory' | 'zip';
  bundleRootName?: string;
  artifactPath?: string;
  zipPath?: string;
  exportDir?: string;
  sessionCopyDir?: string;
  summaryHtmlPath?: string;
  operationsJsonPath?: string;
  operationsCsvPath?: string;
  checksumManifestPath?: string;
  checksumManifestRelativePath?: string;
  checksumEntryCount?: number;
  artifactSha256Path?: string;
  artifactSha256?: string;
  generatedAtMs?: number;
  eventCount?: number;
  stepEventCount?: number;
  videoStreamCount?: number;
  videoSegmentCount?: number;
  playableVideoSegmentCount?: number;
  copiedFileCount?: number;
  copiedBytes?: number;
}

export type ReqCaseShadowRecorderMetrics = RecorderMetrics;
