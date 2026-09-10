import type {
  TestSessionVideoSegment,
  TestSessionVideoStream,
} from '../../types/contracts';

export type VideoEncoderSummary = {
  encoderLabel: string;
  codecLabel: string;
  pathLabel: string;
  streamLabel: string;
  detailLabel: string;
  isHardwareActive: boolean | null;
};

function normalizeEncoderName(encoderName?: string | null): string | null {
  if (!encoderName) {
    return null;
  }

  const normalized = encoderName.replace(/^ffmpeg:/i, '').trim();
  return normalized.length > 0 ? normalized : null;
}

function isHardwareEncoder(encoderName?: string | null): boolean {
  const normalized = normalizeEncoderName(encoderName)?.toLowerCase() ?? '';
  return (
    normalized.includes('_nvenc')
    || normalized.includes('_qsv')
    || normalized.includes('_amf')
    || normalized.includes('_videotoolbox')
    || normalized.includes('_vaapi')
  );
}

function formatCodecLabel(codec?: string | null): string {
  if (!codec) {
    return '--';
  }

  return codec.toUpperCase();
}

function selectLatestSegment(
  segments: TestSessionVideoSegment[],
  preferredStreamId?: string | null,
): TestSessionVideoSegment | null {
  const sorted = segments
    .slice()
    .sort((left, right) => {
      const rightTimestamp = right.endedAtMs ?? right.startedAtMs;
      const leftTimestamp = left.endedAtMs ?? left.startedAtMs;
      return rightTimestamp - leftTimestamp;
    });

  if (preferredStreamId) {
    const preferredSegment = sorted.find((segment) => segment.streamId === preferredStreamId);
    if (preferredSegment) {
      return preferredSegment;
    }
  }

  return sorted[0] ?? null;
}

export function resolveVideoEncoderSummary(input: {
  streams: TestSessionVideoStream[];
  segments: TestSessionVideoSegment[];
  preferredStreamId?: string | null;
}): VideoEncoderSummary {
  const selectedStream =
    (input.preferredStreamId
      ? input.streams.find((stream) => stream.streamId === input.preferredStreamId)
      : null)
    ?? input.streams[0]
    ?? null;
  const latestSegment = selectLatestSegment(input.segments, selectedStream?.streamId);
  const encoderLabel = normalizeEncoderName(latestSegment?.encoderName) ?? '--';
  const codecLabel = formatCodecLabel(latestSegment?.codec);
  const isHardwareActive = latestSegment ? isHardwareEncoder(latestSegment.encoderName) : null;
  const pathLabel =
    latestSegment
      ? (isHardwareActive ? '硬件编码' : '软件编码')
      : (selectedStream?.status === 'active' ? '等待首段' : '未就绪');
  const streamLabel = selectedStream?.label ?? '--';
  const detailParts = [
    codecLabel !== '--' ? codecLabel : null,
    streamLabel !== '--' ? streamLabel : null,
  ].filter((part): part is string => Boolean(part));

  return {
    encoderLabel,
    codecLabel,
    pathLabel,
    streamLabel,
    detailLabel: detailParts.length > 0 ? detailParts.join(' · ') : '暂无编码样本',
    isHardwareActive,
  };
}
