export const DEFAULT_SCREENSHOT_SHORTCUTS = {
  area: 'CommandOrControl+Shift+A',
  monitor: 'CommandOrControl+Shift+F',
  window: 'CommandOrControl+Shift+W',
  pin: 'F3',
} as const;

export type ScreenshotShortcutKind = keyof typeof DEFAULT_SCREENSHOT_SHORTCUTS;

export type ScreenshotShortcutConfig = {
  shortcutStartRecording?: string;
  shortcutStopRecording?: string;
  shortcutCaptureArea?: string;
  shortcutCaptureMonitor?: string;
  shortcutCaptureWindow?: string;
  shortcutCapturePin?: string;
};

export type ResolvedScreenshotShortcuts = {
  area: string | null;
  monitor: string | null;
  window: string | null;
  pin: string | null;
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

export type ShortcutKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
};

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS']);

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  '+': 'Plus',
  '-': 'Minus',
};

export function acceleratorFromKeyboardEvent(event: ShortcutKeyEvent): string | null {
  if (event.repeat) {
    return null;
  }
  if (event.key === 'Backspace' || event.key === 'Escape') {
    return '';
  }
  if (MODIFIER_KEYS.has(event.key)) {
    return null;
  }
  const bareFunctionKey = /^F(?:[1-9]|1\d|2[0-4])$/.test(event.key);
  if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !bareFunctionKey) {
    return null;
  }
  const token = KEY_NAMES[event.key]
    ?? (/^[a-z]$/i.test(event.key) ? event.key.toUpperCase() : null)
    ?? (/^F\d{1,2}$/.test(event.key) ? event.key : null);
  if (!token) {
    return null;
  }
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) {
    parts.push('CommandOrControl');
  }
  if (event.altKey) {
    parts.push('Alt');
  }
  if (event.shiftKey) {
    parts.push('Shift');
  }
  parts.push(token);
  return parts.join('+');
}

export function formatScreenshotAccelerator(accelerator: string): string {
  return accelerator.replaceAll('CommandOrControl', 'Ctrl');
}

export function canAssignScreenshotShortcut(
  kind: ScreenshotShortcutKind,
  accelerator: string,
  config: ScreenshotShortcutConfig,
): boolean {
  const resolved = resolveScreenshotShortcuts(config);
  const taken = (['area', 'monitor', 'window', 'pin'] as const)
    .filter((item) => item !== kind)
    .map((item) => resolved[item])
    .filter((item): item is string => Boolean(item));
  const reserved = [config.shortcutStartRecording, config.shortcutStopRecording]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return ![...reserved, ...taken].includes(accelerator);
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
    pin: take(config.shortcutCapturePin, DEFAULT_SCREENSHOT_SHORTCUTS.pin),
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

export type AreaDisplayLayout = {
  id: number;
  bounds: ScreenshotRect;
  scaleFactor: number;
};

export type AreaOverlayPlan = {
  displayId: number;
  bounds: ScreenshotRect;
  scaleFactor: number;
};

export function planAreaOverlayWindows(displays: AreaDisplayLayout[]): AreaOverlayPlan[] {
  if (!Array.isArray(displays)) {
    return [];
  }
  return displays.flatMap((display) => {
    const bounds = display?.bounds;
    if (!bounds) {
      return [];
    }
    const { x, y, width, height } = bounds;
    if (![display.id, x, y, width, height].every((value) => Number.isFinite(value))) {
      return [];
    }
    if (width <= 0 || height <= 0) {
      return [];
    }
    const scaleFactor = Number.isFinite(display.scaleFactor) && display.scaleFactor > 0
      ? display.scaleFactor
      : 1;
    return [{
      displayId: display.id,
      bounds: {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
      },
      scaleFactor,
    }];
  });
}

export function physicalSelectionOnDisplay(
  display: {
    bounds: ScreenshotRect;
    scaleFactor: number;
    physicalOrigin: DipPoint;
  },
  local: ScreenshotRect,
): ScreenshotRect | null {
  const scale = display?.scaleFactor;
  const origin = display?.physicalOrigin;
  const bounds = display?.bounds;
  if (!bounds || !origin || !local) {
    return null;
  }
  if (![scale, origin.x, origin.y, bounds.x, bounds.y, local.x, local.y, local.width, local.height]
    .every((value) => Number.isFinite(value))) {
    return null;
  }
  if (scale <= 0 || local.width <= 0 || local.height <= 0) {
    return null;
  }
  return physicalRectFromDipCorners(
    { x: local.x, y: local.y },
    { x: local.x + local.width, y: local.y + local.height },
    (point) => ({
      x: origin.x + point.x * scale,
      y: origin.y + point.y * scale,
    }),
  );
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

export function normalizeScreenshotDelaySeconds(value: unknown): 0 | 3 | 5 {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (parsed === 3 || parsed === 5) {
    return parsed;
  }
  return 0;
}

export const SCREENSHOT_HISTORY_LIMIT = 30;

export function trimScreenshotHistory<T extends { createdAtMs: number }>(
  items: T[],
  limit = SCREENSHOT_HISTORY_LIMIT,
): { kept: T[]; removed: T[] } {
  const sorted = [...items].sort((left, right) => right.createdAtMs - left.createdAtMs);
  const cap = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : SCREENSHOT_HISTORY_LIMIT;
  return {
    kept: sorted.slice(0, cap),
    removed: sorted.slice(cap),
  };
}

export const AREA_DRAG_THRESHOLD_PX = 6;

export function chooseAreaSelection(input: {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  hover: ScreenshotRect | null;
}): ScreenshotRect | null {
  const dragged = Math.hypot(input.endX - input.startX, input.endY - input.startY);
  if (dragged >= AREA_DRAG_THRESHOLD_PX) {
    const x = Math.min(input.startX, input.endX);
    const y = Math.min(input.startY, input.endY);
    const width = Math.abs(input.endX - input.startX);
    const height = Math.abs(input.endY - input.startY);
    if (width < 2 || height < 2) {
      return null;
    }
    return { x, y, width, height };
  }
  if (!input.hover || input.hover.width < 2 || input.hover.height < 2) {
    return null;
  }
  return input.hover;
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
