import type { ReqCaseShadowRecorderMetrics } from './types';

function sameNumber(
  left: number | undefined,
  right: number | undefined,
): boolean {
  return left === right;
}

function sameInputMode(
  left: ReqCaseShadowRecorderMetrics['effectiveInputMode'],
  right: ReqCaseShadowRecorderMetrics['effectiveInputMode'],
): boolean {
  return left === right;
}

export function isSameMetricsSnapshot(
  left: ReqCaseShadowRecorderMetrics,
  right: ReqCaseShadowRecorderMetrics,
): boolean {
  return (
    left.capturedStepsTotal === right.capturedStepsTotal &&
    left.droppedStepsTotal === right.droppedStepsTotal &&
    left.inputChannelFullDropTotal === right.inputChannelFullDropTotal &&
    left.pushDispatchDropTotal === right.pushDispatchDropTotal &&
    left.bufferSteps === right.bufferSteps &&
    left.bufferBytes === right.bufferBytes &&
    left.lastCaptureLatencyMs === right.lastCaptureLatencyMs &&
    left.lastEncodeLatencyMs === right.lastEncodeLatencyMs &&
    left.lastImageBytes === right.lastImageBytes &&
    left.currentEffectiveQuality === right.currentEffectiveQuality &&
    left.qualityAdjustDownCount === right.qualityAdjustDownCount &&
    left.qualityAdjustUpCount === right.qualityAdjustUpCount &&
    left.wgcCaptureCount === right.wgcCaptureCount &&
    left.dxgiCaptureCount === right.dxgiCaptureCount &&
    sameInputMode(left.effectiveInputMode, right.effectiveInputMode) &&
    sameNumber(left.backendFallbackTotal, right.backendFallbackTotal) &&
    sameNumber(left.captureContextResetTotal, right.captureContextResetTotal)
  );
}

export function shouldBroadcastMetricsSnapshot(
  previous: ReqCaseShadowRecorderMetrics | null,
  next: ReqCaseShadowRecorderMetrics,
): boolean {
  if (!previous) {
    return true;
  }

  return !isSameMetricsSnapshot(previous, next);
}

export function shouldPublishStepDrivenMetrics(input: {
  nowMs: number;
  lastStepPublishAtMs: number;
  minIntervalMs: number;
}): boolean {
  if (input.lastStepPublishAtMs <= 0) {
    return true;
  }

  return input.nowMs - input.lastStepPublishAtMs >= input.minIntervalMs;
}
