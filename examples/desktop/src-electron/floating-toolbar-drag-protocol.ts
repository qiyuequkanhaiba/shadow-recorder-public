export type FloatingToolbarDragPhase =
  | 'begin'
  | 'release-for-fit'
  | 'settled'
  | 'pointer-up';

type FloatingToolbarDragEpochCommand = {
  phase: Exclude<FloatingToolbarDragPhase, 'pointer-up'>;
  documentEpoch: number;
  dragEpoch: number;
};

type FloatingToolbarPointerUpCommand = {
  phase: 'pointer-up';
  documentEpoch: number;
  dragEpoch?: number;
};

export type FloatingToolbarDragCommand =
  | FloatingToolbarDragEpochCommand
  | FloatingToolbarPointerUpCommand;

export type FloatingToolbarFitRequest = {
  width: number;
  height: number;
  documentEpoch: number;
};

export type FloatingToolbarMoveRequest = {
  x: number;
  y: number;
  documentEpoch: number;
  dragEpoch: number;
};

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isFloatingToolbarDragCommand(value: unknown): value is FloatingToolbarDragCommand {
  if (!isRecord(value) || !isPositiveSafeInteger(value.documentEpoch)) {
    return false;
  }

  if (value.phase === 'pointer-up') {
    return value.dragEpoch === undefined || isPositiveSafeInteger(value.dragEpoch);
  }

  return (
    (value.phase === 'begin' || value.phase === 'release-for-fit' || value.phase === 'settled')
    && isPositiveSafeInteger(value.dragEpoch)
  );
}

export function isFloatingToolbarFitRequest(value: unknown): value is FloatingToolbarFitRequest {
  return (
    isRecord(value)
    && typeof value.width === 'number'
    && Number.isFinite(value.width)
    && value.width > 0
    && typeof value.height === 'number'
    && Number.isFinite(value.height)
    && value.height > 0
    && isPositiveSafeInteger(value.documentEpoch)
  );
}

export function isFloatingToolbarMoveRequest(value: unknown): value is FloatingToolbarMoveRequest {
  return (
    isRecord(value)
    && typeof value.x === 'number'
    && Number.isFinite(value.x)
    && typeof value.y === 'number'
    && Number.isFinite(value.y)
    && isPositiveSafeInteger(value.documentEpoch)
    && isPositiveSafeInteger(value.dragEpoch)
  );
}
