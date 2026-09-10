import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('examples/desktop/src-react');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}
function write(rel, content) {
  fs.writeFileSync(path.join(root, rel), content, 'utf8');
  console.log('wrote', rel);
}

// ---------- PlaybackStage: event markers on continuous seek ----------
{
  let t = read('components/RecorderPlaybackStage.tsx');

  if (!t.includes('TestSessionTimelineEvent')) {
    t = t.replace(
      'TestSessionVideoStream,\n} from',
      'TestSessionVideoStream,\n  TestSessionTimelineEvent,\n} from',
    );
  }

  if (!t.includes('timelineEvents')) {
    t = t.replace(
      'playbackFocus?: TestSessionPlaybackFocus | null;\n};',
      `playbackFocus?: TestSessionPlaybackFocus | null;
  timelineEvents?: TestSessionTimelineEvent[];
  onEventMarkerSelect?: (event: TestSessionTimelineEvent) => void;
};`,
    );
  }

  if (!t.includes('mapEventToGlobalPlaybackMs')) {
    const helper = `
function mapEventToGlobalPlaybackMs(
  eventMs: number,
  segments: ContinuousPlaybackSegment[],
): number | null {
  if (segments.length === 0) {
    return null;
  }
  for (const segment of segments) {
    if (eventMs >= segment.startedAtMs && eventMs <= Math.max(segment.endedAtMs, segment.startedAtMs)) {
      return segment.accumulatedStartMs + Math.max(0, eventMs - segment.startedAtMs);
    }
  }
  let best = segments[0];
  let bestDelta = Math.abs(eventMs - best.startedAtMs);
  for (const segment of segments) {
    const delta = Math.abs(eventMs - segment.startedAtMs);
    if (delta < bestDelta) {
      best = segment;
      bestDelta = delta;
    }
  }
  return best.accumulatedStartMs + Math.max(0, eventMs - best.startedAtMs);
}

function resolveEventMarkerLabel(event: TestSessionTimelineEvent): string {
  if (event.title?.trim()) return event.title.trim();
  if (event.message?.trim()) return event.message.trim();
  if (event.action?.trim()) return event.action.trim();
  return event.eventType || '事件';
}

`;
    t = t.replace(
      'type ContinuousPlaybackSegment = TestSessionVideoSegment & {\n  accumulatedStartMs: number;\n  accumulatedEndMs: number;\n};\n',
      'type ContinuousPlaybackSegment = TestSessionVideoSegment & {\n  accumulatedStartMs: number;\n  accumulatedEndMs: number;\n};\n' + helper,
    );
  }

  if (!t.includes('eventMarkers')) {
    t = t.replace(
      '}, [activeStreamId, playableSegments]);\n\n  const selectedStream = useMemo(() => {',
      `}, [activeStreamId, playableSegments]);

  const eventMarkers = useMemo(() => {
    const events = props.timelineEvents ?? [];
    if (events.length === 0 || continuousSegments.length === 0) {
      return [] as Array<{ eventId: string; globalMs: number; label: string; category: string }>;
    }
    const markers: Array<{ eventId: string; globalMs: number; label: string; category: string }> = [];
    for (const event of events) {
      if (!event?.eventId || !event.occurredAtMs) continue;
      const category = event.logCategory || 'system';
      if (category !== 'operation' && category !== 'recording' && event.eventType !== 'step_captured') {
        continue;
      }
      const globalMs = mapEventToGlobalPlaybackMs(event.occurredAtMs, continuousSegments);
      if (globalMs == null) continue;
      markers.push({
        eventId: event.eventId,
        globalMs,
        label: resolveEventMarkerLabel(event),
        category,
      });
    }
    if (markers.length > 80) {
      const step = Math.ceil(markers.length / 80);
      return markers.filter((_, index) => index % step === 0);
    }
    return markers;
  }, [continuousSegments, props.timelineEvents]);

  const selectedStream = useMemo(() => {`,
    );
  }

  if (!t.includes('recorder-stage-seek-track')) {
    const oldSeek = `                  {!isFullscreen ? (
                    <input
                      className="recorder-stage-inline-seek"
                      type="range"
                      min={0}
                      max={Math.max(totalDurationMs, 1)}
                      step={100}
                      value={Math.min(globalPlaybackMs, Math.max(totalDurationMs, 1))}
                      disabled={continuousSegments.length === 0}
                      aria-label="播放进度"
                      onChange={handleSeekBarInput}
                    />
                  ) : null}`;
    const newSeek = `                  {!isFullscreen ? (
                    <div className="recorder-stage-seek-track" aria-label="连续时间轴">
                      <div className="recorder-stage-seek-markers" aria-hidden="true">
                        {eventMarkers.map((marker) => {
                          const pct = totalDurationMs > 0 ? (marker.globalMs / totalDurationMs) * 100 : 0;
                          return (
                            <button
                              key={marker.eventId}
                              type="button"
                              className={\`recorder-stage-seek-marker cat-\${marker.category}\`}
                              style={{ left: \`\${Math.min(100, Math.max(0, pct))}%\` }}
                              title={marker.label}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                seekToPlaybackTime(marker.globalMs);
                                const source = (props.timelineEvents ?? []).find((item) => item.eventId === marker.eventId);
                                if (source) {
                                  props.onEventMarkerSelect?.(source);
                                }
                              }}
                            />
                          );
                        })}
                      </div>
                      <input
                        className="recorder-stage-inline-seek"
                        type="range"
                        min={0}
                        max={Math.max(totalDurationMs, 1)}
                        step={100}
                        value={Math.min(globalPlaybackMs, Math.max(totalDurationMs, 1))}
                        disabled={continuousSegments.length === 0}
                        aria-label="播放进度"
                        onChange={handleSeekBarInput}
                      />
                    </div>
                  ) : null}`;
    if (!t.includes(oldSeek)) {
      console.warn('seek block not found exactly; trying loose replace');
    }
    t = t.replace(oldSeek, newSeek);
  }

  write('components/RecorderPlaybackStage.tsx', t);
}

// ---------- Timeline panel compact variant ----------
{
  let t = read('components/RecorderSessionTimelinePanel.tsx');
  if (!t.includes('variant?:')) {
    t = t.replace(
      'privacyRulesActive: boolean;\n};',
      `privacyRulesActive: boolean;
  /** compact: simplified continuous-timeline companion for playback page */
  variant?: 'full' | 'compact';
};`,
    );
  }

  // destructure variant
  if (!t.includes('variant = ')) {
    t = t.replace(
      'onPlaybackFocusChange,\n  } = props;',
      `onPlaybackFocusChange,
    variant = 'full',
  } = props;
  const isCompact = variant === 'compact';`,
    );
  }

  // title
  t = t.replace(
    '<h2>事件日志</h2>',
    '<h2>{isCompact ? \'连续时间线\' : \'事件日志\'}</h2>',
  );
  t = t.replace(
    'aria-label="会话事件日志"',
    'aria-label={isCompact ? \'连续时间线\' : \'会话事件日志\'}',
  );

  // compact class on aside
  t = t.replace(
    'className="recorder-log-panel recorder-log-panel-fluid"',
    'className={`recorder-log-panel recorder-log-panel-fluid${isCompact ? \' is-compact\' : \'\'}`}',
  );

  // hide search in compact - wrap search input
  if (!t.includes('!isCompact ? (') && t.includes('recorder-log-search')) {
    t = t.replace(
      `<input
            className="recorder-log-search"
            type="search"
            value={keyword}
            placeholder="筛选日志内容"
            onChange={(event) => { setKeyword(event.target.value); }}
          />`,
      `{!isCompact ? (
            <input
              className="recorder-log-search"
              type="search"
              value={keyword}
              placeholder="筛选日志内容"
              onChange={(event) => { setKeyword(event.target.value); }}
            />
          ) : null}`,
    );
  }

  // hide evidence export actions in compact mode if present
  if (t.includes('EvidenceExportPanel') && !t.includes('!isCompact && pendingExportMode')) {
    t = t.replace(
      /\{pendingExportMode \? \(/,
      '{!isCompact && pendingExportMode ? (',
    );
  }
  // hide export buttons group - look for common labels
  if (t.includes('导出证据') && !t.includes('!isCompact ? (')) {
    // optional: leave buttons; compact CSS can hide .recorder-log-export-actions
  }

  // default compact filter to operation-focused? keep all but show tip
  if (!t.includes('compact-tip')) {
    t = t.replace(
      '<p className="recorder-log-summary">{summaryText}</p>',
      `<p className="recorder-log-summary">{summaryText}</p>
          {isCompact ? <p className="recorder-log-compact-tip">点击条目可跳转回放；关键操作已同步到下方连续时间轴标记。</p> : null}`,
    );
  }

  write('components/RecorderSessionTimelinePanel.tsx', t);
}

// ---------- RecorderPage: tabs + layout ----------
{
  let t = read('pages/RecorderPage.tsx');

  // tab type
  t = t.replace(
    "useState<'main' | 'settings'>('main')",
    "useState<'main' | 'evidence' | 'settings'>('main')",
  );

  // enable dashboard also on evidence tab
  t = t.replace(
    'enabled: activeTab === \'main\',',
    "enabled: activeTab === 'main' || activeTab === 'evidence',",
  );

  // insert evidence tab button after main tab
  if (!t.includes('tab-evidence')) {
    t = t.replace(
      `              >
                录制
              </button>
              <button
                type="button"
                role="tab"
                id="tab-settings"`,
      `              >
                录制
              </button>
              <button
                type="button"
                role="tab"
                id="tab-evidence"
                aria-selected={activeTab === 'evidence'}
                aria-controls="panel-evidence"
                className={\`app-tab \${activeTab === 'evidence' ? 'active' : ''}\`}
                onClick={() => setActiveTab('evidence')}
              >
                缺陷证据
              </button>
              <button
                type="button"
                role="tab"
                id="tab-settings"`,
    );
  }

  // show recording controls also on evidence tab? keep only on main - ok

  // Pass events to playback + compact timeline + remove defect from main
  if (!t.includes('timelineEvents={dashboard.events}')) {
    t = t.replace(
      `                      <RecorderPlaybackStage
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
                      />`,
      `                      <RecorderPlaybackStage
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
                        onEventMarkerSelect={(event) => {
                          setPlaybackFocus({
                            eventId: event.eventId,
                            sessionId: event.sessionId,
                            occurredAtMs: event.occurredAtMs,
                            displayId: event.displayId,
                          });
                        }}
                      />`,
    );
  }

  // compact timeline + remove DefectEvidencePanel from main
  t = t.replace(
    `                    <RecorderSessionTimelinePanel
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
                    />
                    <DefectEvidencePanel
                      session={dashboard.selectedSession ?? dashboard.activeSession}
                      isRecording={runtime.isRecording}
                      onPlaybackFocusChange={setPlaybackFocus}
                      onError={setError}
                      toUiErrorMessage={toUiErrorMessage}
                    />`,
    `                    <RecorderSessionTimelinePanel
                      variant="compact"
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
                    />`,
  );

  // also remove partial if different whitespace already applied once
  if (t.includes('<DefectEvidencePanel') && t.includes('panel-main')) {
    // remove any remaining DefectEvidencePanel in main area via regex between primary stack end and settings
    t = t.replace(/\n\s*<DefectEvidencePanel[\s\S]*?\/>\s*/g, '\n');
  }

  // add evidence panel tab content before settings panel
  if (!t.includes('panel-evidence')) {
    t = t.replace(
      `{activeTab === 'settings' ? (`,
      `{activeTab === 'evidence' ? (
              <section
                className="app-tab-panel app-tab-panel-evidence"
                role="tabpanel"
                id="panel-evidence"
                aria-labelledby="tab-evidence"
              >
                <div className="defect-evidence-workspace">
                  <header className="defect-evidence-workspace-header">
                    <div>
                      <h2>缺陷证据工作台</h2>
                      <p>标记缺陷、聚合步骤、复制复现说明并导出证据包。不占用录像回放主视图空间。</p>
                    </div>
                    <div className="defect-evidence-session-select">
                      <label>
                        <span>会话</span>
                        <select
                          value={dashboard.selectedSessionId ?? ''}
                          onChange={(event) => {
                            if (event.target.value) {
                              dashboard.selectSession(event.target.value);
                            }
                          }}
                          disabled={dashboard.sessions.length === 0}
                        >
                          {dashboard.sessions.length === 0 ? (
                            <option value="">暂无录像会话</option>
                          ) : null}
                          {dashboard.sessions.map((session) => (
                            <option key={session.sessionId} value={session.sessionId}>
                              {(session.name?.trim() || session.sessionId)} · {session.status}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </header>
                  <DefectEvidencePanel
                    session={dashboard.selectedSession ?? dashboard.activeSession}
                    isRecording={runtime.isRecording}
                    onPlaybackFocusChange={setPlaybackFocus}
                    onError={setError}
                    toUiErrorMessage={toUiErrorMessage}
                  />
                </div>
              </section>
            ) : null}

            {activeTab === 'settings' ? (`,
    );
  }

  // tabbar aside: show status on evidence too
  t = t.replace(
    '{activeTab === \'main\' ? (',
    "{activeTab === 'main' || activeTab === 'evidence' ? (",
  );

  write('pages/RecorderPage.tsx', t);
}

// ---------- CSS ----------
{
  const cssPath = path.join(root, 'styles/evidence.css');
  let css = fs.readFileSync(cssPath, 'utf8');
  if (!css.includes('defect-evidence-workspace')) {
    css += `

/* Defect workspace tab */
.app-tab-panel-evidence {
  min-height: 0;
  height: 100%;
  overflow: auto;
  padding: 12px 14px 18px;
}
.defect-evidence-workspace {
  max-width: 1100px;
  margin: 0 auto;
  display: grid;
  gap: 12px;
}
.defect-evidence-workspace-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  flex-wrap: wrap;
}
.defect-evidence-workspace-header h2 {
  margin: 0 0 4px;
  font-size: 16px;
}
.defect-evidence-workspace-header p {
  margin: 0;
  opacity: 0.75;
  font-size: 12px;
}
.defect-evidence-session-select label {
  display: grid;
  gap: 4px;
  font-size: 12px;
}
.defect-evidence-session-select select {
  min-width: 240px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.14));
  background: transparent;
  color: inherit;
  padding: 6px 8px;
}

/* Compact continuous timeline companion */
.recorder-log-panel.is-compact {
  min-width: 0;
}
.recorder-log-panel.is-compact .recorder-log-header {
  padding-bottom: 6px;
}
.recorder-log-panel.is-compact .recorder-log-summary {
  font-size: 11px;
}
.recorder-log-compact-tip {
  margin: 4px 0 0;
  font-size: 11px;
  opacity: 0.7;
}
.recorder-log-panel.is-compact .event-timeline-detail {
  display: none;
}
.recorder-log-panel.is-compact .recorder-log-export-actions,
.recorder-log-panel.is-compact .recorder-log-export-tip {
  display: none;
}

/* Continuous seek track with event markers */
.recorder-stage-seek-track {
  position: relative;
  flex: 1 1 auto;
  min-width: 120px;
  display: flex;
  align-items: center;
}
.recorder-stage-seek-markers {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 0;
  pointer-events: none;
  z-index: 2;
}
.recorder-stage-seek-marker {
  position: absolute;
  top: 0;
  width: 8px;
  height: 8px;
  margin-left: -4px;
  margin-top: -4px;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.55);
  background: #38bdf8;
  padding: 0;
  pointer-events: auto;
  cursor: pointer;
}
.recorder-stage-seek-marker.cat-operation {
  background: #22c55e;
}
.recorder-stage-seek-marker.cat-recording {
  background: #f59e0b;
}
.recorder-stage-seek-marker:hover {
  transform: scale(1.25);
}
.recorder-stage-seek-track .recorder-stage-inline-seek {
  width: 100%;
  position: relative;
  z-index: 1;
}
`;
    fs.writeFileSync(cssPath, css, 'utf8');
    console.log('css updated');
  }
}

console.log('UI refactor done');
