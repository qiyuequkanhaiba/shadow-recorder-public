import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  BrowserWindow,
  Notification as ElectronNotification,
  app,
  clipboard,
  dialog,
  nativeImage,
  screen,
  shell,
} from 'electron';

import { captureScreenshot, windowBoundsAtPoint } from './native-binding';
import {
  normalizeScreenshotDelaySeconds,
  parseSelectionRect,
  physicalRectFromDipCorners,
  trimScreenshotHistory,
  unionDisplayBounds,
  type ScreenshotRect,
} from './screenshot-capture';
import {
  createCountdownHtml,
  createPinHtml,
  createScreenshotOverlayHtml,
} from './screenshot-overlay-html';

type PrivacyConfig = {
  privacyEnabled?: boolean;
  maskRegions?: Array<{ x: number; y: number; width: number; height: number }>;
  screenshotDelaySeconds?: number;
};

type HistoryItem = {
  id: string;
  fileName: string;
  createdAtMs: number;
  width: number;
  height: number;
};

type FrozenShot = {
  png: Buffer;
  dip: ScreenshotRect;
};

let overlay: BrowserWindow | null = null;
let frozen: FrozenShot | null = null;
let readPrivacy: () => PrivacyConfig | undefined = () => undefined;
let captureInFlight = false;
let delayCancelled = false;
const pins = new Map<string, BrowserWindow>();

function notify(title: string, body: string): void {
  if (!ElectronNotification.isSupported()) {
    return;
  }
  new ElectronNotification({ title, body }).show();
}

function privacyPayload(config: PrivacyConfig | undefined): {
  privacyEnabled: boolean;
  masks: Array<{ x: number; y: number; width: number; height: number }>;
} {
  const masks = (config?.maskRegions ?? [])
    .map((region) => ({
      x: Math.max(0, Math.round(region.x)),
      y: Math.max(0, Math.round(region.y)),
      width: Math.max(0, Math.round(region.width)),
      height: Math.max(0, Math.round(region.height)),
    }))
    .filter((region) => region.width > 0 && region.height > 0);
  return {
    privacyEnabled: Boolean(config?.privacyEnabled),
    masks,
  };
}

function closeOverlay(): void {
  frozen = null;
  const current = overlay;
  overlay = null;
  if (current && !current.isDestroyed()) {
    current.close();
  }
}

function virtualDesktopBounds(): ScreenshotRect {
  return unionDisplayBounds(
    screen.getAllDisplays().map((display) => ({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    })),
  );
}

function showExcludedFromCapture(win: BrowserWindow): void {
  if (win.isDestroyed()) {
    return;
  }
  win.setContentProtection(true);
  win.show();
}

function ensureOverlay(): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) {
    return overlay;
  }
  const bounds = virtualDesktopBounds();
  const window = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.resolve(__dirname, './preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.on('closed', () => {
    if (overlay === window) {
      overlay = null;
      frozen = null;
    }
  });
  void window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(createScreenshotOverlayHtml())}`,
  );
  overlay = window;
  return window;
}

async function runCountdown(seconds: 0 | 3 | 5): Promise<boolean> {
  if (seconds === 0) {
    return true;
  }
  delayCancelled = false;
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const width = 140;
  const height = 140;
  const win = new BrowserWindow({
    x: Math.round(display.bounds.x + (display.bounds.width - width) / 2),
    y: Math.round(display.bounds.y + (display.bounds.height - height) / 2),
    width,
    height,
    frame: false,
    transparent: true,
    focusable: true,
    skipTaskbar: true,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.resolve(__dirname, './preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  try {
    await win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(createCountdownHtml())}`,
    );
    showExcludedFromCapture(win);
    win.focus();
    for (let remaining = seconds; remaining > 0; remaining -= 1) {
      if (win.isDestroyed() || delayCancelled) {
        return false;
      }
      await win.webContents.executeJavaScript(
        `document.getElementById('n').textContent = ${remaining}`,
        true,
      );
      const started = Date.now();
      while (Date.now() - started < 1000) {
        if (delayCancelled || win.isDestroyed()) {
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    return !delayCancelled;
  } finally {
    if (!win.isDestroyed()) {
      win.close();
    }
  }
}

function historyDirectory(): string {
  return path.join(app.getPath('userData'), 'screenshot-history');
}

function readHistory(): HistoryItem[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(historyDirectory(), 'index.json'), 'utf8'));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is HistoryItem => {
      if (!item || typeof item !== 'object') {
        return false;
      }
      const record = item as HistoryItem;
      return typeof record.id === 'string' && typeof record.fileName === 'string';
    });
  } catch {
    return [];
  }
}

function rememberScreenshot(png: Buffer): void {
  try {
    const size = nativeImage.createFromBuffer(png).getSize();
    const directory = historyDirectory();
    mkdirSync(directory, { recursive: true });
    const item: HistoryItem = {
      id: `shot-${Date.now()}`,
      fileName: '',
      createdAtMs: Date.now(),
      width: size.width,
      height: size.height,
    };
    item.fileName = `${item.id}.png`;
    writeFileSync(path.join(directory, item.fileName), png);
    const next = trimScreenshotHistory([item, ...readHistory()]);
    for (const removed of next.removed) {
      try {
        unlinkSync(path.join(directory, removed.fileName));
      } catch {
        // The index can mention a file that was already removed.
      }
    }
    writeFileSync(path.join(directory, 'index.json'), JSON.stringify(next.kept));
  } catch (error: unknown) {
    console.warn('Failed to remember screenshot', error);
  }
}

function pngFromOverride(override: unknown): Buffer | null {
  if (typeof override !== 'string' || override.length < 16) {
    return null;
  }
  const png = Buffer.from(override, 'base64');
  return png.length > 8 ? png : null;
}

function currentPng(override: unknown): Buffer | null {
  return pngFromOverride(override) ?? frozen?.png ?? null;
}

const pinDrags = new Map<string, { originX: number; originY: number; screenX: number; screenY: number }>();
const pinHomes = new Map<string, { x: number; y: number; width: number; height: number }>();
const pinPayloads = new Map<string, Buffer>();

function pinAssetDirectory(): string {
  const directory = path.join(app.getPath('userData'), 'screenshot-pins');
  mkdirSync(directory, { recursive: true });
  return directory;
}

function forgetPin(id: string): void {
  pins.delete(id);
  pinDrags.delete(id);
  pinHomes.delete(id);
  pinPayloads.delete(id);
  const directory = path.join(app.getPath('userData'), 'screenshot-pins');
  for (const name of [`${id}.png`, `${id}.html`]) {
    try {
      unlinkSync(path.join(directory, name));
    } catch {
      // The pin file is already gone.
    }
  }
}

function pinWindowSize(size: { width: number; height: number }, scaleFactor: number): { width: number; height: number } {
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workAreaSize;
  const factor = scaleFactor > 0 ? scaleFactor : 1;
  const dipWidth = size.width / factor;
  const dipHeight = size.height / factor;
  const maxWidth = Math.max(80, area.width - 48);
  const maxHeight = Math.max(60, area.height - 48);
  const scale = Math.min(1, maxWidth / Math.max(dipWidth, 1), maxHeight / Math.max(dipHeight, 1));
  return {
    width: Math.max(80, Math.round(dipWidth * scale)),
    height: Math.max(60, Math.round(dipHeight * scale)),
  };
}

function openPin(png: Buffer): void {
  const size = nativeImage.createFromBuffer(png).getSize();
  if (!size.width || !size.height) {
    notify('没有可贴上的图片', '这张图片无法显示');
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { width, height } = pinWindowSize(size, display.scaleFactor || 1);
  const id = `pin-${Date.now()}-${pins.size}`;
  const home = {
    x: Math.round(cursor.x - width / 2),
    y: Math.round(cursor.y - height / 2),
    width,
    height,
  };
  const directory = pinAssetDirectory();
  const imageName = `${id}.png`;
  writeFileSync(path.join(directory, imageName), png);
  writeFileSync(path.join(directory, `${id}.html`), createPinHtml(id, imageName));
  const win = new BrowserWindow({
    x: home.x,
    y: home.y,
    width,
    height,
    show: false,
    frame: false,
    transparent: false,
    thickFrame: false,
    roundedCorners: false,
    focusable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    autoHideMenuBar: true,
    backgroundColor: '#111111',
    title: '',
    webPreferences: {
      preload: path.resolve(__dirname, './preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.setTitle('');
  win.setMenuBarVisibility(false);
  win.setBackgroundColor('#111111');
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pins.set(id, win);
  pinHomes.set(id, home);
  pinPayloads.set(id, png);
  win.on('closed', () => {
    forgetPin(id);
  });
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) {
      return;
    }
    win.show();
    win.focus();
  });
  void win.loadFile(path.join(directory, `${id}.html`));
}

export async function copyPinnedScreenshot(id: string): Promise<{ ok: boolean; message: string }> {
  const png = pinPayloads.get(id);
  if (!png) {
    return { ok: false, message: '没有可复制的截图' };
  }
  copyPng(png);
  notify('截图已复制', '图片在剪贴板里');
  return { ok: true, message: '已复制' };
}

export async function savePinnedScreenshot(id: string): Promise<{ ok: boolean; message: string }> {
  const png = pinPayloads.get(id);
  const win = pins.get(id);
  if (!png) {
    return { ok: false, message: '没有可保存的截图' };
  }
  const stamp = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const fileName = `截图-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.png`;
  const options = {
    defaultPath: path.join(app.getPath('pictures'), fileName),
    filters: [{ name: 'PNG', extensions: ['png'] }],
  };
  const result = win && !win.isDestroyed()
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) {
    return { ok: false, message: '已取消保存' };
  }
  try {
    mkdirSync(path.dirname(result.filePath), { recursive: true });
    writeFileSync(result.filePath, png);
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : '保存失败' };
  }
  notify('截图已保存', result.filePath);
  return { ok: true, message: '已保存' };
}

export function beginPinnedDrag(id: string, screenX: number, screenY: number): void {
  const win = pins.get(id);
  if (!win || win.isDestroyed() || !Number.isFinite(screenX) || !Number.isFinite(screenY)) {
    return;
  }
  const [originX, originY] = win.getPosition();
  pinDrags.set(id, { originX, originY, screenX, screenY });
}

export function movePinnedScreenshot(id: string, screenX: number, screenY: number): void {
  const win = pins.get(id);
  const drag = pinDrags.get(id);
  if (!win || win.isDestroyed() || !drag || !Number.isFinite(screenX) || !Number.isFinite(screenY)) {
    return;
  }
  win.setPosition(
    Math.round(drag.originX + screenX - drag.screenX),
    Math.round(drag.originY + screenY - drag.screenY),
  );
}

export function endPinnedDrag(id: string): void {
  pinDrags.delete(id);
}

export function scalePinnedScreenshot(id: string, deltaY: number, screenX: number, screenY: number): void {
  const win = pins.get(id);
  const home = pinHomes.get(id);
  if (!win || win.isDestroyed() || !home || !Number.isFinite(deltaY) || !Number.isFinite(screenX) || !Number.isFinite(screenY)) {
    return;
  }
  const bounds = win.getBounds();
  const factor = deltaY > 0 ? 0.9 : 1.1;
  const nextWidth = Math.max(80, Math.min(2400, Math.round(bounds.width * factor)));
  const nextHeight = Math.max(48, Math.round(nextWidth * home.height / Math.max(1, home.width)));
  const ratioX = bounds.width > 0 ? (screenX - bounds.x) / bounds.width : 0.5;
  const ratioY = bounds.height > 0 ? (screenY - bounds.y) / bounds.height : 0.5;
  win.setBounds({
    x: Math.round(screenX - ratioX * nextWidth),
    y: Math.round(screenY - ratioY * nextHeight),
    width: nextWidth,
    height: nextHeight,
  });
}

export function resetPinnedScreenshot(id: string): void {
  const win = pins.get(id);
  const home = pinHomes.get(id);
  if (!win || win.isDestroyed() || !home) {
    return;
  }
  win.setIgnoreMouseEvents(false);
  win.setBounds(home);
}

export function setPinnedClickThrough(id: string, enabled: boolean): void {
  const win = pins.get(id);
  if (!win || win.isDestroyed()) {
    return;
  }
  win.setIgnoreMouseEvents(enabled, { forward: true });
}

export function closeAllPinnedScreenshots(): void {
  for (const win of [...pins.values()]) {
    if (!win.isDestroyed()) {
      win.close();
    }
  }
}

export function pinQuickScreenshot(): void {
  if (overlay && !overlay.isDestroyed() && overlay.isVisible() && frozen) {
    overlay.webContents.send('reqcase:screenshot:pin-request');
    return;
  }
  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    const png = image.toPNG();
    if (png.length > 32) {
      rememberScreenshot(png);
      openPin(png);
      return;
    }
  }
  const latest = listScreenshotHistory()[0];
  if (latest) {
    try {
      openPin(readFileSync(latest.filePath));
      return;
    } catch (error: unknown) {
      console.warn('Failed to pin latest screenshot', error);
    }
  }
  notify('没有可贴上的图片', '先截一张图，或复制一张图片后再按贴图快捷键');
}

async function grab(request: {
  mode: 'region' | 'monitor' | 'window';
  x: number;
  y: number;
  width: number;
  height: number;
}): Promise<{ png: Buffer; width: number; height: number }> {
  if (captureInFlight) {
    throw new Error('已有截图正在进行');
  }
  captureInFlight = true;
  try {
    const config = readPrivacy();
    const continued = await runCountdown(normalizeScreenshotDelaySeconds(config?.screenshotDelaySeconds));
    if (!continued) {
      throw new Error('已取消');
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    const privacy = privacyPayload(config);
    const captured = captureScreenshot({
      ...request,
      privacyEnabled: privacy.privacyEnabled,
      masks: privacy.masks,
    });
    return {
      png: Buffer.from(captured.pngBase64, 'base64'),
      width: captured.width,
      height: captured.height,
    };
  } finally {
    captureInFlight = false;
  }
}

function copyPng(png: Buffer): void {
  clipboard.writeImage(nativeImage.createFromBuffer(png));
}

export async function beginAreaScreenshot(
  readConfig: () => PrivacyConfig | undefined,
): Promise<void> {
  readPrivacy = readConfig;
  closeOverlay();
  const window = ensureOverlay();
  showExcludedFromCapture(window);
  window.focus();
}

export async function captureInstantScreenshot(
  mode: 'monitor' | 'window',
  readConfig: () => PrivacyConfig | undefined,
): Promise<void> {
  readPrivacy = readConfig;
  const dip = screen.getCursorScreenPoint();
  const physical = screen.dipToScreenPoint(dip);
  try {
    const captured = await grab({
      mode,
      x: physical.x,
      y: physical.y,
      width: 0,
      height: 0,
    });
    copyPng(captured.png);
    rememberScreenshot(captured.png);
    notify('截图已复制', mode === 'window' ? '已复制光标下的窗口' : '已复制当前屏幕');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '截图失败';
    notify(message === '已取消' ? '已取消截图' : '截图失败', message === '已取消' ? '倒计时已取消' : message);
  }
}

function overlayHwnd(window: BrowserWindow): number {
  const handle = window.getNativeWindowHandle();
  if (handle.length >= 8) {
    const value = handle.readBigUInt64LE(0);
    if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
  }
  return handle.length >= 4 ? handle.readUInt32LE(0) : 0;
}

export function windowSelectionAtClientPoint(clientX: number, clientY: number): ScreenshotRect | null {
  const window = overlay;
  if (!window || window.isDestroyed() || !Number.isFinite(clientX) || !Number.isFinite(clientY)) {
    return null;
  }
  const bounds = window.getBounds();
  const physical = screen.dipToScreenPoint({
    x: bounds.x + clientX,
    y: bounds.y + clientY,
  });
  let found: { x: number; y: number; width: number; height: number } | null = null;
  try {
    found = windowBoundsAtPoint(physical.x, physical.y, overlayHwnd(window));
  } catch (error: unknown) {
    console.warn('Failed to resolve the window under the cursor', error);
    return null;
  }
  if (!found) {
    return null;
  }
  const origin = screen.screenToDipPoint({ x: found.x, y: found.y });
  const far = screen.screenToDipPoint({
    x: found.x + found.width,
    y: found.y + found.height,
  });
  const local = {
    x: Math.round(origin.x - bounds.x),
    y: Math.round(origin.y - bounds.y),
    width: Math.round(far.x - origin.x),
    height: Math.round(far.y - origin.y),
  };
  if (local.width < 2 || local.height < 2) {
    return null;
  }
  return local;
}

export async function confirmAreaSelection(value: unknown): Promise<{
  ok: boolean;
  message?: string;
  pngBase64?: string;
  dipX?: number;
  dipY?: number;
  dipWidth?: number;
  dipHeight?: number;
}> {
  const local = parseSelectionRect(value);
  const window = overlay;
  if (!local || !window || window.isDestroyed()) {
    return { ok: false, message: '选区无效' };
  }
  const bounds = window.getBounds();
  const physical = physicalRectFromDipCorners(
    { x: bounds.x + local.x, y: bounds.y + local.y },
    { x: bounds.x + local.x + local.width, y: bounds.y + local.y + local.height },
    (point) => screen.dipToScreenPoint(point),
  );
  if (!physical) {
    return { ok: false, message: '选区太小' };
  }
  window.hide();
  try {
    const captured = await grab({ mode: 'region', ...physical });
    frozen = { png: captured.png, dip: local };
    if (!window.isDestroyed()) {
      showExcludedFromCapture(window);
      window.focus();
    }
    return {
      ok: true,
      pngBase64: captured.png.toString('base64'),
      dipX: local.x,
      dipY: local.y,
      dipWidth: local.width,
      dipHeight: local.height,
    };
  } catch (error: unknown) {
    if (!window.isDestroyed()) {
      showExcludedFromCapture(window);
      window.focus();
    }
    return { ok: false, message: error instanceof Error ? error.message : '截图失败' };
  }
}

export function cancelAreaScreenshot(): void {
  closeOverlay();
}

export function cancelScreenshotDelay(): void {
  delayCancelled = true;
}

export async function copyFrozenScreenshot(override?: unknown): Promise<{ ok: boolean; message: string }> {
  const png = currentPng(override);
  if (!png) {
    return { ok: false, message: '没有可复制的截图' };
  }
  copyPng(png);
  rememberScreenshot(png);
  closeOverlay();
  notify('截图已复制', '图片在剪贴板里');
  return { ok: true, message: '已复制' };
}

export async function pinFrozenScreenshot(override?: unknown): Promise<{ ok: boolean; message: string }> {
  const png = currentPng(override);
  if (!png) {
    return { ok: false, message: '没有可贴上的截图' };
  }
  rememberScreenshot(png);
  openPin(png);
  closeOverlay();
  return { ok: true, message: '已贴上' };
}

export function closePinnedScreenshot(id: string): void {
  const win = pins.get(id);
  if (win && !win.isDestroyed()) {
    win.close();
  }
}

export function listScreenshotHistory(): Array<HistoryItem & { filePath: string }> {
  const directory = historyDirectory();
  return readHistory()
    .filter((item) => existsSync(path.join(directory, item.fileName)))
    .map((item) => ({
      ...item,
      filePath: path.join(directory, item.fileName),
    }));
}

export function pinScreenshotHistory(id: string): { ok: boolean; message: string } {
  const item = listScreenshotHistory().find((entry) => entry.id === id);
  if (!item) {
    return { ok: false, message: '找不到这张截图' };
  }
  openPin(readFileSync(item.filePath));
  return { ok: true, message: '已贴上' };
}

export function revealScreenshotHistory(): void {
  const directory = historyDirectory();
  mkdirSync(directory, { recursive: true });
  void shell.openPath(directory);
}

export async function saveFrozenScreenshot(override?: unknown): Promise<{ ok: boolean; message: string }> {
  const png = currentPng(override);
  if (!png) {
    return { ok: false, message: '没有可保存的截图' };
  }
  if (overlay && !overlay.isDestroyed()) {
    overlay.hide();
  }
  const stamp = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const fileName = `截图-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.png`;
  const result = await dialog.showSaveDialog({
    defaultPath: path.join(app.getPath('pictures'), fileName),
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (result.canceled || !result.filePath) {
    if (overlay && !overlay.isDestroyed()) {
      showExcludedFromCapture(overlay);
      overlay.focus();
    }
    return { ok: false, message: '已取消保存' };
  }
  try {
    mkdirSync(path.dirname(result.filePath), { recursive: true });
    writeFileSync(result.filePath, png);
  } catch (error: unknown) {
    if (overlay && !overlay.isDestroyed()) {
      showExcludedFromCapture(overlay);
      overlay.focus();
    }
    return { ok: false, message: error instanceof Error ? error.message : '保存失败' };
  }
  rememberScreenshot(png);
  closeOverlay();
  notify('截图已保存', result.filePath);
  return { ok: true, message: '已保存' };
}
