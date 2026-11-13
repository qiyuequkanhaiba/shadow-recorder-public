import clsx from 'clsx';

import styles from '../features/player/Drawer.module.css';
import type { TestSessionTimelineEvent } from '../../types/contracts';
import type { TestSessionOperationRecord } from '../../types/operation-contracts';
import type { SemanticStepRow } from './StudioDrawer';

const toneClass = {
  success: styles.toneSuccess,
  warning: styles.toneWarning,
  danger: styles.toneDanger,
  muted: styles.toneMuted,
  info: styles.toneInfo,
};

export type StudioDrawerStepsTabProps = {
  semanticSteps: SemanticStepRow[];
  operations: TestSessionOperationRecord[];
  timelineEvents: TestSessionTimelineEvent[];
  copiedKey: string | null;
  onCopyText: (key: string, label: string, text?: string | null) => void;
  formatDateTime: (timestampMs?: number) => string;
  isUserOperationEvent: (event: TestSessionTimelineEvent) => boolean;
  getActionKindMeta: (kind?: string) => { icon: string; label: string };
  getOutcomeChip: (status?: string) => { tone: string; label: string } | null;
  getPrecisionBadge: (level?: string) => string | null;
};

export function StudioDrawerStepsTab({
  semanticSteps,
  operations,
  timelineEvents,
  copiedKey,
  onCopyText,
  formatDateTime,
  isUserOperationEvent,
  getActionKindMeta,
  getOutcomeChip,
  getPrecisionBadge,
}: StudioDrawerStepsTabProps) {
  const userEvents = timelineEvents.filter(isUserOperationEvent);

  if (semanticSteps.length > 0) {
    return (
      <div className={styles.tabContent}>
        <div className={styles.stepsList}>
          {semanticSteps.map((step, idx) => {
            const matchingOp = operations.find((op) => {
              if (op.operationId === step.stepId) return true;
              const sIds = op.action?.sourceEventIds;
              return Array.isArray(sIds) && Array.isArray(step.sourceEventIds)
                && sIds.some((id) => step.sourceEventIds?.includes(id));
            });
            const actionMeta = getActionKindMeta(matchingOp?.action?.kind || step.stepType);
            const outcome = matchingOp?.outcome?.status ? getOutcomeChip(matchingOp.outcome.status) : null;
            const precision = getPrecisionBadge(step.precisionLevel || matchingOp?.precisionLevel);
            const copyKey = `step_${step.stepId || idx}`;

            return (
              <div key={step.stepId || idx} className={styles.stepItem}>
                <span className={styles.stepIdx}>{idx + 1}</span>
                <div className={styles.stepCopy}>
                  <div className={styles.stepTopLine}>
                    <span className={styles.stepTag}>
                      {actionMeta.icon} {actionMeta.label}
                    </span>
                    {outcome ? (
                      <span className={clsx(styles.stepOutcome, toneClass[outcome.tone as keyof typeof toneClass])}>
                        {outcome.label}
                      </span>
                    ) : null}
                    {precision ? (
                      <span className={styles.stepPrecision}>
                        {precision}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className={styles.stepCopyBtn}
                      onClick={() => onCopyText(
                        copyKey,
                        `步骤 ${idx + 1}`,
                        `${step.title}${step.windowTitle ? ` (${step.windowTitle})` : ''}`,
                      )}
                      title="复制步骤描述"
                    >
                      {copiedKey === copyKey ? '✓' : '📋'}
                    </button>
                  </div>
                  <strong className={styles.stepTitle}>{step.title}</strong>
                  {step.summary && step.summary !== step.title ? (
                    <span className={styles.stepSummary}>{step.summary}</span>
                  ) : null}
                  <div className={styles.stepFooter}>
                    <small className={styles.stepTime}>{formatDateTime(step.startedAtMs)}</small>
                    {step.windowTitle ? (
                      <small className={styles.stepHint} title={step.windowTitle}>
                        {step.windowTitle}
                      </small>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (userEvents.length > 0) {
    return (
      <div className={styles.tabContent}>
        <div className={styles.stepsList}>
          {userEvents.map((event, idx) => {
            const actionMeta = getActionKindMeta(event.action || event.eventType);
            const copyKey = `ev_${event.eventId || idx}`;
            return (
              <div key={event.eventId || idx} className={styles.stepItem}>
                <span className={styles.stepIdx}>{idx + 1}</span>
                <div className={styles.stepCopy}>
                  <div className={styles.stepTopLine}>
                    <span className={styles.stepTag}>
                      {actionMeta.icon} {actionMeta.label}
                    </span>
                    <button
                      type="button"
                      className={styles.stepCopyBtn}
                      onClick={() => onCopyText(
                        copyKey,
                        `步骤 ${idx + 1}`,
                        event.action || event.title || event.message || '用户操作',
                      )}
                      title="复制步骤描述"
                    >
                      {copiedKey === copyKey ? '✓' : '📋'}
                    </button>
                  </div>
                  <strong className={styles.stepTitle}>
                    {event.action || event.title || '用户操作'}
                  </strong>
                  <div className={styles.stepFooter}>
                    <small className={styles.stepTime}>{formatDateTime(event.occurredAtMs)}</small>
                    {event.windowTitle ? (
                      <small className={styles.stepHint} title={event.windowTitle}>
                        {event.windowTitle}
                      </small>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.tabContent}>
      <div className={styles.emptyState}>
        当前会话暂无步骤记录
      </div>
    </div>
  );
}
