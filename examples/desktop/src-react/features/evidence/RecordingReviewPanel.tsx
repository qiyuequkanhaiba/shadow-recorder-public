import { useCallback, useEffect, useMemo, useState } from 'react';

import type { TestSessionPlaybackFocus, TestSessionState } from '../../../types/contracts';
import type {
  OperationUiStateSnapshot,
  TestSessionOperationRecord,
  TestSessionOperationTailResult,
} from '../../../types/operation-contracts';
import {
  OPERATION_PAGE_LIMIT,
  buildOperationReproText,
  buildOperationReviewModel,
  filterOperationsByWindow,
  formatActionKindLabel,
  formatRelativeOperationTime,
  listManualOutcomeChoices,
  mergeOperationPages,
  normalizeOperationRecord,
  operationStatusPresentation,
  reviewStatusMessage,
  shouldShowConfidenceBadge,
  type OperationReviewStatus,
} from '../../lib/operation-adapter';

type DefectMarkResult = {
  event?: { eventId?: string; sessionId?: string };
  markedAtMs: number;
  windowStartMs: number;
  windowEndMs: number;
  preWindowSeconds: number;
  postWindowSeconds: number;
  note?: string;
  expected?: string;
  actual?: string;
  stepCount: number;
};

type DefectPackResult = {
  packDir: string;
  reproStepsPath: string;
  stepCount: number;
  screenshotCount: number;
  videoSegmentCount: number;
  clipPath?: string;
  clipBuilt?: boolean;
};

export type RecordingReviewPanelProps = {
  session: TestSessionState | null;
  isRecording: boolean;
  enabled?: boolean;
  preWindowSeconds?: number;
  postWindowSeconds?: number;
  onPlaybackFocusChange?: (focus: TestSessionPlaybackFocus | null) => void;
  onError: (message: string) => void;
  toUiErrorMessage: (error: unknown) => string;
  onOpenSettings?: () => void;
  onMetaSaved?: () => void;
  onNotice?: (message: string) => void;
};

function getApi(): any {
  return (window as any).reqcaseShadowRecorder;
}

function asTailResult(value: unknown, sessionId?: string): TestSessionOperationTailResult {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const itemsRaw = Array.isArray(record.items)
    ? record.items
    : Array.isArray(value)
      ? value
      : [];
  const items = itemsRaw.map((item, index) => normalizeOperationRecord(item, sessionId, index));
  return {
    items,
    nextCursor: typeof record.nextCursor === 'string' ? record.nextCursor : undefined,
    reset: record.reset !== false,
    totalCount: typeof record.totalCount === 'number' ? record.totalCount : items.length,
    diagnostics: Array.isArray(record.diagnostics)
      ? (record.diagnostics as TestSessionOperationTailResult['diagnostics'])
      : [],
  };
}

function confidenceLabel(operation: TestSessionOperationRecord): string {
  const level = (operation.precisionLevel ?? 'l0').toUpperCase();
  const overall = operation.outcome?.confidence?.overall ?? operation.action?.confidence?.overall;
  if (typeof overall !== 'number') {
    return level;
  }
  return `${level} · ${Math.round(overall * 100)}%`;
}

function formatJsonish(value: unknown): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getActionKindIcon(kind?: string): string {
  const k = (kind ?? '').toLowerCase();
  if (k.includes('double')) return '👆👆';
  if (k.includes('right')) return '👉';
  if (k.includes('click')) return '👆';
  if (k.includes('type') || k.includes('key')) return '⌨️';
  if (k.includes('scroll')) return '📜';
  if (k.includes('shortcut')) return '⚡';
  if (k.includes('window')) return '🪟';
  return '🎯';
}

function parseStateProperties(snapshot?: OperationUiStateSnapshot | null): Record<string, string> {
  if (!snapshot) return {};
  const entries: Record<string, string> = {};
  if (snapshot.valueText !== undefined && snapshot.valueText !== null && snapshot.valueText !== '') {
    entries['valueText'] = String(snapshot.valueText);
  }
  if (snapshot.selectedNames && snapshot.selectedNames.length > 0) {
    entries['selectedNames'] = snapshot.selectedNames.join(', ');
  }
  if (snapshot.isEnabled !== undefined && snapshot.isEnabled !== null) {
    entries['isEnabled'] = String(snapshot.isEnabled);
  }
  if (snapshot.hasKeyboardFocus !== undefined && snapshot.hasKeyboardFocus !== null) {
    entries['hasKeyboardFocus'] = String(snapshot.hasKeyboardFocus);
  }
  if (snapshot.toggleState !== undefined && snapshot.toggleState !== null) {
    entries['toggleState'] = String(snapshot.toggleState);
  }
  if (snapshot.selectionState !== undefined && snapshot.selectionState !== null) {
    entries['selectionState'] = String(snapshot.selectionState);
  }
  if (snapshot.rangeValue !== undefined && snapshot.rangeValue !== null) {
    entries['rangeValue'] = String(snapshot.rangeValue);
  }
  if (snapshot.isOffscreen !== undefined && snapshot.isOffscreen !== null) {
    entries['isOffscreen'] = String(snapshot.isOffscreen);
  }
  return entries;
}

export function RecordingReviewPanel(props: RecordingReviewPanelProps) {
  const [note, setNote] = useState('');
  const [expected, setExpected] = useState('');
  const [actual, setActual] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [operations, setOperations] = useState<TestSessionOperationRecord[]>([]);
  const [reviewStatus, setReviewStatus] = useState<OperationReviewStatus>('empty');
  const [diagnostics, setDiagnostics] = useState<TestSessionOperationTailResult['diagnostics']>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [totalCount, setTotalCount] = useState(0);
  const [defect, setDefect] = useState<DefectMarkResult | null>(null);
  const [reproText, setReproText] = useState('');
  const [packResult, setPackResult] = useState<DefectPackResult | null>(null);
  const [editingOperationId, setEditingOperationId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [markerCollapsed, setMarkerCollapsed] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);

  const [editingName, setEditingName] = useState('');
  const [editingNotes, setEditingNotes] = useState('');
  const [isEditingMeta, setIsEditingMeta] = useState(false);

  // Modern UI Ergonomic Additions
  const [layoutMode, setLayoutMode] = useState<'split' | 'inline'>('split');
  const [activeInspectorTab, setActiveInspectorTab] = useState<'locators' | 'diff' | 'candidates' | 'evidence'>('locators');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterKind, setFilterKind] = useState<'all' | 'issue' | 'click' | 'input'>('all');
  const [isReproModalOpen, setIsReproModalOpen] = useState(false);
  const [toastFeedback, setToastFeedback] = useState<string | null>(null);
  function notify(message: string): void {
    if (props.onNotice) {
      props.onNotice(message);
      return;
    }
    setToastFeedback(message);
  }

  const sessionId = props.session?.sessionId ?? null;

  useEffect(() => {
    if (!toastFeedback) return;
    const timer = setTimeout(() => {
      setToastFeedback(null);
    }, 2200);
    return () => clearTimeout(timer);
  }, [toastFeedback]);

  const windowedOperations = useMemo(
    () =>
      filterOperationsByWindow(
        operations.filter((operation) => !operation.ignored),
        defect?.windowStartMs,
        defect?.windowEndMs,
      ),
    [defect, operations],
  );

  const visibleOperations = useMemo(() => {
    return windowedOperations.filter((operation) => {
      // 1. Search Query filtering
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const titleMatch = (operation.title || '').toLowerCase().includes(q);
        const aliasMatch = (operation.businessAlias || '').toLowerCase().includes(q);
        const resultMatch = (operation.resultSummary || '').toLowerCase().includes(q);
        const targetNameMatch = (operation.action?.target?.name || '').toLowerCase().includes(q);
        const controlTypeMatch = (operation.action?.target?.controlType || '').toLowerCase().includes(q);
        const previewMatch = (operation.action?.contentPreview || '').toLowerCase().includes(q);
        if (!titleMatch && !aliasMatch && !resultMatch && !targetNameMatch && !controlTypeMatch && !previewMatch) {
          return false;
        }
      }

      // 2. Kind/Status filtering
      if (filterKind === 'issue') {
        const st = operation.outcome?.status;
        return st === 'suspected' || st === 'failed' || st === 'incomplete' || st === 'observerDegraded';
      }
      if (filterKind === 'click') {
        const k = (operation.action?.kind || '').toLowerCase();
        return k.includes('click');
      }
      if (filterKind === 'input') {
        const k = (operation.action?.kind || '').toLowerCase();
        return k.includes('type') || k.includes('key') || k.includes('input');
      }

      return true;
    });
  }, [filterKind, searchQuery, windowedOperations]);

  // Selected Operation for Inspector
  const selectedOperation = useMemo(() => {
    if (selectedOperationId) {
      const found = visibleOperations.find((op) => op.operationId === selectedOperationId);
      if (found) return found;
      const foundInAll = operations.find((op) => op.operationId === selectedOperationId);
      if (foundInAll) return foundInAll;
    }
    return visibleOperations[0] ?? operations[0] ?? null;
  }, [operations, selectedOperationId, visibleOperations]);

  const applyTail = useCallback(
    (tail: TestSessionOperationTailResult, append: boolean) => {
      const model = buildOperationReviewModel(tail, [], sessionId ?? undefined);
      setOperations((previous) =>
        mergeOperationPages(append ? previous : [], model.operations, append ? false : true),
      );
      setReviewStatus(model.status);
      setDiagnostics(model.diagnostics);
      setNextCursor(model.nextCursor);
      setTotalCount(model.totalCount);
    },
    [sessionId],
  );

  const loadOperationsPage = useCallback(
    async (options?: { cursor?: string; append?: boolean; rebuild?: boolean }) => {
      const api = getApi();
      if (!props.enabled) {
        setOperations([]);
        setReviewStatus('empty');
        setDiagnostics([]);
        setNextCursor(undefined);
        setTotalCount(0);
        return;
      }
      if (!sessionId) {
        setOperations([]);
        setReviewStatus('empty');
        return;
      }

      setLoading(true);
      try {
        if (options?.rebuild) {
          if (typeof api?.rebuildTestSessionOperations === 'function') {
            await api.rebuildTestSessionOperations({ sessionId });
          } else if (typeof api?.rebuildTestSessionSteps === 'function') {
            await api.rebuildTestSessionSteps({ sessionId });
          }
        }

        if (typeof api?.getTestSessionOperations === 'function') {
          const raw = await api.getTestSessionOperations({
            sessionId,
            cursor: options?.cursor,
            limit: OPERATION_PAGE_LIMIT,
          });
          applyTail(asTailResult(raw, sessionId), !!options?.append);
          return;
        }

        // Legacy fallback: steps API only.
        if (typeof api?.getTestSessionSteps === 'function') {
          const rows = await api.getTestSessionSteps({ sessionId });
          const list = Array.isArray(rows) ? rows : [];
          const model = buildOperationReviewModel(
            { items: [], nextCursor: undefined, reset: true, totalCount: 0, diagnostics: [] },
            list,
            sessionId,
          );
          setOperations(model.operations);
          setReviewStatus(model.status);
          setDiagnostics(model.diagnostics);
          setNextCursor(undefined);
          setTotalCount(model.totalCount);
          return;
        }

        setReviewStatus('unavailable');
        setOperations([]);
      } catch (error) {
        const message = props.toUiErrorMessage(error);
        if (!/not active|SessionNotFound|no active|not found|disabled/i.test(message)) {
          props.onError(message);
        }
        setReviewStatus('unavailable');
      } finally {
        setLoading(false);
      }
    },
    [applyTail, props, sessionId],
  );

  useEffect(() => {
    void loadOperationsPage({ rebuild: true });
  }, [loadOperationsPage, props.isRecording, sessionId]);

  async function handleMarkDefect(): Promise<void> {
    const api = getApi();
    if (!api?.markTestDefect) {
      props.onError('当前原生模块不支持问题标记，请重新构建 native binding。');
      return;
    }
    setBusy(true);
    setStatus('');
    setPackResult(null);
    try {
      if (!sessionId) {
        props.onError('当前没有可标记的会话。请先开始录制，或在时间线中选中历史会话后再标记。');
        return;
      }
      const result = await api.markTestDefect({
        sessionId,
        note: note.trim() || undefined,
        expected: expected.trim() || undefined,
        actual: actual.trim() || undefined,
        preWindowSeconds: props.preWindowSeconds,
        postWindowSeconds: props.postWindowSeconds,
      });
      const mapped: DefectMarkResult = {
        event: result?.event,
        markedAtMs: Number(result?.markedAtMs ?? Date.now()),
        windowStartMs: Number(result?.windowStartMs ?? 0),
        windowEndMs: Number(result?.windowEndMs ?? 0),
        preWindowSeconds: Number(result?.preWindowSeconds ?? 60),
        postWindowSeconds: Number(result?.postWindowSeconds ?? 20),
        note: result?.note,
        expected: result?.expected,
        actual: result?.actual,
        stepCount: Number(result?.stepCount ?? 0),
      };
      setDefect(mapped);
      await loadOperationsPage({ rebuild: true });
      const windowOps = filterOperationsByWindow(operations, mapped.windowStartMs, mapped.windowEndMs);
      const localRepro = buildOperationReproText({
        sessionId,
        operations: windowOps.length > 0 ? windowOps : operations,
        defectNote: note.trim() || actual.trim() || undefined,
        windowStartMs: mapped.windowStartMs,
        windowEndMs: mapped.windowEndMs,
        markedAtMs: mapped.markedAtMs,
      });
      if (api.renderTestSessionReproSteps) {
        try {
          const text = await api.renderTestSessionReproSteps({
            sessionId: sessionId ?? undefined,
            windowStartMs: mapped.windowStartMs,
            windowEndMs: mapped.windowEndMs,
            defectNote: note.trim() || actual.trim() || undefined,
          });
          setReproText(String(text ?? localRepro));
        } catch {
          setReproText(localRepro);
        }
      } else {
        setReproText(localRepro);
      }
      setStatus(
        `已添加问题标记：前后 ${mapped.preWindowSeconds}s/${mapped.postWindowSeconds}s，窗内操作 ${mapped.stepCount} 条。`,
      );
      notify('问题标记已保存并锁定时间窗');
    } catch (error) {
      const message = props.toUiErrorMessage(error);
      if (/not active/i.test(message)) {
        props.onError(
          '当前没有进行中的录制会话。请在录制过程中标记，或选中已结束的会话后重试（已支持对历史会话标记）。',
        );
      } else {
        props.onError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRebuild(): Promise<void> {
    setBusy(true);
    try {
      await loadOperationsPage({ rebuild: true });
      setStatus('已重新生成操作记录。');
      notify('已重新感知并生成操作与结果序列');
    } catch (error) {
      props.onError(props.toUiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyRepro(): Promise<void> {
    const api = getApi();
    try {
      let text = reproText;
      const local = buildOperationReproText({
        sessionId,
        operations: visibleOperations,
        defectNote: note.trim() || actual.trim() || undefined,
        windowStartMs: defect?.windowStartMs,
        windowEndMs: defect?.windowEndMs,
        markedAtMs: defect?.markedAtMs,
      });
      if (!text && api?.renderTestSessionReproSteps) {
        try {
          text = String(
            (await api.renderTestSessionReproSteps({
              sessionId: sessionId ?? undefined,
              windowStartMs: defect?.windowStartMs,
              windowEndMs: defect?.windowEndMs,
              defectNote: note.trim() || actual.trim() || undefined,
            })) ?? '',
          );
        } catch {
          text = '';
        }
      }
      if (!text) {
        text = local;
      }
      setReproText(text);
      await navigator.clipboard.writeText(text);
      setStatus('操作结果文本已复制到剪贴板。');
      notify('操作结果文本已复制到剪贴板');
    } catch (error) {
      props.onError(props.toUiErrorMessage(error));
    }
  }

  async function handleExportPack(): Promise<void> {
    const api = getApi();
    if (!api?.exportTestDefectPack) {
      props.onError('当前原生模块不支持导出记录包。');
      return;
    }
    setBusy(true);
    try {
      const result = await api.exportTestDefectPack({
        sessionId: sessionId ?? undefined,
        markedAtMs: defect?.markedAtMs,
        preWindowSeconds: defect?.preWindowSeconds,
        postWindowSeconds: defect?.postWindowSeconds,
        note: note.trim() || undefined,
        expected: expected.trim() || undefined,
        actual: actual.trim() || undefined,
      });
      const mapped: DefectPackResult = {
        packDir: String(result?.packDir ?? ''),
        reproStepsPath: String(result?.reproStepsPath ?? ''),
        stepCount: Number(result?.stepCount ?? 0),
        screenshotCount: Number(result?.screenshotCount ?? 0),
        videoSegmentCount: Number(result?.videoSegmentCount ?? 0),
        clipPath: result?.clipPath ? String(result.clipPath) : undefined,
        clipBuilt: !!result?.clipBuilt,
      };
      setPackResult(mapped);
      setStatus(
        mapped.clipBuilt
          ? `记录包已导出（含 clip.mp4）：${mapped.packDir}`
          : `记录包已导出：${mapped.packDir}`,
      );
      notify(`记录包已导出至：${mapped.packDir}`);
    } catch (error) {
      const message = props.toUiErrorMessage(error);
      if (!/cancel/i.test(message)) {
        props.onError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  function focusOperation(operation: TestSessionOperationRecord): void {
    setSelectedOperationId(operation.operationId);
    props.onPlaybackFocusChange?.({
      eventId: operation.operationId,
      sessionId: operation.sessionId || sessionId || '',
      occurredAtMs: operation.startedAtMs,
      displayId: operation.action?.coordinate?.displayId ?? undefined,
    });
  }

  function toggleExpanded(operationId: string): void {
    setExpandedIds((current) => ({
      ...current,
      [operationId]: !current[operationId],
    }));
  }

  async function handleSaveEdit(operation: TestSessionOperationRecord): Promise<void> {
    const api = getApi();
    const nextTitle = editingTitle.trim();
    if (!nextTitle) {
      props.onError('操作标题不能为空。');
      return;
    }
    setBusy(true);
    try {
      if (typeof api?.updateTestSessionOperation === 'function') {
        await api.updateTestSessionOperation({
          sessionId: sessionId ?? undefined,
          operationId: operation.operationId,
          title: nextTitle,
        });
      } else if (typeof api?.updateTestSessionStep === 'function') {
        await api.updateTestSessionStep({
          sessionId: sessionId ?? undefined,
          stepId: operation.operationId,
          title: nextTitle,
        });
      } else {
        props.onError('当前原生模块不支持操作编辑。');
        return;
      }
      setEditingOperationId(null);
      await loadOperationsPage({ rebuild: false });
      setStatus('操作标题已更新。');
      notify('操作标题已更新');
    } catch (error) {
      props.onError(props.toUiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectCandidate(
    operation: TestSessionOperationRecord,
    transitionId: string,
  ): Promise<void> {
    const api = getApi();
    if (typeof api?.updateTestSessionOperation !== 'function') {
      props.onError('当前原生模块不支持人工选择结果。');
      return;
    }
    setBusy(true);
    try {
      await api.updateTestSessionOperation({
        sessionId: sessionId ?? undefined,
        operationId: operation.operationId,
        selectedTransitionId: transitionId,
        selectedOutcomeStatus: 'confirmed',
      });
      await loadOperationsPage({ rebuild: false });
      setStatus('已保存人工选择的操作结果。');
      notify('已保存人工选择的操作结果');
    } catch (error) {
      props.onError(props.toUiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleRestoreAuto(operation: TestSessionOperationRecord): Promise<void> {
    const api = getApi();
    if (typeof api?.updateTestSessionOperation !== 'function') {
      props.onError('当前原生模块不支持恢复自动判断。');
      return;
    }
    setBusy(true);
    try {
      await api.updateTestSessionOperation({
        sessionId: sessionId ?? undefined,
        operationId: operation.operationId,
        selectedOutcomeStatus: operation.completionCandidates[0]?.status ?? 'incomplete',
        selectedTransitionId: operation.completionCandidates[0]?.primaryTransitionId ?? undefined,
        note: operation.manualNote ?? undefined,
        reason: 'restore-auto-selection',
      });
      if (typeof api.rebuildTestSessionOperations === 'function') {
        await api.rebuildTestSessionOperations({ sessionId: sessionId ?? undefined });
      }
      await loadOperationsPage({ rebuild: false });
      setStatus('已尝试恢复自动结果判断。');
      notify('已恢复自动智能判断');
    } catch (error) {
      props.onError(props.toUiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function handleAnchorStepToDefect(operation: TestSessionOperationRecord): void {
    const summary = `${operation.businessAlias || operation.title} -> ${operation.resultSummary}`;
    setActual(summary);
    notify('已将选中步骤填入实际表现');
    setMarkerCollapsed(false);
  }

  function copyTextToClipboard(text: string, label: string): void {
    if (!text || text === '—') return;
    navigator.clipboard.writeText(text).then(() => {
      notify(`已复制 ${label}`);
    }).catch(() => {
      notify(`已复制 ${label}`);
    });
  }

  if (!props.session) {
    return (
      <section className="defect-evidence-panel recording-review-panel" aria-label="记录与回顾">
        <header className="defect-evidence-header">
          <div>
            <span className="defect-evidence-kicker">录屏工具</span>
            <h3>记录与回顾</h3>
            <p>开始录制后可按时间线回看操作与可观察结果，并在需要时标记问题。</p>
          </div>
        </header>
        <div className="defect-evidence-idle">
          <strong>等待会话</strong>
          <span>开始录制后，这里会汇总当前会话的操作、结果和可导出的记录文本。</span>
        </div>
      </section>
    );
  }

  const markerDisabled = busy || !props.enabled || !sessionId;
  const windowLabel = defect
    ? `${defect.preWindowSeconds}s 前 / ${defect.postWindowSeconds}s 后`
    : '完整会话';
  const scopeLabel = defect ? '问题时间窗' : '完整会话';
  const markerStateLabel = defect
    ? '已标记'
    : note.trim() || expected.trim() || actual.trim()
      ? '草稿'
      : '未标记';
  const statusBanner = reviewStatusMessage(loading ? 'loading' : reviewStatus);

  // Inspector details props extraction for selected operation
  const selTarget = selectedOperation?.action?.target;
  const selCoord = selectedOperation?.action?.coordinate;
  const selCoordText = selCoord ? `X: ${selCoord.x}, Y: ${selCoord.y}${selCoord.displayId !== undefined && selCoord.displayId !== null ? ` (Display #${selCoord.displayId})` : ''}` : '—';
  const selAutoId = selTarget?.automationId || '—';
  const selRuntimeIdText = selTarget?.runtimeId?.length ? selTarget.runtimeId.join(', ') : '—';
  const selControlName = selTarget?.name || '—';
  const selControlType = [selTarget?.controlType, selTarget?.localizedControlType].filter(Boolean).join(' · ') || '—';
  const selProcessWindow = [
    selTarget?.className,
    selTarget?.frameworkId ? `Framework: ${selTarget.frameworkId}` : null,
    selTarget?.processId ? `PID: ${selTarget.processId}` : null,
  ].filter(Boolean).join(' · ') || '—';
  const selContent = selectedOperation?.action?.contentPreview?.trim() || selectedOperation?.action?.stateBefore?.valueText?.trim() || '—';
  const selStateProps = parseStateProperties(selectedOperation?.action?.stateBefore);
  const selPrimaryTransition = selectedOperation?.transitions.find(t => t.transitionId === selectedOperation?.outcome?.primaryTransitionId);
  const selChoices = selectedOperation ? listManualOutcomeChoices(selectedOperation) : [];

  return (
    <section className={`defect-evidence-panel recording-review-panel layout-${layoutMode}`} aria-label="记录与回顾">
      {/* 1. Header with integrated session info & control room */}
      <header className="defect-evidence-header recording-review-header-v2">
        <div className="recording-review-title-col">
          <div className="recording-review-title-row">
            <span className="defect-evidence-kicker">录屏工具</span>
            <h3>记录与回顾</h3>
            <div className="recording-review-layout-toggles" role="group" aria-label="布局模式切换">
              <button
                type="button"
                className={`btn-layout-mode ${layoutMode === 'split' ? 'is-active' : ''}`}
                onClick={() => setLayoutMode('split')}
                title="分栏检查器模式（右侧独立 Inspector）"
              >
                分栏检查器
              </button>
              <button
                type="button"
                className={`btn-layout-mode ${layoutMode === 'inline' ? 'is-active' : ''}`}
                onClick={() => setLayoutMode('inline')}
                title="流式内联折叠模式"
              >
                流式内联
              </button>
            </div>
          </div>
          <p className="recording-review-subdesc">
            按发生时序聚合操作主句与可观察结果；点击右侧检查器深度查看控件定位与状态变动。
          </p>
        </div>

        <div className="defect-evidence-summary" aria-label="记录概览">
          <span>
            <strong>{visibleOperations.length} / {totalCount || operations.length}</strong>
            <small>当前操作</small>
          </span>
          <span className={defect ? 'is-highlight-defect' : ''}>
            <strong>{defect ? '已标记时间窗' : markerStateLabel}</strong>
            <small>问题状态</small>
          </span>
          <span>
            <strong>{props.enabled ? '已开启' : '未开启'}</strong>
            <small>语义记录</small>
          </span>
        </div>
      </header>

      {/* 2. Integrated Session Meta Block */}
      <div className="recording-review-session-meta">
        <div className="session-meta-display-row">
          <div className="session-meta-text-col">
            <div className="session-meta-title-line">
              <strong className="session-meta-name">
                {props.session?.name || '当前录制会话'}
              </strong>
              <button
                type="button"
                className="btn-edit-session-meta"
                title="编辑会话名称与备注"
                onClick={() => {
                  setEditingName(props.session?.name || '');
                  setEditingNotes(props.session?.notes || '');
                  setIsEditingMeta(!isEditingMeta);
                }}
              >
                {isEditingMeta ? '取消' : '✏️ 编辑'}
              </button>
            </div>
            <p className="session-meta-notes">
              {props.session?.notes ? `备注：${props.session.notes}` : '暂无会话备注'}
              <span className="session-meta-retention">
                · {props.session?.historyRetentionMode === 'age'
                  ? `按 ${props.session?.historyRetentionHours ?? 24} 小时保留`
                  : `滚出切片按最近 ${props.session?.historyRetentionMaxSegments ?? 200} 段保留`}
              </span>
            </p>
          </div>
        </div>

        {isEditingMeta ? (
          <div className="session-meta-edit-form">
            <div className="session-meta-form-grid">
              <label className="settings-field">
                <span className="settings-field-label">会话名称</span>
                <input
                  type="text"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  maxLength={80}
                  placeholder="例如：结算中心支付结算异常复现"
                />
              </label>
              <label className="settings-field">
                <span className="settings-field-label">会话备注 / 复查要点</span>
                <textarea
                  value={editingNotes}
                  onChange={(e) => setEditingNotes(e.target.value)}
                  maxLength={2000}
                  rows={2}
                  placeholder="记录该会话的重点测试范围或异常背景"
                />
              </label>
            </div>
            <div className="session-meta-form-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={async () => {
                  const api = window.reqcaseShadowRecorder;
                  if (api?.updateTestSessionMeta) {
                    const name = editingName.trim();
                    if (!name || name.match(/[\\/:\n]/)) {
                      props.onError('名称无效，请避免斜杠或换行');
                      return;
                    }
                    setBusy(true);
                    try {
                      const res = await api.updateTestSessionMeta({
                        sessionId: props.session!.sessionId,
                        name,
                        notes: editingNotes,
                      });
                      if (res && res.error) {
                        props.onError(res.error);
                      } else {
                        setIsEditingMeta(false);
                        props.onMetaSaved?.();
                        notify('会话信息已保存');
                      }
                    } catch (err) {
                      props.onError(String(err));
                    } finally {
                      setBusy(false);
                    }
                  }
                }}
              >
                保存信息
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => setIsEditingMeta(false)}
              >
                取消
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* 3. Semantic Disabled Notification */}
      {!props.enabled ? (
        <div className="defect-evidence-disabled" role="status">
          <div>
            <strong>语义记录未开启</strong>
            <span>开启后会补充控件识别、操作结果关联和语义步骤，便于回看录屏过程。</span>
          </div>
          {props.onOpenSettings ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={props.onOpenSettings}>
              打开设置
            </button>
          ) : null}
        </div>
      ) : null}

      {/* 4. Diagnostics & Status Banner */}
      {statusBanner ? (
        <div className={`recording-review-banner is-${loading ? 'loading' : reviewStatus}`} role="status">
          {statusBanner}
          {diagnostics && diagnostics.length > 0 ? (
            <span className="recording-review-banner-meta">
              {diagnostics.map((item) => item.code).join(' · ')}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* 5. Defect Window Scope Notification Banner */}
      {defect ? (
        <div className="defect-scope-banner" role="status">
          <div className="banner-left">
            <span className="banner-dot" aria-hidden="true" />
            <strong>已锁定问题时间窗：</strong>
            <span>发生点前 {defect.preWindowSeconds}s / 后 {defect.postWindowSeconds}s · 关联窗内操作 {defect.stepCount} 条</span>
          </div>
          <div className="banner-actions">
            <button
              type="button"
              className="banner-link-btn"
              onClick={() => {
                setMarkerCollapsed(false);
              }}
            >
              修改标记参数
            </button>
            <button
              type="button"
              className="banner-link-btn banner-clear-btn"
              onClick={() => {
                setDefect(null);
                notify('已切回完整会话视角');
              }}
            >
              清除时间窗筛选
            </button>
          </div>
        </div>
      ) : null}

      {/* 6. Filter & Action Toolbar */}
      <section className="recording-review-toolbar" aria-label="操作与筛选工具条">
        <div className="toolbar-left-group">
          <div className="search-box-wrap">
            <span className="search-icon" aria-hidden="true">🔍</span>
            <input
              type="text"
              className="search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索步骤/控件/内容..."
              aria-label="搜索步骤"
            />
            {searchQuery ? (
              <button
                type="button"
                className="search-clear-btn"
                onClick={() => setSearchQuery('')}
                aria-label="清空搜索"
              >
                ✕
              </button>
            ) : null}
          </div>

          <div className="filter-pill-tabs" role="tablist" aria-label="步骤分类筛选">
            <button
              type="button"
              role="tab"
              aria-selected={filterKind === 'all'}
              className={`filter-pill-tab ${filterKind === 'all' ? 'is-active' : ''}`}
              onClick={() => setFilterKind('all')}
            >
              全部 ({windowedOperations.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filterKind === 'issue'}
              className={`filter-pill-tab is-issue ${filterKind === 'issue' ? 'is-active' : ''}`}
              onClick={() => setFilterKind('issue')}
            >
              仅异常/可疑
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filterKind === 'click'}
              className={`filter-pill-tab ${filterKind === 'click' ? 'is-active' : ''}`}
              onClick={() => setFilterKind('click')}
            >
              单击
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filterKind === 'input'}
              className={`filter-pill-tab ${filterKind === 'input' ? 'is-active' : ''}`}
              onClick={() => setFilterKind('input')}
            >
              输入/键盘
            </button>
          </div>
        </div>

        <div className="toolbar-right-group">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || !sessionId}
            onClick={() => void handleRebuild()}
            title="重新感知并关联 UI 迁移与操作"
          >
            🔄 重新生成
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || visibleOperations.length === 0}
            onClick={() => setIsReproModalOpen(true)}
            title="查看并复制操作复现 Markdown 步骤"
          >
            📋 复制步骤
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={markerDisabled}
            onClick={() => void handleExportPack()}
            title="导出包含视频、截图与步骤的记录包"
          >
            📦 导出记录包
          </button>
          <button
            type="button"
            className={`btn btn-ghost btn-sm btn-marker-toggle ${!markerCollapsed ? 'is-opened' : ''}`}
            onClick={() => setMarkerCollapsed((cur) => !cur)}
            title="展开或收起问题标记工作面板"
          >
            ⚠️ 问题标记 {markerCollapsed ? '▼' : '▲'}
          </button>
        </div>
      </section>

      {/* 7. Main Split / Stream Layout */}
      <div className={`defect-evidence-layout layout-${layoutMode} ${markerCollapsed ? 'is-marker-collapsed' : ''}`}>
        
        {/* Timeline Stream (Center / Main) */}
        <section className="defect-evidence-steps recording-review-timeline" aria-label="语义步骤时间线">
          <div className="defect-evidence-section-title">
            <div>
              <h4>语义步骤时间线</h4>
              <p>{defect ? '已按问题标记时间窗筛选' : '按录制发生时间顺序排列'}</p>
            </div>
            <span className="scope-indicator-tag">
              {scopeLabel} · {visibleOperations.length}/{totalCount || operations.length}
            </span>
          </div>

          {visibleOperations.length === 0 ? (
            <div className="defect-evidence-empty-box">
              <span className="empty-icon">📑</span>
              <strong>{loading ? '正在加载操作记录…' : '暂无符合条件的操作记录'}</strong>
              <p>{loading ? '请稍候，正在获取会话事件…' : '开始录制并完成操作后可重新生成，或调整筛选条件。'}</p>
              {!loading && (searchQuery || filterKind !== 'all') ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setSearchQuery('');
                    setFilterKind('all');
                  }}
                >
                  重置筛选条件
                </button>
              ) : null}
            </div>
          ) : (
            <ol className="defect-step-timeline recording-op-timeline">
              {visibleOperations.map((operation, index) => {
                const presentation = operationStatusPresentation(operation.outcome?.status);
                const expanded = !!expandedIds[operation.operationId];
                const isSelected = (selectedOperation?.operationId === operation.operationId);
                const showConfidence = shouldShowConfidenceBadge(operation);
                const contentPreview =
                  operation.action?.contentPreview?.trim() ||
                  operation.action?.stateBefore?.valueText?.trim() ||
                  (operation.action?.stateBefore?.selectedNames || []).filter(Boolean).join('、') ||
                  '';
                const contextBits = [
                  operation.action?.target?.controlType ?? operation.action?.target?.localizedControlType,
                  typeof operation.outcome?.latencyMs === 'number'
                    ? `${operation.outcome.latencyMs}ms`
                    : null,
                  operation.outcomeSelectionSource === 'manual' ? '人工选择' : null,
                ].filter(Boolean);
                const choices = listManualOutcomeChoices(operation);
                const opKindIcon = getActionKindIcon(operation.action?.kind);

                return (
                  <li
                    className={`defect-step-timeline-item recording-op-item status-${presentation.tone} ${isSelected ? 'is-selected' : ''}`}
                    key={operation.operationId || `${operation.startedAtMs}-${index}`}
                    onClick={() => focusOperation(operation)}
                  >
                    <div className="recording-op-meta-col">
                      <span className="recording-op-index" aria-label={`序号 ${index + 1}`}>
                        #{index + 1}
                      </span>
                      <span className="recording-op-kind" title={operation.action?.kind}>
                        <span className="kind-icon" aria-hidden="true">{opKindIcon}</span>
                        <span>{formatActionKindLabel(operation.action?.kind)}</span>
                      </span>
                    </div>

                    <span className="defect-step-rail" aria-hidden="true">
                      <span className={`recording-op-dot is-${presentation.tone}`} />
                    </span>

                    <article className="recording-op-node">
                      <header className="recording-op-node-header">
                        <time className="recording-op-time">
                          {formatRelativeOperationTime(operation.relativeMsFromSessionStart)}
                        </time>
                        <span
                          className={`recording-op-status is-${presentation.tone}`}
                          title={presentation.label}
                        >
                          {presentation.shortLabel}
                        </span>
                      </header>

                      {editingOperationId === operation.operationId ? (
                        <div className="defect-step-edit" onClick={(e) => e.stopPropagation()}>
                          <input
                            aria-label="操作标题"
                            value={editingTitle}
                            onChange={(event) => setEditingTitle(event.target.value)}
                            disabled={busy}
                          />
                          <div className="defect-step-edit-actions">
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={busy}
                              onClick={() => void handleSaveEdit(operation)}
                            >
                              保存
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={busy}
                              onClick={() => setEditingOperationId(null)}
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="recording-op-main"
                            onClick={(e) => {
                              e.stopPropagation();
                              focusOperation(operation);
                            }}
                          >
                            <div className="recording-op-title-row">
                              <strong className="recording-op-title">{operation.businessAlias || operation.title}</strong>
                              {operation.businessAlias ? (
                                <span className="recording-op-alias-tag">业务别名</span>
                              ) : null}
                            </div>

                            {contentPreview ? (
                              <span className="recording-op-content" title="操作内容">
                                内容「{contentPreview}」
                              </span>
                            ) : null}

                            <span className="recording-op-result">
                              <span className="recording-op-arrow" aria-hidden="true">→</span>
                              <span>{operation.resultSummary}</span>
                            </span>

                            {contextBits.length > 0 || showConfidence ? (
                              <div className="recording-op-footer-chips">
                                {contextBits.length > 0 ? (
                                  <span className="recording-op-context">{contextBits.join(' · ')}</span>
                                ) : null}
                                {showConfidence ? (
                                  <span className="recording-op-confidence">{confidenceLabel(operation)}</span>
                                ) : null}
                              </div>
                            ) : null}
                          </button>

                          <div className="recording-op-actions" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="btn btn-ghost btn-xs btn-op-action"
                              title="视频回放定位到此步骤"
                              onClick={() => focusOperation(operation)}
                            >
                              ▶ 回放
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-xs btn-op-action"
                              title="将此步骤作为实际表现锚点"
                              onClick={() => handleAnchorStepToDefect(operation)}
                            >
                              📍 锚定
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-xs btn-op-action"
                              disabled={busy}
                              onClick={() => {
                                setEditingOperationId(operation.operationId);
                                setEditingTitle(operation.title);
                              }}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-xs btn-op-action"
                              aria-expanded={expanded}
                              aria-controls={`recording-op-details-${operation.operationId}`}
                              onClick={() => toggleExpanded(operation.operationId)}
                            >
                              {expanded ? '收起详情' : '技术详情'}
                            </button>
                          </div>
                        </>
                      )}

                      {/* Technical Details (Accordion slot for inline view or expanded item) */}
                      {expanded ? (
                        <div
                          id={`recording-op-details-${operation.operationId}`}
                          className="recording-op-details"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="recording-op-detail-group">
                            <h5>定位属性</h5>
                            <dl>
                              <div>
                                <dt>控件</dt>
                                <dd>
                                  {[operation.action?.target?.name, operation.action?.target?.controlType]
                                    .filter(Boolean)
                                    .join(' · ') || '—'}
                                </dd>
                              </div>
                              <div>
                                <dt>AutomationId</dt>
                                <dd className="copyable-val">
                                  <span>{operation.action?.target?.automationId || '—'}</span>
                                  {operation.action?.target?.automationId ? (
                                    <button
                                      type="button"
                                      className="btn-copy-chip"
                                      onClick={() => copyTextToClipboard(operation.action?.target?.automationId!, 'AutomationId')}
                                    >
                                      复制
                                    </button>
                                  ) : null}
                                </dd>
                              </div>
                              <div>
                                <dt>runtimeId</dt>
                                <dd className="copyable-val">
                                  <span>
                                    {operation.action?.target?.runtimeId?.length
                                      ? operation.action.target.runtimeId.join(',')
                                      : '—'}
                                  </span>
                                  {operation.action?.target?.runtimeId?.length ? (
                                    <button
                                      type="button"
                                      className="btn-copy-chip"
                                      onClick={() => {
                                        const rids = operation.action?.target?.runtimeId;
                                        if (rids && rids.length > 0) {
                                          copyTextToClipboard(rids.join(','), 'runtimeId');
                                        }
                                      }}
                                    >
                                      复制
                                    </button>
                                  ) : null}
                                </dd>
                              </div>
                              <div>
                                <dt>物理坐标</dt>
                                <dd className="copyable-val">
                                  <span>
                                    {operation.action?.coordinate
                                      ? `${operation.action.coordinate.x}, ${operation.action.coordinate.y}`
                                      : '—'}
                                  </span>
                                  {operation.action?.coordinate ? (
                                    <button
                                      type="button"
                                      className="btn-copy-chip"
                                      onClick={() => copyTextToClipboard(`${operation.action?.coordinate?.x}, ${operation.action?.coordinate?.y}`, '坐标')}
                                    >
                                      复制
                                    </button>
                                  ) : null}
                                </dd>
                              </div>
                              <div>
                                <dt>操作内容</dt>
                                <dd>{contentPreview || '—'}</dd>
                              </div>
                            </dl>
                          </div>

                          <div className="recording-op-detail-group">
                            <h5>前后状态对比</h5>
                            <dl>
                              <div>
                                <dt>操作前</dt>
                                <dd>{formatJsonish(operation.action?.stateBefore)}</dd>
                              </div>
                              <div>
                                <dt>主迁移</dt>
                                <dd>
                                  {operation.outcome.primaryTransitionId
                                    ? operation.transitions.find(
                                        (item) => item.transitionId === operation.outcome.primaryTransitionId,
                                      )?.property ?? operation.outcome.primaryTransitionId
                                    : '—'}
                                </dd>
                              </div>
                            </dl>
                          </div>

                          <div className="recording-op-detail-group">
                            <h5>候选结果判定</h5>
                            {choices.length === 0 ? (
                              <p className="recording-op-detail-empty">无候选迁移</p>
                            ) : (
                              <ul className="recording-op-candidates">
                                {choices.map((choice) => (
                                  <li key={choice.transitionId}>
                                    <span>{choice.label}</span>
                                    <button
                                      type="button"
                                      className="btn btn-ghost btn-sm"
                                      disabled={busy}
                                      onClick={() =>
                                        void handleSelectCandidate(operation, choice.transitionId)
                                      }
                                    >
                                      选为结果
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {operation.outcomeSelectionSource === 'manual' ? (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                disabled={busy}
                                onClick={() => void handleRestoreAuto(operation)}
                              >
                                恢复自动判断
                              </button>
                            ) : null}
                          </div>

                          <div className="recording-op-detail-group">
                            <h5>Reason / 证据链</h5>
                            <p>
                              {(operation.outcome.reasonCodes ?? []).join(', ') ||
                                (operation.action.targetReasonCodes ?? []).join(', ') ||
                                '—'}
                            </p>
                            <ul className="recording-op-evidence">
                              {(operation.evidence ?? []).slice(0, 20).map((evidence) => (
                                <li key={evidence.evidenceId}>
                                  <button
                                    type="button"
                                    className="recording-op-evidence-link"
                                    onClick={() => {
                                      props.onPlaybackFocusChange?.({
                                        eventId: evidence.sourceId || operation.operationId,
                                        sessionId: operation.sessionId || sessionId || '',
                                        occurredAtMs: evidence.occurredAtMs || operation.startedAtMs,
                                      });
                                    }}
                                  >
                                    <span>
                                      {evidence.kind} · {evidence.role}
                                    </span>
                                    <time>
                                      {formatRelativeOperationTime(
                                        Math.max(
                                          0,
                                          evidence.occurredAtMs -
                                            (operation.startedAtMs - operation.relativeMsFromSessionStart),
                                        ),
                                      )}
                                    </time>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      ) : null}
                    </article>
                  </li>
                );
              })}
            </ol>
          )}

          {nextCursor ? (
            <div className="recording-review-load-more">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={loading || busy}
                onClick={() => void loadOperationsPage({ cursor: nextCursor, append: true })}
              >
                加载更多操作
              </button>
            </div>
          ) : null}
        </section>

        {/* Right Inspector & Defect Marker Column (Inspector Mode) */}
        <aside className="defect-evidence-inspector-col" aria-label="技术详情检查器与问题标记">
          {/* Pro Step Inspector */}
          {selectedOperation && layoutMode === 'split' ? (
            <section className="recording-op-inspector" aria-label="当前选中步骤检查器">
              <header className="inspector-panel-header">
                <div className="inspector-panel-title-row">
                  <div className="inspector-panel-title">
                    <span className="inspector-label-tag">🔬 步骤检查器</span>
                    <span className="inspector-index-chip">
                      #{visibleOperations.findIndex(o => o.operationId === selectedOperation.operationId) + 1 || 1}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs btn-seek-video"
                    onClick={() => focusOperation(selectedOperation)}
                    title="播放器定位到此步骤发生时刻"
                  >
                    ▶ 定位视频
                  </button>
                </div>
                <div className="inspector-panel-op-title" title={selectedOperation.businessAlias || selectedOperation.title}>
                  {selectedOperation.businessAlias || selectedOperation.title}
                </div>

                <nav className="inspector-nav-tabs" role="tablist" aria-label="检查器视图切换">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeInspectorTab === 'locators'}
                    className={`inspector-nav-tab ${activeInspectorTab === 'locators' ? 'is-active' : ''}`}
                    onClick={() => setActiveInspectorTab('locators')}
                  >
                    UI 定位
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeInspectorTab === 'diff'}
                    className={`inspector-nav-tab ${activeInspectorTab === 'diff' ? 'is-active' : ''}`}
                    onClick={() => setActiveInspectorTab('diff')}
                  >
                    前后对比
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeInspectorTab === 'candidates'}
                    className={`inspector-nav-tab ${activeInspectorTab === 'candidates' ? 'is-active' : ''}`}
                    onClick={() => setActiveInspectorTab('candidates')}
                  >
                    候选判定
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeInspectorTab === 'evidence'}
                    className={`inspector-nav-tab ${activeInspectorTab === 'evidence' ? 'is-active' : ''}`}
                    onClick={() => setActiveInspectorTab('evidence')}
                  >
                    证据链路
                  </button>
                </nav>
              </header>

              <div className="inspector-panel-body">
                {/* Tab 1: Locators & Coordinates */}
                {activeInspectorTab === 'locators' ? (
                  <div className="inspector-tab-view">
                    <div className="inspector-group-box">
                      <div className="inspector-group-header">
                        <span>目标控件属性</span>
                        <span className="group-header-sub">UIA 智能感知</span>
                      </div>
                      <div className="prop-keyval-table">
                        <div className="prop-keyval-row">
                          <span className="prop-k">控件名称</span>
                          <div className="prop-v-wrap">
                            <span className="prop-v" title={selControlName}>{selControlName}</span>
                            {selControlName !== '—' ? (
                              <button
                                type="button"
                                className="btn-copy-chip"
                                onClick={() => copyTextToClipboard(selControlName, '控件名称')}
                              >
                                复制
                              </button>
                            ) : null}
                          </div>
                        </div>

                        <div className="prop-keyval-row">
                          <span className="prop-k">控件类型</span>
                          <div className="prop-v-wrap">
                            <span className="prop-v">{selControlType}</span>
                          </div>
                        </div>

                        <div className="prop-keyval-row">
                          <span className="prop-k">AutomationId</span>
                          <div className="prop-v-wrap">
                            <span className="prop-v" title={selAutoId}>{selAutoId}</span>
                            {selAutoId !== '—' ? (
                              <button
                                type="button"
                                className="btn-copy-chip"
                                onClick={() => copyTextToClipboard(selAutoId, 'AutomationId')}
                              >
                                复制
                              </button>
                            ) : null}
                          </div>
                        </div>

                        <div className="prop-keyval-row">
                          <span className="prop-k">runtimeId</span>
                          <div className="prop-v-wrap">
                            <span className="prop-v" title={selRuntimeIdText}>{selRuntimeIdText}</span>
                            {selRuntimeIdText !== '—' ? (
                              <button
                                type="button"
                                className="btn-copy-chip"
                                onClick={() => copyTextToClipboard(selRuntimeIdText, 'runtimeId')}
                              >
                                复制
                              </button>
                            ) : null}
                          </div>
                        </div>

                        <div className="prop-keyval-row">
                          <span className="prop-k">物理坐标</span>
                          <div className="prop-v-wrap">
                            <span className="prop-v">{selCoordText}</span>
                            {selCoord ? (
                              <button
                                type="button"
                                className="btn-copy-chip"
                                onClick={() => copyTextToClipboard(`${selCoord.x}, ${selCoord.y}`, '坐标')}
                              >
                                复制
                              </button>
                            ) : null}
                          </div>
                        </div>

                        <div className="prop-keyval-row">
                          <span className="prop-k">所属窗口/进程</span>
                          <div className="prop-v-wrap">
                            <span className="prop-v" title={selProcessWindow}>{selProcessWindow}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="inspector-group-box">
                      <div className="inspector-group-header">
                        <span>操作捕获内容</span>
                      </div>
                      <div className="prop-keyval-table">
                        <div className="prop-keyval-row">
                          <span className="prop-k">输入/捕获文本</span>
                          <div className="prop-v-wrap">
                            <span className="prop-v" style={{ color: 'var(--accent-primary)' }}>{selContent}</span>
                          </div>
                        </div>
                        <div className="prop-keyval-row">
                          <span className="prop-k">动作类型</span>
                          <div className="prop-v-wrap">
                            <span className="prop-v">{formatActionKindLabel(selectedOperation.action?.kind)}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {/* Tab 2: Visual Diff Before vs After */}
                {activeInspectorTab === 'diff' ? (
                  <div className="inspector-tab-view">
                    <div className="inspector-group-box">
                      <div className="inspector-group-header">
                        <span>属性级变动对比 (Visual Diff)</span>
                      </div>

                      <div className="diff-card-grid">
                        <div className="diff-card-col diff-col-before">
                          <div className="diff-card-col-title">操作前 (Before)</div>
                          {Object.keys(selStateProps).length === 0 ? (
                            <div className="diff-empty-text">未记录快照属性</div>
                          ) : (
                            <div className="diff-props-list">
                              {Object.entries(selStateProps).map(([k, v]) => (
                                <div className="diff-prop-item" key={k}>
                                  <span className="diff-prop-key">{k}:</span>
                                  <span className="diff-prop-val">{v}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="diff-card-col diff-col-after">
                          <div className="diff-card-col-title">主迁移结果 (After)</div>
                          {selPrimaryTransition ? (
                            <div className="diff-props-list">
                              <div className="diff-prop-item">
                                <span className="diff-prop-key">属性:</span>
                                <span className="diff-prop-val is-accent">{selPrimaryTransition.property}</span>
                              </div>
                              <div className="diff-prop-item">
                                <span className="diff-prop-key">变动前:</span>
                                <span className="diff-prop-val">{formatJsonish(selPrimaryTransition.before)}</span>
                              </div>
                              <div className="diff-prop-item">
                                <span className="diff-prop-key">变动后:</span>
                                <span className="diff-prop-val is-highlight">{formatJsonish(selPrimaryTransition.after)}</span>
                              </div>
                              {selPrimaryTransition.kind ? (
                                <div className="diff-prop-item">
                                  <span className="diff-prop-key">类型:</span>
                                  <span className="diff-prop-val">{selPrimaryTransition.kind}</span>
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            <div className="diff-empty-text">
                              {selectedOperation.resultSummary || '未关联明确迁移'}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="inspector-group-box">
                      <div className="inspector-group-header">
                        <span>迁移指标</span>
                      </div>
                      <div className="prop-keyval-table">
                        <div className="prop-keyval-row">
                          <span className="prop-k">主迁移 ID</span>
                          <div className="prop-v-wrap">
                            <span className="prop-v">{selectedOperation.outcome?.primaryTransitionId || '—'}</span>
                          </div>
                        </div>
                        <div className="prop-keyval-row">
                          <span className="prop-k">可观测延迟</span>
                          <div className="prop-v-wrap">
                            <span className="prop-v">
                              {typeof selectedOperation.outcome?.latencyMs === 'number'
                                ? `${selectedOperation.outcome.latencyMs} ms`
                                : '—'}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {/* Tab 3: Candidate Decisions */}
                {activeInspectorTab === 'candidates' ? (
                  <div className="inspector-tab-view">
                    <div className="inspector-group-box">
                      <div className="inspector-group-header">
                        <span>候选迁移结果选择</span>
                        <span className="group-header-sub">
                          来源: {selectedOperation.outcomeSelectionSource === 'manual' ? '人工选择' : '自动推断'}
                        </span>
                      </div>

                      {selChoices.length === 0 ? (
                        <p className="recording-op-detail-empty">该步骤未生成备选迁移</p>
                      ) : (
                        <div className="candidate-cards-list">
                          {selChoices.map((choice) => (
                            <div
                              key={choice.transitionId}
                              className={`candidate-card-item ${choice.transitionId === selectedOperation.outcome?.primaryTransitionId ? 'is-primary' : ''}`}
                            >
                              <div className="candidate-card-content">
                                <strong>{choice.label}</strong>
                                <span className="candidate-card-sub">
                                  ID: {choice.transitionId}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="btn btn-secondary btn-xs"
                                disabled={busy || choice.transitionId === selectedOperation.outcome?.primaryTransitionId}
                                onClick={() => void handleSelectCandidate(selectedOperation, choice.transitionId)}
                              >
                                {choice.transitionId === selectedOperation.outcome?.primaryTransitionId ? '当前结果' : '选为结果'}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      {selectedOperation.outcomeSelectionSource === 'manual' ? (
                        <div className="restore-auto-wrap">
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => void handleRestoreAuto(selectedOperation)}
                          >
                            ↺ 恢复自动判断
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {/* Tab 4: Evidence Timeline & Telemetry */}
                {activeInspectorTab === 'evidence' ? (
                  <div className="inspector-tab-view">
                    <div className="inspector-group-box">
                      <div className="inspector-group-header">
                        <span>佐证物与诊断码</span>
                        <span className="group-header-sub">点击可跳转视频回放</span>
                      </div>

                      <div className="reason-codes-wrap">
                        <span className="reason-codes-label">Reason Codes:</span>
                        <span className="reason-codes-val">
                          {(selectedOperation.outcome.reasonCodes ?? []).join(', ') ||
                            (selectedOperation.action.targetReasonCodes ?? []).join(', ') ||
                            '—'}
                        </span>
                      </div>

                      <div className="evidence-timeline-cards">
                        {(selectedOperation.evidence ?? []).slice(0, 20).map((evidence) => {
                          const relMs = Math.max(
                            0,
                            evidence.occurredAtMs -
                              (selectedOperation.startedAtMs - selectedOperation.relativeMsFromSessionStart),
                          );
                          const icon =
                            evidence.kind === 'screenshot' || evidence.kind === 'thumbnail'
                              ? '🖼️'
                              : evidence.kind === 'stateTransition'
                                ? '🌲'
                                : '📄';

                          return (
                            <button
                              key={evidence.evidenceId}
                              type="button"
                              className="evidence-card-btn"
                              onClick={() => {
                                props.onPlaybackFocusChange?.({
                                  eventId: evidence.sourceId || selectedOperation.operationId,
                                  sessionId: selectedOperation.sessionId || sessionId || '',
                                  occurredAtMs: evidence.occurredAtMs || selectedOperation.startedAtMs,
                                });
                              }}
                            >
                              <div className="evidence-card-left">
                                <span className="evidence-card-icon" aria-hidden="true">{icon}</span>
                                <div className="evidence-card-text">
                                  <strong>{evidence.kind}</strong>
                                  <span>{evidence.role}</span>
                                </div>
                              </div>
                              <time className="evidence-card-time">
                                {formatRelativeOperationTime(relMs)}
                              </time>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {/* Defect Marker & Pack Export Panel */}
          <aside
            className={`defect-evidence-marker ${markerCollapsed ? 'is-collapsed' : ''}`}
            aria-label="问题标记"
          >
            <div className="defect-evidence-section-title defect-evidence-marker-title">
              <div>
                <h4>问题标记与导出</h4>
                <p>定位一段可复查时间窗并导出完整记录包。</p>
              </div>
              <div className="defect-evidence-title-actions">
                <span>{windowLabel}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm defect-marker-toggle"
                  aria-expanded={!markerCollapsed}
                  aria-controls="recording-review-marker-body"
                  title={markerCollapsed ? '展开问题标记' : '收起问题标记'}
                  onClick={() => setMarkerCollapsed((current) => !current)}
                >
                  {markerCollapsed ? '展开' : '收起'}
                </button>
              </div>
            </div>

            {markerCollapsed ? (
              <div className="defect-evidence-marker-summary" aria-label="问题标记摘要">
                <span>
                  <strong>{markerStateLabel}</strong>
                  <small>标记</small>
                </span>
                <span>
                  <strong>{visibleOperations.length}</strong>
                  <small>操作</small>
                </span>
                <span>
                  <strong>{props.enabled ? '开启' : '关闭'}</strong>
                  <small>记录</small>
                </span>
              </div>
            ) : null}

            <div
              id="recording-review-marker-body"
              className="defect-evidence-marker-body"
              hidden={markerCollapsed}
            >
              <div className="defect-evidence-form">
                <label>
                  <span>问题说明</span>
                  <input
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="例如：保存后金额未刷新"
                    disabled={markerDisabled}
                  />
                </label>
                <label>
                  <span>期望表现</span>
                  <input
                    value={expected}
                    onChange={(event) => setExpected(event.target.value)}
                    placeholder="可选"
                    disabled={markerDisabled}
                  />
                </label>
                <label>
                  <span>实际表现</span>
                  <div className="actual-input-wrap">
                    <input
                      value={actual}
                      onChange={(event) => setActual(event.target.value)}
                      placeholder="可选，可点击步骤右侧「📍 锚定」自动填入"
                      disabled={markerDisabled}
                    />
                    {selectedOperation ? (
                      <button
                        type="button"
                        className="btn-fill-actual"
                        title="将选中步骤填入实际表现"
                        onClick={() => handleAnchorStepToDefect(selectedOperation)}
                      >
                        填入选中步
                      </button>
                    ) : null}
                  </div>
                </label>
              </div>

              <div className="defect-evidence-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={markerDisabled}
                  onClick={() => void handleMarkDefect()}
                >
                  标记问题
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={markerDisabled}
                  onClick={() => void handleRebuild()}
                >
                  重新生成
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy || visibleOperations.length === 0}
                  onClick={() => void handleCopyRepro()}
                >
                  复制步骤
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={markerDisabled}
                  onClick={() => void handleExportPack()}
                >
                  导出记录包
                </button>
              </div>

              {status ? <p className="defect-evidence-status">{status}</p> : null}
              {packResult ? (
                <p className="defect-evidence-pack-summary">
                  路径: {packResult.packDir} · 操作 {packResult.stepCount} · 截图 {packResult.screenshotCount} ·
                  视频段 {packResult.videoSegmentCount}
                  {packResult.clipBuilt ? ' · clip.mp4 已生成' : ''}
                </p>
              ) : null}
            </div>
          </aside>
        </aside>
      </div>

      {/* 8. Bottom Repro Panel (Backward Compatibility & Easy Review) */}
      {reproText ? (
        <section className="defect-evidence-repro-panel" aria-label="操作结果文本">
          <div className="defect-evidence-section-title">
            <div>
              <h4>操作结果文本</h4>
              <p>用于粘贴到工单、测试记录或沟通上下文（操作 → 结果 → 耗时）。</p>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={() => copyTextToClipboard(reproText, '操作结果文本')}
            >
              复制文本
            </button>
          </div>
          <pre className="defect-evidence-repro">{reproText}</pre>
        </section>
      ) : null}

      {/* 9. Repro Steps Markdown Modal */}
      {isReproModalOpen ? (
        <div className="recording-review-modal-overlay" onClick={() => setIsReproModalOpen(false)}>
          <div className="recording-review-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-box-header">
              <div>
                <strong>操作复现步骤 (Markdown)</strong>
                <p>已按时间窗与当前筛选结果组织，可直接粘贴至缺陷工单或报告</p>
              </div>
              <button
                type="button"
                className="btn-modal-close"
                onClick={() => setIsReproModalOpen(false)}
                aria-label="关闭"
              >
                ✕
              </button>
            </div>
            <div className="modal-box-body">
              <pre className="modal-repro-pre">
                {reproText || buildOperationReproText({
                  sessionId,
                  operations: visibleOperations,
                  defectNote: note.trim() || actual.trim() || undefined,
                  windowStartMs: defect?.windowStartMs,
                  windowEndMs: defect?.windowEndMs,
                  markedAtMs: defect?.markedAtMs,
                })}
              </pre>
            </div>
            <div className="modal-box-footer">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setIsReproModalOpen(false)}
              >
                关闭
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={async () => {
                  await handleCopyRepro();
                  setIsReproModalOpen(false);
                }}
              >
                复制到剪贴板
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 10. Lightweight Toast Feedback Pill */}
      {toastFeedback ? (
        <div className="recording-review-toast" role="status" aria-live="polite">
          <span>{toastFeedback}</span>
        </div>
      ) : null}
    </section>
  );
}

/** @deprecated Use RecordingReviewPanel. Kept for gradual rename compatibility. */
export const DefectEvidencePanel = RecordingReviewPanel;
export type DefectEvidencePanelProps = RecordingReviewPanelProps;
