import { useCallback, useEffect, useState } from 'react';

import type { ResolvedTheme, ThemeMode } from '../lib/theme';
import {
  applyTheme,
  nextThemeMode,
  readStoredTheme,
  resolveTheme,
  themeModeLabel,
} from '../lib/theme';

type UseThemeResult = {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  label: string;
  setMode: (mode: ThemeMode) => void;
  cycleMode: () => void;
};

export function useTheme(): UseThemeResult {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') {
      return 'dark';
    }
    return readStoredTheme();
  });
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(mode));

  const setMode = useCallback((next: ThemeMode) => {
    const nextResolved = applyTheme(next);
    setModeState(next);
    setResolved(nextResolved);
  }, []);

  const cycleMode = useCallback(() => {
    setMode(nextThemeMode(mode));
  }, [mode, setMode]);

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== 'reqcase.shadow-recorder.theme' || !event.newValue) {
        return;
      }
      if (event.newValue === 'dark' || event.newValue === 'light' || event.newValue === 'system') {
        const nextResolved = applyTheme(event.newValue);
        setModeState(event.newValue);
        setResolved(nextResolved);
      }
    };

    const onCustom = (event: Event): void => {
      const detail = (event as CustomEvent<{ mode: ThemeMode; resolved: ResolvedTheme }>).detail;
      if (!detail) {
        return;
      }
      setModeState(detail.mode);
      setResolved(detail.resolved);
    };

    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onSystem = (): void => {
      if (readStoredTheme() !== 'system') {
        return;
      }
      const nextResolved = applyTheme('system');
      setModeState('system');
      setResolved(nextResolved);
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener('reqcase-theme-change', onCustom as EventListener);
    media.addEventListener('change', onSystem);

    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('reqcase-theme-change', onCustom as EventListener);
      media.removeEventListener('change', onSystem);
    };
  }, []);

  return {
    mode,
    resolved,
    label: themeModeLabel(mode),
    setMode,
    cycleMode,
  };
}
