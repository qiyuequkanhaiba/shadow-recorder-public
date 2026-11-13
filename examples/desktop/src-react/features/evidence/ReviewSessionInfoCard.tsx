import React, { useState } from 'react';
import type { TestSessionState } from '../../../types/contracts';
import type { TestSessionOperationTailResult } from '../../../types/operation-contracts';
import type { OperationReviewStatus } from '../../lib/operation-adapter';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import styles from './RecordingReview.module.css';

export type ReviewSessionInfoCardProps = {
  session: TestSessionState | null;
  enabled?: boolean;
  totalOperations: number;
  visibleOperations: number;
  layoutMode: 'split' | 'inline';
  onLayoutModeChange: (mode: 'split' | 'inline') => void;
  defectLocked: boolean;
  defectPreWindow?: number;
  defectPostWindow?: number;
  defectStepCount?: number;
  onClearDefectWindow?: () => void;
  onOpenMarker?: () => void;
  onOpenSettings?: () => void;
  onSaveMeta: (name: string, notes: string) => Promise<void>;
  busy?: boolean;
  reviewStatus?: OperationReviewStatus;
  statusBanner?: string;
  diagnostics?: TestSessionOperationTailResult['diagnostics'];
};

export function ReviewSessionInfoCard({
  session,
  enabled,
  totalOperations,
  visibleOperations,
  layoutMode,
  onLayoutModeChange,
  defectLocked,
  defectPreWindow,
  defectPostWindow,
  defectStepCount,
  onClearDefectWindow,
  onOpenMarker,
  onOpenSettings,
  onSaveMeta,
  busy,
  reviewStatus,
  statusBanner,
  diagnostics,
}: ReviewSessionInfoCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(session?.name || '');
  const [notes, setNotes] = useState(session?.notes || '');

  const handleSave = async () => {
    await onSaveMeta(name, notes);
    setIsEditing(false);
  };

  return (
    <>
      <header className={styles.header}>
        <div className={styles.titleCol}>
          <div className={styles.titleRow}>
            <span className={styles.kicker}>录屏工具</span>
            <h3>记录与回顾</h3>
            <div style={{ display: 'flex', gap: 4 }}>
              <Button
                variant={layoutMode === 'split' ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => onLayoutModeChange('split')}
                title="分栏检查器模式（右侧独立 Inspector）"
              >
                分栏检查器
              </Button>
              <Button
                variant={layoutMode === 'inline' ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => onLayoutModeChange('inline')}
                title="流式内联折叠模式"
              >
                流式内联
              </Button>
            </div>
          </div>
          <p className={styles.subdesc}>
            按发生时序聚合操作主句与可观察结果；点击右侧检查器深度查看控件定位与状态变动。
          </p>
        </div>

        <div className={styles.summaryGroup} aria-label="记录概览">
          <div className={styles.summaryItem}>
            <strong>{visibleOperations} / {totalOperations}</strong>
            <small>当前操作</small>
          </div>
          <div className={styles.summaryItem}>
            <strong>{defectLocked ? '已标记时间窗' : '未标记'}</strong>
            <small>问题状态</small>
          </div>
          <div className={styles.summaryItem}>
            <Badge tone={enabled ? 'success' : 'neutral'}>
              {enabled ? '已开启' : '未开启'}
            </Badge>
            <small>语义记录</small>
          </div>
        </div>
      </header>

      {/* Session Metadata Card */}
      <div className={styles.metaCard}>
        <div className={styles.metaDisplayRow}>
          <div className={styles.metaNameLine}>
            <strong>{session?.name || '当前录制会话'}</strong>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setName(session?.name || '');
                setNotes(session?.notes || '');
                setIsEditing(!isEditing);
              }}
            >
              {isEditing ? '取消' : '✏️ 编辑'}
            </Button>
          </div>
        </div>
        <p className={styles.metaNotes}>
          {session?.notes ? `备注：${session.notes}` : '暂无会话备注'}
        </p>

        {isEditing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            <input
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="输入简明易记的会话名称..."
              maxLength={80}
            />
            <textarea
              className={styles.textarea}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="记录测试用例编号、前置条件或缺陷概要..."
              maxLength={2000}
              rows={2}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => { void handleSave(); }}>
                保存信息
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setIsEditing(false)}>
                取消
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Semantic Disabled Banner */}
      {!enabled ? (
        <div className={`${styles.banner} ${styles.bannerWarning}`} role="status">
          <span>语义记录未开启。开启后会补充控件识别、操作结果关联和语义步骤。</span>
          {onOpenSettings ? (
            <Button variant="secondary" size="sm" onClick={onOpenSettings}>
              打开设置
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Diagnostics & Status Banner */}
      {statusBanner ? (
        <div
          className={`${styles.banner} ${
            reviewStatus === 'corrupt' || reviewStatus === 'unavailable'
              ? styles.bannerDanger
              : reviewStatus === 'partial' || reviewStatus === 'futureSchema'
                ? styles.bannerWarning
                : styles.bannerInfo
          }`}
          role="status"
        >
          <span>{statusBanner}</span>
          {diagnostics && diagnostics.length > 0 ? (
            <span>{diagnostics.map((item) => item.code).join(' · ')}</span>
          ) : null}
        </div>
      ) : null}

      {/* Defect Window Scope Banner */}
      {defectLocked ? (
        <div className={`${styles.banner} ${styles.bannerInfo}`} role="status">
          <span>
            已锁定问题时间窗：发生点前 {defectPreWindow}s / 后 {defectPostWindow}s · 关联窗内操作 {defectStepCount} 条
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            {onOpenMarker ? (
              <Button variant="ghost" size="sm" onClick={onOpenMarker}>
                修改标记参数
              </Button>
            ) : null}
            {onClearDefectWindow ? (
              <Button variant="ghost" size="sm" onClick={onClearDefectWindow}>
                清除时间窗筛选
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
