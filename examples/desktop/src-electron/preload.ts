import { contextBridge, ipcRenderer } from 'electron';

import type {
  ReqCaseShadowRecorderConfig,
  ReqCaseShadowRecorderDisplayTarget,
  ReqCaseShadowRecorderExportInput,
  ReqCaseShadowRecorderExportResult,
  ReqCaseShadowRecorderMetrics,
  ReqCaseShadowRecorderPersistedSettings,
  ReqCaseShadowRecorderReplayStepGenerateInput,
  ReqCaseShadowRecorderReplayStepGenerateResult,
  ReqCaseShadowRecorderRuntimeHealth,
  ReqCaseShadowRecorderStep,
  ReqCaseShadowRecorderTestSessionLogInput,
  ReqCaseShadowRecorderTestSessionNoteInput,
  ReqCaseShadowRecorderTestSessionOperationDetailInput,
  ReqCaseShadowRecorderTestSessionOperationListInput,
  ReqCaseShadowRecorderTestSessionOperationRebuildInput,
  ReqCaseShadowRecorderTestSessionOperationRecord,
  ReqCaseShadowRecorderTestSessionOperationTailResult,
  ReqCaseShadowRecorderTestSessionOperationUpdateInput,
  ReqCaseShadowRecorderTestSessionEvidenceExportResult,
  ReqCaseShadowRecorderTestSessionVideoSegment,
  ReqCaseShadowRecorderTestSessionVideoSegmentTailResult,
  ReqCaseShadowRecorderTestSessionVideoStream,
  ReqCaseShadowRecorderTestSessionState,
  ReqCaseShadowRecorderTestSessionTimelineEvent,
  ReqCaseShadowRecorderTestSessionTimelineEventTailResult,
  ReqCaseShadowRecorderTuningSnapshotExportInput,
  ReqCaseShadowRecorderTuningSnapshotExportResult,
} from './modules/reqcase-shadow-recorder/types';
import type {
  FloatingToolbarDragCommand,
  FloatingToolbarFitRequest,
  FloatingToolbarMoveRequest,
} from './floating-toolbar-drag-protocol';

type ReqCaseShadowRecorderEvidenceExportRequest = {
  sessionId?: string;
  targetDir: string;
  bundleName?: string;
  zipFileName?: string;
  outputMode?: 'directory' | 'zip';
  privacyAcknowledgedAt?: string;
};

const REQCASE_SHADOW_RECORDER_CHANNELS = {
  start: 'reqcase:shadow-recorder:start',
  stop: 'reqcase:shadow-recorder:stop',
  listAvailableDisplays: 'reqcase:shadow-recorder:list-available-displays',
  getActiveTestSession: 'reqcase:shadow-recorder:get-active-test-session',
  listTestSessions: 'reqcase:shadow-recorder:list-test-sessions',
  getTestSessionOperations: 'reqcase:shadow-recorder:get-test-session-operations',
  getTestSessionOperation: 'reqcase:shadow-recorder:get-test-session-operation',
  rebuildTestSessionOperations: 'reqcase:shadow-recorder:rebuild-test-session-operations',
  updateTestSessionOperation: 'reqcase:shadow-recorder:update-test-session-operation',
  getTestSessionEvents: 'reqcase:shadow-recorder:get-test-session-events',
  getTestSessionEventsTail: 'reqcase:shadow-recorder:get-test-session-events-tail',
  getTestSessionVideoStreams: 'reqcase:shadow-recorder:get-test-session-video-streams',
  getTestSessionVideoSegments: 'reqcase:shadow-recorder:get-test-session-video-segments',
  getTestSessionVideoSegmentsTail: 'reqcase:shadow-recorder:get-test-session-video-segments-tail',
  getTestSessionVideoSegmentsForTimestamp: 'reqcase:shadow-recorder:get-test-session-video-segments-for-timestamp',
  exportTestSessionEvidence: 'reqcase:shadow-recorder:export-test-session-evidence',
  appendTestSessionNote: 'reqcase:shadow-recorder:append-test-session-note',
  appendTestSessionLog: 'reqcase:shadow-recorder:append-test-session-log',
  purgeTestSessionEvents: 'reqcase:shadow-recorder:purge-test-session-events',
  deleteTestSession: 'reqcase:shadow-recorder:delete-test-session',
  subscribeSteps: 'reqcase:shadow-recorder:subscribe-steps',
  unsubscribeSteps: 'reqcase:shadow-recorder:unsubscribe-steps',
  stepEvent: 'reqcase:shadow-recorder:step-event',
  subscribeMetrics: 'reqcase:shadow-recorder:subscribe-metrics',
  unsubscribeMetrics: 'reqcase:shadow-recorder:unsubscribe-metrics',
  metricsEvent: 'reqcase:shadow-recorder:metrics-event',
  setConfig: 'reqcase:shadow-recorder:set-config',
  getBuffer: 'reqcase:shadow-recorder:get-buffer',
  getBufferPage: 'reqcase:shadow-recorder:get-buffer-page',
  getStepImage: 'reqcase:shadow-recorder:get-step-image',
  subscribeStepsV2: 'reqcase:shadow-recorder:subscribe-steps-v2',
  clearBuffer: 'reqcase:shadow-recorder:clear-buffer',
  getBufferSince: 'reqcase:shadow-recorder:get-buffer-since',
  getMetrics: 'reqcase:shadow-recorder:get-metrics',
  runtimeHealth: 'reqcase:shadow-recorder:runtime-health',
  generateReplaySteps: 'reqcase:shadow-recorder:generate-replay-steps',
  getSettings: 'reqcase:shadow-recorder:get-settings',
  setSettings: 'reqcase:shadow-recorder:set-settings',
  hideToTray: 'reqcase:shadow-recorder:hide-to-tray',
  showWindow: 'reqcase:shadow-recorder:show-window',
  setFloatingToolbarCollapsed: 'reqcase:shadow-recorder:set-floating-toolbar-collapsed',
  getFloatingToolbarState: 'reqcase:shadow-recorder:get-floating-toolbar-state',
  setUiTheme: 'reqcase:shadow-recorder:set-ui-theme',
  fitFloatingToolbarSize: 'reqcase:shadow-recorder:fit-floating-toolbar-size',
  moveFloatingToolbar: 'reqcase:shadow-recorder:move-floating-toolbar',
  setFloatingToolbarDragging: 'reqcase:shadow-recorder:set-floating-toolbar-dragging',
  exportReport: 'reqcase:shadow-recorder:export-report',
  exportTuningSnapshot: 'reqcase:shadow-recorder:export-tuning-snapshot',
  actionStart: 'reqcase:shadow-recorder:action-start',
  actionStop: 'reqcase:shadow-recorder:action-stop',
  pause: 'reqcase:shadow-recorder:pause',
  resume: 'reqcase:shadow-recorder:resume',
  isPaused: 'reqcase:shadow-recorder:is-paused',
  exportPdf: 'reqcase:shadow-recorder:export-pdf',
} as const;

export type ReqCaseShadowRecorderRendererApi = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  listAvailableDisplays?: () => Promise<ReqCaseShadowRecorderDisplayTarget[]>;
  getActiveTestSession: () => Promise<ReqCaseShadowRecorderTestSessionState | null>;
  listTestSessions: () => Promise<ReqCaseShadowRecorderTestSessionState[]>;
  getTestSessionOperations?: (
    input?: ReqCaseShadowRecorderTestSessionOperationListInput,
  ) => Promise<ReqCaseShadowRecorderTestSessionOperationTailResult>;
  getTestSessionOperation?: (
    input: ReqCaseShadowRecorderTestSessionOperationDetailInput,
  ) => Promise<ReqCaseShadowRecorderTestSessionOperationRecord | null>;
  rebuildTestSessionOperations?: (
    input?: ReqCaseShadowRecorderTestSessionOperationRebuildInput,
  ) => Promise<ReqCaseShadowRecorderTestSessionOperationRecord[]>;
  updateTestSessionOperation?: (
    input: ReqCaseShadowRecorderTestSessionOperationUpdateInput,
  ) => Promise<ReqCaseShadowRecorderTestSessionOperationRecord>;
  getTestSessionVideoStreams?: (input?: {
    sessionId?: string;
  }) => Promise<ReqCaseShadowRecorderTestSessionVideoStream[]>;
  getTestSessionVideoSegments?: (input?: {
    sessionId?: string;
    streamId?: string;
    limit?: number;
  }) => Promise<ReqCaseShadowRecorderTestSessionVideoSegment[]>;
  getTestSessionVideoSegmentsTail?: (input?: {
    sessionId?: string;
    streamId?: string;
    afterSegmentId?: string;
    limit?: number;
  }) => Promise<ReqCaseShadowRecorderTestSessionVideoSegmentTailResult>;
  getTestSessionVideoSegmentsForTimestamp?: (input?: {
    sessionId?: string;
    occurredAtMs?: number;
    displayId?: string;
    limit?: number;
  }) => Promise<ReqCaseShadowRecorderTestSessionVideoSegment[]>;
  markTestDefect?: (input?: any) => Promise<any>;
  purgeTestSessionEvents?: (input?: { sessionId?: string }) => Promise<{ sessionId: string; cleared: boolean }>;
  deleteTestSession?: (input?: {
    sessionId?: string;
    sessionIds?: string[];
  }) => Promise<{ sessionId?: string; deleted?: boolean | string[]; skipped?: string[] }>;
  getTestSessionSteps?: (input?: any) => Promise<any[]>;
  rebuildTestSessionSteps?: (input?: any) => Promise<any[]>;
  renderTestSessionReproSteps?: (input?: any) => Promise<string>;
  exportTestDefectPack?: (input?: any) => Promise<any>;
  updateTestSessionStep?: (input?: any) => Promise<any>;
  setSemanticAliasProfile?: (input?: any) => Promise<void>;
  getSemanticAliasProfile?: () => Promise<any>;
  loadSemanticProfile?: (input: string | { path: string }) => Promise<string>;
  importSemanticProfile?: () => Promise<string | null>;
  setSemanticProfileJson?: (input: string | { json?: string; profile?: unknown }) => Promise<string>;
  getSemanticProfileJson?: () => Promise<string | null>;
  clearSemanticProfile?: () => Promise<void>;
  setActiveSemanticProfile?: (input: string | { id: string }) => Promise<string | null>;
  removeSemanticProfile?: (input: string | { id: string }) => Promise<void>;
  exportTestSessionEvidence?: (
    input?: ReqCaseShadowRecorderEvidenceExportRequest,
  ) => Promise<ReqCaseShadowRecorderTestSessionEvidenceExportResult>;
  getTestSessionEvents: (input?: {
    sessionId?: string;
    limit?: number;
  }) => Promise<ReqCaseShadowRecorderTestSessionTimelineEvent[]>;
  getTestSessionEventsTail?: (input?: {
    sessionId?: string;
    afterEventId?: string;
    limit?: number;
  }) => Promise<ReqCaseShadowRecorderTestSessionTimelineEventTailResult>;
  appendTestSessionNote: (
    input?: ReqCaseShadowRecorderTestSessionNoteInput,
  ) => Promise<ReqCaseShadowRecorderTestSessionTimelineEvent>;
  appendTestSessionLog: (
    input?: ReqCaseShadowRecorderTestSessionLogInput,
  ) => Promise<ReqCaseShadowRecorderTestSessionTimelineEvent | null>;
  subscribeSteps: () => Promise<void>;
  subscribeStepsV2?: (
    options?: { streamPayload?: 'meta_only' | 'meta_plus_thumb' | 'full' },
  ) => Promise<void>;
  unsubscribeSteps: () => Promise<void>;
  onStep: (handler: (step: ReqCaseShadowRecorderStep) => void) => () => void;
  subscribeMetrics: () => Promise<void>;
  unsubscribeMetrics: () => Promise<void>;
  onMetrics: (handler: (metrics: ReqCaseShadowRecorderMetrics) => void) => () => void;
  setConfig: (config: ReqCaseShadowRecorderConfig) => Promise<void>;
  clearBuffer: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  isPaused: () => Promise<boolean>;
  getBuffer: () => Promise<ReqCaseShadowRecorderStep[]>;
  getBufferPage?: (
    cursor: string,
    limit: number,
    includeImage: boolean,
  ) => Promise<ReqCaseShadowRecorderStep[]>;
  getStepImage?: (stepId: string, variant?: 'thumb' | 'full') => Promise<string | null>;
  getBufferSince: (lastId: string) => Promise<ReqCaseShadowRecorderStep[]>;
  getMetrics: () => Promise<ReqCaseShadowRecorderMetrics>;
  getRuntimeHealth?: () => Promise<ReqCaseShadowRecorderRuntimeHealth>;
  generateReplaySteps?: (
    input?: ReqCaseShadowRecorderReplayStepGenerateInput,
  ) => Promise<ReqCaseShadowRecorderReplayStepGenerateResult>;
  getSettings: () => Promise<ReqCaseShadowRecorderPersistedSettings>;
  setSettings: (
    settings: ReqCaseShadowRecorderPersistedSettings,
  ) => Promise<ReqCaseShadowRecorderPersistedSettings>;
  hideToTray: () => Promise<void>;
  showWindow: () => Promise<void>;
  setFloatingToolbarCollapsed: (collapsed: boolean) => Promise<{ collapsed: boolean }>;
  getFloatingToolbarState?: () => Promise<{ collapsed: boolean; theme?: 'dark' | 'light' }>;
  setUiTheme?: (theme: 'dark' | 'light') => Promise<{ theme: 'dark' | 'light' }>;
  fitFloatingToolbarSize?: (size: FloatingToolbarFitRequest) => Promise<{ width: number; height: number }>;
  moveFloatingToolbar?: (pos: FloatingToolbarMoveRequest) => Promise<{ x: number; y: number }>;
  setFloatingToolbarDragging?: (command: FloatingToolbarDragCommand) => Promise<{
    dragging: boolean;
    accepted: boolean;
  }>;
  exportReport: (input: ReqCaseShadowRecorderExportInput) => Promise<ReqCaseShadowRecorderExportResult>;
  exportPdf: (input: ReqCaseShadowRecorderExportInput) => Promise<ReqCaseShadowRecorderExportResult & { pdfPath?: string }>;
  exportTuningSnapshot: (
    input: ReqCaseShadowRecorderTuningSnapshotExportInput,
  ) => Promise<ReqCaseShadowRecorderTuningSnapshotExportResult>;
  onActionStart: (handler: () => void) => () => void;
  onActionStop: (handler: () => void) => () => void;
};

const api: ReqCaseShadowRecorderRendererApi = {
  start: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.start),
  stop: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.stop),
  listAvailableDisplays: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.listAvailableDisplays),
  getActiveTestSession: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getActiveTestSession),
  listTestSessions: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.listTestSessions),
  getTestSessionOperations: (input) =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getTestSessionOperations, input),
  getTestSessionOperation: (input) =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getTestSessionOperation, input),
  rebuildTestSessionOperations: (input) =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.rebuildTestSessionOperations, input),
  updateTestSessionOperation: (input) =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.updateTestSessionOperation, input),
  getTestSessionVideoStreams: (input) =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getTestSessionVideoStreams, input),
  getTestSessionVideoSegments: (input) =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getTestSessionVideoSegments, input),
  getTestSessionVideoSegmentsTail: (input) =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getTestSessionVideoSegmentsTail, input),
  getTestSessionVideoSegmentsForTimestamp: (input) =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getTestSessionVideoSegmentsForTimestamp, input),
  exportTestSessionEvidence: (input) =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.exportTestSessionEvidence, input),
  getTestSessionEvents: (input) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getTestSessionEvents, input),
  getTestSessionEventsTail: (input) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getTestSessionEventsTail, input),
  appendTestSessionNote: (input) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.appendTestSessionNote, input),
  appendTestSessionLog: (input) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.appendTestSessionLog, input),

    markTestDefect: (input?: any) => ipcRenderer.invoke('reqcase:shadow-recorder:mark-test-defect', input),
    purgeTestSessionEvents: (input?: { sessionId?: string }) =>
      ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.purgeTestSessionEvents, input),
    deleteTestSession: (input?: { sessionId?: string; sessionIds?: string[] }) =>
      ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.deleteTestSession, input),
    getTestSessionSteps: (input?: any) => ipcRenderer.invoke('reqcase:shadow-recorder:get-test-session-steps', input),
    rebuildTestSessionSteps: (input?: any) => ipcRenderer.invoke('reqcase:shadow-recorder:rebuild-test-session-steps', input),
    renderTestSessionReproSteps: (input?: any) => ipcRenderer.invoke('reqcase:shadow-recorder:render-test-session-repro-steps', input),
    exportTestDefectPack: (input?: any) => ipcRenderer.invoke('reqcase:shadow-recorder:export-test-defect-pack', input),
    updateTestSessionStep: (input?: any) => ipcRenderer.invoke('reqcase:shadow-recorder:update-test-session-step', input),
    setSemanticAliasProfile: (input?: any) => ipcRenderer.invoke('reqcase:shadow-recorder:set-semantic-alias-profile', input),
    getSemanticAliasProfile: () => ipcRenderer.invoke('reqcase:shadow-recorder:get-semantic-alias-profile'),
    loadSemanticProfile: (input) => ipcRenderer.invoke('reqcase:shadow-recorder:load-semantic-profile', input),
    importSemanticProfile: () => ipcRenderer.invoke('reqcase:shadow-recorder:import-semantic-profile'),
    setSemanticProfileJson: (input) => ipcRenderer.invoke('reqcase:shadow-recorder:set-semantic-profile-json', input),
    getSemanticProfileJson: () => ipcRenderer.invoke('reqcase:shadow-recorder:get-semantic-profile-json'),
    clearSemanticProfile: () => ipcRenderer.invoke('reqcase:shadow-recorder:clear-semantic-profile'),
    setActiveSemanticProfile: (input) => ipcRenderer.invoke('reqcase:shadow-recorder:set-active-semantic-profile', input),
    removeSemanticProfile: (input) => ipcRenderer.invoke('reqcase:shadow-recorder:remove-semantic-profile', input),

  subscribeSteps: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.subscribeSteps),
  subscribeStepsV2: (options) =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.subscribeStepsV2, options),
  unsubscribeSteps: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.unsubscribeSteps),
  onStep: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, step: ReqCaseShadowRecorderStep) => {
      handler(step);
    };
    ipcRenderer.on(REQCASE_SHADOW_RECORDER_CHANNELS.stepEvent, listener);
    return () => {
      ipcRenderer.removeListener(REQCASE_SHADOW_RECORDER_CHANNELS.stepEvent, listener);
    };
  },
  subscribeMetrics: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.subscribeMetrics),
  unsubscribeMetrics: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.unsubscribeMetrics),
  onMetrics: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, metrics: ReqCaseShadowRecorderMetrics) => {
      handler(metrics);
    };
    ipcRenderer.on(REQCASE_SHADOW_RECORDER_CHANNELS.metricsEvent, listener);
    return () => {
      ipcRenderer.removeListener(REQCASE_SHADOW_RECORDER_CHANNELS.metricsEvent, listener);
    };
  },
  setConfig: (config) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.setConfig, config),
  getBuffer: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getBuffer),
  getBufferPage: (cursor, limit, includeImage) =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getBufferPage, {
      cursor,
      limit,
      includeImage,
    }),
  getStepImage: (stepId, variant) =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getStepImage, { stepId, variant }),
  clearBuffer: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.clearBuffer),
  pause: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.pause),
  resume: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.resume),
  isPaused: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.isPaused),
  getBufferSince: (lastId) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getBufferSince, lastId),
  getMetrics: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getMetrics),
  getRuntimeHealth: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.runtimeHealth),
  generateReplaySteps: (input) =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.generateReplaySteps, input),
  getSettings: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getSettings),
  setSettings: (settings) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.setSettings, settings),
  hideToTray: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.hideToTray),
  showWindow: () => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.showWindow),
  setFloatingToolbarCollapsed: (collapsed) =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.setFloatingToolbarCollapsed, collapsed),
  getFloatingToolbarState: () =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.getFloatingToolbarState),
  setUiTheme: (theme: 'dark' | 'light') => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.setUiTheme, theme),
  fitFloatingToolbarSize: (size: FloatingToolbarFitRequest) =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.fitFloatingToolbarSize, size),
  moveFloatingToolbar: (pos: FloatingToolbarMoveRequest) =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.moveFloatingToolbar, pos),
  setFloatingToolbarDragging: (command: FloatingToolbarDragCommand) =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.setFloatingToolbarDragging, command),
  exportReport: (input) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.exportReport, input),
  exportPdf: (input) => ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.exportPdf, input),
  exportTuningSnapshot: (input) =>
    ipcRenderer.invoke(REQCASE_SHADOW_RECORDER_CHANNELS.exportTuningSnapshot, input),
  onActionStart: (handler) => {
    const listener = () => handler();
    ipcRenderer.on(REQCASE_SHADOW_RECORDER_CHANNELS.actionStart, listener);
    return () => {
      ipcRenderer.removeListener(REQCASE_SHADOW_RECORDER_CHANNELS.actionStart, listener);
    };
  },
  onActionStop: (handler) => {
    const listener = () => handler();
    ipcRenderer.on(REQCASE_SHADOW_RECORDER_CHANNELS.actionStop, listener);
    return () => {
      ipcRenderer.removeListener(REQCASE_SHADOW_RECORDER_CHANNELS.actionStop, listener);
    };
  },
};

contextBridge.exposeInMainWorld('reqcaseShadowRecorder', api);
