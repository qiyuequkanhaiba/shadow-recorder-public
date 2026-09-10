import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Notification as ElectronNotification } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import { REQCASE_SHADOW_RECORDER_CHANNELS } from './ipc-channels';
import {
  ExportEvidenceInputSchema,
  GetBufferPageInputSchema,
  RecorderConfigSchema,
  RecorderSettingsSchema,
  ReplayStepGenerateInputSchema,
  parseIpcInput,
} from './ipc-validators';
import {
  OperationDetailInputSchema,
  OperationListInputSchema,
  OperationRebuildInputSchema,
  OperationUpdateInputSchema,
  parseOperationIpcInput,
} from './operation-ipc-validators';
import {
  shouldBroadcastMetricsSnapshot,
  shouldPublishStepDrivenMetrics,
} from './metrics-stream';
import { exportDiagnosticsBundle, recorderDiagnosticsErrorLog } from './diagnostics';
import { exportReportInUtilityProcess } from './utility-export';
import {
  DEFAULT_RECORDING_WINDOW_SECONDS,
  DEFAULT_SEGMENT_DURATION_SECONDS,
  deriveInternalMaxSteps,
} from '../../../types/recording-defaults';
import {
  loadRecorderSettings,
  sanitizeRecorderSettings,
  saveRecorderSettings,
} from './settings-store';
import { ReqCaseShadowRecorderService } from './service';
import {
  isFloatingToolbarDragCommand,
  isFloatingToolbarFitRequest,
  isFloatingToolbarMoveRequest,
  type FloatingToolbarDragCommand,
  type FloatingToolbarFitRequest,
  type FloatingToolbarMoveRequest,
} from '../../floating-toolbar-drag-protocol';
import type {
  ReqCaseShadowRecorderConfig,
  ReqCaseShadowRecorderExportInput,
  ReqCaseShadowRecorderMetrics,
  ReqCaseShadowRecorderPersistedSettings,
  ReqCaseShadowRecorderReplayStepGenerateInput,
  ReqCaseShadowRecorderTestSessionEvidenceExportInput,
  ReqCaseShadowRecorderTestSessionLogInput,
  ReqCaseShadowRecorderTestSessionNoteInput,
  ReqCaseShadowRecorderTuningProfile,
  ReqCaseShadowRecorderTuningSnapshotExportInput,
} from './types';

const METRICS_PUSH_INTERVAL_MS = 1500;
const METRICS_PUSH_STEP_MIN_INTERVAL_MS = 500;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${label}: expected object payload`);
  }
  return value;
}

function optionalString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(record: UnknownRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(record: UnknownRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function ensureOptionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Invalid ${field}: ${String(value)}`);
  }
  return value as T;
}

function ensureString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${field}: expected string`);
  }
  return value;
}

function parseSubscribeStepsV2Input(input: unknown): {
  streamPayload?: 'meta_only' | 'meta_plus_thumb' | 'full';
} {
  if (input === undefined || input === null) {
    return {};
  }

  const record = requireRecord(input, 'subscribeStepsV2');
  return {
    streamPayload: ensureOptionalEnum(
      record.streamPayload,
      ['meta_only', 'meta_plus_thumb', 'full'],
      'streamPayload',
    ),
  };
}

function parseGetBufferPageInput(input: unknown): {
  cursor: string;
  limit: number;
  includeImage: boolean;
} {
  return parseIpcInput(GetBufferPageInputSchema, input, 'getBufferPage');
}

function parseGetStepImageInput(input: unknown): {
  stepId: string;
  variant: 'thumb' | 'full';
} {
  const record = requireRecord(input, 'getStepImage');
  const stepId = ensureString(record.stepId, 'stepId');
  const variant = ensureOptionalEnum(record.variant, ['thumb', 'full'], 'variant') ?? 'full';
  return { stepId, variant };
}

function parseGetBufferSinceInput(input: unknown): string {
  return ensureString(input, 'lastId');
}

function parseReportInput(input: unknown): ReqCaseShadowRecorderExportInput {
  const record = requireRecord(input, 'exportReport');
  const targetDir = ensureString(record.targetDir, 'targetDir');
  const manifestMode =
    ensureOptionalEnum(record.manifestMode, ['full', 'lite'], 'manifestMode') ?? undefined;
  return {
    ...(record as unknown as ReqCaseShadowRecorderExportInput),
    targetDir,
    manifestMode,
  };
}

function parseReplayStepGenerateInput(input: unknown): ReqCaseShadowRecorderReplayStepGenerateInput {
  return parseIpcInput(ReplayStepGenerateInputSchema, input, 'generateReplaySteps');
}

function parseConfigInput(input: unknown): ReqCaseShadowRecorderConfig {
  return parseIpcInput(RecorderConfigSchema, input, 'setConfig');
}

function parseSettingsInput(input: unknown): ReqCaseShadowRecorderPersistedSettings {
  return parseIpcInput(RecorderSettingsSchema, input, 'setSettings');
}

function parseDiagnosticsInput(input: unknown): { targetDir: string } {
  const record = requireRecord(input, 'exportDiagnostics');
  return { targetDir: ensureString(record.targetDir, 'targetDir') };
}

function parseTuningSnapshotInput(input: unknown): ReqCaseShadowRecorderTuningSnapshotExportInput {
  const record = requireRecord(input, 'exportTuningSnapshot');
  return {
    ...(record as unknown as ReqCaseShadowRecorderTuningSnapshotExportInput),
    targetDir: ensureString(record.targetDir, 'targetDir'),
    profile: ensureOptionalEnum(record.profile, ['stability', 'latency', 'size'], 'profile')
      ?? 'stability',
    reason: ensureString(record.reason, 'reason'),
  };
}

function parseGetTestSessionEventsInput(input: unknown): {
  sessionId?: string;
  limit?: number;
} {
  if (input === undefined || input === null) {
    return {};
  }

  const record = requireRecord(input, 'getTestSessionEvents');
  return {
    sessionId: optionalString(record, 'sessionId'),
    limit: optionalNumber(record, 'limit'),
  };
}

function parseGetTestSessionEventsTailInput(input: unknown): {
  sessionId?: string;
  afterEventId?: string;
  limit?: number;
} {
  if (input === undefined || input === null) {
    return {};
  }

  const record = requireRecord(input, 'getTestSessionEventsTail');
  return {
    sessionId: optionalString(record, 'sessionId'),
    afterEventId: optionalString(record, 'afterEventId'),
    limit: optionalNumber(record, 'limit'),
  };
}

function parseGetTestSessionVideoStreamsInput(input: unknown): {
  sessionId?: string;
} {
  if (input === undefined || input === null) {
    return {};
  }

  const record = requireRecord(input, 'getTestSessionVideoStreams');
  return {
    sessionId: optionalString(record, 'sessionId'),
  };
}

function parseGetTestSessionVideoSegmentsInput(input: unknown): {
  sessionId?: string;
  streamId?: string;
  limit?: number;
} {
  if (input === undefined || input === null) {
    return {};
  }

  const record = requireRecord(input, 'getTestSessionVideoSegments');
  return {
    sessionId: optionalString(record, 'sessionId'),
    streamId: optionalString(record, 'streamId'),
    limit: optionalNumber(record, 'limit'),
  };
}

function parseGetTestSessionVideoSegmentsTailInput(input: unknown): {
  sessionId?: string;
  streamId?: string;
  afterSegmentId?: string;
  limit?: number;
} {
  if (input === undefined || input === null) {
    return {};
  }

  const record = requireRecord(input, 'getTestSessionVideoSegmentsTail');
  return {
    sessionId: optionalString(record, 'sessionId'),
    streamId: optionalString(record, 'streamId'),
    afterSegmentId: optionalString(record, 'afterSegmentId'),
    limit: optionalNumber(record, 'limit'),
  };
}

function parseGetTestSessionVideoSegmentsForTimestampInput(input: unknown): {
  sessionId?: string;
  occurredAtMs?: number;
  displayId?: string;
  limit?: number;
} {
  if (input === undefined || input === null) {
    return {};
  }

  const record = requireRecord(input, 'getTestSessionVideoSegmentsForTimestamp');
  return {
    sessionId: optionalString(record, 'sessionId'),
    occurredAtMs: optionalNumber(record, 'occurredAtMs'),
    displayId: optionalString(record, 'displayId'),
    limit: optionalNumber(record, 'limit'),
  };
}

function parseTestSessionNoteInput(input: unknown): ReqCaseShadowRecorderTestSessionNoteInput {
  if (input === undefined || input === null) {
    return {};
  }

  const record = requireRecord(input, 'appendTestSessionNote');
  return {
    title: optionalString(record, 'title'),
    message: optionalString(record, 'message'),
  };
}

function parseTestSessionLogInput(input: unknown): ReqCaseShadowRecorderTestSessionLogInput {
  if (input === undefined || input === null) {
    return {};
  }

  const record = requireRecord(input, 'appendTestSessionLog');
  return {
    level: ensureOptionalEnum(record.level, ['trace', 'debug', 'info', 'warn', 'error'], 'level'),
    source: optionalString(record, 'source'),
    message: optionalString(record, 'message'),
  };
}

function parseTestSessionEvidenceExportInput(
  input: unknown,
): ReqCaseShadowRecorderTestSessionEvidenceExportInput {
  return parseIpcInput(ExportEvidenceInputSchema, input, 'exportTestSessionEvidence');
}

function classifyOperationIpcError(message: string): string {
  if (/validation failed|invalid/i.test(message)) {
    return 'invalid';
  }
  if (/unavailable|not available|missing|stale/i.test(message)) {
    return 'unavailable';
  }
  if (/corrupt|invalid json|parse/i.test(message)) {
    return 'corrupt';
  }
  if (/rebuild/i.test(message)) {
    return 'rebuild failed';
  }
  if (/observer degraded/i.test(message)) {
    return 'observer degraded';
  }
  return 'failed';
}

function withOperationIpcErrors<T>(label: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} ${classifyOperationIpcError(message)}: ${message}`);
  }
}

function resolveEvidenceZipSaveDialogFileName(
  input: ReqCaseShadowRecorderTestSessionEvidenceExportInput,
): string {
  const fallbackName = input.sessionId?.trim()
    ? `evidence-${input.sessionId.trim()}`
    : 'evidence.zip';
  const preferredName = input.zipFileName?.trim() || input.bundleName?.trim() || fallbackName;
  const safeName = path.basename(preferredName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  const fileName = safeName || 'evidence.zip';
  return /\.zip$/i.test(fileName) ? fileName : `${fileName}.zip`;
}

function resolveEvidenceZipSaveDialogDefaultPath(
  input: ReqCaseShadowRecorderTestSessionEvidenceExportInput,
): string {
  const targetDir = input.targetDir?.trim() || app.getPath('documents');
  return path.join(targetDir, resolveEvidenceZipSaveDialogFileName(input));
}

const DEFAULT_BASELINE_CONFIG: ReqCaseShadowRecorderConfig = {
  recordingWindowSeconds: DEFAULT_RECORDING_WINDOW_SECONDS,
  segmentDurationSeconds: DEFAULT_SEGMENT_DURATION_SECONDS,
  recordingProfile: 'balanced',
  encoderPreference: 'auto',
  targetCaptureMode: 'target_display',
  maxSteps: deriveInternalMaxSteps(DEFAULT_RECORDING_WINDOW_SECONDS),
  maxBufferBytes: 150 * 1024 * 1024,
  debounceMs: 120,
  webpQuality: 75,
  thumbWebpQuality: 45,
  adaptiveQualityEnabled: true,
  adaptiveBufferHighRatio: 0.8,
  adaptiveBufferLowRatio: 0.55,
  adaptiveLatencyHighMs: 90,
  adaptiveLatencyLowMs: 45,
  adaptiveTargetImageKb: 100,
  adaptiveStepDown: 6,
  adaptiveStepUp: 2,
  adaptiveMinQuality: 25,
  adaptiveMaxQuality: 90,
  inputMode: 'auto',
  captureBackend: 'auto',
  strictBackend: false,
  deltaMode: 'hash_dedup',
  transportMode: 'push',
  streamPayload: 'meta_only',
  captureReuseEnabled: true,
};

function createPresetConfig(
  baseConfig: ReqCaseShadowRecorderConfig,
  profile: ReqCaseShadowRecorderTuningProfile,
): ReqCaseShadowRecorderConfig {
  if (profile === 'stability') {
    return {
      ...baseConfig,
      adaptiveQualityEnabled: true,
      webpQuality: 70,
      adaptiveBufferHighRatio: 0.76,
      adaptiveBufferLowRatio: 0.5,
      adaptiveLatencyHighMs: 110,
      adaptiveLatencyLowMs: 55,
      adaptiveTargetImageKb: 95,
      adaptiveStepDown: 7,
      adaptiveStepUp: 1.5,
      adaptiveMinQuality: 22,
      adaptiveMaxQuality: 85,
      maxBufferBytes: Math.max(baseConfig.maxBufferBytes ?? 150 * 1024 * 1024, 180 * 1024 * 1024),
    };
  }

  if (profile === 'latency') {
    return {
      ...baseConfig,
      adaptiveQualityEnabled: true,
      webpQuality: 62,
      adaptiveBufferHighRatio: 0.7,
      adaptiveBufferLowRatio: 0.45,
      adaptiveLatencyHighMs: 70,
      adaptiveLatencyLowMs: 35,
      adaptiveTargetImageKb: 85,
      adaptiveStepDown: 8,
      adaptiveStepUp: 1,
      adaptiveMinQuality: 20,
      adaptiveMaxQuality: 80,
      debounceMs: Math.min(baseConfig.debounceMs ?? 120, 100),
    };
  }

  return {
    ...baseConfig,
    adaptiveQualityEnabled: true,
    webpQuality: 54,
    adaptiveBufferHighRatio: 0.68,
    adaptiveBufferLowRatio: 0.4,
    adaptiveLatencyHighMs: 95,
    adaptiveLatencyLowMs: 45,
    adaptiveTargetImageKb: 70,
    adaptiveStepDown: 9,
    adaptiveStepUp: 1,
    adaptiveMinQuality: 18,
    adaptiveMaxQuality: 72,
  };
}

type RegisterReqCaseIpcOptions = {
  hideWindowToTray: () => void;
  showWindow: () => void;
  setFloatingToolbarCollapsed: (collapsed: boolean) => { collapsed: boolean };
  getFloatingToolbarState: () => { collapsed: boolean; theme: 'dark' | 'light' };
  setUiTheme: (theme: 'dark' | 'light') => { theme: 'dark' | 'light' };
  fitFloatingToolbarSize: (
    event: IpcMainInvokeEvent,
    request: FloatingToolbarFitRequest,
  ) => { width: number; height: number };
  moveFloatingToolbar: (
    event: IpcMainInvokeEvent,
    request: FloatingToolbarMoveRequest,
  ) => { x: number; y: number };
  setFloatingToolbarDragging: (
    event: IpcMainInvokeEvent,
    command: FloatingToolbarDragCommand,
  ) => { dragging: boolean; accepted: boolean };
  addRendererTarget: (target: WebContents) => void;
  removeRendererTarget: (target: WebContents) => void;
  getRendererTargets: () => WebContents[];
};

export function registerReqCaseShadowRecorderIpc(
  options: RegisterReqCaseIpcOptions,
): ReqCaseShadowRecorderService {
  const service = new ReqCaseShadowRecorderService();
  const trustedDevOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173'];

  const assertTrustedSender = (sender: WebContents): void => {
    if (sender.isDestroyed()) {
      throw new Error('IPC sender is destroyed.');
    }

    const url = sender.getURL() || '';
    const trusted =
      url.startsWith('file://') ||
      url.startsWith('data:text/html') ||
      trustedDevOrigins.some((origin) => url.startsWith(origin));
    if (!trusted) {
      throw new Error(`Blocked IPC from untrusted sender: ${url}`);
    }
  };

  const handleTrusted = <TArgs extends unknown[], TResult>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult | Promise<TResult>,
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedSender(event.sender);
      return handler(event, ...(args as TArgs));
    });
  };

  let registeredStartShortcut: string | null = null;
  let registeredStopShortcut: string | null = null;

  const unregisterShortcut = (accelerator: string | null): void => {
    if (!accelerator) {
      return;
    }
    try {
      globalShortcut.unregister(accelerator);
    } catch (error: unknown) {
      console.warn('Failed to unregister shortcut', accelerator, error);
    }
  };

  const updateShortcuts = (config: ReqCaseShadowRecorderConfig): void => {
    const nextStartShortcut = config.shortcutStartRecording?.trim() || null;
    const nextStopShortcut = config.shortcutStopRecording?.trim() || null;

    if (registeredStartShortcut && registeredStartShortcut !== nextStartShortcut) {
      unregisterShortcut(registeredStartShortcut);
      registeredStartShortcut = null;
    }
    if (registeredStopShortcut && registeredStopShortcut !== nextStopShortcut) {
      unregisterShortcut(registeredStopShortcut);
      registeredStopShortcut = null;
    }

    if (nextStartShortcut && registeredStartShortcut !== nextStartShortcut) {
      try {
        globalShortcut.register(nextStartShortcut, () => {
          if (!service.isRecording()) {
            service.start();
            options.setFloatingToolbarCollapsed(true);
          }
        });
        registeredStartShortcut = nextStartShortcut;
      } catch (error: unknown) {
        console.error('Failed to register start shortcut', error);
      }
    }

    if (nextStopShortcut && registeredStopShortcut !== nextStopShortcut) {
      try {
        globalShortcut.register(nextStopShortcut, () => {
          if (service.isRecording()) {
            service.stop();
            options.setFloatingToolbarCollapsed(false);
          }
        });
        registeredStopShortcut = nextStopShortcut;
      } catch (error: unknown) {
        console.error('Failed to register stop shortcut', error);
      }
    }
  };

  let runtimeSettings = sanitizeRecorderSettings(loadRecorderSettings());
  runtimeSettings = {
    ...runtimeSettings,
    config: {
      ...DEFAULT_BASELINE_CONFIG,
      ...(runtimeSettings.config ?? {}),
    },
  };
  if (runtimeSettings.config) {
    updateShortcuts(runtimeSettings.config);
  }

  const metricsSubscribers = new Set<WebContents>();
  let metricsTimer: NodeJS.Timeout | null = null;
  let lastBroadcastMetrics: ReqCaseShadowRecorderMetrics | null = null;
  let lastStepMetricsPushAtMs = 0;

  const pruneMetricsSubscribers = (): void => {
    for (const target of Array.from(metricsSubscribers)) {
      if (target.isDestroyed()) {
        metricsSubscribers.delete(target);
      }
    }
  };

  const sendMetricsToTarget = (
    target: WebContents,
    metrics: ReqCaseShadowRecorderMetrics,
  ): void => {
    if (!target.isDestroyed()) {
      target.send(REQCASE_SHADOW_RECORDER_CHANNELS.metricsEvent, metrics);
    }
  };

  const stopMetricsTimerIfIdle = (): void => {
    if (metricsSubscribers.size > 0 || metricsTimer === null) {
      return;
    }
    clearInterval(metricsTimer);
    metricsTimer = null;
  };

  const pushMetricsToSubscribers = (force = false): boolean => {
    pruneMetricsSubscribers();
    if (metricsSubscribers.size === 0) {
      stopMetricsTimerIfIdle();
      return false;
    }

    const metrics = service.getMetrics();
    if (!force && !shouldBroadcastMetricsSnapshot(lastBroadcastMetrics, metrics)) {
      return false;
    }

    lastBroadcastMetrics = metrics;
    for (const target of metricsSubscribers) {
      sendMetricsToTarget(target, metrics);
    }
    return true;
  };

  const pushMetricsToSubscribersFromStep = (): void => {
    const now = Date.now();
    if (
      !shouldPublishStepDrivenMetrics({
        nowMs: now,
        lastStepPublishAtMs: lastStepMetricsPushAtMs,
        minIntervalMs: METRICS_PUSH_STEP_MIN_INTERVAL_MS,
      })
    ) {
      return;
    }
    if (pushMetricsToSubscribers()) {
      lastStepMetricsPushAtMs = now;
    }
  };

  const ensureMetricsTimer = (): void => {
    if (metricsTimer !== null) {
      return;
    }

    metricsTimer = setInterval(() => {
      if (!service.isRecording()) {
        return;
      }
      pushMetricsToSubscribers();
    }, METRICS_PUSH_INTERVAL_MS);
  };

  if (runtimeSettings.config) {
    service.setConfig(runtimeSettings.config);
  }

  if (runtimeSettings.autoApplyLastRecommendedProfile && runtimeSettings.lastRecommendedProfile) {
    const base = runtimeSettings.config ?? DEFAULT_BASELINE_CONFIG;
    const next = createPresetConfig(base, runtimeSettings.lastRecommendedProfile);
    service.setConfig(next);
    runtimeSettings = {
      ...runtimeSettings,
      config: next,
    };
    void saveRecorderSettings(runtimeSettings);
  }

  const restorePersistedSemanticProfile = (): void => {
    const fromList = Array.isArray(runtimeSettings.semanticProfiles)
      ? (runtimeSettings.semanticProfiles as any[])
      : [];
    const list =
      fromList.length > 0
        ? fromList
        : runtimeSettings.semanticProfile &&
            (runtimeSettings.semanticProfile as any).profile
          ? [runtimeSettings.semanticProfile as any]
          : [];
    if (list.length === 0) {
      return;
    }
    const activeId =
      typeof runtimeSettings.activeSemanticProfileId === 'string'
        ? runtimeSettings.activeSemanticProfileId
        : null;
    const selected =
      (activeId &&
        list.find(
          (item: any) => item?.id === activeId || item?.profile?.profileId === activeId,
        )) ||
      list[0];
    if (!selected?.profile || typeof selected.profile !== 'object') {
      return;
    }
    try {
      service.restoreSemanticProfileObject(selected.profile as Record<string, unknown>);
      if (!Array.isArray(runtimeSettings.semanticProfiles) || runtimeSettings.semanticProfiles.length === 0) {
        const id =
          typeof selected.id === 'string' && selected.id
            ? selected.id
            : String(selected.profile?.profileId || 'imported');
        runtimeSettings = {
          ...runtimeSettings,
          semanticProfiles: [{ ...selected, id }],
          activeSemanticProfileId: id,
        };
        void saveRecorderSettings(runtimeSettings);
      }
    } catch (error) {
      console.error('Failed to restore persisted semantic profile', error);
    }
  };
  restorePersistedSemanticProfile();

  const profileRecordId = (
    profile: Record<string, unknown>,
    sourceFileName: string,
    fallbackIndex = 0,
  ): string => {
    const profileId = typeof profile.profileId === 'string' ? profile.profileId.trim() : '';
    if (profileId) return profileId;
    const name = typeof profile.name === 'string' ? profile.name.trim() : '';
    if (name) return `name:${name}`;
    const base = sourceFileName.replace(/\.json$/i, '').trim() || 'profile';
    return `${base}-${fallbackIndex + 1}`;
  };

  const listSemanticProfiles = (): Array<{
    id: string;
    sourceFileName: string;
    sourcePath?: string;
    importedAtMs: number;
    updatedAtMs?: number;
    profile: Record<string, unknown>;
  }> => {
    const fromList = Array.isArray(runtimeSettings.semanticProfiles)
      ? (runtimeSettings.semanticProfiles as any[])
      : [];
    if (fromList.length > 0) {
      return fromList as any;
    }
    const legacy = runtimeSettings.semanticProfile as any;
    if (legacy?.profile && typeof legacy.profile === 'object') {
      const id =
        typeof legacy.id === 'string' && legacy.id.trim()
          ? legacy.id.trim()
          : profileRecordId(legacy.profile, legacy.sourceFileName || 'imported-profile.json', 0);
      return [
        {
          id,
          sourceFileName: legacy.sourceFileName || 'imported-profile.json',
          sourcePath: legacy.sourcePath,
          importedAtMs: legacy.importedAtMs || Date.now(),
          updatedAtMs: legacy.updatedAtMs,
          profile: legacy.profile,
        },
      ];
    }
    return [];
  };

  const upsertSemanticProfile = (entry: {
    id?: string;
    sourceFileName: string;
    sourcePath?: string;
    profile: Record<string, unknown>;
  }) => {
    const list = listSemanticProfiles();
    const id =
      (entry.id && entry.id.trim()) ||
      profileRecordId(entry.profile, entry.sourceFileName, list.length);
    const now = Date.now();
    const existingIndex = list.findIndex((item) => item.id === id);
    const nextEntry = {
      id,
      sourceFileName: entry.sourceFileName,
      sourcePath: entry.sourcePath,
      importedAtMs: existingIndex >= 0 ? list[existingIndex].importedAtMs : now,
      updatedAtMs: now,
      profile: entry.profile,
    };
    const nextList =
      existingIndex >= 0
        ? list.map((item, index) => (index === existingIndex ? nextEntry : item))
        : [...list, nextEntry];
    runtimeSettings = {
      ...runtimeSettings,
      semanticProfiles: nextList,
      activeSemanticProfileId: id,
      semanticProfile: nextEntry,
    };
    return nextEntry;
  };

  const activateSemanticProfileById = (id: string): string | null => {
    const list = listSemanticProfiles();
    const found = list.find((item) => item.id === id);
    if (!found?.profile) {
      return null;
    }
    const restored = service.restoreSemanticProfileObject(found.profile);
    runtimeSettings = {
      ...runtimeSettings,
      semanticProfiles: list,
      activeSemanticProfileId: found.id,
      semanticProfile: found,
    };
    return restored;
  };

  service.setPushPublisher((step) => {
    for (const webContents of options.getRendererTargets()) {
      if (!webContents.isDestroyed()) {
        webContents.send(REQCASE_SHADOW_RECORDER_CHANNELS.stepEvent, step);
      }
    }
    pushMetricsToSubscribersFromStep();
  });

  const exportReportWithUtilityFallback = async (
    input: ReqCaseShadowRecorderExportInput,
  ): Promise<Awaited<ReturnType<ReqCaseShadowRecorderService['exportReport']>>> => {
    const safeInput = service.buildSafeReportInput(input);
    const steps = service.getBuffer();
    try {
      return await exportReportInUtilityProcess(safeInput, steps);
    } catch (error) {
      recorderDiagnosticsErrorLog.record(error, 'exportReportInUtilityProcess');
      console.warn('[utility-export] fallback to main process export:', error);
      return service.exportReport(safeInput);
    }
  };

  const exportDiagnostics = async (targetDir: string) => exportDiagnosticsBundle({
    targetDir,
    appVersion: app.getVersion(),
    nativeLoaded: service.isNativeLoaded(),
    lastMetrics: service.isNativeLoaded() ? service.getMetrics() : undefined,
    recentErrors: recorderDiagnosticsErrorLog.list(),
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.start, async () => {
    service.start();
    options.setFloatingToolbarCollapsed(true);
    pushMetricsToSubscribers(true);
    new ElectronNotification({
      title: 'ReqCaseIntelligence',
      body: '▶ 循环录像已开始',
    }).show();
  });


  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.stop, async () => {
    service.stop();
    options.setFloatingToolbarCollapsed(false);
    pushMetricsToSubscribers(true);
    new ElectronNotification({
      title: 'ReqCaseIntelligence',
      body: '⏹ 循环录像已停止',
    }).show();
    options.showWindow();
  });


  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.clearBuffer, async () => {
    service.clearBuffer();
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.pause, async () => {
    service.pause();
    options.setFloatingToolbarCollapsed(true);
  });


  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.resume, async () => {
    service.resume();
    options.setFloatingToolbarCollapsed(true);
  });


  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.isPaused, async () => {
    return service.isPaused();
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.getActiveTestSession, async () => {
    return service.getActiveSession();
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.listTestSessions, async () => {
    return service.listSessions();
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.getTestSessionOperations, async (_event, rawInput: unknown) => {
    return withOperationIpcErrors('getTestSessionOperations', () => {
      const input = parseOperationIpcInput(OperationListInputSchema, rawInput, 'getTestSessionOperations');
      return service.getSessionOperations(input);
    });
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.getTestSessionOperation, async (_event, rawInput: unknown) => {
    return withOperationIpcErrors('getTestSessionOperation', () => {
      const input = parseOperationIpcInput(OperationDetailInputSchema, rawInput, 'getTestSessionOperation');
      return service.getSessionOperation(input);
    });
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.rebuildTestSessionOperations, async (_event, rawInput: unknown) => {
    return withOperationIpcErrors('rebuildTestSessionOperations', () => {
      const input = parseOperationIpcInput(OperationRebuildInputSchema, rawInput, 'rebuildTestSessionOperations');
      return service.rebuildSessionOperations(input);
    });
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.updateTestSessionOperation, async (_event, rawInput: unknown) => {
    return withOperationIpcErrors('updateTestSessionOperation', () => {
      const input = parseOperationIpcInput(OperationUpdateInputSchema, rawInput, 'updateTestSessionOperation');
      return service.updateSessionOperation(input);
    });
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.getTestSessionEvents, async (_event, rawInput: unknown) => {
    const input = parseGetTestSessionEventsInput(rawInput);
    return service.getSessionEvents(input.sessionId, input.limit);
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.getTestSessionEventsTail, async (_event, rawInput: unknown) => {
    const input = parseGetTestSessionEventsTailInput(rawInput);
    return service.getSessionEventsTail(input.sessionId, input.afterEventId, input.limit);
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.getTestSessionVideoStreams, async (_event, rawInput: unknown) => {
    const input = parseGetTestSessionVideoStreamsInput(rawInput);
    return service.getSessionVideoStreams(input.sessionId);
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.getTestSessionVideoSegments, async (_event, rawInput: unknown) => {
    const input = parseGetTestSessionVideoSegmentsInput(rawInput);
    return service.getSessionVideoSegments(input.sessionId, input.streamId, input.limit);
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.getTestSessionVideoSegmentsTail, async (_event, rawInput: unknown) => {
    const input = parseGetTestSessionVideoSegmentsTailInput(rawInput);
    return service.getSessionVideoSegmentsTail(
      input.sessionId,
      input.streamId,
      input.afterSegmentId,
      input.limit,
    );
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.getTestSessionVideoSegmentsForTimestamp, async (_event, rawInput: unknown) => {
    const input = parseGetTestSessionVideoSegmentsForTimestampInput(rawInput);
    return service.getSessionVideoSegmentsForTimestamp(
      input.sessionId,
      input.occurredAtMs,
      input.displayId,
      input.limit,
    );
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.exportTestSessionEvidence, async (_event, rawInput: unknown) => {
    const input = parseTestSessionEvidenceExportInput(rawInput);
    let targetDir = input.targetDir;
    if (!targetDir) {
      if (input.outputMode === 'zip') {
        const result = await dialog.showSaveDialog({
          title: '保存证据 ZIP',
          defaultPath: resolveEvidenceZipSaveDialogDefaultPath(input),
          filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
        });
        if (result.canceled || !result.filePath) {
          throw new Error('Export canceled by user');
        }
        return service.exportSessionEvidence({
          ...input,
          targetDir: path.dirname(result.filePath),
          zipFileName: path.basename(result.filePath),
        });
      }

      const result = await dialog.showOpenDialog({
        title: '选择证据包导出目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        throw new Error('Export canceled by user');
      }
      targetDir = result.filePaths[0];
    }
    return service.exportSessionEvidence({ ...input, targetDir });
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.appendTestSessionNote, async (_event, rawInput: unknown) => {
    const input = parseTestSessionNoteInput(rawInput);
    return service.appendSessionNote(input);
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.appendTestSessionLog, async (_event, rawInput: unknown) => {
    const input = parseTestSessionLogInput(rawInput);
    return service.appendSessionLog(input);
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.subscribeSteps, async (event) => {
    options.addRendererTarget(event.sender);
    service.subscribePush('full');
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.subscribeStepsV2, async (event, input: unknown) => {
    const optionsV2 = parseSubscribeStepsV2Input(input);
    options.addRendererTarget(event.sender);
    service.subscribePush(optionsV2.streamPayload);
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.unsubscribeSteps, async (event) => {
    options.removeRendererTarget(event.sender);
    if (options.getRendererTargets().length === 0) {
      service.unsubscribePush();
    }
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.subscribeMetrics, async (event) => {
    const sender = event.sender;
    if (!metricsSubscribers.has(sender)) {
      metricsSubscribers.add(sender);
      sender.once('destroyed', () => {
        metricsSubscribers.delete(sender);
        stopMetricsTimerIfIdle();
      });
    }
    ensureMetricsTimer();
    const metrics = service.getMetrics();
    lastBroadcastMetrics = metrics;
    sendMetricsToTarget(sender, metrics);
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.unsubscribeMetrics, async (event) => {
    metricsSubscribers.delete(event.sender);
    stopMetricsTimerIfIdle();
  });

  handleTrusted(
    REQCASE_SHADOW_RECORDER_CHANNELS.setConfig,
    async (_event, rawConfig: unknown) => {
      const config = parseConfigInput(rawConfig);
      service.setConfig(config);
      updateShortcuts(config);
      pushMetricsToSubscribers(true);
      runtimeSettings = {
        ...runtimeSettings,
        config,
      };
      await saveRecorderSettings(runtimeSettings);
    },
  );

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.getSettings, async () => {
    return runtimeSettings;
  });

  handleTrusted(
    REQCASE_SHADOW_RECORDER_CHANNELS.setSettings,
    async (_event, rawSettings: unknown) => {
      const settings = parseSettingsInput(rawSettings);
      const sanitized = sanitizeRecorderSettings(settings);
      runtimeSettings = {
        ...runtimeSettings,
        ...sanitized,
      };
      if (sanitized.config) {
        service.setConfig(sanitized.config);
        updateShortcuts(sanitized.config);
      }
      await saveRecorderSettings(runtimeSettings);
      return runtimeSettings;
    },
  );

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.getBuffer, async () => {
    return service.getBuffer();
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.getBufferSince, async (_event, input: unknown) => {
    const lastId = parseGetBufferSinceInput(input);
    return service.getBufferSince(lastId);
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.getBufferPage, async (_event, input: unknown) => {
    const parsed = parseGetBufferPageInput(input);
    return service.getBufferPage(parsed.cursor, parsed.limit, parsed.includeImage);
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.getStepImage, async (_event, input: unknown) => {
    const parsed = parseGetStepImageInput(input);
    return service.getStepImage(parsed.stepId, parsed.variant);
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.getMetrics, async () => {
    return service.getMetrics();
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.runtimeHealth, async () => {
    return service.getRuntimeHealth();
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.hideToTray, async () => {
    options.hideWindowToTray();
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.showWindow, async () => {
    options.showWindow();
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.setFloatingToolbarCollapsed, async (_event, rawInput: unknown) => {
    if (typeof rawInput !== 'boolean') {
      throw new Error('Invalid setFloatingToolbarCollapsed payload: expected boolean');
    }
    return options.setFloatingToolbarCollapsed(rawInput);
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.getFloatingToolbarState, async () => {
    return options.getFloatingToolbarState();
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.setUiTheme, async (_event, rawInput: unknown) => {
    if (rawInput !== 'dark' && rawInput !== 'light') {
      throw new Error('Invalid setUiTheme payload: expected "dark" | "light"');
    }
    return options.setUiTheme(rawInput);
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.fitFloatingToolbarSize, async (event, rawInput: unknown) => {
    if (!isFloatingToolbarFitRequest(rawInput)) {
      throw new Error('Invalid fitFloatingToolbarSize payload');
    }
    return options.fitFloatingToolbarSize(event, {
      width: Math.round(rawInput.width),
      height: Math.round(rawInput.height),
      documentEpoch: rawInput.documentEpoch,
    });
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.moveFloatingToolbar, async (event, rawInput: unknown) => {
    if (!isFloatingToolbarMoveRequest(rawInput)) {
      throw new Error('Invalid moveFloatingToolbar payload');
    }
    return options.moveFloatingToolbar(event, {
      x: Math.round(rawInput.x),
      y: Math.round(rawInput.y),
      documentEpoch: rawInput.documentEpoch,
      dragEpoch: rawInput.dragEpoch,
    });
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.setFloatingToolbarDragging, async (event, rawInput: unknown) => {
    if (!isFloatingToolbarDragCommand(rawInput)) {
      throw new Error('Invalid setFloatingToolbarDragging payload');
    }
    return options.setFloatingToolbarDragging(event, rawInput);
  });

  handleTrusted(REQCASE_SHADOW_RECORDER_CHANNELS.generateReplaySteps, async (_event, rawInput: unknown) => {
    const input = parseReplayStepGenerateInput(rawInput);
    return service.generateReplaySteps(input);
  });

  handleTrusted(
    REQCASE_SHADOW_RECORDER_CHANNELS.exportReport,
    async (_event, rawInput: unknown) => {
      const input = parseReportInput(rawInput);
      let targetDir = input.targetDir;
      if (!targetDir) {
        const result = await dialog.showOpenDialog({
          title: '选择报告导出目录',
          properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0) {
          throw new Error('Export canceled by user');
        }
        targetDir = result.filePaths[0];
      }
      return exportReportWithUtilityFallback({ ...input, targetDir });
    },
  );

  handleTrusted(
    REQCASE_SHADOW_RECORDER_CHANNELS.exportPdf,
    async (_event, rawInput: unknown) => {
      const input = parseReportInput(rawInput);
      let targetDir = input.targetDir;
      if (!targetDir) {
        const result = await dialog.showOpenDialog({
          title: '选择 PDF 导出目录',
          properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0) {
          throw new Error('Export canceled by user');
        }
        targetDir = result.filePaths[0];
      }

      const report = await exportReportWithUtilityFallback({ ...input, targetDir });
      const win = new BrowserWindow({ show: false, width: 1200, height: 800 });
      try {
        await win.loadFile(report.htmlPath);
        const pdfBuffer = await win.webContents.printToPDF({
          landscape: false,
          printBackground: true,
          margins: { marginType: 'default' },
        });
        const pdfPath = report.htmlPath.replace(/\.html$/, '.pdf');
        await writeFile(pdfPath, pdfBuffer);
        return { ...report, pdfPath };
      } finally {
        win.destroy();
      }
    },
  );

  handleTrusted(
    REQCASE_SHADOW_RECORDER_CHANNELS.exportDiagnostics,
    async (_event, rawInput: unknown) => {
      const input = parseDiagnosticsInput(rawInput);
      let targetDir = input.targetDir;
      if (!targetDir) {
        const result = await dialog.showOpenDialog({
          title: 'Select diagnostics export directory',
          properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0) {
          throw new Error('Export canceled by user');
        }
        targetDir = result.filePaths[0];
      }
      return exportDiagnostics(targetDir);
    },
  );

  handleTrusted(
    REQCASE_SHADOW_RECORDER_CHANNELS.exportTuningSnapshot,
    async (_event, rawInput: unknown) => {
      const input = parseTuningSnapshotInput(rawInput);
      let targetDir = input.targetDir;
      if (!targetDir) {
        const result = await dialog.showOpenDialog({
          title: '选择调优快照导出目录',
          properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0) {
          throw new Error('Export canceled by user');
        }
        targetDir = result.filePaths[0];
      }
      return service.exportTuningSnapshot({ ...input, targetDir });
    },
  );

  ipcMain.handle('reqcase:shadow-recorder:mark-test-defect', async (_event, input) => {
    const record = isRecord(input) ? input : {};
    return service.markTestDefect({
      sessionId: optionalString(record, 'sessionId'),
      note: optionalString(record, 'note') ?? optionalString(record, 'message'),
      expected: optionalString(record, 'expected'),
      actual: optionalString(record, 'actual'),
      markedAtMs: optionalNumber(record, 'markedAtMs'),
      preWindowSeconds: optionalNumber(record, 'preWindowSeconds'),
      postWindowSeconds: optionalNumber(record, 'postWindowSeconds'),
    });
  });

  handleTrusted('reqcase:shadow-recorder:purge-test-session-events', async (_event, rawInput: unknown) => {
    const record = isRecord(rawInput) ? rawInput : {};
    return service.purgeTestSessionEvents(optionalString(record, 'sessionId'));
  });

  handleTrusted('reqcase:shadow-recorder:delete-test-session', async (_event, rawInput: unknown) => {
    const record = isRecord(rawInput) ? rawInput : {};
    const sessionIds = Array.isArray((record as { sessionIds?: unknown }).sessionIds)
      ? ((record as { sessionIds: unknown[] }).sessionIds)
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())
      : [];
    if (sessionIds.length > 0) {
      return service.deleteTestSessions(sessionIds);
    }
    return service.deleteTestSession(optionalString(record, 'sessionId'));
  });

  ipcMain.handle('reqcase:shadow-recorder:get-test-session-steps', async (_event, input) => {
    try {
      if (input === undefined || input === null) {
        return service.getTestSessionSteps();
      }
      if (typeof input === 'string') {
        return service.getTestSessionSteps(input);
      }
      const record = requireRecord(input, 'getTestSessionSteps');
      return service.getTestSessionSteps(optionalString(record, 'sessionId'), optionalNumber(record, 'limit'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not active|SessionNotFound|no active|not found/i.test(message)) {
        return [];
      }
      throw error;
    }
  });

  ipcMain.handle('reqcase:shadow-recorder:rebuild-test-session-steps', async (_event, input) => {
    if (typeof input === 'string') {
      return service.rebuildTestSessionSteps(input);
    }
    if (input && typeof input === 'object') {
      const record = requireRecord(input, 'rebuildTestSessionSteps');
      return service.rebuildTestSessionSteps(optionalString(record, 'sessionId'));
    }
    return service.rebuildTestSessionSteps();
  });

  ipcMain.handle('reqcase:shadow-recorder:render-test-session-repro-steps', async (_event, input) => {
    const record = input && typeof input === 'object' ? requireRecord(input, 'renderTestSessionReproSteps') : {};
    return service.renderTestSessionReproSteps(
      optionalString(record, 'sessionId'),
      optionalNumber(record, 'windowStartMs'),
      optionalNumber(record, 'windowEndMs'),
      optionalString(record, 'defectNote') ?? optionalString(record, 'note'),
    );
  });

  ipcMain.handle('reqcase:shadow-recorder:export-test-defect-pack', async (event, input) => {
    const record = requireRecord(input, 'exportTestDefectPack');
    let targetDir = optionalString(record, 'targetDir');
    if (!targetDir) {
      const result = await dialog.showOpenDialog({
        title: '选择缺陷证据包导出目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || !result.filePaths[0]) {
        throw new Error('export canceled');
      }
      targetDir = result.filePaths[0];
    }
    return service.exportTestDefectPack({
      sessionId: optionalString(record, 'sessionId'),
      targetDir,
      markedAtMs: optionalNumber(record, 'markedAtMs'),
      preWindowSeconds: optionalNumber(record, 'preWindowSeconds'),
      postWindowSeconds: optionalNumber(record, 'postWindowSeconds'),
      note: optionalString(record, 'note'),
      expected: optionalString(record, 'expected'),
      actual: optionalString(record, 'actual'),
    });
  });

  ipcMain.handle('reqcase:shadow-recorder:update-test-session-step', async (_event, input) => {
    const record = isRecord(input) ? input : {};
    return service.updateTestSessionStep({
      sessionId: optionalString(record, 'sessionId'),
      stepId: optionalString(record, 'stepId'),
      title: optionalString(record, 'title'),
      summary: optionalString(record, 'summary'),
    });
  });

  ipcMain.handle('reqcase:shadow-recorder:set-semantic-alias-profile', async (_event, input) => {
    return service.setSemanticAliasProfile(input ?? null);
  });

  ipcMain.handle('reqcase:shadow-recorder:get-semantic-alias-profile', async () => {
    return service.getSemanticAliasProfile();
  });

  ipcMain.handle('reqcase:shadow-recorder:load-semantic-profile', async (_event, input) => {
    const profilePath = typeof input === 'string' ? input : input?.path;
    if (!profilePath || typeof profilePath !== 'string') {
      throw new Error('semantic profile path is required');
    }
    const imported = service.importSemanticProfileFromPath(profilePath);
    upsertSemanticProfile({
      sourceFileName: path.basename(profilePath),
      sourcePath: profilePath,
      profile: imported.profile,
    });
    await saveRecorderSettings(runtimeSettings);
    return imported.profileJson;
  });

  ipcMain.handle('reqcase:shadow-recorder:import-semantic-profile', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入语义画像',
      properties: ['openFile'],
      filters: [
        { name: 'Semantic Profile JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const profilePath = result.filePaths[0];
    const imported = service.importSemanticProfileFromPath(profilePath);
    const entry = upsertSemanticProfile({
      sourceFileName: path.basename(profilePath),
      sourcePath: profilePath,
      profile: imported.profile,
    });
    await saveRecorderSettings(runtimeSettings);
    return imported.profileJson;
  });

  ipcMain.handle('reqcase:shadow-recorder:get-semantic-profile-json', async () => {
    return service.getSemanticProfileJson();
  });

  ipcMain.handle('reqcase:shadow-recorder:clear-semantic-profile', async () => {
    service.clearSemanticProfile();
    runtimeSettings = {
      ...runtimeSettings,
      semanticProfile: null,
      semanticProfiles: [],
      activeSemanticProfileId: null,
    };
    await saveRecorderSettings(runtimeSettings);
  });

  ipcMain.handle('reqcase:shadow-recorder:set-active-semantic-profile', async (_event, input) => {
    const id = typeof input === 'string' ? input : input?.id;
    if (!id || typeof id !== 'string') {
      throw new Error('semantic profile id is required');
    }
    const restored = activateSemanticProfileById(id);
    if (!restored) {
      throw new Error(`semantic profile not found: ${id}`);
    }
    await saveRecorderSettings(runtimeSettings);
    return restored;
  });

  ipcMain.handle('reqcase:shadow-recorder:remove-semantic-profile', async (_event, input) => {
    const id = typeof input === 'string' ? input : input?.id;
    if (!id || typeof id !== 'string') {
      throw new Error('semantic profile id is required');
    }
    const list = listSemanticProfiles().filter((item) => item.id !== id);
    const activeId = runtimeSettings.activeSemanticProfileId;
    const nextActive = activeId === id ? (list[0]?.id ?? null) : ((activeId as string | null | undefined) ?? null);
    runtimeSettings = {
      ...runtimeSettings,
      semanticProfiles: list,
      activeSemanticProfileId: nextActive,
      semanticProfile: list.find((p) => p.id === nextActive) ?? list[0] ?? null,
    };
    if (activeId === id) {
      if (list[0]?.profile) {
        service.restoreSemanticProfileObject(list[0].profile);
        runtimeSettings = {
          ...runtimeSettings,
          activeSemanticProfileId: list[0].id,
          semanticProfile: list[0],
        };
      } else {
        service.clearSemanticProfile();
      }
    }
    await saveRecorderSettings(runtimeSettings);
  });

  ipcMain.handle('reqcase:shadow-recorder:set-semantic-profile-json', async (_event, input) => {
    const content =
      typeof input === 'string'
        ? input
        : input && typeof input === 'object' && typeof (input as any).json === 'string'
          ? (input as any).json
          : input && typeof input === 'object' && (input as any).profile
            ? JSON.stringify((input as any).profile)
            : null;
    if (!content || typeof content !== 'string') {
      throw new Error('semantic profile JSON content is required');
    }
    const saved = service.setSemanticProfileJson(content);
    const preferredId =
      input && typeof input === 'object' && typeof (input as any).id === 'string'
        ? String((input as any).id).trim()
        : typeof runtimeSettings.activeSemanticProfileId === 'string'
          ? runtimeSettings.activeSemanticProfileId
          : undefined;
    const list = listSemanticProfiles();
    const existing = preferredId ? list.find((p) => p.id === preferredId) : undefined;
    upsertSemanticProfile({
      id: preferredId || undefined,
      sourceFileName: existing?.sourceFileName || 'edited-profile.json',
      sourcePath: existing?.sourcePath,
      profile: saved.profile,
    });
    await saveRecorderSettings(runtimeSettings);
    return saved.profileJson;
  });

  return service;
}
