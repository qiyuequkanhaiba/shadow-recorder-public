import type {
  FloatingToolbarDragCommand,
  FloatingToolbarMoveRequest,
} from './floating-toolbar-drag-protocol';

export interface FloatingToolbarRendererEventPort {
  sender: unknown;
  senderFrame: { frameTreeNodeId: number } | null | undefined;
}

export interface FloatingToolbarRendererWindowPort {
  isDestroyed(): boolean;
  webContents: {
    mainFrame: { frameTreeNodeId: number };
  };
}

export interface FloatingToolbarDragCoordinatorPort {
  beginDrag(documentEpoch: number, dragEpoch: number): boolean;
  acknowledgePointerUp(documentEpoch: number, dragEpoch?: number): boolean;
  releaseDragForRendererFit(documentEpoch: number, dragEpoch: number): boolean;
  completePostDragFit(documentEpoch: number, dragEpoch: number): boolean;
  isActiveDrag(documentEpoch: number, dragEpoch: number): boolean;
}

export interface FloatingToolbarBoundsPort {
  isDestroyed(): boolean;
  getBounds(): { width: number; height: number };
}

export interface FloatingToolbarRefreshCoordinatorPort {
  requestRefresh(): void;
}

export type FloatingToolbarDragRouteResult = {
  dragging: boolean;
  accepted: boolean;
  fittedSize?: { width: number; height: number };
};

export function isCurrentFloatingToolbarRenderer(
  event: FloatingToolbarRendererEventPort,
  window: FloatingToolbarRendererWindowPort | null,
  requestedDocumentEpoch: number,
  currentDocumentEpoch: number,
): boolean {
  if (!window || window.isDestroyed() || requestedDocumentEpoch !== currentDocumentEpoch) {
    return false;
  }

  const mainFrame = window.webContents.mainFrame;
  return event.sender === window.webContents
    && event.senderFrame != null
    && event.senderFrame.frameTreeNodeId === mainFrame.frameTreeNodeId;
}

export function routeFloatingToolbarDragCommand(
  input: {
    acceptedRenderer: boolean;
    currentlyDragging: boolean;
    window: FloatingToolbarBoundsPort | null;
    coordinator: FloatingToolbarDragCoordinatorPort;
  },
  command: FloatingToolbarDragCommand,
): FloatingToolbarDragRouteResult {
  const result: FloatingToolbarDragRouteResult = {
    dragging: input.currentlyDragging,
    accepted: false,
  };
  if (!input.acceptedRenderer) {
    return result;
  }

  if (command.phase === 'begin') {
    if (input.coordinator.beginDrag(command.documentEpoch, command.dragEpoch)) {
      result.dragging = true;
      result.accepted = true;
      if (input.window && !input.window.isDestroyed()) {
        const bounds = input.window.getBounds();
        result.fittedSize = { width: bounds.width, height: bounds.height };
      }
    }
    return result;
  }

  if (command.phase === 'pointer-up') {
    result.accepted = input.coordinator.acknowledgePointerUp(command.documentEpoch, command.dragEpoch);
    return result;
  }

  if (command.phase === 'release-for-fit') {
    if (input.coordinator.releaseDragForRendererFit(command.documentEpoch, command.dragEpoch)) {
      result.dragging = false;
      result.accepted = true;
    }
    return result;
  }

  result.accepted = input.coordinator.completePostDragFit(command.documentEpoch, command.dragEpoch);
  return result;
}

export function shouldApplyFloatingToolbarMove(
  input: {
    acceptedRenderer: boolean;
    currentlyDragging: boolean;
    coordinator: Pick<FloatingToolbarDragCoordinatorPort, 'isActiveDrag'>;
  },
  request: FloatingToolbarMoveRequest,
): boolean {
  return input.acceptedRenderer
    && input.currentlyDragging
    && input.coordinator.isActiveDrag(request.documentEpoch, request.dragEpoch);
}

export function requestFloatingToolbarDisplayMetricsRefresh(
  window: { isDestroyed(): boolean } | null,
  coordinator: FloatingToolbarRefreshCoordinatorPort,
): boolean {
  if (!window || window.isDestroyed()) {
    return false;
  }

  coordinator.requestRefresh();
  return true;
}
