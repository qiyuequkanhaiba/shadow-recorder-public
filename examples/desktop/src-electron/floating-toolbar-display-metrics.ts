export interface FloatingToolbarRefreshScheduler {
  schedule(task: () => void): void;
}

type DragIdentity = {
  documentEpoch: number;
  dragEpoch: number;
  nativePointerEpoch: number;
};

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function matchesDrag(
  drag: DragIdentity | null,
  documentEpoch: number,
  dragEpoch: number,
): boolean {
  return !!drag && drag.documentEpoch === documentEpoch && drag.dragEpoch === dragEpoch;
}

/**
 * Serializes DPI refreshes with the toolbar's renderer-owned drag lifecycle.
 * Identity-bearing phases prevent a page or drag that has already been
 * superseded from releasing the current drag or applying stale bounds.
 */
export class FloatingToolbarDisplayMetricsRefreshCoordinator {
  private admittedDocumentEpoch = 0;
  private nativePointerDown = false;
  private nativePointerEpoch = 0;
  private activeDrag: DragIdentity | null = null;
  private awaitingPostDragFit: DragIdentity | null = null;
  private lastDragEpoch = 0;
  private refreshPending = false;
  private refreshScheduled = false;
  private refreshInFlight = false;
  private refreshScheduleVersion = 0;

  constructor(
    private readonly scheduler: FloatingToolbarRefreshScheduler,
    private readonly onRefreshReady: () => void,
  ) {}

  admitDocument(documentEpoch: number): boolean {
    if (!isPositiveSafeInteger(documentEpoch) || documentEpoch <= this.admittedDocumentEpoch) {
      return false;
    }

    this.admittedDocumentEpoch = documentEpoch;
    this.nativePointerDown = false;
    this.nativePointerEpoch = 0;
    this.activeDrag = null;
    this.awaitingPostDragFit = null;
    this.lastDragEpoch = 0;
    this.invalidateScheduledRefresh();
    return true;
  }

  beginNativePointer(documentEpoch: number): boolean {
    if (!this.isCurrentDocument(documentEpoch)) {
      return false;
    }

    this.nativePointerEpoch += 1;
    this.nativePointerDown = true;
    this.invalidateScheduledRefresh();
    return true;
  }

  observeNativePointerUp(documentEpoch: number): boolean {
    if (!this.isCurrentDocument(documentEpoch)) {
      return false;
    }

    // This comes directly from Electron's native input path, so it identifies
    // the physical press rather than an asynchronously delivered renderer IPC.
    // Do not change the active drag identity here: a post-drag click may occur
    // while the prior drag is still waiting for its final renderer fit.
    this.nativePointerDown = false;
    return true;
  }

  acknowledgePointerUp(documentEpoch: number, dragEpoch?: number): boolean {
    if (!this.isCurrentDocument(documentEpoch)) {
      return false;
    }

    if (dragEpoch !== undefined) {
      const drag = isPositiveSafeInteger(dragEpoch)
        ? this.currentInteraction(documentEpoch, dragEpoch)
        : null;
      if (!drag) {
        return false;
      }
      // Pointer Capture can finish outside the native window, where Electron
      // may not emit before-mouse-event mouseUp. The matching drag may clear
      // only the physical press it started with; a newer press stays frozen.
      if (this.nativePointerDown && drag.nativePointerEpoch === this.nativePointerEpoch) {
        this.nativePointerDown = false;
      }
    } else if (this.activeDrag || this.awaitingPostDragFit) {
      // An unrelated click from this document must not release an active drag.
      return false;
    }

    // Physical release is owned exclusively by observeNativePointerUp(). A
    // renderer acknowledgement for an older drag can arrive after a newer
    // mouseDown, so it must never clear this current native interaction.
    this.scheduleRefreshIfEligible();
    return true;
  }

  beginDrag(documentEpoch: number, dragEpoch: number): boolean {
    if (!this.isCurrentDocument(documentEpoch) || !isPositiveSafeInteger(dragEpoch)) {
      return false;
    }

    if (dragEpoch < this.lastDragEpoch) {
      return false;
    }
    if (dragEpoch === this.lastDragEpoch) {
      return matchesDrag(this.activeDrag, documentEpoch, dragEpoch);
    }

    this.lastDragEpoch = dragEpoch;
    this.activeDrag = { documentEpoch, dragEpoch, nativePointerEpoch: this.nativePointerEpoch };
    this.awaitingPostDragFit = null;
    this.invalidateScheduledRefresh();
    return true;
  }

  releaseDragForRendererFit(documentEpoch: number, dragEpoch: number): boolean {
    if (!matchesDrag(this.activeDrag, documentEpoch, dragEpoch)) {
      return false;
    }

    const drag = this.activeDrag;
    this.activeDrag = null;
    this.awaitingPostDragFit = drag;
    return true;
  }

  completePostDragFit(documentEpoch: number, dragEpoch: number): boolean {
    if (!matchesDrag(this.awaitingPostDragFit, documentEpoch, dragEpoch)) {
      return false;
    }

    this.awaitingPostDragFit = null;
    this.scheduleRefreshIfEligible();
    return true;
  }

  isActiveDrag(documentEpoch: number, dragEpoch: number): boolean {
    return matchesDrag(this.activeDrag, documentEpoch, dragEpoch);
  }

  cancelInteraction(documentEpoch: number): boolean {
    if (!this.isCurrentDocument(documentEpoch)) {
      return false;
    }

    this.nativePointerDown = false;
    this.activeDrag = null;
    this.awaitingPostDragFit = null;
    this.invalidateScheduledRefresh();
    this.scheduleRefreshIfEligible();
    return true;
  }

  requestRefresh(): void {
    this.refreshPending = true;
    this.scheduleRefreshIfEligible();
  }

  completeRefresh(): void {
    if (!this.refreshInFlight) {
      return;
    }

    this.refreshInFlight = false;
    this.scheduleRefreshIfEligible();
  }

  isFitFrozen(): boolean {
    return this.nativePointerDown || this.refreshScheduled || this.refreshInFlight;
  }

  private isCurrentDocument(documentEpoch: number): boolean {
    return documentEpoch === this.admittedDocumentEpoch;
  }

  private currentInteraction(documentEpoch: number, dragEpoch: number): DragIdentity | null {
    if (matchesDrag(this.activeDrag, documentEpoch, dragEpoch)) {
      return this.activeDrag;
    }
    if (matchesDrag(this.awaitingPostDragFit, documentEpoch, dragEpoch)) {
      return this.awaitingPostDragFit;
    }
    return null;
  }

  private invalidateScheduledRefresh(): void {
    this.refreshScheduled = false;
    this.refreshScheduleVersion += 1;
  }

  private scheduleRefreshIfEligible(): void {
    if (
      !this.refreshPending
      || this.nativePointerDown
      || this.activeDrag
      || this.awaitingPostDragFit
      || this.refreshScheduled
      || this.refreshInFlight
    ) {
      return;
    }

    this.refreshScheduled = true;
    const scheduleVersion = ++this.refreshScheduleVersion;
    const documentEpoch = this.admittedDocumentEpoch;
    this.scheduler.schedule(() => {
      if (scheduleVersion !== this.refreshScheduleVersion) {
        return;
      }

      this.refreshScheduled = false;
      if (
        documentEpoch !== this.admittedDocumentEpoch
        || !this.refreshPending
        || this.nativePointerDown
        || this.activeDrag
        || this.awaitingPostDragFit
        || this.refreshInFlight
      ) {
        return;
      }

      this.refreshPending = false;
      this.refreshInFlight = true;
      this.onRefreshReady();
    });
  }
}
