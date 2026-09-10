# Shadow Recorder v2 实施蓝图（ReqCaseIntelligence）

更新时间：2026-02-10

## 1. 目标与范围

将当前 `Shadow Recorder` 从“可运行 Demo”升级为“可嵌入的产品化子模块”，重点覆盖：

1. 高性能输入采集：低级 Hook + Raw Input 双通道
2. 可切换截图后端：DXGI / WGC（WGC 已实现真实后端）
3. 传输模式：轮询（Poll）+ 推送（Push）
4. 缓冲治理：按步数 + 按字节双阈值控制
5. 平台集成：统一 IPC、托盘最小化、报告导出、Mock AI

## 2. 当前落地状态

### Rust（NAPI）

- 已支持：`start_recording`、`stop_recording`、`set_config`、`get_buffer`
- 已新增：`get_metrics`、`subscribe_steps`、`unsubscribe_steps`
- 已实现：
  - `WM_LBUTTONDOWN` 事件记录
  - 异步截图/编码工作线程
  - 环形缓冲（`max_steps` + `max_buffer_bytes`）
  - 自适应质量（缓冲占用 > 80% 时降质）
  - 输入模式：`auto | hook | raw_input`
  - 捕获来源标注：`capture_backend = dxgi | wgc`

### Desktop（Electron + React）

- 统一 IPC 命名：`reqcase:shadow-recorder:*`
- 提供配置、开始/停止、缓冲查看、指标查看
- 支持托盘最小化与恢复
- 支持 HTML 报告导出
- 支持 Mock AI 重现步骤生成
- 已接通 Push 事件链路（Native -> Main -> Renderer）
- 时间线支持展示捕获后端标签（如 `[dxgi]`）

## 3. 阶段拆解

## Phase 1（已完成）

- 基础 Hook + DXGI + WebP + RingBuffer
- NAPI 基础接口与桌面可视化

## Phase 2（已完成）

- 配置扩展：
  - `max_buffer_bytes`
  - `input_mode`
  - `capture_backend`
  - `transport_mode`
- 指标体系：`RecorderMetrics`
- Push 模式：`subscribe_steps` / `unsubscribe_steps`
- Desktop 改造：统一订阅管理、移除旧轮询模拟推送

## Phase 3（进行中）

- 捕获后端可观测性：记录每步实际后端（DXGI/WGC）
- WGC 真实后端：窗口级 `GraphicsCaptureItem` + `Direct3D11CaptureFramePool`
- 失败回退策略：`WGC -> DXGI`（由 Recorder 侧按配置自动回退）
- Node 基准脚本：输出采样指标与 p95 延迟
- 文档完善：补充 bench 用法与指标说明

## 4. 配置契约（v2）

`RecorderConfigPayload`：

- `maxSteps?: number`
- `maxBufferBytes?: number`
- `debounceMs?: number`
- `webpQuality?: number`
- `adaptiveQualityEnabled?: boolean`
- `adaptiveBufferHighRatio?: number`
- `adaptiveBufferLowRatio?: number`
- `adaptiveLatencyHighMs?: number`
- `adaptiveLatencyLowMs?: number`
- `adaptiveTargetImageKb?: number`
- `adaptiveStepDown?: number`
- `adaptiveStepUp?: number`
- `adaptiveMinQuality?: number`
- `adaptiveMaxQuality?: number`
- `inputMode?: 'auto' | 'hook' | 'raw_input'`
- `captureBackend?: 'auto' | 'dxgi' | 'wgc'`
- `transportMode?: 'poll' | 'push'`

`RecorderStep`（关键扩展）：

- `imageBytes?: number`
- `captureLatencyMs?: number`
- `encodeLatencyMs?: number`
- `source?: 'hook' | 'raw_input'`
- `captureBackend?: 'dxgi' | 'wgc'`

`RecorderMetrics`（压测与调优关键项）：

- `lastImageBytes`
- `currentEffectiveQuality`
- `qualityAdjustDownCount`
- `qualityAdjustUpCount`
- `wgcCaptureCount`
- `dxgiCaptureCount`

## 5. 验收建议

Rust：

- `cargo fmt --all -- --check`
- `cargo check`（需先修复 MSVC/SDK 环境）

Desktop：

- `npm run build:electron`
- `npm run build:react`
- `npm run bench:node`
- `npm run bench:node:wgc`

运行侧：

- Push 模式下时间线可实时追加
- 停止录制后 Push 订阅正确释放
- 录制中最小化窗口进入托盘且可恢复
- 基准脚本可输出 p95 capture/encode 延迟与后端分布
- 基准脚本可输出质量自适应变化和 WGC 命中率
