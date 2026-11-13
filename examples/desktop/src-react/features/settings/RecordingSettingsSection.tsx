import type { Dispatch, SetStateAction } from 'react';

import type { RecorderConfigPayload } from '../../../types/contracts';
import {
  deriveInternalMaxSteps,
  resolveRecordingWindowSeconds,
  resolveSegmentDurationSeconds,
} from '../../../types/recording-defaults';
import {
  MIN_FREE_BYTES_TO_START,
  MIN_FREE_BYTES_WHILE_RECORDING,
  bytesToGiB,
  giBToBytes,
} from '../../../src-electron/modules/reqcase-shadow-recorder/disk-space';
import { t } from '../../lib/i18n';
import type { VideoEncoderSummary } from '../../lib/video-encoder-summary';
import { Badge, Field, SelectField } from '../../ui';
import styles from './SettingsSection.module.css';

export type RecordingSettingsSectionProps = {
  config: RecorderConfigPayload;
  setConfig: Dispatch<SetStateAction<RecorderConfigPayload>>;
  encoderSummary: VideoEncoderSummary;
  error?: string;
};

export function RecordingSettingsSection(props: RecordingSettingsSectionProps) {
  return (
    <section className={styles.pane} aria-label="录制参数">
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <h2 className={styles.headerTitle}>录制参数</h2>
          <p className={styles.headerDesc}>循环窗口、分段时长、画质档位与防抖等基础参数。</p>
        </div>
        <div className={styles.statusBadges}>
          <Badge tone="neutral" title={props.encoderSummary.detailLabel}>
            编码：{props.encoderSummary.encoderLabel}
          </Badge>
          <Badge tone="neutral">
            路径：{props.encoderSummary.pathLabel}
            {props.encoderSummary.isHardwareActive === true
              ? ' · 硬编'
              : props.encoderSummary.isHardwareActive === false
                ? ' · 软编'
                : ''}
          </Badge>
          <Badge tone="neutral">流：{props.encoderSummary.streamLabel}</Badge>
        </div>
      </header>

      <div className={styles.section}>
        <div className={styles.fieldGrid}>
          <Field
            label={t('config.recordingWindowSeconds')}
            type="number"
            min={30}
            max={3600}
            unit="秒"
            value={resolveRecordingWindowSeconds(props.config.recordingWindowSeconds)}
            onChange={(event) => {
              const recordingWindowSeconds = resolveRecordingWindowSeconds(
                Number(event.target.value),
              );
              props.setConfig((current) => ({
                ...current,
                recordingWindowSeconds,
                segmentDurationSeconds: resolveSegmentDurationSeconds(
                  current.segmentDurationSeconds,
                  recordingWindowSeconds,
                ),
                maxSteps: deriveInternalMaxSteps(recordingWindowSeconds),
              }));
            }}
          />

          <SelectField
            label="保留策略"
            value={props.config.historyRetentionMode ?? 'count'}
            onChange={(e) => {
              props.setConfig((current) => ({
                ...current,
                historyRetentionMode: e.target.value as 'age' | 'count',
              }));
            }}
          >
            <option value="count">按段数保留</option>
            <option value="age">按时间保留</option>
          </SelectField>

          <Field
            label="保留数值"
            type="number"
            min={props.config.historyRetentionMode === 'age' ? 1 : 10}
            max={props.config.historyRetentionMode === 'age' ? 168 : 2000}
            unit={props.config.historyRetentionMode === 'age' ? '小时' : '段'}
            value={
              props.config.historyRetentionMode === 'age'
                ? (props.config.historyRetentionHours ?? 24)
                : (props.config.historyRetentionMaxSegments ?? 200)
            }
            onChange={(e) => {
              const raw = Number(e.target.value);
              props.setConfig((current) => {
                if (current.historyRetentionMode === 'age') {
                  const historyRetentionHours = Number.isFinite(raw)
                    ? Math.max(1, Math.min(168, Math.trunc(raw)))
                    : 24;
                  return { ...current, historyRetentionHours };
                }
                const historyRetentionMaxSegments = Number.isFinite(raw)
                  ? Math.max(10, Math.min(2000, Math.trunc(raw)))
                  : 200;
                return { ...current, historyRetentionMaxSegments };
              });
            }}
          />

          <Field
            label={t('config.segmentDurationSeconds')}
            type="number"
            min={2}
            max={60}
            unit="秒"
            value={resolveSegmentDurationSeconds(
              props.config.segmentDurationSeconds,
              props.config.recordingWindowSeconds,
            )}
            onChange={(event) =>
              props.setConfig((current) => ({
                ...current,
                segmentDurationSeconds: resolveSegmentDurationSeconds(
                  Number(event.target.value),
                  current.recordingWindowSeconds,
                ),
              }))
            }
          />

          <Field
            label={t('config.minFreeGiBToStart')}
            type="number"
            min={0}
            step={0.1}
            unit="GiB"
            value={bytesToGiB(props.config.minFreeBytesToStart ?? MIN_FREE_BYTES_TO_START)}
            onChange={(event) => {
              const gib = Number(event.target.value);
              props.setConfig((current) => ({
                ...current,
                minFreeBytesToStart: giBToBytes(gib, MIN_FREE_BYTES_TO_START),
              }));
            }}
          />

          <Field
            label={t('config.minFreeGiBWhileRecording')}
            type="number"
            min={0}
            step={0.1}
            unit="GiB"
            value={bytesToGiB(
              props.config.minFreeBytesWhileRecording ?? MIN_FREE_BYTES_WHILE_RECORDING,
            )}
            onChange={(event) => {
              const gib = Number(event.target.value);
              props.setConfig((current) => ({
                ...current,
                minFreeBytesWhileRecording: giBToBytes(gib, MIN_FREE_BYTES_WHILE_RECORDING),
              }));
            }}
          />

          <SelectField
            label="录制档位"
            value={props.config.recordingProfile ?? 'balanced'}
            onChange={(event) =>
              props.setConfig((current) => ({
                ...current,
                recordingProfile: event.target
                  .value as RecorderConfigPayload['recordingProfile'],
              }))
            }
          >
            <option value="efficiency">省资源 · 7 FPS</option>
            <option value="balanced">标准 · 14 FPS</option>
            <option value="smooth">流畅 · 20 FPS</option>
          </SelectField>

          <SelectField
            label={t('config.showMouseInVideo')}
            hint="关闭可避免连续录屏时鼠标图标闪动。"
            value={(props.config.showMouseInVideo ?? false) ? 'enabled' : 'disabled'}
            onChange={(event) =>
              props.setConfig((current) => ({
                ...current,
                showMouseInVideo: event.target.value === 'enabled',
              }))
            }
          >
            <option value="disabled">关闭</option>
            <option value="enabled">开启</option>
          </SelectField>

          <Field
            label={t('config.debounce')}
            type="number"
            min={20}
            max={2000}
            unit="ms"
            value={props.config.debounceMs ?? 90}
            onChange={(event) =>
              props.setConfig((current) => ({
                ...current,
                debounceMs: Number(event.target.value),
              }))
            }
          />
        </div>
      </div>

      {props.error ? <p className={styles.errorBanner}>{props.error}</p> : null}
    </section>
  );
}
