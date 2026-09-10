import { strict as assert } from 'node:assert';

import type { RecorderMetrics, RecorderPersistedSettings } from '../types/contracts';
import { loadRecorderBootstrapSnapshot } from '../src-react/hooks/useRecorderBootstrapLoader';

type RecorderBridgeMock = {
  getMetrics: () => Promise<RecorderMetrics | null>;
  getSettings: () => Promise<RecorderPersistedSettings | null | undefined>;
};

function createMetrics(): RecorderMetrics {
  return {
    capturedStepsTotal: 5,
    droppedStepsTotal: 1,
    inputChannelFullDropTotal: 0,
    pushDispatchDropTotal: 0,
    bufferSteps: 2,
    bufferBytes: 2048,
    lastCaptureLatencyMs: 10,
    lastEncodeLatencyMs: 8,
    lastImageBytes: 1024,
    currentEffectiveQuality: 75,
    qualityAdjustDownCount: 0,
    qualityAdjustUpCount: 1,
    wgcCaptureCount: 4,
    dxgiCaptureCount: 1,
  };
}

function setWindowBridge(bridge: RecorderBridgeMock): () => void {
  const root = globalThis as unknown as Record<string, unknown>;
  const previousWindow = root.window;
  root.window = {
    reqcaseShadowRecorder: bridge,
  };

  return () => {
    if (typeof previousWindow === 'undefined') {
      delete root.window;
    } else {
      root.window = previousWindow;
    }
  };
}

async function testLoadRecorderBootstrapSnapshotSuccess(): Promise<void> {
  const latestMetrics = createMetrics();
  const settings: RecorderPersistedSettings = {
    config: {
      transportMode: 'push',
      maxSteps: 20,
    },
  };

  const restore = setWindowBridge({
    getMetrics: async () => latestMetrics,
    getSettings: async () => settings,
  });

  try {
    const snapshot = await loadRecorderBootstrapSnapshot();
    assert.deepEqual(snapshot.buffer, []);
    assert.equal(snapshot.latestMetrics, latestMetrics);
    assert.equal(snapshot.settings, settings);
  } finally {
    restore();
  }
}

async function testLoadRecorderBootstrapSnapshotRejectsWhenBridgeFails(): Promise<void> {
  const restore = setWindowBridge({
    getMetrics: async () => null,
    getSettings: async () => {
      throw new Error('settings-failed');
    },
  });

  try {
    await assert.rejects(
      async () => loadRecorderBootstrapSnapshot(),
      /settings-failed/,
    );
  } finally {
    restore();
  }
}

async function run(): Promise<void> {
  await testLoadRecorderBootstrapSnapshotSuccess();
  await testLoadRecorderBootstrapSnapshotRejectsWhenBridgeFails();
  console.log('[recorder-bootstrap-loader-test] PASS');
}

void run();
