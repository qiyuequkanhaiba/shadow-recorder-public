export type EvidenceCopyStats = {
  fileCount: number;
  byteCount: number;
};

export type EvidenceHtmlSegmentView = {
  segmentId: string;
  streamId: string;
  displayId?: string;
  relativePath: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  label: string;
  meta: string;
  fileLabel: string;
};

export type EvidenceHtmlEventView = {
  eventId: string;
  eventType: string;
  logCategory: string;
  logCategoryLabel: string;
  level: string;
  levelLabel: string;
  occurredAtMs: number;
  occurredAtLabel: string;
  summary: string;
  detail: string;
  displayId?: string;
  processName?: string;
  windowTitle?: string;
  message?: string;
  title?: string;
  segmentIndex?: number;
  seekSeconds?: number;
  seekLabel?: string;
  matchLabel: string;
};

export type EvidenceViewModel = {
  playableSegmentViews: EvidenceHtmlSegmentView[];
  eventViews: EvidenceHtmlEventView[];
  defaultEventIndex: number;
  defaultSegmentIndex: number | undefined;
  categoryOptions: Array<{ value: string; label: string }>;
  displayOptions: string[];
};

export type EvidenceHtmlPayload = {
  session: {
    sessionId: string;
    name?: string;
    status: string;
    targetCaptureMode: string;
  };
  generatedAtMs: number;
  copyStats: EvidenceCopyStats;
  eventCount: number;
  stepEventCount: number;
  videoStreams: unknown[];
  videoSegments: unknown[];
  viewModel: EvidenceViewModel;
  manifestPath: string;
  operationsJsonPath: string;
  operationsCsvPath: string;
  checksumManifestPath: string;
};

export function renderEvidenceHtml(payload: EvidenceHtmlPayload): string {
  const inlinePayload = serializeForInlineScript({
    playableSegments: payload.viewModel.playableSegmentViews,
    events: payload.viewModel.eventViews,
    defaultEventIndex: payload.viewModel.defaultEventIndex,
    defaultSegmentIndex: payload.viewModel.defaultSegmentIndex ?? 0,
    categoryOptions: payload.viewModel.categoryOptions,
    displayOptions: payload.viewModel.displayOptions,
  });

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(payload.session.name ?? payload.session.sessionId)} 证据回放</title>
  <style>
    :root { color-scheme: dark; --bg: #0b1117; --panel: #121c24; --line: rgba(161, 180, 196, 0.18); --text: #edf3f8; --muted: #9db0c0; --accent: #4ec2ff; --accent-soft: rgba(78, 194, 255, 0.18); }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: radial-gradient(circle at top left, rgba(78, 194, 255, 0.14), transparent 28%), linear-gradient(180deg, #0b1117 0%, #0e141b 100%); color: var(--text); }
    main { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(340px, 0.95fr); gap: 18px; min-height: 100vh; padding: 18px; }
    section { background: rgba(18, 28, 36, 0.92); border: 1px solid var(--line); border-radius: 18px; padding: 16px; box-shadow: 0 18px 44px rgba(0, 0, 0, 0.24); }
    .hero, .panel-stack { display: grid; gap: 12px; }
    .hero-header, .panel-header { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    .hero-header h1, .panel-header h2, .panel-header h3 { margin: 0; }
    .hero-header p, .muted, .empty { color: var(--muted); }
    .pill-row, .stats-row, .path-list, .detail-grid, .filter-row { display: flex; flex-wrap: wrap; gap: 10px; }
    .pill, .stat, .path-item, .detail-card, .filter-item { background: rgba(255, 255, 255, 0.04); border: 1px solid var(--line); border-radius: 14px; padding: 10px 12px; }
    .pill strong, .stat strong, .detail-card strong, .filter-item label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
    .path-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .path-item a { color: var(--accent); text-decoration: none; word-break: break-all; }
    video { width: 100%; border-radius: 16px; border: 1px solid var(--line); background: #05080b; aspect-ratio: 16 / 9; }
    .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
    .filter-item { display: grid; gap: 6px; min-width: 0; }
    .filter-item input, .filter-item select { min-width: 0; border: 1px solid var(--line); border-radius: 10px; background: rgba(255, 255, 255, 0.04); color: var(--text); padding: 8px 10px; }
    .filter-item.checkbox { display: flex; align-items: center; gap: 8px; }
    .scroll-list { display: grid; gap: 8px; max-height: 260px; overflow: auto; padding-right: 4px; }
    .list-button { width: 100%; text-align: left; border: 1px solid var(--line); background: rgba(255, 255, 255, 0.03); color: var(--text); border-radius: 14px; padding: 10px 12px; cursor: pointer; }
    .list-button.active { border-color: rgba(78, 194, 255, 0.5); background: var(--accent-soft); }
    .list-button strong, .list-button small { display: block; margin-bottom: 2px; }
    .list-button small { color: var(--muted); }
    @media (max-width: 1100px) { main { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div class="hero-header">
        <div>
          <h1>${escapeHtml(payload.session.name ?? payload.session.sessionId)} 证据回放</h1>
          <p>循环录制视频、事件记录与本地导出。生成时间：${escapeHtml(new Date(payload.generatedAtMs).toLocaleString('zh-CN', { hour12: false }))}</p>
        </div>
        <div class="pill-row">
          <div class="pill"><strong>会话状态</strong>${escapeHtml(payload.session.status)}</div>
          <div class="pill"><strong>采集模式</strong>${escapeHtml(payload.session.targetCaptureMode)}</div>
        </div>
      </div>
      <div class="stats-row">
        <div class="stat"><strong>事件数</strong>${payload.eventCount}</div>
        <div class="stat"><strong>步骤事件</strong>${payload.stepEventCount}</div>
        <div class="stat"><strong>视频流</strong>${payload.videoStreams.length}</div>
        <div class="stat"><strong>视频片段</strong>${payload.videoSegments.length}</div>
        <div class="stat"><strong>可播放片段</strong>${payload.viewModel.playableSegmentViews.length}</div>
        <div class="stat"><strong>复制数据</strong>${payload.copyStats.fileCount} 个文件 / ${formatBytes(payload.copyStats.byteCount)}</div>
      </div>
      <div class="path-list">
        <div class="path-item"><strong>回放页</strong><a href="index.html">index.html</a></div>
        <div class="path-item"><strong>清单</strong><a href="${escapeHtml(payload.manifestPath)}">${escapeHtml(payload.manifestPath)}</a></div>
        <div class="path-item"><strong>操作 JSON</strong><a href="${escapeHtml(payload.operationsJsonPath)}">${escapeHtml(payload.operationsJsonPath)}</a></div>
        <div class="path-item"><strong>操作 CSV</strong><a href="${escapeHtml(payload.operationsCsvPath)}">${escapeHtml(payload.operationsCsvPath)}</a></div>
        <div class="path-item"><strong>SHA256</strong><a href="${escapeHtml(payload.checksumManifestPath)}">${escapeHtml(payload.checksumManifestPath)}</a></div>
      </div>
      <div class="player-wrap">
        <video id="evidence-player" controls preload="metadata"></video>
        <div class="detail-grid">
          <div class="detail-card"><strong>当前片段</strong><span id="segment-title">未选择</span></div>
          <div class="detail-card"><strong>片段元信息</strong><span id="segment-meta">--</span></div>
          <div class="detail-card"><strong>当前事件</strong><span id="event-title">未选择</span></div>
          <div class="detail-card"><strong>事件定位</strong><span id="event-meta">--</span></div>
        </div>
      </div>
    </section>
    <section class="panel-stack">
      <div class="panel-header"><h2>视频片段</h2><span class="muted">${payload.viewModel.playableSegmentViews.length} 个可播放片段</span></div>
      <div class="scroll-list" id="segment-list"></div>
      <div class="panel-header"><h3>事件记录</h3><span class="muted">${payload.viewModel.eventViews.length} 条事件</span></div>
      <div class="filter-row">
        <div class="filter-item"><label for="log-category-filter">日志分类</label><select id="log-category-filter"><option value="">全部</option></select></div>
        <div class="filter-item"><label for="display-filter">显示器</label><select id="display-filter"><option value="">全部</option></select></div>
        <div class="filter-item"><label for="event-search">关键字</label><input id="event-search" type="text" placeholder="搜索动作、窗口、进程" /></div>
        <label class="filter-item checkbox"><input id="matched-only" type="checkbox" /><span>仅显示可定位视频事件</span></label>
      </div>
      <div class="scroll-list" id="event-list"></div>
      <div class="empty" id="event-empty" hidden>当前筛选条件下没有事件。</div>
    </section>
  </main>
  <script>
    const payload = ${inlinePayload};
    const player = document.getElementById('evidence-player');
    const segmentList = document.getElementById('segment-list');
    const eventList = document.getElementById('event-list');
    const eventEmpty = document.getElementById('event-empty');
    const segmentTitle = document.getElementById('segment-title');
    const segmentMeta = document.getElementById('segment-meta');
    const eventTitle = document.getElementById('event-title');
    const eventMeta = document.getElementById('event-meta');
    const logCategoryFilter = document.getElementById('log-category-filter');
    const displayFilter = document.getElementById('display-filter');
    const eventSearch = document.getElementById('event-search');
    const matchedOnly = document.getElementById('matched-only');
    let activeSegmentIndex = -1;
    let activeEventIndex = -1;
    payload.categoryOptions.forEach((item) => { const option = document.createElement('option'); option.value = item.value; option.textContent = item.label; logCategoryFilter.appendChild(option); });
    payload.displayOptions.forEach((value) => { const option = document.createElement('option'); option.value = value; option.textContent = value; displayFilter.appendChild(option); });
    function setPlayerSource(segment, seekSeconds) { if (!segment || !(player instanceof HTMLVideoElement)) { segmentTitle.textContent = '未选择'; segmentMeta.textContent = '--'; return; } const applySeek = () => { if (typeof seekSeconds === 'number') { player.currentTime = Math.max(0, seekSeconds); } }; if (player.getAttribute('data-segment-id') === segment.segmentId) { applySeek(); } else { player.setAttribute('data-segment-id', segment.segmentId); player.src = segment.relativePath; player.load(); player.addEventListener('loadedmetadata', applySeek, { once: true }); } segmentTitle.textContent = segment.label; segmentMeta.textContent = segment.meta; }
    function renderSegments() { segmentList.innerHTML = ''; if (payload.playableSegments.length === 0) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '当前证据包内没有可直接播放的视频片段。'; segmentList.appendChild(empty); return; } payload.playableSegments.forEach((segment, index) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'list-button' + (index === activeSegmentIndex ? ' active' : ''); button.innerHTML = '<strong>' + segment.label + '</strong><small>' + segment.meta + '</small><small>' + segment.fileLabel + '</small>'; button.addEventListener('click', () => { activeSegmentIndex = index; setPlayerSource(segment); renderSegments(); }); segmentList.appendChild(button); }); }
    function getFilteredEvents() { const categoryValue = logCategoryFilter.value; const displayValue = displayFilter.value; const searchValue = eventSearch.value.trim().toLowerCase(); const matchedOnlyValue = matchedOnly.checked; return payload.events.filter((event) => { if (categoryValue && event.logCategory !== categoryValue) { return false; } if (displayValue && event.displayId !== displayValue) { return false; } if (matchedOnlyValue && typeof event.segmentIndex !== 'number') { return false; } if (!searchValue) { return true; } return [event.summary, event.detail, event.logCategory, event.logCategoryLabel, event.level, event.levelLabel, event.eventType, event.displayId, event.processName, event.windowTitle, event.message, event.title, event.matchLabel].filter(Boolean).join(' ').toLowerCase().includes(searchValue); }); }
    function renderEvents() { const events = getFilteredEvents(); eventList.innerHTML = ''; if (events.length === 0) { eventEmpty.hidden = false; return; } eventEmpty.hidden = true; events.forEach((event) => { const originalIndex = payload.events.findIndex((candidate) => candidate.eventId === event.eventId); const button = document.createElement('button'); button.type = 'button'; button.className = 'list-button' + (originalIndex === activeEventIndex ? ' active' : ''); button.innerHTML = '<strong>' + event.summary + '</strong><small>' + event.occurredAtLabel + ' · ' + event.logCategoryLabel + ' · ' + event.levelLabel + ' · ' + event.eventType + '</small><small>' + event.detail + '</small><small>' + event.matchLabel + '</small>'; button.addEventListener('click', () => { activeEventIndex = originalIndex; eventTitle.textContent = event.summary; eventMeta.textContent = event.matchLabel; if (typeof event.segmentIndex === 'number' && payload.playableSegments[event.segmentIndex]) { activeSegmentIndex = event.segmentIndex; setPlayerSource(payload.playableSegments[event.segmentIndex], event.seekSeconds); renderSegments(); } renderEvents(); }); eventList.appendChild(button); }); }
    [logCategoryFilter, displayFilter, eventSearch, matchedOnly].forEach((element) => { element.addEventListener('input', renderEvents); element.addEventListener('change', renderEvents); });
    if (payload.playableSegments.length > 0) { activeSegmentIndex = Math.min(Math.max(payload.defaultSegmentIndex ?? 0, 0), payload.playableSegments.length - 1); setPlayerSource(payload.playableSegments[activeSegmentIndex]); }
    if (payload.events.length > 0) { activeEventIndex = Math.min(Math.max(payload.defaultEventIndex ?? 0, 0), payload.events.length - 1); const event = payload.events[activeEventIndex]; eventTitle.textContent = event.summary; eventMeta.textContent = event.matchLabel; if (typeof event.segmentIndex === 'number' && payload.playableSegments[event.segmentIndex]) { activeSegmentIndex = event.segmentIndex; setPlayerSource(payload.playableSegments[event.segmentIndex], event.seekSeconds); } }
    renderSegments();
    renderEvents();
  </script>
</body>
</html>`;
}

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${bytes} B`;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
