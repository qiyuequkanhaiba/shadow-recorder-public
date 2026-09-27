import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';

import type {
  RecorderConfigPayload,
  RecorderMetrics,
  RecorderResourceUsage,
  TestSessionPlaybackFocus,
  TestSessionState,
  TestSessionTimelineEvent,
  TestSessionVideoSegment,
  TestSessionVideoStream,
} from '../../types/contracts';
import type { TestSessionOperationRecord } from '../../types/operation-contracts';
import { useDocumentVisibility } from '../hooks/useDocumentVisibility';
import { appendNoteForActiveQuickDefect } from '../lib/quick-defect-fallback';
import { resolveVideoEncoderSummary } from '../lib/video-encoder-summary';
import {
  StudioDrawer,
  type CoordinateMappingResult,
  type DrawerTab,
  type SelectedTimelineItem,
  type SemanticStepRow,
} from './StudioDrawer';
import {
  StudioTimelineDock,
  type ContinuousPlaybackSegment,
} from './StudioTimelineDock';

export type RecorderPlaybackStageProps = {
  isRecording: boolean;
  isPaused: boolean;
  metrics: RecorderMetrics | null;
  resourceUsage: RecorderResourceUsage | null;
  activeSession: TestSessionState | null;
  playbackSession: TestSessionState | null;
  videoStreams: TestSessionVideoStream[];
  recentSegments: TestSessionVideoSegment[];
  matchedSegments: TestSessionVideoSegment[];
  playbackFocus?: TestSessionPlaybackFocus | null;
  timelineEvents?: TestSessionTimelineEvent[];
  config?: RecorderConfigPayload;
  onNotice?: (message: string) => void;
  onMarked?: () => void;
  onPlaybackFocusChange?: (focus: TestSessionPlaybackFocus | null) => void;
  onExportSession?: () => Promise<void>;
  isExporting?: boolean;
  onClearEvents?: () => Promise<void> | void;
};

function resolveBackendLabel(metrics: RecorderMetrics | null): string {
  if (!metrics) {
    return '--';
  }
  if (metrics.wgcCaptureCount > 0 && metrics.dxgiCaptureCount > 0) {
    return 'DXGI/WGC';
  }
  if (metrics.wgcCaptureCount > 0) {
    return 'WGC';
  }
  if (metrics.dxgiCaptureCount > 0) {
    return 'DXGI';
  }
  return '--';
}

function resolveHardwareEncoderBrand(encoderName?: string | null): string | null {
  if (!encoderName) {
    return null;
  }
  const lower = encoderName.toLowerCase();
  if (lower.includes('nvenc')) {
    return 'NVIDIA NVENC';
  }
  if (lower.includes('qsv')) {
    return 'Intel QSV';
  }
  if (lower.includes('amf')) {
    return 'AMD AMF';
  }
  return null;
}

function formatClock(durationMs?: number): string {
  if (!durationMs || durationMs <= 0) {
    return '00:00';
  }
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatDateTime(timestampMs?: number): string {
  if (!timestampMs) {
    return '--';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestampMs));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function buildContinuousPlaybackSegments(
  segments: TestSessionVideoSegment[],
): ContinuousPlaybackSegment[] {
  const sortedSegments = segments
    .slice()
    .sort((left, right) => left.startedAtMs - right.startedAtMs);

  let accumulatedStartMs = 0;
  return sortedSegments.map((segment) => {
    const durationMs = Math.max(segment.durationMs ?? 0, 0);
    const nextSegment: ContinuousPlaybackSegment = {
      ...segment,
      accumulatedStartMs,
      accumulatedEndMs: accumulatedStartMs + durationMs,
    };
    accumulatedStartMs += durationMs;
    return nextSegment;
  });
}

function TransportGlyph(props: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {props.children}
    </svg>
  );
}

function findSegmentIndexForPlaybackTime(
  segments: ContinuousPlaybackSegment[],
  playbackTimeMs: number,
): number {
  if (segments.length === 0) {
    return -1;
  }

  const clampedTimeMs = clampNumber(
    playbackTimeMs,
    0,
    Math.max(segments[segments.length - 1]?.accumulatedEndMs ?? 0, 0),
  );

  return segments.findIndex((segment) => clampedTimeMs < segment.accumulatedEndMs);
}

export function RecorderPlaybackStage(props: RecorderPlaybackStageProps) {
  const pageVisible = useDocumentVisibility();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const globalPlaybackMsRef = useRef(0);
  const lastTimeUpdateEmitAtRef = useRef(0);
  const timeUpdateRafRef = useRef<number | null>(null);
  const playerRootRef = useRef<HTMLDivElement | null>(null);
  const pendingSeekSecondsRef = useRef<number | null>(null);
  const quickDefectPendingRef = useRef(false);

  const [globalPlaybackMs, setGlobalPlaybackMs] = useState(0);
  const [isPlaybackRunning, setIsPlaybackRunning] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideControlsTimerRef = useRef<number | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(0);
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null);
  const [isQuickDefectPending, setIsQuickDefectPending] = useState(false);

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('defect');
  const [selectedItem, setSelectedItem] = useState<SelectedTimelineItem | null>(null);
  const [semanticSteps, setSemanticSteps] = useState<SemanticStepRow[]>([]);
  const [operations, setOperations] = useState<TestSessionOperationRecord[]>([]);
  const [frameDimensions, setFrameDimensions] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  const currentSessionId = props.activeSession?.sessionId || props.playbackSession?.sessionId || null;

  // Measure actual dimensions of player frame for precise coordinate overlay mapping
  useEffect(() => {
    const el = playerRootRef.current;
    if (!el) return;
    const update = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        setFrameDimensions({ width: el.clientWidth, height: el.clientHeight });
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isFullscreen]);

  // Load semantic steps and operations for current session if available
  useEffect(() => {
    let cancelled = false;
    async function loadStepsAndOperations() {
      if (!currentSessionId) {
        if (!cancelled) {
          setSemanticSteps([]);
          setOperations([]);
        }
        return;
      }
      const api = (window as unknown as {
        reqcaseShadowRecorder?: {
          getTestSessionSteps?: (arg: { sessionId: string }) => Promise<unknown[]>;
          getTestSessionOperations?: (arg: { sessionId: string; limit?: number }) => Promise<unknown>;
        };
      }).reqcaseShadowRecorder;

      if (api?.getTestSessionSteps) {
        try {
          const rows = await api.getTestSessionSteps({ sessionId: currentSessionId });
          if (!cancelled && Array.isArray(rows)) {
            setSemanticSteps(
              rows.map((row: any) => ({
                stepId: String(row.stepId ?? row.step_id ?? ''),
                startedAtMs: Number(row.startedAtMs ?? row.started_at_ms ?? 0),
                endedAtMs: row.endedAtMs ?? row.ended_at_ms,
                title: String(row.title ?? '操作步骤'),
                summary: row.summary,
                stepType: String(row.stepType ?? row.step_type ?? 'step'),
                precisionLevel: row.precisionLevel ?? row.precision_level,
                processName: row.processName ?? row.process_name,
                process_name: row.process_name ?? row.processName,
                windowTitle: row.windowTitle ?? row.window_title,
                window_title: row.window_title ?? row.windowTitle,
                controlName: row.controlName ?? row.control_name,
                control_name: row.control_name ?? row.controlName,
                controlType: row.controlType ?? row.control_type,
                control_type: row.control_type ?? row.controlType,
                automationId: row.automationId ?? row.automation_id,
                automation_id: row.automation_id ?? row.automationId,
                className: row.className ?? row.class_name,
                class_name: row.class_name ?? row.className,
                x: typeof row.x === 'number' ? row.x : undefined,
                y: typeof row.y === 'number' ? row.y : undefined,
                logicalX: typeof row.logicalX === 'number' ? row.logicalX : (typeof row.logical_x === 'number' ? row.logical_x : undefined),
                logicalY: typeof row.logicalY === 'number' ? row.logicalY : (typeof row.logical_y === 'number' ? row.logical_y : undefined),
                displayId: row.displayId ?? row.display_id,
                boundingRect: row.boundingRect ?? row.bounding_rect ?? row.controlRect,
                controlRect: row.controlRect ?? row.boundingRect,
                bounding_rect: row.bounding_rect ?? row.boundingRect,
                sourceEventIds: row.sourceEventIds ?? row.source_event_ids,
                source_event_ids: row.source_event_ids ?? row.sourceEventIds,
              })),
            );
          }
        } catch {
          if (!cancelled) setSemanticSteps([]);
        }
      }

      if (typeof api?.getTestSessionOperations === 'function') {
        try {
          const rawOps = await api.getTestSessionOperations({
            sessionId: currentSessionId,
            limit: 100,
          });
          if (!cancelled && rawOps && Array.isArray((rawOps as any).items)) {
            setOperations((rawOps as any).items);
          }
        } catch {
          if (!cancelled) setOperations([]);
        }
      }
    }
    void loadStepsAndOperations();
    return () => {
      cancelled = true;
    };
  }, [currentSessionId, props.timelineEvents?.length]);

  // Playable segments (only sealed with playbackUrl)
  const playableSegments = useMemo(() => {
    return props.recentSegments
      .filter((segment) => segment.isPlayable && !!segment.playbackUrl)
      .sort((left, right) => left.startedAtMs - right.startedAtMs);
  }, [props.recentSegments]);

  const playableMatchedSegments = useMemo(() => {
    return props.matchedSegments.filter((segment) => segment.isPlayable && !!segment.playbackUrl);
  }, [props.matchedSegments]);

  const preferredStreamId = useMemo(() => {
    const focusStreamId = playableMatchedSegments[0]?.streamId;
    if (focusStreamId) {
      return focusStreamId;
    }

    return (
      playableSegments
        .slice()
        .sort((left, right) => left.startedAtMs - right.startedAtMs)
        .at(-1)?.streamId
      ?? props.videoStreams[0]?.streamId
      ?? null
    );
  }, [playableMatchedSegments, playableSegments, props.videoStreams]);

  const availablePlaybackStreams = useMemo(() => {
    const streamIds = [...new Set(playableSegments.map((segment) => segment.streamId))];
    return streamIds
      .map((streamId) => {
        const stream = props.videoStreams.find((item) => item.streamId === streamId);
        const latestSegment = playableSegments
          .filter((segment) => segment.streamId === streamId)
          .sort((left, right) => right.startedAtMs - left.startedAtMs)[0];
        return {
          streamId,
          label: stream?.label ?? latestSegment?.displayId ?? streamId,
          displayLabel: stream?.displayLabel ?? latestSegment?.displayId ?? streamId,
        };
      })
      .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
  }, [playableSegments, props.videoStreams]);

  const activeStreamId = useMemo(() => {
    if (
      selectedStreamId
      && playableSegments.some((segment) => segment.streamId === selectedStreamId)
    ) {
      return selectedStreamId;
    }
    return preferredStreamId;
  }, [playableSegments, preferredStreamId, selectedStreamId]);

  const continuousSegments = useMemo(() => {
    if (!activeStreamId) {
      return [] as ContinuousPlaybackSegment[];
    }
    return buildContinuousPlaybackSegments(
      playableSegments.filter((segment) => segment.streamId === activeStreamId),
    );
  }, [activeStreamId, playableSegments]);

  const selectedStream = useMemo(() => {
    if (!activeStreamId) {
      return null;
    }
    return props.videoStreams.find((stream) => stream.streamId === activeStreamId) ?? null;
  }, [activeStreamId, props.videoStreams]);

  const encoderSummary = useMemo(() => {
    return resolveVideoEncoderSummary({
      streams: props.videoStreams,
      segments: props.recentSegments,
      preferredStreamId: activeStreamId,
    });
  }, [activeStreamId, props.recentSegments, props.videoStreams]);

  const totalDurationMs = continuousSegments.at(-1)?.accumulatedEndMs ?? 0;
  const playbackProgressPct = totalDurationMs > 0
    ? Math.min(100, (globalPlaybackMs / totalDurationMs) * 100)
    : 0;

  const activeContinuousSegment =
    currentSegmentIndex >= 0 && currentSegmentIndex < continuousSegments.length
      ? continuousSegments[currentSegmentIndex]
      : null;

  // State condition: Playable video is only rendered when paused or stopped and playable segments exist
  const canRenderVideo = (!props.isRecording || props.isPaused) && continuousSegments.length > 0 && !!activeContinuousSegment?.playbackUrl;

  const canMarkQuickDefect = Boolean(
    props.activeSession?.sessionId
    || props.playbackSession?.sessionId
    || activeContinuousSegment?.sessionId,
  );

  // Clean up RAF on unmount
  useEffect(() => {
    return () => {
      if (timeUpdateRafRef.current != null) {
        window.cancelAnimationFrame(timeUpdateRafRef.current);
        timeUpdateRafRef.current = null;
      }
    };
  }, []);

  // Update selectedStreamId
  useEffect(() => {
    if (!selectedStreamId && preferredStreamId) {
      setSelectedStreamId(preferredStreamId);
      return;
    }
    if (
      selectedStreamId
      && !playableSegments.some((segment) => segment.streamId === selectedStreamId)
    ) {
      setSelectedStreamId(preferredStreamId);
    }
  }, [playableSegments, preferredStreamId, selectedStreamId]);

  // Sync stream when playbackFocus matches
  useEffect(() => {
    const focusStreamId = playableMatchedSegments[0]?.streamId;
    if (focusStreamId && focusStreamId !== selectedStreamId) {
      setSelectedStreamId(focusStreamId);
    }
  }, [playableMatchedSegments, selectedStreamId]);

  // Adjust segment index when continuousSegments changes
  useEffect(() => {
    if (continuousSegments.length === 0) {
      setCurrentSegmentIndex(0);
      setGlobalPlaybackMs(0);
      setIsPlaybackRunning(false);
      return;
    }

    const nextIndex = clampNumber(currentSegmentIndex, 0, continuousSegments.length - 1);
    if (nextIndex !== currentSegmentIndex) {
      setCurrentSegmentIndex(nextIndex);
    }
  }, [continuousSegments, currentSegmentIndex]);

  // Auto seek on playbackFocus change
  useEffect(() => {
    if (!props.playbackFocus?.eventId || !props.playbackFocus.occurredAtMs || continuousSegments.length === 0) {
      return;
    }

    const matchedSegmentId = playableMatchedSegments[0]?.segmentId;
    const matchedIndex = matchedSegmentId
      ? continuousSegments.findIndex((segment) => segment.segmentId === matchedSegmentId)
      : -1;
    if (matchedIndex < 0) {
      return;
    }

    const matchedSegment = continuousSegments[matchedIndex];
    const offsetWithinSegmentMs = clampNumber(
      props.playbackFocus.occurredAtMs - matchedSegment.startedAtMs,
      0,
      Math.max(matchedSegment.durationMs, 0),
    );
    seekToPlaybackTime(matchedSegment.accumulatedStartMs + offsetWithinSegmentMs);
    setIsPlaybackRunning(false);
  }, [
    continuousSegments,
    playableMatchedSegments,
    props.playbackFocus?.eventId,
    props.playbackFocus?.occurredAtMs,
  ]);

  // Pause playback when page visibility hidden
  useEffect(() => {
    if (!pageVisible) {
      setIsPlaybackRunning(false);
    }
  }, [pageVisible]);

  // Play/pause management on video element
  useEffect(() => {
    if (props.isRecording && !props.isPaused) {
      setIsPlaybackRunning(false);
      setPlayerError(null);
      return;
    }

    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (!activeContinuousSegment?.playbackUrl) {
      video.pause();
      return;
    }

    if (!isPlaybackRunning) {
      video.pause();
      return;
    }

    void video.play().catch(() => {
      setPlayerError('当前录像无法开始播放');
      setIsPlaybackRunning(false);
    });
  }, [
    activeContinuousSegment?.segmentId,
    activeContinuousSegment?.playbackUrl,
    isPlaybackRunning,
    props.isRecording,
    props.isPaused,
  ]);

  function seekToPlaybackTime(nextPlaybackMs: number): void {
    if (continuousSegments.length === 0) {
      return;
    }

    const clampedPlaybackMs = clampNumber(nextPlaybackMs, 0, Math.max(totalDurationMs, 0));
    const nextSegmentIndex = findSegmentIndexForPlaybackTime(continuousSegments, clampedPlaybackMs);
    if (nextSegmentIndex < 0) {
      return;
    }

    const targetSegment = continuousSegments[nextSegmentIndex];
    const offsetSeconds = clampNumber(
      (clampedPlaybackMs - targetSegment.accumulatedStartMs) / 1000,
      0,
      Math.max((targetSegment.durationMs ?? 0) / 1000, 0),
    );

    if (
      activeContinuousSegment?.segmentId === targetSegment.segmentId
      && videoRef.current
    ) {
      videoRef.current.currentTime = offsetSeconds;
    } else {
      pendingSeekSecondsRef.current = offsetSeconds;
      setCurrentSegmentIndex(nextSegmentIndex);
    }
    globalPlaybackMsRef.current = clampedPlaybackMs;
    setGlobalPlaybackMs(clampedPlaybackMs);
    setPlayerError(null);
  }

  // Pathway 1: Play/Pause toggle (during active recording, notices and does NOT start playback)
  function handleTogglePlayback(): void {
    if (props.isRecording && !props.isPaused) {
      props.onNotice?.('暂停或停止后可回放');
      return;
    }
    if (continuousSegments.length === 0) {
      return;
    }
    if (globalPlaybackMs >= totalDurationMs) {
      seekToPlaybackTime(0);
    }
    setIsPlaybackRunning((current) => !current);
  }

  const clearHideControlsTimer = useCallback((): void => {
    if (hideControlsTimerRef.current !== null) {
      window.clearTimeout(hideControlsTimerRef.current);
      hideControlsTimerRef.current = null;
    }
  }, []);

  const scheduleHideControls = useCallback((): void => {
    clearHideControlsTimer();
    if (!isFullscreen || !isPlaybackRunning) {
      setControlsVisible(true);
      return;
    }
    hideControlsTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
      hideControlsTimerRef.current = null;
    }, 2500);
  }, [clearHideControlsTimer, isFullscreen, isPlaybackRunning]);

  const revealControls = useCallback((): void => {
    setControlsVisible(true);
    scheduleHideControls();
  }, [scheduleHideControls]);

  async function enterOrExitFullscreen(): Promise<void> {
    const root = playerRootRef.current;
    if (!root) {
      return;
    }

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (typeof root.requestFullscreen === 'function') {
        await root.requestFullscreen();
      } else {
        setPlayerError('当前环境不支持全屏回放');
      }
    } catch {
      setPlayerError('无法切换全屏回放');
    }
  }

  // Pathway 2: Seek by delta (during active recording, notices and does NOT seek)
  function handleSeekByDelta(deltaMs: number): void {
    if (props.isRecording && !props.isPaused) {
      props.onNotice?.('暂停或停止后可回放');
      return;
    }
    if (continuousSegments.length === 0) {
      return;
    }
    seekToPlaybackTime(globalPlaybackMsRef.current + deltaMs);
    revealControls();
  }

  // Pathway 3: Scrubber input (during active recording, notices and does NOT seek)
  function handleSeekBarInput(event: ChangeEvent<HTMLInputElement>): void {
    if (props.isRecording && !props.isPaused) {
      props.onNotice?.('暂停或停止后可回放');
      return;
    }
    if (continuousSegments.length === 0) {
      return;
    }
    seekToPlaybackTime(Number(event.target.value));
    revealControls();
  }

  async function handleQuickDefect(): Promise<void> {
    if (quickDefectPendingRef.current) {
      return;
    }

    const segment = activeContinuousSegment;
    const sessionId = segment?.sessionId
      || props.playbackSession?.sessionId
      || props.activeSession?.sessionId;
    if (!sessionId) {
      const message = '当前没有可标记的会话，请先开始录制或选择历史录像';
      setPlayerError(message);
      props.onNotice?.(message);
      return;
    }

    const markedAtMs = segment && videoRef.current
      ? segment.startedAtMs + clampNumber(
        Math.round(videoRef.current.currentTime * 1000),
        0,
        Math.max(segment.durationMs ?? 0, 0),
      )
      : Date.now();
    const api = (window as any).reqcaseShadowRecorder;
    const note = segment ? '回放位置瞬时打标' : '录制位置瞬时打标';

    quickDefectPendingRef.current = true;
    setIsQuickDefectPending(true);
    try {
      let marked = false;
      if (api.markTestDefect) {
        try {
          await api.markTestDefect({
            sessionId,
            markedAtMs,
            note,
            actual: note,
          });
          marked = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/disabled|not active|SessionNotFound|no active|not found|unavailable|not supported|bridge/i.test(message)) {
            throw error;
          }
        }
      }

      if (!marked) {
        marked = await appendNoteForActiveQuickDefect(api, {
          sessionId,
          title: note,
          message: `${note} ${formatDateTime(markedAtMs)}`,
        });
      }

      if (!marked) {
        const message = '当前会话不支持问题标记';
        setPlayerError(message);
        props.onNotice?.(message);
        return;
      }

      setPlayerError(null);
      props.onNotice?.('已记录瞬时标记');
      props.onMarked?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : '标记当前位置失败';
      setPlayerError(message);
      props.onNotice?.(message);
    } finally {
      quickDefectPendingRef.current = false;
      setIsQuickDefectPending(false);
    }
  }

  // Fullscreen event listener
  useEffect(() => {
    const onFullscreenChange = (): void => {
      const active = document.fullscreenElement === playerRootRef.current;
      setIsFullscreen(active);
      setControlsVisible(true);
      if (!active) {
        clearHideControlsTimer();
      }
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      clearHideControlsTimer();
    };
  }, [clearHideControlsTimer]);

  // Pathway 4: Keyboard listener (Space and Arrow keys check recording status)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName.toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return;
        }
      }

      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault();
        if (props.isRecording && !props.isPaused) {
          props.onNotice?.('暂停或停止后可回放');
          return;
        }
        handleTogglePlayback();
        revealControls();
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (props.isRecording && !props.isPaused) {
          props.onNotice?.('暂停或停止后可回放');
          return;
        }
        handleSeekByDelta(5000);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (props.isRecording && !props.isPaused) {
          props.onNotice?.('暂停或停止后可回放');
          return;
        }
        handleSeekByDelta(-5000);
        return;
      }
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        void enterOrExitFullscreen();
        return;
      }
      if (event.key === 'Escape') {
        revealControls();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [continuousSegments.length, isFullscreen, isPlaybackRunning, props.isPaused, props.isRecording, props.onNotice, totalDurationMs]);

  // Encoder brand (only when encoder name actually contains nvenc/qsv/amf)
  const hardwareBrand = resolveHardwareEncoderBrand(activeContinuousSegment?.encoderName);
  const displayEncoderLabel = hardwareBrand ?? encoderSummary.encoderLabel;

  // Step drop readout: droppedStepsTotal / capturedStepsTotal (shows -- if capturedStepsTotal is 0)
  const capturedSteps = props.metrics?.capturedStepsTotal ?? 0;
  const droppedSteps = props.metrics?.droppedStepsTotal ?? 0;
  const stepDropDisplay = capturedSteps > 0 ? `${droppedSteps} / ${capturedSteps}` : '--';

  // Memory rounded to integer MB
  const memoryDisplay = typeof props.resourceUsage?.totalWorkingSetMb === 'number'
    ? `${Math.round(props.resourceUsage.totalWorkingSetMb)} MB`
    : '--';

  // Backend label
  const backendLabel = resolveBackendLabel(props.metrics);

  // Corner badge text (only when still paused and session is open, keep '落后当前写入至少 1 段')
  const badgeCornerText = (props.isRecording && props.isPaused)
    ? '已封口录像 · 落后当前写入至少 1 段'
    : '已封口录像';

  // Handlers for action and defect selection from timeline
  const handleSelectAction = useCallback((event: TestSessionTimelineEvent, playbackMs: number) => {
    setSelectedItem({
      type: 'action',
      event,
      playbackMs,
    });
    setDrawerTab('control');
    setDrawerOpen(true);
  }, []);

  const handleSelectDefect = useCallback((event: TestSessionTimelineEvent, playbackMs: number) => {
    setSelectedItem({
      type: 'defect',
      event,
      playbackMs,
    });
    setDrawerTab('defect');
    setDrawerOpen(true);
  }, []);

  // Screen marker overlay calculation (only active when paused or stopped)
  const coordinateMappingResult = useMemo<CoordinateMappingResult | null>(() => {
    // Condition 1: Do NOT draw when recording and not paused
    if (props.isRecording && !props.isPaused) {
      return null;
    }
    if (!selectedItem) {
      return null;
    }

    const evId = selectedItem.event.eventId;
    const evStepId = selectedItem.event.stepId;

    // Strict step match: only sourceEventIds or stepId (never guess by timestamp)
    const matchingStep = semanticSteps.find((s) => {
      if (s.sourceEventIds && Array.isArray(s.sourceEventIds) && s.sourceEventIds.includes(evId)) {
        return true;
      }
      if (s.source_event_ids && Array.isArray(s.source_event_ids) && s.source_event_ids.includes(evId)) {
        return true;
      }
      if (evStepId && (s.stepId === evStepId || s.stepId === (selectedItem.event as any).id)) {
        return true;
      }
      return false;
    });

    // Strict operation match: only sourceEventIds
    const matchingOperation = operations.find((op) => {
      const sourceIds = op.action?.sourceEventIds;
      return Array.isArray(sourceIds) && sourceIds.includes(evId);
    });

    // Extract explicit element.boundingRect
    const explicitRect = matchingOperation?.action?.target?.boundingRect
      || matchingOperation?.action?.stateBefore?.element?.boundingRect
      || matchingStep?.boundingRect
      || matchingStep?.controlRect
      || matchingStep?.bounding_rect;

    // Extract point coordinate: prioritize physical point x/y, fallback to logicalX/logicalY
    let pointPhysicalX: number | undefined;
    let pointPhysicalY: number | undefined;

    if (typeof matchingStep?.x === 'number' && typeof matchingStep?.y === 'number') {
      pointPhysicalX = matchingStep.x;
      pointPhysicalY = matchingStep.y;
    } else if (
      typeof matchingOperation?.action?.coordinate?.x === 'number'
      && typeof matchingOperation?.action?.coordinate?.y === 'number'
    ) {
      pointPhysicalX = matchingOperation.action.coordinate.x;
      pointPhysicalY = matchingOperation.action.coordinate.y;
    } else if (typeof selectedItem.event.x === 'number' && typeof selectedItem.event.y === 'number') {
      pointPhysicalX = selectedItem.event.x;
      pointPhysicalY = selectedItem.event.y;
    }

    let pointLogicalX: number | undefined;
    let pointLogicalY: number | undefined;

    if (pointPhysicalX === undefined || pointPhysicalY === undefined) {
      if (typeof matchingStep?.logicalX === 'number' && typeof matchingStep?.logicalY === 'number') {
        pointLogicalX = matchingStep.logicalX;
        pointLogicalY = matchingStep.logicalY;
      } else if (typeof selectedItem.event.logicalX === 'number' && typeof selectedItem.event.logicalY === 'number') {
        pointLogicalX = selectedItem.event.logicalX;
        pointLogicalY = selectedItem.event.logicalY;
      }
    }

    const hasPoint = (pointPhysicalX !== undefined && pointPhysicalY !== undefined)
      || (pointLogicalX !== undefined && pointLogicalY !== undefined);

    if (!explicitRect && !hasPoint) {
      return {
        success: false,
        reason: '当前操作未采集边界矩形或点击坐标',
      };
    }

    if (!selectedStream) {
      return {
        success: false,
        reason: '当前未选定视频流',
      };
    }

    // Check display match
    const targetDisplayId = matchingStep?.displayId
      || matchingOperation?.action?.coordinate?.displayId
      || selectedItem.event.displayId;

    if (targetDisplayId && selectedStream.displayId && targetDisplayId !== selectedStream.displayId) {
      return {
        success: false,
        reason: `操作发生于显示器 [${targetDisplayId}]，当前显示为 [${selectedStream.displayId}]，无法映射到当前画面`,
      };
    }

    const monitorLeft = selectedStream.monitorLeft ?? 0;
    const monitorTop = selectedStream.monitorTop ?? 0;
    const video = videoRef.current;
    const streamWidth = (video && video.videoWidth > 0)
      ? video.videoWidth
      : (selectedStream.width && selectedStream.width > 0 ? selectedStream.width : 0);
    const streamHeight = (video && video.videoHeight > 0)
      ? video.videoHeight
      : (selectedStream.height && selectedStream.height > 0 ? selectedStream.height : 0);

    // If both videoWidth and stream width/height are unavailable, fail immediately
    if (streamWidth <= 0 || streamHeight <= 0) {
      return {
        success: false,
        reason: '视频尺寸未就绪',
      };
    }

    const frameWidth = frameDimensions.width;
    const frameHeight = frameDimensions.height;
    if (frameWidth <= 0 || frameHeight <= 0) {
      return {
        success: false,
        reason: '视口尺寸尚未就绪',
      };
    }

    // Actual 16:9 video content box inside the frame (handles letterbox / pillarbox with object-fit: contain)
    const containerAspect = frameWidth / frameHeight;
    const videoAspect = streamWidth / streamHeight;
    let actualWidth = frameWidth;
    let actualHeight = frameHeight;
    let actualLeft = 0;
    let actualTop = 0;

    if (containerAspect > videoAspect) {
      // Pillarbox (black bars left and right)
      actualHeight = frameHeight;
      actualWidth = frameHeight * videoAspect;
      actualLeft = (frameWidth - actualWidth) / 2;
      actualTop = 0;
    } else {
      // Letterbox (black bars top and bottom)
      actualWidth = frameWidth;
      actualHeight = frameWidth / videoAspect;
      actualLeft = 0;
      actualTop = (frameHeight - actualHeight) / 2;
    }

    // Branch 1: Rectangular bounding box from operation evidence element.boundingRect
    if (explicitRect && explicitRect.width > 0 && explicitRect.height > 0) {
      // Physical screen coordinates: only subtract monitor origin, DO NOT multiply by dpiScale
      const localLeft = explicitRect.left - monitorLeft;
      const localTop = explicitRect.top - monitorTop;
      const localWidth = explicitRect.width;
      const localHeight = explicitRect.height;

      // Check both horizontal and vertical bounds strictly
      if (
        localLeft + localWidth <= 0
        || localLeft >= streamWidth
        || localTop + localHeight <= 0
        || localTop >= streamHeight
      ) {
        return {
          success: false,
          reason: '控件矩形超出当前视频流画面范围，无法映射到当前画面',
        };
      }

      const screenX = actualLeft + (localLeft / streamWidth) * actualWidth;
      const screenY = actualTop + (localTop / streamHeight) * actualHeight;
      const screenW = (localWidth / streamWidth) * actualWidth;
      const screenH = (localHeight / streamHeight) * actualHeight;

      const label = matchingStep?.controlName
        || matchingStep?.control_name
        || matchingOperation?.action?.target?.name
        || undefined;

      return {
        success: true,
        overlay: {
          type: 'rect',
          x: Math.round(screenX),
          y: Math.round(screenY),
          width: Math.max(Math.round(screenW), 4),
          height: Math.max(Math.round(screenH), 4),
          label,
        },
      };
    }

    // Branch 2: Point coordinate (DO NOT expand into rectangle)
    if (hasPoint) {
      let localX: number;
      let localY: number;

      if (pointPhysicalX !== undefined && pointPhysicalY !== undefined) {
        // Physical point: only subtract monitor origin, DO NOT multiply by dpiScale
        localX = pointPhysicalX - monitorLeft;
        localY = pointPhysicalY - monitorTop;
      } else if (pointLogicalX !== undefined && pointLogicalY !== undefined) {
        // Only when physical point is missing and logical point is used: require dpiScale on event
        const scale = (typeof selectedItem.event.dpiScale === 'number' && selectedItem.event.dpiScale > 0)
          ? selectedItem.event.dpiScale
          : undefined;

        if (scale === undefined) {
          return {
            success: false,
            reason: '缺少 dpiScale，无法映射逻辑坐标',
          };
        }

        const physX = pointLogicalX * scale;
        const physY = pointLogicalY * scale;
        localX = physX - monitorLeft;
        localY = physY - monitorTop;
      } else {
        return {
          success: false,
          reason: '无法获取有效的点击点坐标',
        };
      }

      // If out of bounds after calculation, fail immediately without trying other formulas
      if (localX < 0 || localX > streamWidth || localY < 0 || localY > streamHeight) {
        return {
          success: false,
          reason: '点击坐标不在当前视频流显示区域内，无法映射到当前画面',
        };
      }

      const screenX = actualLeft + (localX / streamWidth) * actualWidth;
      const screenY = actualTop + (localY / streamHeight) * actualHeight;

      // Label: ONLY controlName or step title. Never guess using event.action or event.title!
      const label = matchingStep?.controlName
        || matchingStep?.control_name
        || matchingOperation?.action?.target?.name
        || matchingStep?.title
        || undefined;

      return {
        success: true,
        overlay: {
          type: 'point',
          x: Math.round(screenX),
          y: Math.round(screenY),
          label,
        },
      };
    }

    return {
      success: false,
      reason: '无法映射到当前画面',
    };
  }, [
    frameDimensions.height,
    frameDimensions.width,
    operations,
    props.isPaused,
    props.isRecording,
    selectedItem,
    selectedStream,
    semanticSteps,
  ]);

  return (
    <section className="recorder-playback-stage recorder-stage-cinema-flow">
      {/* 1. Cinema Viewport (Upper Half) */}
      <div className="cinema-viewport-shell">
        <div
          ref={playerRootRef}
          className={`cinema-screen-frame${isFullscreen ? ' is-fullscreen' : ''}${isFullscreen && !controlsVisible ? ' controls-hidden' : ''}`}
          onMouseMove={() => {
            if (isFullscreen) {
              revealControls();
            }
          }}
          onMouseLeave={() => {
            if (isFullscreen && isPlaybackRunning) {
              scheduleHideControls();
            }
          }}
        >
          {/* Top-Left Corner HUD */}
          <div className="hud-corner-top-left" aria-label="流与编码信息">
            <div className="hud-corner-stream-row">
              <span className="hud-stream-display">
                {selectedStream?.displayLabel ?? selectedStream?.label ?? '当前流'}
              </span>
              <span className="hud-stream-resolution">
                {selectedStream?.width && selectedStream?.height
                  ? `${selectedStream.width}×${selectedStream.height}`
                  : '--'}
              </span>
              {availablePlaybackStreams.length > 1 ? (
                <select
                  className="hud-stream-select"
                  value={activeStreamId ?? ''}
                  aria-label="切换显示流"
                  onChange={(e) => {
                    setSelectedStreamId(e.target.value);
                    setCurrentSegmentIndex(0);
                    setGlobalPlaybackMs(0);
                    setIsPlaybackRunning(false);
                    setPlayerError(null);
                  }}
                >
                  {availablePlaybackStreams.map((s) => (
                    <option key={s.streamId} value={s.streamId}>
                      {s.displayLabel}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
            <div className="hud-corner-encoder-row">
              <span className="hud-meta-chip" title="编码格式">
                {encoderSummary.codecLabel !== '--' ? encoderSummary.codecLabel : '--'}
              </span>
              <span className="hud-meta-chip" title="编码器">
                {displayEncoderLabel}
              </span>
              <span className="hud-meta-chip" title="编码路径">
                {encoderSummary.pathLabel}
              </span>
            </div>
          </div>

          {/* Top-Right Corner HUD: 4 Metrics Boxes + Backend Badge */}
          <div className="hud-corner-top-right" aria-label="实时核心指标">
            <div className="hud-metrics-grid">
              <div className="hud-metric-box">
                <span className="hud-metric-kicker">捕获时延</span>
                <span className="hud-metric-num accent-cyan">
                  {typeof props.metrics?.lastCaptureLatencyMs === 'number'
                    ? `${props.metrics.lastCaptureLatencyMs.toFixed(1)} ms`
                    : '--'}
                </span>
              </div>
              <div className="hud-metric-box">
                <span className="hud-metric-kicker">编码时延</span>
                <span className="hud-metric-num">
                  {typeof props.metrics?.lastEncodeLatencyMs === 'number'
                    ? `${props.metrics.lastEncodeLatencyMs.toFixed(1)} ms`
                    : '--'}
                </span>
              </div>
              <div className="hud-metric-box">
                <span className="hud-metric-kicker">步骤丢弃</span>
                <span className="hud-metric-num">
                  {stepDropDisplay}
                </span>
              </div>
              <div className="hud-metric-box">
                <span className="hud-metric-kicker">内存</span>
                <span className="hud-metric-num">
                  {memoryDisplay}
                </span>
              </div>
            </div>
            <div className="hud-backend-badge" title="捕获后端引擎">
              {backendLabel}
            </div>
          </div>

          {/* Center Stage: Three States */}
          {props.isRecording && !props.isPaused ? (
            /* State 1: Active recording and not paused (no video rendered) */
            <div className="cinema-center-state is-recording">
              <div className="cinema-record-pulse" aria-hidden="true">
                <span className="record-pulse-ring" />
                <span className="record-pulse-core" />
              </div>
              <h3 className="cinema-state-title">正在写入当前切片</h3>
              <p className="cinema-state-sub">
                已封口 {continuousSegments.length} 段 · 暂停或停止后可回放
              </p>
            </div>
          ) : canRenderVideo ? (
            /* State 2: Paused or stopped with playable segments */
            <>
              <video
                key={activeContinuousSegment.segmentId}
                ref={videoRef}
                className="cinema-video-element"
                aria-label="已封口录像回放"
                src={activeContinuousSegment.playbackUrl}
                playsInline
                preload="metadata"
                muted
                onClick={(e) => {
                  e.preventDefault();
                  handleTogglePlayback();
                  if (isFullscreen) revealControls();
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  void enterOrExitFullscreen();
                }}
                onLoadedMetadata={(e) => {
                  const target = e.currentTarget;
                  const seekSeconds = pendingSeekSecondsRef.current;
                  if (seekSeconds !== null) {
                    target.currentTime = seekSeconds;
                    pendingSeekSecondsRef.current = null;
                  }
                  if (isPlaybackRunning) {
                    void target.play().catch(() => {
                      setPlayerError('当前录像无法开始播放');
                      setIsPlaybackRunning(false);
                    });
                  }
                  setPlayerError(null);
                }}
                onTimeUpdate={(e) => {
                  const currentSegment = continuousSegments[currentSegmentIndex];
                  if (!currentSegment) return;
                  const nextPlaybackMs = currentSegment.accumulatedStartMs
                    + Math.round(e.currentTarget.currentTime * 1000);
                  globalPlaybackMsRef.current = nextPlaybackMs;
                  const now = performance.now();
                  if (now - lastTimeUpdateEmitAtRef.current < 250) {
                    if (timeUpdateRafRef.current == null) {
                      timeUpdateRafRef.current = window.requestAnimationFrame(() => {
                        timeUpdateRafRef.current = null;
                        lastTimeUpdateEmitAtRef.current = performance.now();
                        setGlobalPlaybackMs(globalPlaybackMsRef.current);
                      });
                    }
                    return;
                  }
                  lastTimeUpdateEmitAtRef.current = now;
                  setGlobalPlaybackMs(nextPlaybackMs);
                }}
                onEnded={() => {
                  const nextIndex = currentSegmentIndex + 1;
                  if (nextIndex < continuousSegments.length) {
                    pendingSeekSecondsRef.current = 0;
                    setCurrentSegmentIndex(nextIndex);
                    setGlobalPlaybackMs(continuousSegments[nextIndex].accumulatedStartMs);
                    return;
                  }
                  setGlobalPlaybackMs(totalDurationMs);
                  setIsPlaybackRunning(false);
                }}
                onError={() => {
                  setPlayerError('当前录像加载失败');
                  setIsPlaybackRunning(false);
                }}
              />
              <div className="cinema-screen-badge-corner">
                {badgeCornerText}
              </div>

              {/* Screen Marker Overlay (Active when paused or stopped) */}
              {(!props.isRecording || props.isPaused) && coordinateMappingResult?.success && coordinateMappingResult.overlay ? (
                <div className="cinema-overlay-layer" aria-hidden="true">
                  {coordinateMappingResult.overlay.type === 'rect' ? (
                    <div
                      className="cinema-overlay-bounding-box"
                      style={{
                        left: `${coordinateMappingResult.overlay.x}px`,
                        top: `${coordinateMappingResult.overlay.y}px`,
                        width: `${coordinateMappingResult.overlay.width}px`,
                        height: `${coordinateMappingResult.overlay.height}px`,
                      }}
                    >
                      {coordinateMappingResult.overlay.label ? (
                        <span className="cinema-overlay-box-label">
                          {coordinateMappingResult.overlay.label}
                        </span>
                      ) : null}
                    </div>
                  ) : coordinateMappingResult.overlay.type === 'point' ? (
                    <div
                      className="cinema-overlay-click-point"
                      style={{
                        left: `${coordinateMappingResult.overlay.x}px`,
                        top: `${coordinateMappingResult.overlay.y}px`,
                      }}
                    >
                      <span className="cinema-click-pulse-ring" />
                      <span className="cinema-click-dot" />
                      {coordinateMappingResult.overlay.label ? (
                        <span className="cinema-overlay-point-label">
                          {coordinateMappingResult.overlay.label}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            /* State 3: No playable segments */
            <div className="cinema-center-state is-empty">
              <div className="cinema-empty-icon" aria-hidden="true">🎬</div>
              <h3 className="cinema-state-title">暂无可回放录像</h3>
              <p className="cinema-state-sub">等待录制封口后切片就绪</p>
            </div>
          )}

          {playerError ? (
            <div className="cinema-player-error ui-banner is-error" role="alert">
              <strong>提示:</strong> <span>{playerError}</span>
            </div>
          ) : null}

          {/* Bottom Floating Transport Dock */}
          <div className="hud-cinema-transport" role="toolbar" aria-label="回放控制栏">
            <button
              type="button"
              className="btn-dock-step"
              onClick={() => handleSeekByDelta(-5000)}
              disabled={continuousSegments.length === 0}
              title="后退 5 秒"
              aria-label="后退 5 秒"
            >
              -5s
            </button>

            <button
              type="button"
              className="btn-dock-play"
              onClick={handleTogglePlayback}
              disabled={continuousSegments.length === 0}
              title={isPlaybackRunning ? '暂停播放 (空格)' : '播放录像 (空格)'}
              aria-label={isPlaybackRunning ? '暂停播放 (空格)' : '播放录像 (空格)'}
            >
              {isPlaybackRunning ? (
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true" style={{ marginLeft: '2px' }}>
                  <polygon points="6 4 19 12 6 20 6 4" />
                </svg>
              )}
            </button>

            <button
              type="button"
              className="btn-dock-step"
              onClick={() => handleSeekByDelta(5000)}
              disabled={continuousSegments.length === 0}
              title="前进 5 秒"
              aria-label="前进 5 秒"
            >
              +5s
            </button>

            {/* Timecode & Scrubber Track */}
            <div className="transport-time-track">
              <span className="transport-clock-readout">
                {continuousSegments.length > 0
                  ? `${formatClock(globalPlaybackMs)} / ${formatClock(totalDurationMs)}`
                  : '-- / --'}
              </span>

              <div className="transport-scrubber-shell">
                <div className="transport-scrubber-bar" aria-hidden="true">
                  <div
                    className="transport-scrubber-fill"
                    style={{ width: `${playbackProgressPct}%` }}
                  />
                </div>
                <input
                  className="transport-scrubber-input"
                  type="range"
                  min={0}
                  max={Math.max(totalDurationMs, 1)}
                  step={100}
                  value={Math.min(globalPlaybackMs, Math.max(totalDurationMs, 1))}
                  disabled={continuousSegments.length === 0}
                  aria-label="播放进度"
                  onChange={handleSeekBarInput}
                />
              </div>
            </div>

            {/* Instant Defect Mark */}
            <button
              type="button"
              className="btn-dock-quick-defect"
              onClick={() => { void handleQuickDefect(); }}
              disabled={!canMarkQuickDefect || isQuickDefectPending}
              title="标记当前回放位置为缺陷"
              aria-label="标记当前回放位置为缺陷"
              aria-busy={isQuickDefectPending}
            >
              {isQuickDefectPending ? '标记中…' : '🚩 标记瞬时'}
            </button>

            {/* Fullscreen Button */}
            <button
              type="button"
              className="btn-dock-step"
              onClick={() => { void enterOrExitFullscreen(); }}
              disabled={continuousSegments.length === 0}
              title={isFullscreen ? '退出全屏' : '全屏回放'}
              aria-label={isFullscreen ? '退出全屏' : '全屏回放'}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {isFullscreen ? (
                  <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
                ) : (
                  <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                )}
              </svg>
            </button>
          </div>
        </div>

        {/* Sliding Event & Defect Drawer (Covers right side of cinema viewport) */}
        <StudioDrawer
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          activeTab={drawerTab}
          onTabChange={setDrawerTab}
          selectedItem={selectedItem}
          preWindowSeconds={props.config?.defectPreWindowSeconds ?? 10}
          postWindowSeconds={props.config?.defectPostWindowSeconds ?? 10}
          onNotice={props.onNotice}
          onExportSession={props.onExportSession}
          isExporting={props.isExporting}
          semanticSteps={semanticSteps}
          operations={operations}
          mappingResult={coordinateMappingResult}
          timelineEvents={props.timelineEvents ?? []}
        />
      </div>

      {/* 2. Pinned Multi-Track Timeline (Lower Half, Strictly 3 Tracks Only) */}
      <StudioTimelineDock
        isRecording={props.isRecording}
        isPaused={props.isPaused}
        continuousSegments={continuousSegments}
        totalDurationMs={totalDurationMs}
        globalPlaybackMs={globalPlaybackMs}
        onSeek={seekToPlaybackTime}
        timelineEvents={props.timelineEvents ?? []}
        playbackFocus={props.playbackFocus}
        onPlaybackFocusChange={props.onPlaybackFocusChange}
        preWindowSeconds={props.config?.defectPreWindowSeconds ?? 10}
        postWindowSeconds={props.config?.defectPostWindowSeconds ?? 10}
        onNotice={props.onNotice}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((open) => !open)}
        onSelectAction={handleSelectAction}
        onSelectDefect={handleSelectDefect}
      />
    </section>
  );
}
