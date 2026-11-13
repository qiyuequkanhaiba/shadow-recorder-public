import type {
  RecorderMetrics,
  TestSessionVideoSegment,
  TestSessionVideoStream,
} from '../../../types/contracts';
import type { TestSessionOperationRecord } from '../../../types/operation-contracts';
import type {
  CoordinateMappingResult,
  SelectedTimelineItem,
  SemanticStepRow,
} from '../../components/StudioDrawer';
import type { ContinuousPlaybackSegment } from '../../components/StudioTimelineDock';

export function resolveBackendLabel(metrics: RecorderMetrics | null): string {
  if (!metrics) {
    return '--';
  }
  if (metrics.wgcCaptureCount > 0 && metrics.dxgiCaptureCount > 0) {
    return 'DXGI/WGC';
  }
  if (metrics.wgcCaptureCount > 0) {
    return 'WGC';
  }
  if (metrics.dxgiCaptureCount > 0) {
    return 'DXGI';
  }
  return '--';
}

export function resolveHardwareEncoderBrand(encoderName?: string | null): string | null {
  if (!encoderName) {
    return null;
  }
  const lower = encoderName.toLowerCase();
  if (lower.includes('nvenc')) {
    return 'NVIDIA NVENC';
  }
  if (lower.includes('qsv')) {
    return 'Intel QSV';
  }
  if (lower.includes('amf')) {
    return 'AMD AMF';
  }
  return null;
}

export function formatClock(durationMs?: number): string {
  if (!durationMs || durationMs <= 0) {
    return '00:00';
  }
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatDateTime(timestampMs?: number): string {
  if (!timestampMs) {
    return '--';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestampMs));
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function buildContinuousPlaybackSegments(
  segments: TestSessionVideoSegment[],
): ContinuousPlaybackSegment[] {
  const sortedSegments = segments
    .slice()
    .sort((left, right) => left.startedAtMs - right.startedAtMs);

  let accumulatedStartMs = 0;
  return sortedSegments.map((segment) => {
    const durationMs = Math.max(segment.durationMs ?? 0, 0);
    const nextSegment: ContinuousPlaybackSegment = {
      ...segment,
      accumulatedStartMs,
      accumulatedEndMs: accumulatedStartMs + durationMs,
    };
    accumulatedStartMs += durationMs;
    return nextSegment;
  });
}

export function findSegmentIndexForPlaybackTime(
  segments: ContinuousPlaybackSegment[],
  playbackTimeMs: number,
): number {
  if (segments.length === 0) {
    return -1;
  }

  const clampedTimeMs = clampNumber(
    playbackTimeMs,
    0,
    Math.max(segments[segments.length - 1]?.accumulatedEndMs ?? 0, 0),
  );

  const idx = segments.findIndex((segment) => clampedTimeMs < segment.accumulatedEndMs);
  return idx !== -1 ? idx : segments.length - 1;
}

export function computeCoordinateMapping(input: {
  isRecording: boolean;
  isPaused: boolean;
  selectedItem: SelectedTimelineItem | null;
  semanticSteps: SemanticStepRow[];
  operations: TestSessionOperationRecord[];
  selectedStream: TestSessionVideoStream | null;
  videoElement: HTMLVideoElement | null;
  frameDimensions: { width: number; height: number };
}): CoordinateMappingResult | null {
  const {
    isRecording,
    isPaused,
    selectedItem,
    semanticSteps,
    operations,
    selectedStream,
    videoElement,
    frameDimensions,
  } = input;

  if (isRecording && !isPaused) {
    return null;
  }
  if (!selectedItem) {
    return null;
  }

  const evId = selectedItem.event.eventId;
  const evStepId = selectedItem.event.stepId;

  const matchingStep = semanticSteps.find((s) => {
    if (s.sourceEventIds && Array.isArray(s.sourceEventIds) && s.sourceEventIds.includes(evId)) {
      return true;
    }
    if (s.source_event_ids && Array.isArray(s.source_event_ids) && s.source_event_ids.includes(evId)) {
      return true;
    }
    if (evStepId && (s.stepId === evStepId || s.stepId === (selectedItem.event as any).id)) {
      return true;
    }
    return false;
  });

  const matchingOperation = operations.find((op) => {
    const sourceIds = op.action?.sourceEventIds;
    return Array.isArray(sourceIds) && sourceIds.includes(evId);
  });

  const explicitRect = matchingOperation?.action?.target?.boundingRect
    || matchingOperation?.action?.stateBefore?.element?.boundingRect
    || matchingStep?.boundingRect
    || matchingStep?.controlRect
    || matchingStep?.bounding_rect;

  let pointPhysicalX: number | undefined;
  let pointPhysicalY: number | undefined;

  if (typeof matchingStep?.x === 'number' && typeof matchingStep?.y === 'number') {
    pointPhysicalX = matchingStep.x;
    pointPhysicalY = matchingStep.y;
  } else if (
    typeof matchingOperation?.action?.coordinate?.x === 'number'
    && typeof matchingOperation?.action?.coordinate?.y === 'number'
  ) {
    pointPhysicalX = matchingOperation.action.coordinate.x;
    pointPhysicalY = matchingOperation.action.coordinate.y;
  } else if (typeof selectedItem.event.x === 'number' && typeof selectedItem.event.y === 'number') {
    pointPhysicalX = selectedItem.event.x;
    pointPhysicalY = selectedItem.event.y;
  }

  let pointLogicalX: number | undefined;
  let pointLogicalY: number | undefined;

  if (pointPhysicalX === undefined || pointPhysicalY === undefined) {
    if (typeof matchingStep?.logicalX === 'number' && typeof matchingStep?.logicalY === 'number') {
      pointLogicalX = matchingStep.logicalX;
      pointLogicalY = matchingStep.logicalY;
    } else if (typeof selectedItem.event.logicalX === 'number' && typeof selectedItem.event.logicalY === 'number') {
      pointLogicalX = selectedItem.event.logicalX;
      pointLogicalY = selectedItem.event.logicalY;
    }
  }

  const hasPoint = (pointPhysicalX !== undefined && pointPhysicalY !== undefined)
    || (pointLogicalX !== undefined && pointLogicalY !== undefined);

  if (!explicitRect && !hasPoint) {
    return {
      success: false,
      reason: '当前操作未采集边界矩形或点击坐标',
    };
  }

  if (!selectedStream) {
    return {
      success: false,
      reason: '当前未选定视频流',
    };
  }

  const targetDisplayId = matchingStep?.displayId
    || matchingOperation?.action?.coordinate?.displayId
    || selectedItem.event.displayId;

  if (targetDisplayId && selectedStream.displayId && targetDisplayId !== selectedStream.displayId) {
    return {
      success: false,
      reason: `操作发生于显示器 [${targetDisplayId}]，当前显示为 [${selectedStream.displayId}]，无法映射到当前画面`,
    };
  }

  const monitorLeft = selectedStream.monitorLeft ?? 0;
  const monitorTop = selectedStream.monitorTop ?? 0;
  const streamWidth = (videoElement && videoElement.videoWidth > 0)
    ? videoElement.videoWidth
    : (selectedStream.width && selectedStream.width > 0 ? selectedStream.width : 0);
  const streamHeight = (videoElement && videoElement.videoHeight > 0)
    ? videoElement.videoHeight
    : (selectedStream.height && selectedStream.height > 0 ? selectedStream.height : 0);

  if (streamWidth <= 0 || streamHeight <= 0) {
    return {
      success: false,
      reason: '视频尺寸未就绪',
    };
  }

  const frameWidth = frameDimensions.width;
  const frameHeight = frameDimensions.height;
  if (frameWidth <= 0 || frameHeight <= 0) {
    return {
      success: false,
      reason: '视口尺寸尚未就绪',
    };
  }

  const containerAspect = frameWidth / frameHeight;
  const videoAspect = streamWidth / streamHeight;
  let actualWidth = frameWidth;
  let actualHeight = frameHeight;
  let actualLeft = 0;
  let actualTop = 0;

  if (containerAspect > videoAspect) {
    actualHeight = frameHeight;
    actualWidth = frameHeight * videoAspect;
    actualLeft = (frameWidth - actualWidth) / 2;
    actualTop = 0;
  } else {
    actualWidth = frameWidth;
    actualHeight = frameWidth / videoAspect;
    actualLeft = 0;
    actualTop = (frameHeight - actualHeight) / 2;
  }

  if (explicitRect && explicitRect.width > 0 && explicitRect.height > 0) {
    const localLeft = explicitRect.left - monitorLeft;
    const localTop = explicitRect.top - monitorTop;
    const localWidth = explicitRect.width;
    const localHeight = explicitRect.height;

    if (
      localLeft + localWidth <= 0
      || localLeft >= streamWidth
      || localTop + localHeight <= 0
      || localTop >= streamHeight
    ) {
      return {
        success: false,
        reason: '控件矩形超出当前视频流画面范围，无法映射到当前画面',
      };
    }

    const screenX = actualLeft + (localLeft / streamWidth) * actualWidth;
    const screenY = actualTop + (localTop / streamHeight) * actualHeight;
    const screenW = (localWidth / streamWidth) * actualWidth;
    const screenH = (localHeight / streamHeight) * actualHeight;

    const label = matchingStep?.controlName
      || matchingStep?.control_name
      || matchingOperation?.action?.target?.name
      || undefined;

    return {
      success: true,
      overlay: {
        type: 'rect',
        x: Math.round(screenX),
        y: Math.round(screenY),
        width: Math.max(Math.round(screenW), 4),
        height: Math.max(Math.round(screenH), 4),
        label,
      },
    };
  }

  if (hasPoint) {
    let localX: number;
    let localY: number;

    if (pointPhysicalX !== undefined && pointPhysicalY !== undefined) {
      localX = pointPhysicalX - monitorLeft;
      localY = pointPhysicalY - monitorTop;
    } else if (pointLogicalX !== undefined && pointLogicalY !== undefined) {
      const scale = (typeof selectedItem.event.dpiScale === 'number' && selectedItem.event.dpiScale > 0)
        ? selectedItem.event.dpiScale
        : undefined;

      if (scale === undefined) {
        return {
          success: false,
          reason: '缺少 dpiScale，无法映射逻辑坐标',
        };
      }

      const physX = pointLogicalX * scale;
      const physY = pointLogicalY * scale;
      localX = physX - monitorLeft;
      localY = physY - monitorTop;
    } else {
      return {
        success: false,
        reason: '无法获取有效的点击点坐标',
      };
    }

    if (localX < 0 || localX > streamWidth || localY < 0 || localY > streamHeight) {
      return {
        success: false,
        reason: '点击坐标不在当前视频流显示区域内，无法映射到当前画面',
      };
    }

    const screenX = actualLeft + (localX / streamWidth) * actualWidth;
    const screenY = actualTop + (localY / streamHeight) * actualHeight;

    const label = matchingStep?.controlName
      || matchingStep?.control_name
      || matchingOperation?.action?.target?.name
      || matchingStep?.title
      || undefined;

    return {
      success: true,
      overlay: {
        type: 'point',
        x: Math.round(screenX),
        y: Math.round(screenY),
        label,
      },
    };
  }

  return {
    success: false,
    reason: '无法映射到当前画面',
  };
}
