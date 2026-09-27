import React from 'react';
import { createRoot } from 'react-dom/client';

import type {
  TestSessionDisplayTarget,
  TestSessionState,
  TestSessionTimelineEvent,
  TestSessionVideoSegment,
  TestSessionVideoStream,
} from '../types/contracts';
import { RecorderRootErrorBoundary } from './components/RecorderRootErrorBoundary';
import { RecorderPage } from './pages/RecorderPage';
import './styles.css';
import { initTheme } from './lib/theme';

initTheme();

function createFallbackRecorderBridge(): Window['reqcaseShadowRecorder'] {
  const noopUnsubscribe = () => {};
  
  let isRecording = false;
  let isPaused = false;
  const baseTime = Date.now() - 20000;

  const demoSession: TestSessionState = {
    schemaVersion: 1,
    kind: 'reqcase.test-session',
    sessionId: 'session-cinema-demo',
    name: 'Screen Studio Cinema Flow 验证会话',
    status: 'stopped',
    startedAtMs: baseTime,
    updatedAtMs: baseTime + 20000,
    endedAtMs: baseTime + 20000,
    bufferWindowSeconds: 90,
    segmentDurationSeconds: 5,
    recordingProfile: 'balanced',
    encoderPreference: 'auto',
    showMouseInVideo: false,
    targetCaptureMode: 'target_display',
  };

  const fallbackDisplays: TestSessionDisplayTarget[] = [
    {
      displayId: 'display-auto-primary',
      label: 'Primary Display (1920×1080)',
      left: 0,
      top: 0,
      right: 1920,
      bottom: 1080,
      width: 1920,
      height: 1080,
      isPrimary: true,
    },
  ];

  const demoStreams: TestSessionVideoStream[] = [
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-video-stream',
      streamId: 'demo-stream-1',
      sessionId: demoSession.sessionId,
      label: 'Primary Display',
      status: 'stopped',
      targetCaptureMode: 'target_display',
      displayId: 'display-auto-primary',
      displayLabel: 'Primary Display',
      width: 1920,
      height: 1080,
      startedAtMs: baseTime,
      updatedAtMs: baseTime + 20000,
      segmentDurationSeconds: 5,
      segmentCount: 4,
      playableSegmentCount: 4,
      pendingSegmentCount: 0,
      totalSegmentBytes: 1048576,
      retainedSegmentBytes: 1048576,
      sampleIntervalMs: 71,
      targetFps: 14,
      encoderAvailable: true,
      warningCount: 0,
    },
  ];

  let cachedPreviewUrl = '';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const grad = ctx.createLinearGradient(0, 0, 1920, 1080);
      grad.addColorStop(0, '#0c1222');
      grad.addColorStop(1, '#1e293b');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 1920, 1080);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      for (let x = 0; x < 1920; x += 80) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 1080);
        ctx.stroke();
      }
      for (let y = 0; y < 1080; y += 80) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(1920, y);
        ctx.stroke();
      }

      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 36px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText('影子录制器 · Screen Studio Cinema 工作台回放验证', 120, 140);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '20px monospace';
      ctx.fillText('1920 × 1080 · 14fps · NVENC H.264 · WGC 硬件捕获', 120, 190);

      ctx.fillStyle = '#0f172a';
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 2;
      ctx.fillRect(400, 260, 1120, 620);
      ctx.strokeRect(400, 260, 1120, 620);

      ctx.fillStyle = '#1e293b';
      ctx.fillRect(400, 260, 1120, 48);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText('业务客户端 - 统一身份认证', 420, 292);

      ctx.fillStyle = '#1e293b';
      ctx.strokeStyle = '#475569';
      ctx.fillRect(480, 360, 360, 46);
      ctx.strokeRect(480, 360, 360, 46);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '16px sans-serif';
      ctx.fillText('账号: admin_test', 496, 390);

      ctx.fillStyle = '#0284c7';
      ctx.fillRect(480, 520, 200, 50);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 18px sans-serif';
      ctx.fillText('登录系统', 545, 552);

      cachedPreviewUrl = canvas.toDataURL('image/png');
    }
  } catch {}

  const demoSegments: TestSessionVideoSegment[] = [
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-video-segment',
      sessionId: demoSession.sessionId,
      segmentId: 'seg-1',
      streamId: 'demo-stream-1',
      sequenceNumber: 1,
      startedAtMs: baseTime,
      endedAtMs: baseTime + 5000,
      durationMs: 5000,
      isPlayable: true,
      playbackUrl: '/demo-segment.mp4',
      bytes: 262144,
      status: 'ready',
      hasVideo: true,
      hasAudio: false,
    },
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-video-segment',
      sessionId: demoSession.sessionId,
      segmentId: 'seg-2',
      streamId: 'demo-stream-1',
      sequenceNumber: 2,
      startedAtMs: baseTime + 5000,
      endedAtMs: baseTime + 10000,
      durationMs: 5000,
      isPlayable: true,
      playbackUrl: '/demo-segment.mp4',
      bytes: 262144,
      status: 'ready',
      hasVideo: true,
      hasAudio: false,
    },
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-video-segment',
      sessionId: demoSession.sessionId,
      segmentId: 'seg-3',
      streamId: 'demo-stream-1',
      sequenceNumber: 3,
      startedAtMs: baseTime + 10000,
      endedAtMs: baseTime + 15000,
      durationMs: 5000,
      isPlayable: true,
      playbackUrl: '/demo-segment.mp4',
      bytes: 262144,
      status: 'ready',
      hasVideo: true,
      hasAudio: false,
    },
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-video-segment',
      sessionId: demoSession.sessionId,
      segmentId: 'seg-4',
      streamId: 'demo-stream-1',
      sequenceNumber: 4,
      startedAtMs: baseTime + 15000,
      endedAtMs: baseTime + 20000,
      durationMs: 5000,
      isPlayable: true,
      playbackUrl: '/demo-segment.mp4',
      bytes: 262144,
      status: 'ready',
      hasVideo: true,
      hasAudio: false,
    },
  ];

  const demoSteps = [
    {
      id: 'step-1',
      stepId: 'step-1',
      timestampMs: baseTime + 3200,
      action: 'click',
      x: 1265,
      y: 744,
      title: '点击「登录系统」按钮',
      controlName: '登录系统',
      automationId: 'btn-signin',
      className: 'PrimaryButton',
      processName: 'SentinelEnterprise.exe',
      element: {
        boundingRect: {
          left: 1036,
          top: 714,
          right: 1493,
          bottom: 773,
        },
      },
    },
    {
      id: 'step-2',
      stepId: 'step-2',
      timestampMs: baseTime + 8500,
      action: 'input',
      logicalX: 1012,
      logicalY: 394,
      dpiScale: 1.25,
      title: '输入认证用户名与邮箱',
      controlName: 'Username / Email',
      automationId: 'input-username',
      className: 'TextBox',
      processName: 'SentinelEnterprise.exe',
    },
    {
      id: 'step-3',
      stepId: 'step-3',
      timestampMs: baseTime + 14000,
      action: 'click',
      logicalX: 1050,
      logicalY: 640,
      dpiScale: undefined,
      title: '点击重置凭据 (缺失 DPI)',
      controlName: 'Forgot Password?',
      automationId: 'link-forgot-password',
      className: 'Hyperlink',
      processName: 'SentinelEnterprise.exe',
    },
    {
      id: 'step-4',
      stepId: 'step-4',
      timestampMs: baseTime + 17500,
      action: 'click',
      x: 3200,
      y: 1800,
      title: '外部监视器点击 (越界)',
      controlName: '副屏控件',
      processName: 'AuxMonitor.exe',
    },
  ];

  const demoOperations = [
    {
      operationId: 'op-1',
      sessionId: demoSession.sessionId,
      startedAtMs: baseTime + 3100,
      endedAtMs: baseTime + 3300,
      sourceEventIds: ['step-1'],
      category: 'click',
      summary: '点击「登录系统」按钮',
      action: {
        type: 'click',
        target: { name: '登录系统', automationId: 'btn-signin' },
      },
    },
    {
      operationId: 'op-2',
      sessionId: demoSession.sessionId,
      startedAtMs: baseTime + 8400,
      endedAtMs: baseTime + 8600,
      sourceEventIds: ['step-2'],
      category: 'input',
      summary: '输入用户名与邮箱',
      action: {
        type: 'input',
        target: { name: 'Username / Email', automationId: 'input-username' },
      },
    },
    {
      operationId: 'op-3',
      sessionId: demoSession.sessionId,
      startedAtMs: baseTime + 13900,
      endedAtMs: baseTime + 14100,
      sourceEventIds: ['step-3'],
      category: 'click',
      summary: '点击 Forgot Password (缺失 DPI)',
      action: {
        type: 'click',
        target: { name: 'Forgot Password?', automationId: 'link-forgot-password' },
      },
    },
    {
      operationId: 'op-4',
      sessionId: demoSession.sessionId,
      startedAtMs: baseTime + 17400,
      endedAtMs: baseTime + 17600,
      sourceEventIds: ['step-4'],
      category: 'click',
      summary: '副屏外部点击 (越界)',
      action: {
        type: 'click',
        target: { name: '副屏控件' },
      },
    },
  ];

  const demoEvents: TestSessionTimelineEvent[] = [
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-event',
      eventId: 'evt-1',
      sessionId: demoSession.sessionId,
      eventType: 'session_started',
      logCategory: 'recording',
      occurredAtMs: baseTime,
      title: '录制已启动',
      message: '开始全屏桌面录制',
    },
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-event',
      eventId: 'evt-2',
      sessionId: demoSession.sessionId,
      eventType: 'step_captured',
      logCategory: 'operation',
      occurredAtMs: baseTime + 3200,
      title: '点击登录按钮',
      stepId: 'step-1',
    },
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-event',
      eventId: 'evt-3',
      sessionId: demoSession.sessionId,
      eventType: 'step_captured',
      logCategory: 'operation',
      occurredAtMs: baseTime + 8500,
      title: '输入认证账号',
      stepId: 'step-2',
    },
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-event',
      eventId: 'evt-4',
      sessionId: demoSession.sessionId,
      eventType: 'defect_marked' as any,
      logCategory: 'recording',
      occurredAtMs: baseTime + 11500,
      title: '登录接口偶发 504 Gateway Timeout',
      message: '用户点击登录后加载指示器持续转圈，未能跳转主界面',
      metadata: { leadSeconds: 4, postSeconds: 3 },
    },
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-event',
      eventId: 'evt-5',
      sessionId: demoSession.sessionId,
      eventType: 'step_captured',
      logCategory: 'operation',
      occurredAtMs: baseTime + 14000,
      title: '点击重置凭据',
      stepId: 'step-3',
    },
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-event',
      eventId: 'evt-6',
      sessionId: demoSession.sessionId,
      eventType: 'step_captured',
      logCategory: 'operation',
      occurredAtMs: baseTime + 17500,
      title: '外部监视器点击',
      stepId: 'step-4',
    },
    {
      schemaVersion: 1,
      kind: 'reqcase.test-session-event',
      eventId: 'evt-7',
      sessionId: demoSession.sessionId,
      eventType: 'session_stopped',
      logCategory: 'recording',
      occurredAtMs: baseTime + 20000,
      title: '录制已停止',
      message: '会话已封口完成',
    },
  ];

  const demoMetrics = {
    capturedStepsTotal: 4,
    droppedStepsTotal: 0,
    inputChannelFullDropTotal: 0,
    pushDispatchDropTotal: 0,
    bufferSteps: 4,
    bufferBytes: 1048576,
    lastCaptureLatencyMs: 8.6,
    lastEncodeLatencyMs: 11.2,
    lastImageBytes: 42000,
    currentEffectiveQuality: 80,
    qualityAdjustDownCount: 0,
    qualityAdjustUpCount: 0,
    wgcCaptureCount: 280,
    dxgiCaptureCount: 0,
    resourceUsage: {
      totalWorkingSetMb: 148,
    },
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
      start: async () => {
        isRecording = true;
        isPaused = false;
        demoSession.status = 'active';
      },
      stop: async () => {
        isRecording = false;
        isPaused = false;
        demoSession.status = 'stopped';
      },
      pause: async () => {
        isPaused = true;
        demoSession.status = 'paused';
      },
      resume: async () => {
        isPaused = false;
        demoSession.status = 'active';
      },
      isPaused: async () => isPaused,
      listAvailableDisplays: async () => fallbackDisplays,
      getActiveTestSession: async () => (isRecording ? demoSession : null),
      listTestSessions: async () => [demoSession],
      getTestSessionVideoStreams: async () => demoStreams,
      getTestSessionVideoSegments: async () => demoSegments,
      getTestSessionVideoSegmentsTail: async () => ({
        items: demoSegments,
        nextCursor: undefined,
        reset: true,
        totalCount: demoSegments.length,
      }),
      getTestSessionVideoSegmentsForTimestamp: async () => demoSegments,
      exportTestSessionEvidence: unsupported('exportTestSessionEvidence'),
      getTestSessionEvents: async () => demoEvents,
      getTestSessionEventsTail: async () => ({
        items: demoEvents,
        nextCursor: undefined,
        reset: true,
        totalCount: demoEvents.length,
      }),
      getTestSessionSteps: async () => ({
        items: demoSteps,
        total: demoSteps.length,
      }),
      getTestSessionOperations: async () => ({
        items: demoOperations,
        total: demoOperations.length,
      }),
      markTestDefect: async (input?: {
        sessionId?: string;
        note?: string;
        expected?: string;
        actual?: string;
        markedAtMs?: number;
        preWindowSeconds?: number;
        postWindowSeconds?: number;
      }) => {
        const markedAtMs = Number(input?.markedAtMs ?? Date.now());
        const preWindowSeconds = Number(input?.preWindowSeconds ?? 10);
        const postWindowSeconds = Number(input?.postWindowSeconds ?? 10);
        const note = input?.note || input?.actual || '瞬时打标 / 标记缺陷';
        const windowStartMs = Math.max(0, markedAtMs - preWindowSeconds * 1000);
        const windowEndMs = markedAtMs + postWindowSeconds * 1000;
        const newEvt: TestSessionTimelineEvent = {
          schemaVersion: 1,
          kind: 'reqcase.test-session-event',
          eventId: `evt-defect-${Date.now()}`,
          sessionId: input?.sessionId || demoSession.sessionId,
          eventType: 'defect_marked' as any,
          logCategory: 'recording',
          occurredAtMs: markedAtMs,
          title: note,
          message: input?.actual || input?.expected || `${note} (窗口 ${preWindowSeconds + postWindowSeconds}s)`,
          metadata: {
            leadSeconds: preWindowSeconds,
            postSeconds: postWindowSeconds,
            preWindowSeconds,
            postWindowSeconds,
            windowStartMs,
            windowEndMs,
          },
        };
        demoEvents.push(newEvt);
        return {
          event: newEvt,
          markedAtMs,
          windowStartMs,
          windowEndMs,
          preWindowSeconds,
          postWindowSeconds,
          note: input?.note,
          expected: input?.expected,
          actual: input?.actual,
          stepCount: demoSteps.length,
          markedStepCount: demoSteps.length,
          totalSteps: demoSteps.length,
        };
      },
      renderTestSessionReproSteps: async () => null,
      exportTestDefectPack: async () => ({
        packDir: '/mock/exports/defect-pack',
        reproStepsPath: '/mock/exports/defect-pack/repro_steps.md',
        stepCount: demoSteps.length,
        screenshotCount: demoSteps.length,
        videoSegmentCount: demoSegments.length,
        clipPath: '/mock/exports/defect-pack/clip.mp4',
        clipBuilt: true,
      }),
      appendTestSessionNote: async (input?: { title?: string; message?: string }) => {
        const newEvt: TestSessionTimelineEvent = {
          schemaVersion: 1,
          kind: 'reqcase.test-session-event',
          eventId: `evt-note-${Date.now()}`,
          sessionId: demoSession.sessionId,
          eventType: 'defect_marked' as any,
          logCategory: 'recording',
          occurredAtMs: Date.now(),
          title: input?.title || '新标记缺陷',
          message: input?.message || '',
          metadata: { leadSeconds: 5, postSeconds: 3 },
        };
        demoEvents.push(newEvt);
        return newEvt;
      },
      purgeTestSessionEvents: async (input?: { sessionId?: string }) => ({
        sessionId: input?.sessionId ?? '',
        cleared: true,
      }),
      updateTestSessionMeta: async (input?: { sessionId?: string; name?: string; notes?: string }) => {
        const name = String(input?.name ?? '').trim();
        if (!name || [...name].length > 80 || /[\\/:\n\r]/.test(name)) {
          return { error: 'Invalid session name' };
        }
        if (typeof input?.notes === 'string' && [...input.notes].length > 2000) {
          return { error: 'Session notes exceed 2000 characters' };
        }
        if (!input?.sessionId || input.sessionId === demoSession.sessionId) {
          demoSession.name = name;
          demoSession.notes = input?.notes;
        }
        return { ...demoSession, name, notes: input?.notes };
      },
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
      hideToTray: noOpPromise,
      getBuffer: async () => [],
      getBufferPage: async () => [],
      getStepImage: async () => null,
      getBufferSince: async () => [],
      getMetrics: async () => ({ ...demoMetrics }),
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
