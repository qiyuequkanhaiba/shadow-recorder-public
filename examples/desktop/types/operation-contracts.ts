export const TEST_SESSION_OPERATION_SCHEMA_VERSION = 1 as const;
export const TEST_SESSION_OPERATION_KIND = 'reqcase.test-session-operation' as const;
export const TEST_SESSION_OPERATION_BUILDER_VERSION = 'operation-builder-v1' as const;

export const KNOWN_OPERATION_ACTION_KINDS = [
  'click',
  'doubleClick',
  'rightClick',
  'toggle',
  'select',
  'expand',
  'collapse',
  'typeSummary',
  'shortcut',
  'scroll',
  'windowSwitch',
  'manualMark',
] as const;

export const KNOWN_OPERATION_OUTCOME_STATUSES = [
  'confirmed',
  'candidate',
  'ambiguous',
  'incomplete',
  'observerDegraded',
  'legacyUnknown',
] as const;

export const KNOWN_OPERATION_OUTCOME_SELECTION_SOURCES = ['auto', 'manual'] as const;

export const KNOWN_STATE_TRANSITION_KINDS = [
  'property',
  'lifecycle',
  'structure',
  'observerHealth',
  'artifact',
] as const;

export const KNOWN_OPERATION_EVIDENCE_KINDS = [
  'rawEvent',
  'uiaSnapshot',
  'stateTransition',
  'screenshot',
  'videoRange',
  'manualNote',
] as const;

export const KNOWN_OPERATION_EVIDENCE_ROLES = [
  'supportsTarget',
  'supportsOutcome',
  'context',
  'contradicts',
] as const;

export const KNOWN_OPERATION_PRIVACY_CLASSES = [
  'not-sensitive',
  'text-length-only',
  'password-redacted',
  'sensitive-redacted',
  'unknown',
] as const;

type ForwardCompatibleString<T extends string> = T | (string & {});

export type KnownOperationActionKind = (typeof KNOWN_OPERATION_ACTION_KINDS)[number];
export type OperationActionKind = ForwardCompatibleString<KnownOperationActionKind>;

export type KnownOperationOutcomeStatus = (typeof KNOWN_OPERATION_OUTCOME_STATUSES)[number];
export type OperationOutcomeStatus = ForwardCompatibleString<KnownOperationOutcomeStatus>;

export type OperationOutcomeSelectionSource =
  (typeof KNOWN_OPERATION_OUTCOME_SELECTION_SOURCES)[number];

export type StateTransitionKind = ForwardCompatibleString<
  (typeof KNOWN_STATE_TRANSITION_KINDS)[number]
>;

export type OperationEvidenceKind = ForwardCompatibleString<
  (typeof KNOWN_OPERATION_EVIDENCE_KINDS)[number]
>;

export type OperationEvidenceRole = ForwardCompatibleString<
  (typeof KNOWN_OPERATION_EVIDENCE_ROLES)[number]
>;

export type OperationPrivacyClass = ForwardCompatibleString<
  (typeof KNOWN_OPERATION_PRIVACY_CLASSES)[number]
>;

export interface OperationUiElementPathEntry {
  controlType?: string | null;
  name?: string | null;
  automationId?: string | null;
}

export interface OperationUiBoundingRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OperationUiElementIdentity {
  runtimeId?: number[] | null;
  processId?: number | null;
  windowHwnd?: string | null;
  name?: string | null;
  automationId?: string | null;
  controlType?: string | null;
  localizedControlType?: string | null;
  className?: string | null;
  frameworkId?: string | null;
  parentPath: OperationUiElementPathEntry[];
  boundingRect?: OperationUiBoundingRect | null;
}

export interface OperationUiStateSnapshot {
  snapshotId: string;
  capturedAtMs: number;
  element?: OperationUiElementIdentity | null;
  isEnabled?: boolean | null;
  hasKeyboardFocus?: boolean | null;
  isOffscreen?: boolean | null;
  valueLength?: number | null;
  valueText?: string | null;
  valueFingerprint?: string | null;
  toggleState?: string | null;
  selectionState?: string | null;
  selectedNames?: string[] | null;
  expandCollapseState?: string | null;
  rangeValue?: number | null;
  privacyClass: OperationPrivacyClass;
  source?: string | null;
}

export interface OperationCoordinate {
  x: number;
  y: number;
  displayId?: string | null;
}

export interface OperationActionConfidence {
  target?: number | null;
  temporal?: number | null;
  overall?: number | null;
}

export interface OperationAction {
  actionId: string;
  kind: OperationActionKind;
  occurredAtMs: number;
  endedAtMs?: number | null;
  target?: OperationUiElementIdentity | null;
  stateBefore?: OperationUiStateSnapshot | null;
  coordinate?: OperationCoordinate | null;
  sourceEventIds: string[];
  targetReasonCodes: string[];
  confidence: OperationActionConfidence;
  /** Typed text / selected option / path value for repro steps. */
  contentPreview?: string | null;
}

export interface StateTransitionConfidence {
  identity?: number | null;
  temporal?: number | null;
  transition?: number | null;
  overall?: number | null;
}

export interface StateTransition {
  transitionId: string;
  kind: StateTransitionKind;
  occurredAtMs: number;
  element?: OperationUiElementIdentity | null;
  property?: string | null;
  before?: string | null;
  after?: string | null;
  privacyClass: OperationPrivacyClass;
  sourceEventIds: string[];
  reasonCodes: string[];
  confidence: StateTransitionConfidence;
}

export interface OperationOutcomeConfidence {
  temporal?: number | null;
  identity?: number | null;
  transition?: number | null;
  evidence?: number | null;
  overall?: number | null;
}

export interface OperationOutcome {
  outcomeId: string;
  status: OperationOutcomeStatus;
  summary?: string | null;
  observedAtMs: number;
  latencyMs: number;
  primaryTransitionId?: string | null;
  candidateTransitionIds: string[];
  reasonCodes: string[];
  confidence: OperationOutcomeConfidence;
}

export interface OperationVideoRange {
  streamId: string;
  startedAtMs: number;
  endedAtMs: number;
}

export interface OperationEvidence {
  evidenceId: string;
  kind: OperationEvidenceKind;
  role: OperationEvidenceRole;
  sourceId: string;
  occurredAtMs: number;
  artifactRef?: string | null;
  videoRange?: OperationVideoRange | null;
  reasonCode?: string | null;
}

export interface TestSessionOperationRecord {
  schemaVersion: typeof TEST_SESSION_OPERATION_SCHEMA_VERSION;
  kind: typeof TEST_SESSION_OPERATION_KIND;
  operationId: string;
  sessionId: string;
  sequence: number;
  startedAtMs: number;
  endedAtMs: number;
  relativeMsFromSessionStart: number;
  action: OperationAction;
  outcome: OperationOutcome;
  completionCandidates: OperationOutcome[];
  transitions: StateTransition[];
  evidence: OperationEvidence[];
  title: string;
  resultSummary: string;
  displaySummary: string;
  precisionLevel: string;
  outcomeSelectionSource: OperationOutcomeSelectionSource;
  edited: boolean;
  ignored: boolean;
  businessAlias?: string | null;
  manualNote?: string | null;
}

export interface OperationCompatibilityDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error' | (string & {});
  lineNumber?: number;
  schemaVersion?: number;
  message: string;
}

export interface TestSessionOperationTailResult {
  items: TestSessionOperationRecord[];
  nextCursor?: string;
  reset: boolean;
  totalCount: number;
  diagnostics?: OperationCompatibilityDiagnostic[];
}

export interface TestSessionOperationDetailInput {
  sessionId?: string;
  operationId: string;
}

export interface TestSessionOperationListInput {
  sessionId?: string;
  cursor?: string;
  limit: number;
}

export interface TestSessionOperationRebuildInput {
  sessionId?: string;
}

export interface TestSessionOperationUpdateInput {
  sessionId?: string;
  operationId: string;
  title?: string;
  resultSummary?: string;
  selectedOutcomeStatus?: KnownOperationOutcomeStatus;
  selectedTransitionId?: string;
  ignored?: boolean;
  businessAlias?: string;
  note?: string;
  reason?: string;
  occurredAtMs?: number;
}
