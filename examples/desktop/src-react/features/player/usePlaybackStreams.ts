import { useEffect, useMemo, useState } from 'react';

import type {
  TestSessionVideoSegment,
  TestSessionVideoStream,
} from '../../../types/contracts';
import type { ContinuousPlaybackSegment } from '../../components/StudioTimelineDock';
import { buildContinuousPlaybackSegments } from './coordinate-mapping';

export type PlaybackStreamOption = {
  streamId: string;
  label: string;
  displayLabel: string;
};

export type UsePlaybackStreamsResult = {
  playableSegments: TestSessionVideoSegment[];
  playableMatchedSegments: TestSessionVideoSegment[];
  availablePlaybackStreams: PlaybackStreamOption[];
  activeStreamId: string | null;
  selectedStream: TestSessionVideoStream | null;
  continuousSegments: ContinuousPlaybackSegment[];
  setSelectedStreamId: (streamId: string | null) => void;
};

/**
 * 工作台视频流与连续片段选择：
 * 只挑可播放片段，按焦点片段 → 最新片段 → 第一条流的顺序决定默认流，
 * 并把同一条流的片段拼成连续时间轴。
 */
export function usePlaybackStreams(input: {
  recentSegments: TestSessionVideoSegment[];
  matchedSegments: TestSessionVideoSegment[];
  videoStreams: TestSessionVideoStream[];
}): UsePlaybackStreamsResult {
  const { recentSegments, matchedSegments, videoStreams } = input;
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null);

  const playableSegments = useMemo(() => {
    return recentSegments
      .filter((segment) => segment.isPlayable && !!segment.playbackUrl)
      .sort((left, right) => left.startedAtMs - right.startedAtMs);
  }, [recentSegments]);

  const playableMatchedSegments = useMemo(() => {
    return matchedSegments.filter((segment) => segment.isPlayable && !!segment.playbackUrl);
  }, [matchedSegments]);

  const preferredStreamId = useMemo(() => {
    const focusStreamId = playableMatchedSegments[0]?.streamId;
    if (focusStreamId) return focusStreamId;
    return playableSegments.at(-1)?.streamId ?? videoStreams[0]?.streamId ?? null;
  }, [playableMatchedSegments, playableSegments, videoStreams]);

  const availablePlaybackStreams = useMemo(() => {
    const streamIds = [...new Set(playableSegments.map((segment) => segment.streamId))];
    return streamIds
      .map((streamId) => {
        const stream = videoStreams.find((item) => item.streamId === streamId);
        const latestSegment = playableSegments
          .filter((segment) => segment.streamId === streamId)
          .sort((left, right) => right.startedAtMs - left.startedAtMs)[0];
        return {
          streamId,
          label: stream?.label ?? latestSegment?.displayId ?? streamId,
          displayLabel: stream?.displayLabel ?? latestSegment?.displayId ?? streamId,
        };
      })
      .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
  }, [playableSegments, videoStreams]);

  const activeStreamId = useMemo(() => {
    if (selectedStreamId && playableSegments.some((segment) => segment.streamId === selectedStreamId)) {
      return selectedStreamId;
    }
    return preferredStreamId;
  }, [playableSegments, preferredStreamId, selectedStreamId]);

  const continuousSegments = useMemo(() => {
    if (!activeStreamId) return [] as ContinuousPlaybackSegment[];
    return buildContinuousPlaybackSegments(
      playableSegments.filter((segment) => segment.streamId === activeStreamId),
    );
  }, [activeStreamId, playableSegments]);

  const selectedStream = useMemo(() => {
    if (!activeStreamId) return null;
    return videoStreams.find((stream) => stream.streamId === activeStreamId) ?? null;
  }, [activeStreamId, videoStreams]);

  useEffect(() => {
    if (!selectedStreamId && preferredStreamId) {
      setSelectedStreamId(preferredStreamId);
      return;
    }
    if (selectedStreamId && !playableSegments.some((segment) => segment.streamId === selectedStreamId)) {
      setSelectedStreamId(preferredStreamId);
    }
  }, [playableSegments, preferredStreamId, selectedStreamId]);

  useEffect(() => {
    const focusStreamId = playableMatchedSegments[0]?.streamId;
    if (focusStreamId && focusStreamId !== selectedStreamId) {
      setSelectedStreamId(focusStreamId);
    }
  }, [playableMatchedSegments, selectedStreamId]);

  return {
    playableSegments,
    playableMatchedSegments,
    availablePlaybackStreams,
    activeStreamId,
    selectedStream,
    continuousSegments,
    setSelectedStreamId,
  };
}
