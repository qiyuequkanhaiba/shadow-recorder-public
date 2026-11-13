import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';

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
import {
  clampNumber,
  computeCoordinateMapping,
  formatDateTime,
} from '../features/player/coordinate-mapping';
import { useContinuousPlayback } from '../features/player/useContinuousPlayback';
import { usePlaybackStreams } from '../features/player/usePlaybackStreams';
import { useVideoElementController } from '../features/player/useVideoElementController';
import {
  useAutoHideControls,
  useElementSize,
  useInitialLoadingGate,
  useSessionStepsAndOperations,
  useWorkbenchShortcuts,
} from '../features/player/workbench-hooks';
import styles from '../features/player/Workbench.module.css';
import { WorkbenchHudOverlay } from '../features/player/WorkbenchHudOverlay';
import { WorkbenchTransportDock } from '../features/player/WorkbenchTransportDock';
import { WorkbenchViewportContent } from '../features/player/WorkbenchViewportContent';
import { useDocumentVisibility } from '../hooks/useDocumentVisibility';
import { selectionToWallClockRange, type TimelineExportSelection } from '../lib/export-range';
import { frameStepMs, nextPlaybackRate, playbackFrameRate } from '../lib/playback-review';
import { appendNoteForActiveQuickDefect } from '../lib/quick-defect-fallback';
import { resolveVideoEncoderSummary } from '../lib/video-encoder-summary';
import {
  StudioDrawer,
  type CoordinateMappingResult,
  type DrawerTab,
  type SelectedTimelineItem,
} from './StudioDrawer';
import { StudioTimelineDock } from './StudioTimelineDock';

const PLAYBACK_LOCKED_NOTICE = '暂停或停止后可回放';

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
  onExportSession?: (options?: {
    range?: { startMs: number; endMs: number };
    clipMode?: 'precise' | 'fast';
  }) => Promise<void>;
  isExporting?: boolean;
  onClearEvents?: () => Promise<void> | void;
  loading?: boolean;
};

export function RecorderPlaybackStage(props: RecorderPlaybackStageProps) {
  const pageVisible = useDocumentVisibility();
  const controller = useVideoElementController();
  const {
    videoRef,
    playbackRate,
    isFullscreen,
    errorMessage: playerError,
    setCustomError: setPlayerError,
    clearError,
  } = controller;

  const playerRootRef = useRef<HTMLDivElement | null>(null);
  const quickDefectPendingRef = useRef(false);

  const [isQuickDefectPending, setIsQuickDefectPending] = useState(false);
  const [telemetryCollapsed, setTelemetryCollapsed] = useState(
    () => !(props.isRecording && !props.isPaused),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('defect');
  const [timelineSelection, setTimelineSelection] = useState<TimelineExportSelection | null>(null);
  const [isLoopingSelection, setIsLoopingSelection] = useState(false);
  const [selectedItem, setSelectedItem] = useState<SelectedTimelineItem | null>(null);

  const currentSessionId = props.activeSession?.sessionId || props.playbackSession?.sessionId || null;
  const isInitialLoading = useInitialLoadingGate(currentSessionId, props.loading, props.recentSegments.length);
  const isLiveWriting = props.isRecording && !props.isPaused;

  const { semanticSteps, operations } = useSessionStepsAndOperations(
    currentSessionId,
    props.timelineEvents?.length,
  );

  const streams = usePlaybackStreams({
    recentSegments: props.recentSegments,
    matchedSegments: props.matchedSegments,
    videoStreams: props.videoStreams,
  });
  const { continuousSegments, activeStreamId, selectedStream } = streams;

  const playback = useContinuousPlayback({
    controller,
    continuousSegments,
    playableMatchedSegments: streams.playableMatchedSegments,
    playbackFocus: props.playbackFocus,
    isRecording: props.isRecording,
    isPaused: props.isPaused,
    pageVisible,
    timelineSelection,
    isLoopingSelection,
  });
  const { globalPlaybackMs, isPlaybackRunning, activeContinuousSegment, totalDurationMs, seekToPlaybackTime } =
    playback;

  const { controlsVisible, scheduleHideControls, revealControls } = useAutoHideControls(
    isFullscreen,
    isPlaybackRunning,
  );

  useEffect(() => {
    setTimelineSelection(null);
  }, [currentSessionId]);

  useEffect(() => {
    setTelemetryCollapsed(!(props.isRecording && !props.isPaused));
  }, [props.isPaused, props.isRecording]);

  const frameDimensions = useElementSize(playerRootRef, isFullscreen);

  const encoderSummary = useMemo(() => {
    return resolveVideoEncoderSummary({
      streams: props.videoStreams,
      segments: props.recentSegments,
      preferredStreamId: activeStreamId,
    });
  }, [activeStreamId, props.recentSegments, props.videoStreams]);

  const playbackProgressPct =
    totalDurationMs > 0 ? Math.min(100, (globalPlaybackMs / totalDurationMs) * 100) : 0;
  const canRenderVideo =
    !isLiveWriting && continuousSegments.length > 0 && !!activeContinuousSegment?.playbackUrl;
  const canMarkQuickDefect = Boolean(
    props.activeSession?.sessionId || props.playbackSession?.sessionId || activeContinuousSegment?.sessionId,
  );

  /** 录制写入中不允许回放操作；返回 true 表示已拦截。 */
  function blockWhileLiveWriting(): boolean {
    if (!isLiveWriting) return false;
    props.onNotice?.(PLAYBACK_LOCKED_NOTICE);
    return true;
  }

  function handleTogglePlayback(): void {
    if (blockWhileLiveWriting()) return;
    playback.togglePlaybackRunning();
  }

  async function enterOrExitFullscreen(): Promise<void> {
    const root = playerRootRef.current;
    if (!root) return;
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
    if (blockWhileLiveWriting() || continuousSegments.length === 0) return;
    seekToPlaybackTime(playback.globalPlaybackMsRef.current + deltaMs);
    revealControls();
  }

  function handleFrameStep(direction: -1 | 1): void {
    if (blockWhileLiveWriting()) return;
    playback.setIsPlaybackRunning(false);
    const fps = playbackFrameRate(
      props.playbackSession?.recordingProfile ?? props.activeSession?.recordingProfile,
    );
    handleSeekByDelta(frameStepMs(fps, direction));
  }

  function handleSeekBarInput(event: ChangeEvent<HTMLInputElement>): void {
    if (blockWhileLiveWriting() || continuousSegments.length === 0) return;
    seekToPlaybackTime(Number(event.target.value));
    revealControls();
  }

  function handleSetInPoint(): void {
    setTimelineSelection((prev) => ({
      inPlaybackMs: globalPlaybackMs,
      outPlaybackMs: prev ? Math.max(prev.outPlaybackMs, globalPlaybackMs) : totalDurationMs,
    }));
    props.onNotice?.('已设置入点 (In Point)');
  }

  function handleSetOutPoint(): void {
    setTimelineSelection((prev) => ({
      inPlaybackMs: prev ? Math.min(prev.inPlaybackMs, globalPlaybackMs) : 0,
      outPlaybackMs: globalPlaybackMs,
    }));
    props.onNotice?.('已设置出点 (Out Point)');
  }

  function handleToggleLoopSelection(): void {
    setIsLoopingSelection((prev) => {
      const nextVal = !prev;
      props.onNotice?.(nextVal ? '已开启选区循环预览' : '已关闭选区循环预览');
      return nextVal;
    });
  }

  function exportTimelineSelection(): Promise<void> | undefined {
    const wallRange = timelineSelection
      ? selectionToWallClockRange(timelineSelection, continuousSegments)
      : null;
    if (timelineSelection && !wallRange) {
      props.onNotice?.('无法计算选中区间的绝对时间');
      return undefined;
    }
    return props.onExportSession?.(wallRange ? { range: wallRange, clipMode: 'precise' } : undefined);
  }

  async function handleQuickDefect(): Promise<void> {
    if (quickDefectPendingRef.current) return;

    const segment = activeContinuousSegment;
    const sessionId =
      segment?.sessionId || props.playbackSession?.sessionId || props.activeSession?.sessionId;
    if (!sessionId) {
      const message = '当前没有可标记的会话，请先开始录制或选择历史录像';
      setPlayerError(message);
      props.onNotice?.(message);
      return;
    }

    const markedAtMs =
      segment && videoRef.current
        ? segment.startedAtMs
          + clampNumber(
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
          await api.markTestDefect({ sessionId, markedAtMs, note, actual: note });
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
      clearError();
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

  useWorkbenchShortcuts({
    isRecording: props.isRecording,
    isPaused: props.isPaused,
    hasSegments: continuousSegments.length > 0,
    globalPlaybackMs,
    totalDurationMs,
    onNotice: props.onNotice,
    onTogglePlayback: handleTogglePlayback,
    onSeekByDelta: handleSeekByDelta,
    onFrameStep: handleFrameStep,
    onToggleFullscreen: () => void enterOrExitFullscreen(),
    onToggleLoopSelection: handleToggleLoopSelection,
    onSetInPoint: handleSetInPoint,
    onSetOutPoint: handleSetOutPoint,
    onClearSelection: () => {
      setTimelineSelection(null);
      props.onNotice?.('已清除选区');
    },
    onRevealControls: revealControls,
  });

  const badgeCornerText =
    props.isRecording && props.isPaused ? '已封口录像 · 落后当前写入至少 1 段' : '已封口录像';
  const preWindowSeconds = props.config?.defectPreWindowSeconds ?? 10;
  const postWindowSeconds = props.config?.defectPostWindowSeconds ?? 10;

  const handleSelectAction = useCallback((event: TestSessionTimelineEvent, playbackMs: number) => {
    setSelectedItem({ type: 'action', event, playbackMs });
    setDrawerTab('control');
    setDrawerOpen(true);
  }, []);

  const handleSelectDefect = useCallback((event: TestSessionTimelineEvent, playbackMs: number) => {
    setSelectedItem({ type: 'defect', event, playbackMs });
    setDrawerTab('defect');
    setDrawerOpen(true);
  }, []);

  const coordinateMappingResult = useMemo<CoordinateMappingResult | null>(() => {
    return computeCoordinateMapping({
      isRecording: props.isRecording,
      isPaused: props.isPaused,
      selectedItem,
      semanticSteps,
      operations,
      selectedStream,
      videoElement: videoRef.current,
      frameDimensions,
    });
  }, [frameDimensions, operations, props.isPaused, props.isRecording, selectedItem, selectedStream, semanticSteps, videoRef]);

  return (
    <section data-ui-scope="workbench" className={styles.stage}>
      <div className={styles.viewportShell}>
        <div
          ref={playerRootRef}
          className={`${styles.screenFrame}${isFullscreen ? ` ${styles.isFullscreen}` : ''}${isFullscreen && !controlsVisible ? ` ${styles.controlsHidden}` : ''}`}
          onMouseMove={() => {
            if (isFullscreen) revealControls();
          }}
          onMouseLeave={() => {
            if (isFullscreen && isPlaybackRunning) scheduleHideControls();
          }}
        >
          <WorkbenchHudOverlay
            selectedStream={selectedStream}
            availablePlaybackStreams={streams.availablePlaybackStreams}
            activeStreamId={activeStreamId}
            onChangeStream={(streamId) => {
              streams.setSelectedStreamId(streamId);
              playback.resetPlayback();
            }}
            encoderSummary={encoderSummary}
            activeEncoderName={activeContinuousSegment?.encoderName}
            telemetryCollapsed={telemetryCollapsed}
            onToggleTelemetry={setTelemetryCollapsed}
            metrics={props.metrics}
            resourceUsage={props.resourceUsage}
            showMarkerOverlay={canRenderVideo}
            coordinateMappingResult={coordinateMappingResult}
          />

          <WorkbenchViewportContent
            isLiveWriting={isLiveWriting}
            isInitialLoading={isInitialLoading}
            canRenderVideo={canRenderVideo}
            sealedSegmentCount={continuousSegments.length}
            activeSegment={activeContinuousSegment}
            videoRef={videoRef}
            badgeText={badgeCornerText}
            playerError={playerError}
            onVideoClick={() => {
              handleTogglePlayback();
              if (isFullscreen) revealControls();
            }}
            onVideoDoubleClick={() => void enterOrExitFullscreen()}
            videoHandlers={playback.videoHandlers}
          />

          <WorkbenchTransportDock
            hasSegments={continuousSegments.length > 0}
            isPlaybackRunning={isPlaybackRunning}
            playbackRate={playbackRate}
            globalPlaybackMs={globalPlaybackMs}
            totalDurationMs={totalDurationMs}
            playbackProgressPct={playbackProgressPct}
            canMarkQuickDefect={canMarkQuickDefect}
            isQuickDefectPending={isQuickDefectPending}
            isFullscreen={isFullscreen}
            onSeekByDelta={handleSeekByDelta}
            onTogglePlayback={handleTogglePlayback}
            onFrameStep={handleFrameStep}
            onCyclePlaybackRate={() => controller.setRate(nextPlaybackRate(playbackRate))}
            onSeekBarInput={handleSeekBarInput}
            onSetInPoint={handleSetInPoint}
            onSetOutPoint={handleSetOutPoint}
            onQuickDefect={() => void handleQuickDefect()}
            onToggleFullscreen={() => void enterOrExitFullscreen()}
          />
        </div>

        <StudioDrawer
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          activeTab={drawerTab}
          onTabChange={setDrawerTab}
          selectedItem={selectedItem}
          preWindowSeconds={preWindowSeconds}
          postWindowSeconds={postWindowSeconds}
          onNotice={props.onNotice}
          hasTimelineSelection={Boolean(timelineSelection)}
          onSelectDefectWindowForExport={
            selectedItem && totalDurationMs > 0
              ? () => {
                  setTimelineSelection({
                    inPlaybackMs: clampNumber(selectedItem.playbackMs - preWindowSeconds * 1000, 0, totalDurationMs),
                    outPlaybackMs: clampNumber(selectedItem.playbackMs + postWindowSeconds * 1000, 0, totalDurationMs),
                  });
                  props.onNotice?.('已将缺陷前后时间窗口设为导出选区');
                }
              : undefined
          }
          onExportSession={props.onExportSession ? async () => exportTimelineSelection() : undefined}
          isExporting={props.isExporting}
          semanticSteps={semanticSteps}
          operations={operations}
          mappingResult={coordinateMappingResult}
          timelineEvents={props.timelineEvents ?? []}
        />
      </div>

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
        preWindowSeconds={preWindowSeconds}
        postWindowSeconds={postWindowSeconds}
        onNotice={props.onNotice}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((open) => !open)}
        onSelectAction={handleSelectAction}
        onSelectDefect={handleSelectDefect}
        selection={timelineSelection}
        onSelectionChange={setTimelineSelection}
        isLoopingSelection={isLoopingSelection}
        onToggleLoopSelection={handleToggleLoopSelection}
        onExportSelection={
          props.onExportSession && timelineSelection ? () => void exportTimelineSelection() : undefined
        }
        isExporting={props.isExporting}
      />
    </section>
  );
}
