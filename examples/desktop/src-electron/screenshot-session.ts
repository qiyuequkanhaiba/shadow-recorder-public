import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  BrowserWindow,
  Notification as ElectronNotification,
  app,
  clipboard,
  dialog,
  nativeImage,
  screen,
} from 'electron';

import { captureScreenshot } from './native-binding';
import {
  parseSelectionRect,
  physicalRectFromDipCorners,
  unionDisplayBounds,
  type ScreenshotRect,
} from './screenshot-capture';
import { createScreenshotOverlayHtml } from './screenshot-overlay-html';

type PrivacyConfig = {
  privacyEnabled?: boolean;
  maskRegions?: Array<{ x: number; y: number; width: number; height: number }>;
};

type FrozenShot = {
  png: Buffer;
  dip: ScreenshotRect;
};

let overlay: BrowserWindow | null = null;
let frozen: FrozenShot | null = null;
let readPrivacy: () => PrivacyConfig | undefined = () => undefined;
let captureInFlight = false;

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
    const privacy = privacyPayload(readPrivacy());
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
  window.show();
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
    notify('截图已复制', mode === 'window' ? '已复制光标下的窗口' : '已复制当前屏幕');
  } catch (error: unknown) {
    notify('截图失败', error instanceof Error ? error.message : '截图失败');
  }
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
  await new Promise((resolve) => setTimeout(resolve, 80));
  try {
    const captured = await grab({ mode: 'region', ...physical });
    frozen = { png: captured.png, dip: local };
    if (!window.isDestroyed()) {
      window.show();
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
      window.show();
      window.focus();
    }
    return { ok: false, message: error instanceof Error ? error.message : '截图失败' };
  }
}

export function cancelAreaScreenshot(): void {
  closeOverlay();
}

export async function copyFrozenScreenshot(): Promise<{ ok: boolean; message: string }> {
  if (!frozen) {
    return { ok: false, message: '没有可复制的截图' };
  }
  copyPng(frozen.png);
  closeOverlay();
  notify('截图已复制', '图片在剪贴板里');
  return { ok: true, message: '已复制' };
}

export async function saveFrozenScreenshot(): Promise<{ ok: boolean; message: string }> {
  if (!frozen) {
    return { ok: false, message: '没有可保存的截图' };
  }
  const png = frozen.png;
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
      overlay.show();
      overlay.focus();
    }
    return { ok: false, message: '已取消保存' };
  }
  try {
    mkdirSync(path.dirname(result.filePath), { recursive: true });
    writeFileSync(result.filePath, png);
  } catch (error: unknown) {
    if (overlay && !overlay.isDestroyed()) {
      overlay.show();
      overlay.focus();
    }
    return { ok: false, message: error instanceof Error ? error.message : '保存失败' };
  }
  closeOverlay();
  notify('截图已保存', result.filePath);
  return { ok: true, message: '已保存' };
}
