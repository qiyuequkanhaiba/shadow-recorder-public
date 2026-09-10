import { useMemo, useState, type ChangeEvent } from 'react';

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
    <div className="semantic-profile-editor" aria-label="语义画像编辑">
      <div className="spe-meta-grid">
        <label>
          画像名称
          <input
            type="text"
            disabled={locked}
            value={asText(profile.name)}
            onChange={(e: ChangeEvent<HTMLInputElement>) => patchMeta('name', e.target.value)}
          />
        </label>
        <label>
          画像 ID
          <input
            type="text"
            disabled={locked}
            value={asText(profile.profileId)}
            onChange={(e: ChangeEvent<HTMLInputElement>) => patchMeta('profileId', e.target.value)}
          />
        </label>
        <label>
          目标进程
          <input
            type="text"
            disabled={locked}
            placeholder="例如 QtApp.exe / notepad.exe"
            value={asText(profile.targetProcessName)}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              patchMeta('targetProcessName', e.target.value || null)
            }
          />
        </label>
        <label>
          优先级
          <input
            type="number"
            disabled={locked}
            value={Number(profile.priority ?? 0)}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              patchMeta('priority', Number(e.target.value) || 0)
            }
          />
        </label>
        <label className="spe-span-2">
          描述
          <input
            type="text"
            disabled={locked}
            value={asText(profile.description)}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              patchMeta('description', e.target.value || null)
            }
          />
        </label>
      </div>

      <div className="spe-rules-toolbar">
        <h4>
          别名规则
          <span className="spe-rules-count"> · {rules.length}</span>
          {filter.trim() ? (
            <span className="spe-rules-count">（筛选后 {filtered.length}）</span>
          ) : null}
        </h4>
        <input
          className="spe-filter"
          type="search"
          placeholder="筛选别名、AutomationId、模块…"
          value={filter}
          disabled={locked}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="筛选别名规则"
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={locked}
          onClick={addRule}
        >
          新增规则
        </button>
      </div>

      <div className="spe-workbench">
        <div className="spe-rule-list" role="listbox" aria-label="别名规则列表">
          <div className="spe-rule-list-scroll">
            {filtered.length === 0 ? (
              <p className="spe-rule-list-empty">
                {rules.length === 0 ? '暂无别名规则，可点击「新增规则」。' : '无匹配规则，请调整筛选条件。'}
              </p>
            ) : (
              filtered.map(({ rule, index }) => {
                const id = ruleKey(rule, index);
                const selectedRow = selectedRuleId === id;
                const autoId = rule.automationId || rule.matchAutomationId || rule.controlName || '—';
                return (
                  <button
                    key={id}
                    type="button"
                    role="option"
                    aria-selected={selectedRow}
                    className={`spe-rule-row${selectedRow ? ' is-selected' : ''}`}
                    disabled={locked}
                    onClick={() => setSelectedRuleId(id)}
                  >
                    <span className="spe-rule-index">{index + 1}</span>
                    <span className="spe-rule-main">
                      <span className="spe-rule-alias">{rule.alias || '(无别名)'}</span>
                      <span className="spe-rule-id">{autoId}</span>
                      {rule.moduleName || rule.controlType || rule.actionType ? (
                        <span className="spe-rule-module">
                          {[rule.moduleName, rule.controlType, rule.actionType]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="spe-rule-detail" aria-label="规则详情">
          {selected ? (
            <>
              <p className="spe-rule-detail-title">编辑选中规则</p>
              <div className="spe-detail-grid">
                <label className="spe-span-2">
                  业务别名
                  <input
                    type="text"
                    disabled={locked}
                    value={asText(selected.rule.alias)}
                    onChange={(e) => patchRule(selected.index, { alias: e.target.value })}
                  />
                </label>
                <label className="spe-span-2">
                  AutomationId
                  <input
                    type="text"
                    disabled={locked}
                    value={asText(selected.rule.automationId || selected.rule.matchAutomationId)}
                    onChange={(e) =>
                      patchRule(selected.index, {
                        automationId: e.target.value,
                        matchAutomationId: e.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  控件名
                  <input
                    type="text"
                    disabled={locked}
                    value={asText(selected.rule.controlName || selected.rule.matchControlName)}
                    onChange={(e) =>
                      patchRule(selected.index, {
                        controlName: e.target.value,
                        matchControlName: e.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  控件类型
                  <input
                    type="text"
                    disabled={locked}
                    value={asText(selected.rule.controlType)}
                    onChange={(e) => patchRule(selected.index, { controlType: e.target.value })}
                  />
                </label>
                <label>
                  动作
                  <input
                    type="text"
                    disabled={locked}
                    value={asText(selected.rule.actionType)}
                    onChange={(e) => patchRule(selected.index, { actionType: e.target.value })}
                  />
                </label>
                <label>
                  模块
                  <input
                    type="text"
                    disabled={locked}
                    value={asText(selected.rule.moduleName)}
                    onChange={(e) => patchRule(selected.index, { moduleName: e.target.value })}
                  />
                </label>
                <label>
                  优先级
                  <input
                    type="number"
                    disabled={locked}
                    value={Number(selected.rule.priority ?? 0)}
                    onChange={(e) =>
                      patchRule(selected.index, { priority: Number(e.target.value) || 0 })
                    }
                  />
                </label>
              </div>
              <div className="spe-detail-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={locked}
                  onClick={() => removeRule(selected.index)}
                >
                  删除此规则
                </button>
              </div>
            </>
          ) : (
            <p className="spe-rule-detail-empty">
              在左侧列表中选择一条规则进行编辑。
              <br />
              大量规则时可先用上方筛选定位。
            </p>
          )}
        </div>
      </div>

      <div className="spe-footer">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={locked}
          onClick={onSave}
        >
          保存画像到配置
        </button>
        <p className="spe-footer-hint">
          保存后立即生效并写入本地配置；重启后自动恢复。建议填写目标进程名以便优先进程绑定。
        </p>
      </div>
    </div>
  );
}
