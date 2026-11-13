import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject, SyntheticEvent } from 'react';

export type UseVideoElementControllerInput = {
  onEnded?: () => void;
};

export type UseVideoElementControllerResult = {
  videoRef: RefObject<HTMLVideoElement | null>;
  isPlaying: boolean;
  currentTimeMs: number;
  durationMs: number;
  playbackRate: number;
  isMuted: boolean;
  isFullscreen: boolean;
  hasError: boolean;
  errorMessage: string | null;
  play: () => Promise<void>;
  pause: () => void;
  togglePlay: () => void;
  seekMs: (targetMs: number) => void;
  seekDeltaSeconds: (deltaSeconds: number) => void;
  setRate: (rate: number) => void;
  toggleMute: () => void;
  toggleFullscreen: (containerElement?: HTMLElement | null) => void;
  clearError: () => void;
  reset: () => void;
  setCustomError: (message: string | null) => void;
  handleError: () => void;
  handleLoadedMetadata: (e: SyntheticEvent<HTMLVideoElement>) => void;
  handleTimeUpdate: (e: SyntheticEvent<HTMLVideoElement>) => void;
  handlePlay: () => void;
  handlePause: () => void;
  handleEnded: () => void;
};

export function useVideoElementController(
  input?: UseVideoElementControllerInput,
): UseVideoElementControllerResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const clearError = useCallback(() => {
    setErrorMessage(null);
  }, []);

  const reset = useCallback(() => {
    const video = videoRef.current;
    if (video && !video.paused) {
      video.pause();
    }
    setIsPlaying(false);
    setCurrentTimeMs(0);
    setDurationMs(0);
    setErrorMessage(null);
  }, []);

  const handleError = useCallback(() => {
    setErrorMessage('当前录像加载失败');
    setIsPlaying(false);
  }, []);

  const handleLoadedMetadata = useCallback((e: SyntheticEvent<HTMLVideoElement>) => {
    setErrorMessage(null);
    const element = e.currentTarget;
    if (Number.isFinite(element.duration) && element.duration > 0) {
      setDurationMs(Math.round(element.duration * 1000));
    }
  }, []);

  const handleTimeUpdate = useCallback((e: SyntheticEvent<HTMLVideoElement>) => {
    setCurrentTimeMs(Math.round(e.currentTarget.currentTime * 1000));
  }, []);

  const handlePlay = useCallback(() => {
    setIsPlaying(true);
  }, []);

  const handlePause = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const handleEnded = useCallback(() => {
    setIsPlaying(false);
    input?.onEnded?.();
  }, [input]);

  const play = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      await video.play();
      setIsPlaying(true);
    } catch {
      setIsPlaying(false);
    }
  }, []);

  const pause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    setIsPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void play();
    } else {
      pause();
    }
  }, [pause, play]);

  const seekMs = useCallback((targetMs: number) => {
    const video = videoRef.current;
    if (!video) return;
    const clampedSeconds = Math.max(0, targetMs / 1000);
    video.currentTime = clampedSeconds;
    setCurrentTimeMs(Math.round(clampedSeconds * 1000));
  }, []);

  const seekDeltaSeconds = useCallback((deltaSeconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    const nextSeconds = Math.max(0, (video.currentTime || 0) + deltaSeconds);
    video.currentTime = nextSeconds;
    setCurrentTimeMs(Math.round(nextSeconds * 1000));
  }, []);

  const setRate = useCallback((rate: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = rate;
    setPlaybackRate(rate);
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const nextMuted = !video.muted;
    video.muted = nextMuted;
    setIsMuted(nextMuted);
  }, []);

  const toggleFullscreen = useCallback((containerElement?: HTMLElement | null) => {
    const target = containerElement ?? videoRef.current;
    if (!target) return;

    if (!document.fullscreenElement) {
      void target.requestFullscreen?.().catch(() => undefined);
      setIsFullscreen(true);
    } else {
      void document.exitFullscreen?.().catch(() => undefined);
      setIsFullscreen(false);
    }
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, []);

  return {
    videoRef,
    isPlaying,
    currentTimeMs,
    durationMs,
    playbackRate,
    isMuted,
    isFullscreen,
    hasError: errorMessage !== null,
    errorMessage,
    play,
    pause,
    togglePlay,
    seekMs,
    seekDeltaSeconds,
    setRate,
    toggleMute,
    toggleFullscreen,
    clearError,
    reset,
    setCustomError: setErrorMessage,
    handleError,
    handleLoadedMetadata,
    handleTimeUpdate,
    handlePlay,
    handlePause,
    handleEnded,
  };
}
