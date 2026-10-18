export const PLAYBACK_RATES = [1, 1.5, 2] as const;

export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

export function nextPlaybackRate(current: number): PlaybackRate {
  const index = PLAYBACK_RATES.findIndex((rate) => rate === current);
  if (index < 0) {
    return 1.5;
  }
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length] ?? 1;
}

export function playbackFrameRate(profile?: string | null): number {
  if (profile === 'efficiency') {
    return 7;
  }
  if (profile === 'smooth') {
    return 20;
  }
  return 14;
}

export function frameStepMs(framesPerSecond: number, direction: -1 | 1): number {
  const fps = Number.isFinite(framesPerSecond) && framesPerSecond > 0 ? framesPerSecond : 14;
  const step = Math.max(1, Math.round(1000 / fps));
  return direction * step;
}
