import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  TestSessionEvidenceExportResult,
  TestSessionLogCategory,
  TestSessionPlaybackFocus,
  TestSessionState,
  TestSessionTimelineEvent,
  TestSessionVideoSegment,
} from '../../types/contracts';
import { EvidenceExportPanel, type EvidenceExportMode } from '../features/evidence/EvidenceExportPanel';

type RecorderSessionTimelinePanelProps = {
  maxHeight?: number | null;
  sessions: TestSessionState[];
  selectedSession: TestSessionState | null;
  selectedSessionId: string | null;
  events: TestSessionTimelineEvent[];
  videoSegments: TestSessionVideoSegment[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onSelectSession: (sessionId: string) => void;
  onError: (message: string) => void;
  toUiErrorMessage: (error: unknown) => string;
  onPlaybackFocusChange?: (focus: TestSessionPlaybackFocus | null) => void;
  privacyRulesActive: boolean;
  /** compact: simplified continuous-timeline companion for playback page */
  variant?: 'full' | 'compact';
  defectEvidenceEnabled?: boolean;
  onClearEvents?: () => Promise<void> | void;
};

type EventLogFilter = 'all' | TestSessionLogCategory;
type PanelBusyAction = 'refresh' | EvidenceExportMode | null;

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

function formatTimeOfDay(timestampMs?: number): string {
  if (!timestampMs) {
    return '--';
  }
  const date = new Date(timestampMs);
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function compactEventBadge(badge: string, tone: string): string {
  if (tone === 'danger') {
    return '🚩 缺陷';
  }
  return badge;
}

function formatStatus(session: TestSessionState | null): string {
  if (!session) {
    return '无录像';
  }
  if (session.status === 'active') {
    return '录制中';
  }
  if (session.status === 'paused') {
    return '已暂停';
  }
  return '已停止';
}

function resolveEventFilter(event: TestSessionTimelineEvent): EventLogFilter {
  return event.logCategory;
}

function resolveEventLevel(event: TestSessionTimelineEvent): string {
  if (event.eventType === 'app_log_added') {
    return (event.logLevel ?? 'INFO').toUpperCase();
  }

  switch (event.logCategory) {
    case 'recording':
      return '录制';
    case 'operation':
      return '操作';
    case 'system':
      return '系统';
    case 'app':
      return '应用';
    default:
      return '日志';
  }
}

function buildSuggestedZipFileName(session: TestSessionState | null): string {
  const base = session?.name?.trim() || session?.sessionId || 'evidence';
  return base + '.zip';
}

function resolveEventTone(event: TestSessionTimelineEvent): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (event.eventType) {
    case 'session_started':
    case 'session_resumed':
      return 'success';
    case 'session_paused':
    case 'clipboard_updated':
      return 'warning';
    case 'session_stopped':
      return 'danger';
    case 'app_log_added':
      if (event.logLevel === 'error') {
        return 'danger';
      }
      if (event.logLevel === 'warn') {
        return 'warning';
      }
      return 'neutral';
    case 'window_hidden':
      return 'neutral';
    case 'step_captured':
      return 'neutral';
    default:
      return 'info';
  }
}

function resolveEventSummary(event: TestSessionTimelineEvent): string {
  switch (event.eventType) {
    case 'session_started':
      return '循环录像已启动';
    case 'session_paused':
      return '循环录像已暂停';
    case 'session_resumed':
      return '循环录像已恢复';
    case 'session_stopped':
      return '循环录像已停止';
    case 'step_captured':
      return event.action ?? '捕获到一条操作记录';
    case 'app_log_added':
      return event.message ?? event.logSource ?? '应用日志';
    case 'window_foreground_changed':
      return '前台窗口切换';
    case 'window_focus_changed':
      return '窗口焦点变化';
    case 'window_shown':
      return '窗口显示';
    case 'window_hidden':
      return '窗口隐藏';
    case 'window_title_changed':
      return '窗口标题变化';
    case 'clipboard_updated':
      return '剪贴板内容变化';
    default:
      return event.eventType;
  }
}

function resolveEventDetail(event: TestSessionTimelineEvent): string {
  const location =
    event.x !== undefined && event.y !== undefined ? `(${event.x}, ${event.y})` : undefined;

  switch (event.eventType) {
    case 'step_captured':
      return [event.processName, event.windowTitle, location].filter(Boolean).join(' · ');
    case 'app_log_added':
      return [event.logSource, event.message].filter(Boolean).join(' · ');
    case 'window_foreground_changed':
    case 'window_focus_changed':
    case 'window_shown':
    case 'window_hidden':
    case 'window_title_changed':
      return [event.processName, event.windowTitle, event.windowHwnd].filter(Boolean).join(' · ');
    case 'clipboard_updated':
      return event.message ?? `类型: ${event.clipboardContentType ?? 'unknown'}`;
    default:
      return [event.title, event.message, event.status].filter(Boolean).join(' · ');
  }
}

function buildEventSearchText(event: TestSessionTimelineEvent): string {
  return [
    event.eventType,
    resolveEventLevel(event),
    resolveEventSummary(event),
    resolveEventDetail(event),
    event.processName,
    event.windowTitle,
    event.message,
    event.logSource,
    event.logLevel,
    event.clipboardContentType,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function RecorderSessionTimelinePanel(props: RecorderSessionTimelinePanelProps) {
  const {
    maxHeight: _maxHeight,
    sessions,
    selectedSession,
    selectedSessionId,
    events,
    loading,
    onRefresh,
    onSelectSession,
    onError,
    toUiErrorMessage,
    onPlaybackFocusChange,
    variant = 'full',
    defectEvidenceEnabled = false,
    onClearEvents,
  } = props;
  const isCompact = variant === 'compact';
  const [filter, setFilter] = useState<EventLogFilter>('all');
  const [defectOnly, setDefectOnly] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [busyAction, setBusyAction] = useState<PanelBusyAction>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [evidenceExportResult, setEvidenceExportResult] =
    useState<TestSessionEvidenceExportResult | null>(null);
  const [pendingExportMode, setPendingExportMode] = useState<EvidenceExportMode | null>(null);
  const [semanticSteps, setSemanticSteps] = useState<Array<{
    stepId: string;
    startedAtMs: number;
    title: string;
    stepType: string;
    precisionLevel?: string;
  }>>([]);
  const skipStepsUntilEventsRef = useRef(false);
  const deferredEvents = useDeferredValue(events);

  useEffect(() => {
    let cancelled = false;
    async function loadSteps() {
      if (skipStepsUntilEventsRef.current && events.length === 0) {
        if (!cancelled) setSemanticSteps([]);
        return;
      }
      skipStepsUntilEventsRef.current = false;
      if (!defectEvidenceEnabled || !selectedSessionId) {
        if (!cancelled) setSemanticSteps([]);
        return;
      }
      const api = (window as any).reqcaseShadowRecorder;
      if (!api?.getTestSessionSteps) {
        return;
      }
      try {
        if (typeof api.rebuildTestSessionSteps === 'function') {
          await api.rebuildTestSessionSteps({ sessionId: selectedSessionId });
        }
        const rows = await api.getTestSessionSteps({ sessionId: selectedSessionId });
        if (cancelled) return;
        const list = Array.isArray(rows) ? rows : [];
        setSemanticSteps(
          list.map((row: any) => ({
            stepId: String(row.stepId ?? row.step_id ?? ''),
            startedAtMs: Number(row.startedAtMs ?? row.started_at_ms ?? 0),
            title: String(row.title ?? '步骤'),
            stepType: String(row.stepType ?? row.step_type ?? 'step'),
            precisionLevel: row.precisionLevel ?? row.precision_level,
          })),
        );
      } catch {
        if (!cancelled) setSemanticSteps([]);
      }
    }
    void loadSteps();
    return () => {
      cancelled = true;
    };
  }, [defectEvidenceEnabled, selectedSessionId, events.length, loading]);
  const commandBusy = busyAction !== null;
  const exportBusy = busyAction === 'zip' || busyAction === 'directory';
  const exportStatusText =
    busyAction === 'zip'
      ? '正在导出 ZIP，请稍候…'
      : busyAction === 'directory'
        ? '正在导出目录，请稍候…'
        : '';

  const filteredEvents = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    const filtered: TestSessionTimelineEvent[] = [];

    for (let index = deferredEvents.length - 1; index >= 0; index -= 1) {
      const event = deferredEvents[index];
      if (filter !== 'all' && resolveEventFilter(event) !== filter) {
        continue;
      }
      if (normalizedKeyword && !buildEventSearchText(event).includes(normalizedKeyword)) {
        continue;
      }
      filtered.push(event);
    }

    return filtered;
  }, [deferredEvents, filter, keyword]);

  const timelineItems = useMemo(() => {
    type Item = {
      key: string;
      occurredAtMs: number;
      kind: 'event' | 'step';
      title: string;
      badge: string;
      tone: string;
      event?: TestSessionTimelineEvent;
    };
    const items: Item[] = [];
    for (const event of filteredEvents) {
      // When defect mode on, prefer semantic steps over raw step_captured noise.
      if (defectEvidenceEnabled && event.eventType === 'step_captured') {
        continue;
      }
      items.push({
        key: event.eventId,
        occurredAtMs: event.occurredAtMs,
        kind: 'event',
        title: resolveEventSummary(event),
        badge: resolveEventLevel(event),
        tone: resolveEventTone(event),
        event,
      });
    }
    if (defectEvidenceEnabled) {
      for (const step of semanticSteps) {
        if (!step.stepId || !step.startedAtMs) continue;
        items.push({
          key: `step:${step.stepId}`,
          occurredAtMs: step.startedAtMs,
          kind: 'step',
          title: step.title,
          badge: (step.precisionLevel ?? 'STEP').toUpperCase(),
          tone: 'operation',
        });
      }
    }
    items.sort((a, b) => b.occurredAtMs - a.occurredAtMs);
    if (isCompact && items.length > 40) {
      return items.slice(0, 40);
    }
    return items;
  }, [filteredEvents, semanticSteps, defectEvidenceEnabled, isCompact]);

  useEffect(() => {
    if (timelineItems.length === 0) {
      setSelectedEventId(null);
      onPlaybackFocusChange?.(null);
      return;
    }

    if (selectedEventId && filteredEvents.some((event) => event.eventId === selectedEventId)) {
      return;
    }

    setSelectedEventId(filteredEvents[0].eventId);
  }, [filteredEvents, onPlaybackFocusChange, selectedEventId]);

  const handleRefresh = useCallback(async () => {
    try {
      setBusyAction('refresh');
      onError('');
      await onRefresh();
    } catch (error) {
      onError(toUiErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }, [onError, onRefresh, toUiErrorMessage]);

  const handlePrepareExport = useCallback((outputMode: EvidenceExportMode) => {
    if (!selectedSession) {
      return;
    }
    onError('');
    setEvidenceExportResult(null);
    setPendingExportMode(outputMode);
  }, [onError, selectedSession]);

  const handleCancelExport = useCallback(() => {
    setPendingExportMode(null);
  }, []);

  const handleConfirmExport = useCallback(async (privacyAcknowledgedAt: string, zipFileName?: string) => {
    try {
      if (!window.reqcaseShadowRecorder.exportTestSessionEvidence || !selectedSession || !pendingExportMode) {
        return;
      }
      setBusyAction(pendingExportMode);
      onError('');
      setEvidenceExportResult(null);
      const result = await window.reqcaseShadowRecorder.exportTestSessionEvidence({
        sessionId: selectedSession.sessionId,
        outputMode: pendingExportMode,
        bundleName: selectedSession.name?.trim() || selectedSession.sessionId,
        targetDir: '',
        zipFileName: pendingExportMode === 'zip' ? zipFileName : undefined,
        privacyAcknowledgedAt,
      });
      setEvidenceExportResult(result);
      setPendingExportMode(null);
    } catch (error) {
      const message = toUiErrorMessage(error);
      if (!/canceled/i.test(message)) {
        onError(message);
      }
    } finally {
      setBusyAction(null);
    }
  }, [onError, pendingExportMode, selectedSession, toUiErrorMessage]);

  const handleSelectSession = useCallback((sessionId: string) => {
    startTransition(() => {
      onSelectSession(sessionId);
    });
  }, [onSelectSession]);

  const handleSelectEvent = useCallback((event: TestSessionTimelineEvent) => {
    setSelectedEventId(event.eventId);
    onPlaybackFocusChange?.({
      eventId: event.eventId,
      sessionId: event.sessionId,
      occurredAtMs: event.occurredAtMs,
      displayId: event.displayId,
    });
  }, [onPlaybackFocusChange]);

  const summaryText = selectedSession
    ? `${selectedSession.name ?? '最近录像'} · ${formatStatus(selectedSession)}`
    : '录制开始后会自动生成事件日志';

  const countByCategory = useMemo(() => {
    return deferredEvents.reduce(
      (accumulator, event) => {
        accumulator[event.logCategory] += 1;
        return accumulator;
      },
      {
        recording: 0,
        system: 0,
        operation: 0,
        app: 0,
      } satisfies Record<TestSessionLogCategory, number>,
    );
  }, [deferredEvents]);

  return (
    <aside
      className={`recorder-log-panel recorder-log-panel-fluid${isCompact ? ' is-compact' : ''}`}
      aria-label={isCompact ? '实时事件流' : '会话事件日志'}
    >
            {isCompact ? (
        <>
        <div className="timeline-head-bar">
          <span>实时事件流 ({timelineItems.length})</span>
          <div className="timeline-head-actions">
            <button
              type="button"
              className={`action-btn-sm${defectOnly ? ' is-active' : ''}`}
              onClick={() => setDefectOnly((current) => !current)}
            >
              仅缺陷
            </button>
            <button
              type="button"
              className="action-btn-sm"
              disabled={commandBusy}
              onClick={() => { void handleRefresh(); }}
            >
              {busyAction === 'refresh' ? '刷新中…' : '刷新'}
            </button>
            <button
              type="button"
              className="action-btn-sm"
              disabled={commandBusy || timelineItems.length === 0}
              onClick={() => {
                skipStepsUntilEventsRef.current = true;
                setSemanticSteps([]);
                void onClearEvents?.();
              }}
            >
              清除
            </button>
          </div>
        </div>
        <div className="timeline-head-tools">
          <select
            className="recorder-log-select"
            value={selectedSessionId ?? ''}
            onChange={(event) => { void handleSelectSession(event.target.value); }}
            disabled={commandBusy || sessions.length === 0}
            aria-label="选择会话"
          >
            {sessions.length === 0 ? <option value="">暂无录像</option> : null}
            {sessions.map((session) => (
              <option key={session.sessionId} value={session.sessionId}>
                {(session.name?.trim() || session.sessionId)}
                {' · '}
                {formatStatus(session)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`btn-quick-defect${busyAction === 'zip' ? ' is-loading' : ''}`}
            disabled={commandBusy || !selectedSession}
            onClick={() => { handlePrepareExport('zip'); }}
            aria-busy={busyAction === 'zip'}
          >
            {busyAction === 'zip' ? '导出中…' : '导出 ZIP'}
          </button>
        </div>
        </>
      ) : (
        <>
          <div className="recorder-log-header recorder-log-header-slim">
            <div className="recorder-log-title">
              <h2>事件日志</h2>
              <p className="recorder-log-summary">{summaryText}</p>
            </div>
            <div className="meta-tags">
              <span className="meta-tag">
                <strong>会话</strong>
                <span>{selectedSession ? '已绑定' : '无'}</span>
              </span>
              <span className="meta-tag">
                <strong>条数</strong>
                <span>{filteredEvents.length}</span>
              </span>
              <span className="meta-tag">
                <strong>操作</strong>
                <span>{countByCategory.operation}</span>
              </span>
            </div>
          </div>

          <div className="recorder-log-toolbar">
            <div className="recorder-log-filters">
              <select
                className="recorder-log-select"
                value={selectedSessionId ?? ''}
                onChange={(event) => { void handleSelectSession(event.target.value); }}
                disabled={commandBusy || sessions.length === 0}
              >
                {sessions.length === 0 ? <option value="">暂无录像</option> : null}
                {sessions.map((session) => (
                  <option key={session.sessionId} value={session.sessionId}>
                    {(session.name?.trim() || session.sessionId)}
                    {' · '}
                    {formatStatus(session)}
                  </option>
                ))}
              </select>

              <select
                className="recorder-log-select recorder-log-select-short"
                value={filter}
                onChange={(event) => { setFilter(event.target.value as EventLogFilter); }}
              >
                <option value="all">全部</option>
                <option value="recording">录制</option>
                <option value="operation">操作</option>
                <option value="system">系统</option>
                <option value="app">应用</option>
              </select>

              <input
                className="recorder-log-search"
                type="search"
                value={keyword}
                placeholder="筛选日志内容"
                onChange={(event) => { setKeyword(event.target.value); }}
              />
            </div>

            <div className="recorder-log-actions">
              <button type="button" className="btn btn-ghost btn-sm" disabled={commandBusy} onClick={() => { void handleRefresh(); }}>
                {busyAction === 'refresh' ? '刷新中…' : '刷新'}
              </button>
              <button
                className={`btn btn-secondary btn-sm${busyAction === 'zip' ? ' is-loading' : ''}`}
                disabled={commandBusy || !selectedSession}
                onClick={() => { handlePrepareExport('zip'); }}
                aria-busy={busyAction === 'zip'}
              >
                {busyAction === 'zip' ? '导出 ZIP 中…' : '导出 ZIP'}
              </button>
              <button
                className={`btn btn-ghost btn-sm${busyAction === 'directory' ? ' is-loading' : ''}`}
                disabled={commandBusy || !selectedSession}
                onClick={() => { handlePrepareExport('directory'); }}
                aria-busy={busyAction === 'directory'}
              >
                {busyAction === 'directory' ? '导出目录中…' : '导出目录'}
              </button>
            </div>
          </div>
        </>
      )}

      {exportBusy ? (
        <div className="recorder-log-export-tip is-pending" role="status" aria-live="polite">
          {exportStatusText}
        </div>
      ) : null}

      <EvidenceExportPanel
        session={selectedSession}
        events={events}
        videoSegments={props.videoSegments}
        outputMode={pendingExportMode}
        outputPath="确认后选择导出位置"
        privacyRulesActive={props.privacyRulesActive}
        busy={exportBusy}
        result={evidenceExportResult}
        suggestedZipFileName={buildSuggestedZipFileName(selectedSession)}
        onConfirmExport={handleConfirmExport}
        onCancel={handleCancelExport}
      />

            <div
        className={isCompact ? 'fluid-timeline-list' : 'event-timeline'}
        role="log"
        aria-live="polite"
        aria-label={isCompact ? '实时事件流' : '事件时间线'}
      >
        {loading ? (
          <div className="event-timeline-empty">正在加载事件…</div>
        ) : filteredEvents.length === 0 ? (
          <div className="event-timeline-empty">
            {selectedSession ? '当前筛选条件下没有事件。' : '开始录制后，这里会以时间线形式显示操作和系统事件。'}
          </div>
        ) : isCompact ? (
          timelineItems.filter((item) => {
            if (!defectOnly) {
              return true;
            }
            const event = item.event;
            const tone = item.tone || (event ? resolveEventTone(event) : 'operation');
            return tone === 'danger';
          }).map((item) => {
            const event = item.event;
            const tone = item.tone || (event ? resolveEventTone(event) : 'operation');
            const active = event ? selectedEventId === event.eventId : false;
            const flagged = tone === 'danger';
            return (
              <button
                key={item.key}
                type="button"
                className={`mini-event-row${flagged ? ' is-flagged' : ''}${active ? ' is-active' : ''}`}
                onClick={() => {
                  if (event) {
                    handleSelectEvent(event);
                  } else {
                    onPlaybackFocusChange?.({
                      eventId: item.key,
                      sessionId: selectedSessionId ?? undefined,
                      occurredAtMs: item.occurredAtMs,
                    } as any);
                  }
                }}
                aria-current={active ? 'true' : undefined}
              >
                <div className="mini-event-meta">
                  <span className={flagged ? 'is-flagged-label' : undefined}>
                    {compactEventBadge(item.badge, tone)}
                  </span>
                  <time dateTime={new Date(item.occurredAtMs).toISOString()}>
                    {formatTimeOfDay(item.occurredAtMs)}
                  </time>
                </div>
                <div className="mini-event-text">{item.title}</div>
              </button>
            );
          })
        ) : (
          <ol className="event-timeline-list">
            {timelineItems.map((item, index) => {
              const event = item.event;
              const detail = event ? resolveEventDetail(event) : null;
              const tone = item.tone || (event ? resolveEventTone(event) : 'operation');
              const active = event ? selectedEventId === event.eventId : false;
              return (
                <li key={item.key} className={`event-timeline-item-wrap kind-${item.kind}`}>
                  <button
                    type="button"
                    className={`event-timeline-item tone-${tone}${active ? ' is-active' : ''}`}
                    onClick={() => {
                      if (event) {
                        handleSelectEvent(event);
                      } else {
                        onPlaybackFocusChange?.({
                          eventId: item.key,
                          sessionId: selectedSessionId ?? undefined,
                          occurredAtMs: item.occurredAtMs,
                        } as any);
                      }
                    }}
                    aria-current={active ? 'true' : undefined}
                  >
                    <span className="event-timeline-rail" aria-hidden="true">
                      <span className={`event-timeline-dot tone-${tone}`} />
                      {index < timelineItems.length - 1 ? <span className="event-timeline-line" /> : null}
                    </span>
                    <span className="event-timeline-card">
                      <span className="event-timeline-meta">
                        <time className="event-timeline-time" dateTime={new Date(item.occurredAtMs).toISOString()}>
                          {formatDateTime(item.occurredAtMs)}
                        </time>
                        <span className={`event-timeline-badge tone-${tone}`}>
                          {item.badge}
                        </span>
                      </span>
                      <span className="event-timeline-title">{item.title}</span>
                      {detail ? <span className="event-timeline-detail">{detail}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </aside>
  );
}
