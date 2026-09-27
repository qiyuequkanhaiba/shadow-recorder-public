import { useCallback, useState } from 'react';

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

  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopyText = useCallback((key: string, label: string, val?: string) => {
    if (!val || val === '未采集' || val === '--') {
      return;
    }
    void navigator.clipboard.writeText(val).then(() => {
      setCopiedKey(key);
      onNotice?.(`已复制 ${label}: ${val}`);
      setTimeout(() => {
        setCopiedKey((curr) => (curr === key ? null : curr));
      }, 1500);
    });
  }, [onNotice]);

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
      setCopiedKey('defect_all');
      onNotice?.('已复制事件信息到剪贴板');
      setTimeout(() => {
        setCopiedKey((curr) => (curr === 'defect_all' ? null : curr));
      }, 1500);
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

  // 4. Control type & Framework
  const controlType = matchingStep?.controlType
    || matchingStep?.control_type
    || matchingOperation?.action?.target?.controlType
    || matchingOperation?.action?.target?.localizedControlType
    || null;

  const frameworkId = matchingOperation?.action?.target?.frameworkId || null;
  const rawRuntimeId = matchingOperation?.action?.target?.runtimeId;
  const runtimeIdDisplay = Array.isArray(rawRuntimeId)
    ? `[${rawRuntimeId.join(', ')}]`
    : typeof rawRuntimeId === 'string'
      ? rawRuntimeId
      : typeof rawRuntimeId === 'number'
        ? String(rawRuntimeId)
        : null;

  // 5. BoundingRectangle: only genuine element.boundingRect (DO NOT use window boundary)
  const explicitControlRect = matchingOperation?.action?.target?.boundingRect
    || matchingOperation?.action?.stateBefore?.element?.boundingRect
    || matchingStep?.boundingRect
    || matchingStep?.controlRect
    || matchingStep?.bounding_rect;

  const boundingRectDisplay = explicitControlRect && typeof explicitControlRect.left === 'number' && typeof explicitControlRect.top === 'number'
    ? `[${explicitControlRect.left}, ${explicitControlRect.top}, ${explicitControlRect.width ?? 0}×${explicitControlRect.height ?? 0}]`
    : '未采集';

  const rectDimensionLabel = explicitControlRect && typeof explicitControlRect.width === 'number' && typeof explicitControlRect.height === 'number'
    ? `${explicitControlRect.width} × ${explicitControlRect.height} px`
    : null;

  // 6. Point coordinates: prioritize physical, fallback to logical
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

  // 7. Process & Window
  const processName = matchingStep?.processName
    || matchingStep?.process_name
    || selectedItem?.event.processName
    || '未采集';

  const windowTitle = matchingStep?.windowTitle
    || matchingStep?.window_title
    || selectedItem?.event.windowTitle
    || null;

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
                  <div className="drawer-prop-label-row">
                    <span className="drawer-field-kicker">事件原文</span>
                    <button
                      type="button"
                      className="drawer-copy-icon-btn"
                      onClick={() => handleCopyText(
                        'raw_event',
                        '事件原文',
                        selectedItem.event.message || selectedItem.event.title || selectedItem.event.action,
                      )}
                      title="复制事件原文"
                    >
                      {copiedKey === 'raw_event' ? '✓ 已复制' : '复制'}
                    </button>
                  </div>
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
                  <div className="drawer-time-window-pill">
                    ⏱️ 前置 {preWindowSeconds ?? 10} 秒 · 后置 {postWindowSeconds ?? 10} 秒
                  </div>
                </div>

                {windowTitle ? (
                  <div className="drawer-field-group">
                    <span className="drawer-field-kicker">窗口上下文</span>
                    <span className="drawer-field-value drawer-prop-code">
                      {windowTitle}
                    </span>
                  </div>
                ) : null}

                <div className="drawer-actions-row">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={handleCopySteps}
                  >
                    {copiedKey === 'defect_all' ? '✓ 已复制' : '复制信息'}
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
                {/* Control Header Card */}
                <div className="drawer-control-summary-card">
                  <div className="drawer-target-title">
                    {controlName !== '未采集' ? controlName : (selectedItem.event.title || '交互目标')}
                  </div>
                  <div className="drawer-meta-badges">
                    {controlType ? (
                      <span className="drawer-meta-badge" title="控件类型">
                        🔘 {controlType}
                      </span>
                    ) : null}
                    {frameworkId ? (
                      <span className="drawer-meta-badge" title="界面框架">
                        🧩 {frameworkId}
                      </span>
                    ) : null}
                    <span className="drawer-meta-badge" title="所属进程">
                      💻 {processName}
                    </span>
                  </div>
                </div>

                <div className="drawer-control-row">
                  <div className="drawer-prop-label-row">
                    <span className="drawer-field-kicker">名称</span>
                    {controlName !== '未采集' ? (
                      <button
                        type="button"
                        className="drawer-copy-icon-btn"
                        onClick={() => handleCopyText('name', '控件名称', controlName)}
                        title="复制控件名称"
                      >
                        {copiedKey === 'name' ? '✓ 已复制' : '复制'}
                      </button>
                    ) : null}
                  </div>
                  <span className="drawer-field-value">{controlName}</span>
                </div>

                <div className="drawer-control-row">
                  <div className="drawer-prop-label-row">
                    <span className="drawer-field-kicker">AutomationId</span>
                    {automationId !== '未采集' ? (
                      <button
                        type="button"
                        className="drawer-copy-icon-btn"
                        onClick={() => handleCopyText('autoId', 'AutomationId', automationId)}
                        title="复制 AutomationId"
                      >
                        {copiedKey === 'autoId' ? '✓ 已复制' : '复制'}
                      </button>
                    ) : null}
                  </div>
                  <span className={`drawer-field-value${automationId !== '未采集' ? ' drawer-prop-code' : ''}`}>
                    {automationId}
                  </span>
                </div>

                <div className="drawer-control-row">
                  <div className="drawer-prop-label-row">
                    <span className="drawer-field-kicker">类名</span>
                    {className !== '未采集' ? (
                      <button
                        type="button"
                        className="drawer-copy-icon-btn"
                        onClick={() => handleCopyText('class', '类名', className)}
                        title="复制类名"
                      >
                        {copiedKey === 'class' ? '✓ 已复制' : '复制'}
                      </button>
                    ) : null}
                  </div>
                  <span className={`drawer-field-value${className !== '未采集' ? ' drawer-prop-code' : ''}`}>
                    {className}
                  </span>
                </div>

                <div className="drawer-control-row">
                  <div className="drawer-prop-label-row">
                    <span className="drawer-field-kicker">边界矩形</span>
                    {boundingRectDisplay !== '未采集' ? (
                      <button
                        type="button"
                        className="drawer-copy-icon-btn"
                        onClick={() => handleCopyText('rect', '边界矩形', boundingRectDisplay)}
                        title="复制边界矩形"
                      >
                        {copiedKey === 'rect' ? '✓ 已复制' : '复制'}
                      </button>
                    ) : null}
                  </div>
                  <div className="drawer-rect-field-row">
                    <span className={`drawer-field-value${boundingRectDisplay !== '未采集' ? ' drawer-prop-code' : ''}`}>
                      {boundingRectDisplay}
                    </span>
                    {rectDimensionLabel ? (
                      <span className="drawer-dim-badge">{rectDimensionLabel}</span>
                    ) : null}
                  </div>
                </div>

                <div className="drawer-control-row">
                  <div className="drawer-prop-label-row">
                    <span className="drawer-field-kicker">点击坐标</span>
                    {pointCoordDisplay !== '未采集' ? (
                      <button
                        type="button"
                        className="drawer-copy-icon-btn"
                        onClick={() => handleCopyText('coord', '点击坐标', pointCoordDisplay)}
                        title="复制点击坐标"
                      >
                        {copiedKey === 'coord' ? '✓ 已复制' : '复制'}
                      </button>
                    ) : null}
                  </div>
                  <span className={`drawer-field-value${pointCoordDisplay !== '未采集' ? ' drawer-prop-code' : ''}`}>
                    {pointCoordDisplay}
                  </span>
                </div>

                {runtimeIdDisplay ? (
                  <div className="drawer-control-row">
                    <div className="drawer-prop-label-row">
                      <span className="drawer-field-kicker">RuntimeId</span>
                      <button
                        type="button"
                        className="drawer-copy-icon-btn"
                        onClick={() => handleCopyText('runtimeId', 'RuntimeId', runtimeIdDisplay)}
                        title="复制 RuntimeId"
                      >
                        {copiedKey === 'runtimeId' ? '✓ 已复制' : '复制'}
                      </button>
                    </div>
                    <span className="drawer-field-value drawer-prop-code">{runtimeIdDisplay}</span>
                  </div>
                ) : null}

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
                  <div className="drawer-prop-label-row">
                    <span className="drawer-field-kicker">进程</span>
                    {processName !== '未采集' ? (
                      <button
                        type="button"
                        className="drawer-copy-icon-btn"
                        onClick={() => handleCopyText('process', '进程', processName)}
                        title="复制进程"
                      >
                        {copiedKey === 'process' ? '✓ 已复制' : '复制'}
                      </button>
                    ) : null}
                  </div>
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
                {semanticSteps.map((step, idx) => {
                  const matchingOp = operations.find((op) => {
                    if (op.operationId === step.stepId) return true;
                    const sIds = op.action?.sourceEventIds;
                    return Array.isArray(sIds) && Array.isArray(step.sourceEventIds)
                      && sIds.some((id) => step.sourceEventIds?.includes(id));
                  });
                  const actionMeta = getActionKindMeta(matchingOp?.action?.kind || step.stepType);
                  const outcome = matchingOp?.outcome?.status ? getOutcomeChip(matchingOp.outcome.status) : null;
                  const precision = getPrecisionBadge(step.precisionLevel || matchingOp?.precisionLevel);
                  const copyKey = `step_${step.stepId || idx}`;

                  return (
                    <div key={step.stepId || idx} className="drawer-step-item">
                      <span className="drawer-step-idx">{idx + 1}</span>
                      <div className="drawer-step-copy">
                        <div className="drawer-step-top-line">
                          <span className="drawer-step-action-tag">
                            {actionMeta.icon} {actionMeta.label}
                          </span>
                          {outcome ? (
                            <span className={`drawer-step-outcome tone-${outcome.tone}`}>
                              {outcome.label}
                            </span>
                          ) : null}
                          {precision ? (
                            <span className="drawer-step-precision">
                              {precision}
                            </span>
                          ) : null}
                          <button
                            type="button"
                            className="drawer-step-copy-btn"
                            onClick={() => handleCopyText(
                              copyKey,
                              `步骤 ${idx + 1}`,
                              `${step.title}${step.windowTitle ? ` (${step.windowTitle})` : ''}`,
                            )}
                            title="复制步骤描述"
                          >
                            {copiedKey === copyKey ? '✓' : '📋'}
                          </button>
                        </div>
                        <strong className="drawer-step-title">{step.title}</strong>
                        {step.summary && step.summary !== step.title ? (
                          <span className="drawer-step-summary-note">{step.summary}</span>
                        ) : null}
                        <div className="drawer-step-footer-row">
                          <small className="drawer-step-time">{formatDateTime(step.startedAtMs)}</small>
                          {step.windowTitle ? (
                            <small className="drawer-step-target-hint" title={step.windowTitle}>
                              {step.windowTitle}
                            </small>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : timelineEvents.filter(isUserOperationEvent).length > 0 ? (
              <div className="drawer-steps-list">
                {timelineEvents.filter(isUserOperationEvent).map((event, idx) => {
                  const actionMeta = getActionKindMeta(event.action || event.eventType);
                  const copyKey = `ev_${event.eventId || idx}`;
                  return (
                    <div key={event.eventId || idx} className="drawer-step-item">
                      <span className="drawer-step-idx">{idx + 1}</span>
                      <div className="drawer-step-copy">
                        <div className="drawer-step-top-line">
                          <span className="drawer-step-action-tag">
                            {actionMeta.icon} {actionMeta.label}
                          </span>
                          <button
                            type="button"
                            className="drawer-step-copy-btn"
                            onClick={() => handleCopyText(
                              copyKey,
                              `步骤 ${idx + 1}`,
                              event.action || event.title || event.message || '用户操作',
                            )}
                            title="复制步骤描述"
                          >
                            {copiedKey === copyKey ? '✓' : '📋'}
                          </button>
                        </div>
                        <strong className="drawer-step-title">
                          {event.action || event.title || '用户操作'}
                        </strong>
                        <div className="drawer-step-footer-row">
                          <small className="drawer-step-time">{formatDateTime(event.occurredAtMs)}</small>
                          {event.windowTitle ? (
                            <small className="drawer-step-target-hint" title={event.windowTitle}>
                              {event.windowTitle}
                            </small>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
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

