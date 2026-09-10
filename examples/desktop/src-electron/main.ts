import path from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';

import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  protocol,
  screen,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type Rectangle,
  type WebContents,
} from 'electron';

import {
  exportDiagnosticsBundle,
  recorderDiagnosticsErrorLog,
  registerReqCaseShadowRecorderIpc,
  ReqCaseShadowRecorderService,
  REQCASE_SHADOW_RECORDER_CHANNELS,
} from './modules/reqcase-shadow-recorder';
import { createFloatingToolbarHtml } from './floating-toolbar';
import { FloatingToolbarDisplayMetricsRefreshCoordinator } from './floating-toolbar-display-metrics';
import {
  isCurrentFloatingToolbarRenderer,
  requestFloatingToolbarDisplayMetricsRefresh,
  routeFloatingToolbarDragCommand,
  shouldApplyFloatingToolbarMove,
} from './floating-toolbar-main-routes';
import type {
  FloatingToolbarDragCommand,
  FloatingToolbarFitRequest,
  FloatingToolbarMoveRequest,
} from './floating-toolbar-drag-protocol';
import {
  scaleFloatingToolbarCoreSize,
  type FloatingToolbarVisualState,
} from './floating-toolbar-layout';

let mainWindow: BrowserWindow | null = null;
let toolbarWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let appQuitting = false;
let recorderService: ReqCaseShadowRecorderService | null = null;
let toolbarCollapsed = true;
let toolbarDragging = false;
let toolbarReloading = false;
let toolbarDocumentEpoch = 0;
const toolbarDisplayMetricsRefreshCoordinator = new FloatingToolbarDisplayMetricsRefreshCoordinator(
  { schedule: (task) => setImmediate(task) },
  () => applyFloatingToolbarDisplayMetricsRefresh(),
);
/** Last explicitly fitted size — never grow past this unless content state changes. */
let toolbarFittedSize: { width: number; height: number } | null = null;
let uiTheme: 'dark' | 'light' = 'dark';
let lastMainWindowBounds: Rectangle | null = null;
let mainWindowShouldShow = false;
const loadedMainWindows = new WeakSet<BrowserWindow>();
const loadingMainWindows = new WeakMap<BrowserWindow, Promise<void>>();
const rendererTargets = new Set<WebContents>();
const SAFE_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);
const DEFAULT_SAFE_EXTERNAL_HOSTS = [
  'localhost',
  '127.0.0.1',
  'learn.microsoft.com',
  'electronjs.org',
  'react.dev',
  'openai.com',
  'github.com',
];
const SHOW_MAIN_WINDOW_SHORTCUT = 'CommandOrControl+Alt+M';
const MEDIA_PROTOCOL = 'reqcase-media';
const ENABLE_MAIN_WINDOW_DEV_SERVER = process.env.REQCASE_MAIN_WINDOW_DEV_SERVER === '1';
const OPEN_MAIN_WINDOW_ON_START = process.env.REQCASE_OPEN_MAIN_WINDOW === '1';

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

function loadSafeExternalHostAllowlist(): Set<string> {
  const envRaw = process.env.REQCASE_ALLOWED_EXTERNAL_HOSTS;
  if (!envRaw) {
    return new Set(DEFAULT_SAFE_EXTERNAL_HOSTS);
  }

  const parsed = envRaw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);

  if (parsed.length === 0) {
    return new Set(DEFAULT_SAFE_EXTERNAL_HOSTS);
  }
  return new Set(parsed);
}

const SAFE_EXTERNAL_HOSTS = loadSafeExternalHostAllowlist();
const TOOLBAR_MARGIN = 10;

/** UI scale from display resolution / DPI (CSS already DIP-aware; this boosts high-res screens). */
function getToolbarUiScale(display?: Electron.Display): number {
  const d = display ?? screen.getPrimaryDisplay();
  const width = d.workAreaSize?.width ?? d.size.width ?? 1920;
  const scaleFactor = d.scaleFactor || 1;
  const resScale = width >= 3840 ? 1.25 : width >= 2560 ? 1.12 : width >= 1920 ? 1.0 : width >= 1366 ? 0.95 : 0.9;
  const dpiNudge = scaleFactor >= 2 ? 1.08 : scaleFactor >= 1.5 ? 1.04 : 1;
  return Math.min(1.4, Math.max(0.85, resScale * dpiNudge));
}

function removeRendererTarget(target: WebContents): void {
  rendererTargets.delete(target);
  if (rendererTargets.size === 0) {
    recorderService?.unsubscribePush();
  }
}

function getIconPath(): string | undefined {
  if (app.isPackaged && (process as any).resourcesPath) {
    const packagedIco = path.join((process as any).resourcesPath, 'ico.ico');
    if (existsSync(packagedIco)) {
      return packagedIco;
    }
  }
  const repoRoot = path.resolve(__dirname, '../../../../');
  const icoPath = path.join(repoRoot, 'ico.ico');
  if (existsSync(icoPath)) {
    return icoPath;
  }
  return undefined;
}

function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (!SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
      return false;
    }
    if (parsed.protocol === 'mailto:') {
      return true;
    }
    const host = parsed.hostname.toLowerCase();
    if (!host) {
      return false;
    }
    if (SAFE_EXTERNAL_HOSTS.has(host)) {
      return true;
    }
    for (const allowedHost of SAFE_EXTERNAL_HOSTS) {
      if (host.endsWith(`.${allowedHost}`)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function formatShortcutLabel(accelerator: string): string {
  if (process.platform === 'darwin') {
    return accelerator
      .replace('CommandOrControl', 'Cmd')
      .replace('Alt', 'Option');
  }
  return accelerator
    .replace('CommandOrControl', 'Ctrl')
    .replaceAll('+', ' + ');
}

function getToolbarVisualState(): FloatingToolbarVisualState {
  if (!recorderService?.isRecording()) {
    return 'idle';
  }
  return recorderService.isPaused() ? 'paused' : 'recording';
}

function getToolbarSize(
  collapsed: boolean,
  state: FloatingToolbarVisualState,
  uiScale: number,
): { width: number; height: number } {
  return scaleFloatingToolbarCoreSize(collapsed, state, uiScale);
}

function isWithinRoot(rootDir: string, targetPath: string): boolean {
  const relative = path.relative(rootDir, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function collectAllowedMediaRoots(): string[] {
  const roots = new Set<string>();
  roots.add(path.resolve(__dirname, '../reports'));
  roots.add(path.resolve(__dirname, '../../dist-electron/reports'));
  roots.add(path.resolve(__dirname, '../../reports'));
  roots.add(path.resolve(app.getPath('userData'), 'reports'));
  if (app.isPackaged && process.resourcesPath) {
    roots.add(path.resolve(process.resourcesPath, 'reports'));
  }
  return Array.from(roots);
}

function resolveMediaMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.m3u8':
      return 'application/vnd.apple.mpegurl';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.ndjson':
      return 'application/x-ndjson; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function parseByteRange(rangeHeader: string, fileSize: number): {
  start: number;
  end: number;
} | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) {
    return null;
  }

  const startToken = match[1];
  const endToken = match[2];

  if (!startToken && !endToken) {
    return null;
  }

  if (!startToken) {
    const suffixLength = Number.parseInt(endToken, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    const start = Math.max(fileSize - suffixLength, 0);
    return {
      start,
      end: fileSize - 1,
    };
  }

  const start = Number.parseInt(startToken, 10);
  if (!Number.isFinite(start) || start < 0 || start >= fileSize) {
    return null;
  }

  const end = endToken
    ? Number.parseInt(endToken, 10)
    : fileSize - 1;
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  return {
    start,
    end: Math.min(end, fileSize - 1),
  };
}

function registerMediaProtocol(): void {
  protocol.handle(MEDIA_PROTOCOL, async (request) => {
    try {
      const requestUrl = new URL(request.url);
      const rawPath = requestUrl.searchParams.get('path');
      if (!rawPath) {
        return new Response('Missing media path', { status: 400 });
      }

      const resolvedPath = path.resolve(rawPath);
      const allowed = collectAllowedMediaRoots().some((rootDir) => isWithinRoot(rootDir, resolvedPath));
      if (!allowed) {
        return new Response('Forbidden media path', { status: 403 });
      }
      if (!existsSync(resolvedPath)) {
        return new Response('Media not found', { status: 404 });
      }

      const fileStat = statSync(resolvedPath);
      if (!fileStat.isFile()) {
        return new Response('Media is not a file', { status: 400 });
      }

      const headers = new Headers({
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        'content-type': resolveMediaMimeType(resolvedPath),
      });
      const method = request.method.toUpperCase();
      const rangeHeader = request.headers.get('range');

      if (rangeHeader) {
        const range = parseByteRange(rangeHeader, fileStat.size);
        if (!range) {
          headers.set('content-range', `bytes */${fileStat.size}`);
          return new Response(null, {
            status: 416,
            headers,
          });
        }

        const contentLength = range.end - range.start + 1;
        headers.set('content-range', `bytes ${range.start}-${range.end}/${fileStat.size}`);
        headers.set('content-length', String(contentLength));

        if (method === 'HEAD') {
          return new Response(null, {
            status: 206,
            headers,
          });
        }

        const stream = createReadStream(resolvedPath, {
          start: range.start,
          end: range.end,
        });
        return new Response(Readable.toWeb(stream) as BodyInit, {
          status: 206,
          headers,
        });
      }

      headers.set('content-length', String(fileStat.size));

      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers,
        });
      }

      const stream = createReadStream(resolvedPath);
      return new Response(Readable.toWeb(stream) as BodyInit, {
        status: 200,
        headers,
      });
    } catch (error) {
      console.error('[media-protocol] failed to resolve request', error);
      return new Response('Media load failed', { status: 500 });
    }
  });
}

function applyToolbarShape(window: BrowserWindow): void {
  try {
    // The transparent BrowserWindow is exactly the CSS capsule bounds.
    // CSS alpha supplies the antialiased rounded edge; pixel setShape is jagged.
    window.setShape([]);
  } catch (error: unknown) {
    console.warn('[floating-toolbar] failed to apply shaped window region', error);
  }
}

function clampToolbarBounds(bounds: Rectangle): Rectangle {
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - bounds.width);
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - bounds.height);

  return {
    ...bounds,
    x: Math.min(Math.max(bounds.x, workArea.x), maxX),
    y: Math.min(Math.max(bounds.y, workArea.y), maxY),
  };
}

function isWindowBoundsVisible(bounds: Rectangle): boolean {
  if (bounds.x <= -30000 || bounds.y <= -30000) {
    return false;
  }

  return screen.getAllDisplays().some((display) => {
    const workArea = display.workArea;
    const intersectsHorizontally =
      bounds.x < workArea.x + workArea.width && bounds.x + bounds.width > workArea.x;
    const intersectsVertically =
      bounds.y < workArea.y + workArea.height && bounds.y + bounds.height > workArea.y;
    return intersectsHorizontally && intersectsVertically;
  });
}

function buildVisibleMainWindowBounds(currentBounds: Rectangle): Rectangle {
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const nextWidth = Math.min(Math.max(currentBounds.width, 1080), primaryWorkArea.width);
  const nextHeight = Math.min(Math.max(currentBounds.height, 760), primaryWorkArea.height);
  return {
    width: nextWidth,
    height: nextHeight,
    x: primaryWorkArea.x + Math.max(Math.floor((primaryWorkArea.width - nextWidth) / 2), 0),
    y: primaryWorkArea.y + Math.max(Math.floor((primaryWorkArea.height - nextHeight) / 2), 0),
  };
}

function buildToolbarBounds(
  collapsed: boolean,
  currentBounds: Rectangle | undefined,
  state: FloatingToolbarVisualState,
  uiScale: number,
): Rectangle {
  const size = getToolbarSize(collapsed, state, uiScale);
  if (!currentBounds) {
    const workArea = screen.getPrimaryDisplay().workArea;
    return {
      x: workArea.x + workArea.width - size.width - TOOLBAR_MARGIN,
      y: workArea.y + TOOLBAR_MARGIN,
      width: size.width,
      height: size.height,
    };
  }

  return clampToolbarBounds({
    x: currentBounds.x + currentBounds.width - size.width,
    y: currentBounds.y,
    width: size.width,
    height: size.height,
  });
}

function admitNextFloatingToolbarDocument(): number {
  const nextEpoch = toolbarDocumentEpoch + 1;
  if (!toolbarDisplayMetricsRefreshCoordinator.admitDocument(nextEpoch)) {
    throw new Error('Failed to admit floating toolbar document');
  }
  toolbarDocumentEpoch = nextEpoch;
  return toolbarDocumentEpoch;
}

function cancelFloatingToolbarInteraction(): void {
  toolbarDragging = false;
  toolbarDisplayMetricsRefreshCoordinator.cancelInteraction(toolbarDocumentEpoch);
}

function getFloatingToolbarState(): {
  collapsed: boolean;
  theme: 'dark' | 'light';
} {
  return {
    collapsed: toolbarCollapsed,
    theme: uiTheme,
  };
}

function fitFloatingToolbarSize(
  event: IpcMainInvokeEvent,
  request: FloatingToolbarFitRequest,
): { width: number; height: number } {
  const size = { width: request.width, height: request.height };
  if (!toolbarWindow || toolbarWindow.isDestroyed()) {
    return size;
  }
  const current = toolbarWindow.getBounds();
  if (!isCurrentFloatingToolbarRenderer(
    event,
    toolbarWindow,
    request.documentEpoch,
    toolbarDocumentEpoch,
  )) {
    return { width: current.width, height: current.height };
  }
  // Preserve drag and refresh ownership until the current document is stable.
  if (
    toolbarDragging
    || toolbarReloading
    || toolbarDisplayMetricsRefreshCoordinator.isFitFrozen()
  ) {
    return { width: current.width, height: current.height };
  }
  const width = Math.max(24, Math.min(640, Math.round(size.width)));
  const height = Math.max(24, Math.min(200, Math.round(size.height)));
  if (current.width === width && current.height === height) {
    applyToolbarShape(toolbarWindow);
    toolbarFittedSize = { width, height };
    return { width, height };
  }
  // Keep top-left fixed so residual resizes never crawl toward bottom-right.
  const nextBounds = clampToolbarBounds({
    x: current.x,
    y: current.y,
    width,
    height,
  });
  toolbarWindow.setBounds(nextBounds, false);
  applyToolbarShape(toolbarWindow);
  toolbarFittedSize = { width: nextBounds.width, height: nextBounds.height };
  return { width: nextBounds.width, height: nextBounds.height };
}

function moveFloatingToolbar(
  event: IpcMainInvokeEvent,
  request: FloatingToolbarMoveRequest,
): { x: number; y: number } {
  const pos = { x: request.x, y: request.y };
  if (!toolbarWindow || toolbarWindow.isDestroyed()) {
    return pos;
  }
  const current = toolbarWindow.getBounds();
  const acceptedRenderer = isCurrentFloatingToolbarRenderer(
    event,
    toolbarWindow,
    request.documentEpoch,
    toolbarDocumentEpoch,
  );
  if (!shouldApplyFloatingToolbarMove({
    acceptedRenderer,
    currentlyDragging: toolbarDragging,
    coordinator: toolbarDisplayMetricsRefreshCoordinator,
  }, request)) {
    return { x: current.x, y: current.y };
  }
  if (toolbarReloading) {
    return { x: current.x, y: current.y };
  }
  const width = toolbarFittedSize?.width ?? current.width;
  const height = toolbarFittedSize?.height ?? current.height;
  const next = clampToolbarBounds({
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    width,
    height,
  });
  // Explicit width/height every move so Windows DPI cannot inflate bounds.
  toolbarWindow.setBounds({ x: next.x, y: next.y, width, height }, false);
  return { x: next.x, y: next.y };
}

function setFloatingToolbarDragging(
  event: IpcMainInvokeEvent,
  command: FloatingToolbarDragCommand,
): { dragging: boolean; accepted: boolean } {
  const routeResult = routeFloatingToolbarDragCommand({
    acceptedRenderer: isCurrentFloatingToolbarRenderer(
      event,
      toolbarWindow,
      command.documentEpoch,
      toolbarDocumentEpoch,
    ),
    currentlyDragging: toolbarDragging,
    window: toolbarWindow,
    coordinator: toolbarDisplayMetricsRefreshCoordinator,
  }, command);
  toolbarDragging = routeResult.dragging;
  if (routeResult.fittedSize) {
    toolbarFittedSize = routeResult.fittedSize;
  }
  return { dragging: toolbarDragging, accepted: routeResult.accepted };
}

function applyFloatingToolbarDisplayMetricsRefresh(): void {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) {
    toolbarDisplayMetricsRefreshCoordinator.completeRefresh();
    return;
  }
  try {
    const nextToolbarState = getToolbarVisualState();
    const currentBounds = toolbarWindow.getBounds();
    const nextToolbarScale = getToolbarUiScale(screen.getDisplayMatching(currentBounds));
    const bounds = buildToolbarBounds(
      toolbarCollapsed,
      currentBounds,
      nextToolbarState,
      nextToolbarScale,
    );
    const nextToolbarDocumentEpoch = admitNextFloatingToolbarDocument();
    toolbarReloading = true;
    toolbarWindow.setBounds(bounds, false);
    toolbarFittedSize = { width: bounds.width, height: bounds.height };
    void toolbarWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        createFloatingToolbarHtml({
          initialCollapsed: toolbarCollapsed,
          initialState: nextToolbarState,
          initialStartedAtMs: recorderService?.getActiveSession()?.startedAtMs,
          initialTheme: uiTheme,
          uiScale: nextToolbarScale,
          documentEpoch: nextToolbarDocumentEpoch,
        }),
      )}`,
    ).catch((error) => {
      console.warn('[floating-toolbar] display metrics reload failed', error);
    }).finally(() => {
      toolbarReloading = false;
      toolbarDisplayMetricsRefreshCoordinator.completeRefresh();
    });
  } catch (error: unknown) {
    toolbarReloading = false;
    toolbarDisplayMetricsRefreshCoordinator.completeRefresh();
    console.warn('[floating-toolbar] display metrics refresh failed', error);
  }
}

function refreshFloatingToolbarForDisplayMetrics(): void {
  requestFloatingToolbarDisplayMetricsRefresh(toolbarWindow, toolbarDisplayMetricsRefreshCoordinator);
}

function reassertToolbarTransparentSurface(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }
  try {
    window.setBackgroundColor('#00000000');
  } catch {
    // ignore
  }
  try {
    window.webContents.invalidate();
  } catch {
    // ignore
  }
}

function setUiTheme(theme: 'dark' | 'light'): { theme: 'dark' | 'light' } {
  uiTheme = theme === 'light' ? 'light' : 'dark';
  if (toolbarWindow && !toolbarWindow.isDestroyed()) {
    reassertToolbarTransparentSurface(toolbarWindow);
    // Do not set color-scheme here. Chromium uses it as an opaque canvas on
    // transparent windows, so a theme/background switch turns the island into
    // a black or white slab. The capsule itself stays light glass.
    void toolbarWindow.webContents.executeJavaScript(
      `document.documentElement.setAttribute('data-theme', '${uiTheme}');document.documentElement.style.colorScheme='only light';document.documentElement.style.background='transparent';document.documentElement.style.backgroundColor='transparent';if(document.body){document.body.style.background='transparent';document.body.style.backgroundColor='transparent';}`,
    );
  }
  return { theme: uiTheme };
}

async function waitForWindowLoad(window: BrowserWindow, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      window.webContents.removeListener('did-finish-load', handleLoad);
      window.webContents.removeListener('did-fail-load', handleFail);
      resolve(result);
    };

    const handleLoad = (): void => {
      cleanup(true);
    };

    const handleFail = (): void => {
      cleanup(false);
    };

    timer = setTimeout(() => {
      cleanup(false);
    }, timeoutMs);

    window.webContents.once('did-finish-load', handleLoad);
    window.webContents.once('did-fail-load', handleFail);
  });
}

async function captureMainWindowRendererSnapshot(window: BrowserWindow): Promise<{
  href: string;
  title: string;
  hasRootShell: boolean;
  bodyTextSample: string;
  serviceWorkerController: string | null;
} | null> {
  try {
    const snapshot = await window.webContents.executeJavaScript(
      `JSON.stringify({
        href: window.location.href,
        title: document.title,
        hasRootShell: !!document.querySelector('.workspace-shell'),
        bodyTextSample: (document.body?.innerText || '').slice(0, 240),
        serviceWorkerController: navigator.serviceWorker?.controller?.scriptURL ?? null,
      })`,
      true,
    );

    return JSON.parse(String(snapshot)) as {
      href: string;
      title: string;
      hasRootShell: boolean;
      bodyTextSample: string;
      serviceWorkerController: string | null;
    };
  } catch (error) {
    console.warn('[main-window] failed to capture renderer snapshot', error);
    return null;
  }
}

function isExpectedMainWindowSnapshot(snapshot: {
  title: string;
  hasRootShell: boolean;
  bodyTextSample: string;
} | null): boolean {
  if (!snapshot) {
    return false;
  }

  const sample = snapshot.bodyTextSample ?? '';
  return (
    snapshot.title.includes('影子录制器')
    && snapshot.hasRootShell
    && (
      sample.includes('循环录制与事件回顾')
      || sample.includes('录制与回放')
      || sample.includes('基础设置')
    )
  );
}

async function loadMainWindowContents(window: BrowserWindow): Promise<void> {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const staticEntry = path.resolve(__dirname, '../../dist-react/index.html');

  if (devUrl && ENABLE_MAIN_WINDOW_DEV_SERVER) {
    try {
      await window.webContents.session.clearCache();
      await window.webContents.session.clearStorageData({
        storages: ['serviceworkers', 'cachestorage'],
      });
      console.log('[main-window] cleared dev session cache/service workers');
    } catch (error) {
      console.warn('[main-window] failed to clear dev session state', error);
    }

    const devTarget = `${devUrl}${devUrl.includes('?') ? '&' : '?'}app=reqcase-shadow-recorder`;
    console.log('[main-window] loading dev url', devTarget);
    try {
      void window.loadURL(devTarget);
      const loaded = await waitForWindowLoad(window, 8000);
      if (loaded) {
        const snapshot = await captureMainWindowRendererSnapshot(window);
        console.log('[main-window] renderer-snapshot', JSON.stringify(snapshot));
        if (isExpectedMainWindowSnapshot(snapshot)) {
          return;
        }
        console.warn('[main-window] unexpected dev renderer content, falling back to static build');
      } else {
        console.warn('[main-window] dev url load timed out or failed, falling back to static build');
      }
    } catch (error) {
      console.warn('[main-window] dev url load failed, falling back to static build', error);
    }

    try {
      window.webContents.stop();
    } catch {}
  }

  if (devUrl && !ENABLE_MAIN_WINDOW_DEV_SERVER) {
    console.log(
      '[main-window] dev server detected but static main window mode is enabled; loading built renderer',
    );
  }

  console.log('[main-window] loading static file', staticEntry);
  await window.loadFile(staticEntry);
}

function ensureMainWindowContents(window: BrowserWindow): Promise<void> {
  if (loadedMainWindows.has(window)) {
    return Promise.resolve();
  }

  const inFlight = loadingMainWindows.get(window);
  if (inFlight) {
    return inFlight;
  }

  const nextLoad = loadMainWindowContents(window)
    .catch((error) => {
      console.error('[main-window] failed to load contents', error);
      throw error;
    })
    .finally(() => {
      loadingMainWindows.delete(window);
    });

  loadingMainWindows.set(window, nextLoad);
  return nextLoad;
}

function createMainWindow(): BrowserWindow {
  const iconPath = getIconPath();
  const rememberedBounds = lastMainWindowBounds;
  const window = new BrowserWindow({
    width: rememberedBounds?.width ?? 1200,
    height: rememberedBounds?.height ?? 840,
    x: rememberedBounds?.x,
    y: rememberedBounds?.y,
    minWidth: 1080,
    minHeight: 760,
    show: false,
    title: '影子录制器',
    icon: iconPath,
    backgroundColor: '#020617',
    webPreferences: {
      preload: path.resolve(__dirname, './preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  window.webContents.on('did-finish-load', () => {
    loadedMainWindows.add(window);
    console.log('[main-window] did-finish-load');
  });

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(
      '[main-window] did-fail-load',
      JSON.stringify({
        errorCode,
        errorDescription,
        validatedURL,
      }),
    );
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main-window] render-process-gone', JSON.stringify(details));
  });

  window.webContents.on('unresponsive', () => {
    console.error('[main-window] renderer became unresponsive');
  });

  window.webContents.on('responsive', () => {
    console.log('[main-window] renderer responsive again');
  });

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(
      '[main-window] preload-error',
      JSON.stringify({
        preloadPath,
        error: error?.stack ?? error?.message ?? String(error),
      }),
    );
  });

  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2 || message.includes('[shadow-recorder]')) {
      const method = level >= 3 ? 'error' : level === 2 ? 'warn' : 'log';
      console[method](
        `[main-window][console:${level}] ${message} (${sourceId}:${line})`,
      );
    }
  });

  window.once('ready-to-show', () => {
    if (!appQuitting && mainWindowShouldShow) {
      window.show();
      window.focus();
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  window.on('show', () => {
    rendererTargets.add(window.webContents);
  });

  window.on('hide', () => {
    removeRendererTarget(window.webContents);
  });

  window.on('minimize', () => {
    if (recorderService?.isRecording()) {
      setTimeout(() => {
        disposeMainWindow();
        showFloatingToolbar();
      }, 0);
    }
  });

  window.on('close', (event) => {
    if (!appQuitting) {
      event.preventDefault();
      disposeMainWindow();
      showFloatingToolbar();
      new Notification({
        title: '影子录制器',
        body: '主界面已隐藏，悬浮窗与托盘仍可继续操作。',
        icon: iconPath,
      }).show();
    }
  });

  window.on('closed', () => {
    removeRendererTarget(window.webContents);
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

function ensureMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  mainWindow = createMainWindow();
  return mainWindow;
}

function disposeMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = null;
    return;
  }

  try {
    lastMainWindowBounds = mainWindow.getBounds();
  } catch {}

  const windowToDispose = mainWindow;
  const webContents = windowToDispose.webContents;

  removeRendererTarget(webContents);
  mainWindowShouldShow = false;
  mainWindow = null;

  try {
    windowToDispose.removeAllListeners('close');
    windowToDispose.removeAllListeners('hide');
    windowToDispose.removeAllListeners('show');
    windowToDispose.removeAllListeners('minimize');
    windowToDispose.removeAllListeners('closed');
    windowToDispose.removeAllListeners('ready-to-show');
    webContents.removeAllListeners('did-finish-load');
    webContents.removeAllListeners('did-fail-load');
    webContents.removeAllListeners('render-process-gone');
    webContents.removeAllListeners('unresponsive');
    webContents.removeAllListeners('responsive');
    webContents.removeAllListeners('preload-error');
    webContents.removeAllListeners('console-message');
    windowToDispose.destroy();
  } catch (error) {
    console.warn('[main-window] failed to dispose renderer window', error);
  }
}

function showMainWindow(): void {
  const window = ensureMainWindow();
  mainWindowShouldShow = true;
  const currentBounds = window.getBounds();
  if (!isWindowBoundsVisible(currentBounds)) {
    const nextBounds = buildVisibleMainWindowBounds(currentBounds);
    console.warn('[main-window] window bounds were off-screen, resetting', JSON.stringify({
      currentBounds,
      nextBounds,
    }));
    window.setBounds(nextBounds, false);
  }
  if (window.isMinimized()) {
    window.restore();
  }
  if (!loadedMainWindows.has(window)) {
    void ensureMainWindowContents(window);
    return;
  }
  window.show();
  window.moveTop();
  window.focus();
}

function refreshTrayMenu(): void {
  if (!tray) {
    return;
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '开始录制',
        click: () => {
          startBackgroundRecording();
        },
      },
      {
        label: '停止录制',
        click: () => {
          stopBackgroundRecording();
        },
      },
      { type: 'separator' },
      {
        label: `打开主页面 (${formatShortcutLabel(SHOW_MAIN_WINDOW_SHORTCUT)})`,
        click: () => {
          showMainWindow();
        },
      },
      {
        label: '显示悬浮窗',
        click: () => {
          showFloatingToolbar();
        },
      },
      {
        label: toolbarCollapsed ? '展开悬浮窗' : '折叠悬浮窗',
        click: () => {
          setFloatingToolbarCollapsed(!toolbarCollapsed);
          showFloatingToolbar();
        },
      },
      { type: 'separator' },
      {
        label: 'Export diagnostics bundle',
        click: () => {
          void exportDiagnosticsFromTray();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          appQuitting = true;
          if (recorderService?.isRecording()) {
            recorderService.stop();
          }
          app.quit();
        },
      },
    ]),
  );
}

function setFloatingToolbarCollapsed(collapsed: boolean): {
  collapsed: boolean;
} {
  toolbarCollapsed = collapsed;
  // Size is owned by the renderer fit pass after collapse state changes.
  // Do not apply main-process bounds here — it races with fit and can look like growth.
  if (toolbarWindow && !toolbarWindow.isDestroyed() && !toolbarDragging) {
    applyToolbarShape(toolbarWindow);
  }
  refreshTrayMenu();
  return getFloatingToolbarState();
}

function createToolbarWindow(): BrowserWindow {
  const iconPath = getIconPath();
  const initialToolbarState = getToolbarVisualState();
  const initialToolbarScale = getToolbarUiScale();
  const initialToolbarDocumentEpoch = admitNextFloatingToolbarDocument();
  const initialBounds = buildToolbarBounds(
    toolbarCollapsed,
    undefined,
    initialToolbarState,
    initialToolbarScale,
  );
  const window = new BrowserWindow({
    x: initialBounds.x,
    y: initialBounds.y,
    width: initialBounds.width,
    height: initialBounds.height,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    title: '',
    icon: iconPath,
    // Transparent window: only the island paints (single glass card, no nested outer frame).
    // Drag size is frozen separately to avoid DPI growth; white-flash mitigated by no opaque body fill.
    transparent: true,
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    accentColor: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    webPreferences: {
      preload: path.resolve(__dirname, './preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  window.webContents.on('before-mouse-event', (_event, mouse) => {
    if (mouse.button !== 'left') {
      return;
    }
    if (mouse.type === 'mouseDown') {
      toolbarDisplayMetricsRefreshCoordinator.beginNativePointer(toolbarDocumentEpoch);
      return;
    }
    if (mouse.type === 'mouseUp') {
      toolbarDisplayMetricsRefreshCoordinator.observeNativePointerUp(toolbarDocumentEpoch);
    }
  });
  window.webContents.on('render-process-gone', () => {
    cancelFloatingToolbarInteraction();
  });
  window.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame) {
      cancelFloatingToolbarInteraction();
    }
  });

  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.removeMenu();
  window.setMenuBarVisibility(false);
  window.setBackgroundColor('#00000000');
  applyToolbarShape(window);
  window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      createFloatingToolbarHtml({
        initialCollapsed: toolbarCollapsed,
        initialState: initialToolbarState,
        initialStartedAtMs: recorderService?.getActiveSession()?.startedAtMs,
        initialTheme: uiTheme,
        uiScale: initialToolbarScale,
        documentEpoch: initialToolbarDocumentEpoch,
      }),
    )}`,
  ).catch((error) => {
    console.error('[floating-toolbar] failed to load toolbar window', error);
  });

  window.once('ready-to-show', () => {
    if (!appQuitting) {
      applyToolbarShape(window);
      reassertToolbarTransparentSurface(window);
      window.showInactive();
      window.moveTop();
    }
  });

  window.on('show', () => {
    reassertToolbarTransparentSurface(window);
  });
  window.on('hide', () => {
    cancelFloatingToolbarInteraction();
  });
  window.on('blur', () => {
    reassertToolbarTransparentSurface(window);
  });
  window.on('focus', () => {
    reassertToolbarTransparentSurface(window);
  });

  window.on('resize', () => {
    applyToolbarShape(window);
    reassertToolbarTransparentSurface(window);
  });

  window.on('close', (event) => {
    if (!appQuitting) {
      event.preventDefault();
      window.hide();
    }
  });

  window.on('closed', () => {
    cancelFloatingToolbarInteraction();
    if (toolbarWindow === window) {
      toolbarWindow = null;
    }
  });

  return window;
}

function ensureFloatingToolbar(): BrowserWindow {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) {
    return toolbarWindow;
  }
  toolbarWindow = createToolbarWindow();
  return toolbarWindow;
}

function showFloatingToolbar(): void {
  const window = ensureFloatingToolbar();
  window.showInactive();
  window.moveTop();
}

function startBackgroundRecording(): void {
  if (!recorderService) {
    return;
  }
  if (!recorderService.isRecording()) {
    recorderService.start();
    setFloatingToolbarCollapsed(true);
  }
  showFloatingToolbar();
}

function stopBackgroundRecording(): void {
  if (!recorderService) {
    return;
  }
  if (recorderService.isRecording()) {
    recorderService.stop();
    setFloatingToolbarCollapsed(false);
  }
  showFloatingToolbar();
}

async function exportDiagnosticsFromTray(): Promise<void> {
  const result = await dialog.showOpenDialog({
    title: 'Select diagnostics export directory',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return;
  }

  const targetDir = result.filePaths[0];
  try {
    const exported = await exportDiagnosticsBundle({
      targetDir,
      appVersion: app.getVersion(),
      nativeLoaded: recorderService?.isNativeLoaded() ?? false,
      lastMetrics: recorderService?.isNativeLoaded() ? recorderService.getMetrics() : undefined,
      recentErrors: recorderDiagnosticsErrorLog.list(),
    });
    new Notification({
      title: 'Shadow Recorder',
      body: `Diagnostics bundle exported: ${exported.zipPath}`,
      icon: getIconPath(),
    }).show();
  } catch (error) {
    recorderDiagnosticsErrorLog.record(error, 'exportDiagnosticsFromTray');
    console.error('[diagnostics] export failed', error);
    new Notification({
      title: 'Shadow Recorder',
      body: 'Diagnostics export failed. Check the main process log.',
      icon: getIconPath(),
    }).show();
  }
}

function createTray(): void {
  const iconPath = getIconPath();
  const image = iconPath
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAOElEQVR42mNgGAXUB8QwGoaJgQEHQwP/Gf4TQYhSwwsSgEwMFQxEDMkgIYGBgQEPH4YkA2oQjR4AAAtYQmU5isfWwAAAABJRU5ErkJggg==',
    );

  tray = new Tray(image);
  tray.setToolTip('影子录制器');
  refreshTrayMenu();

  tray.on('double-click', () => {
    showMainWindow();
  });
}

function registerAppShortcuts(): void {
  try {
    globalShortcut.register(SHOW_MAIN_WINDOW_SHORTCUT, () => {
      showMainWindow();
    });
  } catch (error: unknown) {
    console.error('Failed to register show main window shortcut', error);
  }
}

function registerIpc(): void {
  recorderService = registerReqCaseShadowRecorderIpc({
    hideWindowToTray: () => {
      disposeMainWindow();
      showFloatingToolbar();
    },
    showWindow: () => {
      showMainWindow();
    },
    setFloatingToolbarCollapsed,
    getFloatingToolbarState,
    setUiTheme,
    fitFloatingToolbarSize,
    moveFloatingToolbar,
    setFloatingToolbarDragging,
    addRendererTarget: (target: Electron.WebContents) => {
      rendererTargets.add(target);
      target.once('destroyed', () => {
        removeRendererTarget(target);
      });
    },
    removeRendererTarget,
    getRendererTargets: () => Array.from(rendererTargets),
  });

  ipcMain.removeHandler(REQCASE_SHADOW_RECORDER_CHANNELS.listAvailableDisplays);
  ipcMain.handle(REQCASE_SHADOW_RECORDER_CHANNELS.listAvailableDisplays, () => {
    return recorderService?.listAvailableDisplays() ?? [];
  });
}

app.whenReady().then(() => {
  registerMediaProtocol();
  registerIpc();
  screen.on('display-metrics-changed', () => {
    refreshFloatingToolbarForDisplayMetrics();
  });
  createTray();
  ensureFloatingToolbar();
  registerAppShortcuts();
  if (OPEN_MAIN_WINDOW_ON_START) {
    setTimeout(() => {
      showMainWindow();
    }, 1200);
  }
});

app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    return;
  }
  showFloatingToolbar();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  appQuitting = true;
  globalShortcut.unregisterAll();
});
