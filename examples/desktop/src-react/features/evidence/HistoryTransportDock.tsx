import React from 'react';
import { Button } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import type { UseVideoElementControllerResult } from '../player/useVideoElementController';
import styles from './HistorySessionPanel.module.css';

export type HistoryTransportDockProps = {
  controller: UseVideoElementControllerResult;
  hasActiveSegment: boolean;
  segmentIndex: number;
  totalSegments: number;
  durationMs: number;
  onPrevSegment: () => void;
  onNextSegment: () => void;
};

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function HistoryTransportDock({
  controller,
  hasActiveSegment,
  segmentIndex,
  totalSegments,
  durationMs,
  onPrevSegment,
  onNextSegment,
}: HistoryTransportDockProps) {
  const seekFraction = durationMs > 0 ? Math.min(1, Math.max(0, controller.currentTimeMs / durationMs)) : 0;

  return (
    <div className={styles.transportDock} role="toolbar" aria-label="视频回放控制">
      <div className={styles.transportLeft}>
        <Button
          variant="ghost"
          size="sm"
          disabled={!hasActiveSegment}
          onClick={() => controller.seekDeltaSeconds(-5)}
          title="后退 5 秒"
          aria-label="后退 5 秒"
        >
          -5s
        </Button>

        <Button
          variant="secondary"
          size="sm"
          disabled={!hasActiveSegment}
          onClick={controller.togglePlay}
          title={controller.isPlaying ? '暂停播放 (空格)' : '播放视频 (空格)'}
          aria-label={controller.isPlaying ? '暂停' : '播放'}
        >
          {controller.isPlaying ? '⏸' : '▶'}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          disabled={!hasActiveSegment}
          onClick={() => controller.seekDeltaSeconds(5)}
          title="前进 5 秒"
          aria-label="前进 5 秒"
        >
          +5s
        </Button>

        <Button
          variant="ghost"
          size="sm"
          disabled={segmentIndex <= 0}
          onClick={onPrevSegment}
          title="切换至上一段"
          aria-label="上一段"
        >
          ⏮ 上一段
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={segmentIndex >= totalSegments - 1}
          onClick={onNextSegment}
          title="切换至下一段"
          aria-label="下一段"
        >
          下一段 ⏭
        </Button>
      </div>

      <div className={styles.scrubberTrack}>
        <span className={styles.timeReadout}>
          {formatClock(controller.currentTimeMs)} / {formatClock(durationMs)}
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={seekFraction}
          aria-label="播放进度调节"
          className={styles.slider}
          disabled={!hasActiveSegment}
          onChange={(e) => {
            const fraction = parseFloat(e.target.value);
            controller.seekMs(fraction * durationMs);
          }}
        />
      </div>

      <div className={styles.transportRight}>
        <IconButton
          size="sm"
          aria-label="静音"
          title={controller.isMuted ? '取消静音' : '静音'}
          onClick={controller.toggleMute}
        >
          <span>{controller.isMuted ? '🔇' : '🔊'}</span>
        </IconButton>
        <IconButton
          size="sm"
          aria-label="全屏播放"
          title="全屏播放"
          onClick={() => controller.toggleFullscreen()}
        >
          <span>⤢</span>
        </IconButton>
      </div>
    </div>
  );
}
