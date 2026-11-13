import { useCallback, useState } from 'react';
import clsx from 'clsx';

import type {
  TestSessionTimelineEvent,
} from '../../types/contracts';
import type {
  TestSessionOperationRecord,
} from '../../types/operation-contracts';
import { formatDateTime } from '../features/player/coordinate-mapping';
import styles from '../features/player/Drawer.module.css';
import { isUserOperationEvent } from '../features/player/timeline-geometry';
import { StudioDrawerControlTab } from './StudioDrawerControlTab';
import { StudioDrawerDefectTab } from './StudioDrawerDefectTab';
import { StudioDrawerStepsTab } from './StudioDrawerStepsTab';

export type DrawerTab = 'defect' | 'control' | 'steps';

export type SelectedTimelineItem = {
  type: 'action' | 'defect';
  event: TestSessionTimelineEvent;
  playbackMs: number;
};

export type SemanticStepRow = {
  stepId: string;
  startedAtMs: number;
  endedAtMs?: number;
  title: string;
  summary?: string;
  stepType: string;
  precisionLevel?: string;
  processName?: string;
  process_name?: string;
  windowTitle?: string;
  window_title?: string;
  controlName?: string;
  control_name?: string;
  controlType?: string;
  control_type?: string;
  automationId?: string;
  automation_id?: string;
  className?: string;
  class_name?: string;
  x?: number;
  y?: number;
  logicalX?: number;
  logicalY?: number;
  displayId?: string;
  boundingRect?: { left: number; top: number; width: number; height: number };
  controlRect?: { left: number; top: number; width: number; height: number };
  bounding_rect?: { left: number; top: number; width: number; height: number };
  sourceEventIds?: string[];
  source_event_ids?: string[];
};

export type CoordinateMappingResult = {
  success: boolean;
  reason?: string;
  overlay?: {
    type: 'rect' | 'point';
    x: number;
    y: number;
    width?: number;
    height?: number;
    label?: string;
  };
  scaleX?: number;
};

export type StudioDrawerProps = {
  isOpen: boolean;
  onClose: () => void;
  activeTab: DrawerTab;
  onTabChange: (tab: DrawerTab) => void;
  selectedItem: SelectedTimelineItem | null;
  preWindowSeconds: number;
  postWindowSeconds: number;
  onNotice?: (message: string) => void;
  onExportSession?: () => Promise<void>;
  hasTimelineSelection?: boolean;
  onSelectDefectWindowForExport?: () => void;
  isExporting?: boolean;
  semanticSteps: SemanticStepRow[];
  operations?: TestSessionOperationRecord[];
  mappingResult?: CoordinateMappingResult | null;
  timelineEvents: TestSessionTimelineEvent[];
};

function getActionKindMeta(kind?: string): { icon: string; label: string } {
  const k = (kind ?? '').toLowerCase();
  if (k.includes('double')) return { icon: '✌️', label: '双击' };
  if (k.includes('right')) return { icon: '👉', label: '右键' };
  if (k.includes('scroll')) return { icon: '📜', label: '滚动' };
  if (k.includes('type') || k.includes('input') || k.includes('key')) return { icon: '⌨️', label: '输入' };
  if (k.includes('switch') || k.includes('window')) return { icon: '🔄', label: '切窗' };
  if (k.includes('toggle') || k.includes('select') || k.includes('check')) return { icon: '🔘', label: '选择' };
  if (k.includes('shortcut')) return { icon: '⚡', label: '快捷键' };
  if (k.includes('click')) return { icon: '👆', label: '单击' };
  return { icon: '⚡', label: '操作' };
}

function getOutcomeChip(status?: string): { label: string; tone: 'success' | 'warning' | 'muted' | 'danger' | 'info' } {
  switch (status) {
    case 'confirmed':
      return { label: '✓ 已确认', tone: 'success' };
    case 'candidate':
      return { label: '⚠️ 候选', tone: 'warning' };
    case 'ambiguous':
      return { label: '❓ 待确认', tone: 'warning' };
    case 'incomplete':
      return { label: '⏳ 未完成', tone: 'muted' };
    case 'observerDegraded':
      return { label: '⚡ 降级', tone: 'danger' };
    case 'legacyUnknown':
      return { label: 'ℹ️ 旧记录', tone: 'info' };
    default:
      return { label: status || '未定', tone: 'muted' };
  }
}

function getPrecisionBadge(level?: string): string | null {
  if (!level) return null;
  const l = level.toLowerCase();
  if (l === 'l2' || l.includes('high')) return 'L2 精准';
  if (l === 'l1' || l.includes('medium')) return 'L1 基础';
  if (l === 'l0' || l.includes('low') || l.includes('legacy')) return 'L0 原始';
  return level;
}

export function StudioDrawer({
  isOpen,
  onClose,
  activeTab,
  onTabChange,
  selectedItem,
  preWindowSeconds,
  postWindowSeconds,
  onNotice,
  onExportSession,
  hasTimelineSelection,
  onSelectDefectWindowForExport,
  isExporting,
  semanticSteps,
  operations = [],
  mappingResult,
  timelineEvents,
}: StudioDrawerProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopyText = useCallback((key: string, label: string, text?: string | null) => {
    if (!text || text === '未采集') return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      onNotice?.(`已复制 ${label}`);
      setTimeout(() => setCopiedKey(null), 1800);
    }).catch(() => {
      onNotice?.(`复制 ${label} 失败`);
    });
  }, [onNotice]);

  const handleCopySteps = useCallback(() => {
    if (!selectedItem) return;
    const lines: string[] = [
      `【${selectedItem.type === 'defect' ? '缺陷记录' : '操作记录'}】`,
      `时间: ${formatDateTime(selectedItem.event.occurredAtMs)}`,
      `事件: ${selectedItem.event.message || selectedItem.event.title || selectedItem.event.action || '未命名'}`,
    ];
    if (selectedItem.event.windowTitle) {
      lines.push(`窗口: ${selectedItem.event.windowTitle}`);
    }
    const text = lines.join('\n');
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedKey('defect_all');
      onNotice?.('已复制详情文本');
      setTimeout(() => setCopiedKey(null), 1800);
    });
  }, [onNotice, selectedItem]);

  const matchedStep = semanticSteps.find((s) => {
    if (!selectedItem) return false;
    return s.stepId === selectedItem.event.eventId
      || (Array.isArray(s.sourceEventIds) && s.sourceEventIds.includes(selectedItem.event.eventId));
  });

  const controlName = matchedStep?.controlName || matchedStep?.control_name || '未采集';
  const controlType = matchedStep?.controlType || matchedStep?.control_type || '';
  const frameworkId = matchedStep?.processName || matchedStep?.process_name || '';
  const processName = matchedStep?.processName || matchedStep?.process_name || selectedItem?.event.processName || '未采集';
  const automationId = matchedStep?.automationId || matchedStep?.automation_id || '未采集';
  const className = matchedStep?.className || matchedStep?.class_name || '未采集';
  const windowTitle = matchedStep?.windowTitle || matchedStep?.window_title || selectedItem?.event.windowTitle || '';

  const rect = matchedStep?.boundingRect || matchedStep?.controlRect || matchedStep?.bounding_rect;
  const boundingRectDisplay = rect ? `[${rect.left}, ${rect.top}, ${rect.width}, ${rect.height}]` : '未采集';
  const coordDisplay = typeof matchedStep?.x === 'number' && typeof matchedStep?.y === 'number'
    ? `(${matchedStep.x}, ${matchedStep.y})`
    : '未采集';

  if (!isOpen) return null;

  return (
    <aside className={styles.drawer} data-ui-scope="workbench" aria-label="时间轴详情抽屉">
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <h3 className={styles.title}>详情检视</h3>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="关闭抽屉"
            title="关闭抽屉"
          >
            ✕
          </button>
        </div>

        <div className={styles.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'defect'}
            className={clsx(styles.tabBtn, activeTab === 'defect' && styles.tabBtnActive)}
            onClick={() => onTabChange('defect')}
          >
            🚩 缺陷与事件
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'control'}
            className={clsx(styles.tabBtn, activeTab === 'control' && styles.tabBtnActive)}
            onClick={() => onTabChange('control')}
          >
            🔘 控件属性
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'steps'}
            className={clsx(styles.tabBtn, activeTab === 'steps' && styles.tabBtnActive)}
            onClick={() => onTabChange('steps')}
          >
            📑 步骤列表
          </button>
        </div>
      </div>

      <div className={styles.body}>
        {activeTab === 'defect' ? (
          <StudioDrawerDefectTab
            selectedItem={selectedItem}
            copiedKey={copiedKey}
            onCopyText={handleCopyText}
            onCopySteps={handleCopySteps}
            formatDateTime={formatDateTime}
            preWindowSeconds={preWindowSeconds}
            postWindowSeconds={postWindowSeconds}
            windowTitle={windowTitle}
            onSelectDefectWindowForExport={onSelectDefectWindowForExport}
            onExportSession={onExportSession}
            isExporting={isExporting}
            hasTimelineSelection={hasTimelineSelection}
          />
        ) : null}

        {activeTab === 'control' ? (
          <StudioDrawerControlTab
            selectedItem={selectedItem}
            copiedKey={copiedKey}
            onCopyText={handleCopyText}
            controlName={controlName}
            controlType={controlType}
            frameworkId={frameworkId}
            processName={processName}
            automationId={automationId}
            className={className}
            boundingRectDisplay={boundingRectDisplay}
            coordinateDisplay={coordDisplay}
            windowTitle={windowTitle}
            coordinateMappingResult={mappingResult}
          />
        ) : null}

        {activeTab === 'steps' ? (
          <StudioDrawerStepsTab
            semanticSteps={semanticSteps}
            operations={operations}
            timelineEvents={timelineEvents}
            copiedKey={copiedKey}
            onCopyText={handleCopyText}
            formatDateTime={formatDateTime}
            isUserOperationEvent={isUserOperationEvent}
            getActionKindMeta={getActionKindMeta}
            getOutcomeChip={getOutcomeChip}
            getPrecisionBadge={getPrecisionBadge}
          />
        ) : null}
      </div>
    </aside>
  );
}
