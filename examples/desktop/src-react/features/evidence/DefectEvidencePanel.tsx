/**
 * Compatibility export for the recording review panel.
 * Prefer importing `RecordingReviewPanel` for new code.
 * Visible product copy remains “记录与回顾”.
 */
export {
  DefectEvidencePanel,
  RecordingReviewPanel,
  type DefectEvidencePanelProps,
  type RecordingReviewPanelProps,
} from './RecordingReviewPanel';

/** @deprecated Legacy step shape — use TestSessionOperationRecord via operation-adapter. */
export type SemanticStep = {
  stepId: string;
  sessionId: string;
  startedAtMs: number;
  endedAtMs: number;
  relativeMsFromSessionStart: number;
  stepType: string;
  title: string;
  summary: string;
  processName?: string;
  windowTitle?: string;
  controlName?: string;
  controlType?: string;
  automationId?: string;
  precisionLevel?: string;
  confidence?: number;
  fullImagePath?: string;
  thumbImagePath?: string;
  x?: number;
  y?: number;
  displayId?: string;
};
