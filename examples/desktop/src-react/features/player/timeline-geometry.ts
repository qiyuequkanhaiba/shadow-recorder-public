import { useMemo } from 'react';

import type { TestSessionTimelineEvent } from '../../../types/contracts';
import type { ContinuousPlaybackSegment } from '../../components/StudioTimelineDock';
import { clampNumber, formatClock } from './coordinate-mapping';

export type ActionCluster = {
  playbackMs: number;
  events: TestSessionTimelineEvent[];
};

export type MappedDefect = {
  event: TestSessionTimelineEvent;
  playbackMs: number;
  windowStartMs: number;
  windowEndMs: number;
  durationMs: number;
};

export type RulerTick = { timeMs: number; pct: number; label: string };

export function formatDuration(durationMs?: number): string {
  if (!durationMs || durationMs <= 0) {
    return '--';
  }
  return `${Math.round(durationMs / 100) / 10}s`;
}

export function mapOccurredAtToPlaybackMs(
  occurredAtMs: number,
  segments: ContinuousPlaybackSegment[],
): number | null {
  for (const segment of segments) {
    const start = segment.startedAtMs;
    const end = start + Math.max(segment.durationMs ?? 0, 0);
    if (occurredAtMs >= start && occurredAtMs <= end) {
      return segment.accumulatedStartMs + (occurredAtMs - start);
    }
  }
  return null;
}

/**
 * Identify genuine defect mark events:
 * 1. Event type is 'defect_marked' (from native markTestDefect).
 * 2. Instant mark note fallback (contains '瞬时打标', '缺陷标记', or '已标记缺陷').
 * 3. Note added with 'defect' / '缺陷'.
 * Excludes generic error logs (logLevel === 'error') which are ordinary app errors, not defect markers.
 */
export function isDefectTimelineEvent(event: TestSessionTimelineEvent): boolean {
  if ((event.eventType as string) === 'defect_marked') {
    return true;
  }
  const text = `${event.title ?? ''} ${event.message ?? ''}`.toLowerCase();
  if (text.includes('瞬时打标') || text.includes('缺陷标记') || text.includes('已标记缺陷')) {
    return true;
  }
  if (event.eventType === 'note_added' && (text.includes('defect') || text.includes('缺陷'))) {
    return true;
  }
  return false;
}

export function isUserOperationEvent(event: TestSessionTimelineEvent): boolean {
  if (event.logCategory === 'operation' || event.eventType === 'step_captured') {
    return true;
  }
  const type = event.eventType.toLowerCase();
  return type.startsWith('mouse_') || type.startsWith('key_') || type.includes('click') || type.includes('input');
}

/** 把指针 clientX 换算为 0–totalDurationMs 的播放位置。 */
export function clientXToPlaybackMs(
  canvas: HTMLElement,
  clientX: number,
  totalDurationMs: number,
): number {
  const rect = canvas.getBoundingClientRect();
  const x = clampNumber(clientX - rect.left, 0, rect.width);
  const fraction = rect.width > 0 ? clampNumber(x / rect.width, 0, 1) : 0;
  return Math.round(fraction * totalDurationMs);
}

/**
 * 时间轴几何：操作点聚类（按真实屏幕像素 14px 阈值）、缺陷窗口（保留 postWindowSeconds === 0）
 * 和标尺刻度。
 */
export function useTimelineGeometry(input: {
  continuousSegments: ContinuousPlaybackSegment[];
  timelineEvents: TestSessionTimelineEvent[];
  totalDurationMs: number;
  trackPixelWidth: number;
  zoom: number;
  preWindowSeconds: number;
  postWindowSeconds: number;
}): { actionClusters: ActionCluster[]; mappedDefects: MappedDefect[]; rulerTicks: RulerTick[] } {
  const {
    continuousSegments,
    timelineEvents,
    totalDurationMs,
    trackPixelWidth,
    zoom,
    preWindowSeconds,
    postWindowSeconds,
  } = input;

  const mappedActions = useMemo(() => {
    if (continuousSegments.length === 0 || totalDurationMs <= 0) {
      return [];
    }
    const results: Array<{ playbackMs: number; event: TestSessionTimelineEvent }> = [];
    for (const event of timelineEvents) {
      if (!isUserOperationEvent(event)) continue;
      const playbackMs = mapOccurredAtToPlaybackMs(event.occurredAtMs, continuousSegments);
      if (playbackMs !== null && playbackMs >= 0 && playbackMs <= totalDurationMs) {
        results.push({ playbackMs, event });
      }
    }
    results.sort((a, b) => a.playbackMs - b.playbackMs);
    return results;
  }, [continuousSegments, timelineEvents, totalDurationMs]);

  const actionClusters = useMemo(() => {
    if (mappedActions.length === 0 || totalDurationMs <= 0) {
      return [] as ActionCluster[];
    }
    const thresholdMs = trackPixelWidth > 0 ? (14 / trackPixelWidth) * totalDurationMs : 0;
    const clusters: ActionCluster[] = [];
    for (const action of mappedActions) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(action.playbackMs - last.playbackMs) < thresholdMs) {
        last.events.push(action.event);
      } else {
        clusters.push({ playbackMs: action.playbackMs, events: [action.event] });
      }
    }
    return clusters;
  }, [mappedActions, totalDurationMs, trackPixelWidth]);

  const mappedDefects = useMemo(() => {
    if (continuousSegments.length === 0 || totalDurationMs <= 0) {
      return [] as MappedDefect[];
    }
    const results: MappedDefect[] = [];
    const preMs = (preWindowSeconds ?? 10) * 1000;
    const postMs = (postWindowSeconds ?? 10) * 1000;
    for (const event of timelineEvents) {
      if (!isDefectTimelineEvent(event)) continue;
      const playbackMs = mapOccurredAtToPlaybackMs(event.occurredAtMs, continuousSegments);
      if (playbackMs !== null && playbackMs >= 0 && playbackMs <= totalDurationMs) {
        const windowStartMs = clampNumber(playbackMs - preMs, 0, totalDurationMs);
        const windowEndMs = clampNumber(playbackMs + postMs, 0, totalDurationMs);
        results.push({
          event,
          playbackMs,
          windowStartMs,
          windowEndMs,
          durationMs: windowEndMs - windowStartMs,
        });
      }
    }
    return results;
  }, [continuousSegments, preWindowSeconds, postWindowSeconds, timelineEvents, totalDurationMs]);

  const rulerTicks = useMemo(() => {
    if (totalDurationMs <= 0) {
      return [] as RulerTick[];
    }
    const targetTickCount = Math.max(4, Math.round(8 * zoom));
    const rawInterval = totalDurationMs / targetTickCount;
    let intervalMs = 5000;
    if (rawInterval > 30000) intervalMs = 60000;
    else if (rawInterval > 15000) intervalMs = 30000;
    else if (rawInterval > 7500) intervalMs = 15000;
    else if (rawInterval > 3000) intervalMs = 5000;
    else if (rawInterval > 1000) intervalMs = 2000;
    else intervalMs = 1000;

    const ticks: RulerTick[] = [];
    for (let timeMs = 0; timeMs <= totalDurationMs; timeMs += intervalMs) {
      ticks.push({ timeMs, pct: (timeMs / totalDurationMs) * 100, label: formatClock(timeMs) });
    }
    return ticks;
  }, [totalDurationMs, zoom]);

  return { actionClusters, mappedDefects, rulerTicks };
}
