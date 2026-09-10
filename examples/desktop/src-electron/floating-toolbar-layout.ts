export type FloatingToolbarVisualState = 'idle' | 'recording' | 'paused';

export const FLOATING_TOOLBAR_LAYOUT = {
  collapsedWidth: 58,
  idleExpandedWidth: 128,
  activeExpandedWidth: 178,
  height: 34,
} as const;

export function getFloatingToolbarCoreSize(
  collapsed: boolean,
  state: FloatingToolbarVisualState,
): { width: number; height: number } {
  if (collapsed) {
    return {
      width: FLOATING_TOOLBAR_LAYOUT.collapsedWidth,
      height: FLOATING_TOOLBAR_LAYOUT.height,
    };
  }

  return {
    width: state === 'idle'
      ? FLOATING_TOOLBAR_LAYOUT.idleExpandedWidth
      : FLOATING_TOOLBAR_LAYOUT.activeExpandedWidth,
    height: FLOATING_TOOLBAR_LAYOUT.height,
  };
}

export function scaleFloatingToolbarCoreSize(
  collapsed: boolean,
  state: FloatingToolbarVisualState,
  uiScale: number,
): { width: number; height: number } {
  const core = getFloatingToolbarCoreSize(collapsed, state);
  return {
    width: Math.ceil(core.width * uiScale),
    height: Math.ceil(core.height * uiScale),
  };
}
