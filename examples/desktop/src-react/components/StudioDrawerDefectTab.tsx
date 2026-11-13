import clsx from 'clsx';

import styles from '../features/player/Drawer.module.css';
import { Button } from '../ui/Button';
import type { SelectedTimelineItem } from './StudioDrawer';

export type StudioDrawerDefectTabProps = {
  selectedItem: SelectedTimelineItem | null;
  copiedKey: string | null;
  onCopyText: (key: string, label: string, text?: string | null) => void;
  onCopySteps: () => void;
  formatDateTime: (timestampMs?: number) => string;
  preWindowSeconds: number;
  postWindowSeconds: number;
  windowTitle?: string;
  onSelectDefectWindowForExport?: () => void;
  onExportSession?: () => Promise<void> | void;
  isExporting?: boolean;
  hasTimelineSelection?: boolean;
};

export function StudioDrawerDefectTab({
  selectedItem,
  copiedKey,
  onCopyText,
  onCopySteps,
  formatDateTime,
  preWindowSeconds,
  postWindowSeconds,
  windowTitle,
  onSelectDefectWindowForExport,
  onExportSession,
  isExporting,
  hasTimelineSelection,
}: StudioDrawerDefectTabProps) {
  if (!selectedItem) {
    return (
      <div className={styles.emptyState}>
        在时间轴上选择一次操作或一个缺陷窗
      </div>
    );
  }

  const rawText =
    selectedItem.event.message || selectedItem.event.title || selectedItem.event.action;

  return (
    <div className={styles.tabContent}>
      <div className={styles.fieldGroup}>
        <div className={styles.labelRow}>
          <span className={styles.kicker}>事件原文</span>
          <button
            type="button"
            className={styles.copyBtn}
            onClick={() => onCopyText('raw_event', '事件原文', rawText)}
            title="复制事件原文"
          >
            {copiedKey === 'raw_event' ? '✓ 已复制' : '复制'}
          </button>
        </div>
        <p className={clsx(styles.value, styles.rawText)}>
          {rawText || '未采集原文'}
        </p>
      </div>

      <div className={styles.fieldGroup}>
        <span className={styles.kicker}>发生时间</span>
        <span className={styles.value}>
          {formatDateTime(selectedItem.event.occurredAtMs)}
        </span>
      </div>

      <div className={styles.fieldGroup}>
        <span className={styles.kicker}>缺陷前后窗口</span>
        <div className={styles.windowPill}>
          ⏱️ 前置 {preWindowSeconds ?? 10} 秒 · 后置 {postWindowSeconds ?? 10} 秒
        </div>
      </div>

      {windowTitle ? (
        <div className={styles.fieldGroup}>
          <span className={styles.kicker}>窗口上下文</span>
          <span className={clsx(styles.value, styles.code)}>
            {windowTitle}
          </span>
        </div>
      ) : null}

      <div className={styles.actionsRow}>
        <Button
          variant="secondary"
          size="sm"
          onClick={onCopySteps}
        >
          {copiedKey === 'defect_all' ? '✓ 已复制' : '复制信息'}
        </Button>
        {onSelectDefectWindowForExport ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={onSelectDefectWindowForExport}
            title="将该缺陷前后时间窗口设为导出选区"
          >
            ✂️ 选定缺陷窗口
          </Button>
        ) : null}
        {onExportSession ? (
          <Button
            variant="primary"
            size="sm"
            disabled={isExporting}
            onClick={() => { void onExportSession(); }}
          >
            {isExporting ? '导出中…' : (hasTimelineSelection ? '导出选中区间' : '导出当前会话')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
