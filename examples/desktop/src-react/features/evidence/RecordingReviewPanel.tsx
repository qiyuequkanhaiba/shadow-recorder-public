import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  mergeOperationPages,
  normalizeOperationRecord,
  reviewStatusMessage,
  type OperationReviewStatus,
} from '../../lib/operation-adapter';
import styles from './RecordingReview.module.css';
import { ReviewDefectForm } from './ReviewDefectForm';
import { type OperationOverridePatch, ReviewInspectorPanel } from './ReviewInspectorPanel';
import { ReviewOperationsList } from './ReviewOperationsList';
import { ReviewReproModal } from './ReviewReproModal';
import { ReviewSessionInfoCard } from './ReviewSessionInfoCard';

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
  const itemsRaw = Array.isArray(record.items) ? record.items : Array.isArray(value) ? value : [];
  const items = itemsRaw.map((item, index) => normalizeOperationRecord(item, sessionId, index));
  return {
    items,
    nextCursor: typeof record.nextCursor === 'string' ? record.nextCursor : undefined,
    reset: record.reset !== false,
    totalCount: typeof record.totalCount === 'number' ? record.totalCount : items.length,
    diagnostics: Array.isArray(record.diagnostics) ? (record.diagnostics as TestSessionOperationTailResult['diagnostics']) : [],
  };
}

export function RecordingReviewPanel(props: RecordingReviewPanelProps) {
  const [note, setNote] = useState('');
  const [expected, setExpected] = useState('');
  const [actual, setActual] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [operations, setOperations] = useState<TestSessionOperationRecord[]>([]);
  const [reviewStatus, setReviewStatus] = useState<OperationReviewStatus>('empty');
  const [diagnostics, setDiagnostics] = useState<TestSessionOperationTailResult['diagnostics']>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [totalCount, setTotalCount] = useState(0);
  const [defect, setDefect] = useState<{
    markedAtMs: number;
    windowStartMs: number;
    windowEndMs: number;
    preWindowSeconds: number;
    postWindowSeconds: number;
    stepCount: number;
  } | null>(null);
  const [reproText, setReproText] = useState('');
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [markerCollapsed, setMarkerCollapsed] = useState(false);
  const [layoutMode, setLayoutMode] = useState<'split' | 'inline'>('split');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterKind, setFilterKind] = useState<'all' | 'issue' | 'click' | 'input'>('all');
  const [isReproModalOpen, setIsReproModalOpen] = useState(false);

  const { enabled, isRecording, onError, onNotice, toUiErrorMessage } = props;
  const sessionId = props.session?.sessionId ?? null;
  const onErrorRef = useRef(onError);
  const onNoticeRef = useRef(onNotice);
  const toUiErrorMessageRef = useRef(toUiErrorMessage);
  onErrorRef.current = onError;
  onNoticeRef.current = onNotice;
  toUiErrorMessageRef.current = toUiErrorMessage;

  const notify = useCallback((message: string) => {
    onNoticeRef.current?.(message);
  }, []);

  const windowedOperations = useMemo(
    () => filterOperationsByWindow(operations.filter((op) => !op.ignored), defect?.windowStartMs, defect?.windowEndMs),
    [defect, operations],
  );

  const visibleOperations = useMemo(() => {
    return windowedOperations.filter((operation) => {
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const haystacks = [
          operation.title,
          operation.businessAlias,
          operation.resultSummary,
          operation.action?.target?.name,
          operation.action?.target?.controlType,
          operation.action?.target?.localizedControlType,
          operation.action?.target?.automationId,
          operation.action?.contentPreview,
          operation.action?.stateBefore?.valueText,
        ];
        if (!haystacks.some((value) => (value ?? '').toLowerCase().includes(q))) {
          return false;
        }
      }

      if (filterKind === 'issue') {
        const st = operation.outcome?.status;
        return st === 'suspected' || st === 'failed' || st === 'incomplete' || st === 'observerDegraded';
      }
      if (filterKind === 'click') {
        return (operation.action?.kind || '').toLowerCase().includes('click');
      }
      if (filterKind === 'input') {
        const k = (operation.action?.kind || '').toLowerCase();
        return k.includes('type') || k.includes('key') || k.includes('input');
      }

      return true;
    });
  }, [filterKind, searchQuery, windowedOperations]);

  const selectedOperation = useMemo(() => {
    if (selectedOperationId) {
      const found = visibleOperations.find((op) => op.operationId === selectedOperationId);
      if (found) return found;
    }
    return visibleOperations[0] ?? null;
  }, [selectedOperationId, visibleOperations]);

  const loadOperationsPage = useCallback(
    async (options?: { cursor?: string; append?: boolean; rebuild?: boolean }) => {
      const api = getApi();
      if (!enabled || !sessionId) {
        setOperations([]);
        setReviewStatus('empty');
        setDiagnostics([]);
        setNextCursor(undefined);
        setTotalCount(0);
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
          const tail = asTailResult(raw, sessionId);
          const model = buildOperationReviewModel(tail, [], sessionId);
          setOperations((prev) =>
            mergeOperationPages(options?.append ? prev : [], model.operations, !options?.append),
          );
          setReviewStatus(model.status);
          setDiagnostics(model.diagnostics);
          setNextCursor(model.nextCursor);
          setTotalCount(model.totalCount);
        } else if (typeof api?.getTestSessionSteps === 'function') {
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
        } else {
          setReviewStatus('unavailable');
          setDiagnostics([]);
          setOperations([]);
        }
      } catch (error) {
        const message = toUiErrorMessageRef.current(error);
        if (!/not active|SessionNotFound|no active|not found|disabled/i.test(message)) {
          onErrorRef.current(message);
        }
        setReviewStatus('unavailable');
      } finally {
        setLoading(false);
      }
    },
    [enabled, sessionId],
  );

  useEffect(() => {
    setDefect(null);
  }, [sessionId]);

  useEffect(() => {
    void loadOperationsPage({ rebuild: true });
  }, [isRecording, loadOperationsPage, sessionId]);

  const handleSaveMeta = async (name: string, notes: string): Promise<void> => {
    const api = getApi();
    if (!sessionId || !api?.updateTestSessionMeta) {
      props.onError('当前环境不能修改会话信息');
      return;
    }
    const cleanName = name.trim();
    if (!cleanName || /[\\/:\n\r]/.test(cleanName)) {
      props.onError('名称无效，请避免斜杠或换行');
      return;
    }
    setBusy(true);
    try {
      const res = await api.updateTestSessionMeta({
        sessionId,
        name: cleanName,
        notes,
      });
      if (res && typeof res === 'object' && res.error) {
        props.onError(String(res.error));
      } else {
        props.onMetaSaved?.();
        notify('会话信息已保存');
      }
    } catch (err) {
      props.onError(props.toUiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleMarkDefect = async (): Promise<void> => {
    const api = getApi();
    if (!sessionId || !api?.markTestDefect) {
      props.onError('当前环境不能标记缺陷');
      return;
    }
    setBusy(true);
    try {
      const res = await api.markTestDefect({
        sessionId,
        note: note.trim(),
        expected: expected.trim() || undefined,
        actual: actual.trim() || undefined,
        preWindowSeconds: props.preWindowSeconds ?? 15,
        postWindowSeconds: props.postWindowSeconds ?? 10,
      });
      setDefect({
        markedAtMs: res.markedAtMs,
        windowStartMs: res.windowStartMs,
        windowEndMs: res.windowEndMs,
        preWindowSeconds: res.preWindowSeconds,
        postWindowSeconds: res.postWindowSeconds,
        stepCount: res.stepCount ?? 0,
      });
      await loadOperationsPage({ rebuild: true });
      notify('已锁定缺陷复现时间窗');
    } catch (err) {
      props.onError(props.toUiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleClearDefect = async (): Promise<void> => {
    setDefect(null);
    notify('已清除缺陷标记时间窗');
  };

  const handleBuildRepro = async (): Promise<void> => {
    const api = getApi();
    const defectNote = note.trim() || actual.trim() || undefined;
    if (typeof api?.renderTestSessionReproSteps === 'function' && sessionId) {
      try {
        const rendered = await api.renderTestSessionReproSteps({
          sessionId,
          windowStartMs: defect?.windowStartMs,
          windowEndMs: defect?.windowEndMs,
          defectNote,
        });
        const renderedText =
          typeof rendered === 'string'
            ? rendered
            : typeof rendered?.text === 'string'
              ? rendered.text
              : '';
        if (renderedText.trim()) {
          setReproText(renderedText);
          setIsReproModalOpen(true);
          return;
        }
      } catch {
        // Fall back to client generator
      }
    }

    const text = buildOperationReproText({
      sessionId: sessionId || '',
      operations: windowedOperations,
      defectNote,
      markedAtMs: defect?.markedAtMs,
      windowStartMs: defect?.windowStartMs,
      windowEndMs: defect?.windowEndMs,
    });
    setReproText(text);
    setIsReproModalOpen(true);
  };

  const handleExportPack = async (): Promise<void> => {
    const api = getApi();
    if (!sessionId || !api?.exportTestDefectPack) {
      props.onError('当前环境不能导出缺陷包');
      return;
    }
    setBusy(true);
    try {
      const res = await api.exportTestDefectPack({
        sessionId,
        markedAtMs: defect?.markedAtMs,
        preWindowSeconds: defect?.preWindowSeconds ?? props.preWindowSeconds,
        postWindowSeconds: defect?.postWindowSeconds ?? props.postWindowSeconds,
        note: note.trim() || undefined,
        expected: expected.trim() || undefined,
        actual: actual.trim() || undefined,
      });
      notify(`缺陷包已导出: ${res.packDir || res.reproStepsPath}`);
    } catch (err) {
      props.onError(props.toUiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveStep = async (
    operationId: string,
    patch: OperationOverridePatch,
  ): Promise<void> => {
    const api = getApi();
    if (!sessionId) return;
    setBusy(true);
    try {
      if (typeof api?.updateTestSessionOperation === 'function') {
        await api.updateTestSessionOperation({
          sessionId,
          operationId,
          ...patch,
        });
        if (
          patch.reason === 'restore-auto-selection' &&
          typeof api.rebuildTestSessionOperations === 'function'
        ) {
          await api.rebuildTestSessionOperations({ sessionId });
        }
      } else if (typeof api?.updateTestSessionStep === 'function') {
        await api.updateTestSessionStep({
          sessionId,
          stepId: operationId,
          title: patch.title,
          summary: patch.resultSummary,
          businessAlias: patch.businessAlias,
          ignored: patch.ignored,
          note: patch.note,
        });
      }
      await loadOperationsPage({ rebuild: false });
      notify('步骤状态已更新');
    } catch (err) {
      props.onError(props.toUiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!props.session) {
    return (
      <section className={styles.panel} data-ui-scope="review" aria-label="记录与回顾">
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
          <h3>等待会话</h3>
          <p>开始录制后，这里会汇总当前会话的操作、结果和可导出的记录文本。</p>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.panel} data-ui-scope="review" aria-label="记录与回顾">
      <ReviewSessionInfoCard
        session={props.session}
        enabled={props.enabled}
        totalOperations={totalCount || operations.length}
        visibleOperations={visibleOperations.length}
        layoutMode={layoutMode}
        onLayoutModeChange={setLayoutMode}
        defectLocked={Boolean(defect)}
        defectPreWindow={defect?.preWindowSeconds}
        defectPostWindow={defect?.postWindowSeconds}
        defectStepCount={defect?.stepCount}
        onClearDefectWindow={() => { void handleClearDefect(); }}
        onOpenMarker={() => setMarkerCollapsed(false)}
        onOpenSettings={props.onOpenSettings}
        onSaveMeta={handleSaveMeta}
        busy={busy}
        reviewStatus={loading ? 'loading' : reviewStatus}
        statusBanner={reviewStatusMessage(loading ? 'loading' : reviewStatus)}
        diagnostics={diagnostics}
      />

      <ReviewDefectForm
        note={note}
        onNoteChange={setNote}
        expected={expected}
        onExpectedChange={setExpected}
        actual={actual}
        onActualChange={setActual}
        isDefectMarked={Boolean(defect)}
        preWindowSeconds={props.preWindowSeconds ?? 15}
        postWindowSeconds={props.postWindowSeconds ?? 10}
        onMarkDefect={handleMarkDefect}
        onClearDefect={handleClearDefect}
        onExportPack={handleExportPack}
        onBuildRepro={() => { void handleBuildRepro(); }}
        busy={busy}
        disabled={!props.enabled || !sessionId}
        collapsed={markerCollapsed}
        onToggleCollapse={() => setMarkerCollapsed(!markerCollapsed)}
      />

      <div className={layoutMode === 'split' ? styles.layoutSplit : styles.layoutInline}>
        <ReviewOperationsList
          operations={visibleOperations}
          sessionStartedAtMs={props.session?.startedAtMs ?? operations[0]?.startedAtMs}
          selectedOperationId={selectedOperation?.operationId ?? null}
          onSelectOperation={(op) => {
            setSelectedOperationId(op.operationId);
            props.onPlaybackFocusChange?.({
              eventId: op.operationId,
              sessionId: op.sessionId || sessionId || '',
              occurredAtMs: op.startedAtMs,
              displayId: op.action?.coordinate?.displayId ?? undefined,
            });
          }}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          filterKind={filterKind}
          onFilterKindChange={setFilterKind}
          onRefresh={() => { void loadOperationsPage({ rebuild: isRecording }); }}
          onRebuild={() => { void loadOperationsPage({ rebuild: true }); }}
          loading={loading}
          hasMore={Boolean(nextCursor)}
          onLoadMore={() => { void loadOperationsPage({ cursor: nextCursor, append: true }); }}
        />

        <ReviewInspectorPanel
          operation={selectedOperation}
          onSaveStep={handleSaveStep}
          busy={busy}
        />
      </div>

      <ReviewReproModal
        isOpen={isReproModalOpen}
        reproText={reproText}
        onClose={() => setIsReproModalOpen(false)}
        onCopy={() => { void navigator.clipboard.writeText(reproText).then(() => { notify('已复制复现步骤文本'); }); }}
      />
    </section>
  );
}
