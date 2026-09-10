import { strict as assert } from 'node:assert';

import type { SetStateAction } from 'react';

import type {
  RecorderConfigPayload,
  RecorderMetrics,
  RecorderPersistedSettings,
  RecorderStep,
} from '../types/contracts';
import { applyRecorderBootstrapSnapshot } from '../src-react/hooks/useRecorderBootstrapBindings';

function resolveStateUpdate<T>(current: T, next: SetStateAction<T>): T {
  return typeof next === 'function' ? (next as (value: T) => T)(current) : next;
}

function createStep(id: number): RecorderStep {
  return {
    id: String(id),
    timestampMs: 1700000000000 + id,
    action: 'click',
    x: 10,
    y: 20,
    windowLeft: 0,
    windowTop: 0,
    windowRight: 100,
    windowBottom: 120,
    processName: 'demo.exe',
    windowTitle: 'demo',
    imageWebpBase64: 'AAAA',
  };
}

function createMetrics(): RecorderMetrics {
  return {
    capturedStepsTotal: 10,
    droppedStepsTotal: 1,
    inputChannelFullDropTotal: 0,
    pushDispatchDropTotal: 0,
    bufferSteps: 3,
    bufferBytes: 3000,
    lastCaptureLatencyMs: 12,
    lastEncodeLatencyMs: 9,
    lastImageBytes: 1024,
    currentEffectiveQuality: 76,
    qualityAdjustDownCount: 0,
    qualityAdjustUpCount: 1,
    wgcCaptureCount: 8,
    dxgiCaptureCount: 2,
  };
}

function testApplySnapshotMergesConfigAndHydratesAllConsumers(): void {
  let config: RecorderConfigPayload = {
    transportMode: 'poll',
    webpQuality: 66,
  };
  let steps: RecorderStep[] = [];
  let metrics: RecorderMetrics | null = null;
  let setConfigCallCount = 0;
  const hydrateCalls: string[] = [];
  const hydrateSettingsRefs: Array<RecorderPersistedSettings | null | undefined> = [];

  const settings: RecorderPersistedSettings = {
    config: {
      transportMode: 'push',
      maxSteps: 40,
    },
    autoApplyLastRecommendedProfile: true,
  };

  applyRecorderBootstrapSnapshot({
    snapshot: {
      buffer: [createStep(1), createStep(2)],
      latestMetrics: createMetrics(),
      settings,
    },
    setConfig: ((next: SetStateAction<RecorderConfigPayload>) => {
      setConfigCallCount += 1;
      config = resolveStateUpdate(config, next);
    }) as never,
    setSteps: ((next: SetStateAction<RecorderStep[]>) => {
      steps = resolveStateUpdate(steps, next);
    }) as never,
    setMetrics: ((next: SetStateAction<RecorderMetrics | null>) => {
      metrics = resolveStateUpdate(metrics, next);
    }) as never,
    hydrateTuningFromSettings: (value) => {
      hydrateCalls.push('tuning');
      hydrateSettingsRefs.push(value);
    },
    hydrateBenchmarkFromSettings: (value) => {
      hydrateCalls.push('benchmark');
      hydrateSettingsRefs.push(value);
    },
    hydrateQueueFromSettings: (value) => {
      hydrateCalls.push('queue');
      hydrateSettingsRefs.push(value);
    },
  });

  assert.equal(setConfigCallCount, 1);
  assert.equal(config.transportMode, 'push');
  assert.equal(config.maxSteps, 40);
  assert.equal(config.webpQuality, 66);
  assert.equal(steps.length, 2);
  assert.equal(steps[0]?.id, '1');
  assert.equal((metrics as RecorderMetrics | null)?.capturedStepsTotal, 10);
  assert.deepEqual(hydrateCalls, ['tuning', 'benchmark', 'queue']);
  assert.equal(hydrateSettingsRefs[0], settings);
  assert.equal(hydrateSettingsRefs[1], settings);
  assert.equal(hydrateSettingsRefs[2], settings);
}

function testApplySnapshotSkipsConfigMergeWhenSettingsMissingConfig(): void {
  let config: RecorderConfigPayload = {
    transportMode: 'poll',
    webpQuality: 70,
  };
  let setConfigCallCount = 0;
  let steps: RecorderStep[] = [];
  let metrics: RecorderMetrics | null = null;

  applyRecorderBootstrapSnapshot({
    snapshot: {
      buffer: [createStep(3)],
      latestMetrics: createMetrics(),
      settings: {
        autoApplyLastRecommendedProfile: false,
      },
    },
    setConfig: ((next: SetStateAction<RecorderConfigPayload>) => {
      setConfigCallCount += 1;
      config = resolveStateUpdate(config, next);
    }) as never,
    setSteps: ((next: SetStateAction<RecorderStep[]>) => {
      steps = resolveStateUpdate(steps, next);
    }) as never,
    setMetrics: ((next: SetStateAction<RecorderMetrics | null>) => {
      metrics = resolveStateUpdate(metrics, next);
    }) as never,
    hydrateTuningFromSettings: () => undefined,
    hydrateBenchmarkFromSettings: () => undefined,
    hydrateQueueFromSettings: () => undefined,
  });

  assert.equal(setConfigCallCount, 0);
  assert.equal(config.transportMode, 'poll');
  assert.equal(config.webpQuality, 70);
  assert.equal(steps.length, 1);
  assert.equal((metrics as RecorderMetrics | null)?.capturedStepsTotal, 10);
}

function run(): void {
  testApplySnapshotMergesConfigAndHydratesAllConsumers();
  testApplySnapshotSkipsConfigMergeWhenSettingsMissingConfig();
  console.log('[recorder-bootstrap-bindings-test] PASS');
}

run();
