import { useCallback, useEffect, useMemo, useState } from 'react';

import type { TestSessionPlaybackFocus, TestSessionState } from '../../../types/contracts';
import type {
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

  const sessionId = props.session?.sessionId ?? null;

  const visibleOperations = useMemo(
    () =>
      filterOperationsByWindow(
        operations.filter((operation) => !operation.ignored),
        defect?.windowStartMs,
        defect?.windowEndMs,
      ),
    [defect, operations],
  );

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
      // Clearing manual selection by writing an empty note+reason restore signal is not enough;
      // use selectedOutcomeStatus incomplete with no transition to request auto rebuild path when supported.
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
    } catch (error) {
      props.onError(props.toUiErrorMessage(error));
    } finally {
      setBusy(false);
    }
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

  return (
    <section className="defect-evidence-panel recording-review-panel" aria-label="记录与回顾">
      <header className="defect-evidence-header">
        <div>
          <span className="defect-evidence-kicker">录屏工具</span>
          <h3>记录与回顾</h3>
          <p>按时间线展示操作主句与可观察结果；坐标和 locator 默认折叠在技术详情中。</p>
        </div>
        <div className="defect-evidence-summary" aria-label="记录概览">
          <span>
            <strong>{visibleOperations.length}</strong>
            <small>当前操作</small>
          </span>
          <span>
            <strong>{defect ? '已标记' : '未标记'}</strong>
            <small>问题状态</small>
          </span>
          <span>
            <strong>{props.enabled ? '已开启' : '未开启'}</strong>
            <small>语义记录</small>
          </span>
        </div>
      </header>

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

      <div className={`defect-evidence-layout ${markerCollapsed ? 'is-marker-collapsed' : ''}`}>
        <aside
          className={`defect-evidence-marker ${markerCollapsed ? 'is-collapsed' : ''}`}
          aria-label="问题标记"
        >
          <div className="defect-evidence-section-title defect-evidence-marker-title">
            <div>
              <h4>问题标记</h4>
              <p>定位一段可复查时间窗，不影响原始录屏。</p>
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
                <input
                  value={actual}
                  onChange={(event) => setActual(event.target.value)}
                  placeholder="可选"
                  disabled={markerDisabled}
                />
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

        <section className="defect-evidence-steps recording-review-timeline" aria-label="语义步骤时间线">
          <div className="defect-evidence-section-title">
            <div>
              <h4>语义步骤时间线</h4>
              <p>{defect ? '已按问题标记时间窗筛选' : '按录制发生时间顺序排列'}</p>
            </div>
            <span>
              {scopeLabel} · {visibleOperations.length}/{totalCount || operations.length}
            </span>
          </div>

          {visibleOperations.length === 0 ? (
            <p className="defect-evidence-empty">
              {loading
                ? '正在加载操作记录…'
                : '暂无操作记录。开始录制并完成操作后可重新生成。'}
            </p>
          ) : (
            <ol className="defect-step-timeline recording-op-timeline">
              {visibleOperations.map((operation, index) => {
                const presentation = operationStatusPresentation(operation.outcome?.status);
                const expanded = !!expandedIds[operation.operationId];
                const showConfidence = shouldShowConfidenceBadge(operation);
                const contentPreview =
                  operation.action?.contentPreview?.trim() ||
                  operation.action?.stateBefore?.valueText?.trim() ||
                  (operation.action?.stateBefore?.selectedNames || []).filter(Boolean).join('、') ||
                  '';
                const contextBits = [
                  contentPreview ? `内容: ${contentPreview}` : null,
                  operation.action?.target?.controlType ?? operation.action?.target?.localizedControlType,
                  typeof operation.outcome?.latencyMs === 'number'
                    ? `${operation.outcome.latencyMs}ms`
                    : null,
                  operation.outcomeSelectionSource === 'manual' ? '人工选择' : null,
                ].filter(Boolean);
                const choices = listManualOutcomeChoices(operation);
                const selected = selectedOperationId === operation.operationId;

                return (
                  <li
                    className={`defect-step-timeline-item recording-op-item ${selected ? 'is-selected' : ''}`}
                    key={operation.operationId || `${operation.startedAtMs}-${index}`}
                  >
                    <div className="recording-op-meta-col">
                      <span className="recording-op-index" aria-label={`序号 ${index + 1}`}>
                        #{index + 1}
                      </span>
                      <span className="recording-op-kind" title={operation.action?.kind}>
                        {formatActionKindLabel(operation.action?.kind)}
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
                        <div className="defect-step-edit">
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
                            onClick={() => focusOperation(operation)}
                          >
                            <strong className="recording-op-title">{operation.businessAlias || operation.title}</strong>
                            {operation.businessAlias && operation.businessAlias !== operation.title ? (
                              <span className="recording-op-alias-tag">业务别名</span>
                            ) : operation.businessAlias ? (
                              <span className="recording-op-alias-tag">业务别名</span>
                            ) : null}
                            {contentPreview ? (
                              <span className="recording-op-content" title="操作内容">
                                内容「{contentPreview}」
                              </span>
                            ) : null}
                            <span className="recording-op-result">
                              <span className="recording-op-arrow" aria-hidden="true">
                                →
                              </span>
                              <span>{operation.resultSummary}</span>
                            </span>
                            {contextBits.length > 0 ? (
                              <span className="recording-op-context">{contextBits.join(' · ')}</span>
                            ) : null}
                            {showConfidence ? (
                              <span className="recording-op-confidence">{confidenceLabel(operation)}</span>
                            ) : null}
                          </button>

                          <div className="recording-op-actions">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
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
                              className="btn btn-ghost btn-sm"
                              aria-expanded={expanded}
                              aria-controls={`recording-op-details-${operation.operationId}`}
                              onClick={() => toggleExpanded(operation.operationId)}
                            >
                              {expanded ? '收起详情' : '技术详情'}
                            </button>
                          </div>
                        </>
                      )}

                      {expanded ? (
                        <div
                          id={`recording-op-details-${operation.operationId}`}
                          className="recording-op-details"
                        >
                          <div className="recording-op-detail-group">
                            <h5>定位</h5>
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
                                <dd>{operation.action?.target?.automationId || '—'}</dd>
                              </div>
                              <div>
                                <dt>runtimeId</dt>
                                <dd>
                                  {operation.action?.target?.runtimeId?.length
                                    ? operation.action.target.runtimeId.join(',')
                                    : '—'}
                                </dd>
                              </div>
                              <div>
                                <dt>坐标</dt>
                                <dd>
                                  {operation.action?.coordinate
                                    ? `${operation.action.coordinate.x}, ${operation.action.coordinate.y}`
                                    : '—'}
                                </dd>
                              </div>
                              <div>
                                <dt>操作内容</dt>
                                <dd>{contentPreview || '—'}</dd>
                              </div>
                            </dl>
                          </div>

                          <div className="recording-op-detail-group">
                            <h5>前后状态</h5>
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
                            <h5>候选结果</h5>
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
                            <h5>Reason / 证据</h5>
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
      </div>

      {reproText ? (
        <section className="defect-evidence-repro-panel" aria-label="操作结果文本">
          <div className="defect-evidence-section-title">
            <div>
              <h4>操作结果文本</h4>
              <p>用于粘贴到工单、测试记录或沟通上下文（操作 → 结果 → 耗时）。</p>
            </div>
          </div>
          <pre className="defect-evidence-repro">{reproText}</pre>
        </section>
      ) : null}
    </section>
  );
}

/** @deprecated Use RecordingReviewPanel. Kept for gradual rename compatibility. */
export const DefectEvidencePanel = RecordingReviewPanel;
export type DefectEvidencePanelProps = RecordingReviewPanelProps;
