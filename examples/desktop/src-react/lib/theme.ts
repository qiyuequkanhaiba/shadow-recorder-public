export type ThemeMode = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'reqcase.shadow-recorder.theme';

const THEME_MODES: ThemeMode[] = ['dark', 'light', 'system'];

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'dark' || value === 'light' || value === 'system';
}

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark';
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function readStoredTheme(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeMode(raw)) {
      return raw;
    }
  } catch {
    // ignore storage failures (private mode, etc.)
  }
  return 'dark';
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? getSystemTheme() : mode;
}

export function themeModeLabel(mode: ThemeMode): string {
  switch (mode) {
    case 'light':
      return '浅色';
    case 'system':
      return '跟随系统';
    case 'dark':
    default:
      return '深色';
  }
}

export function nextThemeMode(mode: ThemeMode): ThemeMode {
  const index = THEME_MODES.indexOf(mode);
  return THEME_MODES[(index + 1) % THEME_MODES.length] ?? 'dark';
}

/** Apply theme to document root. Safe to call before React mounts. */
export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-theme-mode', mode);
  root.style.colorScheme = resolved;

  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) {
    meta.setAttribute('content', resolved);
  }

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // ignore
  }

  window.dispatchEvent(
    new CustomEvent('reqcase-theme-change', {
      detail: { mode, resolved },
    }),
  );

  try {
    const bridge = (window as Window & {
      reqcaseShadowRecorder?: { setUiTheme?: (theme: 'dark' | 'light') => Promise<unknown> };
    }).reqcaseShadowRecorder;
    void bridge?.setUiTheme?.(resolved);
  } catch {
    // ignore
  }

  return resolved;
}

export function initTheme(): { mode: ThemeMode; resolved: ResolvedTheme } {
  const mode = readStoredTheme();
  const resolved = applyTheme(mode);
  return { mode, resolved };
}
