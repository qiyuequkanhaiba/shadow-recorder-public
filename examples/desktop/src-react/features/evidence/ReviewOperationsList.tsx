import React from 'react';
import type { TestSessionOperationRecord } from '../../../types/operation-contracts';
import {
  formatActionKindLabel,
  formatRelativeOperationTime,
  operationStatusPresentation,
} from '../../lib/operation-adapter';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import styles from './RecordingReview.module.css';

export type ReviewOperationsListProps = {
  operations: TestSessionOperationRecord[];
  sessionStartedAtMs?: number;
  selectedOperationId: string | null;
  onSelectOperation: (op: TestSessionOperationRecord) => void;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  filterKind: 'all' | 'issue' | 'click' | 'input';
  onFilterKindChange: (kind: 'all' | 'issue' | 'click' | 'input') => void;
  onRefresh: () => void;
  onRebuild: () => void;
  loading?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
};

export function ReviewOperationsList({
  operations,
  sessionStartedAtMs,
  selectedOperationId,
  onSelectOperation,
  searchQuery,
  onSearchQueryChange,
  filterKind,
  onFilterKindChange,
  onRefresh,
  onRebuild,
  loading,
  hasMore,
  onLoadMore,
}: ReviewOperationsListProps) {
  return (
    <section className={styles.sectionCard} aria-label="操作步骤列表">
      <div className={styles.cardHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
          <input
            className={styles.input}
            style={{ maxWidth: 220 }}
            placeholder="搜索操作、控件或结果…"
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 4 }}>
            {(['all', 'issue', 'click', 'input'] as const).map((kind) => {
              const labels = {
                all: '全部',
                issue: '异常/待查',
                click: '点击',
                input: '输入',
              };
              return (
                <Button
                  key={kind}
                  variant={filterKind === kind ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => onFilterKindChange(kind)}
                >
                  {labels[kind]}
                </Button>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4 }}>
          <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading} title="刷新操作列表">
            刷新
          </Button>
          <Button variant="ghost" size="sm" onClick={onRebuild} disabled={loading} title="重新推导语义操作">
            重建语义
          </Button>
        </div>
      </div>

      <div className={styles.operationsList}>
        {operations.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            暂无匹配的操作步骤
          </div>
        ) : (
          operations.map((op, idx) => {
            const isSelected = op.operationId === selectedOperationId;
            const statusConfig = operationStatusPresentation(op.outcome?.status);
            const actionKind = formatActionKindLabel(op.action?.kind);
            const relativeMs =
              typeof op.relativeMsFromSessionStart === 'number' && op.relativeMsFromSessionStart > 0
                ? op.relativeMsFromSessionStart
                : sessionStartedAtMs !== undefined
                  ? Math.max(0, op.startedAtMs - sessionStartedAtMs)
                  : 0;
            const timeLabel = formatRelativeOperationTime(relativeMs);

            return (
              <div
                key={op.operationId || idx}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                data-operation-id={op.operationId}
                className={`${styles.operationRow} ${isSelected ? styles.operationRowSelected : ''}`}
                onClick={() => onSelectOperation(op)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectOperation(op);
                  }
                }}
              >
                <Badge tone={statusConfig.tone as any}>
                  {statusConfig.shortLabel}
                </Badge>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {actionKind}
                </span>
                <div className={styles.operationHeadline}>
                  <div className={styles.operationTitle}>
                    {op.title || op.businessAlias || '未命名操作'}
                  </div>
                  {op.resultSummary ? (
                    <div className={styles.operationMeta}>
                      ↳ {op.resultSummary}
                    </div>
                  ) : null}
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {timeLabel}
                </span>
              </div>
            );
          })
        )}
      </div>

      {hasMore && onLoadMore ? (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}>
          <Button variant="ghost" size="sm" onClick={onLoadMore} disabled={loading}>
            {loading ? '正在加载更多…' : '加载更多步骤 ▾'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
