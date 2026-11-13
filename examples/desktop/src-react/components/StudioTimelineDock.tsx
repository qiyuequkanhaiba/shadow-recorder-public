import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import clsx from 'clsx';

import type {
  TestSessionPlaybackFocus,
  TestSessionTimelineEvent,
  TestSessionVideoSegment,
} from '../../types/contracts';
import { clampNumber, formatClock } from '../features/player/coordinate-mapping';
import {
  clientXToPlaybackMs,
  formatDuration,
  useTimelineGeometry,
  type ActionCluster,
  type MappedDefect,
} from '../features/player/timeline-geometry';
import styles from '../features/player/Timeline.module.css';
import { TimelineDockHeader } from '../features/player/TimelineDockHeader';
import { TimelineSelectionOverlay } from '../features/player/TimelineSelectionOverlay';

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
  selection?: { inPlaybackMs: number; outPlaybackMs: number } | null;
  onSelectionChange?: (selection: { inPlaybackMs: number; outPlaybackMs: number } | null) => void;
  isLoopingSelection?: boolean;
  onToggleLoopSelection?: () => void;
  onExportSelection?: () => void;
  isExporting?: boolean;
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
    selection,
    onSelectionChange,
    isLoopingSelection,
    onToggleLoopSelection,
    onExportSelection,
    isExporting,
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

  const { actionClusters, mappedDefects, rulerTicks } = useTimelineGeometry({
    continuousSegments,
    timelineEvents,
    totalDurationMs,
    trackPixelWidth,
    zoom,
    preWindowSeconds,
    postWindowSeconds,
  });

  // Playhead position in percentage across the playable time scale
  const playheadPct = totalDurationMs > 0
    ? clampNumber((globalPlaybackMs / totalDurationMs) * 100, 0, 100)
    : 0;

  const isMarqueeDraggingRef = useRef(false);
  const marqueeStartMsRef = useRef<number | null>(null);
  const marqueeStartXRef = useRef<number | null>(null);

  const handleTrackPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('[data-timeline-interactive]')) {
      return;
    }
    if (isRecording && !isPaused) {
      onNotice?.('暂停或停止后可回放');
      return;
    }
    if (!playableCanvasRef.current || totalDurationMs <= 0) return;
    const startMs = clientXToPlaybackMs(playableCanvasRef.current, event.clientX, totalDurationMs);
    marqueeStartMsRef.current = startMs;
    marqueeStartXRef.current = event.clientX;
    isMarqueeDraggingRef.current = false;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }, [isPaused, isRecording, onNotice, totalDurationMs]);

  const handleTrackPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (marqueeStartMsRef.current === null || marqueeStartXRef.current === null || !playableCanvasRef.current || totalDurationMs <= 0) {
      return;
    }
    const deltaX = Math.abs(event.clientX - marqueeStartXRef.current);
    if (!isMarqueeDraggingRef.current && deltaX >= 6) {
      isMarqueeDraggingRef.current = true;
    }
    if (isMarqueeDraggingRef.current) {
      const currentMs = clientXToPlaybackMs(playableCanvasRef.current, event.clientX, totalDurationMs);
      const inMs = Math.min(marqueeStartMsRef.current, currentMs);
      const outMs = Math.max(marqueeStartMsRef.current, currentMs);
      onSelectionChange?.({ inPlaybackMs: inMs, outPlaybackMs: outMs });
    }
  }, [onSelectionChange, totalDurationMs]);

  const handleTrackPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {}
    const startMs = marqueeStartMsRef.current;
    const wasDragging = isMarqueeDraggingRef.current;
    marqueeStartMsRef.current = null;
    marqueeStartXRef.current = null;
    isMarqueeDraggingRef.current = false;

    if (startMs === null) return;
    if (totalDurationMs <= 0 || !playableCanvasRef.current) return;
    const endMs = clientXToPlaybackMs(playableCanvasRef.current, event.clientX, totalDurationMs);

    if (!wasDragging) {
      onSeek(endMs);
    } else if (Math.abs(endMs - startMs) < 200) {
      onSelectionChange?.(null);
    } else {
      onSeek(Math.min(startMs, endMs));
    }
  }, [onSeek, onSelectionChange, totalDurationMs]);

  const handleTrackPointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {}
    marqueeStartMsRef.current = null;
    marqueeStartXRef.current = null;
    isMarqueeDraggingRef.current = false;
  }, []);

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
  const handleDefectClick = useCallback((item: MappedDefect, event: ReactMouseEvent) => {
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
    <div className={styles.dock} data-ui-scope="workbench" aria-label="三轨连续时间轴">
      <TimelineDockHeader
        isWritingActive={isWritingActive}
        segmentCount={continuousSegments.length}
        totalDurationMs={totalDurationMs}
        selection={selection}
        onSelectionChange={onSelectionChange}
        isLoopingSelection={isLoopingSelection}
        onToggleLoopSelection={onToggleLoopSelection}
        onExportSelection={onExportSelection}
        isExporting={isExporting}
        onNotice={onNotice}
        zoom={zoom}
        onZoomChange={setZoom}
        drawerOpen={drawerOpen}
        onToggleDrawer={onToggleDrawer}
      />

      {/* Main Track Area */}
      <div className={styles.tracksLayout}>
        {/* Left Fixed Rail Heads (Fixed 128px) */}
        <div className={styles.railHeads}>
          <div className={clsx(styles.headCell, styles.headRuler)}>
            <span>标尺</span>
          </div>
          <div className={styles.headCell}>
            <span>📹 视频切片</span>
          </div>
          <div className={styles.headCell}>
            <span>👆 用户操作</span>
          </div>
          <div className={styles.headCell}>
            <span>🚩 缺陷窗口</span>
          </div>
        </div>

        {/* Right Scrollable Timeline Content Area */}
        <div className={styles.scrollContainer} ref={scrollContainerRef}>
          <div
            className={styles.contentTrack}
            style={{ width: isWritingActive ? `${trackPixelWidth + 60}px` : `${trackPixelWidth}px` }}
            onPointerDown={handleTrackPointerDown}
            onPointerMove={handleTrackPointerMove}
            onPointerUp={handleTrackPointerUp}
            onPointerCancel={handleTrackPointerCancel}
          >
            {/* The 0%–100% Playable Time Canvas */}
            <div
              className={styles.playableCanvas}
              ref={playableCanvasRef}
              style={{ width: `${trackPixelWidth}px` }}
            >
              {selection && totalDurationMs > 0 ? (
                <TimelineSelectionOverlay
                  selection={selection}
                  totalDurationMs={totalDurationMs}
                  isLocked={isRecording && !isPaused}
                  canvasRef={playableCanvasRef}
                  onSelectionChange={onSelectionChange}
                  onSeek={onSeek}
                />
              ) : null}

              {/* Playhead Vertical Needle (Spans all tracks within 0%–100%) */}
              {totalDurationMs > 0 ? (
                <div
                  className={styles.playhead}
                  style={{ left: `${playheadPct}%` }}
                  aria-hidden="true"
                >
                  <div className={styles.playheadCap} />
                  <div className={styles.playheadLine} />
                </div>
              ) : null}

              {/* Row 0: Ruler with Time Ticks */}
              <div className={clsx(styles.trackRow, styles.rulerRow)}>
                {rulerTicks.map((tick) => (
                  <div
                    key={tick.timeMs}
                    className={styles.rulerTick}
                    style={{ left: `${tick.pct}%` }}
                  >
                    <span className={styles.tickLine} />
                    <span className={styles.tickLabel}>{tick.label}</span>
                  </div>
                ))}
              </div>

              {/* Track 1: Video Segments Track */}
              <div className={styles.trackRow}>
                {continuousSegments.length === 0 && !isRecording ? (
                  <div className={styles.rowEmpty}>无切片数据</div>
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
                      className={styles.segmentBar}
                      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                      title={`分段 #${idx + 1} (${formatDuration(segment.durationMs)}) · 双击设为选区`}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        onSelectionChange?.({
                          inPlaybackMs: segment.accumulatedStartMs,
                          outPlaybackMs: segment.accumulatedEndMs,
                        });
                        onSeek(segment.accumulatedStartMs);
                        onNotice?.(`已选中分段 #${idx + 1} (${formatDuration(segment.durationMs)}) 作为导出选区`);
                      }}
                    >
                      {isWideEnough ? (
                        <span className={styles.segmentLabel}>
                          #{idx + 1} · {formatDuration(segment.durationMs)}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {/* Track 2: User Action Operations Track */}
              <div className={styles.trackRow}>
                {actionClusters.length === 0 ? (
                  <div className={styles.rowEmptyMuted}>暂无操作点</div>
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
                      className={styles.actionPin}
                      data-timeline-interactive=""
                      style={{ left: `${leftPct}%` }}
                      title={tooltip}
                      onClick={(e) => handleActionClick(cluster, e)}
                    >
                      {isMulti ? (
                        <span className={styles.actionCount}>{count}</span>
                      ) : (
                        <span className={styles.actionDot} />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Track 3: Defect Window Track */}
              <div className={styles.trackRow}>
                {mappedDefects.length === 0 ? (
                  <div className={styles.rowEmptyMuted}>暂无缺陷标记</div>
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
                      className={styles.defectBar}
                      data-timeline-interactive=""
                      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                      title={`缺陷窗口 (${Math.round(item.durationMs / 1000)}s) · 点击定位`}
                      onClick={(e) => handleDefectClick(item, e)}
                    >
                      <span aria-hidden="true">🚩</span>
                      {isWideEnough ? (
                        <span className={styles.defectSeconds}>
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
              <div className={styles.writingStrip}>
                <div className={clsx(styles.trackRow, styles.rulerRow)} />
                <div className={styles.trackRow}>
                  <div
                    className={styles.writingBar}
                    title="当前分段正在写入，封口前不可回放"
                  >
                    <span className={styles.writingLabel}>写入中</span>
                  </div>
                </div>
                <div className={styles.trackRow} />
                <div className={styles.trackRow} />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
