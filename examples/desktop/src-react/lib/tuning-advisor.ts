import type {
  RecorderConfigPayload,
  RecorderMetrics,
  RecorderTuningProfile,
} from '../../types/contracts';
import {
  DEFAULT_RECORDING_WINDOW_SECONDS,
  DEFAULT_SEGMENT_DURATION_SECONDS,
  deriveInternalMaxSteps,
} from '../../types/recording-defaults';

export const DEFAULT_BUFFER_BYTES = 150 * 1024 * 1024;

export const DEFAULT_CONFIG: RecorderConfigPayload = {
  recordingWindowSeconds: DEFAULT_RECORDING_WINDOW_SECONDS,
  segmentDurationSeconds: DEFAULT_SEGMENT_DURATION_SECONDS,
  targetCaptureMode: 'target_display',
  recordingProfile: 'balanced',
  encoderPreference: 'auto',
  showMouseInVideo: false,
  maxSteps: deriveInternalMaxSteps(DEFAULT_RECORDING_WINDOW_SECONDS),
  maxBufferBytes: DEFAULT_BUFFER_BYTES,
  debounceMs: 90,
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
  captureBackend: 'dxgi',
  strictBackend: false,
  deltaMode: 'hash_dedup',
  transportMode: 'push',
  streamPayload: 'meta_only',
  captureReuseEnabled: true,
  defectEvidenceEnabled: false,
  semanticRecordingEnabled: false,
  uiaObserverEnabled: false,
  operationBuilderEnabled: false,
  operationReviewV2Enabled: false,
  semanticPlaintextInputEnabled: false,
  defectPreWindowSeconds: 60,
  defectPostWindowSeconds: 20,
  privacyEnabled: false,
  excludedWindowTitleKeywords: [],
  excludedProcessNames: [],
  maskRegions: [],
  shortcutStartRecording: 'CommandOrControl+Shift+R',
  shortcutStopRecording: 'CommandOrControl+Shift+S',
};

export const PROFILE_LABELS: Record<RecorderTuningProfile, string> = {
  stability: '稳定性优先',
  latency: '低延迟优先',
  size: '小体积优先',
};

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${bytes}B`;
}

export function createPresetConfig(
  baseConfig: RecorderConfigPayload,
  profile: RecorderTuningProfile,
): RecorderConfigPayload {
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
      maxBufferBytes: Math.max(baseConfig.maxBufferBytes ?? DEFAULT_BUFFER_BYTES, 180 * 1024 * 1024),
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
      debounceMs: Math.min(baseConfig.debounceMs ?? 90, 70),
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

export function recommendTuningProfile(
  metrics: RecorderMetrics | null,
  config: RecorderConfigPayload,
): { profile: RecorderTuningProfile; reason: string } {
  if (!metrics) {
    return {
      profile: 'stability',
      reason: 'No runtime metrics yet; start with stability profile.',
    };
  }

  const maxBufferBytes = Math.max(config.maxBufferBytes ?? DEFAULT_BUFFER_BYTES, 1);
  const bufferRatio = metrics.bufferBytes / maxBufferBytes;
  const targetImageBytes = (config.adaptiveTargetImageKb ?? 100) * 1024;
  const latencyHigh = config.adaptiveLatencyHighMs ?? 90;

  if (metrics.droppedStepsTotal > 0 || bufferRatio >= 0.9) {
    return {
      profile: 'stability',
      reason: `Detected drops or high buffer pressure (${(bufferRatio * 100).toFixed(1)}%), prefer stability profile.`,
    };
  }

  if (metrics.lastCaptureLatencyMs >= latencyHigh) {
    return {
      profile: 'latency',
      reason: `Recent capture latency ${metrics.lastCaptureLatencyMs}ms is high, prefer latency profile.`,
    };
  }

  if (metrics.lastImageBytes > targetImageBytes * 1.15 || bufferRatio >= 0.78) {
    return {
      profile: 'size',
      reason: `Recent image size ${formatBytes(metrics.lastImageBytes)} and buffer ${(bufferRatio * 100).toFixed(1)}% indicate size pressure.`,
    };
  }

  return {
    profile: 'stability',
    reason: 'Current metrics are stable; keep stability profile for long-running sessions.',
  };
}

export function buildTuningTriggerTags(
  metrics: RecorderMetrics | null,
  config: RecorderConfigPayload,
): string[] {
  if (!metrics) {
    return ['metrics_unavailable'];
  }
  const maxBufferBytes = Math.max(config.maxBufferBytes ?? DEFAULT_BUFFER_BYTES, 1);
  const bufferRatio = metrics.bufferBytes / maxBufferBytes;
  return [
    metrics.droppedStepsTotal > 0 ? 'drop_detected' : 'drop_free',
    metrics.lastCaptureLatencyMs >= (config.adaptiveLatencyHighMs ?? 90)
      ? 'high_capture_latency'
      : 'capture_latency_normal',
    bufferRatio >= 0.8 ? 'buffer_pressure' : 'buffer_ok',
  ];
}
