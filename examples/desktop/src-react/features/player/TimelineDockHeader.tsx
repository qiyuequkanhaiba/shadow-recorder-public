import clsx from 'clsx';

import { formatClock } from './coordinate-mapping';
import styles from './Timeline.module.css';

type Selection = { inPlaybackMs: number; outPlaybackMs: number };

export type TimelineDockHeaderProps = {
  isWritingActive: boolean;
  segmentCount: number;
  totalDurationMs: number;
  selection?: Selection | null;
  onSelectionChange?: (selection: Selection | null) => void;
  isLoopingSelection?: boolean;
  onToggleLoopSelection?: () => void;
  onExportSelection?: () => void;
  isExporting?: boolean;
  onNotice?: (message: string) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
};

/** 时间轴顶栏：片段摘要、导出选区工具条、缩放与抽屉开关。 */
export function TimelineDockHeader({
  isWritingActive,
  segmentCount,
  totalDurationMs,
  selection,
  onSelectionChange,
  isLoopingSelection,
  onToggleLoopSelection,
  onExportSelection,
  isExporting,
  onNotice,
  zoom,
  onZoomChange,
  drawerOpen,
  onToggleDrawer,
}: TimelineDockHeaderProps) {
  return (
    <div className={styles.header}>
      <div className={styles.meta}>
        <span className={styles.title}>三轨时间轴</span>
        {segmentCount > 0 || isWritingActive ? (
          <span className={styles.metaText}>
            {isWritingActive
              ? `正在写入 · 已封口 ${segmentCount} 段`
              : `${segmentCount} 段切片 · 可播放 ${formatClock(totalDurationMs)}`}
          </span>
        ) : null}
        {isWritingActive ? (
          <span className={styles.liveTag}>
            ● 正在写入当前切片
          </span>
        ) : null}
      </div>

      {selection && totalDurationMs > 0 ? (
        <div className={styles.selectionBar} role="toolbar" aria-label="导出选区控制">
          <span className={styles.selectionReadout}>
            ✂️ {formatClock(Math.min(selection.inPlaybackMs, selection.outPlaybackMs))} - {formatClock(Math.max(selection.inPlaybackMs, selection.outPlaybackMs))}
            <strong className={styles.selectionDuration}>
              ({((Math.abs(selection.outPlaybackMs - selection.inPlaybackMs)) / 1000).toFixed(1)}s)
            </strong>
          </span>
          {onToggleLoopSelection ? (
            <button
              type="button"
              className={clsx(styles.actionBtn, isLoopingSelection && styles.actionBtnActive)}
              onClick={onToggleLoopSelection}
              title="A-B 选区循环预览 (L)"
            >
              🔁 循环
            </button>
          ) : null}
          {onExportSelection ? (
            <button
              type="button"
              className={clsx(styles.actionBtn, styles.actionBtnPrimary)}
              disabled={isExporting}
              onClick={onExportSelection}
              title="导出所选区间为 ZIP"
            >
              {isExporting ? '导出中…' : '导出选区'}
            </button>
          ) : null}
          <button
            type="button"
            className={clsx(styles.actionBtn, styles.actionBtnIcon)}
            onClick={() => {
              onSelectionChange?.(null);
              onNotice?.('已清除导出选区');
            }}
            title="清除导出选区"
            aria-label="清除导出选区"
          >
            ✕
          </button>
        </div>
      ) : null}

      <div className={styles.controls}>
        <label className={styles.zoomControl} title="时间轴缩放">
          <span className={styles.zoomLabel}>缩放 {zoom.toFixed(1)}x</span>
          <input
            type="range"
            min="1"
            max="4"
            step="0.2"
            value={zoom}
            aria-label="时间轴缩放"
            onChange={(e) => onZoomChange(Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          className={clsx(styles.actionBtn, drawerOpen && styles.actionBtnActive)}
          onClick={onToggleDrawer}
          title={drawerOpen ? '收起详情抽屉' : '展开详情抽屉'}
          aria-label={drawerOpen ? '收起详情抽屉' : '展开详情抽屉'}
        >
          📋 详情抽屉
        </button>
      </div>
    </div>
  );
}
