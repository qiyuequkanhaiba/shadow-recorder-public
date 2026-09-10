import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createFloatingToolbarHtml } from '../src-electron/floating-toolbar';
import {
  FLOATING_TOOLBAR_LAYOUT,
  getFloatingToolbarCoreSize,
  scaleFloatingToolbarCoreSize,
} from '../src-electron/floating-toolbar-layout';
import {
  FloatingToolbarDisplayMetricsRefreshCoordinator,
  type FloatingToolbarRefreshScheduler,
} from '../src-electron/floating-toolbar-display-metrics';
import {
  isFloatingToolbarDragCommand,
  isFloatingToolbarFitRequest,
  isFloatingToolbarMoveRequest,
  type FloatingToolbarDragCommand,
} from '../src-electron/floating-toolbar-drag-protocol';
import {
  isCurrentFloatingToolbarRenderer,
  requestFloatingToolbarDisplayMetricsRefresh,
  routeFloatingToolbarDragCommand,
  shouldApplyFloatingToolbarMove,
} from '../src-electron/floating-toolbar-main-routes';

class ManualToolbarRefreshScheduler implements FloatingToolbarRefreshScheduler {
  private readonly tasks: Array<() => void> = [];

  schedule(task: () => void): void {
    this.tasks.push(task);
  }

  get size(): number {
    return this.tasks.length;
  }

  flushAll(): void {
    while (this.tasks.length > 0) {
      this.tasks.shift()?.();
    }
  }
}

class RecordingFloatingToolbarDragCoordinator {
  readonly calls: Array<[string, number, number | undefined]> = [];
  beginResult = true;
  pointerUpResult = true;
  releaseResult = true;
  settledResult = true;
  activeDragResult = true;

  beginDrag(documentEpoch: number, dragEpoch: number): boolean {
    this.calls.push(['begin', documentEpoch, dragEpoch]);
    return this.beginResult;
  }

  acknowledgePointerUp(documentEpoch: number, dragEpoch?: number): boolean {
    this.calls.push(['pointer-up', documentEpoch, dragEpoch]);
    return this.pointerUpResult;
  }

  releaseDragForRendererFit(documentEpoch: number, dragEpoch: number): boolean {
    this.calls.push(['release-for-fit', documentEpoch, dragEpoch]);
    return this.releaseResult;
  }

  completePostDragFit(documentEpoch: number, dragEpoch: number): boolean {
    this.calls.push(['settled', documentEpoch, dragEpoch]);
    return this.settledResult;
  }

  isActiveDrag(documentEpoch: number, dragEpoch: number): boolean {
    this.calls.push(['move', documentEpoch, dragEpoch]);
    return this.activeDragResult;
  }
}

class RecordingFloatingToolbarWindow {
  getBoundsCalls = 0;

  constructor(
    private readonly destroyed = false,
    private readonly bounds = { width: 128, height: 34 },
  ) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getBounds(): { width: number; height: number } {
    this.getBoundsCalls += 1;
    return { ...this.bounds };
  }
}

function createDisplayMetricsTrace(): {
  coordinator: FloatingToolbarDisplayMetricsRefreshCoordinator;
  scheduler: ManualToolbarRefreshScheduler;
  trace: string[];
  setScale: (scale: number) => void;
} {
  const scheduler = new ManualToolbarRefreshScheduler();
  const trace: string[] = [];
  let scale = 1;
  const coordinator = new FloatingToolbarDisplayMetricsRefreshCoordinator(
    scheduler,
    () => {
      const size = scaleFloatingToolbarCoreSize(false, 'idle', scale);
      trace.push(`refresh:${size.width}x${size.height}`);
    },
  );
  coordinator.admitDocument(1);

  return {
    coordinator,
    scheduler,
    trace,
    setScale: (nextScale) => {
      scale = nextScale;
    },
  };
}

function testFloatingToolbarDisplayMetricsRefreshCoordinatesDragAndNativeInput(): void {
  const first = createDisplayMetricsTrace();
  first.setScale(1.4);
  first.coordinator.beginDrag(1, 1);
  first.coordinator.requestRefresh();
  first.coordinator.releaseDragForRendererFit(1, 1);
  first.trace.push('old-fit:128x34');
  first.coordinator.completePostDragFit(1, 1);

  assert.equal(first.scheduler.size, 1);
  assert.equal(first.coordinator.isFitFrozen(), true);
  assert.deepEqual(first.trace, ['old-fit:128x34']);

  first.scheduler.flushAll();
  assert.deepEqual(first.trace, ['old-fit:128x34', 'refresh:180x48']);
  assert.equal(first.coordinator.isFitFrozen(), true);
  first.coordinator.completeRefresh();
  assert.equal(first.coordinator.isFitFrozen(), false);

  const coalesced = createDisplayMetricsTrace();
  coalesced.setScale(0.85);
  coalesced.coordinator.requestRefresh();
  coalesced.coordinator.requestRefresh();
  coalesced.setScale(1.4);
  coalesced.coordinator.requestRefresh();

  assert.equal(coalesced.scheduler.size, 1);
  coalesced.scheduler.flushAll();
  assert.deepEqual(coalesced.trace, ['refresh:180x48']);
  coalesced.coordinator.completeRefresh();

  const nativePointer = createDisplayMetricsTrace();
  nativePointer.coordinator.beginNativePointer(1);
  nativePointer.coordinator.requestRefresh();
  nativePointer.scheduler.flushAll();
  assert.deepEqual(nativePointer.trace, []);

  // Native mouse-up releases the physical fence, while the renderer-owned
  // command still owns the drag identity and its post-drag fit ordering.
  nativePointer.coordinator.observeNativePointerUp(1);
  nativePointer.scheduler.flushAll();
  assert.deepEqual(nativePointer.trace, []);
  nativePointer.coordinator.beginDrag(1, 1);
  nativePointer.coordinator.acknowledgePointerUp(1, 1);
  nativePointer.scheduler.flushAll();
  assert.deepEqual(nativePointer.trace, []);
  nativePointer.coordinator.releaseDragForRendererFit(1, 1);
  nativePointer.coordinator.completePostDragFit(1, 1);
  nativePointer.scheduler.flushAll();
  assert.deepEqual(nativePointer.trace, ['refresh:128x34']);
  nativePointer.coordinator.completeRefresh();

  // `isFitFrozen()` is the main-process admission gate for an already queued
  // renderer fit. A physical press must close that gate before drag IPC lands.
  const nativeFitFence = createDisplayMetricsTrace();
  assert.equal(nativeFitFence.coordinator.isFitFrozen(), false);
  nativeFitFence.coordinator.beginNativePointer(1);
  assert.equal(nativeFitFence.coordinator.isFitFrozen(), true);
  nativeFitFence.coordinator.observeNativePointerUp(1);
  assert.equal(nativeFitFence.coordinator.isFitFrozen(), false);

  const postDragClick = createDisplayMetricsTrace();
  postDragClick.coordinator.beginNativePointer(1);
  postDragClick.coordinator.beginDrag(1, 1);
  postDragClick.coordinator.requestRefresh();
  postDragClick.coordinator.observeNativePointerUp(1);
  assert.equal(postDragClick.coordinator.acknowledgePointerUp(1, 1), true);
  postDragClick.coordinator.releaseDragForRendererFit(1, 1);

  // A normal click while the old drag is awaiting its final fit must release
  // only the physical-pointer fence, never the old drag identity.
  postDragClick.coordinator.beginNativePointer(1);
  assert.equal(postDragClick.coordinator.isFitFrozen(), true);
  postDragClick.coordinator.observeNativePointerUp(1);
  assert.equal(postDragClick.coordinator.isFitFrozen(), false);
  assert.equal(postDragClick.coordinator.acknowledgePointerUp(1), false);
  assert.equal(postDragClick.scheduler.size, 0);
  postDragClick.coordinator.completePostDragFit(1, 1);
  assert.equal(postDragClick.scheduler.size, 1);
  postDragClick.scheduler.flushAll();
  assert.deepEqual(postDragClick.trace, ['refresh:128x34']);
  postDragClick.coordinator.completeRefresh();

  const delayedOldAcknowledgement = createDisplayMetricsTrace();
  delayedOldAcknowledgement.coordinator.beginNativePointer(1);
  delayedOldAcknowledgement.coordinator.beginDrag(1, 1);
  delayedOldAcknowledgement.coordinator.observeNativePointerUp(1);
  assert.equal(delayedOldAcknowledgement.coordinator.acknowledgePointerUp(1, 1), true);
  delayedOldAcknowledgement.coordinator.releaseDragForRendererFit(1, 1);

  // The old drag's renderer acknowledgement can arrive after a new press.
  // It must not re-open the native fit gate for that new physical interaction.
  delayedOldAcknowledgement.coordinator.beginNativePointer(1);
  assert.equal(delayedOldAcknowledgement.coordinator.isFitFrozen(), true);
  assert.equal(delayedOldAcknowledgement.coordinator.acknowledgePointerUp(1, 1), true);
  assert.equal(delayedOldAcknowledgement.coordinator.isFitFrozen(), true);
  delayedOldAcknowledgement.coordinator.observeNativePointerUp(1);
  assert.equal(delayedOldAcknowledgement.coordinator.isFitFrozen(), false);

  const capturedPointerRelease = createDisplayMetricsTrace();
  capturedPointerRelease.coordinator.beginNativePointer(1);
  capturedPointerRelease.coordinator.beginDrag(1, 1);
  capturedPointerRelease.coordinator.requestRefresh();

  // Pointer Capture can deliver renderer pointer-up outside the native window,
  // where before-mouse-event may not observe a mouseUp. The matching drag may
  // release its own physical press as a fallback, but never a newer one.
  assert.equal(capturedPointerRelease.coordinator.acknowledgePointerUp(1, 1), true);
  assert.equal(capturedPointerRelease.coordinator.isFitFrozen(), false);
  capturedPointerRelease.coordinator.releaseDragForRendererFit(1, 1);
  capturedPointerRelease.coordinator.completePostDragFit(1, 1);
  capturedPointerRelease.scheduler.flushAll();
  assert.deepEqual(capturedPointerRelease.trace, ['refresh:128x34']);
  capturedPointerRelease.coordinator.completeRefresh();

  const capturedPointerWithNewPress = createDisplayMetricsTrace();
  capturedPointerWithNewPress.coordinator.beginNativePointer(1);
  capturedPointerWithNewPress.coordinator.beginDrag(1, 1);
  capturedPointerWithNewPress.coordinator.beginNativePointer(1);
  assert.equal(capturedPointerWithNewPress.coordinator.acknowledgePointerUp(1, 1), true);
  assert.equal(capturedPointerWithNewPress.coordinator.isFitFrozen(), true);
  capturedPointerWithNewPress.coordinator.observeNativePointerUp(1);
  assert.equal(capturedPointerWithNewPress.coordinator.isFitFrozen(), false);

  const staleFit = createDisplayMetricsTrace();
  staleFit.coordinator.beginDrag(1, 1);
  staleFit.coordinator.requestRefresh();
  staleFit.coordinator.releaseDragForRendererFit(1, 1);
  staleFit.coordinator.beginDrag(1, 2);
  staleFit.coordinator.acknowledgePointerUp(1, 1);
  staleFit.coordinator.completePostDragFit(1, 1);
  staleFit.scheduler.flushAll();
  assert.deepEqual(staleFit.trace, []);

  staleFit.coordinator.releaseDragForRendererFit(1, 2);
  staleFit.coordinator.completePostDragFit(1, 2);
  staleFit.scheduler.flushAll();
  assert.deepEqual(staleFit.trace, ['refresh:128x34']);
  staleFit.coordinator.completeRefresh();

  const staleRelease = createDisplayMetricsTrace();
  staleRelease.coordinator.beginDrag(1, 1);
  staleRelease.coordinator.requestRefresh();
  staleRelease.coordinator.releaseDragForRendererFit(1, 1);
  staleRelease.coordinator.beginDrag(1, 2);
  staleRelease.coordinator.releaseDragForRendererFit(1, 1);
  staleRelease.coordinator.completePostDragFit(1, 1);
  staleRelease.scheduler.flushAll();
  assert.deepEqual(staleRelease.trace, []);
  staleRelease.coordinator.releaseDragForRendererFit(1, 2);
  staleRelease.coordinator.completePostDragFit(1, 2);
  staleRelease.scheduler.flushAll();
  assert.deepEqual(staleRelease.trace, ['refresh:128x34']);
  staleRelease.coordinator.completeRefresh();

  const delayedCommit = createDisplayMetricsTrace();
  delayedCommit.coordinator.beginDrag(1, 1);
  delayedCommit.coordinator.requestRefresh();
  delayedCommit.coordinator.releaseDragForRendererFit(1, 1);
  delayedCommit.coordinator.completePostDragFit(1, 1);
  assert.equal(delayedCommit.scheduler.size, 1);
  delayedCommit.coordinator.beginNativePointer(1);
  delayedCommit.coordinator.beginDrag(1, 2);
  delayedCommit.scheduler.flushAll();
  assert.deepEqual(delayedCommit.trace, []);
  delayedCommit.coordinator.observeNativePointerUp(1);
  delayedCommit.coordinator.acknowledgePointerUp(1, 2);
  delayedCommit.coordinator.releaseDragForRendererFit(1, 2);
  delayedCommit.coordinator.completePostDragFit(1, 2);
  delayedCommit.scheduler.flushAll();
  assert.deepEqual(delayedCommit.trace, ['refresh:128x34']);
  delayedCommit.coordinator.completeRefresh();

  const inFlight = createDisplayMetricsTrace();
  inFlight.coordinator.requestRefresh();
  inFlight.scheduler.flushAll();
  inFlight.coordinator.requestRefresh();
  assert.equal(inFlight.scheduler.size, 0);
  inFlight.coordinator.completeRefresh();
  assert.equal(inFlight.scheduler.size, 1);
  inFlight.scheduler.flushAll();
  assert.deepEqual(inFlight.trace, ['refresh:128x34', 'refresh:128x34']);
  inFlight.coordinator.completeRefresh();

  const staleDocument = createDisplayMetricsTrace();
  staleDocument.coordinator.beginDrag(1, 1);
  staleDocument.coordinator.requestRefresh();
  staleDocument.coordinator.releaseDragForRendererFit(1, 1);
  staleDocument.coordinator.admitDocument(2);
  staleDocument.coordinator.beginNativePointer(2);
  staleDocument.coordinator.acknowledgePointerUp(1);
  staleDocument.coordinator.completePostDragFit(1, 1);
  staleDocument.scheduler.flushAll();
  assert.deepEqual(staleDocument.trace, []);

  const abandonedPointer = createDisplayMetricsTrace();
  abandonedPointer.coordinator.beginNativePointer(1);
  abandonedPointer.coordinator.requestRefresh();
  abandonedPointer.coordinator.cancelInteraction(1);
  abandonedPointer.scheduler.flushAll();
  assert.deepEqual(abandonedPointer.trace, ['refresh:128x34']);
  abandonedPointer.coordinator.completeRefresh();
}

function testFloatingToolbarProtocolAcceptsOnlyDocumentScopedCommands(): void {
  assert.equal(isFloatingToolbarDragCommand({
    phase: 'begin',
    documentEpoch: 1,
    dragEpoch: 1,
  }), true);
  assert.equal(isFloatingToolbarDragCommand({
    phase: 'pointer-up',
    documentEpoch: 1,
  }), true);
  assert.equal(isFloatingToolbarDragCommand({
    phase: 'settled',
    documentEpoch: 1,
  }), false);
  assert.equal(isFloatingToolbarDragCommand({
    phase: 'release-for-fit',
    documentEpoch: 0,
    dragEpoch: 1,
  }), false);
  assert.equal(isFloatingToolbarDragCommand({
    phase: 'unexpected',
    documentEpoch: 1,
    dragEpoch: 1,
  }), false);
  assert.equal(isFloatingToolbarFitRequest({ width: 128, height: 34, documentEpoch: 1 }), true);
  assert.equal(isFloatingToolbarFitRequest({ width: 128, height: 34, documentEpoch: 0 }), false);
  assert.equal(isFloatingToolbarMoveRequest({ x: 12, y: 24, documentEpoch: 1 }), false);
  assert.equal(isFloatingToolbarMoveRequest({ x: 12, y: 24, documentEpoch: 1, dragEpoch: 2 }), true);
  assert.equal(isFloatingToolbarMoveRequest({ x: 12, y: Number.NaN, documentEpoch: 1 }), false);
}

function testFloatingToolbarRoutesAuthenticateCurrentRenderer(): void {
  const webContents = { mainFrame: { frameTreeNodeId: 42 } };
  const window = {
    isDestroyed: () => false,
    webContents,
  };
  const matchingEvent = {
    sender: webContents,
    senderFrame: { frameTreeNodeId: 42 },
  };

  assert.equal(isCurrentFloatingToolbarRenderer(matchingEvent, window, 3, 3), true);
  assert.equal(isCurrentFloatingToolbarRenderer(matchingEvent, null, 3, 3), false);
  assert.equal(isCurrentFloatingToolbarRenderer(
    matchingEvent,
    { ...window, isDestroyed: () => true },
    3,
    3,
  ), false);
  assert.equal(isCurrentFloatingToolbarRenderer(matchingEvent, window, 2, 3), false);
  assert.equal(isCurrentFloatingToolbarRenderer({
    sender: { mainFrame: { frameTreeNodeId: 42 } },
    senderFrame: { frameTreeNodeId: 42 },
  }, window, 3, 3), false);
  assert.equal(isCurrentFloatingToolbarRenderer({
    sender: webContents,
    senderFrame: null,
  }, window, 3, 3), false);
  assert.equal(isCurrentFloatingToolbarRenderer({
    sender: webContents,
    senderFrame: { frameTreeNodeId: 43 },
  }, window, 3, 3), false);
}

function testFloatingToolbarRoutesRejectUntrustedDragCommands(): void {
  const commands: FloatingToolbarDragCommand[] = [
    { phase: 'begin', documentEpoch: 3, dragEpoch: 7 },
    { phase: 'pointer-up', documentEpoch: 3, dragEpoch: 7 },
    { phase: 'release-for-fit', documentEpoch: 3, dragEpoch: 7 },
    { phase: 'settled', documentEpoch: 3, dragEpoch: 7 },
  ];

  for (const command of commands) {
    const coordinator = new RecordingFloatingToolbarDragCoordinator();
    const window = new RecordingFloatingToolbarWindow();
    const result = routeFloatingToolbarDragCommand({
      acceptedRenderer: false,
      currentlyDragging: true,
      window,
      coordinator,
    }, command);

    assert.deepEqual(result, { dragging: true, accepted: false }, command.phase);
    assert.deepEqual(coordinator.calls, [], command.phase);
    assert.equal(window.getBoundsCalls, 0, command.phase);
  }
}

function testFloatingToolbarRoutesFreezeSizeOnlyForAcceptedBegin(): void {
  const acceptedCoordinator = new RecordingFloatingToolbarDragCoordinator();
  const acceptedWindow = new RecordingFloatingToolbarWindow(false, { width: 178, height: 34 });
  const accepted = routeFloatingToolbarDragCommand({
    acceptedRenderer: true,
    currentlyDragging: false,
    window: acceptedWindow,
    coordinator: acceptedCoordinator,
  }, { phase: 'begin', documentEpoch: 3, dragEpoch: 7 });

  assert.deepEqual(accepted, {
    dragging: true,
    accepted: true,
    fittedSize: { width: 178, height: 34 },
  });
  assert.deepEqual(acceptedCoordinator.calls, [['begin', 3, 7]]);
  assert.equal(acceptedWindow.getBoundsCalls, 1);

  const rejectedCoordinator = new RecordingFloatingToolbarDragCoordinator();
  rejectedCoordinator.beginResult = false;
  const rejectedWindow = new RecordingFloatingToolbarWindow();
  const rejected = routeFloatingToolbarDragCommand({
    acceptedRenderer: true,
    currentlyDragging: true,
    window: rejectedWindow,
    coordinator: rejectedCoordinator,
  }, { phase: 'begin', documentEpoch: 3, dragEpoch: 8 });

  assert.deepEqual(rejected, { dragging: true, accepted: false });
  assert.deepEqual(rejectedCoordinator.calls, [['begin', 3, 8]]);
  assert.equal(rejectedWindow.getBoundsCalls, 0);

  const destroyedCoordinator = new RecordingFloatingToolbarDragCoordinator();
  const destroyedWindow = new RecordingFloatingToolbarWindow(true);
  const destroyed = routeFloatingToolbarDragCommand({
    acceptedRenderer: true,
    currentlyDragging: false,
    window: destroyedWindow,
    coordinator: destroyedCoordinator,
  }, { phase: 'begin', documentEpoch: 3, dragEpoch: 9 });

  assert.deepEqual(destroyed, { dragging: true, accepted: true });
  assert.deepEqual(destroyedCoordinator.calls, [['begin', 3, 9]]);
  assert.equal(destroyedWindow.getBoundsCalls, 0);
}

function testFloatingToolbarRoutesKeepDraggingThroughPointerUp(): void {
  const coordinator = new RecordingFloatingToolbarDragCoordinator();
  const window = new RecordingFloatingToolbarWindow();

  const withoutDragEpoch = routeFloatingToolbarDragCommand({
    acceptedRenderer: true,
    currentlyDragging: true,
    window,
    coordinator,
  }, { phase: 'pointer-up', documentEpoch: 3 });
  const withDragEpoch = routeFloatingToolbarDragCommand({
    acceptedRenderer: true,
    currentlyDragging: true,
    window,
    coordinator,
  }, { phase: 'pointer-up', documentEpoch: 3, dragEpoch: 7 });

  assert.deepEqual(withoutDragEpoch, { dragging: true, accepted: true });
  assert.deepEqual(withDragEpoch, { dragging: true, accepted: true });
  assert.deepEqual(coordinator.calls, [
    ['pointer-up', 3, undefined],
    ['pointer-up', 3, 7],
  ]);
  assert.equal(window.getBoundsCalls, 0);

  const rejectedCoordinator = new RecordingFloatingToolbarDragCoordinator();
  rejectedCoordinator.pointerUpResult = false;
  const rejected = routeFloatingToolbarDragCommand({
    acceptedRenderer: true,
    currentlyDragging: true,
    window,
    coordinator: rejectedCoordinator,
  }, { phase: 'pointer-up', documentEpoch: 3, dragEpoch: 8 });
  assert.deepEqual(rejected, { dragging: true, accepted: false });
}

function testFloatingToolbarRoutesReleaseAndSettleOnlyThroughCoordinator(): void {
  const releasedCoordinator = new RecordingFloatingToolbarDragCoordinator();
  const released = routeFloatingToolbarDragCommand({
    acceptedRenderer: true,
    currentlyDragging: true,
    window: new RecordingFloatingToolbarWindow(),
    coordinator: releasedCoordinator,
  }, { phase: 'release-for-fit', documentEpoch: 3, dragEpoch: 7 });

  assert.deepEqual(released, { dragging: false, accepted: true });
  assert.deepEqual(releasedCoordinator.calls, [['release-for-fit', 3, 7]]);

  const rejectedCoordinator = new RecordingFloatingToolbarDragCoordinator();
  rejectedCoordinator.releaseResult = false;
  const rejected = routeFloatingToolbarDragCommand({
    acceptedRenderer: true,
    currentlyDragging: true,
    window: new RecordingFloatingToolbarWindow(),
    coordinator: rejectedCoordinator,
  }, { phase: 'release-for-fit', documentEpoch: 3, dragEpoch: 8 });

  assert.deepEqual(rejected, { dragging: true, accepted: false });
  assert.deepEqual(rejectedCoordinator.calls, [['release-for-fit', 3, 8]]);

  const settledCoordinator = new RecordingFloatingToolbarDragCoordinator();
  const settled = routeFloatingToolbarDragCommand({
    acceptedRenderer: true,
    currentlyDragging: false,
    window: new RecordingFloatingToolbarWindow(),
    coordinator: settledCoordinator,
  }, { phase: 'settled', documentEpoch: 3, dragEpoch: 7 });

  assert.deepEqual(settled, { dragging: false, accepted: true });
  assert.deepEqual(settledCoordinator.calls, [['settled', 3, 7]]);
}

function testFloatingToolbarMovesRequireCurrentActiveDrag(): void {
  const coordinator = new RecordingFloatingToolbarDragCoordinator();
  const request = { x: 12, y: 24, documentEpoch: 3, dragEpoch: 7 };

  assert.equal(shouldApplyFloatingToolbarMove({
    acceptedRenderer: true,
    currentlyDragging: true,
    coordinator,
  }, request), true);
  assert.deepEqual(coordinator.calls, [['move', 3, 7]]);

  coordinator.activeDragResult = false;
  assert.equal(shouldApplyFloatingToolbarMove({
    acceptedRenderer: true,
    currentlyDragging: true,
    coordinator,
  }, request), false);
  assert.equal(shouldApplyFloatingToolbarMove({
    acceptedRenderer: false,
    currentlyDragging: true,
    coordinator,
  }, request), false);
  assert.equal(shouldApplyFloatingToolbarMove({
    acceptedRenderer: true,
    currentlyDragging: false,
    coordinator,
  }, request), false);
}

function testFloatingToolbarRoutesGateDisplayMetricsRefresh(): void {
  let refreshCalls = 0;
  const coordinator = {
    requestRefresh: () => {
      refreshCalls += 1;
    },
  };

  assert.equal(requestFloatingToolbarDisplayMetricsRefresh(null, coordinator), false);
  assert.equal(requestFloatingToolbarDisplayMetricsRefresh({ isDestroyed: () => true }, coordinator), false);
  assert.equal(refreshCalls, 0);
  assert.equal(requestFloatingToolbarDisplayMetricsRefresh({ isDestroyed: () => false }, coordinator), true);
  assert.equal(refreshCalls, 1);
}

function testFloatingToolbarRoutesComposeWithRefreshCoordinator(): void {
  const trace = createDisplayMetricsTrace();
  const window = new RecordingFloatingToolbarWindow();
  let result = routeFloatingToolbarDragCommand({
    acceptedRenderer: true,
    currentlyDragging: false,
    window,
    coordinator: trace.coordinator,
  }, { phase: 'begin', documentEpoch: 1, dragEpoch: 1 });

  assert.deepEqual(result, {
    dragging: true,
    accepted: true,
    fittedSize: { width: 128, height: 34 },
  });
  assert.equal(requestFloatingToolbarDisplayMetricsRefresh(window, trace.coordinator), true);
  assert.equal(trace.scheduler.size, 0);
  assert.deepEqual(trace.trace, []);

  result = routeFloatingToolbarDragCommand({
    acceptedRenderer: true,
    currentlyDragging: result.dragging,
    window,
    coordinator: trace.coordinator,
  }, { phase: 'pointer-up', documentEpoch: 1, dragEpoch: 1 });
  assert.deepEqual(result, { dragging: true, accepted: true });
  assert.equal(trace.scheduler.size, 0);

  result = routeFloatingToolbarDragCommand({
    acceptedRenderer: true,
    currentlyDragging: result.dragging,
    window,
    coordinator: trace.coordinator,
  }, { phase: 'release-for-fit', documentEpoch: 1, dragEpoch: 1 });
  assert.deepEqual(result, { dragging: false, accepted: true });
  assert.equal(trace.scheduler.size, 0);
  assert.deepEqual(trace.trace, []);

  result = routeFloatingToolbarDragCommand({
    acceptedRenderer: true,
    currentlyDragging: result.dragging,
    window,
    coordinator: trace.coordinator,
  }, { phase: 'settled', documentEpoch: 1, dragEpoch: 1 });
  assert.deepEqual(result, { dragging: false, accepted: true });
  assert.equal(trace.scheduler.size, 1);
  assert.deepEqual(trace.trace, []);

  trace.scheduler.flushAll();
  assert.deepEqual(trace.trace, ['refresh:128x34']);
  trace.coordinator.completeRefresh();
}

function testFloatingToolbarLayoutUsesExactStateSizes(): void {
  assert.deepEqual(FLOATING_TOOLBAR_LAYOUT, {
    collapsedWidth: 58,
    idleExpandedWidth: 128,
    activeExpandedWidth: 178,
    height: 34,
  });
  assert.deepEqual(getFloatingToolbarCoreSize(true, 'idle'), { width: 58, height: 34 });
  assert.deepEqual(getFloatingToolbarCoreSize(true, 'recording'), { width: 58, height: 34 });
  assert.deepEqual(getFloatingToolbarCoreSize(false, 'idle'), { width: 128, height: 34 });
  assert.deepEqual(getFloatingToolbarCoreSize(false, 'recording'), { width: 178, height: 34 });
  assert.deepEqual(getFloatingToolbarCoreSize(false, 'paused'), { width: 178, height: 34 });
  assert.deepEqual(scaleFloatingToolbarCoreSize(true, 'idle', 0.85), { width: 50, height: 29 });
  assert.deepEqual(scaleFloatingToolbarCoreSize(false, 'idle', 1.4), { width: 180, height: 48 });
  assert.deepEqual(scaleFloatingToolbarCoreSize(false, 'paused', 1), { width: 178, height: 34 });
}

function extractCssDeclaration(html: string, selector: string, property: string): string | null {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockMatch = html.match(new RegExp(escapedSelector + '\\s*\\{([\\s\\S]*?)\\}', 'm'));
  if (!blockMatch) {
    return null;
  }

  const declarationMatch = blockMatch[1]?.match(new RegExp(property + '\\s*:\\s*([^;]+);'));
  return declarationMatch?.[1]?.trim() ?? null;
}

function testFloatingToolbarSurfaceIsTransparentSingleCard(): void {
  const html = createFloatingToolbarHtml({ initialCollapsed: false, uiScale: 1 });

  assert.match(html, /id="island-container"/);
  assert.match(html, /<div id="island-container">\s*<div class="island" id="island"/);
  assert.doesNotMatch(html, /feathered-island-wrapper|feathered-island-glow|aura-gutter/);
  assert.match(html, /background:\s*transparent\s*!important/);
  assert.equal(extractCssDeclaration(html, '.island', 'width'), 'var(--core-idle-expanded-width)');
  assert.equal(extractCssDeclaration(html, '.island', 'height'), 'var(--bar-h)');
  assert.match(html, /--core-collapsed-width:\s*58px/);
  assert.match(html, /--core-idle-expanded-width:\s*128px/);
  assert.match(html, /--core-active-expanded-width:\s*178px/);
  assert.match(html, /width 0\.34s var\(--spring-morph\)/);
  assert.match(html, /backdrop-filter/);
  assert.equal(extractCssDeclaration(html, '.island', 'border-radius'), '999px');
  assert.match(html, /color-scheme:\s*only light/);
  assert.match(html, /meta name="color-scheme" content="light"/);
  assert.match(html, /reassertGlassSurface/);
  assert.doesNotMatch(html, /style\.colorScheme = next/);
  assert.doesNotMatch(html, /backface-visibility:\s*hidden/);
  assert.doesNotMatch(html, /transform:\s*translateZ\(0\)/);
}

function testFloatingToolbarWindowUsesSharedZeroOverflowGeometry(): void {
  const mainSource = readFileSync(join(__dirname, '../src-electron/main.ts'), 'utf8');

  assert.match(mainSource, /from '\.\/floating-toolbar-layout'/);
  assert.match(mainSource, /function getToolbarVisualState\(\): FloatingToolbarVisualState/);
  assert.match(mainSource, /recorderService\?\.isRecording\(\)/);
  assert.match(mainSource, /recorderService\.isPaused\(\)/);
  assert.match(mainSource, /scaleFloatingToolbarCoreSize\(collapsed, state, uiScale\)/);
  assert.match(mainSource, /const initialToolbarState = getToolbarVisualState\(\);/);
  assert.match(mainSource, /const initialToolbarScale = getToolbarUiScale\(\);/);
  assert.match(mainSource, /initialState: initialToolbarState/);
  assert.match(mainSource, /const nextToolbarState = getToolbarVisualState\(\);/);
  assert.match(mainSource, /const currentBounds = toolbarWindow\.getBounds\(\);/);
  assert.match(
    mainSource,
    /const nextToolbarScale = getToolbarUiScale\(screen\.getDisplayMatching\(currentBounds\)\);/,
  );
  assert.match(
    mainSource,
    /buildToolbarBounds\(\s*toolbarCollapsed,\s*currentBounds,\s*nextToolbarState,\s*nextToolbarScale,\s*\)/,
  );
  assert.match(mainSource, /initialState: nextToolbarState/);
  assert.match(mainSource, /documentEpoch: initialToolbarDocumentEpoch/);
  assert.match(mainSource, /documentEpoch: nextToolbarDocumentEpoch/);
  assert.match(mainSource, /FloatingToolbarDisplayMetricsRefreshCoordinator/);
  assert.match(
    mainSource,
    /const toolbarDisplayMetricsRefreshCoordinator = new FloatingToolbarDisplayMetricsRefreshCoordinator\(/,
  );
  assert.match(mainSource, /function admitNextFloatingToolbarDocument\(\): number/);
  assert.match(mainSource, /toolbarDisplayMetricsRefreshCoordinator\.admitDocument\(nextEpoch\)/);
  assert.match(mainSource, /from '\.\/floating-toolbar-main-routes'/);
  assert.match(
    mainSource,
    /isCurrentFloatingToolbarRenderer\(\s*event,\s*toolbarWindow,\s*request\.documentEpoch,\s*toolbarDocumentEpoch,\s*\)/,
  );
  assert.match(mainSource, /toolbarDisplayMetricsRefreshCoordinator\.beginNativePointer\(toolbarDocumentEpoch\)/);
  assert.match(mainSource, /toolbarDisplayMetricsRefreshCoordinator\.observeNativePointerUp\(toolbarDocumentEpoch\)/);
  assert.match(mainSource, /routeFloatingToolbarDragCommand\(/);
  assert.match(mainSource, /toolbarDragging = routeResult\.dragging;/);
  assert.match(mainSource, /toolbarFittedSize = routeResult\.fittedSize;/);
  assert.match(mainSource, /toolbarDisplayMetricsRefreshCoordinator\.cancelInteraction\(toolbarDocumentEpoch\)/);
  assert.match(mainSource, /toolbarDisplayMetricsRefreshCoordinator\.completeRefresh\(\);/);
  assert.match(mainSource, /requestFloatingToolbarDisplayMetricsRefresh\(toolbarWindow, toolbarDisplayMetricsRefreshCoordinator\)/);
  assert.match(mainSource, /before-mouse-event/);
  assert.doesNotMatch(mainSource, /before-input-event/);
  assert.match(mainSource, /let toolbarReloading = false;/);
  assert.match(mainSource, /toolbarDisplayMetricsRefreshCoordinator\.isFitFrozen\(\)/);
  assert.match(mainSource, /if \(toolbarReloading\) \{\s*return \{ x: current\.x, y: current\.y \};/);
  assert.match(mainSource, /screen\.on\('display-metrics-changed', \(\) => \{\s*refreshFloatingToolbarForDisplayMetrics\(\);\s*\}\);/);
  assert.doesNotMatch(mainSource, /FloatingToolbarDisplayMetricsRefreshGate|acknowledgeRendererSettled/);
  assert.doesNotMatch(mainSource, /TOOLBAR_AURA_GUTTER|TOOLBAR_BASE_EXPANDED|TOOLBAR_BASE_COLLAPSED|scaleToolbarSize/);
  assert.match(mainSource, /transparent:\s*true,/);
  assert.match(mainSource, /backgroundColor:\s*'#00000000'/);
}

function testMainForwardsDragRouteAcceptance(): void {
  const mainSource = readFileSync(join(__dirname, '../src-electron/main.ts'), 'utf8');

  assert.match(
    mainSource,
    /function setFloatingToolbarDragging\([\s\S]*\): \{ dragging: boolean; accepted: boolean \} \{[\s\S]*return \{ dragging: toolbarDragging, accepted: routeResult\.accepted \};/,
  );
}

function testMainGatesFloatingToolbarMovesThroughActiveDragRoute(): void {
  const mainSource = readFileSync(join(__dirname, '../src-electron/main.ts'), 'utf8');

  assert.match(mainSource, /shouldApplyFloatingToolbarMove/);
  assert.match(
    mainSource,
    /const acceptedRenderer = isCurrentFloatingToolbarRenderer\([\s\S]*request\.documentEpoch[\s\S]*\);[\s\S]*if \(!shouldApplyFloatingToolbarMove\(\{[\s\S]*acceptedRenderer,[\s\S]*currentlyDragging: toolbarDragging,[\s\S]*coordinator: toolbarDisplayMetricsRefreshCoordinator,[\s\S]*\}, request\)\)/,
  );
}

function testMainPreservesCapturedDragAcrossBlurAndUsesMatchingDisplayScale(): void {
  const mainSource = readFileSync(join(__dirname, '../src-electron/main.ts'), 'utf8');

  assert.doesNotMatch(
    mainSource,
    /(?:toolbarWindow|window(?:\.webContents)?)\.on\('blur',\s*\(\)\s*=>\s*\{[^}]*cancelFloatingToolbarInteraction\(\)/,
  );
  assert.match(
    mainSource,
    /getToolbarUiScale\(screen\.getDisplayMatching\(currentBounds\)\)/,
  );
}

function testFloatingToolbarShowsMainAndExportWithoutMoreMenu(): void {
  const html = createFloatingToolbarHtml({ initialCollapsed: false });

  assert.match(html, /id="export-btn"/);
  assert.match(html, /id="main-btn"/);
  assert.match(html, /show-on-idle show-on-live show-on-paused/);
  assert.match(html, /id="flag-btn"/);
  assert.match(html, /api\.showWindow/);
  assert.match(html, /refreshCanExport|canExport/);
  assert.match(html, /listTestSessions/);
  assert.doesNotMatch(html, /id="more-btn"/);
  assert.doesNotMatch(html, /id="more-menu"/);
  assert.doesNotMatch(html, /id=\"main-btn\"[^>]*btn-always|class=\"btn btn-always\"/);
}

function testFloatingToolbarButtonsHaveUniformSize(): void {
  const html = createFloatingToolbarHtml({ initialCollapsed: false, uiScale: 1 });
  assert.match(html, /--btn:\s*calc\(26px \* var\(--ui-scale\)\)/);
  assert.match(html, /\.slim-btn,[\s\S]*\.btn \{[\s\S]*width:\s*var\(--btn\)/);
  assert.match(html, /\.slim-btn,[\s\S]*\.btn \{[\s\S]*height:\s*var\(--btn\)/);
  assert.match(html, /\.slim-btn,[\s\S]*\.btn \{[\s\S]*flex:\s*0 0 var\(--btn\)/);
}

function testFloatingToolbarFitDoesNotObserveWindowSizedIsland(): void {
  const html = createFloatingToolbarHtml({ initialCollapsed: false });
  assert.match(html, /const CORE_COLLAPSED_WIDTH = 58;/);
  assert.match(html, /const CORE_IDLE_EXPANDED_WIDTH = 128;/);
  assert.match(html, /const CORE_ACTIVE_EXPANDED_WIDTH = 178;/);
  assert.match(html, /Deterministic canvas size from UI state/);
  assert.match(html, /setFloatingToolbarDragging/);
  assert.doesNotMatch(html, /new ResizeObserver/);
  assert.match(html, /measureContentSize/);
}

function testFloatingToolbarAutoCollapsesAndExpandsOnHover(): void {
  const html = createFloatingToolbarHtml({ initialCollapsed: true });

  assert.match(html, /let collapsed = true;/);
  assert.match(html, /scheduleAutoCollapse/);
  assert.match(html, /syncAutoCollapse/);
  assert.match(html, /syncCollapsedState\(true\)/);
  assert.match(html, /syncCollapsedState\(false\)/);
  assert.match(html, /island\.addEventListener\('mouseenter'/);
  assert.match(html, /island\.addEventListener\('mouseleave'/);
  assert.match(html, /featheredRingExpand/);
  assert.match(html, /data-collapsed="true"\] \.capsule-slim-deck/);
  assert.match(html, /class="collapsed-time sr-only" id="collapsed-time"/);
}

function testFloatingToolbarHasStatusAndExport(): void {
  const html = createFloatingToolbarHtml({ initialCollapsed: false });
  assert.match(html, /id="status-label"/);
  assert.match(html, /id="status-time"/);
  assert.match(html, /id="export-btn"/);
  assert.match(html, /id="export-btn"/);
  assert.match(html, /show-on-idle/);
  assert.match(html, /exportTestSessionEvidence\(\{[\s\S]*outputMode: 'zip'/);
  assert.doesNotMatch(html, /window\.confirm/);
  assert.match(html, /sessionStartedAtMs/);
  assert.match(html, /status-capsule/);
  assert.match(html, /capsule-core-cluster/);
  assert.match(html, /beginDrag/);
  assert.match(html, /moveFloatingToolbar/);
  assert.match(html, /toast-status-banner/);
}

function testFloatingToolbarUsesZeroOverflowGlassCapsule(): void {
  const html = createFloatingToolbarHtml({ initialCollapsed: false, uiScale: 1 });
  const activeHtml = createFloatingToolbarHtml({
    initialCollapsed: false,
    initialState: 'recording',
    uiScale: 1,
  });

  assert.match(html, /id="island-container"/);
  assert.match(html, /class="island" id="island" data-state="idle"/);
  assert.match(activeHtml, /class="island" id="island" data-state="recording"/);
  assert.doesNotMatch(html, /feathered-island-wrapper|feathered-island-glow|aura-gutter/);
  assert.doesNotMatch(html, /(?:^|[;\s])filter\s*:\s*blur\(/m);
  assert.match(html, /backdrop-filter:\s*blur\(36px\) saturate\(210%\) brightness\(1\.08\)/);
  assert.equal(extractCssDeclaration(html, '.island', 'width'), 'var(--core-idle-expanded-width)');
  assert.equal(extractCssDeclaration(html, '.island-inner', 'justify-content'), 'flex-start');
  assert.equal(extractCssDeclaration(html, '.island-inner', 'gap'), '0');
  assert.match(html, /\.island \{[\s\S]*box-shadow:\s*inset /);
  assert.match(html, /\.island:hover \{[\s\S]*box-shadow:\s*inset /);
  assert.match(html, /\.island\[data-state="recording"\],[\s\S]*width:\s*var\(--core-active-expanded-width\)/);
  assert.match(html, /\.island\[data-collapsed="true"\] \.actions \{[\s\S]*max-width:\s*0;[\s\S]*margin-left:\s*0;[\s\S]*pointer-events:\s*none;/);
  assert.match(html, /\.island\[data-collapsed="false"\] \.actions \{[\s\S]*margin-left:\s*var\(--inner-gap\);[\s\S]*pointer-events:\s*auto;/);
  assert.match(html, /\.island\[data-collapsed="false"\] \.collapsed-waveform \{[\s\S]*max-width:\s*0;[\s\S]*margin-left:\s*0;/);
}

function testFloatingToolbarUsesVisualStatusWithoutVisibleClock(): void {
  const html = createFloatingToolbarHtml({ initialCollapsed: true, uiScale: 1 });
  assert.match(html, /class="collapsed-waveform" aria-hidden="true"/);
  assert.match(html, /class="waveform-bar"/);
  assert.match(html, /class="capsule-clock-digits status-time sr-only" id="status-time"/);
  assert.match(html, /class="collapsed-time sr-only" id="collapsed-time"/);
  assert.match(html, /aria-describedby="status-label status-time"/);
  assert.match(html, /#22c55e/);
  assert.match(html, /#f59e0b/);
  assert.match(html, /#64748b/);
  assert.match(html, /featheredRingExpand/);
  assert.match(html, /waveformPulse/);
  assert.match(html, /prefers-reduced-motion/);
}

function testFloatingToolbarStateMotionIsDistinctAndReducedMotionSafe(): void {
  const html = createFloatingToolbarHtml({ initialCollapsed: true, uiScale: 1 });

  assert.match(html, /\.status-dot::after \{[\s\S]*--ring-start-opacity: 0\.9;/);
  assert.match(html, /\.island\[data-state="recording"\] \.status-dot::after \{[\s\S]*--ring-start-opacity: 0\.9;/);
  assert.match(html, /\.island\[data-state="paused"\] \.status-dot::after \{[\s\S]*--ring-start-opacity: 0\.56;/);
  assert.match(html, /\.island\[data-state="idle"\] \.status-dot::after \{[\s\S]*--ring-start-opacity: 0\.38;/);
  assert.match(html, /0% \{ width: var\(--status-dot-size\); height: var\(--status-dot-size\); opacity: var\(--ring-start-opacity\); \}/);
  assert.match(html, /\.island\[data-state="recording"\] \.status-dot::after \{[\s\S]*animation: featheredRingExpand 2s/);
  assert.match(html, /\.island\[data-state="paused"\] \.status-dot::after \{[\s\S]*border-color: var\(--pause\);[\s\S]*animation: featheredRingExpand 3\.4s/);
  assert.match(html, /\.island\[data-state="idle"\] \.status-dot::after \{[\s\S]*border-color: var\(--idle\);[\s\S]*animation: featheredRingExpand 5\.2s/);
  assert.match(html, /\.island\[data-state="paused"\] \.waveform-bar \{[\s\S]*background: var\(--pause\);[\s\S]*animation: waveformPulse 1\.8s/);
  assert.match(html, /\.island\[data-state="idle"\] \.waveform-bar \{[\s\S]*background: var\(--idle\);[\s\S]*animation: waveformPulse 2\.4s/);
  assert.doesNotMatch(html, /\.island\[data-state="idle"\] \.collapsed-waveform,[\s\S]*max-width: 0/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.status-dot::after,[\s\S]*\.waveform-bar,[\s\S]*\{[\s\S]*animation: none !important/);
  assert.match(html, /class="capsule-clock-digits status-time sr-only" id="status-time"/);
  assert.match(html, /class="collapsed-time sr-only" id="collapsed-time"/);
}

function testFloatingToolbarContentBudgetsFitEverySupportedScale(): void {
  for (const scale of [0.85, 1, 1.4]) {
    const border = 2;
    const collapsedContent = (9 + 8 + (3 * 2.5 + 2 * 2.5) + 20) * scale + border;
    const idleContent = (9 + 8 + 5 + 3 * 26 + 3 * 3 + 16) * scale + border;
    const activeContent = (9 + 8 + 5 + 4 * 26 + 4 * 3 + 22) * scale + border;

    assert.ok(collapsedContent <= scaleFloatingToolbarCoreSize(true, 'recording', scale).width);
    assert.ok(idleContent <= scaleFloatingToolbarCoreSize(false, 'idle', scale).width);
    assert.ok(activeContent <= scaleFloatingToolbarCoreSize(false, 'paused', scale).width);
  }
}

function testFloatingToolbarUsesRevisionedStateSizing(): void {
  const html = createFloatingToolbarHtml({
    initialCollapsed: false,
    uiScale: 1,
    documentEpoch: 7,
  });

  assert.match(html, /const CORE_COLLAPSED_WIDTH = 58;/);
  assert.match(html, /const CORE_IDLE_EXPANDED_WIDTH = 128;/);
  assert.match(html, /const CORE_ACTIVE_EXPANDED_WIDTH = 178;/);
  assert.match(html, /let canvasCoreWidth = getCoreWidth\(collapsed, visualState\);/);
  assert.match(html, /let presentationRevision = 0;/);
  assert.match(html, /let pendingPresentation = null;/);
  assert.match(html, /let canvasFitUncertain = false;/);
  assert.match(html, /const measureContentSize = \(coreWidth = canvasCoreWidth\) =>/);
  assert.match(html, /const fitContentNow = async \(force, coreWidth = canvasCoreWidth\) =>/);
  assert.match(html, /const applyPresentation = \(nextState, nextCollapsed\) =>/);
  assert.match(html, /if \(canvasFitUncertain\) \{[\s\S]*const renderedCoreWidth = getCoreWidth\(collapsed, visualState\);[\s\S]*fitContentNow\(true, renderedCoreWidth\)[\s\S]*canvasCoreWidth = renderedCoreWidth;[\s\S]*applyPresentation\(nextState, nextCollapsed\);/);
  assert.match(html, /targetCoreWidth > canvasCoreWidth/);
  assert.match(html, /void fitContentNow\(true, targetCoreWidth\)\.then\(\(fitted\) =>/);
  assert.match(html, /if \(dragging \|\| dragReleasePending\) \{[\s\S]*canvasFitUncertain = true;/);
  assert.match(html, /canvasCoreWidth = targetCoreWidth;[\s\S]*canvasFitUncertain = false;/);
  assert.match(html, /canvasFitUncertain = false;[\s\S]*if \(revision !== presentationRevision\) return;/);
  assert.match(html, /window\.requestAnimationFrame\(/);
  assert.match(html, /if \(revision === presentationRevision && !dragging && !dragReleasePending\) \{[\s\S]*commitPresentation\(nextState, normalizedCollapsed\);/);
  assert.match(html, /targetCoreWidth < canvasCoreWidth/);
  assert.match(html, /function flushPendingPresentation\(\)/);
  assert.match(html, /function flushPendingPresentation\(\) \{[\s\S]*if \(pendingPresentation\) \{[\s\S]*pendingPresentation = null;[\s\S]*applyPresentation\(next\.state, next\.collapsed\);\s*\}[\s\S]*if \(pendingFit/);
  assert.match(html, /let dragReleasePending = false;/);
  assert.match(html, /let dragReleaseRevision = 0;/);
  assert.match(html, /let dragEpoch = 0;/);
  assert.match(html, /let dragStartSync = null;/);
  assert.match(html, /let deferredFitTimer = null;/);
  assert.match(html, /const waitForPresentationToSettle = \(releaseRevision\) => new Promise/);
  assert.match(html, /deferredFitTimer != null/);
  assert.match(html, /if \(dragging \|\| dragReleasePending \|\| fitting\) \{/);
  assert.match(html, /const releaseRevision = dragReleaseRevision;[\s\S]*const startSync = dragStartSync;[\s\S]*let mainDragStarted = false;[\s\S]*if \(startSync\) \{[\s\S]*mainDragStarted = await startSync;[\s\S]*dragStartSync === startSync/);
  assert.match(html, /const DOCUMENT_EPOCH = 7;/);
  assert.match(html, /await api\.fitFloatingToolbarSize\(\{ \.\.\.size, documentEpoch: DOCUMENT_EPOCH \}\)/);
  assert.match(html, /const fittedSize = await api\.fitFloatingToolbarSize\(\{ \.\.\.size, documentEpoch: DOCUMENT_EPOCH \}\);/);
  assert.match(html, /if \(fittedSize\?\.width === size\.width && fittedSize\?\.height === size\.height\) \{[\s\S]*return true;/);
  assert.match(html, /const FIT_RETRY_DELAY_MS = 32;/);
  assert.match(html, /const MAX_FIT_RETRIES = 4;/);
  assert.match(html, /const fitRevision = presentationRevision;/);
  assert.match(html, /for \(let attempt = 0; attempt < MAX_FIT_RETRIES; attempt \+= 1\)/);
  assert.match(html, /if \(dragging \|\| dragReleasePending \|\| fitRevision !== presentationRevision\)/);
  assert.match(html, /fitRetryDeferred = true;[\s\S]*canvasFitUncertain = true;[\s\S]*return false;/);
  assert.match(html, /if \(fitRetryDeferred\) return;[\s\S]*void fitContentNow\(nextForce\);/);
  assert.match(html, /if \(pendingFit && !fitRetryDeferred\)/);
  assert.doesNotMatch(html, /while \(true\)/);
  assert.match(html, /api\.moveFloatingToolbar\(\{ x: nextX, y: nextY, documentEpoch: DOCUMENT_EPOCH, dragEpoch \}\)/);
  assert.match(html, /const sendDragCommand = async \(phase, commandDragEpoch\) =>/);
  assert.match(html, /const command = \{ phase, documentEpoch: DOCUMENT_EPOCH \};/);
  assert.match(html, /command\.dragEpoch = commandDragEpoch;/);
  assert.match(html, /const onPassivePointerUp = \(event\) => \{[\s\S]*if \(event\.button !== 0\) return;[\s\S]*sendDragCommand\('pointer-up'\)/);
  assert.match(
    html,
    /const onPassivePointerUp = \(event\) => \{[\s\S]*if \(event\.button !== 0\) return;[\s\S]*void sendDragCommand\('pointer-up'\)\.then\(\(acknowledged\) => \{[\s\S]*if \(acknowledged\) resumeDeferredFit\(\);/,
  );
  assert.match(html, /window\.addEventListener\('mouseup', onPassivePointerUp, true\);/);
  assert.match(html, /dragReleasePending = true;[\s\S]*const pointerUpAcknowledged = await sendDragCommand\([\s\S]*mainDragReleased = await sendDragCommand\('release-for-fit', releaseDragEpoch\);/);
  assert.match(
    html,
    /const pointerUpAcknowledged = await sendDragCommand\([\s\S]*if \(!pointerUpAcknowledged \|\| !mainDragStarted \|\| releaseRevision !== dragReleaseRevision \|\| dragging\) return;[\s\S]*resumeDeferredFit\(\);[\s\S]*mainDragReleased = await sendDragCommand\('release-for-fit', releaseDragEpoch\);/,
  );
  assert.match(html, /void waitForPresentationToSettle\(releaseRevision\)\.then\(async \(settled\) =>/);
  assert.match(html, /if \(settled && releaseRevision === dragReleaseRevision && !dragging && api\.setFloatingToolbarDragging\) \{[\s\S]*await sendDragCommand\('settled', releaseDragEpoch\);/);
  assert.match(html, /dragStartSync = sendDragCommand\('begin', dragEpoch\)/);
  assert.match(html, /dragReleaseRevision \+= 1;/);
  assert.match(html, /dragEpoch \+= 1;/);
  assert.doesNotMatch(html, /api\.setFloatingToolbarDragging\(true\)|api\.setFloatingToolbarDragging\(false\)/);
  assert.match(html, /presentationRevision \+= 1;[\s\S]*pendingPresentation = desiredPresentation;[\s\S]*canvasFitUncertain = true;[\s\S]*lastFitKey = '';/);
  assert.doesNotMatch(html, /canvasCoreWidth = 0/);
  assert.match(html, /if \(fitTimer != null\) \{[\s\S]*pendingFit = true;[\s\S]*pendingFitForce = true;/);
  assert.match(html, /const requestedCollapsed = typeof toolbarState\?\.collapsed === 'boolean' \? toolbarState\.collapsed : collapsed;/);
  assert.match(html, /applyHealth\(health, requestedCollapsed\);/);
  assert.doesNotMatch(html, /canvasExpanded|CORE_EXPANDED_WIDTH|AURA_GUTTER|new ResizeObserver/);
}

function testFloatingToolbarPreservesSessionClockAnchorAcrossDocumentReloads(): void {
  const html = createFloatingToolbarHtml({
    initialCollapsed: false,
    initialState: 'recording',
    initialStartedAtMs: 1_700_000_000_000,
  });
  const mainSource = readFileSync(join(__dirname, '../src-electron/main.ts'), 'utf8');

  assert.match(html, /const INITIAL_STARTED_AT_MS = 1700000000000;/);
  assert.match(html, /let sessionStartedAtMs = INITIAL_STARTED_AT_MS;/);
  assert.match(
    html,
    /if \(recording && recordingChanged && sessionStartedAtMs == null\) \{[\s\S]*sessionStartedAtMs = Date\.now\(\);/,
  );
  assert.equal(
    (mainSource.match(/initialStartedAtMs:\s*recorderService\?\.getActiveSession\(\)\?\.startedAtMs/g) ?? []).length,
    2,
  );
}

function testFloatingToolbarPointerCaptureFinishesDragOutsideWindow(): void {
  const html = createFloatingToolbarHtml({ initialCollapsed: false, documentEpoch: 7 });

  assert.match(html, /let dragPointerId = null;/);
  assert.match(html, /dragCaptureTarget\.setPointerCapture\(event\.pointerId\);/);
  assert.match(html, /window\.addEventListener\('pointermove', onDragMove, true\);/);
  assert.match(html, /window\.addEventListener\('pointerup', onDragEnd, true\);/);
  assert.match(html, /window\.addEventListener\('pointercancel', onDragEnd, true\);/);
  assert.match(html, /dragCaptureTarget\.addEventListener\('lostpointercapture', onDragEnd\);/);
  assert.match(html, /window\.removeEventListener\('pointermove', onDragMove, true\);/);
  assert.match(html, /window\.removeEventListener\('pointerup', onDragEnd, true\);/);
  assert.match(html, /window\.removeEventListener\('pointercancel', onDragEnd, true\);/);
  assert.match(html, /dragCaptureTarget\.removeEventListener\('lostpointercapture', onDragEnd\);/);
  assert.match(html, /dragHandle\.addEventListener\('pointerdown', beginDrag\);/);
  assert.doesNotMatch(html, /dragHandle\.addEventListener\('mousedown', beginDrag\);/);
  assert.match(html, /window\.addEventListener\('mouseup', onPassivePointerUp, true\);/);
  assert.match(
    html,
    /const sendDragCommand = async \(phase, commandDragEpoch\) => \{[\s\S]*try \{[\s\S]*const result = await api\.setFloatingToolbarDragging\(command\);[\s\S]*return result\?\.accepted === true;[\s\S]*\} catch \(error\) \{[\s\S]*return false;/,
  );
  assert.match(
    html,
    /if \(startSync\) \{[\s\S]*mainDragStarted = await startSync;[\s\S]*const pointerUpAcknowledged = await sendDragCommand\(\s*'pointer-up',\s*mainDragStarted \? releaseDragEpoch : undefined,\s*\);[\s\S]*if \(!pointerUpAcknowledged \|\| !mainDragStarted \|\| releaseRevision !== dragReleaseRevision \|\| dragging\) return;/,
  );
  assert.match(html, /mainDragReleased = await sendDragCommand\('release-for-fit', releaseDragEpoch\);/);
  assert.match(
    html,
    /void api\.moveFloatingToolbar\(\{ x: nextX, y: nextY, documentEpoch: DOCUMENT_EPOCH, dragEpoch \}\)\.catch\(/,
  );
}

function testQualityGateRunsFloatingToolbarContract(): void {
  const qualityGate = readFileSync(join(__dirname, '../../../scripts/quality-gate.ps1'), 'utf8');
  assert.match(
    qualityGate,
    /Invoke-NpmScript "typecheck:electron"[\s\S]*Invoke-NpmScript "typecheck:react"[\s\S]*Invoke-NpmScript "test:floating-toolbar"[\s\S]*Invoke-NpmScript "test:metrics-stream"/
  );
}

function testFloatingToolbarCanQuickFlagDefectWithExistingApis(): void {
  const html = createFloatingToolbarHtml({ initialCollapsed: false });

  assert.match(html, /id="flag-btn"/);
  assert.match(html, /btn-flag show-on-live show-on-paused/);
  assert.match(html, /markTestDefect/);
  assert.match(html, /appendTestSessionNote/);
  assert.match(html, /getActiveTestSession/);
  assert.match(html, /瞬时打标/);
}

function testRecorderPlaybackStageUsesFluidTransportDock(): void {
  const source = readFileSync(join(__dirname, '../src-react/components/RecorderPlaybackStage.tsx'), 'utf8');

  assert.match(source, /recorder-stage-transport-dock/);
  assert.match(source, /recorder-stage-transport-track/);
  assert.match(source, /aria-label="后退 5 秒"/);
  assert.match(source, /aria-label="前进 5 秒"/);
  assert.match(source, /recorder-stage-quick-defect/);
  assert.match(source, /aria-label="标记当前回放位置为缺陷"/);
  assert.match(source, /标记瞬时/);
  assert.match(source, /recorder-stage-scrubber/);
  assert.match(source, /recorder-stage-scrubber-mark/);
  assert.match(source, /markTestDefect/);
  assert.match(source, /appendNoteForActiveQuickDefect/);
  assert.match(source, /quickDefectPendingRef/);
  assert.match(source, /isQuickDefectPending/);
  assert.match(source, /canMarkQuickDefect/);
  assert.match(source, /disabled\|not active\|SessionNotFound/);
}

function testRecorderPageUsesSlimHeaderAndRecPill(): void {
  const source = readFileSync(join(__dirname, '../src-react/pages/RecorderPage.tsx'), 'utf8');
  const css = readFileSync(join(__dirname, '../src-react/styles/theme-surfaces.css'), 'utf8');
  const stage = readFileSync(join(__dirname, '../src-react/components/RecorderPlaybackStage.tsx'), 'utf8');

  assert.match(source, /className=\{`rec-pill-state rec-pill-indicator is-\$\{recPillState\}`\}/);
  assert.match(source, /scheme-b-final/);
  assert.match(source, /header-center-capsule/);
  assert.match(source, /唤起悬浮岛/);
  assert.match(source, /📌 悬浮窗/);
  assert.match(source, /记录与回顾/);
  assert.match(source, /实时遥测与负载/);
  assert.match(source, /mac-toast/);
  assert.match(source, /evidence-session-rail/);
  assert.match(source, /删除所选/);
  assert.match(source, /evidence-session-copy/);
  assert.match(source, /dashboard.deleteSessions/);
  assert.doesNotMatch(source, /event-row-meta/);
  assert.match(source, /已唤起桌面极简透明悬浮窗/);
  assert.doesNotMatch(source, /action\.startRecording/);
  assert.doesNotMatch(source, /action\.minimizeTray/);
  assert.doesNotMatch(source, /traffic-lights|light-close/);

  assert.match(css, /\.scheme-b-final \.app-tabbar \{[\s\S]*height:\s*50px/);
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*340px/);
  assert.match(css, /grid-template-columns:\s*280px minmax\(0,\s*1fr\)/);
  assert.match(css, /grid-template-columns:\s*200px minmax\(0,\s*1fr\)/);

  assert.match(stage, /stage-top-meta/);
  assert.match(stage, /meta-micro-tag/);
}

function testCompactTimelineUsesMiniEventRows(): void {
  const source = readFileSync(join(__dirname, '../src-react/components/RecorderSessionTimelinePanel.tsx'), 'utf8');
  assert.match(source, /实时事件流/);
  assert.match(source, /mini-event-row/);
  assert.match(source, /is-flagged/);
  assert.match(source, /formatTimeOfDay/);
  assert.match(source, /onClearEvents/);
  assert.match(source, /清除/);
}

function run(): void {
  testFloatingToolbarDisplayMetricsRefreshCoordinatesDragAndNativeInput();
  testFloatingToolbarProtocolAcceptsOnlyDocumentScopedCommands();
  testFloatingToolbarRoutesAuthenticateCurrentRenderer();
  testFloatingToolbarRoutesRejectUntrustedDragCommands();
  testFloatingToolbarRoutesFreezeSizeOnlyForAcceptedBegin();
  testFloatingToolbarRoutesKeepDraggingThroughPointerUp();
  testFloatingToolbarRoutesReleaseAndSettleOnlyThroughCoordinator();
  testFloatingToolbarRoutesGateDisplayMetricsRefresh();
  testFloatingToolbarRoutesComposeWithRefreshCoordinator();
  testFloatingToolbarLayoutUsesExactStateSizes();
  testFloatingToolbarSurfaceIsTransparentSingleCard();
  testFloatingToolbarWindowUsesSharedZeroOverflowGeometry();
  testMainForwardsDragRouteAcceptance();
  testMainGatesFloatingToolbarMovesThroughActiveDragRoute();
  testMainPreservesCapturedDragAcrossBlurAndUsesMatchingDisplayScale();
  testFloatingToolbarShowsMainAndExportWithoutMoreMenu();
  testFloatingToolbarButtonsHaveUniformSize();
  testFloatingToolbarFitDoesNotObserveWindowSizedIsland();
  testFloatingToolbarAutoCollapsesAndExpandsOnHover();
  testFloatingToolbarHasStatusAndExport();
  testFloatingToolbarUsesZeroOverflowGlassCapsule();
  testFloatingToolbarUsesVisualStatusWithoutVisibleClock();
  testFloatingToolbarStateMotionIsDistinctAndReducedMotionSafe();
  testFloatingToolbarContentBudgetsFitEverySupportedScale();
  testFloatingToolbarUsesRevisionedStateSizing();
  testFloatingToolbarPreservesSessionClockAnchorAcrossDocumentReloads();
  testFloatingToolbarPointerCaptureFinishesDragOutsideWindow();
  testQualityGateRunsFloatingToolbarContract();
  testFloatingToolbarCanQuickFlagDefectWithExistingApis();
  testRecorderPlaybackStageUsesFluidTransportDock();
  testRecorderPageUsesSlimHeaderAndRecPill();
  testCompactTimelineUsesMiniEventRows();
  console.log('[floating-toolbar-layout-test] PASS');
}

run();
