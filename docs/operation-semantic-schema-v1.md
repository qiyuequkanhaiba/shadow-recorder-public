# 操作语义记录 Schema v1

> 文档版本：v1.0
> 冻结日期：2026-07-30
> 状态：M0-T3 契约冻结
> 适用文件：`semantic-events.ndjson`、`operations.ndjson`、`operation-overrides.ndjson`、`steps.ndjson` 兼容投影
> 关联计划：`docs/操作结果链路语义记录详细实施计划.md`

---

## 1. 范围和目标

本 schema 固定 Shadow Recorder 操作语义记录第一版磁盘契约。它回答四个问题：

1. 用户做了什么操作。
2. 操作前后可观察 UI 状态发生了什么变化。
3. 哪些原始事件、UIA 事件、截图或视频片段支持该结论。
4. 观测不足时如何诚实降级，而不是根据按钮名称推断成功。

v1 只陈述可观察事实，不判断业务语义是否真正成功。比如保存按钮后出现错误弹窗，应记录为已确认的可观察结果，但不能改写成“保存成功”。

---

## 2. 文件职责和重建规则

| 文件 | kind | 职责 | 是否可重建 |
|---|---|---|---|
| `events.ndjson` | `reqcase.test-session-event` | 输入、窗口、会话状态、备注和人工标记等既有原始事实 | 否 |
| `semantic-events.ndjson` | `reqcase.test-session-semantic-event` | UIA 快照、属性变化、焦点、结构、窗口、弹窗和 observer 健康事件 | 否 |
| `operations.ndjson` | `reqcase.test-session-operation` | 从输入事件和语义事件派生出的操作、结果、证据和用户可读摘要 | 是 |
| `operation-overrides.ndjson` | `reqcase.test-session-operation-override` | 用户人工修改标题、结果选择、备注、忽略状态和业务别名 | 否 |
| `steps.ndjson` | `reqcase.test-session-step` | 给旧 API、旧 UI 和旧导出使用的兼容投影 | 是 |

重建规则：

- `semantic-events.ndjson` 和 `operation-overrides.ndjson` 是 append-only fact log，不能通过改写历史行来修正。
- `operations.ndjson` 可删除后从 `events.ndjson`、`semantic-events.ndjson`、artifact/video index 和 overrides 确定性重建。
- `steps.ndjson` 由 operation 投影生成；新状态字段不写入 `steps.ndjson`。
- 旧会话只有 `steps.ndjson` 时，读取层在内存中合成 `legacyUnknown` operation，不自动改写原会话。
- 稳定 ID 必须基于会话 ID 和锚点事件 ID，不能用列表序号生成。

---

## 3. NDJSON 通用规则

- 文件编码为 UTF-8。
- 每行必须是一个完整 JSON object；不允许顶层数组、注释、尾逗号或多行 object。
- 每个 record 必须包含 `schemaVersion`、`kind`、`sessionId` 和本类型主 ID。
- 字段名统一使用 `camelCase`。
- action/status/role 等面向程序的枚举值使用本文列出的稳定字符串；reason code 使用 kebab-case。
- 读取 append-only 文件时，允许忽略崩溃造成的最后一行不完整 JSON，并输出诊断计数；中间损坏行必须保留错误信息，不能静默吞掉。
- 未来 schema version 大于 1 时，v1 reader 可只读已知字段，未知字段必须保留或忽略，但不能误判为成功结果。

---

## 4. 缺失值和未知枚举

### 4.1 缺失值

v1 writer 约定：

- 必填 scalar 字段必须有值，不能为 `null`。
- 可选 string/object/number 字段未知时写 `null`；reader 也必须接受字段缺失并按 `null` 处理。
- array 字段写空数组 `[]` 表示没有条目；reader 接受字段缺失并按空数组处理。
- boolean 的 `false` 只能表示已观测到 false；未知必须是 `null` 或字段缺失。
- number 的 `0` 只能表示真实数值 0；未知必须是 `null` 或字段缺失。
- 可选空字符串写盘前归一化为 `null`。
- confidence 子项未知时为 `null`，不能用 0 伪装低置信度。

### 4.2 未知枚举

Rust 和 TypeScript 类型必须提供 Unknown/Other 前向兼容路径：

- 未知 `eventType`：作为 context evidence 保留，operation builder 不把它当作完成信号。
- 未知 `action.kind`：保留原值，UI 展示为未知操作，不生成成功语句。
- 未知 `outcome.status`：展示为不支持状态；复制文本和导出不得把它写成 confirmed。
- 未知 reason code：保留原字符串并显示在技术详情中。
- 未知 evidence `role`：按 `context` 处理。

---

## 5. 时间和 ID

- `occurredAtMs`、`startedAtMs`、`endedAtMs`、`observedAtMs` 使用 Unix epoch wall-clock milliseconds。
- `relativeMsFromSessionStart` 使用同一会话的 `startedAtMs` 计算。
- UIA observer 可额外写 `monotonicOffsetMs`，用于诊断事件顺序；用户可读时间仍以墙钟为准。
- 目标关联窗口为输入前后 `300ms`，包含边界 300ms。
- 结果观测窗口最长 `3000ms`，包含边界 3000ms；下一次输入到来会提前关闭上一操作的结果窗口。
- `latencyMs` 必须等于 `observedAtMs - action.occurredAtMs`。

---

## 6. 隐私规则

隐私清洗必须在写盘前完成，UI 和导出层不是最后防线。

- 密码控件永不记录 Value、文本、长度、指纹或候选文本。
- 普通文本默认只记录 `valueLength`；`valueFingerprint` 在 v1 必须保持 `null`。
- 明文输入必须使用独立显式配置，不能复用 `semanticRecording.enabled`。
- v1 schema 不定义 `textPreview`、`plaintext`、`plainText`、`inputValue`、`valueText` 等明文字段；如果未来新增，必须受独立开关和 sanitizer 保护。
- UIA `name`、窗口标题和控件标题可作为 locator label 记录，但仍必须经过应用排除规则和长度限制。
- 日志不得输出 UIA 原始 Value、键盘字符、未脱敏 payload 或包含敏感值的完整事件 JSON。
- 截图和视频继续沿用现有隐私确认；operation 只保存 artifact/video 引用，不复制媒体内容。

`privacyClass` v1 值：

| 值 | 含义 |
|---|---|
| `not-sensitive` | 未识别为敏感值，可记录非 Value 的定位标签 |
| `text-length-only` | 只允许记录文本长度 |
| `password-redacted` | 密码控件，Value、长度、指纹均禁止 |
| `sensitive-redacted` | 应用规则或 sanitizer 判定为敏感，已整体脱敏 |
| `unknown` | 无法判断敏感级别，按更保守策略处理 |

---

## 7. UiElementIdentity

```json
{
  "runtimeId": [42, 7, 19],
  "processId": 1234,
  "windowHwnd": "0x000A12BC",
  "name": "保存",
  "automationId": "btnSave",
  "controlType": "Button",
  "localizedControlType": "按钮",
  "className": "Button",
  "frameworkId": "WPF",
  "parentPath": [
    { "controlType": "Window", "name": "订单编辑", "automationId": null },
    { "controlType": "Pane", "name": null, "automationId": "editorPane" }
  ],
  "boundingRect": { "left": 100, "top": 80, "width": 120, "height": 32 }
}
```

字段规则：

- `runtimeId` 为 UIA runtime ID 整数数组；不可用时为 `null`。
- `windowHwnd` 使用十六进制字符串，避免 JavaScript number 精度问题。
- `boundingRect` 使用物理屏幕像素。
- `parentPath` 只保存定位所需的有限字段，不能复制整棵 UI tree。
- 所有 locator label 均需经过 sanitizer。

身份匹配优先级：

1. `runtimeId`
2. `automationId` 加父级路径
3. `name` 加 `controlType` 加父级路径
4. 焦点或祖先语义匹配
5. 空间命中
6. 坐标兜底

---

## 8. UiStateSnapshot

```json
{
  "snapshotId": "state-01J...",
  "capturedAtMs": 0,
  "element": {},
  "isEnabled": true,
  "hasKeyboardFocus": false,
  "isOffscreen": false,
  "valueLength": 8,
  "valueFingerprint": null,
  "toggleState": "on",
  "selectionState": "selected",
  "expandCollapseState": "expanded",
  "rangeValue": 35.0,
  "privacyClass": "text-length-only",
  "source": "uia-property-event"
}
```

状态枚举：

| 字段 | v1 值 |
|---|---|
| `toggleState` | `on`、`off`、`indeterminate`、`unknown` |
| `selectionState` | `selected`、`notSelected`、`mixed`、`unknown` |
| `expandCollapseState` | `expanded`、`collapsed`、`partiallyExpanded`、`leafNode`、`unknown` |
| `source` | `uia-snapshot`、`uia-property-event`、`uia-focus-event`、`derived-from-event`、`manual` |

未支持的 UIA Pattern 写 `null`，不能用默认值伪装已观测状态。

---

## 9. SemanticEventRecord

`semantic-events.ndjson` 每行写一个语义事件：

```json
{
  "schemaVersion": 1,
  "kind": "reqcase.test-session-semantic-event",
  "eventId": "sem-01J...",
  "sessionId": "ts-01J...",
  "eventType": "uia_property_changed",
  "occurredAtMs": 0,
  "monotonicOffsetMs": 123456,
  "sourceEventId": "evt-01J...",
  "target": {},
  "payload": {
    "property": "toggleState",
    "before": "off",
    "after": "on"
  },
  "privacyClass": "not-sensitive",
  "reasonCodes": ["toggle-state-changed"]
}
```

v1 `eventType`：

- `uia_snapshot`
- `uia_focus_changed`
- `uia_property_changed`
- `uia_selection_changed`
- `uia_structure_changed`
- `window_opened`
- `window_closed`
- `popup_appeared`
- `dialog_appeared`
- `observer_health`

`sourceEventId` 指向触发或邻近的输入事件；没有直接输入来源时为 `null`。`payload` 必须是已脱敏对象。

`observer_health` payload v1 字段：

```json
{
  "state": "circuitOpen",
  "queueOverflowCount": 3,
  "message": null
}
```

`state` 常用值为 `healthy`、`timeout`、`circuitOpen`、`queueOverflow`、`restarted`、`targetProcessExited`。

---

## 10. OperationAction

```json
{
  "actionId": "action-01J...",
  "kind": "click",
  "occurredAtMs": 0,
  "endedAtMs": 0,
  "target": {},
  "stateBefore": {},
  "coordinate": { "x": 1203, "y": 456, "displayId": "display-1" },
  "sourceEventIds": ["evt-01J..."],
  "targetReasonCodes": ["runtime-id-match", "point-hit"],
  "confidence": {
    "target": 0.96,
    "temporal": 0.92,
    "overall": 0.94
  }
}
```

`kind` v1 值：

- `click`
- `doubleClick`
- `rightClick`
- `toggle`
- `select`
- `expand`
- `collapse`
- `typeSummary`
- `shortcut`
- `scroll`
- `windowSwitch`
- `manualMark`

`target` 和 `stateBefore` 在无法观测时为 `null`。`coordinate` 是兜底证据，不作为正常 UI 主句的首选表达。

---

## 11. StateTransition

```json
{
  "transitionId": "transition-01J...",
  "kind": "property",
  "occurredAtMs": 0,
  "element": {},
  "property": "toggleState",
  "before": "off",
  "after": "on",
  "sourceEventIds": ["sem-01J..."],
  "reasonCodes": ["toggle-state-changed"],
  "confidence": {
    "identity": 0.92,
    "temporal": 0.91,
    "transition": 0.95,
    "overall": 0.93
  }
}
```

`kind` v1 值为 `property`、`lifecycle`、`structure`、`observerHealth`、`artifact`。`before` 和 `after` 可为 string、number、boolean、object 或 `null`，但必须已经脱敏。

---

## 12. OperationOutcome

```json
{
  "outcomeId": "outcome-01J...",
  "status": "confirmed",
  "summary": "“保存成功”提示出现",
  "observedAtMs": 0,
  "latencyMs": 420,
  "primaryTransitionId": "transition-01J...",
  "candidateTransitionIds": ["transition-01J..."],
  "reasonCodes": ["popup-appeared", "name-match-success-term"],
  "confidence": {
    "temporal": 0.91,
    "identity": 0.84,
    "transition": 0.95,
    "evidence": 0.9,
    "overall": 0.9
  }
}
```

`status` v1 值：

| 值 | 含义 | UI/导出要求 |
|---|---|---|
| `confirmed` | 存在唯一且证据充分的结果 | 可写成明确“操作 -> 结果” |
| `candidate` | 有合理候选，但证据不足以确认 | 必须带候选措辞 |
| `ambiguous` | 多个候选接近，系统不替用户选择 | 必须展示候选列表 |
| `incomplete` | 结果窗口内没有可解释完成信号 | 必须诚实写“未观测到明确结果” |
| `observerDegraded` | observer 不可用、熔断、超时或队列溢出 | 必须写观测降级 |
| `legacyUnknown` | 旧会话只有步骤，没有结果事实 | 只读兼容，不补写成功结果 |

未知 status 不得投影为 `confirmed`。

---

## 13. OperationEvidence

```json
{
  "evidenceId": "evidence-01J...",
  "kind": "stateTransition",
  "role": "supportsOutcome",
  "sourceId": "transition-01J...",
  "occurredAtMs": 0,
  "artifactRef": null,
  "videoRange": null,
  "reasonCode": "toggle-state-changed"
}
```

`kind` v1 值：

- `rawEvent`
- `uiaSnapshot`
- `stateTransition`
- `screenshot`
- `videoRange`
- `manualNote`

`role` v1 值：

- `supportsTarget`
- `supportsOutcome`
- `context`
- `contradicts`

`artifactRef` 使用既有 session artifact 引用字符串。`videoRange` 结构为：

```json
{
  "streamId": "stream-01J...",
  "startedAtMs": 0,
  "endedAtMs": 0
}
```

---

## 14. TestSessionOperationRecord

`operations.ndjson` 每行写一个 operation：

```json
{
  "schemaVersion": 1,
  "kind": "reqcase.test-session-operation",
  "operationId": "operation-01J...",
  "sessionId": "ts-01J...",
  "sequence": 12,
  "startedAtMs": 0,
  "endedAtMs": 0,
  "relativeMsFromSessionStart": 0,
  "action": {},
  "outcome": {},
  "completionCandidates": [],
  "transitions": [],
  "evidence": [],
  "title": "单击按钮“保存”",
  "resultSummary": "“保存成功”提示出现",
  "displaySummary": "单击按钮“保存” -> “保存成功”提示出现，耗时 420ms",
  "precisionLevel": "l3",
  "edited": false,
  "businessAlias": null
}
```

规则：

- `sequence` 是展示排序辅助字段，不参与稳定 ID 生成。
- `action` 和 `outcome` 为必填 object。
- `completionCandidates`、`transitions`、`evidence` 为数组，空时写 `[]`。
- `displaySummary` 是派生显示文本；重建时可重新生成。
- `edited=true` 表示存在人工 override 影响当前显示或结果选择。
- `businessAlias` 来自语义画像或人工 override；不能覆盖原始 target/evidence。

---

## 15. OperationOverrideRecord

`operation-overrides.ndjson` 每行写一个人工覆盖事件：

```json
{
  "schemaVersion": 1,
  "kind": "reqcase.test-session-operation-override",
  "overrideId": "override-01J...",
  "sessionId": "ts-01J...",
  "operationId": "operation-01J...",
  "occurredAtMs": 0,
  "source": "user",
  "changes": {
    "title": "点击保存订单",
    "resultSummary": null,
    "selectedOutcomeStatus": null,
    "selectedTransitionId": null,
    "ignored": false,
    "businessAlias": "保存订单",
    "note": null
  },
  "reason": "manual-review"
}
```

覆盖规则：

- override append-only；后写记录按 `occurredAtMs`、`overrideId` 确定性覆盖早期记录。
- override 只能影响显示、人工选择、忽略状态和备注，不能改写 raw event、semantic event 或原始 evidence。
- 删除人工覆盖通过追加一个恢复自动判断的 override 表达，不能删除旧行。
- override 内容同样经过 sanitizer。

---

## 16. Reason Code

Reason code 是测试、诊断和 UI 说明契约，不允许只用自由文本替代。

| 分类 | v1 reason code |
|---|---|
| 目标 | `runtime-id-match`、`automation-path-match`、`focus-match`、`point-hit`、`ancestor-semantic-match`、`coordinate-fallback` |
| 状态 | `value-length-changed`、`toggle-state-changed`、`selection-changed`、`expand-state-changed`、`range-value-changed`、`enabled-state-changed` |
| 生命周期 | `focus-changed`、`window-opened`、`window-closed`、`popup-appeared`、`dialog-appeared`、`structure-changed` |
| 结束 | `explicit-completion`、`next-input-closed-window`、`result-timeout`、`no-observable-change`、`multiple-candidates` |
| 候选判断 | `weak-completion-signal`、`negative-completion-signal`、`name-match-success-term` |
| 降级 | `uia-timeout`、`uia-circuit-open`、`uia-disabled`、`queue-overflow`、`observer-restarted`、`target-process-mismatch` |

新增 reason code 必须同步更新 Rust/TS 强类型、Golden fixture 或 schema 变更说明。

---

## 17. 兼容投影到 steps.ndjson

新会话同时生成 `operations.ndjson` 和 `steps.ndjson`。

投影规则：

- `stepId` 可使用对应 operation 的稳定 ID 派生，保证旧引用可寻址。
- `stepType` 来自 `action.kind` 的旧步骤分类映射。
- `title` 来自 operation `title`。
- `summary` 对 `confirmed` 写结果摘要；对 `candidate`、`ambiguous`、`incomplete`、`observerDegraded`、`legacyUnknown` 必须使用对应状态措辞，不能写成成功。
- `startedAtMs`、`endedAtMs`、`relativeMsFromSessionStart` 来自 operation。
- `controlName`、`automationId`、`controlType`、`className` 从 `action.target` 投影。
- `x`、`y`、`displayId` 从 `action.coordinate` 投影。
- `precisionLevel` 从 operation `precisionLevel` 投影。
- `sourceEventIds` 合并 action 和 evidence 的原始输入事件 ID。
- `artifactRefs` 从 screenshot/video evidence 投影。
- `edited`、`businessAlias` 从 operation 当前视图投影。

旧会话读取规则：

- 只有 `steps.ndjson` 时，在内存中合成 `legacyUnknown` outcome。
- 不创建 `semantic-events.ndjson`、`operations.ndjson` 或 `operation-overrides.ndjson`。
- UI 可展示旧步骤，但不能伪造 operation evidence。

---

## 18. Feature Flag 降级行为

| 开关 | 关闭后的行为 | 数据要求 |
|---|---|---|
| `semanticRecording.enabled` | 不启用 operation 语义链路，继续既有步骤记录 | 不创建新的 semantic/operation 文件；已有文件只读 |
| `uiaObserver.enabled` | 不采集 UIA semantic events | operation builder 只能使用输入、坐标、截图和视频；结果应为 `observerDegraded` 或 `incomplete`，不得编造 confirmed |
| `operationBuilder.enabled` | 不生成新的 `operations.ndjson` | 可继续写 `semantic-events.ndjson` 供诊断；UI/导出回退 `steps.ndjson` |
| `operationReviewV2.enabled` | 关闭新版记录与回顾 UI | 数据仍可写入；前端读取旧步骤视图 |
| 明文输入开关 | 默认关闭，独立于以上开关 | 关闭时只允许文本长度；密码始终全量禁止 |

所有开关缺失时必须使用安全默认值启动。回滚不得要求删除或改写用户会话数据。

---

## 19. Golden 和验证

Golden 契约位于 `tests/fixtures/operations`：

- `manifest.json` 固定 `schemaVersion=1`、`targetWindowMs=300`、`outcomeWindowMs=3000`。
- 当前 Golden 集覆盖 17 个 case、30 个 operation、5 类技术栈和 5 种 outcome status。
- 隐私哨兵值和密码 payload 规则必须持续通过。

契约测试：

```powershell
cargo test operation_golden --test operation_golden
cd examples/desktop
npm run test:operation-golden-contract
```

schema、status、reason code、时间窗或隐私字段变化时，必须同步更新本文件、Rust/TS 类型、fixture 和契约测试。

---

## 20. M0-T3 冻结结论

v1 冻结内容：

- `schemaVersion=1` 和三个新 kind 字符串。
- `semantic-events.ndjson`、`operations.ndjson`、`operation-overrides.ndjson` 和 `steps.ndjson` 的职责边界。
- unknown enum、nullable、missing-field 和损坏尾行处理。
- outcome status、evidence role、reason code 和 feature flag 降级行为。
- 默认不记录文本明文，密码值永不记录。
- 旧会话只读兼容，不自动改写。

M1-T1 可以据此实现 Rust/TypeScript 数据模型和 round-trip 测试。
