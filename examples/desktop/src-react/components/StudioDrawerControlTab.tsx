import clsx from 'clsx';

import styles from '../features/player/Drawer.module.css';
import type { CoordinateMappingResult, SelectedTimelineItem } from './StudioDrawer';

export type StudioDrawerControlTabProps = {
  selectedItem: SelectedTimelineItem | null;
  copiedKey: string | null;
  onCopyText: (key: string, label: string, text?: string | null) => void;
  controlName: string;
  controlType: string;
  frameworkId: string;
  processName: string;
  automationId: string;
  className: string;
  boundingRectDisplay: string;
  coordinateDisplay: string;
  windowTitle?: string;
  coordinateMappingResult?: CoordinateMappingResult | null;
};

export function StudioDrawerControlTab({
  selectedItem,
  copiedKey,
  onCopyText,
  controlName,
  controlType,
  frameworkId,
  processName,
  automationId,
  className,
  boundingRectDisplay,
  coordinateDisplay,
  windowTitle,
  coordinateMappingResult,
}: StudioDrawerControlTabProps) {
  if (!selectedItem) {
    return (
      <div className={styles.emptyState}>
        在时间轴上选择一次操作以检视其目标控件参数
      </div>
    );
  }

  return (
    <div className={styles.tabContent}>
      <div className={styles.tabContent}>
        <div className={styles.summaryCard}>
          <div className={styles.targetTitle}>
            {controlName !== '未采集' ? controlName : (selectedItem.event.title || '交互目标')}
          </div>
          <div className={styles.badges}>
            {controlType ? (
              <span className={styles.badge} title="控件类型">
                🔘 {controlType}
              </span>
            ) : null}
            {frameworkId ? (
              <span className={styles.badge} title="界面框架">
                🧩 {frameworkId}
              </span>
            ) : null}
            <span className={styles.badge} title="所属进程">
              💻 {processName}
            </span>
          </div>
        </div>

        <div className={styles.controlRow}>
          <div className={styles.labelRow}>
            <span className={styles.kicker}>名称</span>
            {controlName !== '未采集' ? (
              <button
                type="button"
                className={styles.copyBtn}
                onClick={() => onCopyText('name', '控件名称', controlName)}
                title="复制控件名称"
              >
                {copiedKey === 'name' ? '✓ 已复制' : '复制'}
              </button>
            ) : null}
          </div>
          <span className={styles.value}>{controlName}</span>
        </div>

        <div className={styles.controlRow}>
          <div className={styles.labelRow}>
            <span className={styles.kicker}>AutomationId</span>
            {automationId !== '未采集' ? (
              <button
                type="button"
                className={styles.copyBtn}
                onClick={() => onCopyText('autoId', 'AutomationId', automationId)}
                title="复制 AutomationId"
              >
                {copiedKey === 'autoId' ? '✓ 已复制' : '复制'}
              </button>
            ) : null}
          </div>
          <span className={clsx(styles.value, automationId !== '未采集' && styles.code)}>
            {automationId}
          </span>
        </div>

        <div className={styles.controlRow}>
          <div className={styles.labelRow}>
            <span className={styles.kicker}>类名</span>
            {className !== '未采集' ? (
              <button
                type="button"
                className={styles.copyBtn}
                onClick={() => onCopyText('class', '类名', className)}
                title="复制类名"
              >
                {copiedKey === 'class' ? '✓ 已复制' : '复制'}
              </button>
            ) : null}
          </div>
          <span className={clsx(styles.value, className !== '未采集' && styles.code)}>
            {className}
          </span>
        </div>

        <div className={styles.controlRow}>
          <div className={styles.labelRow}>
            <span className={styles.kicker}>边界矩形</span>
            {boundingRectDisplay !== '未采集' ? (
              <button
                type="button"
                className={styles.copyBtn}
                onClick={() => onCopyText('rect', '边界矩形', boundingRectDisplay)}
                title="复制边界矩形"
              >
                {copiedKey === 'rect' ? '✓ 已复制' : '复制'}
              </button>
            ) : null}
          </div>
          <div className={styles.inlineRow}>
            <span className={clsx(styles.value, boundingRectDisplay !== '未采集' && styles.code)}>
              {boundingRectDisplay}
            </span>
          </div>
        </div>

        <div className={styles.controlRow}>
          <div className={styles.labelRow}>
            <span className={styles.kicker}>操作坐标</span>
            {coordinateDisplay !== '未采集' ? (
              <button
                type="button"
                className={styles.copyBtn}
                onClick={() => onCopyText('coord', '操作坐标', coordinateDisplay)}
                title="复制操作坐标"
              >
                {copiedKey === 'coord' ? '✓ 已复制' : '复制'}
              </button>
            ) : null}
          </div>
          <div className={styles.inlineRow}>
            <span className={clsx(styles.value, coordinateDisplay !== '未采集' && styles.code)}>
              {coordinateDisplay}
            </span>
            {coordinateMappingResult?.scaleX ? (
              <span className={styles.scaleBadge} title="画面缩放与视口对齐比例">
                {Math.round(coordinateMappingResult.scaleX * 100)}% 视口对齐
              </span>
            ) : null}
          </div>
        </div>

        {windowTitle ? (
          <div className={styles.controlRow}>
            <span className={styles.kicker}>窗口上下文</span>
            <span className={clsx(styles.value, styles.code)}>
              {windowTitle}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
