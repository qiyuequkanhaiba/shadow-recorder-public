import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { TestSessionOperationRecord } from '../../../types/operation-contracts';
import type { SemanticStepRow } from '../../components/StudioDrawer';

export function useSessionStepsAndOperations(
  currentSessionId: string | null,
  eventsLength?: number,
): { semanticSteps: SemanticStepRow[]; operations: TestSessionOperationRecord[] } {
  const [semanticSteps, setSemanticSteps] = useState<SemanticStepRow[]>([]);
  const [operations, setOperations] = useState<TestSessionOperationRecord[]>([]);

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
  }, [currentSessionId, eventsLength]);

  return { semanticSteps, operations };
}

export function useWorkbenchShortcuts(input: {
  isRecording: boolean;
  isPaused: boolean;
  hasSegments: boolean;
  globalPlaybackMs: number;
  totalDurationMs: number;
  onNotice?: (message: string) => void;
  onTogglePlayback: () => void;
  onSeekByDelta: (deltaMs: number) => void;
  onFrameStep: (direction: -1 | 1) => void;
  onToggleFullscreen: () => void;
  onToggleLoopSelection: () => void;
  onSetInPoint: () => void;
  onSetOutPoint: () => void;
  onClearSelection: () => void;
  onRevealControls: () => void;
}): void {
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
        if (input.isRecording && !input.isPaused) {
          input.onNotice?.('暂停或停止后可回放');
          return;
        }
        input.onTogglePlayback();
        input.onRevealControls();
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        input.onSeekByDelta(5000);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        input.onSeekByDelta(-5000);
        return;
      }
      if (event.key === ',' || event.key === '.') {
        event.preventDefault();
        input.onFrameStep(event.key === '.' ? 1 : -1);
        return;
      }
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        input.onToggleFullscreen();
        return;
      }
      if (event.key === 'l' || event.key === 'L') {
        event.preventDefault();
        input.onToggleLoopSelection();
        return;
      }
      if (event.key === 'i' || event.key === 'I') {
        if (!input.hasSegments) return;
        event.preventDefault();
        input.onSetInPoint();
        return;
      }
      if (event.key === 'o' || event.key === 'O') {
        if (!input.hasSegments) return;
        event.preventDefault();
        input.onSetOutPoint();
        return;
      }
      if (event.key === 'x' || event.key === 'X') {
        if (!input.hasSegments) return;
        event.preventDefault();
        input.onClearSelection();
        return;
      }
      if (event.key === 'Escape') {
        input.onRevealControls();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });
}

/** 全屏播放时 2.5 秒无操作自动隐藏控制条；非全屏或暂停时始终显示。 */
export function useAutoHideControls(isFullscreen: boolean, isPlaybackRunning: boolean) {
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef<number | null>(null);

  const clearHideTimer = useCallback((): void => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHideControls = useCallback((): void => {
    clearHideTimer();
    if (!isFullscreen || !isPlaybackRunning) {
      setControlsVisible(true);
      return;
    }
    hideTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
      hideTimerRef.current = null;
    }, 2500);
  }, [clearHideTimer, isFullscreen, isPlaybackRunning]);

  const revealControls = useCallback((): void => {
    setControlsVisible(true);
    scheduleHideControls();
  }, [scheduleHideControls]);

  useEffect(() => clearHideTimer, [clearHideTimer]);

  return { controlsVisible, scheduleHideControls, revealControls };
}

/**
 * 首次数据加载门：同一会话只在从未拿到片段且 loading 为真时返回 true。
 * 后台刷新（已加载过一次）不再显示加载提示，避免替换当前画面。
 */
export function useInitialLoadingGate(
  sessionId: string | null,
  loading: boolean | undefined,
  segmentCount: number,
): boolean {
  const hasLoadedRef = useRef(false);
  const lastSessionIdRef = useRef<string | null>(null);
  if (sessionId !== lastSessionIdRef.current) {
    lastSessionIdRef.current = sessionId;
    hasLoadedRef.current = false;
  }
  if (loading === false || segmentCount > 0) {
    hasLoadedRef.current = true;
  }
  return Boolean(loading && !hasLoadedRef.current && segmentCount === 0);
}

/** 跟踪元素的客户区尺寸，供坐标映射计算视口。 */
export function useElementSize(
  ref: RefObject<HTMLElement | null>,
  resetKey: unknown,
): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        setSize({ width: el.clientWidth, height: el.clientHeight });
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, resetKey]);
  return size;
}
