export const STUDIO_SEGMENT_LIMIT = 2000;

export type StudioSegmentWindowInput = {
  bufferWindowSeconds?: number;
  segmentDurationSeconds?: number;
  historyRetentionMode?: 'age' | 'count' | string;
  historyRetentionMaxSegments?: number;
};

function liveSegmentCount(bufferWindowSeconds: number, segmentDurationSeconds: number): number {
  const duration = Math.max(1, Math.trunc(segmentDurationSeconds) || 1);
  const windowSeconds = Math.max(duration, Math.trunc(bufferWindowSeconds) || duration);
  const quotient = Math.floor(windowSeconds / duration);
  const remainder = windowSeconds % duration;
  return Math.max(1, quotient + (remainder > 0 ? 1 : 0));
}

export function resolveStudioSegmentLimit(session?: StudioSegmentWindowInput | null): number {
  const live = liveSegmentCount(session?.bufferWindowSeconds ?? 30, session?.segmentDurationSeconds ?? 5);
  if (session?.historyRetentionMode === 'age') {
    return STUDIO_SEGMENT_LIMIT;
  }
  const retained = Math.max(
    10,
    Math.min(STUDIO_SEGMENT_LIMIT, Math.trunc(session?.historyRetentionMaxSegments ?? 200) || 200),
  );
  return Math.min(STUDIO_SEGMENT_LIMIT, live + retained);
}
