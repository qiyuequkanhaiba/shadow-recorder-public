export { REQCASE_SHADOW_RECORDER_CHANNELS } from './ipc-channels';
export { registerReqCaseShadowRecorderIpc } from './ipc';
export { ReqCaseShadowRecorderService } from './service';
export { exportShadowRecorderReport } from './report-export';
export { exportTestSessionEvidence } from './evidence-export';
export { exportTuningSnapshot } from './tuning-snapshot';
export { exportDiagnosticsBundle, recorderDiagnosticsErrorLog } from './diagnostics';

export type {
  ReqCaseShadowRecorderConfig,
  ReqCaseShadowRecorderExportInput,
  ReqCaseShadowRecorderExportResult,
  ReqCaseShadowRecorderMetrics,
  ReqCaseShadowRecorderResourceUsage,
  ReqCaseShadowRecorderRuntimeHealth,
  ReqCaseShadowRecorderPersistedSettings,
  ReqCaseShadowRecorderStep,
  ReqCaseShadowRecorderDisplayTarget,
  ReqCaseShadowRecorderTestSessionLogInput,
  ReqCaseShadowRecorderTestSessionNoteInput,
  ReqCaseShadowRecorderTestSessionStartInput,
  ReqCaseShadowRecorderTestSessionPlaybackFocus,
  ReqCaseShadowRecorderTestSessionEvidenceExportInput,
  ReqCaseShadowRecorderTestSessionEvidenceExportResult,
  ReqCaseShadowRecorderTestSessionTimelineEventTailResult,
  ReqCaseShadowRecorderTestSessionVideoSegment,
  ReqCaseShadowRecorderTestSessionVideoSegmentTailResult,
  ReqCaseShadowRecorderTestSessionVideoStream,
  ReqCaseShadowRecorderTestSessionState,
  ReqCaseShadowRecorderTestSessionTimelineEvent,
  ReqCaseShadowRecorderTestSessionOperationDetailInput,
  ReqCaseShadowRecorderTestSessionOperationListInput,
  ReqCaseShadowRecorderTestSessionOperationRebuildInput,
  ReqCaseShadowRecorderTestSessionOperationRecord,
  ReqCaseShadowRecorderTestSessionOperationTailResult,
  ReqCaseShadowRecorderTestSessionOperationUpdateInput,
  ReqCaseShadowRecorderTuningSnapshotExportInput,
  ReqCaseShadowRecorderTuningSnapshotExportResult,
  ReqCaseShadowRecorderTuningProfile,
} from './types';
export type { DiagnosticsBundle, DiagnosticsExportResult } from './diagnostics';
