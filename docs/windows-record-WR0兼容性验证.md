# windows-record WR-0 兼容性验证

## 1. 目标

本验证用于确认 `windows-record` 是否适合作为当前项目“连续视频录制内核”的替换候选。

WR-0 只验证：

- 能否在当前仓库环境中独立编译
- 能否生成最小可用录制文件
- 它的公开 API 是否覆盖当前主需求
- 与当前项目的集成边界是否清晰

## 2. 当前结论

截至本轮验证，结论如下：

- `windows-record` crate 版本：`0.1.0`
- 许可证：`MIT`
- 当前仓库内已新增独立 PoC 子项目：`tools/windows-record-poc`
- 当前仓库内已新增辅助脚本：
  - `scripts/list-visible-window-titles.ps1`
  - `scripts/run-windows-record-poc.ps1`
- 当前环境下 **编译通过**，但 **最小真实录制尚未通过**

## 3. 已确认的能力

- 支持 Rust 直接调用，不需要额外 Node 原生桥。
- 支持直接录制到视频文件。
- 支持 replay buffer。
- 支持音频源选择。
- 对当前项目而言，最有价值的是它能替代现有 `JPEG 帧序列 + ffmpeg` 主录制链。

## 4. 已确认的边界

### 4.1 公开 API 目前更偏“按窗口标题录制”

虽然方法名是 `with_process_name(...)`，但当前公开实现实际是按**可见窗口标题文本**匹配窗口。

这意味着：

- 它不是当前项目理想的 `hwnd` 绑定 API
- `foreground_window` 集成时需要额外适配层
- WR-1 需要明确是“直接复用公开 API”，还是“在 fork 中补 `hwnd` 级接口”

### 4.2 当前公开示例没有直接暴露多显示器主路径

从公开 README 和示例看，主入口明显偏单窗口录制。

这意味着：

- `desktop / target_display / all_displays` 还不能直接认定已经满足
- WR-0 只先验证单窗口录制
- 多显示器应放到 WR-1/WR-2 再做定向验证

## 5. 与当前项目的接入建议

建议只替换“连续视频录制内核”，保留：

- 会话生命周期
- 事件日志
- 视频与事件时间戳映射
- Electron IPC
- React 回放与导出界面

不建议在 WR-0 直接做：

- 事件模型迁移
- NAPI 接口重写
- 主窗口 UI 重构
- 证据包结构改造

## 6. WR-0 PoC 使用方式

### 6.1 列出当前可见窗口标题

```powershell
powershell -ExecutionPolicy Bypass -File scripts/list-visible-window-titles.ps1
```

### 6.2 执行最小录制 PoC

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run-windows-record-poc.ps1 `
  -Window "shadowrecord" `
  -Duration 6 `
  -Audio off `
  -Debug
```

### 6.3 直接使用 cargo

```powershell
cargo run --manifest-path tools/windows-record-poc/Cargo.toml -- `
  --window "shadowrecord" `
  --duration 6 `
  --audio off `
  --debug
```

## 7. WR-0 验收标准

- [x] PoC 编译通过
- [ ] 最小录制能够生成非空视频文件
- [x] 停止录制未出现当前仓库主链那种“同步卡死 UI”，PoC 进程可退出
- [ ] 至少确认单窗口录制可用
- [x] 明确记录多显示器与 `hwnd` 绑定缺口

## 8. 本轮实际验证结果

### 8.1 编译验证

已执行：

```powershell
cargo build --manifest-path tools/windows-record-poc/Cargo.toml
```

结果：

- 编译通过

### 8.2 真实录制验证

已执行两轮最小录制：

1. 目标窗口：`shadowrecord`
2. 目标窗口：`Google Chrome`
3. 目标窗口：`Codex`

命令形态：

```powershell
cargo run --manifest-path tools/windows-record-poc/Cargo.toml -- `
  --window "Codex" `
  --duration 5 `
  --audio off `
  --debug `
  --output D:/python/shadowrecord/reports/windows-record-poc/wr0-codex.mp4
```

实际结果：

- 输出文件被创建，但大小为 `0 bytes`
- `Chrome` 录制日志中出现：
  - `Sample processing finished. Processed 0 frames`
- `Codex` 录制日志中出现：
  - `Window 'Codex' lost focus - displaying black screen`
  - `Channel closed or receiver disconnected, stopping frame collection`
  - `Process thread error: HRESULT(0x80004005)`

因此当前 WR-0 结论是：

- `windows-record` 在当前环境中“可以编译”
- 但“最小真实录制尚未跑通”
- 暂时还不能直接进入主链替换实施

### 8.3 观察到的行为边界

- 该库对“目标窗口必须保持焦点”非常敏感。
- 即使目标窗口日志显示处于 focus 状态，当前环境下仍出现 `0 frames`。
- 它当前公开 API 更像“按窗口标题录制”，而不是“按 hwnd/显示器稳定绑定”。

## 9. 当前建议

在当前验证结果下，不建议直接开始 WR-1 主链替换。

建议先做一个“WR-0.5 深挖”：

1. 进一步确认 `windows-record` 的 `0 frames` 是否由当前 GPU / Desktop Duplication 约束触发。
2. 评估是否需要 fork `windows-record` 并补 `hwnd` / 显示器级接口。
3. 在独立 PoC 中继续验证：
   - 不同窗口类型
   - 焦点保持策略
   - 不同分辨率
   - 是否必须前台保持不变
4. 只有在独立 PoC 能稳定产出非空视频后，再进入 WR-1。

## 10. 下一步

如果后续 WR-0.5 能跑通，下一步再进入 WR-1：

- 将 `tools/windows-record-poc` 的最小链路抽到 `src/session/windows_record_runtime.rs`
- 先接单窗口录制
- 再补 `foreground_window` 跟随与 stop/finalize 状态机

## 11. WR-0.5 深挖结果

WR-0.5 的目标不是继续“碰运气录一次”，而是回答三个更具体的问题：

- `0 frames` 是否由默认分辨率不匹配导致
- `--exact` / 焦点保持这些调用是否真的按公开 API 预期生效
- 如果 PoC 仍失败，失败点更接近“采集层”还是“处理/编码层”

### 11.1 WR-0.5 对 PoC 的增强

本轮已对 `tools/windows-record-poc` 做了三项增强：

- 新增主显示器分辨率自动探测，并把 `input/output dimensions` 打到日志里
- 新增 CLI 参数：
  - `--input-width`
  - `--input-height`
  - `--output-width`
  - `--output-height`
- PowerShell 辅助脚本 `scripts/run-windows-record-poc.ps1` 也已同步支持这组尺寸参数

### 11.2 WR-0.5 实验结果

本机自动探测到的主显示器尺寸为：

- `2560 x 1600`

本轮实际执行了这些 PoC 录制：

1. `Codex`，自动探测尺寸
2. `Codex`，显式 `2560x1600`
3. `Google Chrome`，自动探测尺寸
4. `Codex`，substring 模式复测

结果一致：

- 输出文件均被创建
- 输出文件大小均为 `0 bytes`
- 没有任何一组产出非空视频

其中最关键的一组是 `Codex substring` 复测。日志显示：

- 目标窗口已被识别为前台：
  - `Window 'Codex' is now in focus - displaying window content`
- 但随后仍立即出现：
  - `Channel closed or receiver disconnected, stopping frame collection`
- 最终 stop 时处理线程报：
  - `Process thread error: HRESULT(0x80004005)`

这说明：

- **分辨率不匹配不是唯一根因**
- **即使窗口已在前台，当前 crate 仍会在第一帧之前失败**

### 11.3 WR-0.5 确认的源码级问题

#### 11.3.1 `with_exact_match(...)` 在当前发布版里实际失效

源码路径：

- `windows-record-0.1.0/src/recorder/mod.rs`
- `windows-record-0.1.0/src/recorder/inner.rs`

问题点：

- `Recorder::with_exact_match(true)` 会把值写进 `Recorder.use_exact_match`
- `start_recording()` 也能读到这个值并打印：
  - `Searching for windows with exact match: 'Codex'`
- 但它最后调用的是：
  - `RecorderInner::init(&self.config, proc_name)`
- 而不是：
  - `RecorderInner::init_with_exact_match(...)`

结果是：

- inner 层始终按 `false` 初始化
- 日志里能看到：
  - `Initializing recorder for process: Codex with exact match: false`

这说明当前 crate 的 `exact match` 功能在发布版里存在明确实现缺陷。

#### 11.3.2 当前采集链强依赖“窗口必须保持前台”

源码路径：

- `windows-record-0.1.0/src/capture/video.rs`

关键逻辑：

- `is_focused()` 直接用 `GetForegroundWindow() == hwnd`
- `should_show_content` 完全等于 `is_window_focused`
- 失焦时直接走：
  - `displaying black screen`

这意味着：

- 当前公开实现不是“后台窗口录制”
- 更不是当前项目需要的 `foreground_window` 平滑跟随模型
- 对用户操作切窗非常敏感

#### 11.3.3 当前 DXGI 复制固定绑定 `EnumOutputs(0)`

源码路径：

- `windows-record-0.1.0/src/capture/dxgi.rs`

关键逻辑：

- `dxgi_adapter.EnumOutputs(0)?`

这说明它当前默认只绑当前 adapter 的第一个 output。

影响：

- 多显示器/非主输出的稳定性不能从公开 crate 直接保证
- 即使单窗口录制，也缺少“按目标窗口所在显示器选 output”的能力
- 这一点对当前项目的 `desktop / target_display / all_displays` 都是不足的

#### 11.3.4 采集层日志会把“下游失败”伪装成 `Channel closed`

源码路径：

- `windows-record-0.1.0/src/capture/video.rs`
- `windows-record-0.1.0/src/processing/mod.rs`

现象：

- 采集线程先报：
  - `Channel closed or receiver disconnected`
- 但真实根因往往在处理线程
- stop 时才通过 join 暴露：
  - `Process thread error: HRESULT(0x80004005)`

这意味着当前日志可诊断性不足：

- 采集线程日志会误导排查方向
- 第一时间看起来像 sender/receiver 通道问题
- 实际更可能是 `ProcessInput / ProcessOutput / WriteSample / Finalize` 链条中的 Media Foundation 错误

### 11.4 WR-0.5 更新结论

WR-0.5 之后，结论已经比 WR-0 更明确：

- `windows-record` 当前版本与本仓库 **编译兼容**
- 但与本机/本项目场景 **运行兼容性仍不成立**
- `0 frames` **不能归咎于默认 1920x1080 分辨率**
- `with_exact_match(...)` 在当前发布版存在明确缺陷
- 即使窗口处于前台，当前处理链仍可能在首帧前以 `HRESULT(0x80004005)` 失败
- 当前 crate 的公开形态 **不能直接进入 WR-1 主链替换**

### 11.5 WR-0.5 后的建议

不建议直接把 `windows-record` 接入主工程。

更合理的后续顺序是：

1. 先进入一个 `WR-0.6 / fork 评估`：
   - 修 `with_exact_match` 传递缺陷
   - 补更明确的错误日志，把处理线程错误在首发点打出来
   - 评估是否需要补 `hwnd` / `HMONITOR` / `output index` 级接口
2. 仅当 fork 版 PoC 能稳定生成非空视频后，再进入 WR-1
3. 如果 fork 成本过高，应暂停“直接替换内核”路线，改为继续优化现有录制链或评估其他内核

### 11.6 WR-1 启动前门槛

在 WR-1 之前，至少满足以下条件：

- [ ] fork/补丁版 PoC 能连续产出非空视频
- [ ] `exact match` 或 `hwnd` 绑定行为可验证
- [ ] stop 路径不出现同步卡死
- [ ] 至少确认单窗口录制在本机稳定
- [ ] 能明确判断多显示器支持是“现成可用”还是“需要二次开发”

## 12. WR-0.6 fork 评估结果

WR-0.6 的目标是把 WR-0.5 的“猜测”变成“可验证结论”。

本轮不再只读源码，而是做了一个仓库内可打补丁的本地 fork，并让独立 PoC 直接依赖它。

### 12.1 本轮实际改动

已新增本地 fork：

- `tools/windows-record-fork`

PoC 依赖已切到 path 依赖：

- `tools/windows-record-poc/Cargo.toml`

fork 中实际打了两类补丁：

1. 修 `exact_match` 透传
2. 补首发错误日志

具体位置：

- `tools/windows-record-fork/src/recorder/mod.rs`
- `tools/windows-record-fork/src/capture/video.rs`
- `tools/windows-record-fork/src/processing/mod.rs`

### 12.2 WR-0.6 已确认的修复

#### 12.2.1 `exact_match` 透传问题已被修复并验证

fork 版日志已明确显示：

- `Searching for windows with exact match: 'Codex'`
- `Initializing recorder for process: Codex with exact match: true`
- `Found window matching 'Codex' with ExactMatch`

这说明：

- WR-0.5 确认的 `exact_match` 透传缺陷已经在 fork 中修掉
- 当前如果只看“窗口匹配正确性”，fork 已经优于 crates.io 发布版

### 12.3 WR-0.6 新拿到的关键结论

#### 12.3.1 首发故障点不是“通道关闭”，而是 `WriteSample`

在 `Codex` 和 `Google Chrome` 的 `2560x1600` 实验里，新增日志明确显示：

- `Failed to write video sample at frame 3 timestamp 1000000: HRESULT(0x80004005)`

随后采集线程才因为 receiver 断开而结束：

- `send_frame failed because receiver disconnected: SendError { .. }`

这说明：

- WR-0.5 中的 `Channel closed or receiver disconnected` 只是**后果**
- 真正的首发失败点在处理线程的：
  - `writer.0.WriteSample(...)`

也就是说当前 fork 已经把根因从“通道问题”收敛到了“Media Foundation sink writer / 编码链”。

#### 12.3.2 `0 frames` 与 `E_FAIL` 两种失败模式都存在

本轮又补了一个显式 `1920x1080` 的 `Codex exact` 实验。

结果与 `2560x1600` 不同：

- `2560x1600`：
  - 能走到 `WriteSample`
  - 在第 `3` 帧附近报 `HRESULT(0x80004005)`
- `1920x1080`：
  - 没有任何帧被处理
  - stop 时 `Finalize` 报：
    - `HRESULT(0xC00D4A44)`  
    - 含义是“接收器未处理任何示例”

这说明：

- 失败模式与尺寸/时序组合有关
- 但无论 `2560x1600` 还是 `1920x1080`，最终都**不能得到非空视频**
- 因此 WR-0.6 之后，仍不能把问题简单归结为“默认分辨率错了”

#### 12.3.3 焦点约束仍是集成风险

即使 `exact_match` 已修，日志里仍然能看到两种情况：

- 有的实验一开始就是：
  - `Window 'Codex' lost focus - displaying black screen`
- 有的实验则能看到：
  - `Window 'Codex' is now in focus - displaying window content`

这说明：

- 该库当前对焦点切换时机非常敏感
- `AppActivate` 并不能稳定保证整个录制窗口期都满足它的前台要求
- 对当前项目的“用户在多个窗口之间切换操作”目标仍然不匹配

### 12.4 WR-0.6 更新结论

到 WR-0.6 为止，可以确认：

- 本地 fork **可以修复发布版的 `exact_match` 缺陷**
- 但即使修完窗口匹配问题，**录制主链仍然不稳定**
- 当前本机最关键的新故障点是：
  - `WriteSample(...) -> HRESULT(0x80004005)`
  - 或 `Finalize(...) -> HRESULT(0xC00D4A44)`

因此：

- `windows-record` 当前 fork 版 **仍不满足进入 WR-1 的条件**
- 现阶段不能把它当成“只要修个 exact_match 就能替换当前内核”的方案

### 12.5 WR-0.6 后的建议

如果继续沿这条路线推进，下一步应进入一个更明确的 `WR-0.7 / 编码链定位`：

1. 继续在 fork 中细化这三段日志：
   - `convert_bgra_to_nv12`
   - `WriteSample`
   - `Finalize`
2. 评估是否需要尝试以下替换组合：
   - 改视频 encoder 类型
   - 改 `MF_MT_VIDEO_PROFILE`
   - 关闭 `MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS`
   - 关闭 `MF_TRANSFORM_ASYNC`
3. 如果 `WriteSample` 仍无法稳定通过，应暂停“替换当前录制内核”路线

更直接地说：

- WR-0.6 证明了 fork 有意义
- 但也证明了**当前问题已经进入 Media Foundation 编码链兼容性层面**
- 这已经不是一个“轻量替换”任务

## 13. WR-0.7 编码链定位结果

WR-0.7 的目标是继续缩小 `WriteSample / Finalize` 失败面，而不是替换主工程。

### 13.1 WR-0.7 对 fork / PoC 的增强

本轮给本地 fork 和 PoC 增加了可实验的编码链开关。

涉及文件：

- `tools/windows-record-fork/src/recorder/config.rs`
- `tools/windows-record-fork/src/processing/media.rs`
- `tools/windows-record-fork/src/processing/video.rs`
- `tools/windows-record-fork/src/processing/mod.rs`
- `tools/windows-record-fork/src/recorder/inner.rs`
- `tools/windows-record-poc/src/main.rs`
- `scripts/run-windows-record-poc.ps1`

新增可切换项包括：

- 编码器类型：`h264 / hevc`
- 视频 profile：`auto / h264-baseline / h264-main / h264-high / hevc-main`
- `enable_hardware_transforms`
- `disable_sink_throttling`
- `enable_low_latency`
- `enable_async_video_processor`
- `video_bitrate`

### 13.2 WR-0.7 实验矩阵

本轮主要围绕 `Codex` 窗口做了多组 5 秒录制：

1. `H.264 + default`
2. `H.264 + no hardware transforms`
3. `H.264 + no hardware transforms + no async + no low latency + sink throttling on`
4. `H.264 + main profile`
5. `H.264 + baseline profile + software-like组合`
6. `HEVC + software-like组合`
7. `H.264 + baseline profile`
8. `H.264 + default + no low latency`
9. `H.264 + main profile + no low latency`
10. `HEVC + default`

额外保留了 WR-0.6 的对照结果：

- `2560x1600` 默认链路会在 `WriteSample` 处失败
- `1920x1080` 默认链路更容易退化成 `Finalize -> 0 samples`

### 13.3 WR-0.7 新确认的结论

#### 13.3.1 关闭硬件 transforms 会在启动阶段直接失败

凡是带以下组合的实验：

- `--disable-hw-transforms`

都没有进入正常录制阶段，而是在启动阶段直接失败：

- `HRESULT(0xC00D36B4)`
- 含义是：媒体类型无效、不一致或不受支持

这说明：

- 对当前 crate / 当前机器而言，**关闭硬件 transforms 并不是一个可行的绕行方案**
- 如果后续继续用这条链，需要保留 `MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS = 1`

#### 13.3.2 在“硬件 transforms 保持开启”时，profile / low latency / encoder 的切换都没有解除 `WriteSample` 故障

以下组合仍然全部失败并产出 `0 bytes`：

- `H.264 + default`
- `H.264 + baseline`
- `H.264 + main`
- `H.264 + default + no low latency`
- `H.264 + main + no low latency`
- `HEVC + default`

它们的共同特征是：

- 启动可通过
- 采集线程能开始送样本
- 处理线程仍在极早阶段报：
  - `Failed to write video sample ... HRESULT(0x80004005)`

这说明：

- 单纯切 `H264/HEVC`
- 单纯切 `High/Main/Baseline`
- 单纯关闭 `low latency`

都不能解决当前机器上的写入兼容性问题。

#### 13.3.3 当前最有价值的定位结果

到 WR-0.7 为止，编码链已经被缩小成两类失败面：

1. **软件向配置**
   - 关闭硬件 transforms
   - 结果：启动即 `0xC00D36B4`

2. **硬件 transforms 保持开启的配置**
   - 不管是 H.264 还是 HEVC
   - 不管是 High/Main/Baseline
   - 不管 low latency 开或关
   - 结果：都能走到首批样本，但很快在 `WriteSample` 处 `0x80004005`

这意味着当前主要矛盾已经不是：

- 窗口匹配
- 焦点判断
- 默认分辨率
- profile 选择
- low latency 开关

而更像是：

- `DXGI surface sample -> sink writer` 这条路径本身与当前 Media Foundation 编码链不兼容

### 13.4 WR-0.7 更新结论

WR-0.7 之后，可以更明确地说：

- `windows-record` 的当前 fork 版仍然**不具备进入主工程替换的条件**
- 继续切 encoder/profile/low latency 已经没有太高收益
- 当前值得继续打的点，应该从“配置组合实验”转到“样本形态实验”

### 13.5 WR-0.7 后的建议

如果继续推进，下一步建议进入 `WR-0.8 / 样本形态验证`，重点不是再调 profile，而是验证：

1. 是否必须把 `DXGI surface sample` 改成 `CPU 内存 buffer sample`
2. 是否必须绕开当前 `NV12 + sink writer` 直写方案
3. 是否应直接验证：
   - `RGB32 -> sink writer`
   - `CPU copy -> contiguous buffer`
   - 或其他更保守的 MF 输入路径

换句话说：

- WR-0.7 基本排除了“只是编码器配置不对”这条假设
- 下一步应验证“样本承载方式是否就是根因”

## 14. WR-0.8 样本形态验证结果

WR-0.8 的目标不再是继续调 encoder/profile，而是直接验证：

- `DXGI surface sample -> sink writer` 是否就是当前机器上的根因
- 如果把同一份转换后的样本改成 `CPU 内存 buffer sample`，编码链能否恢复

### 14.1 WR-0.8 对 fork / PoC 的增强

本轮在本地 fork 和独立 PoC 中新增了 `video_sample_transport` 概念。

涉及文件：

- `tools/windows-record-fork/src/recorder/config.rs`
- `tools/windows-record-fork/src/recorder/mod.rs`
- `tools/windows-record-fork/src/lib.rs`
- `tools/windows-record-fork/src/recorder/inner.rs`
- `tools/windows-record-fork/src/processing/mod.rs`
- `tools/windows-record-fork/src/processing/video.rs`
- `tools/windows-record-poc/src/main.rs`
- `scripts/run-windows-record-poc.ps1`

新增可切换项：

- `--sample-transport dxgi|memory`

两种模式含义：

- `dxgi`
  - 直接把转换后的 DXGI-backed `IMFSample` 送进 sink writer
- `memory`
  - 先把样本转成 contiguous buffer
  - 再复制到 `MFCreateMemoryBuffer(...)` 生成的 CPU memory-backed `IMFSample`
  - 最后把这个内存样本送进 sink writer

### 14.2 WR-0.8 实验方式

为了避免 PowerShell 参数拼接干扰，本轮统一采用稳定的 `Start-Process -ArgumentList <array>` 方式运行 PoC。

代表性命令组合：

1. `Codex + 1920x1080 + sample-transport=memory`
2. `Codex + 2560x1600 + sample-transport=memory`
3. `Codex + 1920x1080 + sample-transport=dxgi` 作为对照组

### 14.3 WR-0.8 关键实验结果

#### 14.3.1 `sample-transport=memory` 首次稳定产出非空视频

实验：

- `Codex`
- `exact match`
- `duration = 5s`
- `audio = off`

结果一：

- `1920x1080 + memory`
- 输出文件：
  - `reports/windows-record-poc/wr08c-codex-1920-memory.mp4`
- 文件大小约：
  - `2020759 bytes`
- 日志关键行：
  - `Sample processing finished. Processed 134 frames in 4.9956733s`
  - `recording stopped`

结果二：

- `2560x1600 + memory`
- 输出文件：
  - `reports/windows-record-poc/wr08e-codex-2560-memory.mp4`
- 文件大小约：
  - `2499779 bytes`
- 日志关键行：
  - `Sample processing finished. Processed 150 frames in 4.9828481s`
  - `recording stopped`

这说明：

- 在同一台机器、同一目标窗口、同一编码链配置下
- 只要把样本承载方式改成 `CPU memory sample`
- `windows-record` 就能稳定写出非空 `mp4`

#### 14.3.2 `sample-transport=dxgi` 对照组仍然失败

对照实验：

- `Codex`
- `1920x1080`
- `sample-transport=dxgi`

结果：

- 输出文件：
  - `reports/windows-record-poc/wr08e-codex-1920-dxgi.mp4`
- 文件大小：
  - `0 bytes`
- 日志关键行：
  - `Sample processing finished. Processed 0 frames ...`
  - `Sink writer finalize failed after 0 frames ... HRESULT(0xC00D4A44)`

这与 WR-0.6 / WR-0.7 的失败形态保持一致。

### 14.4 WR-0.8 新确认的结论

到 WR-0.8 为止，可以确认：

- 当前机器上的关键兼容性问题 **不是单纯的 encoder/profile/low latency 配置**
- 当前机器上的关键兼容性问题 **也不只是 exact match、焦点或默认尺寸**
- 真正的决定性分界在于：
  - `DXGI surface sample -> sink writer` 会失败
  - `CPU memory-backed sample -> sink writer` 可以成功

换句话说：

- WR-0.8 基本证实了当前主要问题就是 **样本承载形态**
- 当前 fork 最有希望的继续路线，不是再切 profile，而是沿 `memory sample` 路线推进

### 14.5 WR-0.8 更新结论

WR-0.8 之后，判断已经足够明确：

- `windows-record` 仍然 **不能直接按当前默认 DXGI 样本链路接入主工程**
- 但它也不再是“整体不可用”
- 更准确的说法是：
  - **DXGI 样本路径在本机不可用**
  - **CPU memory sample 路径在本机已验证可行**

这使得 `windows-record` 从“当前不可用候选”转变为“可继续 fork 验证的候选”。

### 14.6 WR-0.8 后的建议

下一步不该直接进入主工程替换，而应进入一个更务实的 `WR-0.9 / memory 路径评估`：

1. 量化 `memory sample` 路线的 CPU/内存/吞吐代价
2. 验证不同分辨率和更长录制时长下的稳定性
3. 验证 stop/finalize 是否仍然稳定
4. 再决定：
   - 是否继续沿 fork 的 `memory sample` 路线推进
   - 还是暂停 `windows-record` 替换计划

更直接地说：

- WR-0.8 已经回答了“样本形态是不是根因”
- 答案是：**是**
- 现在真正该评估的是：**这条可行路径的性能成本是否能接受**
