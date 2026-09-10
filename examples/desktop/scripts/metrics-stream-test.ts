import { strict as assert } from 'node:assert';

import type { ReqCaseShadowRecorderMetrics } from '../src-electron/modules/reqcase-shadow-recorder';
import {
  isSameMetricsSnapshot,
  shouldPublishStepDrivenMetrics,
  shouldBroadcastMetricsSnapshot,
} from '../src-electron/modules/reqcase-shadow-recorder/metrics-stream';

function createMetrics(): ReqCaseShadowRecorderMetrics {
  return {
    capturedStepsTotal: 10,
    droppedStepsTotal: 1,
    inputChannelFullDropTotal: 2,
    pushDispatchDropTotal: 3,
    bufferSteps: 4,
    bufferBytes: 4096,
    lastCaptureLatencyMs: 20,
    lastEncodeLatencyMs: 12,
    lastImageBytes: 900,
    currentEffectiveQuality: 74,
    qualityAdjustDownCount: 2,
    qualityAdjustUpCount: 1,
    wgcCaptureCount: 8,
    dxgiCaptureCount: 2,
    effectiveInputMode: 'hook',
    backendFallbackTotal: 5,
    captureContextResetTotal: 1,
  };
}

function testIsSameMetricsSnapshotForEqualValues(): void {
  const left = createMetrics();
  const right = createMetrics();
  assert.equal(isSameMetricsSnapshot(left, right), true);
}

function testIsSameMetricsSnapshotDetectsChanges(): void {
  const left = createMetrics();
  const right = createMetrics();
  right.capturedStepsTotal += 1;
  assert.equal(isSameMetricsSnapshot(left, right), false);
}

function testIsSameMetricsSnapshotHandlesOptionalFields(): void {
  const left = createMetrics();
  const right = createMetrics();
  left.effectiveInputMode = undefined;
  right.effectiveInputMode = undefined;
  left.backendFallbackTotal = undefined;
  right.backendFallbackTotal = undefined;
  assert.equal(isSameMetricsSnapshot(left, right), true);

  right.captureContextResetTotal = 9;
  assert.equal(isSameMetricsSnapshot(left, right), false);
}

function testShouldBroadcastMetricsSnapshot(): void {
  const metrics = createMetrics();
  assert.equal(shouldBroadcastMetricsSnapshot(null, metrics), true);
  assert.equal(shouldBroadcastMetricsSnapshot(metrics, { ...metrics }), false);
  assert.equal(
    shouldBroadcastMetricsSnapshot(metrics, { ...metrics, bufferBytes: metrics.bufferBytes + 1 }),
    true,
  );
}

function testShouldPublishStepDrivenMetrics(): void {
  assert.equal(
    shouldPublishStepDrivenMetrics({
      nowMs: 1000,
      lastStepPublishAtMs: 0,
      minIntervalMs: 300,
    }),
    true,
  );
  assert.equal(
    shouldPublishStepDrivenMetrics({
      nowMs: 1200,
      lastStepPublishAtMs: 1000,
      minIntervalMs: 300,
    }),
    false,
  );
  assert.equal(
    shouldPublishStepDrivenMetrics({
      nowMs: 1300,
      lastStepPublishAtMs: 1000,
      minIntervalMs: 300,
    }),
    true,
  );
}

function run(): void {
  testIsSameMetricsSnapshotForEqualValues();
  testIsSameMetricsSnapshotDetectsChanges();
  testIsSameMetricsSnapshotHandlesOptionalFields();
  testShouldBroadcastMetricsSnapshot();
  testShouldPublishStepDrivenMetrics();
  console.log('[metrics-stream-test] PASS');
}

run();
