import type { ContinuousPlaybackSegment } from '../components/StudioTimelineDock';

export type TimelineExportSelection = {
  inPlaybackMs: number;
  outPlaybackMs: number;
};

export type WallClockRange = {
  startMs: number;
  endMs: number;
};

/**
 * Converts accumulated playback milliseconds (0 to totalDurationMs)
 * back to wall clock timestamp (epoch ms) using continuous playback segments.
 */
export function playbackMsToWallClock(
  playbackMs: number,
  segments: ContinuousPlaybackSegment[],
): number | null {
  if (segments.length === 0) return null;

  for (const seg of segments) {
    if (playbackMs >= seg.accumulatedStartMs && playbackMs <= seg.accumulatedEndMs) {
      const offset = playbackMs - seg.accumulatedStartMs;
      return seg.startedAtMs + offset;
    }
  }

  // Clamping fallbacks
  if (playbackMs < segments[0].accumulatedStartMs) {
    return segments[0].startedAtMs;
  }
  const last = segments[segments.length - 1];
  return last.endedAtMs;
}

/**
 * Converts a selection of [inPlaybackMs, outPlaybackMs] into a wall-clock epoch range.
 */
export function selectionToWallClockRange(
  selection: TimelineExportSelection,
  segments: ContinuousPlaybackSegment[],
): WallClockRange | null {
  const start = Math.min(selection.inPlaybackMs, selection.outPlaybackMs);
  const end = Math.max(selection.inPlaybackMs, selection.outPlaybackMs);

  const startMs = playbackMsToWallClock(start, segments);
  const endMs = playbackMsToWallClock(end, segments);

  if (startMs === null || endMs === null) return null;
  return {
    startMs: Math.min(startMs, endMs),
    endMs: Math.max(startMs, endMs),
  };
}
