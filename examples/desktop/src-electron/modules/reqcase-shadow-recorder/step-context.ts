import type {
  ReqCaseShadowRecorderStep,
  ReqCaseShadowRecorderStructuredStepAction,
  ReqCaseShadowRecorderStructuredStepContext,
  ReqCaseShadowRecorderTestSessionTimelineEvent,
} from './types';

export type StructuredStepAction = ReqCaseShadowRecorderStructuredStepAction;
export type StructuredStepContext = ReqCaseShadowRecorderStructuredStepContext;

type StepContextInput = Pick<ReqCaseShadowRecorderStep, 'id' | 'timestampMs' | 'x' | 'y'>
  & Partial<Pick<
    ReqCaseShadowRecorderStep,
    'action' | 'windowTitle' | 'processName' | 'captureBackend' | 'imageWebpBase64' | 'imageBytes'
  >>
  & {
    fullImagePath?: string;
    thumbImagePath?: string;
    privacyFiltered?: boolean;
  };

const ACTION_ALIASES: Record<string, StructuredStepAction> = {
  click: 'click',
  left_click: 'click',
  WM_LBUTTONDOWN: 'click',
  double_click: 'double_click',
  WM_LBUTTONDBLCLK: 'double_click',
  right_click: 'right_click',
  WM_RBUTTONDOWN: 'right_click',
  scroll: 'scroll',
  mouse_wheel: 'scroll',
  WM_MOUSEWHEEL: 'scroll',
  WM_MOUSEWHEEL_UP: 'scroll',
  WM_MOUSEWHEEL_DOWN: 'scroll',
};

export function normalizeStructuredStepAction(action: string | undefined): StructuredStepAction {
  if (!action) {
    return 'unknown';
  }
  return ACTION_ALIASES[action] ?? ACTION_ALIASES[action.trim()] ?? 'unknown';
}

export function buildStructuredStepContext(input: StepContextInput): StructuredStepContext {
  return {
    stepId: input.id,
    timestampMs: input.timestampMs,
    action: normalizeStructuredStepAction(input.action),
    position: { x: input.x, y: input.y },
    windowTitle: input.windowTitle || undefined,
    processName: input.processName || undefined,
    captureBackend: input.captureBackend || undefined,
    hasImage: hasImageArtifact(input),
    privacyFiltered: input.privacyFiltered === true,
  };
}

export function buildStructuredStepContextFromEvent(
  event: ReqCaseShadowRecorderTestSessionTimelineEvent,
): StructuredStepContext | undefined {
  if (event.eventType !== 'step_captured' || !event.stepId) {
    return undefined;
  }

  return buildStructuredStepContext({
    id: event.stepId,
    timestampMs: event.occurredAtMs,
    action: event.action,
    x: event.x ?? 0,
    y: event.y ?? 0,
    windowTitle: event.windowTitle,
    processName: event.processName,
    captureBackend: event.captureBackend,
    imageBytes: event.imageBytes,
    fullImagePath: event.fullImagePath,
    thumbImagePath: event.thumbImagePath,
    privacyFiltered: isPrivacyFilteredEvent(event),
  });
}

function hasImageArtifact(input: StepContextInput): boolean {
  return !!input.imageWebpBase64
    || (typeof input.imageBytes === 'number' && input.imageBytes > 0)
    || !!input.fullImagePath
    || !!input.thumbImagePath;
}

function isPrivacyFilteredEvent(event: ReqCaseShadowRecorderTestSessionTimelineEvent): boolean {
  return event.privacyFiltered === true;
}
