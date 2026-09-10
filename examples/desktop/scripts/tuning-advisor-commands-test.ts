import { strict as assert } from 'node:assert';

import type { RecorderConfigPayload, RecorderMetrics } from '../types/contracts';
import {
  buildPersistedTuningSettings,
  buildTuningSnapshotExportInput,
  resolveRecommendationReason,
} from '../src-react/lib/tuning-advisor-commands';

const SAMPLE_CONFIG: RecorderConfigPayload = {
  maxBufferBytes: 160 * 1024 * 1024,
  adaptiveLatencyHighMs: 90,
  adaptiveTargetImageKb: 100,
  captureBackend: 'auto',
  inputMode: 'auto',
  transportMode: 'push',
};

const SAMPLE_METRICS: RecorderMetrics = {
  capturedStepsTotal: 120,
  droppedStepsTotal: 1,
  inputChannelFullDropTotal: 0,
  pushDispatchDropTotal: 1,
  bufferSteps: 18,
  bufferBytes: 120 * 1024 * 1024,
  lastCaptureLatencyMs: 92,
  lastEncodeLatencyMs: 26,
  lastImageBytes: 150 * 1024,
  currentEffectiveQuality: 68,
  qualityAdjustDownCount: 3,
  qualityAdjustUpCount: 1,
  wgcCaptureCount: 80,
  dxgiCaptureCount: 40,
};

function testResolveRecommendationReason(): void {
  assert.equal(
    resolveRecommendationReason('stability', { profile: 'stability', reason: 'stable metrics' }),
    'stable metrics',
  );
  assert.equal(
    resolveRecommendationReason('latency', { profile: 'stability', reason: 'stable metrics' }),
    '低延迟优先 (manual selection)',
  );
}

function testBuildPersistedTuningSettings(): void {
  const nextConfig: RecorderConfigPayload = {
    ...SAMPLE_CONFIG,
    webpQuality: 62,
  };
  const settings = buildPersistedTuningSettings({
    nextConfig,
    profile: 'latency',
    recommendation: { profile: 'stability', reason: 'stable metrics' },
    autoApplyRecommendedOnStartup: true,
  });

  assert.equal(settings.config, nextConfig);
  assert.equal(settings.autoApplyLastRecommendedProfile, true);
  assert.equal(settings.lastRecommendedProfile, 'latency');
  assert.equal(settings.lastRecommendationReason, '低延迟优先 (manual selection)');
}

function testBuildTuningSnapshotExportInput(): void {
  const output = buildTuningSnapshotExportInput({
    profile: 'stability',
    recommendation: {
      profile: 'stability',
      reason: 'drop detected',
    },
    config: SAMPLE_CONFIG,
    metrics: SAMPLE_METRICS,
    autoApplyRecommendedOnStartup: false,
  });

  assert.equal(output.targetDir, 'reports');
  assert.equal(output.profile, 'stability');
  assert.equal(output.reason, 'drop detected');
  assert.equal(output.config, SAMPLE_CONFIG);
  assert.equal(output.metrics, SAMPLE_METRICS);
  assert.equal(output.autoApplyLastRecommendedProfile, false);
  assert.deepEqual(output.triggerTags, ['drop_detected', 'high_capture_latency', 'buffer_ok']);
  assert.equal(output.notes, 'Exported from explainability panel.');
}

function run(): void {
  testResolveRecommendationReason();
  testBuildPersistedTuningSettings();
  testBuildTuningSnapshotExportInput();
  console.log('[tuning-advisor-commands-test] PASS');
}

run();
