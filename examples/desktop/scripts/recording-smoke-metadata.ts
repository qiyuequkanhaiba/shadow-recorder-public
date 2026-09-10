import os from 'node:os';

export type CaptureMode = 'target_display' | 'foreground_window';

export type SmokeMatrixMetadata = {
  os: string;
  arch: string;
  dpi: string;
  displayCount: number;
  displayMode: 'none' | 'single' | 'dual' | 'multi';
  captureBackend: 'wgc' | 'dxgi' | 'mixed' | 'unknown';
  captureMode: CaptureMode;
  encoder: string;
};

type DisplayLike = {
  displayId: string;
};

type StreamLike = {
  displayId?: string;
};

type SegmentLike = {
  encoderName?: string;
  captureBackend?: 'dxgi' | 'wgc';
};

type EventLike = {
  dpiScale?: number;
  captureBackend?: 'dxgi' | 'wgc';
};

type MetricsLike = {
  wgcCaptureCount: number;
  dxgiCaptureCount: number;
};

type OsInfo = {
  type: string;
  release: string;
  arch: string;
};

export function resolveDisplayMode(displayCount: number): SmokeMatrixMetadata['displayMode'] {
  if (displayCount <= 0) return 'none';
  if (displayCount === 1) return 'single';
  if (displayCount === 2) return 'dual';
  return 'multi';
}

export function resolveDpiLabel(events: EventLike[]): string {
  const dpiScales = Array.from(
    new Set(
      events
        .map((event) => event.dpiScale)
        .filter((dpiScale): dpiScale is number => typeof dpiScale === 'number' && dpiScale > 0)
        .map((dpiScale) => `${Math.round(dpiScale * 100)}%`),
    ),
  );
  return dpiScales.length > 0 ? dpiScales.join(',') : 'unknown';
}

export function resolveCaptureBackend(
  metrics: MetricsLike,
  events: EventLike[],
  segments: SegmentLike[] = [],
): SmokeMatrixMetadata['captureBackend'] {
  const eventBackends = new Set(
    [...events, ...segments]
      .map((item) => item.captureBackend)
      .filter((backend): backend is 'dxgi' | 'wgc' => backend === 'dxgi' || backend === 'wgc'),
  );
  if (eventBackends.size > 1) return 'mixed';
  if (eventBackends.size === 1) return Array.from(eventBackends)[0];
  if (metrics.wgcCaptureCount > 0 && metrics.dxgiCaptureCount > 0) return 'mixed';
  if (metrics.wgcCaptureCount > 0) return 'wgc';
  if (metrics.dxgiCaptureCount > 0) return 'dxgi';
  return 'unknown';
}

export function resolveEncoderName(segments: SegmentLike[]): string {
  const encoderNames = Array.from(
    new Set(
      segments
        .map((segment) => segment.encoderName)
        .filter((encoderName): encoderName is string => Boolean(encoderName)),
    ),
  );
  return encoderNames.length > 0 ? encoderNames.join(',') : 'unknown';
}

export function createSmokeMatrixMetadata(input: {
  mode: CaptureMode;
  displays: DisplayLike[];
  streams: StreamLike[];
  segments: SegmentLike[];
  events: EventLike[];
  metrics: MetricsLike;
  osInfo?: OsInfo;
}): SmokeMatrixMetadata {
  const osInfo = input.osInfo ?? {
    type: os.type(),
    release: os.release(),
    arch: os.arch(),
  };
  const streamDisplayCount = new Set(
    input.streams.map((stream) => stream.displayId).filter(Boolean),
  ).size;
  const displayCount = input.displays.length > 0 ? input.displays.length : streamDisplayCount;

  return {
    os: `${osInfo.type} ${osInfo.release}`,
    arch: osInfo.arch,
    dpi: resolveDpiLabel(input.events),
    displayCount,
    displayMode: resolveDisplayMode(displayCount),
    captureBackend: resolveCaptureBackend(input.metrics, input.events, input.segments),
    captureMode: input.mode,
    encoder: resolveEncoderName(input.segments),
  };
}
