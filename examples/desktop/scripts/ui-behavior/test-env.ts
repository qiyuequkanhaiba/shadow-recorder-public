import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

import type {
  RecorderConfigPayload,
  RecorderMetrics,
  RecorderPersistedSettings,
  RecorderRuntimeHealth,
  RecorderStep,
  TestSessionDisplayTarget,
  TestSessionEvidenceExportResult,
  TestSessionOperationRecord,
  TestSessionOperationTailResult,
  TestSessionState,
  TestSessionTimelineEvent,
  TestSessionVideoSegment,
  TestSessionVideoStream,
} from '../../types/contracts';

export function createMockSession(
  overrides: Partial<TestSessionState> & { sessionId: string },
): TestSessionState {
  return {
    schemaVersion: 1,
    kind: 'reqcase.test-session',
    status: 'stopped',
    startedAtMs: 1700000000000,
    updatedAtMs: 1700000010000,
    endedAtMs: 1700000010000,
    bufferWindowSeconds: 180,
    segmentDurationSeconds: 10,
    recordingProfile: 'balanced',
    encoderPreference: 'auto',
    targetCaptureMode: 'target_display',
    ...overrides,
  };
}

export function createMockVideoSegment(
  overrides: Partial<TestSessionVideoSegment> & { segmentId: string; sessionId: string },
): TestSessionVideoSegment {
  return {
    schemaVersion: 1,
    kind: 'reqcase.test-session-video-segment',
    streamId: 'stream-1',
    status: 'ready',
    startedAtMs: 1700000000000,
    endedAtMs: 1700000010000,
    durationMs: 10000,
    sizeBytes: 102400,
    isPlayable: true,
    filePath: `C:/videos/${overrides.segmentId}.mp4`,
    playbackUrl: `file:///C:/videos/${overrides.segmentId}.mp4`,
    ...overrides,
  };
}

// Register CSS / CSS Modules loader hook for Node tsx execution
try {
  registerHooks({
     load(url, context, nextLoad) {
      if (url.endsWith('.css') || url.includes('.css?')) {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            const proxy = new Proxy({}, {
              get(_target, prop) {
                if (prop === '__esModule') return false;
                if (typeof prop === 'symbol') return undefined;
                return String(prop);
              }
            });
            export default proxy;
          `,
        };
      }
      return nextLoad(url, context);
    },
  });
} catch {
  // Fallback if registerHooks is already registered or unavailable
}

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true,
});

const { window } = dom;

Object.defineProperties(globalThis, {
  window: { value: window, configurable: true, writable: true },
  document: { value: window.document, configurable: true, writable: true },
  navigator: { value: window.navigator, configurable: true, writable: true },
  location: { value: window.location, configurable: true, writable: true },
  HTMLElement: { value: window.HTMLElement, configurable: true, writable: true },
  SVGElement: { value: window.SVGElement, configurable: true, writable: true },
  Element: { value: window.Element, configurable: true, writable: true },
  Node: { value: window.Node, configurable: true, writable: true },
  Text: { value: window.Text, configurable: true, writable: true },
  DocumentFragment: { value: window.DocumentFragment, configurable: true, writable: true },
  HTMLInputElement: { value: window.HTMLInputElement, configurable: true, writable: true },
  HTMLSelectElement: { value: window.HTMLSelectElement, configurable: true, writable: true },
  HTMLTextAreaElement: { value: window.HTMLTextAreaElement, configurable: true, writable: true },
  HTMLButtonElement: { value: window.HTMLButtonElement, configurable: true, writable: true },
  HTMLVideoElement: { value: window.HTMLVideoElement, configurable: true, writable: true },
  HTMLMediaElement: { value: window.HTMLMediaElement, configurable: true, writable: true },
  HTMLCanvasElement: { value: window.HTMLCanvasElement, configurable: true, writable: true },
  Event: { value: window.Event, configurable: true, writable: true },
  CustomEvent: { value: window.CustomEvent, configurable: true, writable: true },
  MouseEvent: { value: window.MouseEvent, configurable: true, writable: true },
  KeyboardEvent: { value: window.KeyboardEvent, configurable: true, writable: true },
  FocusEvent: { value: window.FocusEvent, configurable: true, writable: true },
  MutationObserver: { value: window.MutationObserver, configurable: true, writable: true },
  getComputedStyle: { value: window.getComputedStyle.bind(window), configurable: true, writable: true },
  localStorage: { value: window.localStorage, configurable: true, writable: true },
  sessionStorage: { value: window.sessionStorage, configurable: true, writable: true },
  requestAnimationFrame: {
    value: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
    configurable: true,
    writable: true,
  },
  cancelAnimationFrame: {
    value: (id: number) => clearTimeout(id),
    configurable: true,
    writable: true,
  },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true, writable: true },
});

if (typeof (globalThis as Record<string, unknown>).PointerEvent === 'undefined') {
  class MockPointerEvent extends window.MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 1;
      this.pointerType = params.pointerType ?? 'mouse';
    }
  }
  Object.defineProperty(globalThis, 'PointerEvent', {
    value: MockPointerEvent,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, 'PointerEvent', {
    value: MockPointerEvent,
    configurable: true,
    writable: true,
  });
}

if (typeof (globalThis as Record<string, unknown>).ResizeObserver === 'undefined') {
  class MockResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: MockResizeObserver,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, 'ResizeObserver', {
    value: MockResizeObserver,
    configurable: true,
    writable: true,
  });
}

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

if (!window.navigator.clipboard) {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: {
      writeText: async () => undefined,
      readText: async () => '',
    },
    configurable: true,
  });
}

if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = () => {};
}

if (!window.HTMLElement.prototype.setPointerCapture) {
  window.HTMLElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.releasePointerCapture = () => {};
}

// Stub HTMLMediaElement methods for JSDOM
window.HTMLMediaElement.prototype.play = async function play(this: HTMLMediaElement) {
  Object.defineProperty(this, 'paused', { value: false, configurable: true });
  this.dispatchEvent(new window.Event('play'));
};
window.HTMLMediaElement.prototype.pause = function pause(this: HTMLMediaElement) {
  Object.defineProperty(this, 'paused', { value: true, configurable: true });
  this.dispatchEvent(new window.Event('pause'));
};
window.HTMLMediaElement.prototype.load = function load() {};

export type BridgeCallRecord = {
  method: string;
  args: unknown[];
};

export type ExportProgressPayload = {
  percent: number;
  message: string;
  phase: 'idle' | 'running' | 'complete' | 'canceled' | 'failed';
};

export type MockBridgeController = {
  calls: BridgeCallRecord[];
  callsFor: (method: string) => BridgeCallRecord[];
  clearCalls: () => void;
  emitExportProgress: (payload: ExportProgressPayload) => void;
  emitActionStart: () => void;
  emitActionStop: () => void;
  setActiveSession: (session: TestSessionState | null) => void;
  setSessions: (sessions: TestSessionState[]) => void;
  setVideoSegments: (segments: TestSessionVideoSegment[]) => void;
  setVideoStreams: (streams: TestSessionVideoStream[]) => void;
  setSettingsResult: (settings: RecorderPersistedSettings) => void;
  setDeleteResult: (result: { sessionId?: string; deleted?: boolean | string[]; skipped?: string[] }) => void;
  overrides: Partial<Record<string, (...args: any[]) => any>>;
};

export function installMockShadowRecorderBridge(options?: {
  activeSession?: TestSessionState | null;
  sessions?: TestSessionState[];
  videoSegments?: TestSessionVideoSegment[];
  videoStreams?: TestSessionVideoStream[];
  settings?: RecorderPersistedSettings;
  displays?: TestSessionDisplayTarget[];
  operations?: TestSessionOperationRecord[];
}): MockBridgeController {
  const calls: BridgeCallRecord[] = [];
  const exportProgressListeners = new Set<(payload: ExportProgressPayload) => void>();
  const actionStartListeners = new Set<() => void>();
  const actionStopListeners = new Set<() => void>();

  let activeSession: TestSessionState | null = options?.activeSession ?? null;
  let sessions: TestSessionState[] = options?.sessions ?? (activeSession ? [activeSession] : []);
  let videoSegments: TestSessionVideoSegment[] = options?.videoSegments ?? [];
  let videoStreams: TestSessionVideoStream[] = options?.videoStreams ?? [];
  let persistedSettings: RecorderPersistedSettings = options?.settings ?? {};
  let deleteResult: { sessionId?: string; deleted?: boolean | string[]; skipped?: string[] } = {
    deleted: [],
    skipped: [],
  };
  let recording = Boolean(activeSession && (activeSession.status === 'active' || activeSession.status === 'paused'));
  let paused = activeSession?.status === 'paused';

  const overrides: Partial<Record<string, (...args: any[]) => any>> = {};

  function record<T>(method: string, impl: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]): T => {
      calls.push({
        method,
        args: args.map((arg) => {
          try {
            return typeof arg === 'function' ? '[Function]' : structuredClone(arg);
          } catch {
            return arg;
          }
        }),
      });
      if (overrides[method]) {
        return overrides[method]!(...args);
      }
      return impl(...args);
    };
  }

  const defaultMetrics: RecorderMetrics = {
    capturedStepsTotal: 0,
    droppedStepsTotal: 0,
    inputChannelFullDropTotal: 0,
    pushDispatchDropTotal: 0,
    bufferSteps: 0,
    bufferBytes: 0,
    lastCaptureLatencyMs: 12,
    lastEncodeLatencyMs: 8,
    lastImageBytes: 0,
    currentEffectiveQuality: 75,
    qualityAdjustDownCount: 0,
    qualityAdjustUpCount: 0,
    wgcCaptureCount: 0,
    dxgiCaptureCount: 0,
  };

  const api = {
    start: record('start', async () => {
      recording = true;
      paused = false;
      if (!activeSession) {
        const created = createMockSession({
          sessionId: 'session-live-1',
          name: '实时录制会话',
          status: 'active',
          startedAtMs: 1700000000000,
          updatedAtMs: 1700000001000,
        });
        activeSession = created;
        if (!sessions.some((item) => item.sessionId === created.sessionId)) {
          sessions = [created, ...sessions];
        }
      }
    }),
    stop: record('stop', async () => {
      recording = false;
      paused = false;
      if (activeSession) {
        activeSession = { ...activeSession, status: 'stopped', endedAtMs: 1700000010000 };
      }
    }),
    pause: record('pause', async () => {
      paused = true;
    }),
    resume: record('resume', async () => {
      paused = false;
    }),
    isPaused: record('isPaused', async () => paused),
    setConfig: record('setConfig', async (_config: RecorderConfigPayload) => undefined),
    getSettings: record('getSettings', async () => persistedSettings),
    setSettings: record('setSettings', async (next: RecorderPersistedSettings) => {
      persistedSettings = { ...persistedSettings, ...next };
      return persistedSettings;
    }),
    hideToTray: record('hideToTray', async () => undefined),
    showWindow: record('showWindow', async () => undefined),
    setFloatingToolbarCollapsed: record('setFloatingToolbarCollapsed', async (collapsed: boolean) => ({
      collapsed,
    })),
    getFloatingToolbarState: record('getFloatingToolbarState', async () => ({
      collapsed: false,
      theme: 'dark' as const,
    })),
    setUiTheme: record('setUiTheme', async (theme: 'dark' | 'light') => ({ theme })),
    listAvailableDisplays: record('listAvailableDisplays', async () => options?.displays ?? [
      {
        displayId: 'display-1',
        label: '主显示器 1',
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1080,
        width: 1920,
        height: 1080,
        isPrimary: true,
      },
    ]),
    getActiveTestSession: record('getActiveTestSession', async () => activeSession),
    listTestSessions: record('listTestSessions', async () => sessions),
    getTestSessionEvents: record('getTestSessionEvents', async (): Promise<TestSessionTimelineEvent[]> => []),
    getTestSessionEventsTail: record('getTestSessionEventsTail', async () => ({
      items: [],
      reset: false,
      totalCount: 0,
    })),
    getTestSessionVideoStreams: record('getTestSessionVideoStreams', async () => videoStreams),
    getTestSessionVideoSegments: record('getTestSessionVideoSegments', async () => videoSegments),
    getTestSessionVideoSegmentsTail: record('getTestSessionVideoSegmentsTail', async () => ({
      items: videoSegments,
      reset: true,
      totalCount: videoSegments.length,
    })),
    getTestSessionVideoSegmentsForTimestamp: record(
      'getTestSessionVideoSegmentsForTimestamp',
      async () => videoSegments,
    ),
    getTestSessionOperations: record(
      'getTestSessionOperations',
      async (): Promise<TestSessionOperationTailResult> => ({
        items: options?.operations ?? [],
        reset: true,
        totalCount: options?.operations?.length ?? 0,
        diagnostics: [],
      }),
    ),
    getTestSessionOperation: record('getTestSessionOperation', async () => null),
    rebuildTestSessionOperations: record('rebuildTestSessionOperations', async () => options?.operations ?? []),
    updateTestSessionOperation: record('updateTestSessionOperation', async (input: any) => input),
    getTestSessionSteps: record('getTestSessionSteps', async () => []),
    rebuildTestSessionSteps: record('rebuildTestSessionSteps', async () => []),
    renderTestSessionReproSteps: record('renderTestSessionReproSteps', async () => '# 复现步骤'),
    exportTestDefectPack: record('exportTestDefectPack', async () => ({
      exportDir: 'C:/exports/defect-pack',
      manifestPath: 'C:/exports/defect-pack/manifest.json',
    })),
    updateTestSessionStep: record('updateTestSessionStep', async () => ({})),
    updateTestSessionMeta: record('updateTestSessionMeta', async (input: any) => input),
    markTestDefect: record('markTestDefect', async (input?: any) => ({
      defectId: 'defect-1',
      sessionId: input?.sessionId ?? activeSession?.sessionId ?? 'session-1',
      title: input?.title ?? '操作问题标记',
      markedAtMs: input?.markedAtMs ?? 1700000005000,
      preWindowSeconds: 60,
      postWindowSeconds: 20,
      windowStartMs: 1699999945000,
      windowEndMs: 1700000025000,
    })),
    appendTestSessionNote: record('appendTestSessionNote', async (input?: any) => ({
      eventId: 'evt-note-1',
      sessionId: input?.sessionId ?? activeSession?.sessionId ?? 'session-1',
      eventType: 'manual_note',
      occurredAtMs: 1700000005000,
      relativeMsFromSessionStart: 5000,
      title: '人工备注',
      summary: input?.note ?? '',
    })),
    appendTestSessionLog: record('appendTestSessionLog', async () => null),
    purgeTestSessionEvents: record('purgeTestSessionEvents', async (input?: { sessionId?: string }) => ({
      sessionId: input?.sessionId ?? 'session-1',
      cleared: true,
    })),
    deleteTestSession: record('deleteTestSession', async (input?: { sessionId?: string; sessionIds?: string[] }) => {
      const requested = input?.sessionIds ?? (input?.sessionId ? [input.sessionId] : []);
      if (deleteResult.deleted && Array.isArray(deleteResult.deleted) && deleteResult.deleted.length > 0) {
        sessions = sessions.filter((s) => !(deleteResult.deleted as string[]).includes(s.sessionId));
        return deleteResult;
      }
      if (deleteResult.skipped && deleteResult.skipped.length > 0) {
        const skippedSet = new Set(deleteResult.skipped);
        const deletedIds = requested.filter((id) => !skippedSet.has(id));
        sessions = sessions.filter((s) => !deletedIds.includes(s.sessionId));
        return {
          deleted: deletedIds,
          skipped: deleteResult.skipped,
        };
      }
      sessions = sessions.filter((s) => !requested.includes(s.sessionId));
      return {
        deleted: requested,
        skipped: [],
      };
    }),
    exportTestSessionEvidence: record(
      'exportTestSessionEvidence',
      async (input?: any): Promise<TestSessionEvidenceExportResult> => ({
        sessionId: input?.sessionId ?? activeSession?.sessionId ?? 'session-1',
        outputMode: input?.outputMode ?? 'zip',
        bundleRootName: 'session-1-bundle',
        artifactPath: 'C:/exports/session-1.zip',
        exportDir: 'C:/exports/session-1',
        zipPath: input?.outputMode === 'zip' ? 'C:/exports/session-1.zip' : undefined,
        manifestPath: 'C:/exports/session-1/manifest.json',
        eventCount: 2,
        videoSegmentCount: 1,
      }),
    ),
    onExportProgress: (handler: (payload: ExportProgressPayload) => void) => {
      exportProgressListeners.add(handler);
      return () => {
        exportProgressListeners.delete(handler);
      };
    },
    subscribeSteps: record('subscribeSteps', async () => undefined),
    subscribeStepsV2: record('subscribeStepsV2', async () => undefined),
    unsubscribeSteps: record('unsubscribeSteps', async () => undefined),
    onStep: (_handler: (step: RecorderStep) => void) => () => undefined,
    subscribeMetrics: record('subscribeMetrics', async () => undefined),
    unsubscribeMetrics: record('unsubscribeMetrics', async () => undefined),
    onMetrics: (_handler: (metrics: RecorderMetrics) => void) => () => undefined,
    clearBuffer: record('clearBuffer', async () => undefined),
    getBuffer: record('getBuffer', async () => []),
    getBufferPage: record('getBufferPage', async () => []),
    getStepImage: record('getStepImage', async () => null),
    getBufferSince: record('getBufferSince', async () => []),
    getMetrics: record('getMetrics', async () => defaultMetrics),
    getRuntimeHealth: record('getRuntimeHealth', async (): Promise<RecorderRuntimeHealth> => ({
      recording,
      paused,
      captureBackend: 'dxgi',
      strictBackend: false,
      transportMode: 'push',
      streamPayload: 'meta_only',
      deltaMode: 'hash_dedup',
      metrics: defaultMetrics,
      resourceUsage: null,
    })),
    generateReplaySteps: record('generateReplaySteps', async () => ({
      markdown: '',
      stepCount: 0,
      generatedAt: new Date(1700000000000).toISOString(),
    })),
    exportReport: record('exportReport', async () => ({
      jsonPath: 'C:/exports/report.json',
      markdownPath: 'C:/exports/report.md',
      stepCount: 0,
    })),
    exportPdf: record('exportPdf', async () => ({
      jsonPath: 'C:/exports/report.json',
      markdownPath: 'C:/exports/report.md',
      pdfPath: 'C:/exports/report.pdf',
      stepCount: 0,
    })),
    exportTuningSnapshot: record('exportTuningSnapshot', async () => ({
      snapshotPath: 'C:/exports/tuning.json',
      exportedAt: new Date(1700000000000).toISOString(),
    })),
    listScreenshotHistory: record('listScreenshotHistory', async () => []),
    beginAreaScreenshot: record('beginAreaScreenshot', async () => undefined),
    suspendScreenshotHotkeys: record('suspendScreenshotHotkeys', async () => undefined),
    resumeScreenshotHotkeys: record('resumeScreenshotHotkeys', async () => undefined),
    getSemanticProfileJson: record('getSemanticProfileJson', async () => null),
    setSemanticProfileJson: record('setSemanticProfileJson', async () => 'profile-1'),
    clearSemanticProfile: record('clearSemanticProfile', async () => undefined),
    onActionStart: (handler: () => void) => {
      actionStartListeners.add(handler);
      return () => {
        actionStartListeners.delete(handler);
      };
    },
    onActionStop: (handler: () => void) => {
      actionStopListeners.add(handler);
      return () => {
        actionStopListeners.delete(handler);
      };
    },
  };

  Object.defineProperty(window, 'reqcaseShadowRecorder', {
    value: api,
    configurable: true,
    writable: true,
  });

  return {
    calls,
    callsFor: (method: string) => calls.filter((c) => c.method === method),
    clearCalls: () => {
      calls.length = 0;
    },
    emitExportProgress: (payload: ExportProgressPayload) => {
      for (const listener of exportProgressListeners) {
        listener(payload);
      }
    },
    emitActionStart: () => {
      for (const listener of actionStartListeners) {
        listener();
      }
    },
    emitActionStop: () => {
      for (const listener of actionStopListeners) {
        listener();
      }
    },
    setActiveSession: (session: TestSessionState | null) => {
      activeSession = session;
    },
    setSessions: (next: TestSessionState[]) => {
      sessions = next;
    },
    setVideoSegments: (next: TestSessionVideoSegment[]) => {
      videoSegments = next;
    },
    setVideoStreams: (next: TestSessionVideoStream[]) => {
      videoStreams = next;
    },
    setSettingsResult: (next: RecorderPersistedSettings) => {
      persistedSettings = next;
    },
    setDeleteResult: (next) => {
      deleteResult = next;
    },
    overrides,
  };
}
