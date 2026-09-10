# 操作语义记录基线

> 版本：v1.0  
> 状态：M0 基线口径已冻结，当前数值由脚本重新生成  
> 对应任务：M0-T1

## 1. 目的

本基线用于量化 `operations.ndjson` 上线前，现有 `steps.ndjson` 能提供的目标语义质量。它不把尚未采集的“操作结果”指标填成 0，也不把步骤与源事件时间一致误写成视频 seek 已验收。

## 2. 数据来源

- 默认会话根目录：`examples/desktop/dist-electron/reports/test-sessions`
- 输入文件：`session.json`、`events.ndjson`、`steps.ndjson`
- 默认排除：active 会话、无步骤会话
- 最少样本：5 个真实会话
- 隐私：报告仅保留聚合值和 session ID，不输出控件文字、窗口标题、输入内容和截图内容

## 3. 指标口径

| 指标 | 计算口径 |
|---|---|
| targetable step | 排除窗口切换、会话生命周期、备注和缺陷标记后的操作步骤 |
| coordinate-only | targetable step 没有控件身份，但保留 x/y 坐标 |
| semantic target | targetable step 至少存在 controlName、automationId 或 controlType |
| unidentified target | targetable step 既没有控件身份，也没有坐标 |
| L2+ | targetable step 的 precisionLevel 为 l2/l3/l4 |
| source event resolution | `sourceEventIds` 能在同一会话 `events.ndjson` 找到的比例 |
| source timestamp delta | step.startedAtMs 与其源事件 occurredAtMs 的绝对差 |
| artifact resolution | artifactRefs 指向的本地文件仍存在的比例 |

## 4. 暂不可测指标

以下指标必须等 `operations.ndjson` 和人工标注 Golden 数据落地后计算：

- confirmed 结果关联准确率
- 错误确认率
- incomplete 诚实率
- 操作结果耗时误差
- observer degraded 识别率

视频 seek 对齐必须使用人工标注的视频操作时刻，不能用 source event timestamp delta 替代。

## 5. 执行方式

```powershell
cd examples/desktop
npx tsx scripts/operation-semantic-baseline-test.ts
```

可选参数：

```text
--sessions-root <path>       指定会话根目录
--output-root <path>         指定报告输出目录
--minimum-sessions <count>   最小有效样本数，默认 5
--limit <count>              只分析最近 N 个有效会话
--include-active             包含未正常停止的会话
```

报告写入 `.ci-artifacts/operation-semantic-baseline/report-*/`，该目录已被 `.gitignore` 排除。

Golden 契约测试：

```powershell
cd examples/desktop
npm run test:operation-golden-contract
```

该测试固定 `tests/fixtures/operations` 的样本覆盖、结果状态、时间窗边界和隐私约束。当前 Golden 集为 17 个 case、30 个 operation，覆盖 5 类技术栈和 5 种结果状态。

## 6. 当前基线

最近一次执行：`2026-07-30T09:35:19.841Z`

报告路径：`examples/desktop/.ci-artifacts/operation-semantic-baseline/report-20260730T093519841Z/operation-semantic-baseline.json`

| 指标 | 当前值 |
|---|---:|
| 发现会话 | 23 |
| 有效会话 | 11 |
| 分析会话 | 11 |
| 事件数 | 189 |
| 步骤数 | 67 |
| 可定位操作 | 32 |
| coordinate-only | 18 / 32（56.3%） |
| semantic target | 14 / 32（43.8%） |
| L2+ | 14 / 32（43.8%） |
| unidentified target | 0 / 32（0.0%） |
| NDJSON 解析错误 | 0 |
| source event 引用完整性 | 67 / 67（100.0%） |
| artifact 引用完整性 | 64 / 64（100.0%） |
| source timestamp delta p95 | 0 ms |
| 事件速率 | 74.774 events/minute |
| UIA 超时率代理值 | 0 / 14（0.0%） |
| CPU p95 | 需 native 60 分钟长跑采样 |
| 最大 RSS | 需 native 60 分钟长跑采样 |
| 1 小时稳定性 | 需 native 60 分钟长跑采样 |

结论：现有步骤链路已具备稳定引用完整性，但目标语义仍有 56.3% 依赖坐标兜底，距离 Phase A 的 L2 目标还有明显缺口；事件速率和 UIA 超时率已有历史会话代理基线，CPU、内存和 1 小时稳定性需在 M8/native 长跑中采样；结果关联、incomplete 诚实率和视频 seek 对齐仍需 `operations.ndjson` 与人工标注数据后才能验收。

## 7. steps/API/回顾页契约

### steps.ndjson schema

- 文件名：`steps.ndjson`
- 记录类型：`reqcase.test-session-step`
- 已观测 schema version：`1`
- 必填字段：`schemaVersion`、`kind`、`stepId`、`sessionId`、`startedAtMs`、`endedAtMs`、`relativeMsFromSessionStart`、`stepType`、`title`、`summary`、`precisionLevel`、`confidence`、`sourceEventIds`、`artifactRefs`
- 可选字段：`processName`、`windowTitle`、`controlName`、`controlType`、`automationId`、`className`、`x`、`y`、`displayId`、`fullImagePath`、`thumbImagePath`、`edited`、`originalTitle`、`businessAlias`
- 隐私说明：报告只聚合字段名和引用完整性；不打开截图、视频，不输出 `windowTitle`、`controlName` 等可能含业务信息的明文内容；键盘明文不属于 `TestSessionStepRecord`。

### API 返回结构

| 层级 | 契约 |
|---|---|
| Rust NAPI function | `get_test_session_steps` |
| Electron/Preload binding | `getTestSessionSteps` |
| 返回类型 | `JsTestSessionStepRecord[]` |
| 字段命名 | native NAPI 对象使用 snake_case，preload 映射为 React 侧 camelCase |

### 回顾页字段映射

| steps.ndjson 字段 | API 字段 | 回顾页用途 |
|---|---|---|
| `stepId` | `stepId` | 稳定行 key 和编辑目标 |
| `startedAtMs` | `startedAtMs` | 时间线排序和时间显示 |
| `stepType` | `stepType` | 节点类型和过滤 |
| `title` | `title` | 主操作句 |
| `summary` | `summary` | 次级详情和导出文本 |
| `precisionLevel` | `precisionLevel` | `RecorderSessionTimelinePanel` 中的小型精度标识 |
| `sourceEventIds` | `sourceEventIds` | 折叠技术详情和追溯 |
| `artifactRefs` | `artifactRefs` | 截图、视频证据查找 |
| `businessAlias` | `businessAlias` | 可选业务别名 |

## 8. 运行时基线与采样方法

| 指标 | 当前值 | 状态 | 采样或计算方法 |
|---|---:|---|---|
| 事件速率 | 74.774 events/minute | 历史会话代理值 | `events.ndjson` 事件总数 / stopped 会话总时长分钟 |
| UIA 超时率 | 0.0% | 历史会话代理值 | 文本或 L2+ 代理识别的 UIA 事件中，含 timeout/timed out 的事件比例；M2 后改用 `observer_health` |
| CPU p95 | 未采样 | 需 native 长跑 | 固定录制设置下运行 60 分钟，跳过预热后按采样点计算进程 CPU p95 |
| 最大 RSS | 未采样 | 需 native 长跑 | 固定录制设置下运行 60 分钟，记录 resident memory 峰值 |
| 1 小时稳定性 | 未采样 | 需 native 长跑 | 连续录制 60 分钟，验证无崩溃、无中间损坏 NDJSON 行、stop 可完成、manifest 可读 |

CPU、内存和长跑稳定性在本阶段冻结的是采样契约，不伪造缺失数值。M8 首次 native 长跑产生的数值将作为后续 observer 开关、限流和性能门禁的对比基线。

## 9. 验收指标采样映射

| 验收指标 | 当前状态 | 数据来源 | 计算方法 |
|---|---|---|---|
| 目标识别正确率 | 需人工标注 | Golden operation annotations 和 reviewer labels | locator 能定位实际交互控件且不只依赖坐标时判为正确 |
| 结果关联正确率 | operations v1 前不可测 | `operations.ndjson` outcome 和 Golden annotations | 比较选中结果与人工标注的期望 UI 状态迁移 |
| incomplete 诚实率 | operations v1 前不可测 | `operations.ndjson` incomplete/degraded outcome 和 annotations | 无完成信号时应为 incomplete，observer 故障应单独归为 degraded |
| coordinate-only 比例 | 已可测 | `steps.ndjson` | targetable steps 中无控件身份但有 x/y 的比例 |
| L2+ 比例 | 已可测 | `steps.ndjson.precisionLevel` | targetable steps 中 `l2/l3/l4` 的比例 |
| 视频 seek 对齐 | 需人工视频标注 | manual video timestamp annotations | 比较点击 operation 后播放器落点，目标 p95 在前后 500ms 内、最大不超过 1 秒 |
| 事件速率 | 历史会话代理值 | session duration 和 `events.ndjson` count | 事件总数 / stopped 会话总时长分钟；M2 后接 native observer 计数 |
| CPU 和内存 | 需 native 长跑 | performance/native long-run harness | 60 分钟录制下采样 CPU p95 和最大 RSS |

## 10. 人工标注规则

### 目标识别正确

控件身份足以让不熟悉录制过程的人定位到实际交互对象。只有 ControlType 且页面存在多个同类控件时，不算正确目标。

### 结果关联正确

选中结果必须是动作后实际出现的状态变化，并且没有更合理的竞争候选。按钮名包含“保存”“提交”等词不能作为完成证据。

### incomplete 诚实

结果窗口内确实没有可解释完成信号，或者观测质量足够但没有状态变化。UIA 熔断、队列溢出等情况应标为 observer degraded，不能混入 incomplete。

### seek 对齐

人工标注视频中操作实际发生时刻，比较点击 operation 后播放器落点。目标为 95% 在前后 500ms 内，全部不超过 1 秒。
