import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';

import type {
  RecorderConfigPayload,
  RecorderPersistedSettings,
  RecorderTuningProfile,
  TestSessionPlaybackFocus,
} from '../../types/contracts';
import { TopBar } from '../app/TopBar';
import { cloneConfig, countUnsavedConfigChanges } from '../app/config-baseline';
import {
  formatElapsedClock,
  useAvailableDisplays,
  useElapsedRecordingClock,
  useExportProgressToast,
} from '../app/recorder-page-effects';
import { ToastBanner, useToast } from '../app/toast';
import { Button } from '../ui/Button';
import { RecorderPlaybackStage } from '../components/RecorderPlaybackStage';
import { HistorySessionPanel } from '../features/evidence/HistorySessionPanel';
import { RecordingReviewPanel } from '../features/evidence/RecordingReviewPanel';
import { SessionListRail } from '../features/evidence/SessionListRail';
import {
  SettingsWorkspace,
  type ConfigApplyFeedback,
} from '../features/settings/SettingsWorkspace';
import { useRecorderBootstrap } from '../hooks/useRecorderBootstrap';
import { useRecorderDashboardSnapshot } from '../hooks/useRecorderDashboardSnapshot';
import { useRecorderRuntime } from '../hooks/useRecorderRuntime';
import { useTuningAdvisor } from '../hooks/useTuningAdvisor';
import { useTheme } from '../hooks/useTheme';
import {
  createRecorderRuntimeInput,
  createTuningAdvisorInput,
} from '../lib/recorder-page-bindings';
import { DEFAULT_CONFIG } from '../lib/tuning-advisor';
import { toUiErrorMessage } from '../lib/ui-error';
import { resolveVideoEncoderSummary } from '../lib/video-encoder-summary';

const IDLE_CONFIG_APPLY_FEEDBACK: ConfigApplyFeedback = {
  status: 'idle',
  message: '参数调整后，可保存并应用到当前录制内核。',
};

export function RecorderPage() {
  const theme = useTheme();
  const [activeTab, setActiveTab] = useState<'main' | 'evidence' | 'settings'>('main');
  const [config, setConfig] = useState<RecorderConfigPayload>(DEFAULT_CONFIG);
  const [baselineConfig, setBaselineConfig] = useState<RecorderConfigPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [configApplyFeedback, setConfigApplyFeedback] = useState<ConfigApplyFeedback>(IDLE_CONFIG_APPLY_FEEDBACK);
  const [playbackFocus, setPlaybackFocus] = useState<TestSessionPlaybackFocus | null>(null);
  const { availableDisplays, displaysLoading } = useAvailableDisplays(activeTab);
  const [historySelection, setHistorySelection] = useState<string[]>([]);
  const [selectionRevealSeq, setSelectionRevealSeq] = useState(0);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [semanticReviewSessionId, setSemanticReviewSessionId] = useState<string | null>(null);
  const { toast, showToast } = useToast(2600);
  const noopHydrateFromSettings = useCallback(() => {}, []);

  const unsavedCount = useMemo(
    () => countUnsavedConfigChanges(config, baselineConfig),
    [config, baselineConfig],
  );

  const handleConfigCommitted = useCallback((committed: RecorderConfigPayload) => {
    setBaselineConfig(cloneConfig(committed));
  }, []);

  const runtime = useRecorderRuntime({
    ...createRecorderRuntimeInput({
      config,
      toUiErrorMessage,
      setError,
    }),
    onConfigCommitted: handleConfigCommitted,
  });

  const tuning = useTuningAdvisor({
    ...createTuningAdvisorInput({
      config,
      setConfig,
      metrics: runtime.metrics,
      toUiErrorMessage,
      setError,
    }),
    onConfigCommitted: handleConfigCommitted,
  });

  const handleHydrateTuningFromSettings = useCallback(
    (settings: RecorderPersistedSettings | null | undefined) => {
      tuning.hydrateFromSettings(settings);
      setBaselineConfig(
        cloneConfig({ ...DEFAULT_CONFIG, ...(settings?.config ?? {}) }),
      );
    },
    [tuning.hydrateFromSettings],
  );

  const handleBootstrapError = useCallback((message: string) => {
    setError(message);
    setBaselineConfig((current) => current ?? cloneConfig(DEFAULT_CONFIG));
  }, []);

  useRecorderBootstrap({
    setConfig,
    setMetrics: runtime.setMetrics,
    hydrateTuningFromSettings: handleHydrateTuningFromSettings,
    hydrateBenchmarkFromSettings: noopHydrateFromSettings,
    hydrateQueueFromSettings: noopHydrateFromSettings,
    setError: handleBootstrapError,
    toUiErrorMessage,
  });

  const handleDiscardConfig = useCallback(() => {
    if (baselineConfig) {
      setConfig(cloneConfig(baselineConfig));
    }
  }, [baselineConfig]);

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

  const elapsedMs = useElapsedRecordingClock({
    isRecording: runtime.isRecording,
    isPaused: runtime.isPaused,
    startedAtMs: dashboard.activeSession?.startedAtMs,
  });

  useExportProgressToast(showToast);

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
    return runBusyTask(runtime.startRecording);
  }

  async function handleStop(): Promise<boolean> {
    return runBusyTask(runtime.stopRecording);
  }

  async function handleHideToTray(): Promise<void> {
    await runBusyTask(runtime.hideToTray);
  }

  async function handleRecPillClick(): Promise<void> {
    if (busy) return;
    if (!runtime.isRecording) {
      if (await handleStart()) showToast('已开始新录制会话');
      return;
    }
    if (runtime.isPaused) {
      if (await runBusyTask(runtime.resumeRecording)) showToast('录制已继续');
      return;
    }
    if (await runBusyTask(runtime.pauseRecording)) showToast('录制已暂停');
  }

  async function handleApplyConfig(): Promise<void> {
    setBusy(true);
    setError('');
    setConfigApplyFeedback({ status: 'saving', message: '正在保存配置并同步到录制内核...' });
    try {
      await runtime.applyConfig();
      setConfigApplyFeedback({ status: 'success', message: '配置已保存并应用到录制内核。' });
      showToast('配置已成功保存并同步至录制内核');
    } catch (applyError) {
      const message = toUiErrorMessage(applyError);
      setConfigApplyFeedback({ status: 'error', message: `配置保存失败：${message}` });
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleAutoApply(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    await runBusyTask(() => tuning.toggleAutoApply(event.target.checked));
  }

  async function handleApplyProfile(profile: RecorderTuningProfile): Promise<void> {
    await runBusyTask(() => tuning.applyProfile(profile));
  }

  useEffect(() => {
    if (configApplyFeedback.status !== 'success') return () => undefined;
    const timer = window.setTimeout(() => setConfigApplyFeedback(IDLE_CONFIG_APPLY_FEEDBACK), 2600);
    return () => clearTimeout(timer);
  }, [configApplyFeedback.status]);

  useEffect(() => {
    const unbindStart = window.reqcaseShadowRecorder.onActionStart(() => {
      if (!runtime.isRecording && !busy) void handleStart();
    });
    const unbindStop = window.reqcaseShadowRecorder.onActionStop(() => {
      if (runtime.isRecording && !busy) void handleStop();
    });
    return () => {
      unbindStart();
      unbindStop();
    };
  }, [busy, runtime.isRecording]);

  useEffect(() => {
    const validIds = new Set(dashboard.sessions.map((session) => session.sessionId));
    setHistorySelection((current) => {
      const next = current.filter((id) => validIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [dashboard.sessions]);

  const recPillState = !runtime.isRecording ? 'idle' : runtime.isPaused ? 'paused' : 'recording';
  const recPillLabel = !runtime.isRecording ? '待机就绪' : runtime.isPaused ? '已暂停' : formatElapsedClock(elapsedMs);
  const recPillAction = !runtime.isRecording ? '开始录制' : runtime.isPaused ? '继续录制' : '暂停录制';

  const semanticRecordingEnabled = config.semanticRecordingEnabled ?? !!config.defectEvidenceEnabled;
  const historySession = dashboard.selectedSession ?? dashboard.activeSession;
  const showSemanticReview = semanticReviewSessionId != null && semanticReviewSessionId === historySession?.sessionId;
  const historicalSessionIds = dashboard.sessions
    .filter((session) => session.status !== 'active' && session.status !== 'paused')
    .map((session) => session.sessionId);

  async function handleDeleteSelectedSessions(): Promise<void> {
    if (historySelection.length === 0 || busy) {
      return;
    }
    const toDelete = [...historySelection];
    setBusy(true);
    try {
      const result = await dashboard.deleteSessions(toDelete);
      if (result.skipped.length > 0) {
        setIsSelectionMode(true);
        setHistorySelection(result.skipped);
        setSelectionRevealSeq((n) => n + 1);
        showToast(
          `已删除 ${result.deleted.length} 条，${result.skipped.length} 条跳过（正在使用或只读）`,
          'warning',
        );
      } else {
        setHistorySelection([]);
        setIsSelectionMode(false);
        showToast(
          result.deleted.length > 1
            ? `已删除 ${result.deleted.length} 条历史会话`
            : '已删除历史会话',
          'success',
        );
      }
    } catch (error) {
      setError(toUiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleExportCurrentSession(options?: {
    range?: { startMs: number; endMs: number };
    clipMode?: 'precise' | 'fast';
  }): Promise<void> {
    const session = dashboard.selectedSession ?? dashboard.activeSession ?? dashboard.playbackSession;
    if (!session || !window.reqcaseShadowRecorder.exportTestSessionEvidence) {
      showToast('当前没有可导出的会话');
      return;
    }
    setBusy(true);
    try {
      const baseName = session.name?.trim() || session.sessionId;
      const bundleName = options?.range ? `${baseName}-clip` : baseName;
      await window.reqcaseShadowRecorder.exportTestSessionEvidence({
        sessionId: session.sessionId,
        outputMode: 'zip',
        bundleName,
        targetDir: '',
        zipFileName: `${bundleName}.zip`,
        privacyAcknowledgedAt: new Date().toISOString(),
        range: options?.range,
        clipMode: options?.clipMode,
      });
    } catch {
      // 完成、取消和失败只由导出进度通知显示一次。
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="layout">
      <section className="workspace-shell workspace-shell-mvp">
        <div className="app-shell">
          <TopBar
            activeTab={activeTab}
            onSelectTab={setActiveTab}
            historicalSessionCount={historicalSessionIds.length}
            recPillState={recPillState}
            recPillLabel={recPillLabel}
            recPillAction={recPillAction}
            isRecording={runtime.isRecording}
            busy={busy}
            onRecPillClick={() => {
              void handleRecPillClick();
            }}
            onStopClick={() => {
              void handleStop().then((ok) => {
                if (ok) {
                  showToast('录制已停止，最近切片已自动入库');
                }
              });
            }}
            onFloatingIslandClick={() => {
              showToast('已唤起桌面极简透明悬浮窗');
              void handleHideToTray();
            }}
            themeResolved={theme.resolved}
            themeLabel={theme.label}
            onCycleTheme={theme.cycleMode}
          />

          <div className="app-tab-panels">
            {activeTab === 'main' ? (
              <section
                className="app-tab-panel app-tab-panel-main"
                role="tabpanel"
                id="panel-main"
                aria-labelledby="tab-main"
              >
                <div className="recorder-main-shell recorder-main-shell-mvp recorder-main-shell-fill">
                  <RecorderPlaybackStage
                    isRecording={runtime.isRecording}
                    isPaused={runtime.isPaused}
                    loading={dashboard.loading}
                    metrics={runtime.metrics}
                    resourceUsage={runtime.resourceUsage}
                    activeSession={dashboard.activeSession}
                    playbackSession={dashboard.playbackSession}
                    videoStreams={dashboard.videoStreams}
                    recentSegments={dashboard.recentSegments}
                    matchedSegments={dashboard.matchedSegments}
                    playbackFocus={playbackFocus}
                    timelineEvents={dashboard.events}
                    config={config}
                    onNotice={showToast}
                    onMarked={() => { void dashboard.refresh(); }}
                    onPlaybackFocusChange={setPlaybackFocus}
                    onExportSession={handleExportCurrentSession}
                    isExporting={busy}
                    onClearEvents={async () => {
                      await dashboard.clearEvents();
                      showToast('已清除当前事件流');
                    }}
                  />
                </div>
              </section>
            ) : null}

            {activeTab === 'evidence' ? (
              <section
                data-ui-scope="review"
                role="tabpanel"
                id="panel-evidence"
                aria-labelledby="tab-evidence"
                style={{ height: '100%', minHeight: 0 }}
              >
                <div className="evidence-layout-b" style={{ display: 'flex', height: '100%', minHeight: 0, overflow: 'hidden' }}>
                  <SessionListRail
                    sessions={dashboard.sessions}
                    selectedSessionId={dashboard.selectedSessionId}
                    activeSessionId={dashboard.activeSession?.sessionId ?? null}
                    onSelectSession={dashboard.selectSession}
                    selection={historySelection}
                    selectionRevealSeq={selectionRevealSeq}
                    onSelectionChange={setHistorySelection}
                    isSelectionMode={isSelectionMode}
                    onToggleSelectionMode={setIsSelectionMode}
                    onDeleteSelected={() => {
                      void handleDeleteSelectedSessions();
                    }}
                    busy={busy}
                    onCopyNotice={showToast}
                  />
                  <div className="evidence-layout-b-main" style={{ flex: '1 1 auto', minWidth: 0, height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    {showSemanticReview ? (
                      <div className="history-semantic-review" style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '8px' }}>
                        <div style={{ padding: '8px 16px 0 16px' }}>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setSemanticReviewSessionId(null)}
                          >
                            返回历史记录
                          </Button>
                        </div>
                        <RecordingReviewPanel
                          session={historySession}
                          isRecording={runtime.isRecording}
                          enabled
                          preWindowSeconds={config.defectPreWindowSeconds}
                          postWindowSeconds={config.defectPostWindowSeconds}
                          onPlaybackFocusChange={setPlaybackFocus}
                          onError={setError}
                          toUiErrorMessage={toUiErrorMessage}
                          onMetaSaved={() => { void dashboard.refresh(); }}
                          onNotice={showToast}
                        />
                      </div>
                    ) : (
                      <HistorySessionPanel
                        session={historySession}
                        semanticEnabled={semanticRecordingEnabled}
                        onOpenSemanticReview={() => {
                          if (historySession) {
                            setSemanticReviewSessionId(historySession.sessionId);
                          }
                        }}
                        onError={setError}
                        onNotice={showToast}
                        onMetaSaved={() => { void dashboard.refresh(); }}
                      />
                    )}
                  </div>
                </div>
              </section>
            ) : null}
            {activeTab === 'settings' ? (
              <section
                role="tabpanel"
                id="panel-settings"
                aria-labelledby="tab-settings"
                style={{ height: '100%', minHeight: 0 }}
              >
                <SettingsWorkspace
                  config={config}
                  setConfig={setConfig}
                  unsavedCount={unsavedCount}
                  onApplyConfig={handleApplyConfig}
                  onDiscardConfig={handleDiscardConfig}
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
          <ToastBanner toast={toast} />
        </div>
      </section>
    </main>
  );
}
