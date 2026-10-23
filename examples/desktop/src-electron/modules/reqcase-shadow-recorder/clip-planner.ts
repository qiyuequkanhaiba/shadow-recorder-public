import type {
  ReqCaseShadowRecorderTestSessionVideoSegment,
  ReqCaseShadowRecorderTestSessionVideoStream,
} from './types';

export type ClipRange = {
  startMs: number;
  endMs: number;
};

export type ClipPiece = {
  segmentId: string;
  streamId: string;
  filePath: string;
  inpointSeconds?: number;
  outpointSeconds?: number;
  wallStartMs: number;
  wallEndMs: number;
  outputOffsetMs: number;
  pieceDurationMs: number;
};

export type StreamClipPlan = {
  streamId: string;
  stream?: ReqCaseShadowRecorderTestSessionVideoStream;
  pieces: ClipPiece[];
  requestedStartMs: number;
  requestedEndMs: number;
  actualStartMs: number;
  actualEndMs: number;
  totalDurationMs: number;
  isPrecise: boolean;
  requiresReencode?: boolean;
  preferredEncoder?: 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264';
};

export type SessionClipPlan = {
  streamPlans: StreamClipPlan[];
  requestedStartMs?: number;
  requestedEndMs?: number;
  actualStartMs?: number;
  actualEndMs?: number;
  isPrecise: boolean;
};

function resolvePreferredEncoder(
  streamSegments: ReqCaseShadowRecorderTestSessionVideoSegment[],
): 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264' {
  for (const s of streamSegments) {
    const enc = (s.encoderName || '').toLowerCase();
    if (enc.includes('nvenc')) return 'h264_nvenc';
    if (enc.includes('qsv')) return 'h264_qsv';
    if (enc.includes('amf')) return 'h264_amf';
  }
  return 'libx264';
}

export function planStreamClip(
  streamId: string,
  segments: ReqCaseShadowRecorderTestSessionVideoSegment[],
  range?: ClipRange,
  mode: 'precise' | 'fast' = 'precise',
  stream?: ReqCaseShadowRecorderTestSessionVideoStream,
  resolveFilePath?: (segment: ReqCaseShadowRecorderTestSessionVideoSegment) => string | undefined,
): StreamClipPlan {
  // Filter playable segments for this stream and sort by startedAtMs
  const streamSegments = segments
    .filter((s) => s.streamId === streamId && s.isPlayable)
    .sort((a, b) => a.startedAtMs - b.startedAtMs);

  if (!range) {
    // Whole stream export (no clipping)
    let accumulatedMs = 0;
    const pieces: ClipPiece[] = [];
    for (const seg of streamSegments) {
      const filePath = resolveFilePath ? resolveFilePath(seg) : (seg.filePath || seg.relativePath);
      if (!filePath) continue;
      const durationMs = seg.durationMs > 0 ? seg.durationMs : Math.max(0, seg.endedAtMs - seg.startedAtMs);
      pieces.push({
        segmentId: seg.segmentId,
        streamId,
        filePath,
        wallStartMs: seg.startedAtMs,
        wallEndMs: seg.endedAtMs,
        outputOffsetMs: accumulatedMs,
        pieceDurationMs: durationMs,
      });
      accumulatedMs += durationMs;
    }
    const actualStartMs = pieces[0]?.wallStartMs ?? 0;
    const actualEndMs = pieces[pieces.length - 1]?.wallEndMs ?? 0;
    return {
      streamId,
      stream,
      pieces,
      requestedStartMs: actualStartMs,
      requestedEndMs: actualEndMs,
      actualStartMs,
      actualEndMs,
      totalDurationMs: accumulatedMs,
      isPrecise: false,
    };
  }

  const { startMs: reqStart, endMs: reqEnd } = range;
  if (reqStart >= reqEnd) {
    return {
      streamId,
      stream,
      pieces: [],
      requestedStartMs: reqStart,
      requestedEndMs: reqEnd,
      actualStartMs: reqStart,
      actualEndMs: reqStart,
      totalDurationMs: 0,
      isPrecise: mode === 'precise',
    };
  }

  // Find intersecting segments: segment.endedAtMs > reqStart && segment.startedAtMs < reqEnd
  const overlapping = streamSegments.filter((seg) => {
    const end = seg.endedAtMs;
    const start = seg.startedAtMs;
    return end > reqStart && start < reqEnd;
  });

  if (overlapping.length === 0) {
    return {
      streamId,
      stream,
      pieces: [],
      requestedStartMs: reqStart,
      requestedEndMs: reqEnd,
      actualStartMs: reqStart,
      actualEndMs: reqStart,
      totalDurationMs: 0,
      isPrecise: mode === 'precise',
    };
  }

  const isPrecise = mode === 'precise';
  let accumulatedMs = 0;
  const pieces: ClipPiece[] = [];

  for (let i = 0; i < overlapping.length; i++) {
    const seg = overlapping[i];
    const filePath = resolveFilePath ? resolveFilePath(seg) : (seg.filePath || seg.relativePath);
    if (!filePath) continue;

    const segDurationMs = seg.durationMs > 0 ? seg.durationMs : Math.max(0, seg.endedAtMs - seg.startedAtMs);

    let inpointSeconds: number | undefined;
    let outpointSeconds: number | undefined;
    let effectiveStartMs = seg.startedAtMs;
    let effectiveEndMs = seg.endedAtMs;

    if (isPrecise) {
      if (reqStart - seg.startedAtMs > 50) {
        effectiveStartMs = reqStart;
        inpointSeconds = Math.max(0, (reqStart - seg.startedAtMs) / 1000);
      }
      if (seg.endedAtMs - reqEnd > 50) {
        effectiveEndMs = reqEnd;
        outpointSeconds = Math.min(segDurationMs / 1000, Math.max(0, (reqEnd - seg.startedAtMs) / 1000));
      }
    }

    const pieceDurationMs = Math.max(0, effectiveEndMs - effectiveStartMs);
    pieces.push({
      segmentId: seg.segmentId,
      streamId,
      filePath,
      inpointSeconds,
      outpointSeconds,
      wallStartMs: effectiveStartMs,
      wallEndMs: effectiveEndMs,
      outputOffsetMs: accumulatedMs,
      pieceDurationMs,
    });
    accumulatedMs += pieceDurationMs;
  }

  const actualStartMs = pieces[0]?.wallStartMs ?? reqStart;
  const actualEndMs = pieces[pieces.length - 1]?.wallEndMs ?? reqEnd;

  const hasAnyTrim = isPrecise && pieces.some((p) => {
    const hasIn = typeof p.inpointSeconds === "number" && p.inpointSeconds > 0.05;
    const hasOut = typeof p.outpointSeconds === "number";
    return hasIn || hasOut;
  });
  const requiresReencode = isPrecise && hasAnyTrim;
  const preferredEncoder = resolvePreferredEncoder(streamSegments);

  return {
    streamId,
    stream,
    pieces,
    requestedStartMs: reqStart,
    requestedEndMs: reqEnd,
    actualStartMs,
    actualEndMs,
    totalDurationMs: accumulatedMs,
    isPrecise,
    requiresReencode,
    preferredEncoder,
  };
}

export function planSessionClips(
  streams: ReqCaseShadowRecorderTestSessionVideoStream[],
  segments: ReqCaseShadowRecorderTestSessionVideoSegment[],
  range?: ClipRange,
  mode: 'precise' | 'fast' = 'precise',
  resolveFilePath?: (segment: ReqCaseShadowRecorderTestSessionVideoSegment) => string | undefined,
): SessionClipPlan {
  // If streams are given, plan for each stream
  const streamIds = streams.length > 0
    ? streams.map((s) => s.streamId)
    : [...new Set(segments.map((seg) => seg.streamId))];

  const streamPlans = streamIds.map((sId) => {
    const stream = streams.find((s) => s.streamId === sId);
    return planStreamClip(sId, segments, range, mode, stream, resolveFilePath);
  });

  const minActualStart = streamPlans.length > 0 && streamPlans.some((p) => p.pieces.length > 0)
    ? Math.min(...streamPlans.filter((p) => p.pieces.length > 0).map((p) => p.actualStartMs))
    : range?.startMs;

  const maxActualEnd = streamPlans.length > 0 && streamPlans.some((p) => p.pieces.length > 0)
    ? Math.max(...streamPlans.filter((p) => p.pieces.length > 0).map((p) => p.actualEndMs))
    : range?.endMs;

  return {
    streamPlans,
    requestedStartMs: range?.startMs,
    requestedEndMs: range?.endMs,
    actualStartMs: minActualStart,
    actualEndMs: maxActualEnd,
    isPrecise: mode === 'precise',
  };
}

/**
 * Maps a wall clock epoch timestamp to relative offset in the exported stream video.
 * Returns undefined if the event fell outside the exported pieces.
 */
export function mapWallClockToVideoOffsetMs(
  wallClockMs: number,
  plan: StreamClipPlan,
): number | undefined {
  for (const piece of plan.pieces) {
    if (wallClockMs >= piece.wallStartMs && wallClockMs <= piece.wallEndMs) {
      return piece.outputOffsetMs + (wallClockMs - piece.wallStartMs);
    }
  }
  return undefined;
}
