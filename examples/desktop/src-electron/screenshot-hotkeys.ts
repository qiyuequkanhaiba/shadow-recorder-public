import { globalShortcut } from 'electron';

import {
  resolveScreenshotShortcuts,
  type ScreenshotShortcutConfig,
  type ScreenshotShortcutKind,
} from './screenshot-capture';

const registered = new Map<ScreenshotShortcutKind, string>();

export function syncScreenshotHotkeys(
  config: ScreenshotShortcutConfig,
  actions: Record<ScreenshotShortcutKind, () => void>,
): string[] {
  const resolved = resolveScreenshotShortcuts(config);
  const next: Record<ScreenshotShortcutKind, string | null> = {
    area: resolved.area,
    monitor: resolved.monitor,
    window: resolved.window,
  };

  (Object.keys(next) as ScreenshotShortcutKind[]).forEach((kind) => {
    const previous = registered.get(kind) ?? null;
    const accelerator = next[kind];
    if (previous && previous !== accelerator) {
      try {
        globalShortcut.unregister(previous);
      } catch (error: unknown) {
        console.warn('Failed to unregister screenshot shortcut', previous, error);
      }
      registered.delete(kind);
    }
    if (!accelerator || registered.get(kind) === accelerator) {
      return;
    }
    try {
      const registeredOk = globalShortcut.register(accelerator, actions[kind]);
      if (registeredOk) {
        registered.set(kind, accelerator);
      } else {
        resolved.rejected.push(accelerator);
      }
    } catch (error: unknown) {
      console.error('Failed to register screenshot shortcut', accelerator, error);
      resolved.rejected.push(accelerator);
    }
  });

  return resolved.rejected;
}
