import { useEffect, useMemo, useRef, useState } from 'react';

import type { TestSessionState, TestSessionVideoSegment } from '../../../types/contracts';

type HistorySessionPanelProps = {
  session: TestSessionState | null;
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
  const loadedSegmentIdRef = useRef<string | null>(null);
  const [segments, setSegments] = useState<TestSessionVideoSegment[]>([]);
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEditing(false);
    setName(props.session?.name ?? '');
    setNotes(props.session?.notes ?? '');
    setSegmentIndex(0);
    setPlaying(false);
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
      return;
    }
    if (loadedSegmentIdRef.current !== activeSegment.segmentId) {
      loadedSegmentIdRef.current = activeSegment.segmentId;
      video.src = activeSegment.playbackUrl;
    }
    if (playing) {
      void video.play().catch(() => setPlaying(false));
      return;
    }
    video.pause();
  }, [activeSegment?.playbackUrl, activeSegment?.segmentId, playing]);

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
    }
  }

  function togglePlayback(): void {
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
  }

  if (!props.session) {
    return (
      <section className="history-session-panel" aria-label="历史记录">
        <header className="history-session-header">
          <h3>历史记录</h3>
          <p>选择左侧一条已结束的会话，回放录像、修改名称或导出。</p>
        </header>
      </section>
    );
  }

  return (
    <section className="history-session-panel" aria-label="历史记录">
      <header className="history-session-header">
        <div>
          <h3>{props.session.name?.trim() || '未命名会话'}</h3>
          <p>
            {formatWhen(props.session.startedAtMs)}
            {props.session.endedAtMs ? ` · ${formatClock(props.session.endedAtMs - props.session.startedAtMs)}` : ''}
            {isLive ? ' · 录制中' : ''}
          </p>
        </div>
        <div className="history-session-actions">
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setEditing((current) => !current)}>
            {editing ? '取消编辑' : '编辑'}
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || isLive} onClick={() => { void exportSession(); }}>
            导出
          </button>
        </div>
      </header>

      {editing ? (
        <div className="history-session-form">
          <label>
            <span>名称</span>
            <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            <span>备注</span>
            <textarea value={notes} maxLength={2000} rows={3} onChange={(event) => setNotes(event.target.value)} />
          </label>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => { void saveMeta(); }}>
            保存
          </button>
        </div>
      ) : props.session.notes ? (
        <p className="history-session-notes">{props.session.notes}</p>
      ) : null}

      <div className="history-session-stage">
        {loading ? <p>正在读取录像…</p> : null}
        {!loading && !activeSegment ? (
          <p>{isLive ? '正在写入当前切片。已封口的片段会出现在这里。' : '这条会话没有可播放的录像。'}</p>
        ) : null}
        {activeSegment?.playbackUrl ? (
          <video
            ref={videoRef}
            controls={false}
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
        ) : null}
      </div>

      <div className="history-session-transport">
        <button type="button" className="btn btn-secondary btn-sm" disabled={!activeSegment} onClick={togglePlayback}>
          {playing ? '暂停' : '播放'}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={segmentIndex <= 0}
          onClick={() => setSegmentIndex((current) => Math.max(0, current - 1))}
        >
          上一段
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={segmentIndex >= segments.length - 1}
          onClick={() => setSegmentIndex((current) => Math.min(segments.length - 1, current + 1))}
        >
          下一段
        </button>
        <span>
          {segments.length > 0 ? `第 ${segmentIndex + 1} / ${segments.length} 段` : '没有切片'}
          {totalDurationMs > 0 ? ` · ${formatClock(totalDurationMs)}` : ''}
        </span>
      </div>
    </section>
  );
}
