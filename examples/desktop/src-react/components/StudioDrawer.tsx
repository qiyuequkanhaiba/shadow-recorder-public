import { useCallback } from 'react';

import type {
  TestSessionTimelineEvent,
} from '../../types/contracts';
import type {
  TestSessionOperationRecord,
} from '../../types/operation-contracts';

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
  isExporting?: boolean;
  semanticSteps: SemanticStepRow[];
  operations?: TestSessionOperationRecord[];
  mappingResult?: CoordinateMappingResult | null;
  timelineEvents: TestSessionTimelineEvent[];
};

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

function isUserOperationEvent(event: TestSessionTimelineEvent): boolean {
  if (event.logCategory === 'operation' || event.eventType === 'step_captured') {
    return true;
  }
  const type = event.eventType.toLowerCase();
  return type.startsWith('mouse_') || type.startsWith('key_') || type.includes('click') || type.includes('input');
}

export function StudioDrawer(props: StudioDrawerProps) {
  const {
    isOpen,
    onClose,
    activeTab,
    onTabChange,
    selectedItem,
    preWindowSeconds,
    postWindowSeconds,
    onNotice,
    onExportSession,
    isExporting = false,
    semanticSteps,
    operations = [],
    mappingResult,
    timelineEvents,
  } = props;

  // Copy details helper
  const handleCopySteps = useCallback(() => {
    if (!selectedItem) {
      return;
    }
    const ev = selectedItem.event;
    const textLines = [
      `事件: ${ev.title || ev.action || ev.message || ev.eventType}`,
      `时间: ${formatDateTime(ev.occurredAtMs)}`,
      `进程: ${ev.processName || '未采集'}`,
      `窗口: ${ev.windowTitle || '未采集'}`,
    ];
    void navigator.clipboard.writeText(textLines.join('\n')).then(() => {
      onNotice?.('已复制事件信息到剪贴板');
    });
  }, [onNotice, selectedItem]);

  // Find matching step strictly by sourceEventIds or stepId (never guess by timestamp)
  const matchingStep = selectedItem ? semanticSteps.find((s) => {
    const evId = selectedItem.event.eventId;
    const evStepId = selectedItem.event.stepId;
    if (s.sourceEventIds && Array.isArray(s.sourceEventIds) && s.sourceEventIds.includes(evId)) {
      return true;
    }
    if (s.source_event_ids && Array.isArray(s.source_event_ids) && s.source_event_ids.includes(evId)) {
      return true;
    }
    if (evStepId && (s.stepId === evStepId || s.stepId === (selectedItem.event as any).id)) {
      return true;
    }
    return false;
  }) : null;

  // Find matching operation strictly by sourceEventIds
  const matchingOperation = selectedItem ? operations.find((op) => {
    const evId = selectedItem.event.eventId;
    const sourceIds = op.action?.sourceEventIds;
    if (Array.isArray(sourceIds) && sourceIds.includes(evId)) {
      return true;
    }
    return false;
  }) : null;

  // Resolved fields for the Control tab:
  // 1. Name: only genuine controlName from step or operation target
  const controlName = matchingStep?.controlName
    || matchingStep?.control_name
    || matchingOperation?.action?.target?.name
    || '未采集';

  // 2. AutomationId: from step or operation target
  const automationId = matchingStep?.automationId
    || matchingStep?.automation_id
    || matchingOperation?.action?.target?.automationId
    || '未采集';

  // 3. ClassName: from step or operation target
  const className = matchingStep?.className
    || matchingStep?.class_name
    || matchingOperation?.action?.target?.className
    || '未采集';

  // 4. BoundingRectangle: only genuine element.boundingRect (DO NOT use window boundary)
  const explicitControlRect = matchingOperation?.action?.target?.boundingRect
    || matchingOperation?.action?.stateBefore?.element?.boundingRect
    || matchingStep?.boundingRect
    || matchingStep?.controlRect
    || matchingStep?.bounding_rect;

  const boundingRectDisplay = explicitControlRect && typeof explicitControlRect.left === 'number' && typeof explicitControlRect.top === 'number'
    ? `[${explicitControlRect.left}, ${explicitControlRect.top}, ${explicitControlRect.width ?? 0}×${explicitControlRect.height ?? 0}]`
    : '未采集';

  // 5. Point coordinates: prioritize physical, fallback to logical
  const physicalCoord = (matchingStep?.x !== undefined && typeof matchingStep.x === 'number' && matchingStep?.y !== undefined && typeof matchingStep.y === 'number')
    ? { x: matchingStep.x, y: matchingStep.y }
    : (matchingOperation?.action?.coordinate?.x !== undefined && typeof matchingOperation.action.coordinate.x === 'number' && matchingOperation?.action?.coordinate?.y !== undefined && typeof matchingOperation.action.coordinate.y === 'number')
      ? { x: matchingOperation.action.coordinate.x, y: matchingOperation.action.coordinate.y }
      : (selectedItem?.event.x !== undefined && typeof selectedItem.event.x === 'number' && selectedItem?.event.y !== undefined && typeof selectedItem.event.y === 'number')
        ? { x: selectedItem.event.x, y: selectedItem.event.y }
        : null;

  const logicalCoord = (matchingStep?.logicalX !== undefined && typeof matchingStep.logicalX === 'number' && matchingStep?.logicalY !== undefined && typeof matchingStep.logicalY === 'number')
    ? { x: matchingStep.logicalX, y: matchingStep.logicalY }
    : (selectedItem?.event.logicalX !== undefined && typeof selectedItem.event.logicalX === 'number' && selectedItem?.event.logicalY !== undefined && typeof selectedItem.event.logicalY === 'number')
      ? { x: selectedItem.event.logicalX, y: selectedItem.event.logicalY }
      : null;

  const pointCoord = physicalCoord || logicalCoord;

  const pointCoordDisplay = physicalCoord
    ? `[${physicalCoord.x}, ${physicalCoord.y}]`
    : logicalCoord
      ? `[${logicalCoord.x}, ${logicalCoord.y}] (逻辑)`
      : '未采集';

  // 6. Process
  const processName = matchingStep?.processName
    || matchingStep?.process_name
    || selectedItem?.event.processName
    || '未采集';

  return (
    <aside
      className={`studio-event-drawer${isOpen ? ' is-open' : ''}`}
      aria-label="事件与缺陷详情"
    >
      <div className="drawer-header">
        <div className="drawer-tabs">
          <button
            type="button"
            className={`drawer-tab-btn${activeTab === 'defect' ? ' is-active' : ''}`}
            onClick={() => onTabChange('defect')}
          >
            🚩 缺陷
          </button>
          <button
            type="button"
            className={`drawer-tab-btn${activeTab === 'control' ? ' is-active' : ''}`}
            onClick={() => onTabChange('control')}
          >
            🎯 控件
          </button>
          <button
            type="button"
            className={`drawer-tab-btn${activeTab === 'steps' ? ' is-active' : ''}`}
            onClick={() => onTabChange('steps')}
          >
            📑 步骤
          </button>
        </div>
        <button
          type="button"
          className="drawer-close-btn"
          onClick={onClose}
          aria-label="关闭抽屉"
          title="关闭抽屉"
        >
          ✕
        </button>
      </div>

      <div className="drawer-body">
        {/* Tab 1: 缺陷 (Defect) */}
        {activeTab === 'defect' ? (
          <div className="drawer-tab-content drawer-defect-content">
            {selectedItem ? (
              <>
                <div className="drawer-field-group">
                  <span className="drawer-field-kicker">事件原文</span>
                  <p className="drawer-field-value drawer-raw-text">
                    {selectedItem.event.message
                      || selectedItem.event.title
                      || selectedItem.event.action
                      || '未采集原文'}
                  </p>
                </div>

                <div className="drawer-field-group">
                  <span className="drawer-field-kicker">发生时间</span>
                  <span className="drawer-field-value">
                    {formatDateTime(selectedItem.event.occurredAtMs)}
                  </span>
                </div>

                <div className="drawer-field-group">
                  <span className="drawer-field-kicker">缺陷前后窗口</span>
                  <span className="drawer-field-value">
                    前置 {preWindowSeconds ?? 10} 秒 · 后置 {postWindowSeconds ?? 10} 秒
                  </span>
                </div>

                <div className="drawer-actions-row">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={handleCopySteps}
                  >
                    复制信息
                  </button>
                  {onExportSession ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={isExporting}
                      onClick={() => { void onExportSession(); }}
                    >
                      {isExporting ? '导出中…' : '导出当前会话'}
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="drawer-empty-state">
                在时间轴上选择一次操作或一个缺陷窗
              </div>
            )}
          </div>
        ) : null}

        {/* Tab 2: 控件 (Control) */}
        {activeTab === 'control' ? (
          <div className="drawer-tab-content drawer-control-content">
            {selectedItem ? (
              <div className="drawer-control-grid">
                <div className="drawer-control-row">
                  <span className="drawer-field-kicker">名称</span>
                  <span className="drawer-field-value">{controlName}</span>
                </div>

                <div className="drawer-control-row">
                  <span className="drawer-field-kicker">AutomationId</span>
                  <span className="drawer-field-value">{automationId}</span>
                </div>

                <div className="drawer-control-row">
                  <span className="drawer-field-kicker">类名</span>
                  <span className="drawer-field-value">{className}</span>
                </div>

                <div className="drawer-control-row">
                  <span className="drawer-field-kicker">边界矩形</span>
                  <span className="drawer-field-value">{boundingRectDisplay}</span>
                </div>

                <div className="drawer-control-row">
                  <span className="drawer-field-kicker">点击坐标</span>
                  <span className="drawer-field-value">{pointCoordDisplay}</span>
                </div>

                <div className="drawer-control-row">
                  <span className="drawer-field-kicker">画面映射</span>
                  <div className="drawer-field-value">
                    {mappingResult?.success ? (
                      <span className="drawer-mapping-badge is-mapped">
                        {mappingResult.overlay?.type === 'rect' ? '🔲 已在画面标出矩形' : '🎯 已在画面标出点击点'}
                      </span>
                    ) : (explicitControlRect || pointCoord) ? (
                      <div className="drawer-mapping-fail-block">
                        <span className="drawer-mapping-badge is-unmapped" title={mappingResult?.reason}>
                          无法映射到当前画面
                        </span>
                        {mappingResult?.reason ? (
                          <div className="drawer-mapping-reason">{mappingResult.reason}</div>
                        ) : null}
                      </div>
                    ) : (
                      <span className="drawer-field-value-muted">未采集坐标</span>
                    )}
                  </div>
                </div>

                <div className="drawer-control-row">
                  <span className="drawer-field-kicker">进程</span>
                  <span className="drawer-field-value">{processName}</span>
                </div>
              </div>
            ) : (
              <div className="drawer-empty-state">
                在时间轴上选择一次操作或一个缺陷窗
              </div>
            )}
          </div>
        ) : null}

        {/* Tab 3: 步骤 (Steps) */}
        {activeTab === 'steps' ? (
          <div className="drawer-tab-content drawer-steps-content">
            {semanticSteps.length > 0 ? (
              <div className="drawer-steps-list">
                {semanticSteps.map((step, idx) => (
                  <div key={step.stepId || idx} className="drawer-step-item">
                    <span className="drawer-step-idx">{idx + 1}</span>
                    <div className="drawer-step-copy">
                      <strong className="drawer-step-title">{step.title}</strong>
                      <small className="drawer-step-time">{formatDateTime(step.startedAtMs)}</small>
                    </div>
                  </div>
                ))}
              </div>
            ) : timelineEvents.filter(isUserOperationEvent).length > 0 ? (
              <div className="drawer-steps-list">
                {timelineEvents.filter(isUserOperationEvent).map((event, idx) => (
                  <div key={event.eventId || idx} className="drawer-step-item">
                    <span className="drawer-step-idx">{idx + 1}</span>
                    <div className="drawer-step-copy">
                      <strong className="drawer-step-title">
                        {event.action || event.title || '用户操作'}
                      </strong>
                      <small className="drawer-step-time">{formatDateTime(event.occurredAtMs)}</small>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="drawer-empty-state">
                当前会话暂无步骤记录
              </div>
            )}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
