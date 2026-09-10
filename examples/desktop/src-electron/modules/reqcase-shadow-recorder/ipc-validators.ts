import { z } from 'zod';

import type {
  ReqCaseShadowRecorderConfig,
  ReqCaseShadowRecorderPersistedSettings,
  ReqCaseShadowRecorderTestSessionEvidenceExportInput,
  ReqCaseShadowRecorderReplayStepGenerateInput,
  ReqCaseShadowRecorderTestSessionStartInput,
} from './types';

const optionalFiniteNumber = z.number().finite().optional();

const RecorderTargetCaptureModeSchema = z.enum([
  'all_displays',
  'target_display',
  'foreground_window',
  'target_window',
]);

export const RecorderConfigSchema = z.object({
  recordingWindowSeconds: optionalFiniteNumber,
  segmentDurationSeconds: optionalFiniteNumber,
  recordingProfile: z.enum(['efficiency', 'balanced', 'smooth']).optional(),
  encoderPreference: z.enum(['auto', 'hardware', 'software']).optional(),
  showMouseInVideo: z.boolean().optional(),
  targetCaptureMode: RecorderTargetCaptureModeSchema.optional(),
  targetDisplayId: z.string().optional(),
  targetDisplayIds: z.array(z.string()).optional(),
  maxSteps: optionalFiniteNumber,
  maxBufferBytes: optionalFiniteNumber,
  debounceMs: optionalFiniteNumber,
  webpQuality: optionalFiniteNumber,
  thumbWebpQuality: optionalFiniteNumber,
  adaptiveQualityEnabled: z.boolean().optional(),
  adaptiveLatencyHighMs: optionalFiniteNumber,
  adaptiveLatencyLowMs: optionalFiniteNumber,
  adaptiveBufferHighRatio: optionalFiniteNumber,
  adaptiveBufferLowRatio: optionalFiniteNumber,
  adaptiveTargetImageKb: optionalFiniteNumber,
  adaptiveStepDown: optionalFiniteNumber,
  adaptiveStepUp: optionalFiniteNumber,
  adaptiveMinQuality: optionalFiniteNumber,
  adaptiveMaxQuality: optionalFiniteNumber,
  inputMode: z.enum(['auto', 'hook', 'raw_input']).optional(),
  captureBackend: z.enum(['auto', 'dxgi', 'wgc']).optional(),
  strictBackend: z.boolean().optional(),
  deltaMode: z.enum(['off', 'hash_dedup', 'dirty_rect']).optional(),
  transportMode: z.enum(['poll', 'push']).optional(),
  streamPayload: z.enum(['meta_only', 'meta_plus_thumb', 'full']).optional(),
  captureReuseEnabled: z.boolean().optional(),
  defectEvidenceEnabled: z.boolean().optional(),
  semanticRecordingEnabled: z.boolean().optional(),
  uiaObserverEnabled: z.boolean().optional(),
  operationBuilderEnabled: z.boolean().optional(),
  operationReviewV2Enabled: z.boolean().optional(),
  semanticPlaintextInputEnabled: z.boolean().optional(),
  defectPreWindowSeconds: optionalFiniteNumber,
  defectPostWindowSeconds: optionalFiniteNumber,
  shortcutStartRecording: z.string().optional(),
  shortcutStopRecording: z.string().optional(),
}).passthrough() satisfies z.ZodType<ReqCaseShadowRecorderConfig>;

export const RecorderSettingsSchema = z.object({
  config: RecorderConfigSchema.optional(),
  autoApplyLastRecommendedProfile: z.boolean().optional(),
  autoApplyRecommendedOnStartup: z.boolean().optional(),
  lastRecommendedProfile: z.enum(['stability', 'latency', 'size']).optional(),
  lastRecommendationReason: z.string().optional(),
  floatingToolbarCollapsed: z.boolean().optional(),
}).passthrough() satisfies z.ZodType<ReqCaseShadowRecorderPersistedSettings>;

export const ExportEvidenceInputSchema = z.preprocess(
  (value) => (value === undefined || value === null ? {} : value),
  z.object({
    sessionId: z.string().optional(),
    targetDir: z.string().default(''),
    bundleName: z.string().optional(),
    zipFileName: z.string().optional(),
    outputMode: z.enum(['directory', 'zip']).optional(),
    privacyAcknowledgedAt: z.string().optional(),
  }).passthrough(),
) satisfies z.ZodType<ReqCaseShadowRecorderTestSessionEvidenceExportInput>;

export const ReplayStepGenerateInputSchema = z.preprocess(
  (value) => (value === undefined || value === null ? {} : value),
  z.object({
    provider: z.enum(['disabled', 'mock', 'openai_compatible']).default('disabled'),
    contexts: z.array(z.object({
      stepId: z.string(),
      timestampMs: z.number(),
      action: z.enum(['click', 'double_click', 'right_click', 'scroll', 'unknown']),
      position: z.object({ x: z.number(), y: z.number() }),
      windowTitle: z.string().optional(),
      processName: z.string().optional(),
      captureBackend: z.string().optional(),
      hasImage: z.boolean(),
      privacyFiltered: z.boolean(),
    }).passthrough()).default([]),
    aiEnabled: z.boolean().optional(),
    privacyAcknowledgedAt: z.string().optional(),
    openAiCompatible: z.object({
      baseUrl: z.string(),
      apiKey: z.string().optional(),
      model: z.string(),
      timeoutMs: z.number().default(30_000),
    }).optional(),
  }).passthrough(),
) satisfies z.ZodType<ReqCaseShadowRecorderReplayStepGenerateInput>;

export const TestSessionStartInputSchema = z.object({
  name: z.string().optional(),
  storageDir: z.string().optional(),
  targetCaptureMode: RecorderTargetCaptureModeSchema.optional(),
  bufferWindowSeconds: optionalFiniteNumber,
  segmentDurationSeconds: optionalFiniteNumber,
  showMouseInVideo: z.boolean().optional(),
  targetProcessName: z.string().optional(),
  targetPid: optionalFiniteNumber,
  targetHwnd: z.string().optional(),
  targetDisplayId: z.string().optional(),
  targetDisplayIds: z.array(z.string()).optional(),
  recordingProfile: z.enum(['efficiency', 'balanced', 'smooth']).optional(),
  encoderPreference: z.enum(['auto', 'hardware', 'software']).optional(),
}).passthrough() satisfies z.ZodType<ReqCaseShadowRecorderTestSessionStartInput>;

export const GetBufferPageInputSchema = z.preprocess(
  (value) => (value === undefined || value === null ? {} : value),
  z.object({
    cursor: z.string().default('0'),
    limit: z.preprocess(
      (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined),
      z.number().default(100).transform((value) => Math.max(1, Math.min(1000, Math.floor(value)))),
    ),
    includeImage: z.boolean().default(false),
  }).passthrough(),
);

export function parseIpcInput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    throw new Error(`${label} validation failed: ${fields.join(', ')}`);
  }
  return result.data;
}

export {
  OperationDetailInputSchema,
  OperationListInputSchema,
  OperationRebuildInputSchema,
  OperationUpdateInputSchema,
  parseOperationIpcInput,
} from './operation-ipc-validators';
