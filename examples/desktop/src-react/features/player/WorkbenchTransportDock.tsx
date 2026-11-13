import type { ChangeEvent } from 'react';
import { formatClock } from './coordinate-mapping';
import styles from './Workbench.module.css';

export type WorkbenchTransportDockProps = {
  hasSegments: boolean;
  isPlaybackRunning: boolean;
  playbackRate: number;
  globalPlaybackMs: number;
  totalDurationMs: number;
  playbackProgressPct: number;
  canMarkQuickDefect: boolean;
  isQuickDefectPending: boolean;
  isFullscreen: boolean;
  onSeekByDelta: (deltaMs: number) => void;
  onTogglePlayback: () => void;
  onFrameStep: (direction: -1 | 1) => void;
  onCyclePlaybackRate: () => void;
  onSeekBarInput: (event: ChangeEvent<HTMLInputElement>) => void;
  onSetInPoint: () => void;
  onSetOutPoint: () => void;
  onQuickDefect: () => void;
  onToggleFullscreen: () => void;
};

export function WorkbenchTransportDock(props: WorkbenchTransportDockProps) {
  return (
    <div className={styles.transportDock} role="toolbar" aria-label="回放控制栏">
      <button
        type="button"
        className={styles.btnDockStep}
        onClick={() => props.onSeekByDelta(-5000)}
        disabled={!props.hasSegments}
        title="后退 5 秒"
        aria-label="后退 5 秒"
      >
        -5s
      </button>

      <button
        type="button"
        className={styles.btnDockPlay}
        onClick={props.onTogglePlayback}
        disabled={!props.hasSegments}
        title={props.isPlaybackRunning ? '暂停播放 (空格)' : '播放录像 (空格)'}
        aria-label={props.isPlaybackRunning ? '暂停播放 (空格)' : '播放录像 (空格)'}
      >
        {props.isPlaybackRunning ? (
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="currentColor"
            aria-hidden="true"
            style={{ marginLeft: '2px' }}
          >
            <polygon points="6 4 19 12 6 20 6 4" />
          </svg>
        )}
      </button>

      <button
        type="button"
        className={styles.btnDockStep}
        onClick={() => props.onSeekByDelta(5000)}
        disabled={!props.hasSegments}
        title="前进 5 秒"
        aria-label="前进 5 秒"
      >
        +5s
      </button>

      <button
        type="button"
        className={styles.btnDockStep}
        onClick={() => props.onFrameStep(-1)}
        disabled={!props.hasSegments}
        title="上一帧 (,)"
        aria-label="上一帧"
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
          <path d="M6 5h2v14H6zm3 7 9 7V5z" />
        </svg>
      </button>

      <button
        type="button"
        className={styles.btnDockStep}
        onClick={props.onCyclePlaybackRate}
        disabled={!props.hasSegments}
        title="切换 1、1.5、2 倍速"
        aria-label={`播放速度 ${props.playbackRate === 1.5 ? '1.5×' : `${props.playbackRate}×`}`}
      >
        {props.playbackRate === 1.5 ? '1.5×' : `${props.playbackRate}×`}
      </button>

      <button
        type="button"
        className={styles.btnDockStep}
        onClick={() => props.onFrameStep(1)}
        disabled={!props.hasSegments}
        title="下一帧 (.)"
        aria-label="下一帧"
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
          <path d="M16 5h2v14h-2zM6 19l9-7-9-7z" />
        </svg>
      </button>

      <div className={styles.timeTrack}>
        <span className={styles.clockReadout}>
          {props.hasSegments
            ? `${formatClock(props.globalPlaybackMs)} / ${formatClock(props.totalDurationMs)}`
            : '-- / --'}
        </span>

        <div className={styles.scrubberShell}>
          <div className={styles.scrubberBar} aria-hidden="true">
            <div
              className={styles.scrubberFill}
              style={{ width: `${props.playbackProgressPct}%` }}
            />
          </div>
          <input
            className={styles.scrubberInput}
            type="range"
            min={0}
            max={Math.max(props.totalDurationMs, 1)}
            step={100}
            value={Math.min(props.globalPlaybackMs, Math.max(props.totalDurationMs, 1))}
            disabled={!props.hasSegments}
            aria-label="播放进度"
            onChange={props.onSeekBarInput}
          />
        </div>
      </div>

      <div className={styles.btnGroupRange}>
        <button
          type="button"
          className={styles.btnDockPill}
          disabled={!props.hasSegments}
          onClick={props.onSetInPoint}
          title="设置导出入点 (I)"
        >
          [ 入点
        </button>
        <button
          type="button"
          className={styles.btnDockPill}
          disabled={!props.hasSegments}
          onClick={props.onSetOutPoint}
          title="设置导出出点 (O)"
        >
          出点 ]
        </button>
      </div>

      <button
        type="button"
        className={styles.btnDockQuickDefect}
        onClick={props.onQuickDefect}
        disabled={!props.canMarkQuickDefect || props.isQuickDefectPending}
        title="标记当前回放位置为缺陷"
        aria-label="标记当前回放位置为缺陷"
        aria-busy={props.isQuickDefectPending}
      >
        {props.isQuickDefectPending ? '标记中…' : '🚩 标记瞬时'}
      </button>

      <button
        type="button"
        className={styles.btnDockStep}
        onClick={props.onToggleFullscreen}
        disabled={!props.hasSegments}
        title={props.isFullscreen ? '退出全屏' : '全屏回放'}
        aria-label={props.isFullscreen ? '退出全屏' : '全屏回放'}
      >
        <svg
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {props.isFullscreen ? (
            <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
          ) : (
            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
          )}
        </svg>
      </button>
    </div>
  );
}
