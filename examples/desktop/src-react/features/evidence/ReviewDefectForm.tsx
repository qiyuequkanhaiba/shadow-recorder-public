import React from 'react';
import { Button } from '../../ui/Button';
import styles from './RecordingReview.module.css';

export type ReviewDefectFormProps = {
  note: string;
  onNoteChange: (val: string) => void;
  expected: string;
  onExpectedChange: (val: string) => void;
  actual: string;
  onActualChange: (val: string) => void;
  isDefectMarked: boolean;
  preWindowSeconds: number;
  postWindowSeconds: number;
  onMarkDefect: () => Promise<void>;
  onClearDefect: () => Promise<void>;
  onExportPack: () => Promise<void>;
  onBuildRepro: () => void;
  busy?: boolean;
  disabled?: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
};

export function ReviewDefectForm({
  note,
  onNoteChange,
  expected,
  onExpectedChange,
  actual,
  onActualChange,
  isDefectMarked,
  preWindowSeconds,
  postWindowSeconds,
  onMarkDefect,
  onClearDefect,
  onExportPack,
  onBuildRepro,
  busy,
  disabled,
  collapsed,
  onToggleCollapse,
}: ReviewDefectFormProps) {
  return (
    <section className={styles.sectionCard} aria-label="问题标记面板">
      <div className={styles.cardHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h4 className={styles.cardTitle}>标记问题与导出缺陷包</h4>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            时间窗: -{preWindowSeconds}s ~ +{postWindowSeconds}s
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={onToggleCollapse}>
          {collapsed ? '展开表单 ▾' : '收起表单 ▴'}
        </Button>
      </div>

      {!collapsed ? (
        <div className={styles.formGrid}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>
              缺陷现象 / 核心摘要
            </label>
            <input
              className={styles.input}
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              placeholder="例如：点击提交订单按钮后无响应，控制台出现 500 报错..."
              maxLength={200}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>
                预期结果
              </label>
              <textarea
                className={styles.textarea}
                value={expected}
                onChange={(e) => onExpectedChange(e.target.value)}
                placeholder="例如：弹出支付成功页面并跳转订单列表"
                rows={2}
                maxLength={500}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 4 }}>
                实际表现
              </label>
              <textarea
                className={styles.textarea}
                value={actual}
                onChange={(e) => onActualChange(e.target.value)}
                placeholder="例如：按钮保持 loading 状态，页面未响应"
                rows={2}
                maxLength={500}
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || disabled || !note.trim()}
              onClick={() => { void onMarkDefect(); }}
            >
              {isDefectMarked ? '更新标记时间窗' : '标记问题时间窗'}
            </Button>

            {isDefectMarked ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => { void onClearDefect(); }}
              >
                清除标记
              </Button>
            ) : null}

            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={onBuildRepro}
            >
              生成复现步骤
            </Button>

            <Button
              variant="secondary"
              size="sm"
              disabled={busy || disabled}
              onClick={() => { void onExportPack(); }}
            >
              导出缺陷证据包
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
