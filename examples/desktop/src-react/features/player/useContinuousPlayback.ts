import { useEffect, useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';

import type { TestSessionPlaybackFocus, TestSessionVideoSegment } from '../../../types/contracts';
import type { ContinuousPlaybackSegment } from '../../components/StudioTimelineDock';
import type { TimelineExportSelection } from '../../lib/export-range';
import { clampNumber, findSegmentIndexForPlaybackTime } from './coordinate-mapping';
import type { UseVideoElementControllerResult } from './useVideoElementController';

const PLAYBACK_START_ERROR = '当前录像无法开始播放';

function normalizeSelection(selection: TimelineExportSelection | null): { inMs: number; outMs: number } | null {
  if (!selection) return null;
  const inMs = Math.min(selection.inPlaybackMs, selection.outPlaybackMs);
  const outMs = Math.max(selection.inPlaybackMs, selection.outPlaybackMs);
  return outMs > inMs ? { inMs, outMs } : null;
}

/**
 * 把多个已封口片段当作一条连续时间轴播放：
 * 维护全局播放位置、当前片段索引、跨片段跳转、选区循环和焦点定位。
 * 错误状态和倍速仍由 useVideoElementController 持有。
 */
export function useContinuousPlayback(input: {
  controller: UseVideoElementControllerResult;
  continuousSegments: ContinuousPlaybackSegment[];
  playableMatchedSegments: TestSessionVideoSegment[];
  playbackFocus?: TestSessionPlaybackFocus | null;
  isRecording: boolean;
  isPaused: boolean;
  pageVisible: boolean;
  timelineSelection: TimelineExportSelection | null;
  isLoopingSelection: boolean;
}) {
  const {
    controller,
    continuousSegments,
    playableMatchedSegments,
    playbackFocus,
    isRecording,
    isPaused,
    pageVisible,
    timelineSelection,
    isLoopingSelection,
  } = input;
  const { videoRef, playbackRate, clearError, setCustomError } = controller;

  const globalPlaybackMsRef = useRef(0);
  const lastTimeUpdateEmitAtRef = useRef(0);
  const timeUpdateRafRef = useRef<number | null>(null);
  const pendingSeekSecondsRef = useRef<number | null>(null);

  const [globalPlaybackMs, setGlobalPlaybackMs] = useState(0);
  const [isPlaybackRunning, setIsPlaybackRunning] = useState(false);
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(0);

  const totalDurationMs = continuousSegments.at(-1)?.accumulatedEndMs ?? 0;
  const activeContinuousSegment =
    currentSegmentIndex >= 0 && currentSegmentIndex < continuousSegments.length
      ? continuousSegments[currentSegmentIndex]
      : null;
  const loopRange = isLoopingSelection ? normalizeSelection(timelineSelection) : null;

  function seekToPlaybackTime(nextPlaybackMs: number): void {
    if (continuousSegments.length === 0) return;
    const clampedPlaybackMs = clampNumber(nextPlaybackMs, 0, Math.max(totalDurationMs, 0));
    const nextSegmentIndex = findSegmentIndexForPlaybackTime(continuousSegments, clampedPlaybackMs);
    if (nextSegmentIndex < 0) return;

    const targetSegment = continuousSegments[nextSegmentIndex];
    const offsetSeconds = clampNumber(
      (clampedPlaybackMs - targetSegment.accumulatedStartMs) / 1000,
      0,
      Math.max((targetSegment.durationMs ?? 0) / 1000, 0),
    );

    if (activeContinuousSegment?.segmentId === targetSegment.segmentId && videoRef.current) {
      videoRef.current.currentTime = offsetSeconds;
    } else {
      pendingSeekSecondsRef.current = offsetSeconds;
      setCurrentSegmentIndex(nextSegmentIndex);
    }
    globalPlaybackMsRef.current = clampedPlaybackMs;
    setGlobalPlaybackMs(clampedPlaybackMs);
    clearError();
  }

  function resetPlayback(): void {
    setCurrentSegmentIndex(0);
    setGlobalPlaybackMs(0);
    setIsPlaybackRunning(false);
    clearError();
  }

  function togglePlaybackRunning(): void {
    if (continuousSegments.length === 0) return;
    if (!isPlaybackRunning && loopRange) {
      if (globalPlaybackMs >= loopRange.outMs || globalPlaybackMs < loopRange.inMs) {
        seekToPlaybackTime(loopRange.inMs);
      }
    } else if (globalPlaybackMs >= totalDurationMs) {
      seekToPlaybackTime(0);
    }
    setIsPlaybackRunning((current) => !current);
  }

  useEffect(() => {
    return () => {
      if (timeUpdateRafRef.current != null) {
        window.cancelAnimationFrame(timeUpdateRafRef.current);
        timeUpdateRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (continuousSegments.length === 0) {
      setCurrentSegmentIndex(0);
      setGlobalPlaybackMs(0);
      setIsPlaybackRunning(false);
      return;
    }
    const nextIndex = clampNumber(currentSegmentIndex, 0, continuousSegments.length - 1);
    if (nextIndex !== currentSegmentIndex) {
      setCurrentSegmentIndex(nextIndex);
    }
  }, [continuousSegments, currentSegmentIndex]);

  useEffect(() => {
    if (!playbackFocus?.eventId || !playbackFocus.occurredAtMs || continuousSegments.length === 0) {
      return;
    }
    const matchedSegmentId = playableMatchedSegments[0]?.segmentId;
    const matchedIndex = matchedSegmentId
      ? continuousSegments.findIndex((segment) => segment.segmentId === matchedSegmentId)
      : -1;
    if (matchedIndex < 0) return;

    const matchedSegment = continuousSegments[matchedIndex];
    const offsetWithinSegmentMs = clampNumber(
      playbackFocus.occurredAtMs - matchedSegment.startedAtMs,
      0,
      Math.max(matchedSegment.durationMs, 0),
    );
    seekToPlaybackTime(matchedSegment.accumulatedStartMs + offsetWithinSegmentMs);
    setIsPlaybackRunning(false);
  }, [continuousSegments, playableMatchedSegments, playbackFocus?.eventId, playbackFocus?.occurredAtMs]);

  useEffect(() => {
    if (!pageVisible) setIsPlaybackRunning(false);
  }, [pageVisible]);

  useEffect(() => {
    if (isRecording && !isPaused) {
      setIsPlaybackRunning(false);
      clearError();
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (!activeContinuousSegment?.playbackUrl) {
      video.pause();
      return;
    }
    video.playbackRate = playbackRate;
    if (!isPlaybackRunning) {
      video.pause();
      return;
    }
    void video.play().catch(() => {
      setCustomError(PLAYBACK_START_ERROR);
      setIsPlaybackRunning(false);
    });
  }, [
    activeContinuousSegment?.segmentId,
    activeContinuousSegment?.playbackUrl,
    clearError,
    isPaused,
    isPlaybackRunning,
    isRecording,
    playbackRate,
    setCustomError,
    videoRef,
  ]);

  const videoHandlers = {
    onLoadedMetadata: (event: SyntheticEvent<HTMLVideoElement>) => {
      controller.handleLoadedMetadata(event);
      const target = event.currentTarget;
      const seekSeconds = pendingSeekSecondsRef.current;
      if (seekSeconds !== null) {
        target.currentTime = seekSeconds;
        pendingSeekSecondsRef.current = null;
      }
      if (isPlaybackRunning) {
        void target.play().catch(() => {
          setCustomError(PLAYBACK_START_ERROR);
          setIsPlaybackRunning(false);
        });
      }
    },
    onTimeUpdate: (event: SyntheticEvent<HTMLVideoElement>) => {
      controller.handleTimeUpdate(event);
      const currentSegment = continuousSegments[currentSegmentIndex];
      if (!currentSegment) return;
      const nextPlaybackMs =
        currentSegment.accumulatedStartMs + Math.round(event.currentTarget.currentTime * 1000);
      if (isPlaybackRunning && loopRange && nextPlaybackMs >= loopRange.outMs) {
        seekToPlaybackTime(loopRange.inMs);
        return;
      }
      globalPlaybackMsRef.current = nextPlaybackMs;
      const now = performance.now();
      if (now - lastTimeUpdateEmitAtRef.current < 250) {
        if (timeUpdateRafRef.current == null) {
          timeUpdateRafRef.current = window.requestAnimationFrame(() => {
            timeUpdateRafRef.current = null;
            lastTimeUpdateEmitAtRef.current = performance.now();
            setGlobalPlaybackMs(globalPlaybackMsRef.current);
          });
        }
        return;
      }
      lastTimeUpdateEmitAtRef.current = now;
      setGlobalPlaybackMs(nextPlaybackMs);
    },
    onEnded: () => {
      const nextIndex = currentSegmentIndex + 1;
      if (nextIndex < continuousSegments.length) {
        pendingSeekSecondsRef.current = 0;
        setCurrentSegmentIndex(nextIndex);
        setGlobalPlaybackMs(continuousSegments[nextIndex].accumulatedStartMs);
        return;
      }
      if (loopRange) {
        seekToPlaybackTime(loopRange.inMs);
        return;
      }
      setGlobalPlaybackMs(totalDurationMs);
      setIsPlaybackRunning(false);
    },
    onError: () => {
      controller.handleError();
      setIsPlaybackRunning(false);
    },
  };

  return {
    globalPlaybackMs,
    globalPlaybackMsRef,
    isPlaybackRunning,
    setIsPlaybackRunning,
    activeContinuousSegment,
    totalDurationMs,
    seekToPlaybackTime,
    resetPlayback,
    togglePlaybackRunning,
    videoHandlers,
  };
}
