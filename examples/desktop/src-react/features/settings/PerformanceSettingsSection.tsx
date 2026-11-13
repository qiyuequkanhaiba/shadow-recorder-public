import type { ChangeEvent, Dispatch, SetStateAction } from 'react';

import type {
  RecorderConfigPayload,
  RecorderTuningProfile,
} from '../../../types/contracts';
import { DEFAULT_BUFFER_BYTES } from '../../lib/tuning-advisor';
import { t } from '../../lib/i18n';
import type { VideoEncoderSummary } from '../../lib/video-encoder-summary';
import { Badge, Button, Field, SelectField } from '../../ui';
import styles from './SettingsSection.module.css';

export type PerformanceSettingsSectionProps = {
  config: RecorderConfigPayload;
  setConfig: Dispatch<SetStateAction<RecorderConfigPayload>>;
  recommendation: { profile: RecorderTuningProfile; reason: string };
  profileLabels: Record<RecorderTuningProfile, string>;
  autoApplyRecommendedOnStartup: boolean;
  onToggleAutoApply: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  onApplyProfile: (profile: RecorderTuningProfile) => Promise<void>;
  busy: boolean;
  encoderSummary: VideoEncoderSummary;
  error?: string;
};

export function PerformanceSettingsSection(props: PerformanceSettingsSectionProps) {
  return (
    <section className={styles.pane} aria-label="性能与高级">
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <h2 className={styles.headerTitle}>性能与高级</h2>
          <p className={styles.headerDesc}>性能预设与缓冲、传输、编码策略等进阶选项。</p>
        </div>
        <div className={styles.statusBadges}>
          <Badge tone="neutral">编码：{props.encoderSummary.encoderLabel}</Badge>
          <Badge tone="neutral">路径：{props.encoderSummary.pathLabel}</Badge>
        </div>
      </header>

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <h3 className={styles.sectionTitle}>性能预设</h3>
            <p className={styles.sectionDesc}>
              {t('preset.recommendation')}:{' '}
              {props.profileLabels[props.recommendation.profile]} ·{' '}
              {props.recommendation.reason}
            </p>
          </div>
        </div>

        <label className={styles.toggleLabel}>
          <input
            type="checkbox"
            className={styles.toggleInput}
            checked={props.autoApplyRecommendedOnStartup}
            onChange={props.onToggleAutoApply}
          />
          <span className={styles.toggleCopy}>
            <strong className={styles.toggleTitle}>{t('preset.autoApply')}</strong>
          </span>
        </label>

        <div className={styles.actionRow}>
          <Button
            variant="ghost"
            size="sm"
            disabled={props.busy}
            onClick={() => void props.onApplyProfile('stability')}
          >
            {t('preset.apply')} {t('preset.stability')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={props.busy}
            onClick={() => void props.onApplyProfile('latency')}
          >
            {t('preset.apply')} {t('preset.latency')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={props.busy}
            onClick={() => void props.onApplyProfile('size')}
          >
            {t('preset.apply')} {t('preset.size')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={props.busy}
            onClick={() => void props.onApplyProfile(props.recommendation.profile)}
          >
            {t('preset.applyRecommended')}
          </Button>
        </div>

        <p className={styles.hintText}>
          桌面操作较频繁时，优先「流畅」档，防抖建议 60–90ms。
        </p>
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>高级参数</h3>

        <div className={styles.fieldGrid}>
          <Field
            label={t('config.maxBuffer')}
            type="number"
            min={10}
            max={1024}
            unit="MB"
            value={Math.round(
              (props.config.maxBufferBytes ?? DEFAULT_BUFFER_BYTES) / (1024 * 1024),
            )}
            onChange={(event) => {
              const valueMb = Number(event.target.value);
              props.setConfig((current) => ({
                ...current,
                maxBufferBytes: Math.max(10, valueMb) * 1024 * 1024,
              }));
            }}
          />

          <SelectField
            label={t('config.transportMode')}
            value={props.config.transportMode ?? 'poll'}
            onChange={(event) =>
              props.setConfig((current) => ({
                ...current,
                transportMode: event.target
                  .value as RecorderConfigPayload['transportMode'],
              }))
            }
          >
            <option value="poll">{t('config.transport.poll')}</option>
            <option value="push">{t('config.transport.push')}</option>
          </SelectField>

          <SelectField
            label="编码策略"
            hint={`实际：${props.encoderSummary.encoderLabel} · ${props.encoderSummary.pathLabel}`}
            value={props.config.encoderPreference ?? 'auto'}
            onChange={(event) =>
              props.setConfig((current) => ({
                ...current,
                encoderPreference: event.target
                  .value as RecorderConfigPayload['encoderPreference'],
              }))
            }
          >
            <option value="auto">自动优先硬编</option>
            <option value="hardware">优先硬件编码</option>
            <option value="software">仅软件编码</option>
          </SelectField>

          <SelectField
            label={t('config.captureReuse')}
            value={
              (props.config.captureReuseEnabled ?? true) ? 'enabled' : 'disabled'
            }
            onChange={(event) =>
              props.setConfig((current) => ({
                ...current,
                captureReuseEnabled: event.target.value === 'enabled',
              }))
            }
          >
            <option value="enabled">{t('config.reuse.enabled')}</option>
            <option value="disabled">{t('config.reuse.disabled')}</option>
          </SelectField>

          <Field
            label={t('config.webpQuality')}
            type="number"
            min={10}
            max={95}
            value={props.config.webpQuality ?? 75}
            onChange={(event) =>
              props.setConfig((current) => ({
                ...current,
                webpQuality: Number(event.target.value),
              }))
            }
          />

          <Field
            label={t('config.targetImage')}
            type="number"
            min={30}
            max={4096}
            unit="KB"
            value={props.config.adaptiveTargetImageKb ?? 100}
            onChange={(event) =>
              props.setConfig((current) => ({
                ...current,
                adaptiveTargetImageKb: Number(event.target.value),
              }))
            }
          />

          <SelectField
            label="AI Replay Provider"
            hint="默认关闭。OpenAI-compatible 可用于 OpenAI / Ollama / LM Studio。"
            value={props.config.aiReplayProvider ?? 'disabled'}
            onChange={(event) =>
              props.setConfig((current) => ({
                ...current,
                aiReplayProvider: event.target
                  .value as RecorderConfigPayload['aiReplayProvider'],
                aiReplayEnabled:
                  event.target.value === 'openai_compatible'
                    ? current.aiReplayEnabled === true
                    : false,
              }))
            }
          >
            <option value="disabled">Disabled - default</option>
            <option value="mock">Mock - deterministic local</option>
            <option value="openai_compatible">OpenAI-compatible - cloud/local</option>
          </SelectField>

          {props.config.aiReplayProvider === 'openai_compatible' ? (
            <>
              <div className={styles.fieldSpan}>
                <label className={styles.toggleLabel}>
                  <input
                    type="checkbox"
                    className={styles.toggleInput}
                    checked={props.config.aiReplayEnabled === true}
                    onChange={(event) =>
                      props.setConfig((current) => ({
                        ...current,
                        aiReplayEnabled: event.target.checked,
                      }))
                    }
                  />
                  <span className={styles.toggleCopy}>
                    <strong className={styles.toggleTitle}>启用 AI replay 生成</strong>
                  </span>
                </label>
              </div>

              <Field
                label="Base URL"
                placeholder="https://api.openai.com/v1/chat/completions"
                value={props.config.aiReplayOpenAiBaseUrl ?? ''}
                onChange={(event) =>
                  props.setConfig((current) => ({
                    ...current,
                    aiReplayOpenAiBaseUrl: event.target.value,
                  }))
                }
              />

              <Field
                label="Model"
                placeholder="gpt-4o-mini"
                value={props.config.aiReplayOpenAiModel ?? ''}
                onChange={(event) =>
                  props.setConfig((current) => ({
                    ...current,
                    aiReplayOpenAiModel: event.target.value,
                  }))
                }
              />

              <Field
                label="API Key"
                type="password"
                value={props.config.aiReplayOpenAiApiKey ?? ''}
                onChange={(event) =>
                  props.setConfig((current) => ({
                    ...current,
                    aiReplayOpenAiApiKey: event.target.value,
                  }))
                }
              />

              <Field
                label="Timeout (ms)"
                type="number"
                min={1000}
                max={120000}
                unit="ms"
                value={props.config.aiReplayOpenAiTimeoutMs ?? 30000}
                onChange={(event) =>
                  props.setConfig((current) => ({
                    ...current,
                    aiReplayOpenAiTimeoutMs: Number(event.target.value),
                  }))
                }
              />
            </>
          ) : null}
        </div>
      </div>

      {props.error ? <p className={styles.errorBanner}>{props.error}</p> : null}
    </section>
  );
}
