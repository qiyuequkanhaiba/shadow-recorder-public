import { useCallback, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import clsx from 'clsx';

import { clientXToPlaybackMs } from './timeline-geometry';
import styles from './Timeline.module.css';

type Selection = { inPlaybackMs: number; outPlaybackMs: number };

export type TimelineSelectionOverlayProps = {
  selection: Selection;
  totalDurationMs: number;
  isLocked: boolean;
  canvasRef: RefObject<HTMLDivElement | null>;
  onSelectionChange?: (selection: Selection | null) => void;
  onSeek: (timeMs: number) => void;
};

/** 导出选区覆盖层：显示时长徽章，左右把手可拖拽微调入点和出点。 */
export function TimelineSelectionOverlay({
  selection,
  totalDurationMs,
  isLocked,
  canvasRef,
  onSelectionChange,
  onSeek,
}: TimelineSelectionOverlayProps) {
  const draggingHandleRef = useRef<'in' | 'out' | null>(null);

  const handlePointerDownHandle = useCallback((type: 'in' | 'out', event: ReactPointerEvent) => {
    event.stopPropagation();
    event.preventDefault();
    if (isLocked) return;
    draggingHandleRef.current = type;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }, [isLocked]);

  const handlePointerMoveHandle = useCallback((event: ReactPointerEvent) => {
    const handleType = draggingHandleRef.current;
    if (!handleType || totalDurationMs <= 0 || !canvasRef.current) return;
    const targetMs = clientXToPlaybackMs(canvasRef.current, event.clientX, totalDurationMs);

    const currentIn = Math.min(selection.inPlaybackMs, selection.outPlaybackMs);
    const currentOut = Math.max(selection.inPlaybackMs, selection.outPlaybackMs);
    if (handleType === 'in') {
      const nextIn = Math.min(targetMs, currentOut);
      onSelectionChange?.({ inPlaybackMs: nextIn, outPlaybackMs: currentOut });
      onSeek(nextIn);
    } else {
      const nextOut = Math.max(targetMs, currentIn);
      onSelectionChange?.({ inPlaybackMs: currentIn, outPlaybackMs: nextOut });
      onSeek(nextOut);
    }
  }, [onSelectionChange, onSeek, selection, totalDurationMs]);

  const handlePointerUpHandle = useCallback((event: ReactPointerEvent) => {
    if (draggingHandleRef.current) {
      draggingHandleRef.current = null;
      try {
        (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
      } catch {}
    }
  }, []);

  return (
    <div
      className={styles.selectionOverlay}
      style={{
        left: `${(Math.min(selection.inPlaybackMs, selection.outPlaybackMs) / totalDurationMs) * 100}%`,
        width: `${Math.max(0.5, (Math.abs(selection.outPlaybackMs - selection.inPlaybackMs) / totalDurationMs) * 100)}%`,
      }}
      title="选中导出区间（左右两侧可拖拽微调）"
    >
      <div
        className={styles.selectionBadge}
        title="当前导出选区时长"
      >
        ✂️ {((Math.abs(selection.outPlaybackMs - selection.inPlaybackMs)) / 1000).toFixed(1)}s
      </div>
      <div
        className={clsx(styles.selectionHandle, styles.handleIn)}
        data-timeline-interactive=""
        onPointerDown={(e) => handlePointerDownHandle('in', e)}
        onPointerMove={handlePointerMoveHandle}
        onPointerUp={handlePointerUpHandle}
        onPointerCancel={handlePointerUpHandle}
        onClick={(e) => e.stopPropagation()}
        title="拖拽微调入点"
      >
        <span className={styles.selectionGrip} />
      </div>
      <div
        className={clsx(styles.selectionHandle, styles.handleOut)}
        data-timeline-interactive=""
        onPointerDown={(e) => handlePointerDownHandle('out', e)}
        onPointerMove={handlePointerMoveHandle}
        onPointerUp={handlePointerUpHandle}
        onPointerCancel={handlePointerUpHandle}
        onClick={(e) => e.stopPropagation()}
        title="拖拽微调出点"
      >
        <span className={styles.selectionGrip} />
      </div>
    </div>
  );
}
