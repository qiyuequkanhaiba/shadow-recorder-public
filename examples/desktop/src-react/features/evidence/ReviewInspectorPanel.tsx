import React, { useState } from 'react';
import {
  KNOWN_OPERATION_OUTCOME_STATUSES,
  type KnownOperationOutcomeStatus,
  type TestSessionOperationRecord,
} from '../../../types/operation-contracts';
import { listManualOutcomeChoices } from '../../lib/operation-adapter';
import { Button } from '../../ui/Button';
import styles from './RecordingReview.module.css';

function toKnownOutcomeStatus(status?: string): KnownOperationOutcomeStatus {
  return (KNOWN_OPERATION_OUTCOME_STATUSES as readonly string[]).includes(status ?? '')
    ? (status as KnownOperationOutcomeStatus)
    : 'incomplete';
}

export type OperationOverridePatch = {
  title?: string;
  resultSummary?: string;
  selectedOutcomeStatus?: KnownOperationOutcomeStatus;
  selectedTransitionId?: string;
  ignored?: boolean;
  businessAlias?: string;
  note?: string;
  reason?: string;
};

export type ReviewInspectorPanelProps = {
  operation: TestSessionOperationRecord | null;
  onSaveStep: (operationId: string, patch: OperationOverridePatch) => Promise<void>;
  busy?: boolean;
};

export function ReviewInspectorPanel({
  operation,
  onSaveStep,
  busy,
}: ReviewInspectorPanelProps) {
  const [activeTab, setActiveTab] = useState<'locators' | 'diff' | 'evidence'>('locators');

  if (!operation) {
    return (
      <section className={styles.sectionCard} aria-label="操作检查器">
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
          请在左侧列表中点击选择一条操作以检视其详细参数、定位器和状态转变。
        </div>
      </section>
    );
  }

  const target = operation.action?.target;
  const coord = operation.action?.coordinate;
  const outcomeChoices = listManualOutcomeChoices(operation);
  const primaryTransitionId = operation.outcome?.primaryTransitionId;
  const currentStatus = operation.outcome?.status;

  return (
    <section className={styles.sectionCard} aria-label="操作检查器">
      <div className={styles.cardHeader}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h4 className={styles.cardTitle}>{operation.title || '步骤检查器'}</h4>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            ID: {operation.operationId}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['locators', 'diff', 'evidence'] as const).map((tab) => {
            const labels = {
              locators: '控件定位',
              diff: '状态转变',
              evidence: '证据快照',
            };
            return (
              <Button
                key={tab}
                variant={activeTab === tab ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => setActiveTab(tab)}
              >
                {labels[tab]}
              </Button>
            );
          })}
        </div>
      </div>

      {activeTab === 'locators' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
          <div>
            <strong>控件名称：</strong>
            <span>{target?.name || '—'}</span>
          </div>
          <div>
            <strong>控件类型：</strong>
            <span>{[target?.controlType, target?.localizedControlType].filter(Boolean).join(' · ') || '—'}</span>
          </div>
          <div>
            <strong>Automation ID：</strong>
            <code style={{ background: 'var(--bg-surface-2)', padding: '2px 4px', borderRadius: 4 }}>
              {target?.automationId || '—'}
            </code>
          </div>
          <div>
            <strong>点击坐标：</strong>
            <span>{coord ? `X: ${coord.x}, Y: ${coord.y}` : '—'}</span>
          </div>
          <div>
            <strong>所属进程/窗口：</strong>
            <span>{[target?.className, target?.processId ? `PID: ${target.processId}` : null].filter(Boolean).join(' · ') || '—'}</span>
          </div>
        </div>
      ) : null}

      {activeTab === 'diff' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
          <div>
            <strong>可观察结果判定：</strong>
            <span>{operation.resultSummary || '未观测到明确结果'}</span>
          </div>
          {operation.outcome?.primaryTransitionId ? (
            <div>
              <strong>主转变事件：</strong>
              <span>{operation.outcome.primaryTransitionId}</span>
            </div>
          ) : null}
          <div style={{ marginTop: 8 }}>
            <strong>人工修正判定：</strong>
            {outcomeChoices.length > 0 ? (
              <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                {outcomeChoices.map((choice) => {
                  const isCurrent = choice.transitionId === primaryTransitionId;
                  return (
                    <Button
                      key={choice.transitionId}
                      variant={isCurrent ? 'primary' : 'secondary'}
                      size="sm"
                      disabled={busy || isCurrent}
                      title={`${choice.label} (${choice.transitionId})`}
                      onClick={() => {
                        void onSaveStep(operation.operationId, {
                          selectedTransitionId: choice.transitionId,
                          selectedOutcomeStatus: choice.status,
                        });
                      }}
                    >
                      {choice.label}
                    </Button>
                  );
                })}
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
              {(
                [
                  { status: 'confirmed', label: '标记为已确认' },
                  { status: 'incomplete', label: '标记为未完成' },
                  { status: 'observerDegraded', label: '标记为观测降级' },
                ] as const
              ).map((item) => (
                <Button
                  key={item.status}
                  variant={currentStatus === item.status ? 'primary' : 'ghost'}
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    void onSaveStep(operation.operationId, {
                      selectedOutcomeStatus: item.status,
                    });
                  }}
                >
                  {item.label}
                </Button>
              ))}
              {operation.outcomeSelectionSource === 'manual' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    void onSaveStep(operation.operationId, {
                      selectedOutcomeStatus: toKnownOutcomeStatus(operation.completionCandidates[0]?.status),
                      selectedTransitionId: operation.completionCandidates[0]?.primaryTransitionId ?? undefined,
                      note: operation.manualNote ?? undefined,
                      reason: 'restore-auto-selection',
                    });
                  }}
                >
                  恢复自动判断
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {activeTab === 'evidence' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
          <div>
            <strong>内容预览：</strong>
            <pre style={{ background: 'var(--bg-surface-2)', padding: 8, borderRadius: 4, overflow: 'auto' }}>
              {operation.action?.contentPreview || '无文本快照'}
            </pre>
          </div>
        </div>
      ) : null}
    </section>
  );
}
