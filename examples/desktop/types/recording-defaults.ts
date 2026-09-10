export const DEFAULT_RECORDING_WINDOW_SECONDS = 90;
export const MIN_RECORDING_WINDOW_SECONDS = 30;
export const MAX_RECORDING_WINDOW_SECONDS = 3600;

export const DEFAULT_SEGMENT_DURATION_SECONDS = 5;
export const MIN_SEGMENT_DURATION_SECONDS = 2;
export const MAX_SEGMENT_DURATION_SECONDS = 60;

export const MIN_INTERNAL_STEP_LIMIT = 60;
export const MAX_INTERNAL_STEP_LIMIT = 720;

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolveRecordingWindowSeconds(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_RECORDING_WINDOW_SECONDS;
  }

  return clampNumber(Math.round(value), MIN_RECORDING_WINDOW_SECONDS, MAX_RECORDING_WINDOW_SECONDS);
}

export function resolveSegmentDurationSeconds(
  value?: number,
  recordingWindowSeconds?: number,
): number {
  const resolvedRecordingWindowSeconds = resolveRecordingWindowSeconds(recordingWindowSeconds);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Math.min(DEFAULT_SEGMENT_DURATION_SECONDS, resolvedRecordingWindowSeconds);
  }

  return Math.min(
    clampNumber(Math.round(value), MIN_SEGMENT_DURATION_SECONDS, MAX_SEGMENT_DURATION_SECONDS),
    resolvedRecordingWindowSeconds,
  );
}

export function resolveRecordingWindowMs(value?: number): number {
  return resolveRecordingWindowSeconds(value) * 1000;
}

export function deriveInternalMaxSteps(recordingWindowSeconds?: number): number {
  const resolvedRecordingWindowSeconds = resolveRecordingWindowSeconds(recordingWindowSeconds);
  return clampNumber(
    Math.ceil(resolvedRecordingWindowSeconds * 2),
    MIN_INTERNAL_STEP_LIMIT,
    MAX_INTERNAL_STEP_LIMIT,
  );
}
