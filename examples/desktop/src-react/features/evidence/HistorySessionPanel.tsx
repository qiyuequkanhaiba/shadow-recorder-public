import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TestSessionState, TestSessionVideoSegment } from '../../../types/contracts';
import { STUDIO_SEGMENT_LIMIT } from '../../lib/studio-segment-window';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import { useVideoElementController } from '../player/useVideoElementController';
import { HistoryExportMenu } from './HistoryExportMenu';
import { HistoryTransportDock } from './HistoryTransportDock';
import styles from './HistorySessionPanel.module.css';

export type HistorySessionPanelProps = {
  session: TestSessionState | null;
  semanticEnabled?: boolean;
  onOpenSemanticReview?: () => void;
  onError: (message: string) => void;
  onNotice?: (message: string, tone?: 'info' | 'success' | 'warning' | 'error') => void;
  onMetaSaved?: () => void;
};

function formatWhen(timestampMs?: number): string {
  if (!timestampMs) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(timestampMs));
}

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function HistorySessionPanel(props: HistorySessionPanelProps) {
  const [segments, setSegments] = useState<TestSessionVideoSegment[]>([]);
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [segmentRangeStartIndex, setSegmentRangeStartIndex] = useState<number | null>(null);
  const [segmentRangeEndIndex, setSegmentRangeEndIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [operationCount, setOperationCount] = useState<number>(0);

  const sessionId = props.session?.sessionId ?? null;
  const isLive = props.session?.status === 'active' || props.session?.status === 'paused';
  const loadedSegmentIdRef = useRef<string | null>(null);
  const pendingAutoPlayRef = useRef(false);

  const controller = useVideoElementController({
    onEnded: () => {
      const rangeMax =
        segmentRangeEndIndex !== null
          ? Math.max(segmentRangeStartIndex ?? segmentIndex, segmentRangeEndIndex)
          : segments.length - 1;
      if (segmentIndex + 1 <= rangeMax && segmentIndex + 1 < segments.length) {
        pendingAutoPlayRef.current = true;
        setSegmentIndex(segmentIndex + 1);
      }
    },
  });
  const { videoRef, play, reset } = controller;

  useEffect(() => {
    loadedSegmentIdRef.current = null;
    pendingAutoPlayRef.current = false;
    setSegmentRangeStartIndex(null);
    setSegmentRangeEndIndex(null);
    reset();
  }, [reset, sessionId]);

  useEffect(() => {
    if (!props.session) {
      setName('');
      setNotes('');
      setEditing(false);
      return;
    }
    setName(props.session.name ?? '');
    setNotes(props.session.notes ?? '');
    setEditing(false);
  }, [props.session]);

  useEffect(() => {
    const api = window.reqcaseShadowRecorder;
    if (!sessionId || !api.getTestSessionVideoSegments) {
      setSegments([]);
      setSegmentIndex(0);
      setSegmentRangeStartIndex(null);
      setSegmentRangeEndIndex(null);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    void api.getTestSessionVideoSegments({ sessionId, limit: STUDIO_SEGMENT_LIMIT }).then((result) => {
      if (cancelled) return;
      const playable = (Array.isArray(result) ? result : [])
        .filter((segment) => segment.isPlayable && Boolean(segment.playbackUrl))
        .slice()
        .sort((a, b) => a.startedAtMs - b.startedAtMs);
      setSegments(playable);
      setSegmentIndex(0);
      setSegmentRangeStartIndex(null);
      setSegmentRangeEndIndex(null);
    }).catch((error) => {
      if (!cancelled) {
        props.onError(error instanceof Error ? error.message : String(error));
        setSegments([]);
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
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
      if (cancelled) return;
      const total = typeof result?.totalCount === 'number' ? result.totalCount : result?.items?.length ?? 0;
      setOperationCount(total);
    }).catch(() => {
      if (!cancelled) setOperationCount(0);
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
    if (!activeSegment?.playbackUrl) {
      loadedSegmentIdRef.current = null;
      pendingAutoPlayRef.current = false;
      reset();
      if (video) {
        video.removeAttribute('src');
      }
      return;
    }
    if (!video) return;
    if (loadedSegmentIdRef.current !== activeSegment.segmentId) {
      loadedSegmentIdRef.current = activeSegment.segmentId;
      reset();
      video.src = activeSegment.playbackUrl;
    }
    if (pendingAutoPlayRef.current) {
      pendingAutoPlayRef.current = false;
      void play();
    }
  }, [activeSegment?.playbackUrl, activeSegment?.segmentId, play, reset, sessionId, videoRef]);

  const handleCopySessionId = useCallback(() => {
    if (!sessionId) return;
    void navigator.clipboard.writeText(sessionId).then(() => {
      setCopiedId(true);
      props.onNotice?.(`已复制会话ID: ${sessionId}`);
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
      props.onNotice?.('会话信息已保存', 'success');
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function exportSession(options?: { range?: { startMs: number; endMs: number }; clipMode?: 'precise' | 'fast' }): Promise<void> {
    const api = window.reqcaseShadowRecorder;
    if (!props.session || !api.exportTestSessionEvidence) {
      props.onError('当前环境不能导出会话');
      return;
    }
    const baseName = props.session.name?.trim() || props.session.sessionId;
    const bundleName = options?.range ? `${baseName}-clip` : baseName;
    setBusy(true);
    setIsExporting(true);
    try {
      await api.exportTestSessionEvidence({
        sessionId: props.session.sessionId,
        outputMode: 'zip',
        bundleName,
        targetDir: '',
        zipFileName: `${bundleName}.zip`,
        privacyAcknowledgedAt: new Date().toISOString(),
        range: options?.range,
        clipMode: options?.clipMode,
      });
    } catch {
      // Handled by toast
    } finally {
      setBusy(false);
      setIsExporting(false);
    }
  }

  if (!props.session) {
    return (
      <section className={styles.panel} data-ui-scope="review" aria-label="历史记录">
        <div className={styles.emptyCard}>
          <div style={{ fontSize: 40 }} aria-hidden="true">🎬</div>
          <h3>未选择会话</h3>
          <p>请在左侧列表中点击选择一条会话以回放录像、检视切片或导出证据。</p>
        </div>
      </section>
    );
  }

  const durationForDisplay = controller.durationMs || (activeSegment?.durationMs ?? 0);
  const rangeMinIdx = segmentRangeStartIndex !== null && segmentRangeEndIndex !== null
    ? Math.min(segmentRangeStartIndex, segmentRangeEndIndex)
    : segmentIndex;
  const rangeMaxIdx = segmentRangeEndIndex !== null ? Math.max(rangeMinIdx, segmentRangeEndIndex) : segmentIndex;
  const hasMultiple = rangeMinIdx !== rangeMaxIdx && segments.length > 0;
  const startSeg = segments[rangeMinIdx] || activeSegment;
  const endSeg = segments[rangeMaxIdx] || activeSegment;

  return (
    <section className={styles.panel} data-ui-scope="review" aria-label="历史记录">
      <header className={styles.header}>
        <div className={styles.metaLead}>
          <div className={styles.titleLine}>
            <h3 className={styles.heading}>{props.session.name?.trim() || '未命名会话'}</h3>
            <Badge tone={isLive ? 'danger' : 'neutral'}>{isLive ? '🔴 录制中' : '⚪ 已归档'}</Badge>
          </div>
          <div className={styles.metaChips}>
            <span className={styles.metaChip} title="会话开始时间">📅 {formatWhen(props.session.startedAtMs)}</span>
            {totalDurationMs > 0 ? (
              <span className={styles.metaChip} title="总录制时长">⏱️ {formatClock(totalDurationMs)}</span>
            ) : null}
            <span className={styles.metaChip} title="视频切片总数">📑 {segments.length} 个切片</span>
            <button
              type="button"
              className={styles.copyBtn}
              onClick={handleCopySessionId}
              title={`复制会话 ID: ${sessionId}`}
            >
              {copiedId ? '✓ 已复制 ID' : '📋 复制 ID'}
            </button>
          </div>
        </div>

        <div className={styles.actions}>
          <Button variant="secondary" size="sm" disabled={busy || isLive} onClick={() => setEditing((curr) => !curr)}>
            {editing ? '取消编辑' : '✏️ 编辑'}
          </Button>
          {(operationCount > 0 || (props.semanticEnabled && isLive)) && props.onOpenSemanticReview ? (
            <Button variant="secondary" size="sm" onClick={props.onOpenSemanticReview}>
              语义步骤
            </Button>
          ) : null}
          <HistoryExportMenu
            disabled={busy || isLive}
            isExporting={isExporting}
            hasSegment={Boolean(activeSegment)}
            segmentLabel={hasMultiple ? `导出切片 (#${rangeMinIdx + 1}-#${rangeMaxIdx + 1})` : '导出当前切片'}
            onExportAll={() => { void exportSession(); }}
            onExportSegment={() => {
              if (!startSeg || !endSeg) return;
              void exportSession({
                range: { startMs: startSeg.startedAtMs, endMs: endSeg.endedAtMs },
                clipMode: 'precise',
              });
            }}
          />
        </div>
      </header>

      {editing ? (
        <div className={styles.formCard}>
          <div>
            <label htmlFor="history-name-input">会话名称</label>
            <input
              id="history-name-input"
              value={name}
              maxLength={80}
              placeholder="输入简明易记的测试会话名称..."
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="history-notes-input">会话备注 / 缺陷说明</label>
            <textarea
              id="history-notes-input"
              value={notes}
              maxLength={2000}
              rows={3}
              placeholder="记录测试用例编号、前置条件或缺陷概要..."
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => { void saveMeta(); }}>保存修改</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(false)}>取消</Button>
          </div>
        </div>
      ) : null}

      {/* 3. Primary Video Playback Stage */}
      <div className={styles.stage}>
        {loading ? (
          <div className={styles.stageMessage}>
            <span className={styles.stageMessageIcon} aria-hidden="true">⌛</span>
            <p>正在读取录像切片…</p>
          </div>
        ) : null}

        {controller.hasError ? (
          <div className={styles.stageMessage}>
            <span className={styles.stageMessageIcon} aria-hidden="true">⚠️</span>
            <p>{controller.errorMessage || '当前录像加载失败'}</p>
          </div>
        ) : null}

        {!loading && !activeSegment && !controller.hasError ? (
          <div className={styles.stageMessage}>
            <span className={styles.stageMessageIcon} aria-hidden="true">🎬</span>
            <p>{isLive ? '正在写入当前切片，已封口的片段将在此就绪。' : '当前会话没有可播放的视频切片。'}</p>
          </div>
        ) : null}

        {activeSegment?.playbackUrl ? (
          <div
            className={styles.videoContainer}
            onClick={controller.togglePlay}
            style={{ display: controller.hasError ? 'none' : undefined }}
          >
            <video
              ref={controller.videoRef}
              className={styles.videoElement}
              controls={false}
              onError={controller.handleError}
              onLoadedMetadata={controller.handleLoadedMetadata}
              onTimeUpdate={controller.handleTimeUpdate}
              onPlay={controller.handlePlay}
              onPause={controller.handlePause}
              onEnded={controller.handleEnded}
            />
            {!controller.isPlaying ? (
              <div className={styles.centerOverlay} aria-hidden="true">
                ▶
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 4. Integrated Video Transport Controls */}
      <HistoryTransportDock
        controller={controller}
        hasActiveSegment={Boolean(activeSegment)}
        segmentIndex={segmentIndex}
        totalSegments={segments.length}
        durationMs={durationForDisplay}
        onPrevSegment={() => {
          if (segmentIndex <= 0) return;
          setSegmentRangeStartIndex(null);
          setSegmentRangeEndIndex(null);
          pendingAutoPlayRef.current =
            controller.isPlaying || Boolean(videoRef.current && !videoRef.current.paused);
          setSegmentIndex((current) => Math.max(0, current - 1));
        }}
        onNextSegment={() => {
          if (segmentIndex >= segments.length - 1) return;
          setSegmentRangeStartIndex(null);
          setSegmentRangeEndIndex(null);
          pendingAutoPlayRef.current =
            controller.isPlaying || Boolean(videoRef.current && !videoRef.current.paused);
          setSegmentIndex((current) => Math.min(segments.length - 1, current + 1));
        }}
      />

      {/* 5. Segment Selection Strip */}
      {segments.length > 1 ? (
        <div className={styles.segmentStrip} aria-label="切片导航">
          {segments.map((seg, idx) => {
            const isCurrent = idx === segmentIndex;
            const isInRange = hasMultiple && idx >= rangeMinIdx && idx <= rangeMaxIdx;
            return (
              <button
                key={seg.segmentId}
                type="button"
                className={`${styles.segmentChip} ${isCurrent || isInRange ? styles.segmentChipActive : ''}`}
                onClick={(e) => {
                  if (e.shiftKey) {
                    const anchorIdx = segmentRangeStartIndex ?? segmentIndex;
                    const minIdx = Math.min(anchorIdx, idx);
                    const maxIdx = Math.max(anchorIdx, idx);
                    setSegmentIndex(minIdx);
                    setSegmentRangeStartIndex(minIdx === maxIdx ? null : minIdx);
                    setSegmentRangeEndIndex(minIdx === maxIdx ? null : maxIdx);
                    if (minIdx !== maxIdx) {
                      props.onNotice?.(`已选取切片 #${minIdx + 1} 至 #${maxIdx + 1}`);
                    }
                  } else {
                    setSegmentRangeStartIndex(null);
                    setSegmentRangeEndIndex(null);
                    if (idx === segmentIndex) {
                      void play();
                    } else {
                      pendingAutoPlayRef.current = true;
                      setSegmentIndex(idx);
                    }
                  }
                }}
                title={`切片 #${idx + 1} (${formatClock(seg.durationMs || 0)}) · 按住 Shift 连续多选`}
              >
                <span>#{idx + 1}</span>
                <span>{formatClock(seg.durationMs || 0)}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
