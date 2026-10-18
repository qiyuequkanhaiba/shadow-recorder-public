export const DEFAULT_SCREENSHOT_SHORTCUTS = {
  area: 'CommandOrControl+Shift+A',
  monitor: 'CommandOrControl+Shift+F',
  window: 'CommandOrControl+Shift+W',
} as const;

export type ScreenshotShortcutKind = keyof typeof DEFAULT_SCREENSHOT_SHORTCUTS;

export type ScreenshotShortcutConfig = {
  shortcutStartRecording?: string;
  shortcutStopRecording?: string;
  shortcutCaptureArea?: string;
  shortcutCaptureMonitor?: string;
  shortcutCaptureWindow?: string;
};

export type ResolvedScreenshotShortcuts = {
  area: string | null;
  monitor: string | null;
  window: string | null;
  rejected: string[];
};

export type DipPoint = { x: number; y: number };

export type ScreenshotRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function normalizeAccelerator(value: string | undefined, fallback: string | null): string | null {
  if (value === undefined) {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveScreenshotShortcuts(
  config: ScreenshotShortcutConfig,
): ResolvedScreenshotShortcuts {
  const reserved = new Set(
    [config.shortcutStartRecording, config.shortcutStopRecording]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  );
  const rejected: string[] = [];
  const used = new Set<string>();
  const take = (value: string | undefined, fallback: string): string | null => {
    const accelerator = normalizeAccelerator(value, fallback);
    if (!accelerator) {
      return null;
    }
    if (reserved.has(accelerator) || used.has(accelerator)) {
      rejected.push(accelerator);
      return null;
    }
    used.add(accelerator);
    return accelerator;
  };

  return {
    area: take(config.shortcutCaptureArea, DEFAULT_SCREENSHOT_SHORTCUTS.area),
    monitor: take(config.shortcutCaptureMonitor, DEFAULT_SCREENSHOT_SHORTCUTS.monitor),
    window: take(config.shortcutCaptureWindow, DEFAULT_SCREENSHOT_SHORTCUTS.window),
    rejected,
  };
}

export function physicalRectFromDipCorners(
  start: DipPoint,
  end: DipPoint,
  toPhysical: (point: DipPoint) => DipPoint,
): ScreenshotRect | null {
  const first = toPhysical(start);
  const second = toPhysical(end);
  if (![first.x, first.y, second.x, second.y].every((value) => Number.isFinite(value))) {
    return null;
  }
  const left = Math.min(first.x, second.x);
  const top = Math.min(first.y, second.y);
  const right = Math.max(first.x, second.x);
  const bottom = Math.max(first.y, second.y);
  const width = Math.round(right - left);
  const height = Math.round(bottom - top);
  if (width < 1 || height < 1) {
    return null;
  }
  return {
    x: Math.round(left),
    y: Math.round(top),
    width,
    height,
  };
}

export function unionDisplayBounds(
  displays: ScreenshotRect[],
): ScreenshotRect {
  if (displays.length === 0) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  const left = Math.min(...displays.map((display) => display.x));
  const top = Math.min(...displays.map((display) => display.y));
  const right = Math.max(...displays.map((display) => display.x + display.width));
  const bottom = Math.max(...displays.map((display) => display.y + display.height));
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.max(1, Math.round(right - left)),
    height: Math.max(1, Math.round(bottom - top)),
  };
}

export function parseSelectionRect(value: unknown): ScreenshotRect | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const numbers = ['x', 'y', 'width', 'height'].map((key) => Number(record[key]));
  if (numbers.some((item) => !Number.isFinite(item))) {
    return null;
  }
  const [x, y, width, height] = numbers.map((item) => Math.round(item));
  if (width < 1 || height < 1 || width > 20000 || height > 20000) {
    return null;
  }
  return { x, y, width, height };
}
