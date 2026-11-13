import type { RefObject, SyntheticEvent } from 'react';

import type { ContinuousPlaybackSegment } from '../../components/StudioTimelineDock';
import styles from './Workbench.module.css';

export type WorkbenchViewportContentProps = {
  isLiveWriting: boolean;
  isInitialLoading: boolean;
  canRenderVideo: boolean;
  sealedSegmentCount: number;
  activeSegment: ContinuousPlaybackSegment | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  badgeText: string;
  playerError: string | null;
  onVideoClick: () => void;
  onVideoDoubleClick: () => void;
  videoHandlers: {
    onLoadedMetadata: (event: SyntheticEvent<HTMLVideoElement>) => void;
    onTimeUpdate: (event: SyntheticEvent<HTMLVideoElement>) => void;
    onEnded: () => void;
    onError: () => void;
  };
};

/**
 * 工作台画面区的四种状态：录制写入中、首次加载、可回放、空状态；
 * 以及与状态无关的播放错误提示。
 */
export function WorkbenchViewportContent(props: WorkbenchViewportContentProps) {
  let content;
  if (props.isLiveWriting) {
    content = (
      <div className={styles.centerState}>
        <div className={styles.recordPulse} aria-hidden="true">
          <span className={styles.recordPulseRing} />
          <span className={styles.recordPulseCore} />
        </div>
        <h3 className={styles.stateTitle}>正在写入当前切片</h3>
        <p className={styles.stateSub}>
          已封口 {props.sealedSegmentCount} 段 · 暂停或停止后可回放
        </p>
      </div>
    );
  } else if (props.isInitialLoading) {
    content = (
      <div className={styles.centerState} role="status">
        <div className={styles.emptyIcon} aria-hidden="true">⌛</div>
        <h3 className={styles.stateTitle}>正在读取录像切片…</h3>
        <p className={styles.stateSub}>正在同步最近录制片段数据</p>
      </div>
    );
  } else if (props.canRenderVideo && props.activeSegment) {
    content = (
      <>
        <video
          key={props.activeSegment.segmentId}
          ref={props.videoRef}
          className={styles.videoElement}
          aria-label="已封口录像回放"
          src={props.activeSegment.playbackUrl}
          playsInline
          preload="metadata"
          muted
          onClick={(event) => {
            event.preventDefault();
            props.onVideoClick();
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            props.onVideoDoubleClick();
          }}
          onLoadedMetadata={props.videoHandlers.onLoadedMetadata}
          onTimeUpdate={props.videoHandlers.onTimeUpdate}
          onEnded={props.videoHandlers.onEnded}
          onError={props.videoHandlers.onError}
        />
        <div className={styles.badgeCorner}>{props.badgeText}</div>
      </>
    );
  } else {
    content = (
      <div className={styles.centerState}>
        <div className={styles.emptyIcon} aria-hidden="true">🎬</div>
        <h3 className={styles.stateTitle}>暂无可回放录像</h3>
        <p className={styles.stateSub}>等待录制封口后切片就绪</p>
      </div>
    );
  }

  return (
    <>
      {content}
      {props.playerError ? (
        <div className={styles.playerError} role="alert">
          <strong>提示:</strong> <span>{props.playerError}</span>
        </div>
      ) : null}
    </>
  );
}
