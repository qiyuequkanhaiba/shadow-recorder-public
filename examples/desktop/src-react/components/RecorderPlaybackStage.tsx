import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';

import type {
  RecorderMetrics,
  RecorderResourceUsage,
  TestSessionPlaybackFocus,
  TestSessionState,
  TestSessionTimelineEvent,
  TestSessionVideoSegment,
  TestSessionVideoStream,
} from '../../types/contracts';
import { useDocumentVisibility } from '../hooks/useDocumentVisibility';
import { appendNoteForActiveQuickDefect } from '../lib/quick-defect-fallback';
import { resolveVideoEncoderSummary } from '../lib/video-encoder-summary';

type RecorderPlaybackStageProps = {
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
  onNotice?: (message: string) => void;
  onMarked?: () => void;
};

type ContinuousPlaybackSegment = TestSessionVideoSegment & {
  accumulatedStartMs: number;
  accumulatedEndMs: number;
};



function resolveRecorderStatus(isRecording: boolean, isPaused: boolean): string {
  if (!isRecording) {
    return '待机';
  }
  if (isPaused) {
    return '已暂停';
  }
  return '录制中';
}

function resolveBackendLabel(metrics: RecorderMetrics | null): string {
  if (!metrics) {
    return '--';
  }
  if (metrics.wgcCaptureCount > 0 && metrics.dxgiCaptureCount > 0) {
    return 'WGC / DXGI';
  }
  if (metrics.wgcCaptureCount > 0) {
    return 'WGC';
  }
  if (metrics.dxgiCaptureCount > 0) {
    return 'DXGI';
  }
  return '--';
}

function formatDuration(durationMs?: number): string {
  if (!durationMs || durationMs <= 0) {
    return '--';
  }
  return `${Math.round(durationMs / 100) / 10}s`;
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

function formatCpuLabel(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '--';
  }
  return `${Math.round(value * 10) / 10}%`;
}

function formatMemoryLabel(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '--';
  }
  return `${Math.round(value * 10) / 10} MB`;
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

function mapOccurredAtToPlaybackMs(
  occurredAtMs: number,
  segments: ContinuousPlaybackSegment[],
): number | null {
  for (const segment of segments) {
    const start = segment.startedAtMs;
    const end = start + Math.max(segment.durationMs ?? 0, 0);
    if (occurredAtMs >= start && occurredAtMs <= end) {
      return segment.accumulatedStartMs + (occurredAtMs - start);
    }
  }
  return null;
}

function isDefectTimelineEvent(event: TestSessionTimelineEvent): boolean {
  if (event.logLevel === 'error') {
    return true;
  }
  const haystack = `${event.title ?? ''} ${event.message ?? ''} ${event.eventType}`.toLowerCase();
  return haystack.includes('缺陷') || haystack.includes('异常') || haystack.includes('defect');
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
  const statusText = resolveRecorderStatus(props.isRecording, props.isPaused);
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
  const [localDefectMarksMs, setLocalDefectMarksMs] = useState<number[]>([]);

  const streamLabelMap = useMemo(() => {
    return new Map(props.videoStreams.map((stream) => [stream.streamId, stream.label]));
  }, [props.videoStreams]);

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
          secondaryLabel: latestSegment?.displayId
            ?? stream?.displayLabel
            ?? stream?.targetCaptureMode
            ?? '--',
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
  const defectMarkers = useMemo(() => {
    const marks = new Map<number, { id: string; atMs: number; pct: number }>();
    const addMark = (id: string, atMs: number) => {
      if (totalDurationMs <= 0) {
        return;
      }
      const clamped = clampNumber(atMs, 0, totalDurationMs);
      const pct = (clamped / totalDurationMs) * 100;
      marks.set(Math.round(clamped / 80), { id, atMs: clamped, pct });
    };

    for (const event of props.timelineEvents ?? []) {
      if (!isDefectTimelineEvent(event)) {
        continue;
      }
      const atMs = mapOccurredAtToPlaybackMs(event.occurredAtMs, continuousSegments);
      if (atMs == null) {
        continue;
      }
      addMark(event.eventId, atMs);
    }
    localDefectMarksMs.forEach((atMs, index) => {
      addMark(`local-defect-${index}`, atMs);
    });
    return [...marks.values()];
  }, [continuousSegments, localDefectMarksMs, props.timelineEvents, totalDurationMs]);

  const activeContinuousSegment =
    currentSegmentIndex >= 0 && currentSegmentIndex < continuousSegments.length
      ? continuousSegments[currentSegmentIndex]
      : null;
  const playbackReady = !props.isRecording && !!activeContinuousSegment?.playbackUrl;
  const canMarkQuickDefect = Boolean(
    props.activeSession?.sessionId
    || props.playbackSession?.sessionId
    || activeContinuousSegment?.sessionId,
  );

  useEffect(() => {
    return () => {
      if (timeUpdateRafRef.current != null) {
        window.cancelAnimationFrame(timeUpdateRafRef.current);
        timeUpdateRafRef.current = null;
      }
    };
  }, []);

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

  useEffect(() => {
    const focusStreamId = playableMatchedSegments[0]?.streamId;
    if (focusStreamId && focusStreamId !== selectedStreamId) {
      setSelectedStreamId(focusStreamId);
    }
  }, [playableMatchedSegments, selectedStreamId]);

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

  useEffect(() => {
    if (!pageVisible) {
      setIsPlaybackRunning(false);
    }
  }, [pageVisible]);

  useEffect(() => {
    if (props.isRecording) {
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
  }, [activeContinuousSegment?.segmentId, activeContinuousSegment?.playbackUrl, isPlaybackRunning, props.isRecording]);

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

  function handleTimelineSeek(event: ChangeEvent<HTMLInputElement>): void {
    seekToPlaybackTime(Number(event.target.value));
  }

  function handleTogglePlayback(): void {
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

  function handleSeekByDelta(deltaMs: number): void {
    seekToPlaybackTime(globalPlaybackMsRef.current + deltaMs);
    revealControls();
  }

  function handleSeekBarInput(event: ChangeEvent<HTMLInputElement>): void {
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
    const api = window.reqcaseShadowRecorder;
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
          if (!/disabled|not active|SessionNotFound|no active|not found/i.test(message)) {
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

      setLocalDefectMarksMs((current) => [...current, segment ? globalPlaybackMsRef.current : markedAtMs]);
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

  useEffect(() => {
    if (!isFullscreen) {
      setControlsVisible(true);
      clearHideControlsTimer();
      return;
    }
    if (isPlaybackRunning) {
      scheduleHideControls();
    } else {
      setControlsVisible(true);
      clearHideControlsTimer();
    }
  }, [clearHideControlsTimer, isFullscreen, isPlaybackRunning, scheduleHideControls]);

  useEffect(() => {
    if (!isFullscreen) {
      return () => undefined;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault();
        handleTogglePlayback();
        revealControls();
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        handleSeekByDelta(5000);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
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
  }, [isFullscreen, continuousSegments.length, totalDurationMs, isPlaybackRunning]);

  const headerSummary = useMemo(() => {
    if (!props.playbackSession) {
      return '暂无可回放录像';
    }
    if (props.activeSession?.sessionId === props.playbackSession.sessionId) {
      return `${props.playbackSession.name ?? props.playbackSession.sessionId} · 当前录制`;
    }
    return `${props.playbackSession.name ?? props.playbackSession.sessionId} · 最近录像`;
  }, [props.activeSession, props.playbackSession]);

  const playbackMetaText = `${continuousSegments.length || 0} 段连续回放`;

  return (
    <section className="recorder-playback-stage">
      <div className="recorder-stage-header recorder-stage-header-slim stage-top-meta">
        <div className="meta-pills-row">
          <span className="meta-micro-tag">
            <strong>会话:</strong> {headerSummary}
          </span>
          <span className="meta-micro-tag">
            <strong>显示器:</strong> {selectedStream?.displayLabel ?? selectedStream?.label ?? '当前显示器'}
          </span>
          <span className="meta-micro-tag">
            <strong>分段:</strong> {continuousSegments.length} 段
          </span>
        </div>
        <div className="meta-pills-row">
          <span className={`meta-micro-tag is-status ${props.isRecording ? (props.isPaused ? 'is-paused' : 'is-live') : 'is-idle'}`}>
            <strong>状态:</strong> {statusText}
          </span>
          <span className="meta-micro-tag meta-encoder">
            <strong>编码:</strong> {encoderSummary.encoderLabel}
          </span>
        </div>
        {availablePlaybackStreams.length > 1 ? (
          <div className="recorder-stage-stream-switcher">
            {availablePlaybackStreams.map((stream) => (
              <button
                key={stream.streamId}
                type="button"
                className={`meta-chip ${activeStreamId === stream.streamId ? 'is-active' : ''}`}
                onClick={() => {
                  setSelectedStreamId(stream.streamId);
                  setCurrentSegmentIndex(0);
                  setGlobalPlaybackMs(0);
                  setIsPlaybackRunning(false);
                  setPlayerError(null);
                }}
              >
                {stream.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className={`recorder-stage-surface ${props.isRecording ? 'live' : 'idle'}`}>
        <div className="recorder-stage-player-shell">
          <div className="recorder-stage-screen recorder-stage-screen-video">
            {playbackReady ? (
              <div
                ref={playerRootRef}
                className={`recorder-stage-video-player recorder-stage-player-root${isFullscreen ? ' is-fullscreen' : ''}${isFullscreen && !controlsVisible ? ' controls-hidden' : ''}`}
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
                <video
                  key={activeContinuousSegment.segmentId}
                  ref={videoRef}
                  className="recorder-stage-video" aria-label="会话录像回放"
                  src={activeContinuousSegment.playbackUrl}
                  playsInline
                  preload="metadata"
                  muted
                  onClick={(event) => {
                    // avoid toggling when clicking native residual UI
                    event.preventDefault();
                    handleTogglePlayback();
                    if (isFullscreen) {
                      revealControls();
                    }
                  }}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    void enterOrExitFullscreen();
                  }}
                  onLoadedMetadata={(event) => {
                    const target = event.currentTarget;
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
                  onTimeUpdate={(event) => {
                    const currentSegment = continuousSegments[currentSegmentIndex];
                    if (!currentSegment) {
                      return;
                    }
                    const nextPlaybackMs = currentSegment.accumulatedStartMs
                      + Math.round(event.currentTarget.currentTime * 1000);
                    globalPlaybackMsRef.current = nextPlaybackMs;
                    const now = performance.now();
                    // Cap React re-renders from video timeupdate (~4/s) for smoother UI.
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
                <div className="recorder-stage-video-meta">
                  <span className="recorder-stage-screen-badge">
                    {props.playbackFocus?.eventId ? '已按日志定位' : '连续录像'}
                  </span>
                  <strong>{selectedStream?.label ?? activeContinuousSegment.streamId}</strong>
                  <small>
                    {playbackMetaText} · {encoderSummary.encoderLabel} · {encoderSummary.pathLabel}
                    {activeContinuousSegment
                      ? ` · 当前分段 ${formatDateTime(activeContinuousSegment.startedAtMs)}`
                      : ''}
                  </small>
                </div>
                <div className="recorder-stage-playback-controls recorder-stage-transport-dock">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm recorder-stage-transport-btn"
                    onClick={() => { handleSeekByDelta(-5000); }}
                    disabled={continuousSegments.length === 0}
                    title="后退 5 秒"
                    aria-label="后退 5 秒"
                  >
                    <TransportGlyph>
                      <polygon points="19 20 9 12 19 4 19 20" />
                      <line x1="5" y1="19" x2="5" y2="5" />
                    </TransportGlyph>
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm recorder-stage-transport-btn recorder-stage-play-toggle"
                    onClick={handleTogglePlayback}
                    disabled={continuousSegments.length === 0}
                    title={isPlaybackRunning ? '暂停播放' : '播放录像'}
                    aria-label={isPlaybackRunning ? '暂停播放' : '播放录像'}
                  >
                    {isPlaybackRunning ? (
                      <TransportGlyph>
                        <rect x="6" y="4" width="4" height="16" />
                        <rect x="14" y="4" width="4" height="16" />
                      </TransportGlyph>
                    ) : (
                      <TransportGlyph>
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </TransportGlyph>
                    )}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm recorder-stage-transport-btn"
                    onClick={() => { handleSeekByDelta(5000); }}
                    disabled={continuousSegments.length === 0}
                    title="前进 5 秒"
                    aria-label="前进 5 秒"
                  >
                    <TransportGlyph>
                      <polygon points="5 4 15 12 5 20 5 4" />
                      <line x1="19" y1="5" x2="19" y2="19" />
                    </TransportGlyph>
                  </button>
                  <div className="recorder-stage-transport-track">
                    <span className="recorder-stage-timecode">
                      {formatClock(globalPlaybackMs)}
                    </span>
                    {!isFullscreen ? (
                      <div className="recorder-stage-scrubber">
                        <div className="recorder-stage-scrubber-bar" aria-hidden="true">
                          <div
                            className="recorder-stage-scrubber-fill"
                            style={{ width: `${playbackProgressPct}%` }}
                          />
                          {defectMarkers.map((mark) => (
                            <span
                              key={mark.id}
                              className="recorder-stage-scrubber-mark"
                              style={{ left: `${mark.pct}%` }}
                              title="异常发生点"
                            />
                          ))}
                        </div>
                        <input
                          className="recorder-stage-inline-seek recorder-stage-scrubber-input"
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
                    ) : null}
                    <span className="recorder-stage-timecode">
                      {formatClock(totalDurationMs)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm recorder-stage-transport-btn recorder-stage-quick-defect"
                    onClick={() => { void handleQuickDefect(); }}
                    disabled={!canMarkQuickDefect || isQuickDefectPending}
                    title="标记当前回放位置为缺陷"
                    aria-label="标记当前回放位置为缺陷"
                    aria-busy={isQuickDefectPending}
                  >
                    {isQuickDefectPending ? '标记中…' : '🚩 标记瞬时'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm recorder-stage-transport-btn"
                    onClick={() => { void enterOrExitFullscreen(); }}
                    disabled={continuousSegments.length === 0}
                    title={isFullscreen ? '退出全屏' : '全屏回放'}
                    aria-label={isFullscreen ? '退出全屏' : '全屏回放'}
                  >
                    <TransportGlyph>
                      {isFullscreen ? (
                        <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
                      ) : (
                        <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                      )}
                    </TransportGlyph>
                  </button>
                </div>

                <div
                  className={`recorder-stage-fs-bar${isFullscreen ? ' is-visible' : ''}${controlsVisible ? '' : ' is-hidden'}`}
                  onMouseDown={(event) => { event.stopPropagation(); }}
                >
                  <input
                    className="recorder-stage-fs-seek"
                    type="range"
                    min={0}
                    max={Math.max(totalDurationMs, 1)}
                    step={100}
                    value={Math.min(globalPlaybackMs, Math.max(totalDurationMs, 1))}
                    disabled={continuousSegments.length === 0}
                    aria-label="播放进度"
                    onChange={handleSeekBarInput}
                    onPointerDown={() => {
                      // keep controls while dragging
                      clearHideControlsTimer();
                      setControlsVisible(true);
                    }}
                    onPointerUp={() => {
                      scheduleHideControls();
                    }}
                  />
                  <div className="recorder-stage-fs-toolbar">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        handleTogglePlayback();
                        revealControls();
                      }}
                      disabled={continuousSegments.length === 0}
                    >
                      {isPlaybackRunning ? '暂停' : '播放'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => { handleSeekByDelta(-5000); }}
                      disabled={continuousSegments.length === 0}
                    >
                      -5s
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => { handleSeekByDelta(5000); }}
                      disabled={continuousSegments.length === 0}
                    >
                      +5s
                    </button>
                    <span className="recorder-stage-fs-time">
                      {formatClock(globalPlaybackMs)} / {formatClock(totalDurationMs)}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => { void enterOrExitFullscreen(); }}
                      disabled={continuousSegments.length === 0}
                    >
                      {isFullscreen ? '退出全屏' : '全屏'}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <>
              <div className="recorder-stage-screen-copy">
                <span className="recorder-stage-screen-badge">
                  {props.isRecording ? '录制中' : '暂无录像'}
                </span>
                <h3>
                  {props.isRecording ? '录制中 · 预览已暂停' : '暂无可用录像'}
                </h3>
                <p>
                  {props.isRecording
                    ? '录制中暂停实时预览；停止后自动装载最近录像。'
                    : props.playbackSession
                      ? '已找到录制，可播放文件尚未就绪。'
                      : '开始录制后将显示最近连续录像。'}
                </p>
              </div>
              <div className="recorder-stage-playback-controls recorder-stage-transport-dock">
                <span className="recorder-stage-timecode">
                  {props.isRecording ? (props.isPaused ? '已暂停' : '录制中') : '待机'}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm recorder-stage-transport-btn recorder-stage-quick-defect"
                  onClick={() => { void handleQuickDefect(); }}
                  disabled={!canMarkQuickDefect || isQuickDefectPending}
                  title="标记当前时间为缺陷"
                  aria-label="标记当前时间为缺陷"
                  aria-busy={isQuickDefectPending}
                >
                  {isQuickDefectPending ? '标记中…' : '🚩 标记瞬时'}
                </button>
              </div>
              </>
            )}
            {playerError ? (
              <div className="recorder-stage-player-error ui-banner is-error">
                <strong>提示</strong>
                <span>{playerError}</span>
              </div>
            ) : null}
          </div>

          <div className="timeline-rail">
            <div className="timeline-rail-head">
              <strong>连续时间轴</strong>
              <span>{continuousSegments.length} 段 · {formatClock(totalDurationMs)}</span>
            </div>

            <div className="timeline-rail-list">
              {continuousSegments.length === 0 ? (
                <div className="timeline-rail-empty">暂无录像分段。</div>
              ) : (
                continuousSegments.map((segment, index) => (
                  <button
                    key={segment.segmentId}
                    type="button"
                    className={`timeline-rail-item ${
                      activeContinuousSegment?.segmentId === segment.segmentId ? 'is-active' : ''
                    }`}
                    onClick={() => {
                      seekToPlaybackTime(segment.accumulatedStartMs);
                      setPlayerError(null);
                    }}
                  >
                    <strong>{streamLabelMap.get(segment.streamId) ?? segment.streamId}</strong>
                    <span>
                      {formatClock(segment.accumulatedStartMs)} - {formatClock(segment.accumulatedEndMs)}
                    </span>
                    <small>
                      {formatDuration(segment.durationMs)} · {formatDateTime(segment.startedAtMs)}
                    </small>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="meta-tags recorder-stage-metrics-tags">
          <span className="meta-tag"><strong>流</strong><span>{props.videoStreams.length || '--'}</span></span>
          <span className="meta-tag"><strong>时长</strong><span>{formatClock(totalDurationMs)}</span></span>
          <span className="meta-tag"><strong>捕获</strong><span>{props.metrics ? `${props.metrics.lastCaptureLatencyMs} ms` : '--'}</span></span>
          <span className="meta-tag"><strong>编码延迟</strong><span>{props.metrics ? `${props.metrics.lastEncodeLatencyMs} ms` : '--'}</span></span>
          <span className="meta-tag"><strong>CPU</strong><span>{formatCpuLabel(props.resourceUsage?.totalCpuPercent)}</span></span>
          <span className="meta-tag"><strong>内存</strong><span>{formatMemoryLabel(props.resourceUsage?.totalWorkingSetMb)}</span></span>
        </div>
      </div>
    </section>
  );
}
