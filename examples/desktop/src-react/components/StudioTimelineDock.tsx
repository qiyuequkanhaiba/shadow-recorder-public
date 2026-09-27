import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import type {
  TestSessionPlaybackFocus,
  TestSessionTimelineEvent,
  TestSessionVideoSegment,
} from '../../types/contracts';

export type ContinuousPlaybackSegment = TestSessionVideoSegment & {
  accumulatedStartMs: number;
  accumulatedEndMs: number;
};

export type StudioTimelineDockProps = {
  isRecording: boolean;
  isPaused: boolean;
  continuousSegments: ContinuousPlaybackSegment[];
  totalDurationMs: number;
  globalPlaybackMs: number;
  onSeek: (timeMs: number) => void;
  timelineEvents: TestSessionTimelineEvent[];
  playbackFocus?: TestSessionPlaybackFocus | null;
  onPlaybackFocusChange?: (focus: TestSessionPlaybackFocus | null) => void;
  preWindowSeconds: number;
  postWindowSeconds: number;
  onNotice?: (message: string) => void;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  onSelectAction: (event: TestSessionTimelineEvent, playbackMs: number) => void;
  onSelectDefect: (event: TestSessionTimelineEvent, playbackMs: number) => void;
};

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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

function formatDuration(durationMs?: number): string {
  if (!durationMs || durationMs <= 0) {
    return '--';
  }
  return `${Math.round(durationMs / 100) / 10}s`;
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

/**
 * Identify genuine defect mark events:
 * 1. Event type is 'defect_marked' (from native markTestDefect).
 * 2. Instant mark note fallback (contains '瞬时打标', '缺陷标记', or '已标记缺陷').
 * 3. Note added with 'defect' / '缺陷'.
 * Excludes generic error logs (logLevel === 'error') which are ordinary app errors, not defect markers.
 */
function isDefectTimelineEvent(event: TestSessionTimelineEvent): boolean {
  if ((event.eventType as string) === 'defect_marked') {
    return true;
  }
  const text = `${event.title ?? ''} ${event.message ?? ''}`.toLowerCase();
  if (text.includes('瞬时打标') || text.includes('缺陷标记') || text.includes('已标记缺陷')) {
    return true;
  }
  if (event.eventType === 'note_added' && (text.includes('defect') || text.includes('缺陷'))) {
    return true;
  }
  return false;
}

function isUserOperationEvent(event: TestSessionTimelineEvent): boolean {
  if (event.logCategory === 'operation' || event.eventType === 'step_captured') {
    return true;
  }
  const type = event.eventType.toLowerCase();
  return type.startsWith('mouse_') || type.startsWith('key_') || type.includes('click') || type.includes('input');
}

type ActionCluster = {
  playbackMs: number;
  events: TestSessionTimelineEvent[];
};

export function StudioTimelineDock(props: StudioTimelineDockProps) {
  const {
    isRecording,
    isPaused,
    continuousSegments,
    totalDurationMs,
    globalPlaybackMs,
    onSeek,
    timelineEvents,
    onPlaybackFocusChange,
    preWindowSeconds,
    postWindowSeconds,
    onNotice,
    drawerOpen,
    onToggleDrawer,
    onSelectAction,
    onSelectDefect,
  } = props;

  const [zoom, setZoom] = useState(1);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const playableCanvasRef = useRef<HTMLDivElement | null>(null);
  const [containerClientWidth, setContainerClientWidth] = useState(800);

  // Measure actual container width to avoid hardcoded 800px
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const update = () => {
      const w = el.clientWidth;
      if (w > 0) {
        setContainerClientWidth(w);
      }
    };
    update();

    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Actual pixel width of the playable time scale (0%–100%)
  const trackPixelWidth = useMemo(() => {
    return Math.max(containerClientWidth, 200) * zoom;
  }, [containerClientWidth, zoom]);

  // Action events mapped to playbackMs
  const mappedActions = useMemo(() => {
    if (continuousSegments.length === 0 || totalDurationMs <= 0) {
      return [];
    }
    const results: Array<{ playbackMs: number; event: TestSessionTimelineEvent }> = [];
    for (const event of timelineEvents) {
      if (!isUserOperationEvent(event)) {
        continue;
      }
      const playbackMs = mapOccurredAtToPlaybackMs(event.occurredAtMs, continuousSegments);
      if (playbackMs !== null && playbackMs >= 0 && playbackMs <= totalDurationMs) {
        results.push({ playbackMs, event });
      }
    }
    results.sort((a, b) => a.playbackMs - b.playbackMs);
    return results;
  }, [continuousSegments, timelineEvents, totalDurationMs]);

  // Cluster overlapping action points using real screen pixel threshold (~14px)
  const actionClusters = useMemo(() => {
    if (mappedActions.length === 0 || totalDurationMs <= 0) {
      return [] as ActionCluster[];
    }
    // Dynamic threshold in ms representing 14 screen pixels
    const thresholdMs = trackPixelWidth > 0 ? (14 / trackPixelWidth) * totalDurationMs : 0;
    const clusters: ActionCluster[] = [];

    for (const action of mappedActions) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(action.playbackMs - last.playbackMs) < thresholdMs) {
        last.events.push(action.event);
      } else {
        clusters.push({ playbackMs: action.playbackMs, events: [action.event] });
      }
    }
    return clusters;
  }, [mappedActions, totalDurationMs, trackPixelWidth]);

  // Defect events mapped to playbackMs and clamped windows (preserve postWindowSeconds === 0)
  const mappedDefects = useMemo(() => {
    if (continuousSegments.length === 0 || totalDurationMs <= 0) {
      return [];
    }
    const results: Array<{
      event: TestSessionTimelineEvent;
      playbackMs: number;
      windowStartMs: number;
      windowEndMs: number;
      durationMs: number;
    }> = [];

    const preMs = (preWindowSeconds ?? 10) * 1000;
    const postMs = (postWindowSeconds ?? 10) * 1000;

    for (const event of timelineEvents) {
      if (!isDefectTimelineEvent(event)) {
        continue;
      }
      const playbackMs = mapOccurredAtToPlaybackMs(event.occurredAtMs, continuousSegments);
      if (playbackMs !== null && playbackMs >= 0 && playbackMs <= totalDurationMs) {
        const windowStartMs = clampNumber(playbackMs - preMs, 0, totalDurationMs);
        const windowEndMs = clampNumber(playbackMs + postMs, 0, totalDurationMs);
        results.push({
          event,
          playbackMs,
          windowStartMs,
          windowEndMs,
          durationMs: windowEndMs - windowStartMs,
        });
      }
    }
    return results;
  }, [continuousSegments, preWindowSeconds, postWindowSeconds, timelineEvents, totalDurationMs]);

  // Playhead position in percentage across the playable time scale
  const playheadPct = totalDurationMs > 0
    ? clampNumber((globalPlaybackMs / totalDurationMs) * 100, 0, 100)
    : 0;

  // Ruler tick marks calculation
  const rulerTicks = useMemo(() => {
    if (totalDurationMs <= 0) {
      return [];
    }
    const targetTickCount = Math.max(4, Math.round(8 * zoom));
    const rawInterval = totalDurationMs / targetTickCount;
    let intervalMs = 5000;
    if (rawInterval > 30000) intervalMs = 60000;
    else if (rawInterval > 15000) intervalMs = 30000;
    else if (rawInterval > 7500) intervalMs = 15000;
    else if (rawInterval > 3000) intervalMs = 5000;
    else if (rawInterval > 1000) intervalMs = 2000;
    else intervalMs = 1000;

    const ticks: Array<{ timeMs: number; pct: number; label: string }> = [];
    for (let timeMs = 0; timeMs <= totalDurationMs; timeMs += intervalMs) {
      ticks.push({
        timeMs,
        pct: (timeMs / totalDurationMs) * 100,
        label: formatClock(timeMs),
      });
    }
    return ticks;
  }, [totalDurationMs, zoom]);

  // Click handler for content track
  const handleContentTrackClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (isRecording && !isPaused) {
      onNotice?.('暂停或停止后可回放');
      return;
    }
    if (totalDurationMs <= 0 || !playableCanvasRef.current) {
      return;
    }
    const rect = playableCanvasRef.current.getBoundingClientRect();
    const clickX = clampNumber(event.clientX - rect.left, 0, rect.width);
    const fraction = clampNumber(clickX / rect.width, 0, 1);
    const clickedTimeMs = Math.round(fraction * totalDurationMs);
    onSeek(clickedTimeMs);
  }, [isRecording, isPaused, onNotice, onSeek, totalDurationMs]);

  // Handle clicking an action dot or cluster
  const handleActionClick = useCallback((cluster: ActionCluster, event: ReactMouseEvent) => {
    event.stopPropagation();
    if (isRecording && !isPaused) {
      onNotice?.('暂停或停止后可回放');
      return;
    }
    const primaryEvent = cluster.events[0];
    onSeek(cluster.playbackMs);
    onPlaybackFocusChange?.({
      eventId: primaryEvent.eventId,
      sessionId: primaryEvent.sessionId,
      occurredAtMs: primaryEvent.occurredAtMs,
      displayId: primaryEvent.displayId,
    });
    onSelectAction(primaryEvent, cluster.playbackMs);
  }, [isRecording, isPaused, onNotice, onPlaybackFocusChange, onSeek, onSelectAction]);

  // Handle clicking a defect window
  const handleDefectClick = useCallback((item: typeof mappedDefects[0], event: ReactMouseEvent) => {
    event.stopPropagation();
    if (isRecording && !isPaused) {
      onNotice?.('暂停或停止后可回放');
      return;
    }
    onSeek(item.playbackMs);
    onPlaybackFocusChange?.({
      eventId: item.event.eventId,
      sessionId: item.event.sessionId,
      occurredAtMs: item.event.occurredAtMs,
      displayId: item.event.displayId,
    });
    onSelectDefect(item.event, item.playbackMs);
  }, [isRecording, isPaused, onNotice, onPlaybackFocusChange, onSeek, onSelectDefect]);

  // Whether writing bar is appended outside the 100% playable range
  const isWritingActive = isRecording && !isPaused;

  return (
    <div className="studio-timeline-dock" aria-label="三轨连续时间轴">
      {/* Top Header Row of Timeline */}
      <div className="timeline-dock-header">
        <div className="timeline-dock-meta">
          <span className="timeline-badge-title">三轨时间轴</span>
          <span className="timeline-meta-text">
            {continuousSegments.length > 0
              ? `${continuousSegments.length} 段切片 · 可播放 ${formatClock(totalDurationMs)}`
              : '暂无可播放录像'}
          </span>
          {isWritingActive ? (
            <span className="timeline-recording-live-tag">
              ● 正在写入当前切片
            </span>
          ) : null}
        </div>

        <div className="timeline-dock-controls">
          <label className="timeline-zoom-control" title="时间轴缩放">
            <span className="timeline-zoom-label">缩放 {zoom.toFixed(1)}x</span>
            <input
              type="range"
              min="1"
              max="4"
              step="0.2"
              value={zoom}
              aria-label="时间轴缩放"
              onChange={(e) => setZoom(Number(e.target.value))}
            />
          </label>
          <button
            type="button"
            className={`btn-timeline-drawer-toggle action-btn-sm${drawerOpen ? ' is-active' : ''}`}
            onClick={onToggleDrawer}
            title={drawerOpen ? '收起详情抽屉' : '展开详情抽屉'}
            aria-label={drawerOpen ? '收起详情抽屉' : '展开详情抽屉'}
          >
            📋 详情抽屉
          </button>
        </div>
      </div>

      {/* Main Track Area */}
      <div className="timeline-tracks-layout">
        {/* Left Fixed Rail Heads (Fixed 128px) */}
        <div className="timeline-rail-heads" style={{ width: 128, minWidth: 128, maxWidth: 128 }}>
          <div className="timeline-head-cell timeline-head-ruler">
            <span>标尺</span>
          </div>
          <div className="timeline-head-cell timeline-head-video">
            <span>📹 视频切片</span>
          </div>
          <div className="timeline-head-cell timeline-head-action">
            <span>👆 用户操作</span>
          </div>
          <div className="timeline-head-cell timeline-head-defect">
            <span>🚩 缺陷窗口</span>
          </div>
        </div>

        {/* Right Scrollable Timeline Content Area */}
        <div className="timeline-scroll-container" ref={scrollContainerRef}>
          <div
            className="timeline-content-track"
            style={{ width: isWritingActive ? `${trackPixelWidth + 60}px` : `${trackPixelWidth}px` }}
            onClick={handleContentTrackClick}
          >
            {/* The 0%–100% Playable Time Canvas */}
            <div
              className="timeline-playable-canvas"
              ref={playableCanvasRef}
              style={{ width: `${trackPixelWidth}px` }}
            >
              {/* Playhead Vertical Needle (Spans all tracks within 0%–100%) */}
              {totalDurationMs > 0 ? (
                <div
                  className="timeline-playhead-needle"
                  style={{ left: `${playheadPct}%` }}
                  aria-hidden="true"
                >
                  <div className="timeline-playhead-cap" />
                  <div className="timeline-playhead-line" />
                </div>
              ) : null}

              {/* Row 0: Ruler with Time Ticks */}
              <div className="timeline-track-row timeline-ruler-row">
                {rulerTicks.map((tick) => (
                  <div
                    key={tick.timeMs}
                    className="timeline-ruler-tick"
                    style={{ left: `${tick.pct}%` }}
                  >
                    <span className="timeline-tick-line" />
                    <span className="timeline-tick-label">{tick.label}</span>
                  </div>
                ))}
              </div>

              {/* Track 1: Video Segments Track */}
              <div className="timeline-track-row timeline-video-row">
                {continuousSegments.length === 0 && !isRecording ? (
                  <div className="timeline-row-empty">无切片数据</div>
                ) : null}

                {continuousSegments.map((segment, idx) => {
                  if (totalDurationMs <= 0) return null;
                  const leftPct = (segment.accumulatedStartMs / totalDurationMs) * 100;
                  const widthPct = (Math.max(segment.durationMs, 0) / totalDurationMs) * 100;
                  // Use real screen pixel width (>= 72px)
                  const segmentPixelWidth = (Math.max(segment.durationMs, 0) / totalDurationMs) * trackPixelWidth;
                  const isWideEnough = segmentPixelWidth >= 72;

                  return (
                    <div
                      key={segment.segmentId}
                      className="timeline-video-segment-bar"
                      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                      title={`分段 #${idx + 1} (${formatDuration(segment.durationMs)})`}
                    >
                      {isWideEnough ? (
                        <span className="timeline-segment-label">
                          #{idx + 1} · {formatDuration(segment.durationMs)}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {/* Track 2: User Action Operations Track */}
              <div className="timeline-track-row timeline-action-row">
                {actionClusters.length === 0 ? (
                  <div className="timeline-row-empty-muted">暂无操作点</div>
                ) : null}

                {actionClusters.map((cluster, idx) => {
                  if (totalDurationMs <= 0) return null;
                  const leftPct = (cluster.playbackMs / totalDurationMs) * 100;
                  const count = cluster.events.length;
                  const isMulti = count > 1;
                  const firstEvent = cluster.events[0];
                  const tooltip = isMulti
                    ? `${count} 次连续操作 · 点击定位并查看`
                    : `${firstEvent.action || firstEvent.title || '用户操作'} · ${formatClock(cluster.playbackMs)}`;

                  return (
                    <button
                      key={`cluster-${idx}-${cluster.playbackMs}`}
                      type="button"
                      className={`timeline-action-pin${isMulti ? ' is-multi' : ''}`}
                      style={{ left: `${leftPct}%` }}
                      title={tooltip}
                      onClick={(e) => handleActionClick(cluster, e)}
                    >
                      {isMulti ? (
                        <span className="timeline-action-count">{count}</span>
                      ) : (
                        <span className="timeline-action-dot" />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Track 3: Defect Window Track */}
              <div className="timeline-track-row timeline-defect-row">
                {mappedDefects.length === 0 ? (
                  <div className="timeline-row-empty-muted">暂无缺陷标记</div>
                ) : null}

                {mappedDefects.map((item, idx) => {
                  if (totalDurationMs <= 0) return null;
                  const leftPct = (item.windowStartMs / totalDurationMs) * 100;
                  const widthPct = (Math.max(item.durationMs, 100) / totalDurationMs) * 100;
                  // Use real screen pixel width (>= 60px)
                  const defectPixelWidth = (Math.max(item.durationMs, 100) / totalDurationMs) * trackPixelWidth;
                  const isWideEnough = defectPixelWidth >= 60;

                  return (
                    <button
                      key={`defect-${idx}-${item.event.eventId}`}
                      type="button"
                      className="timeline-defect-window-bar"
                      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                      title={`缺陷窗口 (${Math.round(item.durationMs / 1000)}s) · 点击定位`}
                      onClick={(e) => handleDefectClick(item, e)}
                    >
                      <span className="timeline-defect-flag">🚩</span>
                      {isWideEnough ? (
                        <span className="timeline-defect-seconds">
                          {Math.round(item.durationMs / 1000)}s
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Outside 100%: The 60px "写入中" bar appended only during active recording */}
            {isWritingActive ? (
              <div className="timeline-writing-extension-strip" style={{ width: 60 }}>
                <div className="timeline-track-row timeline-ruler-row" />
                <div className="timeline-track-row timeline-video-row">
                  <div
                    className="timeline-video-writing-bar-pinned"
                    title="当前分段正在写入，封口前不可回放"
                  >
                    <span className="timeline-writing-label">写入中</span>
                  </div>
                </div>
                <div className="timeline-track-row timeline-action-row" />
                <div className="timeline-track-row timeline-defect-row" />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
