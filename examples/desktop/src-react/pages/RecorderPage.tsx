import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';

import type {
  RecorderConfigPayload,
  RecorderTuningProfile,
  TestSessionDisplayTarget,
  TestSessionPlaybackFocus,
  TestSessionState,
} from '../../types/contracts';
import type { ConfigApplyFeedback } from '../components/RecorderControlPanel';
import { RecorderPlaybackStage } from '../components/RecorderPlaybackStage';
import { RecorderSessionTimelinePanel } from '../components/RecorderSessionTimelinePanel';
import { RecordingReviewPanel } from '../features/evidence/RecordingReviewPanel';
import { SettingsWorkspace } from '../features/settings/SettingsWorkspace';
import { useRecorderBootstrap } from '../hooks/useRecorderBootstrap';
import { useRecorderDashboardSnapshot } from '../hooks/useRecorderDashboardSnapshot';
import { useRecorderRuntime } from '../hooks/useRecorderRuntime';
import { useTuningAdvisor } from '../hooks/useTuningAdvisor';
import { useTheme } from '../hooks/useTheme';
import {
  createRecorderRuntimeInput,
  createTuningAdvisorInput,
  isSemanticRecordingEnabled,
} from '../lib/recorder-page-bindings';
import { DEFAULT_CONFIG } from '../lib/tuning-advisor';
import { toUiErrorMessage } from '../lib/ui-error';
import { resolveVideoEncoderSummary } from '../lib/video-encoder-summary';

const IDLE_CONFIG_APPLY_FEEDBACK: ConfigApplyFeedback = {
  status: 'idle',
  message: '参数调整后，可保存并应用到当前录制内核。',
};

function formatElapsedClock(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatSessionListTime(timestampMs: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestampMs));
}

function formatSessionDuration(session: TestSessionState): string {
  const end = session.endedAtMs ?? (session.status === 'active' ? Date.now() : session.updatedAtMs);
  const durationMs = Math.max(0, end - session.startedAtMs);
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h${remainder}m` : `${hours}h`;
}

export function RecorderPage() {
  const theme = useTheme();
  const [activeTab, setActiveTab] = useState<'main' | 'evidence' | 'settings'>('main');
  const [config, setConfig] = useState<RecorderConfigPayload>(DEFAULT_CONFIG);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [configApplyFeedback, setConfigApplyFeedback] = useState<ConfigApplyFeedback>(IDLE_CONFIG_APPLY_FEEDBACK);
  const [playbackFocus, setPlaybackFocus] = useState<TestSessionPlaybackFocus | null>(null);
  const [availableDisplays, setAvailableDisplays] = useState<TestSessionDisplayTarget[]>([]);
  const [displaysLoading, setDisplaysLoading] = useState(true);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [historySelection, setHistorySelection] = useState<string[]>([]);
  const toastTimerRef = useRef<number | null>(null);
  const noopHydrateFromSettings = useCallback(() => {}, []);

  const runtime = useRecorderRuntime(createRecorderRuntimeInput({
    config,
    toUiErrorMessage,
    setError,
  }));

  const tuning = useTuningAdvisor(createTuningAdvisorInput({
    config,
    setConfig,
    metrics: runtime.metrics,
    toUiErrorMessage,
    setError,
  }));

  useRecorderBootstrap({
    setConfig,
    setMetrics: runtime.setMetrics,
    hydrateTuningFromSettings: tuning.hydrateFromSettings,
    hydrateBenchmarkFromSettings: noopHydrateFromSettings,
    hydrateQueueFromSettings: noopHydrateFromSettings,
    setError,
    toUiErrorMessage,
  });

  const dashboard = useRecorderDashboardSnapshot({
    enabled: activeTab === 'main' || activeTab === 'evidence',
    isRecording: runtime.isRecording,
    playbackFocus,
    onError: setError,
    toUiErrorMessage,
  });

  const encoderSummary = resolveVideoEncoderSummary({
    streams: dashboard.videoStreams,
    segments: dashboard.recentSegments,
  });
  const semanticRecordingEnabled = isSemanticRecordingEnabled(config);
  const elapsedMsRef = useRef(0);
  const lastElapsedTickRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  function showToast(message: string): void {
    setToastMessage(message);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage((current) => (current === message ? null : current));
      toastTimerRef.current = null;
    }, 2600);
  }

  async function runBusyTask(task: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError('');
    try {
      await task();
      return true;
    } catch (error) {
      setError(toUiErrorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleStart(): Promise<boolean> {
    return runBusyTask(async () => {
      await runtime.startRecording();
    });
  }

  async function handleStop(): Promise<boolean> {
    return runBusyTask(async () => {
      await runtime.stopRecording();
    });
  }

  async function handleHideToTray(): Promise<void> {
    await runBusyTask(async () => {
      await runtime.hideToTray();
    });
  }

  async function handleRecPillClick(): Promise<void> {
    if (busy) {
      return;
    }
    if (!runtime.isRecording) {
      if (await handleStart()) {
        showToast('已开始新录制会话');
      }
      return;
    }
    if (runtime.isPaused) {
      if (await runBusyTask(runtime.resumeRecording)) {
        showToast('录制已继续');
      }
      return;
    }
    if (await runBusyTask(runtime.pauseRecording)) {
      showToast('录制已暂停');
    }
  }

  async function handleApplyConfig(): Promise<void> {
    setBusy(true);
    setError('');
    setConfigApplyFeedback({
      status: 'saving',
      message: '正在保存配置并同步到录制内核...',
    });
    try {
      await runtime.applyConfig();
      setConfigApplyFeedback({
        status: 'success',
        message: '配置已保存并应用到录制内核。',
      });
      showToast('配置已成功保存并同步至录制内核');
    } catch (applyError) {
      const message = toUiErrorMessage(applyError);
      setConfigApplyFeedback({
        status: 'error',
        message: `配置保存失败：${message}`,
      });
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleAutoApply(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    await runBusyTask(async () => {
      await tuning.toggleAutoApply(event.target.checked);
    });
  }

  async function handleApplyProfile(profile: RecorderTuningProfile): Promise<void> {
    await runBusyTask(async () => {
      await tuning.applyProfile(profile);
    });
  }

  useEffect(() => {
    if (!runtime.isRecording) {
      elapsedMsRef.current = 0;
      lastElapsedTickRef.current = null;
      setElapsedMs(0);
      return;
    }

    if (elapsedMsRef.current === 0 && dashboard.activeSession?.startedAtMs) {
      elapsedMsRef.current = Math.max(0, Date.now() - dashboard.activeSession.startedAtMs);
      setElapsedMs(elapsedMsRef.current);
    }

    if (runtime.isPaused) {
      lastElapsedTickRef.current = null;
      return;
    }

    lastElapsedTickRef.current = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      const last = lastElapsedTickRef.current ?? now;
      elapsedMsRef.current += now - last;
      lastElapsedTickRef.current = now;
      setElapsedMs(elapsedMsRef.current);
    }, 250);

    return () => {
      window.clearInterval(timer);
    };
  }, [dashboard.activeSession?.startedAtMs, runtime.isPaused, runtime.isRecording]);

  useEffect(() => {
    if (configApplyFeedback.status !== 'success') {
      return () => undefined;
    }

    const timer = window.setTimeout(() => {
      setConfigApplyFeedback(IDLE_CONFIG_APPLY_FEEDBACK);
    }, 2600);

    return () => {
      clearTimeout(timer);
    };
  }, [configApplyFeedback.status]);

  useEffect(() => {
    let disposed = false;

    const loadDisplays = async (): Promise<void> => {
      if (!window.reqcaseShadowRecorder.listAvailableDisplays) {
        if (!disposed) {
          setAvailableDisplays([]);
          setDisplaysLoading(false);
        }
        return;
      }

      setDisplaysLoading(true);
      try {
        const displays = await window.reqcaseShadowRecorder.listAvailableDisplays();
        if (!disposed) {
          setAvailableDisplays(displays);
        }
      } catch (loadError) {
        console.warn('[shadow-recorder] failed to enumerate displays', loadError);
        if (!disposed) {
          setAvailableDisplays([]);
        }
      } finally {
        if (!disposed) {
          setDisplaysLoading(false);
        }
      }
    };

    void loadDisplays();

    return () => {
      disposed = true;
    };
  }, [activeTab]);

  useEffect(() => {
    const unbindStart = window.reqcaseShadowRecorder.onActionStart(() => {
      if (!runtime.isRecording && !busy) {
        void handleStart();
      }
    });
    const unbindStop = window.reqcaseShadowRecorder.onActionStop(() => {
      if (runtime.isRecording && !busy) {
        void handleStop();
      }
    });

    return () => {
      unbindStart();
      unbindStop();
    };
  }, [busy, runtime.isRecording]);

  useEffect(() => () => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const validIds = new Set(dashboard.sessions.map((session) => session.sessionId));
    setHistorySelection((current) => {
      const next = current.filter((id) => validIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [dashboard.sessions]);

  const recPillState = !runtime.isRecording ? 'idle' : runtime.isPaused ? 'paused' : 'recording';
  const recPillLabel = !runtime.isRecording
    ? '待机就绪'
    : runtime.isPaused
      ? '已暂停'
      : formatElapsedClock(elapsedMs);
  const recPillAction = !runtime.isRecording
    ? '开始录制'
    : runtime.isPaused
      ? '继续录制'
      : '暂停录制';
  const reviewCount = dashboard.events.length;
  const captureLatencyMs = runtime.metrics?.lastCaptureLatencyMs;
  const droppedTotal = runtime.metrics?.droppedStepsTotal ?? 0;
  const capturedTotal = runtime.metrics?.capturedStepsTotal ?? 0;
  const dropRate = capturedTotal > 0 ? (droppedTotal / capturedTotal) * 100 : 0;
  const telemetryHealthy = dropRate < 1 && (captureLatencyMs == null || captureLatencyMs < 20);
  const backendLabel = runtime.metrics
    ? runtime.metrics.wgcCaptureCount > 0 && runtime.metrics.dxgiCaptureCount > 0
      ? 'DXGI/WGC'
      : runtime.metrics.wgcCaptureCount > 0
        ? 'WGC'
        : runtime.metrics.dxgiCaptureCount > 0
          ? 'DXGI'
          : '--'
    : '--';
  const historicalSessionIds = dashboard.sessions
    .filter((session) => session.status !== 'active' && session.status !== 'paused')
    .map((session) => session.sessionId);
  const selectedHistoricalIds = historySelection.filter((id) => historicalSessionIds.includes(id));
  const allHistoricalSelected = historicalSessionIds.length > 0
    && selectedHistoricalIds.length === historicalSessionIds.length;

  return (
    <main className="layout scheme-b-final">
      <section className="workspace-shell workspace-shell-mvp">
        <div className="app-shell">
          <div className="app-tabbar">
            <div className="header-left">
              <div className="app-brand-lockup" aria-label="影子录制器">
                <span className="app-brand-mark" aria-hidden="true">S</span>
                <span className="app-brand-copy">
                  <strong>影子录制器</strong>
                </span>
              </div>
            </div>
            <nav className="app-tabs header-center-capsule" role="tablist" aria-label="主功能切换">
              <button
                type="button"
                role="tab"
                id="tab-main"
                aria-selected={activeTab === 'main'}
                aria-controls="panel-main"
                className={`app-tab capsule-tab ${activeTab === 'main' ? 'active' : ''}`}
                onClick={() => setActiveTab('main')}
              >
                📹 录制工作台
              </button>
              <button
                type="button"
                role="tab"
                id="tab-evidence"
                aria-selected={activeTab === 'evidence'}
                aria-controls="panel-evidence"
                className={`app-tab capsule-tab ${activeTab === 'evidence' ? 'active' : ''}`}
                onClick={() => setActiveTab('evidence')}
              >
                📑 记录与回顾
                {reviewCount > 0 ? <span className="capsule-badge">{reviewCount}</span> : null}
              </button>
              <button
                type="button"
                role="tab"
                id="tab-settings"
                aria-selected={activeTab === 'settings'}
                aria-controls="panel-settings"
                className={`app-tab capsule-tab ${activeTab === 'settings' ? 'active' : ''}`}
                onClick={() => setActiveTab('settings')}
              >
                ⚙️ 偏好设置
              </button>
            </nav>
            <div className="app-tabbar-aside header-right">
              {activeTab === 'settings' ? (
                <div className="app-tabbar-actions" role="toolbar" aria-label="配置操作">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm apply-config-btn-top"
                    disabled={busy}
                    onClick={() => { void handleApplyConfig(); }}
                  >
                    {configApplyFeedback.status === 'saving'
                      ? '应用中...'
                      : configApplyFeedback.status === 'success'
                        ? '已保存'
                        : '保存并应用配置'}
                  </button>
                  {configApplyFeedback.status !== 'idle' ? (
                    <span
                      className={`apply-config-status-top is-${configApplyFeedback.status}`}
                      role="status"
                      aria-live="polite"
                    >
                      {configApplyFeedback.message}
                    </span>
                  ) : null}
                </div>
              ) : (
                <div className="app-tabbar-status" role="toolbar" aria-label="录制状态">
                  <button
                    type="button"
                    className={`rec-pill-state rec-pill-indicator is-${recPillState}`}
                    disabled={busy}
                    title={`点击${recPillAction}`}
                    aria-label={recPillAction}
                    onClick={() => { void handleRecPillClick(); }}
                  >
                    <span className="rec-pill-dot" aria-hidden="true" />
                    <span className="rec-pill-time">{recPillLabel}</span>
                  </button>
                  <button
                    type="button"
                    className="action-btn-sm app-island-pin"
                    disabled={busy}
                    title="唤起悬浮岛"
                    aria-label="唤起悬浮岛"
                    onClick={() => {
                      showToast('已唤起桌面极简透明悬浮窗');
                      void handleHideToTray();
                    }}
                  >
                    📌 悬浮窗
                  </button>
                  {runtime.isRecording ? (
                    <button
                      type="button"
                      className="action-btn-sm action-btn-danger"
                      disabled={busy}
                      onClick={() => {
                        void handleStop().then((ok) => {
                          if (ok) {
                            showToast('录制已停止，最近切片已自动入库');
                          }
                        });
                      }}
                    >
                      ⏹ 停止
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="action-btn-sm action-btn-start"
                      disabled={busy}
                      onClick={() => {
                        void handleStart().then((ok) => {
                          if (ok) {
                            showToast('已开始新录制会话');
                          }
                        });
                      }}
                    >
                      ▶ 开始
                    </button>
                  )}
                </div>
              )}

              <button
                type="button"
                className="theme-toggle theme-toggle-end action-btn-sm"
                onClick={theme.cycleMode}
                title={`当前主题：${theme.label}（点击切换）`}
                aria-label={`切换主题，当前为${theme.label}`}
              >
                <span className={`theme-toggle-swatch is-${theme.resolved}`} aria-hidden="true" />
                <span>{theme.label}</span>
              </button>
            </div>
          </div>

          <div className="app-tab-panels">
            {activeTab === 'main' ? (
              <section
                className="app-tab-panel app-tab-panel-main"
                role="tabpanel"
                id="panel-main"
                aria-labelledby="tab-main"
              >
                <div className="recorder-main-shell recorder-main-shell-mvp recorder-main-shell-fill">
                  <div className="recorder-workbench-grid">
                    <div className="recorder-primary-stack">
                      <RecorderPlaybackStage
                        isRecording={runtime.isRecording}
                        isPaused={runtime.isPaused}
                        metrics={runtime.metrics}
                        resourceUsage={runtime.resourceUsage}
                        activeSession={dashboard.activeSession}
                        playbackSession={dashboard.playbackSession}
                        videoStreams={dashboard.videoStreams}
                        recentSegments={dashboard.recentSegments}
                        matchedSegments={dashboard.matchedSegments}
                        playbackFocus={playbackFocus}
                        timelineEvents={dashboard.events}
                        onNotice={showToast}
                        onMarked={() => { void dashboard.refresh(); }}
                      />
                    </div>

                    <aside className="workbench-side-col">
                      <div className="side-card">
                        <div className="side-card-title">
                          <span>实时遥测与负载</span>
                          <span className={telemetryHealthy ? 'tele-health is-good' : 'tele-health is-warn'}>
                            ● {telemetryHealthy ? '良好' : '关注'}
                          </span>
                        </div>
                        <div className="tele-grid">
                          <div className="tele-box">
                            <span className="tele-kicker">捕获延迟</span>
                            <span className="tele-num tele-accent">
                              {typeof captureLatencyMs === 'number' ? `${captureLatencyMs.toFixed(1)} ms` : '--'}
                            </span>
                          </div>
                          <div className="tele-box">
                            <span className="tele-kicker">丢帧率</span>
                            <span className="tele-num tele-ok">{dropRate.toFixed(2)}%</span>
                          </div>
                          <div className="tele-box">
                            <span className="tele-kicker">内存占用</span>
                            <span className="tele-num">
                              {typeof runtime.resourceUsage?.totalWorkingSetMb === 'number'
                                ? `${Math.round(runtime.resourceUsage.totalWorkingSetMb)} MB`
                                : '--'}
                            </span>
                          </div>
                          <div className="tele-box">
                            <span className="tele-kicker">后端引擎</span>
                            <span className="tele-num">{backendLabel}</span>
                          </div>
                        </div>
                      </div>
                      <RecorderSessionTimelinePanel
                        variant="compact"
                        defectEvidenceEnabled={semanticRecordingEnabled}
                        sessions={dashboard.sessions}
                        selectedSession={dashboard.selectedSession}
                        selectedSessionId={dashboard.selectedSessionId}
                        events={dashboard.events}
                        videoSegments={dashboard.recentSegments}
                        loading={dashboard.loading}
                        onRefresh={() => dashboard.refresh()}
                        onSelectSession={dashboard.selectSession}
                        onError={setError}
                        toUiErrorMessage={toUiErrorMessage}
                        onPlaybackFocusChange={setPlaybackFocus}
                        privacyRulesActive={!!config.privacyEnabled}
                        onClearEvents={async () => {
                          await dashboard.clearEvents();
                          showToast('已清除当前事件流');
                        }}
                      />
                    </aside>
                  </div>
                </div>
              </section>
            ) : null}

            {activeTab === 'evidence' ? (
              <section
                className="app-tab-panel app-tab-panel-evidence"
                role="tabpanel"
                id="panel-evidence"
                aria-labelledby="tab-evidence"
              >
                <div className="evidence-layout-b">
                  <aside className="evidence-session-rail" aria-label="录制会话列表">
                    <div className="evidence-session-rail-title">录制会话列表</div>
                    {historicalSessionIds.length > 0 ? (
                        <div className="evidence-session-toolbar">
                          <label className="evidence-session-check">
                            <input
                              type="checkbox"
                              checked={allHistoricalSelected}
                              onChange={(event) => {
                                setHistorySelection(event.target.checked ? historicalSessionIds : []);
                              }}
                            />
                            全选历史
                          </label>
                          <button
                            type="button"
                            className="action-btn-sm action-btn-danger"
                            disabled={selectedHistoricalIds.length === 0 || busy}
                            onClick={() => {
                              void dashboard.deleteSessions(selectedHistoricalIds).then((result) => {
                                setHistorySelection([]);
                                showToast(
                                  result.deleted.length > 1
                                    ? `已删除 ${result.deleted.length} 条历史会话`
                                    : '已删除历史会话',
                                );
                              }).catch((error) => {
                                setError(toUiErrorMessage(error));
                              });
                            }}
                          >
                            删除所选{selectedHistoricalIds.length > 0 ? ` (${selectedHistoricalIds.length})` : ''}
                          </button>
                        </div>
                    ) : null}
                    {dashboard.sessions.length === 0 ? (
                      <div className="evidence-session-empty">暂无会话，开始录制后会显示在这里。</div>
                    ) : (
                      dashboard.sessions.map((session) => {
                        const selectedId = dashboard.selectedSessionId ?? dashboard.activeSession?.sessionId;
                        const isSelected = session.sessionId === selectedId;
                        const isLive = session.status === 'active' || session.status === 'paused';
                        const checked = historySelection.includes(session.sessionId);
                        return (
                          <div
                            key={session.sessionId}
                            className={`evidence-session-row${isSelected ? ' is-selected' : ''}${isLive ? ' is-live' : ''}`}
                          >
                            {!isLive ? (
                              <input
                                type="checkbox"
                                className="evidence-session-checkbox"
                                checked={checked}
                                aria-label={`选择 ${session.name?.trim() || session.sessionId}`}
                                onChange={(event) => {
                                  const nextChecked = event.target.checked;
                                  setHistorySelection((current) => {
                                    if (nextChecked) {
                                      return current.includes(session.sessionId)
                                        ? current
                                        : [...current, session.sessionId];
                                    }
                                    return current.filter((id) => id !== session.sessionId);
                                  });
                                }}
                              />
                            ) : (
                              <span className="evidence-session-checkbox-spacer" aria-hidden="true" />
                            )}
                            <button
                              type="button"
                              className="evidence-session-copy"
                              onClick={() => dashboard.selectSession(session.sessionId)}
                            >
                              <strong>
                                {session.name?.trim() || formatSessionListTime(session.startedAtMs)}
                                {isLive ? ' · LIVE' : ` · ${formatSessionDuration(session)}`}
                              </strong>
                              <span className="evidence-session-sub">
                                {isLive ? '当前录制会话' : formatSessionListTime(session.startedAtMs)}
                              </span>
                            </button>
                          </div>
                        );
                      })
                    )}
                  </aside>
                  <div className="evidence-layout-b-main">
                    <RecordingReviewPanel
                      session={dashboard.selectedSession ?? dashboard.activeSession}
                      isRecording={runtime.isRecording}
                      enabled={semanticRecordingEnabled}
                      preWindowSeconds={config.defectPreWindowSeconds}
                      postWindowSeconds={config.defectPostWindowSeconds}
                      onPlaybackFocusChange={setPlaybackFocus}
                      onError={setError}
                      toUiErrorMessage={toUiErrorMessage}
                      onOpenSettings={() => setActiveTab('settings')}
                    />
                  </div>
                </div>
              </section>
            ) : null}
            {activeTab === 'settings' ? (
              <section
                className="app-tab-panel app-tab-panel-settings settings-page"
                role="tabpanel"
                id="panel-settings"
                aria-labelledby="tab-settings"
              >
                <SettingsWorkspace
                  config={config}
                  setConfig={setConfig}
                  recommendation={tuning.recommendation}
                  profileLabels={tuning.profileLabels}
                  autoApplyRecommendedOnStartup={tuning.autoApplyRecommendedOnStartup}
                  availableDisplays={availableDisplays}
                  displaysLoading={displaysLoading}
                  onToggleAutoApply={handleToggleAutoApply}
                  onApplyProfile={handleApplyProfile}
                  busy={busy}
                  error={error}
                  applyFeedback={configApplyFeedback}
                  encoderSummary={encoderSummary}
                />
              </section>
            ) : null}
          </div>
          {toastMessage ? (
            <div className="mac-toast show" role="status" aria-live="polite">
              <span>{toastMessage}</span>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
