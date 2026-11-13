import React, { useEffect, useMemo, useState } from 'react';
import type { TestSessionState } from '../../../types/contracts';
import { Button } from '../../ui/Button';
import styles from './SessionListRail.module.css';

export type SessionListRailProps = {
  sessions: TestSessionState[];
  selectedSessionId: string | null;
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  selection: string[];
  selectionRevealSeq?: number;
  onSelectionChange: (ids: string[]) => void;
  isSelectionMode: boolean;
  onToggleSelectionMode: (active: boolean) => void;
  onDeleteSelected: () => void;
  busy?: boolean;
  onCopyNotice?: (message: string) => void;
};

function formatSessionDuration(session: TestSessionState): string {
  const start = session.startedAtMs || 0;
  const end = session.endedAtMs || session.updatedAtMs || start;
  const durationSec = Math.max(0, Math.round((end - start) / 1000));
  const mins = Math.floor(durationSec / 60);
  const secs = durationSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatSessionListTime(timestampMs?: number): string {
  if (!timestampMs) return '未知时间';
  const d = new Date(timestampMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatGroupDate(timestampMs: number): string {
  const target = new Date(timestampMs);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const thatDay = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const diffDays = Math.round((today - thatDay) / (24 * 3600 * 1000));
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
}

type SessionDateGroup = {
  label: string;
  sessions: TestSessionState[];
};

function groupSessionsByDate(sessions: TestSessionState[]): SessionDateGroup[] {
  const groups: Map<string, TestSessionState[]> = new Map();
  for (const session of sessions) {
    const time = session.startedAtMs || Date.now();
    const label = formatGroupDate(time);
    const existing = groups.get(label);
    if (existing) {
      existing.push(session);
    } else {
      groups.set(label, [session]);
    }
  }
  return Array.from(groups.entries()).map(([label, groupedSessions]) => ({
    label,
    sessions: groupedSessions,
  }));
}

export function SessionListRail({
  sessions,
  selectedSessionId,
  activeSessionId,
  onSelectSession,
  selection,
  selectionRevealSeq,
  onSelectionChange,
  isSelectionMode,
  onToggleSelectionMode,
  onDeleteSelected,
  busy,
  onCopyNotice,
}: SessionListRailProps) {
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (selectionRevealSeq) {
      setSearchQuery('');
    }
  }, [selectionRevealSeq]);

  const historicalSessions = useMemo(
    () => sessions.filter((s) => s.status !== 'active' && s.status !== 'paused'),
    [sessions],
  );

  const filteredSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((session) => {
      const name = (session.name || '').toLowerCase();
      const id = (session.sessionId || '').toLowerCase();
      const time = formatSessionListTime(session.startedAtMs).toLowerCase();
      return name.includes(q) || id.includes(q) || time.includes(q);
    });
  }, [searchQuery, sessions]);

  const filteredHistoricalSessions = useMemo(
    () => filteredSessions.filter((s) => s.status !== 'active' && s.status !== 'paused'),
    [filteredSessions],
  );

  const visibleHistoricalIds = useMemo(
    () => filteredHistoricalSessions.map((s) => s.sessionId),
    [filteredHistoricalSessions],
  );

  const allVisibleSelected =
    visibleHistoricalIds.length > 0 &&
    visibleHistoricalIds.every((id) => selection.includes(id));

  const dateGroups = useMemo(
    () => groupSessionsByDate(filteredSessions),
    [filteredSessions],
  );

  const handleCopyId = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(sessionId).then(() => {
      onCopyNotice?.(`已复制会话ID: ${sessionId}`);
    });
  };

  return (
    <aside className={styles.rail} data-ui-scope="review" aria-label="录制会话列表">
      <div className={styles.header}>
        <div className={styles.title}>录制会话列表</div>
        <span className={styles.countTag}>
          {sessions.length > 0
            ? searchQuery.trim()
              ? `${filteredSessions.length}/${sessions.length}`
              : `${sessions.length} 个会话`
            : '0'}
        </span>
      </div>

      <div className={styles.searchWrapper}>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="搜索会话名称或ID…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="搜索会话"
        />
        {searchQuery ? (
          <button
            type="button"
            className={styles.searchClear}
            onClick={() => setSearchQuery('')}
            aria-label="清除搜索"
            title="清除搜索"
          >
            ✕
          </button>
        ) : null}
      </div>

      {historicalSessions.length > 0 ? (
        <div className={styles.toolbar}>
          {!isSelectionMode ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onToggleSelectionMode(true)}
            >
              选择模式
            </Button>
          ) : (
            <>
              <label className={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={(e) => {
                    if (e.target.checked) {
                      onSelectionChange(
                        Array.from(new Set([...selection, ...visibleHistoricalIds])),
                      );
                    } else {
                      onSelectionChange(
                        selection.filter((id) => !visibleHistoricalIds.includes(id)),
                      );
                    }
                  }}
                />
                全选
              </label>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  onToggleSelectionMode(false);
                  onSelectionChange([]);
                }}
              >
                退出选择
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={selection.length === 0 || busy}
                onClick={onDeleteSelected}
              >
                删除所选{selection.length > 0 ? ` (${selection.length})` : ''}
              </Button>
            </>
          )}
        </div>
      ) : null}

      <div className={styles.list}>
        {sessions.length === 0 ? (
          <div className={styles.empty}>暂无会话，开始录制后会显示在这里。</div>
        ) : filteredSessions.length === 0 ? (
          <div className={styles.empty}>未匹配到“{searchQuery}”的会话</div>
        ) : (
          dateGroups.map((group) => (
            <div key={group.label} className={styles.group}>
              <div className={styles.groupLabel}>{group.label}</div>
              {group.sessions.map((session) => {
                const currentSelectedId = selectedSessionId ?? activeSessionId;
                const isSelected = session.sessionId === currentSelectedId;
                const isLive = session.status === 'active' || session.status === 'paused';
                const checked = selection.includes(session.sessionId);

                return (
                  <div
                    key={session.sessionId}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelectionMode ? checked : isSelected}
                    data-session-id={session.sessionId}
                    className={`${styles.sessionRow} ${isSelected ? styles.sessionRowSelected : ''}`}
                    onClick={() => onSelectSession(session.sessionId)}
                    onKeyDown={(e) => {
                      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        onSelectSession(session.sessionId);
                      }
                    }}
                  >
                    {isSelectionMode && !isLive ? (
                      <input
                        type="checkbox"
                        className={styles.sessionCheckbox}
                        checked={checked}
                        aria-label={`选择 ${session.name?.trim() || session.sessionId}`}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const nextChecked = e.target.checked;
                          if (nextChecked) {
                            onSelectionChange(
                              selection.includes(session.sessionId)
                                ? selection
                                : [...selection, session.sessionId],
                            );
                          } else {
                            onSelectionChange(
                              selection.filter((id) => id !== session.sessionId),
                            );
                          }
                        }}
                      />
                    ) : null}

                    <div className={styles.sessionContent}>
                      <div className={styles.rowHeadline}>
                        <strong>
                          {session.name?.trim() || `录制会话 #${session.sessionId.slice(0, 6)}`}
                        </strong>
                        {isLive ? (
                          <span className={styles.liveTag}>LIVE</span>
                        ) : (
                          <span>{formatSessionDuration(session)}</span>
                        )}
                      </div>
                      <span className={styles.sessionSub}>
                        {isLive ? '当前录制会话' : formatSessionListTime(session.startedAtMs)}
                      </span>
                    </div>

                    <button
                      type="button"
                      className={styles.copyIdBtn}
                      title={`复制会话ID: ${session.sessionId}`}
                      aria-label={`复制会话ID: ${session.sessionId}`}
                      onClick={(e) => handleCopyId(e, session.sessionId)}
                    >
                      📋
                    </button>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
