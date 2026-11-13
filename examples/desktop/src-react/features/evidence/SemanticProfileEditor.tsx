import { useMemo, useState, type ChangeEvent } from 'react';

import { Button, Field } from '../../ui';
import styles from '../settings/SettingsSection.module.css';

export type EditableAliasRule = {
  ruleId?: string | null;
  alias?: string | null;
  automationId?: string | null;
  matchAutomationId?: string | null;
  controlName?: string | null;
  matchControlName?: string | null;
  controlType?: string | null;
  actionType?: string | null;
  moduleName?: string | null;
  priority?: number;
  description?: string | null;
  source?: string | null;
};

export type EditableSemanticProfile = {
  schemaVersion?: number;
  profileId?: string;
  name?: string;
  description?: string | null;
  targetProcessName?: string | null;
  enabled?: boolean;
  priority?: number;
  source?: string | null;
  aliasRules?: EditableAliasRule[];
  scenarioRules?: unknown[];
  [key: string]: unknown;
};

type SemanticProfileEditorProps = {
  profile: EditableSemanticProfile;
  disabled?: boolean;
  busy?: boolean;
  onChange: (next: EditableSemanticProfile) => void;
  onSave: () => void;
  onCancel?: () => void;
};

function asText(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function ruleKey(rule: EditableAliasRule, index: number): string {
  return rule.ruleId || `alias-${index + 1}`;
}

export function SemanticProfileEditor(props: SemanticProfileEditorProps) {
  const { profile, disabled, busy, onChange, onSave } = props;
  const [filter, setFilter] = useState('');
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const rules = profile.aliasRules ?? [];
  const locked = Boolean(disabled || busy);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rules.map((rule, index) => ({ rule, index }));
    return rules
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => {
        const hay = [
          rule.alias,
          rule.automationId,
          rule.matchAutomationId,
          rule.controlName,
          rule.moduleName,
          rule.controlType,
          rule.actionType,
          rule.ruleId,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      });
  }, [filter, rules]);

  const selected = useMemo(() => {
    if (!selectedRuleId) return null;
    const index = rules.findIndex((rule, i) => ruleKey(rule, i) === selectedRuleId);
    if (index < 0) return null;
    return { rule: rules[index], index };
  }, [rules, selectedRuleId]);

  function patchMeta<K extends keyof EditableSemanticProfile>(
    key: K,
    value: EditableSemanticProfile[K],
  ) {
    onChange({ ...profile, [key]: value });
  }

  function patchRule(index: number, patch: Partial<EditableAliasRule>) {
    const nextRules = rules.map((rule, i) => {
      if (i !== index) return rule;
      const next = { ...rule, ...patch };
      if ('automationId' in patch) {
        next.matchAutomationId = patch.automationId ?? null;
      }
      if ('controlName' in patch) {
        next.matchControlName = patch.controlName ?? null;
      }
      return next;
    });
    onChange({ ...profile, aliasRules: nextRules });
  }

  function removeRule(index: number) {
    const nextRules = rules.filter((_, i) => i !== index);
    onChange({ ...profile, aliasRules: nextRules });
    setSelectedRuleId(null);
  }

  function addRule() {
    const ruleId = `alias-${Date.now().toString(36)}`;
    const next: EditableAliasRule = {
      ruleId,
      alias: '新别名',
      automationId: '',
      matchAutomationId: '',
      controlType: 'Button',
      actionType: 'CLICK',
      priority: 10,
      source: 'manual',
    };
    onChange({ ...profile, aliasRules: [...rules, next] });
    setSelectedRuleId(ruleId);
  }

  return (
    <div className={styles.editorContainer} aria-label="语义画像编辑">
      <div className={styles.fieldGrid}>
        <Field
          label="画像名称"
          disabled={locked}
          value={asText(profile.name)}
          onChange={(e: ChangeEvent<HTMLInputElement>) => patchMeta('name', e.target.value)}
        />
        <Field
          label="画像 ID"
          disabled={locked}
          value={asText(profile.profileId)}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            patchMeta('profileId', e.target.value)
          }
        />
        <Field
          label="目标进程"
          disabled={locked}
          placeholder="例如 QtApp.exe / notepad.exe"
          value={asText(profile.targetProcessName)}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            patchMeta('targetProcessName', e.target.value || null)
          }
        />
        <Field
          label="优先级"
          type="number"
          disabled={locked}
          value={Number(profile.priority ?? 0)}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            patchMeta('priority', Number(e.target.value) || 0)
          }
        />
        <div className={styles.fieldSpan}>
          <Field
            label="描述"
            disabled={locked}
            value={asText(profile.description)}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              patchMeta('description', e.target.value || null)
            }
          />
        </div>
      </div>

      <div className={styles.editorToolbar}>
        <div className={styles.editorToolbarTitle}>
          别名规则
          <span className={styles.hintText}> · 共 {rules.length} 条</span>
          {filter.trim() ? (
            <span className={styles.hintText}>（筛选后 {filtered.length} 条）</span>
          ) : null}
        </div>
        <input
          className={styles.editorSearch}
          type="search"
          placeholder="筛选别名、AutomationId、模块…"
          value={filter}
          disabled={locked}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="筛选别名规则"
        />
        <Button variant="ghost" size="sm" disabled={locked} onClick={addRule}>
          新增规则
        </Button>
      </div>

      <div className={styles.editorWorkbench}>
        <div className={styles.ruleList} role="listbox" aria-label="别名规则列表">
          {filtered.length === 0 ? (
            <p className={styles.hintText}>
              {rules.length === 0
                ? '暂无别名规则，可点击「新增规则」。'
                : '无匹配规则，请调整筛选条件。'}
            </p>
          ) : (
            filtered.map(({ rule, index }) => {
              const id = ruleKey(rule, index);
              const selectedRow = selectedRuleId === id;
              const autoId =
                rule.automationId || rule.matchAutomationId || rule.controlName || '—';
              return (
                <button
                  key={id}
                  type="button"
                  role="option"
                  aria-selected={selectedRow}
                  className={`${styles.ruleRow}${selectedRow ? ` ${styles.ruleRowSelected}` : ''}`}
                  disabled={locked}
                  onClick={() => setSelectedRuleId(id)}
                >
                  <span className={styles.ruleIndex}>{index + 1}</span>
                  <span className={styles.ruleMain}>
                    <span className={styles.ruleAlias}>{rule.alias || '(无别名)'}</span>
                    <span className={styles.ruleId}>{autoId}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className={styles.ruleDetail} aria-label="规则详情">
          {selected ? (
            <>
              <h4 className={styles.sectionTitle}>编辑选中规则</h4>
              <div className={styles.fieldGrid}>
                <div className={styles.fieldSpan}>
                  <Field
                    label="业务别名"
                    disabled={locked}
                    value={asText(selected.rule.alias)}
                    onChange={(e) =>
                      patchRule(selected.index, { alias: e.target.value })
                    }
                  />
                </div>
                <div className={styles.fieldSpan}>
                  <Field
                    label="AutomationId"
                    disabled={locked}
                    value={asText(
                      selected.rule.automationId || selected.rule.matchAutomationId,
                    )}
                    onChange={(e) =>
                      patchRule(selected.index, {
                        automationId: e.target.value,
                        matchAutomationId: e.target.value,
                      })
                    }
                  />
                </div>
                <Field
                  label="控件名"
                  disabled={locked}
                  value={asText(
                    selected.rule.controlName || selected.rule.matchControlName,
                  )}
                  onChange={(e) =>
                    patchRule(selected.index, { controlName: e.target.value })
                  }
                />
                <Field
                  label="控件类型"
                  disabled={locked}
                  value={asText(selected.rule.controlType)}
                  onChange={(e) =>
                    patchRule(selected.index, { controlType: e.target.value })
                  }
                />
                <Field
                  label="动作"
                  disabled={locked}
                  value={asText(selected.rule.actionType)}
                  onChange={(e) =>
                    patchRule(selected.index, { actionType: e.target.value })
                  }
                />
                <Field
                  label="模块"
                  disabled={locked}
                  value={asText(selected.rule.moduleName)}
                  onChange={(e) =>
                    patchRule(selected.index, { moduleName: e.target.value })
                  }
                />
                <Field
                  label="优先级"
                  type="number"
                  disabled={locked}
                  value={Number(selected.rule.priority ?? 0)}
                  onChange={(e) =>
                    patchRule(selected.index, {
                      priority: Number(e.target.value) || 0,
                    })
                  }
                />
              </div>
              <div className={styles.actionRow}>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={locked}
                  onClick={() => removeRule(selected.index)}
                >
                  删除此规则
                </Button>
              </div>
            </>
          ) : (
            <p className={styles.hintText}>
              在左侧列表中选择一条规则进行编辑。大量规则时可先用上方筛选定位。
            </p>
          )}
        </div>
      </div>

      <div className={styles.editorFooter}>
        <Button variant="primary" size="sm" disabled={locked} onClick={onSave}>
          保存画像到配置
        </Button>
        <span className={styles.hintText}>
          保存后立即生效并写入本地配置；重启后自动恢复。建议填写目标进程名以便优先进程绑定。
        </span>
      </div>
    </div>
  );
}
