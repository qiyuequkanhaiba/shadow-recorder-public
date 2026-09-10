import {
  scaleFloatingToolbarCoreSize,
  type FloatingToolbarVisualState,
} from './floating-toolbar-layout';

function createIconSvg(paths: string, extraClass = '', filled = false): string {
  const className = extraClass ? `toolbar-icon ${extraClass}` : 'toolbar-icon';
  const fill = filled ? 'currentColor' : 'none';
  const stroke = filled ? 'none' : 'currentColor';
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

const ICONS = {
  start: createIconSvg('<polygon points="5 3 19 12 5 21 5 3"></polygon>', '', true),
  pause: createIconSvg(
    '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>',
  ),
  resume: createIconSvg('<polygon points="5 3 19 12 5 21 5 3"></polygon>', '', true),
  stop: createIconSvg('<rect x="5" y="5" width="14" height="14" rx="1"></rect>', '', true),
  flag: createIconSvg(
    '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"></path>',
    '',
    true,
  ),
  export: createIconSvg(
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>',
  ),
  main: createIconSvg(
    '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line>',
  ),
} as const;

export function createFloatingToolbarHtml(input: {
  initialCollapsed?: boolean;
  initialState?: FloatingToolbarVisualState;
  initialStartedAtMs?: number;
  initialTheme?: 'dark' | 'light';
  uiScale?: number;
  documentEpoch?: number;
} = {}): string {
  const initialCollapsed = !!input.initialCollapsed;
  const initialState: FloatingToolbarVisualState = input.initialState === 'recording'
    || input.initialState === 'paused'
    ? input.initialState
    : 'idle';
  const initialStartedAtMs = Number.isFinite(input.initialStartedAtMs)
    && (input.initialStartedAtMs as number) > 0
    ? Math.floor(input.initialStartedAtMs as number)
    : null;
  const initialTheme = input.initialTheme === 'light' ? 'light' : 'dark';
  const uiScale = Number.isFinite(input.uiScale) && (input.uiScale as number) > 0
    ? Math.min(1.4, Math.max(0.85, input.uiScale as number))
    : 1;
  const documentEpoch = Number.isSafeInteger(input.documentEpoch) && (input.documentEpoch as number) > 0
    ? input.documentEpoch as number
    : 1;
  const collapsedSize = scaleFloatingToolbarCoreSize(true, initialState, uiScale);
  const idleExpandedSize = scaleFloatingToolbarCoreSize(false, 'idle', uiScale);
  const activeExpandedSize = scaleFloatingToolbarCoreSize(false, 'recording', uiScale);

  return `<!doctype html>
<html lang="zh-CN" data-theme="${initialTheme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <style>
      :root {
        color-scheme: only light;
      }
      :root, [data-theme="dark"], [data-theme="light"] {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", sans-serif;
        --ui-scale: ${uiScale};
        --btn: calc(26px * var(--ui-scale));
        --icon: calc(14px * var(--ui-scale));
        --gap: calc(3px * var(--ui-scale));
        --bar-h: ${idleExpandedSize.height}px;
        --compact-pad-x: calc(10px * var(--ui-scale));
        --idle-expanded-pad-x: calc(8px * var(--ui-scale));
        --active-expanded-pad-left: calc(12px * var(--ui-scale));
        --active-expanded-pad-right: calc(10px * var(--ui-scale));
        --inner-gap: calc(8px * var(--ui-scale));
        --status-dot-size: calc(9px * var(--ui-scale));
        --status-ring-size: calc(22px * var(--ui-scale));
        --waveform-bar-width: calc(2.5px * var(--ui-scale));
        --waveform-gap: calc(2.5px * var(--ui-scale));
        --waveform-max-width: calc(22px * var(--ui-scale));
        --waveform-min-height: calc(4px * var(--ui-scale));
        --waveform-h1: calc(6px * var(--ui-scale));
        --waveform-h2: calc(13px * var(--ui-scale));
        --waveform-h3: calc(8px * var(--ui-scale));
        --waveform-max-height: calc(14px * var(--ui-scale));
        --core-collapsed-width: ${collapsedSize.width}px;
        --core-idle-expanded-width: ${idleExpandedSize.width}px;
        --core-active-expanded-width: ${activeExpandedSize.width}px;
        --spring-morph: cubic-bezier(0.32, 1.28, 0.4, 1);
        --ease-apple: cubic-bezier(0.16, 1, 0.3, 1);
        --glass-base: rgba(10, 14, 23, 0.62);
        --glass-base-hover: rgba(12, 17, 28, 0.76);
        --glass-specular: rgba(255, 255, 255, 0.16);
        --glass-rim: rgba(255, 255, 255, 0.08);
        --ink: #f8fafc;
        --ink-secondary: #e2e8f0;
        --ink-tertiary: #64748b;
        --ink-divider: rgba(255, 255, 255, 0.14);
        --rec: #22c55e;
        --pause: #f59e0b;
        --idle: #64748b;
        --stop: #f87171;
        --flag: #ef4444;
        --flag-bg: rgba(239, 68, 68, 0.24);
      }
      * { box-sizing: border-box; }
      html, body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: transparent !important;
        background-color: transparent !important;
        color-scheme: only light;
      }
      body {
        padding: 0;
        user-select: none;
        display: flex;
        align-items: stretch;
        justify-content: stretch;
        color: var(--ink);
        -webkit-font-smoothing: antialiased;
      }
      #island-container {
        position: relative;
        display: flex;
        align-items: stretch;
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 0;
        overflow: hidden;
        background: transparent;
        border: none;
      }
      .island {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: flex-start;
        width: var(--core-idle-expanded-width);
        height: var(--bar-h);
        margin: 0;
        padding: 0 var(--idle-expanded-pad-x);
        gap: 0;
        border: 1px solid var(--glass-rim);
        border-top-color: var(--glass-specular);
        border-radius: 999px;
        background: var(--glass-base);
        -webkit-backdrop-filter: blur(36px) saturate(210%) brightness(1.08);
        backdrop-filter: blur(36px) saturate(210%) brightness(1.08);
        box-shadow: inset 0 -1px 0.5px 0 rgba(0, 0, 0, 0.35);
        overflow: hidden;
        cursor: grab;
        /* Do not promote .island to its own layer (translateZ / backface-visibility).
           That makes backdrop-filter sample a stale buffer after the desktop behind
           the window changes, so the capsule turns milky, black, or frozen. */
        transition: width 0.34s var(--spring-morph), padding 0.34s var(--spring-morph), background 0.2s ease, border-color 0.2s ease;
      }
      .island[data-state="recording"],
      .island[data-state="paused"] {
        width: var(--core-active-expanded-width);
        padding: 0 var(--active-expanded-pad-right) 0 var(--active-expanded-pad-left);
      }
      .island[data-collapsed="true"] {
        width: var(--core-collapsed-width);
        padding: 0 var(--compact-pad-x);
      }
      .island:hover {
        background: var(--glass-base-hover);
        border-color: rgba(255, 255, 255, 0.16);
        box-shadow: inset 0 -1px 0.5px 0 rgba(0, 0, 0, 0.35);
      }
      .island:active { cursor: grabbing; }
      .island-inner {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 0;
        width: 100%;
        height: 100%;
        box-sizing: border-box;
        padding: 0;
        margin: 0;
      }
      .island[data-collapsed="true"] .island-inner {
        padding: 0;
      }
      .capsule-core-cluster,
      .status-capsule {
        display: flex;
        align-items: center;
        gap: 0;
        flex-shrink: 0;
        height: 100%;
        cursor: grab;
      }
      .capsule-core-cluster:active,
      .status-capsule:active { cursor: grabbing; }
      .status-dot {
        position: relative;
        width: var(--status-dot-size);
        height: var(--status-dot-size);
        border-radius: 50%;
        background: var(--idle);
        flex-shrink: 0;
        box-shadow: none;
      }
      .island[data-state="recording"] .status-dot {
        background: var(--rec);
        box-shadow: 0 0 10px rgba(34, 197, 94, 0.7);
      }
      .status-dot::after {
        content: '';
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        width: 100%;
        height: 100%;
        border-radius: 50%;
        border: 1.5px solid var(--rec);
        --ring-start-opacity: 0.9;
        opacity: 0;
        pointer-events: none;
      }
      .island[data-state="recording"] .status-dot::after {
        --ring-start-opacity: 0.9;
        opacity: 0.9;
        animation: featheredRingExpand 2s cubic-bezier(0.25, 1, 0.5, 1) infinite;
      }
      .island[data-state="paused"] .status-dot {
        background: var(--pause);
        box-shadow: 0 0 10px rgba(245, 158, 11, 0.7);
      }
      .island[data-state="paused"] .status-dot::after {
        display: block;
        border-color: var(--pause);
        --ring-start-opacity: 0.56;
        opacity: 0.56;
        animation: featheredRingExpand 3.4s cubic-bezier(0.25, 1, 0.5, 1) infinite;
      }
      .island[data-state="idle"] .status-dot::after {
        display: block;
        border-color: var(--idle);
        --ring-start-opacity: 0.38;
        opacity: 0.38;
        animation: featheredRingExpand 5.2s cubic-bezier(0.25, 1, 0.5, 1) infinite;
      }
      @keyframes featheredRingExpand {
        0% { width: var(--status-dot-size); height: var(--status-dot-size); opacity: var(--ring-start-opacity); }
        100% { width: var(--status-ring-size); height: var(--status-ring-size); opacity: 0; }
      }
      .capsule-clock-digits,
      .status-time {
        font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
        font-size: 11px;
        font-weight: 700;
        color: var(--ink);
        letter-spacing: 0.02em;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .island[data-state="idle"] .capsule-clock-digits,
      .island[data-state="idle"] .status-time {
        font-family: inherit;
        color: var(--ink-secondary);
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
      .capsule-slim-deck,
      .actions {
        display: flex;
        align-items: center;
        flex: 0 1 auto;
        min-width: 0;
        max-width: 0;
        height: var(--btn);
        margin-left: 0;
        gap: var(--gap);
        overflow: hidden;
        opacity: 0;
        transform: scale(0.92) translateX(-4px);
        pointer-events: none;
        white-space: nowrap;
        transition: max-width 0.2s var(--spring-morph), margin-left 0.2s var(--spring-morph), opacity 0.18s var(--ease-apple) 0.04s, transform 0.2s var(--spring-morph) 0.04s;
      }
      .island[data-collapsed="false"] .capsule-slim-deck,
      .island[data-collapsed="false"] .actions {
        max-width: calc(140px * var(--ui-scale));
        margin-left: var(--inner-gap);
        opacity: 1;
        transform: scale(1) translateX(0);
        pointer-events: auto;
      }
      .collapsed-waveform {
        display: flex;
        align-items: center;
        flex: 0 1 auto;
        min-width: 0;
        max-width: var(--waveform-max-width);
        margin-left: var(--inner-gap);
        gap: var(--waveform-gap);
        overflow: hidden;
        opacity: 1;
        transition: max-width 0.2s var(--spring-morph), margin-left 0.2s var(--spring-morph), opacity 0.16s var(--ease-apple);
      }
      .waveform-bar {
        flex: 0 0 var(--waveform-bar-width);
        height: var(--waveform-min-height);
        border-radius: 2px;
        background: var(--rec);
        --waveform-pulse-height: var(--waveform-max-height);
        animation: waveformPulse 1s ease-in-out infinite alternate;
      }
      .waveform-bar:nth-child(1) { height: var(--waveform-h1); animation-delay: 0.1s; }
      .waveform-bar:nth-child(2) { height: var(--waveform-h2); animation-delay: 0.35s; }
      .waveform-bar:nth-child(3) { height: var(--waveform-h3); animation-delay: 0.2s; }
      .island[data-state="recording"] .waveform-bar { background: var(--rec); }
      .island[data-state="paused"] .waveform-bar {
        --waveform-pulse-height: calc(8px * var(--ui-scale));
        background: var(--pause);
        animation: waveformPulse 1.8s ease-in-out infinite alternate;
      }
      .island[data-state="idle"] .waveform-bar {
        --waveform-pulse-height: calc(6px * var(--ui-scale));
        background: var(--idle);
        animation: waveformPulse 2.4s ease-in-out infinite alternate;
      }
      .island[data-collapsed="false"] .collapsed-waveform {
        max-width: 0;
        margin-left: 0;
        opacity: 0;
        pointer-events: none;
      }
      @keyframes waveformPulse {
        0% { height: var(--waveform-min-height); opacity: 0.55; }
        100% { height: var(--waveform-pulse-height); opacity: 1; }
      }
      .island[data-collapsed="true"] .capsule-slim-deck,
      .island[data-collapsed="true"] .actions {
        flex-basis: 0;
        max-width: 0;
        margin-left: 0;
        pointer-events: none;
      }
      .deck-sep-line {
        width: 1px;
        height: 14px;
        background: var(--ink-divider);
        margin: 0 3px 0 1px;
        flex-shrink: 0;
      }
      .slim-btn,
      .btn {
        appearance: none;
        -webkit-appearance: none;
        background: transparent;
        border: 1px solid transparent;
        color: var(--ink-secondary);
        cursor: pointer;
        box-sizing: border-box;
        width: var(--btn);
        height: var(--btn);
        min-width: var(--btn);
        min-height: var(--btn);
        max-width: var(--btn);
        max-height: var(--btn);
        padding: 0;
        margin: 0;
        border-radius: 50%;
        display: none;
        align-items: center;
        justify-content: center;
        flex: 0 0 var(--btn);
        line-height: 0;
        transition: background 0.14s var(--ease-apple), color 0.14s var(--ease-apple), border-color 0.14s var(--ease-apple), opacity 0.14s var(--ease-apple), transform 0.14s var(--ease-apple);
        outline: none;
      }
      .slim-btn:hover:not(:disabled),
      .btn:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
        transform: scale(1.08);
      }
      .slim-btn:active:not(:disabled),
      .btn:active:not(:disabled) {
        transform: scale(0.95);
      }
      .slim-btn:focus-visible,
      .btn:focus-visible {
        outline: 2px solid #0284c7;
        outline-offset: 1px;
      }
      .slim-btn:disabled,
      .btn:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }
      .btn-start {
        color: #4ade80;
      }
      .btn-start:hover:not(:disabled) {
        background: rgba(22, 163, 74, 0.2);
        color: #86efac;
        transform: scale(1.08);
      }
      .btn-flag {
        color: var(--ink-secondary);
      }
      .btn-flag:hover:not(:disabled) {
        background: var(--flag-bg);
        color: var(--flag);
        border-color: rgba(239, 68, 68, 0.4);
      }
      .btn-stop:hover:not(:disabled) {
        background: rgba(220, 38, 38, 0.22);
        color: var(--stop);
        border-color: rgba(220, 38, 38, 0.4);
      }
      .btn-export:hover:not(:disabled) {
        background: rgba(56, 189, 248, 0.2);
        color: #38bdf8;
        border-color: rgba(56, 189, 248, 0.4);
      }
      .toolbar-icon {
        width: var(--icon);
        height: var(--icon);
        display: block;
        flex: 0 0 var(--icon);
        pointer-events: none;
      }
      .show-on-idle, .show-on-live, .show-on-paused { display: none !important; }
      .island[data-state="idle"] .show-on-idle {
        display: inline-flex !important;
        width: var(--btn);
        height: var(--btn);
      }
      .island[data-state="live"] .show-on-live,
      .island[data-state="recording"] .show-on-live {
        display: inline-flex !important;
        width: var(--btn);
        height: var(--btn);
      }
      .island[data-state="paused"] .show-on-paused {
        display: inline-flex !important;
        width: var(--btn);
        height: var(--btn);
      }
      .toast-status-banner {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%) translateY(4px);
        background: rgba(15, 23, 42, 0.9);
        color: #fff;
        font-size: 11px;
        font-weight: 600;
        padding: 4px 12px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.15);
        box-shadow: 0 8px 18px rgba(0, 0, 0, 0.3);
        opacity: 0;
        pointer-events: none;
        z-index: 8;
        white-space: nowrap;
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      .toast-status-banner.is-visible {
        opacity: 1;
        transform: translate(-50%, -50%);
      }
      @media (prefers-reduced-motion: reduce) {
        .island, .island-inner, .slim-btn, .btn, .status-dot, .status-dot::after, .capsule-slim-deck, .actions, .collapsed-waveform, .waveform-bar, .toast-status-banner {
          transition: none !important;
          animation: none !important;
        }
      }
    </style>
  </head>
  <body>
    <div id="island-container">
      <div class="island" id="island" data-state="${initialState}" data-collapsed="${initialCollapsed ? 'true' : 'false'}">
        <div class="island-inner" id="island-inner">
          <div class="capsule-core-cluster status-capsule" id="drag-handle"
            title="按住可直接拖拽；鼠标悬停展开工具条"
            aria-describedby="status-label status-time">
            <span class="status-dot" aria-hidden="true"></span>
            <span class="capsule-clock-digits status-time sr-only" id="status-time">就绪</span>
            <span class="status-label sr-only" id="status-label">就绪</span>
          </div>
          <span class="collapsed-time sr-only" id="collapsed-time">就绪</span>
          <div class="collapsed-waveform" aria-hidden="true">
            <span class="waveform-bar"></span>
            <span class="waveform-bar"></span>
            <span class="waveform-bar"></span>
          </div>
          <div class="capsule-slim-deck actions" id="actions">
            <div class="deck-sep-line" aria-hidden="true"></div>
            <button type="button" class="slim-btn btn btn-start show-on-idle" id="start-btn" title="开始录制" aria-label="开始录制">${ICONS.start}</button>
            <button type="button" class="slim-btn btn show-on-live" id="pause-btn" title="暂停录制" aria-label="暂停录制">${ICONS.pause}</button>
            <button type="button" class="slim-btn btn btn-start show-on-paused" id="resume-btn" title="继续录制" aria-label="继续录制">${ICONS.resume}</button>
            <button type="button" class="slim-btn btn btn-flag show-on-live show-on-paused" id="flag-btn" title="瞬时打标" aria-label="瞬时打标">${ICONS.flag}</button>
            <button type="button" class="slim-btn btn btn-stop show-on-live show-on-paused" id="stop-btn" title="停止录制" aria-label="停止录制">${ICONS.stop}</button>
            <button type="button" class="slim-btn btn btn-export show-on-idle" id="export-btn" title="导出证据 ZIP" aria-label="导出证据 ZIP">${ICONS.export}</button>
            <button type="button" class="slim-btn btn show-on-idle show-on-live show-on-paused" id="main-btn" title="打开主工作台" aria-label="打开主工作台">${ICONS.main}</button>
          </div>
        </div>
        <div class="toast-status-banner" id="status-toast" role="status" aria-live="polite"></div>
      </div>
    </div>
    <script>
      const api = window.reqcaseShadowRecorder;
      const island = document.getElementById('island');
      const islandInner = document.getElementById('island-inner');
      const islandContainer = document.getElementById('island-container');
      const dragHandle = document.getElementById('drag-handle');
      const statusLabel = document.getElementById('status-label');
      const statusTime = document.getElementById('status-time');
      const collapsedTime = document.getElementById('collapsed-time');
      const statusToast = document.getElementById('status-toast');
      const DOCUMENT_EPOCH = ${documentEpoch};
      const INITIAL_STARTED_AT_MS = ${initialStartedAtMs ?? 'null'};
      const COLLAPSE_DELAY_MS = 650;
      const buttons = {
        start: document.getElementById('start-btn'),
        pause: document.getElementById('pause-btn'),
        resume: document.getElementById('resume-btn'),
        flag: document.getElementById('flag-btn'),
        stop: document.getElementById('stop-btn'),
        export: document.getElementById('export-btn'),
        main: document.getElementById('main-btn'),
      };

      let busy = false;
      let paused = false;
      let collapsed = ${initialCollapsed ? 'true' : 'false'};
      let pointerInside = false;
      let lastRecording = false;
      let collapseTimer = null;
      let sessionStartedAtMs = INITIAL_STARTED_AT_MS;
      let clockTimer = null;
      let canExport = false;
      let exportCheckTick = 0;
      let lastExportCheckAt = 0;
      let fitTimer = null;
      let lastFitKey = '';
      let lastFitSize = { width: 0, height: 0 };
      let fitting = false;
      let dragging = false;
      let dragReleasePending = false;
      let dragReleaseRevision = 0;
      let dragEpoch = 0;
      let dragStartSync = null;
      let dragPointerId = null;
      let dragCaptureTarget = null;
      let dragOffsetX = 0;
      let dragOffsetY = 0;
      let dragMoved = false;
      let toastTimer = null;
      let visualState = '${initialState}';
      let presentationRevision = 0;
      let pendingPresentation = null;
      let desiredPresentation = { state: visualState, collapsed };
      let pendingFit = false;
      let pendingFitForce = false;
      let fitRetryDeferred = false;
      let canvasFitUncertain = false;
      let morphTimer = null;
      let deferredFitTimer = null;
      const MORPH_MS = 340;
      const FIT_RETRY_DELAY_MS = 32;
      const MAX_FIT_RETRIES = 4;

      const formatElapsed = (ms) => {
        const totalSec = Math.max(0, Math.floor(ms / 1000));
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        if (h > 0) {
          return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
        }
        return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      };

      const updateClock = () => {
        if (!lastRecording || sessionStartedAtMs == null) {
          statusTime.textContent = '就绪';
          collapsedTime.textContent = '就绪';
          return;
        }
        const text = formatElapsed(Date.now() - sessionStartedAtMs);
        statusTime.textContent = text;
        collapsedTime.textContent = text;
      };

      const ensureClock = () => {
        if (clockTimer != null) return;
        clockTimer = window.setInterval(updateClock, 1000);
      };

      const stopClock = () => {
        if (clockTimer != null) {
          window.clearInterval(clockTimer);
          clockTimer = null;
        }
      };

      const applyTheme = (theme) => {
        const next = theme === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        // Keep color-scheme pinned to light. Chromium paints an opaque
        // dark/light canvas on transparent windows when color-scheme changes,
        // which is what makes the island look broken after theme/background switches.
        document.documentElement.style.colorScheme = 'only light';
        document.documentElement.style.background = 'transparent';
        if (document.body) {
          document.body.style.background = 'transparent';
        }
      };

      const reassertGlassSurface = () => {
        document.documentElement.style.background = 'transparent';
        document.documentElement.style.backgroundColor = 'transparent';
        document.documentElement.style.colorScheme = 'only light';
        if (document.body) {
          document.body.style.background = 'transparent';
          document.body.style.backgroundColor = 'transparent';
        }
        if (island) {
          const previousFilter = island.style.webkitBackdropFilter || island.style.backdropFilter;
          island.style.webkitBackdropFilter = 'none';
          island.style.backdropFilter = 'none';
          void island.offsetWidth;
          island.style.webkitBackdropFilter = previousFilter || '';
          island.style.backdropFilter = previousFilter || '';
        }
      };

      const cancelScheduledCollapse = () => {
        if (collapseTimer !== null) {
          window.clearTimeout(collapseTimer);
          collapseTimer = null;
        }
      };

      const CORE_COLLAPSED_WIDTH = ${collapsedSize.width};
      const CORE_IDLE_EXPANDED_WIDTH = ${idleExpandedSize.width};
      const CORE_ACTIVE_EXPANDED_WIDTH = ${activeExpandedSize.width};
      const CORE_HEIGHT = ${idleExpandedSize.height};

      const getCoreWidth = (isCollapsed, state) => {
        if (isCollapsed) return CORE_COLLAPSED_WIDTH;
        return state === 'idle' ? CORE_IDLE_EXPANDED_WIDTH : CORE_ACTIVE_EXPANDED_WIDTH;
      };

      // Only update after a current native fit succeeds; this is the safe ordering baseline.
      let canvasCoreWidth = getCoreWidth(collapsed, visualState);

      const prefersReducedMotion = () =>
        !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

      // Deterministic canvas size from UI state — never depends on current window size.
      const measureContentSize = (coreWidth = canvasCoreWidth) => ({
        width: coreWidth,
        height: CORE_HEIGHT,
      });

      const commitPresentation = (nextState, nextCollapsed) => {
        visualState = nextState;
        collapsed = !!nextCollapsed;
        island.setAttribute('data-state', visualState);
        island.setAttribute('data-collapsed', String(collapsed));
      };

      const fitContentNow = async (force, coreWidth = canvasCoreWidth) => {
        if (!api || !api.fitFloatingToolbarSize) return false;
        if (dragging || dragReleasePending || fitting) {
          pendingFit = true;
          pendingFitForce = pendingFitForce || !!force;
          return false;
        }
        const size = measureContentSize(coreWidth);
        const key = size.width + 'x' + size.height + ':' + visualState + ':' + (collapsed ? '1' : '0') + ':' + presentationRevision;
        if (!force && key === lastFitKey) return true;
        lastFitKey = key;
        lastFitSize = { width: size.width, height: size.height };
        const fitRevision = presentationRevision;
        fitting = true;
        try {
          for (let attempt = 0; attempt < MAX_FIT_RETRIES; attempt += 1) {
            const fittedSize = await api.fitFloatingToolbarSize({ ...size, documentEpoch: DOCUMENT_EPOCH });
            if (fittedSize?.width === size.width && fittedSize?.height === size.height) {
              fitRetryDeferred = false;
              return true;
            }
            if (dragging || dragReleasePending || fitRevision !== presentationRevision) {
              pendingFit = true;
              pendingFitForce = true;
              canvasFitUncertain = true;
              return false;
            }
            if (attempt + 1 < MAX_FIT_RETRIES) {
              await new Promise((resolve) => {
                window.setTimeout(resolve, FIT_RETRY_DELAY_MS);
              });
            }
          }
          // A native pointer fence or an obsolete document may keep rejecting
          // a request. Stop retrying here and resume at the next interaction
          // boundary instead of producing an endless IPC loop.
          lastFitKey = '';
          pendingFit = true;
          pendingFitForce = true;
          fitRetryDeferred = true;
          canvasFitUncertain = true;
          return false;
        } catch (error) {
          console.error('[island] fit size failed:', error);
          return false;
        } finally {
          fitting = false;
          if (!dragging && !dragReleasePending && pendingPresentation) {
            if (deferredFitTimer != null) {
              window.clearTimeout(deferredFitTimer);
            }
            deferredFitTimer = window.setTimeout(() => {
              deferredFitTimer = null;
              flushPendingPresentation();
            }, 0);
          } else if (!dragging && !dragReleasePending && pendingFit) {
            if (fitRetryDeferred) return;
            const nextForce = pendingFitForce;
            pendingFit = false;
            pendingFitForce = false;
            if (deferredFitTimer != null) {
              window.clearTimeout(deferredFitTimer);
            }
            deferredFitTimer = window.setTimeout(() => {
              deferredFitTimer = null;
              void fitContentNow(nextForce);
            }, FIT_RETRY_DELAY_MS);
          }
        }
      };

      const scheduleFitContent = (force) => {
        if (dragging || dragReleasePending) {
          pendingFit = true;
          pendingFitForce = pendingFitForce || !!force;
          return;
        }
        if (fitTimer != null) {
          window.clearTimeout(fitTimer);
        }
        fitTimer = window.setTimeout(() => {
          fitTimer = null;
          void fitContentNow(!!force);
        }, 16);
      };

      const scheduleCanvasShrink = (revision, targetCoreWidth) => {
        const delay = prefersReducedMotion() ? 0 : MORPH_MS;
        morphTimer = window.setTimeout(() => {
          morphTimer = null;
          if (revision !== presentationRevision || dragging || dragReleasePending) return;
          lastFitKey = '';
          void fitContentNow(true, targetCoreWidth).then((fitted) => {
            if (!fitted) return;
            if (dragging || dragReleasePending) {
              canvasFitUncertain = true;
              return;
            }
            canvasCoreWidth = targetCoreWidth;
            canvasFitUncertain = false;
            if (revision !== presentationRevision) return;
          });
        }, delay);
      };

      const applyPresentation = (nextState, nextCollapsed) => {
        const normalizedCollapsed = !!nextCollapsed;
        desiredPresentation = { state: nextState, collapsed: normalizedCollapsed };
        if (
          !dragging && !dragReleasePending && !fitting && !pendingPresentation
          && visualState === nextState && collapsed === normalizedCollapsed
          && canvasCoreWidth === getCoreWidth(normalizedCollapsed, nextState)
          && !canvasFitUncertain
        ) {
          return;
        }
        const revision = ++presentationRevision;
        fitRetryDeferred = false;
        if (dragging || dragReleasePending || fitting) {
          pendingPresentation = desiredPresentation;
          return;
        }
        if (canvasFitUncertain) {
          const renderedCoreWidth = getCoreWidth(collapsed, visualState);
          lastFitKey = '';
          void fitContentNow(true, renderedCoreWidth).then((fitted) => {
            if (!fitted) return;
            if (dragging || dragReleasePending) {
              canvasFitUncertain = true;
              return;
            }
            canvasCoreWidth = renderedCoreWidth;
            canvasFitUncertain = false;
            if (revision !== presentationRevision) return;
            applyPresentation(nextState, nextCollapsed);
          });
          return;
        }
        if (morphTimer != null) {
          window.clearTimeout(morphTimer);
          morphTimer = null;
        }
        const targetCoreWidth = getCoreWidth(normalizedCollapsed, nextState);
        if (targetCoreWidth > canvasCoreWidth) {
          lastFitKey = '';
          void fitContentNow(true, targetCoreWidth).then((fitted) => {
            if (!fitted) return;
            if (dragging || dragReleasePending) {
              canvasFitUncertain = true;
              return;
            }
            canvasCoreWidth = targetCoreWidth;
            canvasFitUncertain = false;
            if (revision !== presentationRevision) return;
            window.requestAnimationFrame(() => {
              if (revision === presentationRevision && !dragging && !dragReleasePending) {
                commitPresentation(nextState, normalizedCollapsed);
              }
            });
          });
          return;
        }
        commitPresentation(nextState, normalizedCollapsed);
        if (targetCoreWidth < canvasCoreWidth) {
          scheduleCanvasShrink(revision, targetCoreWidth);
        }
      };

      function flushPendingPresentation() {
        if (dragging || dragReleasePending || fitting) return;
        if (pendingPresentation) {
          const next = pendingPresentation;
          pendingPresentation = null;
          applyPresentation(next.state, next.collapsed);
        }
        if (pendingFit && !fitRetryDeferred) {
          const nextForce = pendingFitForce;
          pendingFit = false;
          pendingFitForce = false;
          void fitContentNow(nextForce);
        }
      }

      function resumeDeferredFit() {
        if (!fitRetryDeferred) return;
        fitRetryDeferred = false;
        if (!dragging && !dragReleasePending && !fitting) {
          flushPendingPresentation();
        }
      }

      const waitForPresentationToSettle = (releaseRevision) => new Promise((resolve) => {
        const check = () => {
          if (releaseRevision !== dragReleaseRevision) {
            resolve(false);
            return;
          }
          if (
            dragging || dragReleasePending || fitting || pendingPresentation || (pendingFit && !fitRetryDeferred)
            || fitTimer != null || deferredFitTimer != null || morphTimer != null
          ) {
            window.requestAnimationFrame(check);
            return;
          }
          resolve(true);
        };
        window.requestAnimationFrame(check);
      });

      const syncCollapsedState = async (value) => {
        const nextCollapsed = !!value;
        if (!nextCollapsed) {
          cancelScheduledCollapse();
        }
        if (collapsed === nextCollapsed) {
          applyPresentation(visualState, nextCollapsed);
          return;
        }

        applyPresentation(visualState, nextCollapsed);
        if (!api.setFloatingToolbarCollapsed) {
          return;
        }

        try {
          const state = await api.setFloatingToolbarCollapsed(nextCollapsed);
          applyPresentation(
            visualState,
            typeof state?.collapsed === 'boolean' ? state.collapsed : nextCollapsed,
          );
        } catch (error) {
          applyPresentation(visualState, nextCollapsed);
          console.error('[island] collapse sync failed:', error);
        }
      };

      const scheduleAutoCollapse = () => {
        cancelScheduledCollapse();
        if (pointerInside || dragging) {
          return;
        }
        collapseTimer = window.setTimeout(() => {
          collapseTimer = null;
          if (!pointerInside && !dragging) {
            void syncCollapsedState(true);
          }
        }, COLLAPSE_DELAY_MS);
      };

      const syncAutoCollapse = () => {
        if (pointerInside || dragging) {
          cancelScheduledCollapse();
          if (collapsed) {
            void syncCollapsedState(false);
          }
          return;
        }
        if (collapseTimer === null && !collapsed) {
          scheduleAutoCollapse();
        }
      };

      const sessionHasExportableVideo = (session, segments) => {
        if (!session) return false;
        const segs = Array.isArray(segments) ? segments : [];
        if (segs.some((seg) =>
          seg
          && (seg.status === 'ready'
            || seg.isPlayable
            || !!seg.relativePath
            || !!seg.filePath
            || (typeof seg.sizeBytes === 'number' && seg.sizeBytes > 0))
        )) {
          return true;
        }
        return session.status === 'stopped' || typeof session.endedAtMs === 'number';
      };

      const refreshCanExport = async () => {
        try {
          if (!api.listTestSessions) {
            canExport = false;
            return canExport;
          }
          const sessions = await api.listTestSessions();
          if (!Array.isArray(sessions) || sessions.length === 0) {
            canExport = false;
            return canExport;
          }
          const sorted = sessions
            .filter((session) => session && session.sessionId)
            .slice()
            .sort((a, b) => (Number(b.updatedAtMs) || 0) - (Number(a.updatedAtMs) || 0));

          for (const session of sorted.slice(0, 6)) {
            if (session.status === 'active' && session.endedAtMs == null) {
              continue;
            }
            let segments = null;
            if (api.getTestSessionVideoSegments) {
              try {
                segments = await api.getTestSessionVideoSegments({
                  sessionId: session.sessionId,
                  limit: 12,
                });
              } catch {
                segments = null;
              }
            }
            if (sessionHasExportableVideo(session, segments)) {
              canExport = true;
              return canExport;
            }
          }
          canExport = false;
        } catch (error) {
          console.error('[island] refreshCanExport failed:', error);
        }
        return canExport;
      };

      const applyHealth = (health, requestedCollapsed) => {
        const recording = !!health?.recording;
        paused = !!health?.paused;
        const recordingChanged = lastRecording !== recording;
        lastRecording = recording;

        if (recording && recordingChanged && sessionStartedAtMs == null) {
          sessionStartedAtMs = Date.now();
        }
        if (!recording) {
          sessionStartedAtMs = null;
          stopClock();
        } else {
          ensureClock();
        }
        updateClock();

        const state = !recording ? 'idle' : paused ? 'paused' : 'recording';
        const stateDescription = !recording ? '就绪' : paused ? '已暂停' : '录制中';
        statusLabel.textContent = stateDescription;
        dragHandle.title = '按住可直接拖拽；鼠标悬停展开工具条；当前状态：' + stateDescription;

        buttons.start.disabled = busy || recording;
        buttons.stop.disabled = busy || !recording;
        buttons.pause.disabled = busy || !recording || paused;
        buttons.resume.disabled = busy || !recording || !paused;
        buttons.flag.disabled = busy || !recording;
        buttons.export.disabled = busy || recording || !canExport;
        buttons.main.disabled = busy;
        syncAutoCollapse();
        const effectiveCollapsed = pointerInside && requestedCollapsed ? collapsed : requestedCollapsed;
        applyPresentation(state, effectiveCollapsed);
      };

      const refresh = async () => {
        try {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            return;
          }
          const [health, toolbarState] = await Promise.all([
            api.getRuntimeHealth ? api.getRuntimeHealth() : null,
            api.getFloatingToolbarState ? api.getFloatingToolbarState() : null,
          ]);
          if (toolbarState && (toolbarState.theme === 'light' || toolbarState.theme === 'dark')) {
            applyTheme(toolbarState.theme);
          }
          const wasRecording = lastRecording;
          const requestedCollapsed = typeof toolbarState?.collapsed === 'boolean' ? toolbarState.collapsed : collapsed;
          applyHealth(health, requestedCollapsed);
          if (!health?.recording) {
            const now = Date.now();
            const stoppedJustNow = wasRecording && !health?.recording;
            if (stoppedJustNow || now - lastExportCheckAt > 8000) {
              lastExportCheckAt = now;
              await refreshCanExport();
            }
            buttons.export.disabled = busy || !canExport;
          }
        } catch {}
      };

      const runTask = async (task) => {
        if (busy) return;
        busy = true;
        void refresh();
        try {
          await task();
        } catch (error) {
          console.error('[island] action failed:', error);
        } finally {
          busy = false;
          void refresh();
        }
      };

      const markPointerInside = () => {
        pointerInside = true;
        cancelScheduledCollapse();
        if (collapsed && !dragging) {
          void syncCollapsedState(false);
        }
      };

      const onDragMove = (event) => {
        if (!dragging || event.pointerId !== dragPointerId || !api.moveFloatingToolbar) return;
        const nextX = Math.round(event.screenX - dragOffsetX);
        const nextY = Math.round(event.screenY - dragOffsetY);
        if (Math.abs(event.movementX) + Math.abs(event.movementY) > 0) {
          dragMoved = true;
        }
        void api.moveFloatingToolbar({ x: nextX, y: nextY, documentEpoch: DOCUMENT_EPOCH, dragEpoch }).catch((error) => {
          console.error('[island] move failed:', error);
        });
      };
      const sendDragCommand = async (phase, commandDragEpoch) => {
        if (!api.setFloatingToolbarDragging) return false;
        const command = { phase, documentEpoch: DOCUMENT_EPOCH };
        if (typeof commandDragEpoch === 'number') {
          command.dragEpoch = commandDragEpoch;
        }
        try {
          const result = await api.setFloatingToolbarDragging(command);
          return result?.accepted === true;
        } catch (error) {
          console.error('[island] drag ' + phase + ' sync failed:', error);
          return false;
        }
      };
      const onPassivePointerUp = (event) => {
        if (event.button !== 0) return;
        if (!dragging && !dragReleasePending) {
          void sendDragCommand('pointer-up').then((acknowledged) => {
            if (acknowledged) resumeDeferredFit();
          });
        }
      };
      const onDragEnd = async (event) => {
        if (!dragging || event.pointerId !== dragPointerId) return;
        const releaseRevision = dragReleaseRevision;
        const releaseDragEpoch = dragEpoch;
        const startSync = dragStartSync;
        dragging = false;
        dragReleasePending = true;
        window.removeEventListener('pointermove', onDragMove, true);
        window.removeEventListener('pointerup', onDragEnd, true);
        window.removeEventListener('pointercancel', onDragEnd, true);
        if (dragCaptureTarget) {
          dragCaptureTarget.removeEventListener('lostpointercapture', onDragEnd);
          if (dragCaptureTarget.hasPointerCapture(dragPointerId)) {
            dragCaptureTarget.releasePointerCapture(dragPointerId);
          }
        }
        dragPointerId = null;
        dragCaptureTarget = null;
        let mainDragStarted = false;
        let mainDragReleased = false;
        try {
          if (startSync) {
            mainDragStarted = await startSync;
            if (dragStartSync === startSync) {
              dragStartSync = null;
            }
          }
          if (releaseRevision !== dragReleaseRevision || dragging) return;
          const pointerUpAcknowledged = await sendDragCommand(
            'pointer-up',
            mainDragStarted ? releaseDragEpoch : undefined,
          );
          if (!pointerUpAcknowledged || !mainDragStarted || releaseRevision !== dragReleaseRevision || dragging) return;
          resumeDeferredFit();
          mainDragReleased = await sendDragCommand('release-for-fit', releaseDragEpoch);
        } finally {
          const ownsRelease = releaseRevision === dragReleaseRevision && !dragging;
          if (ownsRelease) {
            dragReleasePending = false;
            if (!pointerInside) {
              scheduleAutoCollapse();
            }
            flushPendingPresentation();
            if (mainDragReleased && api.setFloatingToolbarDragging) {
              void waitForPresentationToSettle(releaseRevision).then(async (settled) => {
                if (settled && releaseRevision === dragReleaseRevision && !dragging && api.setFloatingToolbarDragging) {
                  await sendDragCommand('settled', releaseDragEpoch);
                }
              });
            }
          }
        }
      };
      const beginDrag = (event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        if (event.target.closest('.btn, .slim-btn')) return;
        dragReleaseRevision += 1;
        dragEpoch += 1;
        dragging = true;
        dragReleasePending = false;
        dragMoved = false;
        presentationRevision += 1;
        pendingPresentation = desiredPresentation;
        canvasFitUncertain = true;
        lastFitKey = '';
        if (morphTimer != null) {
          window.clearTimeout(morphTimer);
          morphTimer = null;
        }
        if (fitTimer != null) {
          window.clearTimeout(fitTimer);
          fitTimer = null;
          pendingFit = true;
          pendingFitForce = true;
        }
        if (deferredFitTimer != null) {
          window.clearTimeout(deferredFitTimer);
          deferredFitTimer = null;
          pendingFit = true;
          pendingFitForce = true;
        }
        dragOffsetX = event.clientX;
        dragOffsetY = event.clientY;
        dragPointerId = event.pointerId;
        dragCaptureTarget = event.currentTarget;
        dragCaptureTarget.setPointerCapture(event.pointerId);
        if (api.setFloatingToolbarDragging) {
          dragStartSync = sendDragCommand('begin', dragEpoch);
        }
        window.addEventListener('pointermove', onDragMove, true);
        window.addEventListener('pointerup', onDragEnd, true);
        window.addEventListener('pointercancel', onDragEnd, true);
        dragCaptureTarget.addEventListener('lostpointercapture', onDragEnd);
        event.preventDefault();
      };
      window.addEventListener('mouseup', onPassivePointerUp, true);
      dragHandle.addEventListener('pointerdown', beginDrag);
      islandInner.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.btn, .slim-btn, .status-capsule, .capsule-core-cluster')) return;
        beginDrag(event);
      });

      island.addEventListener('mouseenter', markPointerInside);
      island.addEventListener('mousemove', markPointerInside);
      island.addEventListener('mouseleave', () => {
        pointerInside = false;
        if (!dragging) {
          scheduleAutoCollapse();
        }
      });

      island.addEventListener('click', (event) => {
        if (!collapsed) return;
        if (event.target.closest('.btn, .slim-btn')) return;
        if (dragMoved) return;
        void syncCollapsedState(false);
      });
      island.addEventListener('dblclick', (event) => {
        if (event.target.closest('.btn, .slim-btn')) return;
        if (!api.showWindow) return;
        void runTask(() => api.showWindow());
      });

      buttons.start.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void runTask(() => api.start());
      });
      buttons.pause.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void runTask(() => api.pause());
      });
      buttons.resume.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void runTask(() => api.resume());
      });
      buttons.stop.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void runTask(() => api.stop());
      });
      buttons.flag.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void runTask(async () => {
          const markedAtMs = Date.now();
          let activeSession = null;
          if (api.getActiveTestSession) {
            try {
              activeSession = await api.getActiveTestSession();
            } catch {
              activeSession = null;
            }
          }
          const sessionId = activeSession?.sessionId;
          if (api.markTestDefect) {
            await api.markTestDefect({
              sessionId,
              markedAtMs,
              note: '悬浮岛瞬时打标',
              actual: '悬浮岛瞬时打标',
            });
            flashStatus('已标记缺陷', 1800);
            return;
          }
          if (api.appendTestSessionNote) {
            await api.appendTestSessionNote({
              title: '瞬时打标',
              message: '悬浮岛瞬时打标 ' + new Date(markedAtMs).toLocaleTimeString('zh-CN', { hour12: false }),
            });
            flashStatus('已标记缺陷', 1800);
            return;
          }
          throw new Error('No quick flag API');
        });
      });
      buttons.main.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void runTask(async () => {
          if (!api.showWindow) throw new Error('No showWindow API');
          await api.showWindow();
        });
      });

      const flashStatus = (text, ms = 1800) => {
        if (!statusToast) return;
        statusToast.textContent = text;
        statusToast.classList.add('is-visible');
        if (toastTimer != null) {
          window.clearTimeout(toastTimer);
        }
        toastTimer = window.setTimeout(() => {
          statusToast.classList.remove('is-visible');
        }, ms);
      };

      const runExport = (event) => {
        if (event) {
          event.preventDefault();
          event.stopPropagation();
        }
        if (busy) return;
        if (buttons.export.disabled || !canExport) {
          flashStatus('暂无视频');
          return;
        }
        void runTask(async () => {
          if (!api.exportTestSessionEvidence) throw new Error('No export API');
          flashStatus('正在导出…', 4000);
          await api.exportTestSessionEvidence({
            targetDir: '',
            outputMode: 'zip',
            privacyAcknowledgedAt: new Date().toISOString(),
          });
          flashStatus('已导出', 2000);
        });
      };
      buttons.export.addEventListener('click', (event) => runExport(event));

      applyTheme('${initialTheme}');
      applyPresentation(visualState, collapsed);
      window.addEventListener('focus', () => {
        reassertGlassSurface();
        void refresh();
      });
      window.addEventListener('pageshow', reassertGlassSurface);
      // Size is computed from UI state only (no ResizeObserver — avoids growth feedback loops).
      void refresh();
      scheduleFitContent(true);
      window.setInterval(refresh, 4000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          reassertGlassSurface();
          void refresh();
        }
      });
    </script>
  </body>
</html>`;
}
