import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TestSessionState, TestSessionVideoSegment } from '../../../types/contracts';

type HistorySessionPanelProps = {
  session: TestSessionState | null;
  semanticEnabled?: boolean;
  onOpenSemanticReview?: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onMetaSaved?: () => void;
};

function formatClock(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatWhen(startedAtMs: number): string {
  return new Date(startedAtMs).toLocaleString('zh-CN', { hour12: false });
}

function isExportCanceled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cancel/i.test(message);
}

export function HistorySessionPanel(props: HistorySessionPanelProps) {
  const sessionId = props.session?.sessionId ?? null;
  const isLive = props.session?.status === 'active' || props.session?.status === 'paused';
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const loadedSegmentIdRef = useRef<string | null>(null);

  const [segments, setSegments] = useState<TestSessionVideoSegment[]>([]);
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [operationCount, setOperationCount] = useState(0);

  // Video playback position state
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [segmentDurationMs, setSegmentDurationMs] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    setEditing(false);
    setName(props.session?.name ?? '');
    setNotes(props.session?.notes ?? '');
    setSegmentIndex(0);
    setPlaying(false);
    setCurrentTimeMs(0);
    setSegmentDurationMs(0);
  }, [props.session?.name, props.session?.notes, sessionId]);

  useEffect(() => {
    if (!sessionId || !window.reqcaseShadowRecorder.getTestSessionVideoSegments) {
      setSegments([]);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    void window.reqcaseShadowRecorder.getTestSessionVideoSegments({
      sessionId,
      limit: 2000,
    }).then((items) => {
      if (cancelled) {
        return;
      }
      const playable = items
        .filter((segment) => segment.isPlayable && !!segment.playbackUrl)
        .sort((left, right) => left.startedAtMs - right.startedAtMs);
      setSegments(playable);
      setSegmentIndex(0);
    }).catch((error) => {
      if (!cancelled) {
        props.onError(error instanceof Error ? error.message : String(error));
        setSegments([]);
      }
    }).finally(() => {
      if (!cancelled) {
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [props.onError, sessionId]);

  useEffect(() => {
    const api = window.reqcaseShadowRecorder;
    if (!sessionId || !api.getTestSessionOperations) {
      setOperationCount(0);
      return undefined;
    }
    let cancelled = false;
    void api.getTestSessionOperations({ sessionId, limit: 1 }).then((result) => {
      if (cancelled) {
        return;
      }
      const total = typeof result?.totalCount === 'number' ? result.totalCount : result?.items?.length ?? 0;
      setOperationCount(total);
    }).catch(() => {
      if (!cancelled) {
        setOperationCount(0);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const activeSegment = segments[segmentIndex] ?? null;
  const totalDurationMs = useMemo(
    () => segments.reduce((sum, segment) => sum + (segment.durationMs || 0), 0),
    [segments],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (!activeSegment?.playbackUrl) {
      loadedSegmentIdRef.current = null;
      video.removeAttribute('src');
      setCurrentTimeMs(0);
      setSegmentDurationMs(0);
      return;
    }
    if (loadedSegmentIdRef.current !== activeSegment.segmentId) {
      loadedSegmentIdRef.current = activeSegment.segmentId;
      video.src = activeSegment.playbackUrl;
      setCurrentTimeMs(0);
      setSegmentDurationMs(activeSegment.durationMs || 0);
    }
    if (playing) {
      void video.play().catch(() => setPlaying(false));
      return;
    }
    video.pause();
  }, [activeSegment?.durationMs, activeSegment?.playbackUrl, activeSegment?.segmentId, playing]);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video || !activeSegment) {
      return;
    }
    if (video.paused) {
      void video.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
      return;
    }
    video.pause();
    setPlaying(false);
  }, [activeSegment]);

  const handleSeekDelta = useCallback((deltaSeconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    const target = Math.max(0, Math.min(video.duration || 0, video.currentTime + deltaSeconds));
    video.currentTime = target;
    setCurrentTimeMs(Math.round(target * 1000));
  }, []);

  const handleScrubberChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    const seekFraction = parseFloat(e.target.value);
    const targetSeconds = seekFraction * video.duration;
    video.currentTime = targetSeconds;
    setCurrentTimeMs(Math.round(targetSeconds * 1000));
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const nextMuted = !video.muted;
    video.muted = nextMuted;
    setIsMuted(nextMuted);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    if (!document.fullscreenElement) {
      void stage.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => undefined);
    } else {
      void document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const handleCopySessionId = useCallback(() => {
    if (!sessionId) return;
    void navigator.clipboard.writeText(sessionId).then(() => {
      setCopiedId(true);
      props.onNotice(`已复制会话ID: ${sessionId}`);
      setTimeout(() => setCopiedId(false), 1600);
    });
  }, [props, sessionId]);

  async function saveMeta(): Promise<void> {
    const api = window.reqcaseShadowRecorder;
    if (!props.session || !api.updateTestSessionMeta) {
      props.onError('当前环境不能修改会话信息');
      return;
    }
    const nextName = name.trim();
    if (!nextName || /[\\/:\n\r]/.test(nextName)) {
      props.onError('名称无效，请避免斜杠、冒号或换行');
      return;
    }
    setBusy(true);
    try {
      const result = await api.updateTestSessionMeta({
        sessionId: props.session.sessionId,
        name: nextName,
        notes,
      });
      if (result && typeof result === 'object' && 'error' in result && result.error) {
        props.onError(String(result.error));
        return;
      }
      setEditing(false);
      props.onMetaSaved?.();
      props.onNotice('会话信息已保存');
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function exportSession(): Promise<void> {
    const api = window.reqcaseShadowRecorder;
    if (!props.session || !api.exportTestSessionEvidence) {
      props.onError('当前环境不能导出会话');
      return;
    }
    const bundleName = props.session.name?.trim() || props.session.sessionId;
    setBusy(true);
    setIsExporting(true);
    try {
      const result = await api.exportTestSessionEvidence({
        sessionId: props.session.sessionId,
        outputMode: 'zip',
        bundleName,
        targetDir: '',
        zipFileName: `${bundleName}.zip`,
        privacyAcknowledgedAt: new Date().toISOString(),
      });
      props.onNotice(`已导出会话：${result.zipPath || result.artifactPath || bundleName}`);
    } catch (error) {
      if (isExportCanceled(error)) {
        props.onNotice('已取消导出');
        return;
      }
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      setIsExporting(false);
    }
  }

  if (!props.session) {
    return (
      <section className="history-session-panel" aria-label="历史记录">
        <div className="history-session-empty-card">
          <div className="empty-icon" aria-hidden="true">🎬</div>
          <h3>未选择会话</h3>
          <p>请在左侧列表中点击选择一条会话以回放录像、检视切片或导出证据。</p>
        </div>
      </section>
    );
  }

  const durationForDisplay = segmentDurationMs || (activeSegment?.durationMs ?? 0);
  const seekFraction = durationForDisplay > 0 ? Math.min(1, Math.max(0, currentTimeMs / durationForDisplay)) : 0;

  return (
    <section className="history-session-panel" aria-label="历史记录">
      {/* 1. Session Information Header Card */}
      <header className="history-session-header">
        <div className="history-session-meta-lead">
          <div className="history-session-title-line">
            <h3 className="history-session-heading">
              {props.session.name?.trim() || '未命名会话'}
            </h3>
            <span className={`history-session-status-badge ${isLive ? 'is-live' : 'is-archived'}`}>
              {isLive ? '🔴 录制中' : '⚪ 已归档'}
            </span>
          </div>

          <div className="history-session-meta-chips">
            <span className="history-meta-chip" title="会话开始时间">
              📅 {formatWhen(props.session.startedAtMs)}
            </span>
            {totalDurationMs > 0 ? (
              <span className="history-meta-chip" title="总录制时长">
                ⏱️ {formatClock(totalDurationMs)}
              </span>
            ) : null}
            <span className="history-meta-chip" title="视频切片总数">
              📑 {segments.length} 个切片
            </span>
            <button
              type="button"
              className="history-meta-copy-btn"
              onClick={handleCopySessionId}
              title={`复制会话 ID: ${sessionId}`}
            >
              {copiedId ? '✓ 已复制 ID' : '📋 复制 ID'}
            </button>
          </div>
        </div>

        <div className="history-session-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => setEditing((current) => !current)}
          >
            {editing ? '取消编辑' : '✏️ 编辑'}
          </button>
          {(operationCount > 0 || (props.semanticEnabled && isLive)) && props.onOpenSemanticReview ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={props.onOpenSemanticReview}
            >
              语义步骤
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary btn-sm history-export-btn"
            disabled={busy || isLive || isExporting}
            onClick={() => { void exportSession(); }}
          >
            {isExporting ? '正在导出…' : '导出'}
          </button>
        </div>
      </header>

      {/* 2. Metadata Editing Form */}
      {editing ? (
        <div className="history-session-form-card">
          <div className="history-form-group">
            <div className="history-form-label-row">
              <label htmlFor="history-name-input">会话名称</label>
              <span className="history-char-counter">{name.length} / 80</span>
            </div>
            <input
              id="history-name-input"
              className="history-form-input"
              value={name}
              maxLength={80}
              placeholder="输入简明易记的测试会话名称..."
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="history-form-group">
            <div className="history-form-label-row">
              <label htmlFor="history-notes-input">会话备注 / 缺陷说明</label>
              <span className="history-char-counter">{notes.length} / 2000</span>
            </div>
            <textarea
              id="history-notes-input"
              className="history-form-textarea"
              value={notes}
              maxLength={2000}
              rows={3}
              placeholder="记录测试用例编号、前置条件或缺陷概要..."
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>

          <div className="history-form-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => { void saveMeta(); }}
            >
              保存修改
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              取消
            </button>
          </div>
        </div>
      ) : props.session.notes ? (
        <div className="history-session-notes-card">
          <span className="notes-kicker">会话备注</span>
          <p className="notes-body">{props.session.notes}</p>
        </div>
      ) : null}

      {/* 3. Cinema Video Stage */}
      <div className={`history-session-stage${isFullscreen ? ' is-fullscreen' : ''}`} ref={stageRef}>
        {loading ? (
          <div className="history-stage-center-msg">
            <div className="history-stage-spinner" aria-hidden="true" />
            <p>正在读取录像切片…</p>
          </div>
        ) : null}

        {!loading && !activeSegment ? (
          <div className="history-stage-center-msg">
            <span className="stage-empty-icon" aria-hidden="true">🎬</span>
            <p>{isLive ? '正在写入当前切片，已封口的片段将在此就绪。' : '当前会话没有可播放的视频切片。'}</p>
          </div>
        ) : null}

        {activeSegment?.playbackUrl ? (
          <div className="history-video-container" onClick={togglePlayback}>
            <video
              ref={videoRef}
              controls={false}
              onTimeUpdate={(e) => {
                setCurrentTimeMs(Math.round(e.currentTarget.currentTime * 1000));
              }}
              onDurationChange={(e) => {
                if (Number.isFinite(e.currentTarget.duration)) {
                  setSegmentDurationMs(Math.round(e.currentTarget.duration * 1000));
                }
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => {
                setSegmentIndex((current) => {
                  if (current + 1 < segments.length) {
                    return current + 1;
                  }
                  setPlaying(false);
                  return current;
                });
              }}
            />
            {/* Play / Pause Center Overlay Indicator */}
            {!playing ? (
              <div className="history-video-center-overlay" aria-hidden="true">
                <div className="center-play-glyph">▶</div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 4. Integrated Video Transport Controls */}
      <div className="history-session-transport-dock" role="toolbar" aria-label="视频回放控制">
        <div className="transport-controls-left">
          <button
            type="button"
            className="transport-btn transport-btn-step"
            disabled={!activeSegment}
            onClick={() => handleSeekDelta(-5)}
            title="后退 5 秒"
            aria-label="后退 5 秒"
          >
            -5s
          </button>

          <button
            type="button"
            className="transport-btn transport-btn-play"
            disabled={!activeSegment}
            onClick={togglePlayback}
            title={playing ? '暂停播放 (空格)' : '播放视频 (空格)'}
            aria-label={playing ? '暂停' : '播放'}
          >
            {playing ? '⏸' : '▶'}
          </button>

          <button
            type="button"
            className="transport-btn transport-btn-step"
            disabled={!activeSegment}
            onClick={() => handleSeekDelta(5)}
            title="前进 5 秒"
            aria-label="前进 5 秒"
          >
            +5s
          </button>

          <div className="transport-segment-nav">
            <button
              type="button"
              className="transport-btn transport-btn-segment"
              disabled={segmentIndex <= 0}
              onClick={() => setSegmentIndex((current) => Math.max(0, current - 1))}
              title="切换至上一段"
              aria-label="上一段"
            >
              ⏮ 上一段
            </button>
            <button
              type="button"
              className="transport-btn transport-btn-segment"
              disabled={segmentIndex >= segments.length - 1}
              onClick={() => setSegmentIndex((current) => Math.min(segments.length - 1, current + 1))}
              title="切换至下一段"
              aria-label="下一段"
            >
              下一段 ⏭
            </button>
          </div>
        </div>

        {/* Time Progress Scrubber */}
        <div className="transport-scrubber-track">
          <span className="transport-time-readout">
            {formatClock(currentTimeMs)} / {formatClock(durationForDisplay)}
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={seekFraction}
            disabled={!activeSegment || durationForDisplay === 0}
            onChange={handleScrubberChange}
            className="history-scrubber-slider"
            aria-label="播放进度调节"
          />
        </div>

        <div className="transport-controls-right">
          <button
            type="button"
            className="transport-btn transport-btn-icon"
            onClick={toggleMute}
            title={isMuted ? '解除静音' : '静音'}
            aria-label={isMuted ? '解除静音' : '静音'}
          >
            {isMuted ? '🔇' : '🔊'}
          </button>
          <button
            type="button"
            className="transport-btn transport-btn-icon"
            onClick={toggleFullscreen}
            title={isFullscreen ? '退出全屏' : '全屏播放'}
            aria-label={isFullscreen ? '退出全屏' : '全屏播放'}
          >
            {isFullscreen ? '⤓' : '⤢'}
          </button>
        </div>
      </div>

      {/* 5. Segment Playlist Strip (切片切换导航条) */}
      {segments.length > 1 ? (
        <div className="history-segments-strip" aria-label="切片列表">
          <span className="strip-title">录像切片 ({segments.length})：</span>
          <div className="strip-items-scroll">
            {segments.map((seg, idx) => {
              const isSelected = idx === segmentIndex;
              return (
                <button
                  key={seg.segmentId || idx}
                  type="button"
                  className={`segment-strip-chip ${isSelected ? 'is-active' : ''}`}
                  onClick={() => {
                    setSegmentIndex(idx);
                    setPlaying(true);
                  }}
                  title={`点击播放切片 ${idx + 1}`}
                >
                  <span className="chip-idx">#{idx + 1}</span>
                  <span className="chip-duration">{formatClock(seg.durationMs || 0)}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

