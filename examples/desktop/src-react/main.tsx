import React from 'react';
import { createRoot } from 'react-dom/client';

import type {
  TestSessionDisplayTarget,
  TestSessionState,
  TestSessionTimelineEvent,
} from '../types/contracts';
import { RecorderRootErrorBoundary } from './components/RecorderRootErrorBoundary';
import { RecorderPage } from './pages/RecorderPage';
import './styles.css';
import { initTheme } from './lib/theme';

initTheme();

function createFallbackRecorderBridge(): Window['reqcaseShadowRecorder'] {
  const noopUnsubscribe = () => {};
  const makeFallbackSession = (overrides: Partial<TestSessionState> = {}) => ({
    schemaVersion: 1 as const,
    kind: 'reqcase.test-session' as const,
    sessionId: 'fallback-session',
    status: 'active' as const,
    startedAtMs: Date.now(),
    updatedAtMs: Date.now(),
    bufferWindowSeconds: 90,
    segmentDurationSeconds: 5,
    recordingProfile: 'balanced' as const,
    encoderPreference: 'auto' as const,
    showMouseInVideo: false,
    targetCaptureMode: 'target_display' as const,
    ...overrides,
  });
  const fallbackDisplays: TestSessionDisplayTarget[] = [
    {
      displayId: 'display-auto-primary',
      label: 'Primary Display',
      left: 0,
      top: 0,
      right: 1920,
      bottom: 1080,
      width: 1920,
      height: 1080,
      isPrimary: true,
    },
  ];
  const makeFallbackVideoStream = () => ({
    schemaVersion: 1 as const,
    kind: 'reqcase.test-session-video-stream' as const,
    streamId: 'fallback-stream',
    sessionId: 'fallback-session',
    label: 'Primary Display',
    status: 'planned' as const,
    targetCaptureMode: 'target_display' as const,
    displayId: 'display-auto-primary',
    displayLabel: 'Primary Display',
    width: 1920,
    height: 1080,
    startedAtMs: Date.now(),
    updatedAtMs: Date.now(),
    segmentDurationSeconds: 3,
    segmentCount: 0,
    playableSegmentCount: 0,
    pendingSegmentCount: 0,
    totalSegmentBytes: 0,
    retainedSegmentBytes: 0,
    sampleIntervalMs: 71,
    targetFps: 14,
    encoderAvailable: false,
    warningCount: 0,
  });
  const makeFallbackEvent = (overrides: Partial<TestSessionTimelineEvent> = {}) => ({
    schemaVersion: 1 as const,
    kind: 'reqcase.test-session-event' as const,
    eventId: 'fallback-event',
    sessionId: 'fallback-session',
    eventType: 'note_added' as const,
    logCategory: 'operation' as const,
    occurredAtMs: Date.now(),
    title: 'Fallback',
    message: 'Recorder bridge unavailable.',
    ...overrides,
  });
  const zeroMetrics = {
    capturedStepsTotal: 0,
    droppedStepsTotal: 0,
    inputChannelFullDropTotal: 0,
    pushDispatchDropTotal: 0,
    bufferSteps: 0,
    bufferBytes: 0,
    lastCaptureLatencyMs: 0,
    lastEncodeLatencyMs: 0,
    lastImageBytes: 0,
    currentEffectiveQuality: 0,
    qualityAdjustDownCount: 0,
    qualityAdjustUpCount: 0,
    wgcCaptureCount: 0,
    dxgiCaptureCount: 0,
  };

  const noOpPromise = async () => {};
  const noOpEvent = () => noopUnsubscribe;
  const unsupported = (method: string) => async () => {
    throw new Error(
      `Recorder bridge unavailable: ${method}. Please launch via Electron (npm run dev).`,
    );
  };

  return new Proxy(
    {
      start: noOpPromise,
      stop: noOpPromise,
      listAvailableDisplays: async () => fallbackDisplays,
      getActiveTestSession: async () => null,
      listTestSessions: async () => [],
      getTestSessionVideoStreams: async () => [makeFallbackVideoStream()],
      getTestSessionVideoSegments: async () => [],
      getTestSessionVideoSegmentsTail: async () => ({
        items: [],
        nextCursor: undefined,
        reset: true,
        totalCount: 0,
      }),
      getTestSessionVideoSegmentsForTimestamp: async () => [],
      exportTestSessionEvidence: unsupported('exportTestSessionEvidence'),
      getTestSessionEvents: async () => [],
      getTestSessionEventsTail: async () => ({
        items: [],
        nextCursor: undefined,
        reset: true,
        totalCount: 0,
      }),
      appendTestSessionNote: async () => makeFallbackEvent(),
      purgeTestSessionEvents: async (input?: { sessionId?: string }) => ({
        sessionId: input?.sessionId ?? '',
        cleared: true,
      }),
      deleteTestSession: async (input?: { sessionId?: string; sessionIds?: string[] }) => ({
        sessionId: input?.sessionId ?? '',
        deleted: input?.sessionIds ?? (input?.sessionId ? [input.sessionId] : []),
        skipped: [],
      }),
      appendTestSessionLog: async () => null,
      subscribeSteps: noOpPromise,
      subscribeStepsV2: noOpPromise,
      unsubscribeSteps: noOpPromise,
      subscribeMetrics: noOpPromise,
      unsubscribeMetrics: noOpPromise,
      setConfig: noOpPromise,
      clearBuffer: noOpPromise,
      pause: noOpPromise,
      resume: noOpPromise,
      hideToTray: noOpPromise,
      isPaused: async () => false,
      getBuffer: async () => [],
      getBufferPage: async () => [],
      getStepImage: async () => null,
      getBufferSince: async () => [],
      getMetrics: async () => ({ ...zeroMetrics }),
      getSettings: async () => ({}),
      setSettings: async (settings: unknown) => settings as any,
      showWindow: noOpPromise,
      setFloatingToolbarCollapsed: async (collapsed: boolean) => ({ collapsed: !!collapsed }),
      getFloatingToolbarState: async () => ({ collapsed: false }),
      onStep: noOpEvent,
      onMetrics: noOpEvent,
      onActionStart: noOpEvent,
      onActionStop: noOpEvent,
      exportReport: unsupported('exportReport'),
      exportPdf: unsupported('exportPdf'),
      exportTuningSnapshot: unsupported('exportTuningSnapshot'),
      getRuntimeHealth: unsupported('getRuntimeHealth'),
      generateReplaySteps: unsupported('generateReplaySteps'),
    } as Record<string, unknown>,
    {
      get(target, property) {
        if (typeof property === 'string' && property in target) {
          return target[property];
        }
        if (typeof property === 'string' && property.startsWith('on')) {
          return noOpEvent;
        }
        if (typeof property === 'string') {
          return unsupported(property);
        }
        return undefined;
      },
    },
  ) as unknown as Window['reqcaseShadowRecorder'];
}

function ensureRecorderBridge(): void {
  const bridge = window.reqcaseShadowRecorder as Window['reqcaseShadowRecorder'] | undefined;
  if (bridge) {
    return;
  }
  console.error(
    '[shadow-recorder] window.reqcaseShadowRecorder is missing; using fallback bridge to avoid renderer crash.',
  );
  window.reqcaseShadowRecorder = createFallbackRecorderBridge();
}

ensureRecorderBridge();

window.addEventListener('error', (event) => {
  const message = event.error instanceof Error
    ? event.error.stack ?? event.error.message
    : String(event.message ?? 'unknown renderer error');
  console.error('[shadow-recorder][renderer] window error', message);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error
    ? event.reason.stack ?? event.reason.message
    : String(event.reason ?? 'unknown promise rejection');
  console.error('[shadow-recorder][renderer] unhandled rejection', reason);
});

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element');
}

createRoot(root).render(
  <React.StrictMode>
    <RecorderRootErrorBoundary>
      <RecorderPage />
    </RecorderRootErrorBoundary>
  </React.StrictMode>,
);
