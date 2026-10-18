# 视频遮罩与回放审阅 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把隐私遮罩画进新的循环录像片段，并让工作室回放可以按 1 / 1.5 / 2 倍速和逐帧审阅。

**Architecture:** 遮罩仍用现有的屏幕坐标矩形。开始会话和更新录制配置时，把「隐私是否启用 + 遮罩矩形」写进活动会话；ffmpeg 在 gdigrab 输入之后追加 `drawbox`，坐标先减去采集区域左上角，再裁到画面内。回放倍速和逐帧是播放器上的纯函数，不改视频文件。

**Tech Stack:** Rust 会话与 ffmpeg 参数、Electron 配置同步、React 回放条、`tsx` 脚本测试。

## Global Constraints

- 语义明文缺省保持关闭。
- 不恢复证据 ZIP 里的 HTML、manifest 或校验文件。
- 不改 `release-notes-0.1.17.md` 里的安装包 SHA-256。
- 悬浮条保持 `focusable: false`，不恢复 `SetWindowRgn`。
- 遮罩只作用于之后新开的 ffmpeg 片段，不改写已经落盘的 mp4。
- 隐私未启用时，即使填了矩形，也不往视频里画框。
- 这一轮不把循环录像从 gdigrab 换成 DXGI / WGC，不加入系统声或麦克风，不做屏幕文字索引。

## 后续方案（本计划不实施）

这些是对照主流之后仍要做的事，单独开计划，并在 Windows 上验证后再动采集进程。

- 窗口跟随：循环录像改用能跟着窗口走的捕获，拖动窗口时不要重启编码器。设置里的 DXGI / WGC 要和这段 mp4 是同一条链路。
- 声音：系统声和麦克风分成两路可选，缺省关闭，时间轴与视频对齐。
- 画面搜索：对关键帧做本地文字索引，和语义步骤并列，不上传画面。
- 多显示器：两路视频用同一时间码并排。
- 主导出裁切：时间轴入点出点同时用于 ZIP 和缺陷包。
- 补打码：回放里框选，只模糊导出副本，原片保留。
- 按键提示：用已采集的按键事件叠在画面角落，不新采集明文。

## File structure

- `src/privacy.rs`：把遮罩矩形裁进采集画面，并生成 ffmpeg `drawbox` 滤镜。
- `src/session/models.rs`：会话记录保存 `video_privacy_enabled` 和 `video_privacy_masks`。
- `src/session/manager.rs`：开录前接收遮罩，配置更新时写回活动会话。
- `src/recorder.rs` 与 `src/lib.rs`：从当前录制配置读取遮罩，开录和更新视频配置时送进会话。
- `src/session/ffmpeg_loop_runtime.rs`：遮罩变化时重启采集，并在 gdigrab 参数后追加滤镜。
- `examples/desktop/src-electron/modules/reqcase-shadow-recorder/service.ts`：隐私开关或矩形变化时刷新活动会话。
- `examples/desktop/src-react/lib/playback-review.ts`：倍速循环和逐帧步长。
- `examples/desktop/src-react/components/RecorderPlaybackStage.tsx`：回放条上的倍速和逐帧按钮。

---

### Task 1: 回放倍速和逐帧

**Files:**
- Create: `examples/desktop/src-react/lib/playback-review.ts`
- Create: `examples/desktop/scripts/playback-review-test.ts`
- Modify: `examples/desktop/package.json`
- Modify: `examples/desktop/src-react/components/RecorderPlaybackStage.tsx`
- Modify: `examples/desktop/scripts/floating-toolbar-layout-test.ts`

**Interfaces:**
- Consumes: 播放条已有的 `handleSeekByDelta`、空格和左右 5 秒。
- Produces: `nextPlaybackRate(current: number): 1 | 1.5 | 2`，`playbackFrameRate(profile?: string | null): number`，`frameStepMs(framesPerSecond: number, direction: -1 | 1): number`。

- [x] **Step 1: 写失败测试**

`examples/desktop/scripts/playback-review-test.ts` 断言：`nextPlaybackRate(1)` 为 `1.5`，`nextPlaybackRate(1.5)` 为 `2`，`nextPlaybackRate(2)` 为 `1`，未知值回到 `1.5`。`playbackFrameRate('efficiency'|'balanced'|'smooth')` 分别为 `7`、`14`、`20`。`frameStepMs(14, 1)` 为 `71`，`frameStepMs(14, -1)` 为 `-71`。

- [x] **Step 2: 跑测试确认失败**

Run: `examples/desktop/node_modules/.bin/tsx examples/desktop/scripts/playback-review-test.ts`
Expected: 模块不存在，FAIL。

- [x] **Step 3: 实现纯函数并接到回放条**

倍速只在 `1`、`1.5`、`2` 之间循环。逐帧步长与 `resolve_recording_profile_capture_params` 的帧率一致：efficiency 7、balanced 14、smooth 20。回放条增加「倍速」「上一帧」「下一帧」。`,` 和 `.` 逐帧，且输入框里不拦截。逐帧时先暂停。已有的 -5 秒、+5 秒、空格和全屏保持不变。`package.json` 增加 `test:playback-review`。

- [x] **Step 4: 跑测试**

Run: `examples/desktop/node_modules/.bin/tsx scripts/playback-review-test.ts` 和 `scripts/floating-toolbar-layout-test.ts`
Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add examples/desktop/src-react/lib/playback-review.ts examples/desktop/scripts/playback-review-test.ts examples/desktop/package.json examples/desktop/src-react/components/RecorderPlaybackStage.tsx examples/desktop/scripts/floating-toolbar-layout-test.ts
git commit -m "feat: review playback at faster speeds and one frame at a time"
```

### Task 2: 把遮罩画进新的录像片段

**Files:**
- Modify: `src/privacy.rs`
- Modify: `src/session/models.rs`
- Modify: `src/session/manager.rs`
- Modify: `src/recorder.rs`
- Modify: `src/lib.rs`
- Modify: `src/session/ffmpeg_loop_runtime.rs`
- Modify: `examples/desktop/src-electron/modules/reqcase-shadow-recorder/service.ts`
- Modify: `examples/desktop/src-react/features/privacy/PrivacySettingsPanel.tsx`
- Modify: 所有直接构造 `TestSessionRecord` 的测试字面量

**Interfaces:**
- Consumes: `RecorderConfig.privacy_enabled` 和 `mask_regions`。
- Produces: `build_video_privacy_drawbox_filter(enabled, masks, offset_x, offset_y, capture_width, capture_height) -> Option<String>`。`SessionManager::stage_video_privacy(enabled, masks)`。会话字段 `video_privacy_enabled: bool`、`video_privacy_masks: Vec<MaskRegion>`，serde 缺省为关闭和空列表。

- [x] **Step 1: 写滤镜测试**

在 `src/privacy.rs` 的测试里覆盖：未启用返回 `None`；完全落在画面内时输出 `drawbox=x=10:y=20:w=30:h=40:color=black:t=fill`；采集偏移 `(100, 50)` 时矩形从屏幕坐标换成画面坐标；超出画面的部分被裁掉；完全在画面外或宽高为 0 时不出现在滤镜里；两个矩形用逗号连接。

- [x] **Step 2: 实现滤镜并写入会话**

`MaskRegion` 增加 serde。`build_video_privacy_drawbox_filter` 只用整数，不把标签写进滤镜。`Recorder::video_privacy_masks()` 返回当前配置。`start_test_session` 在 `start` 之前 `stage_video_privacy`。`start` 把暂存遮罩抄进新会话并写入 manifest。`update_active_test_session_video_config` 每次用当前遮罩调用 `update_active_video_config` 的第四个参数 `Option<(bool, Vec<MaskRegion>)>`。`SessionVideoConfigState` 带上这两个字段，变化时重启 ffmpeg。`spawn_capture_run` 在 gdigrab 的 `-i` 和 `-an` 之后、编码器参数之前追加 `-vf`。`service.ts` 的 `setConfig` 在隐私开关或矩形变化时也调用 `updateActiveTestSessionVideoConfig`，并且先 `setRecorderConfig`。隐私设置文案改为：启用后，新的录像片段会把遮罩画进视频；已经写好的片段不会改。

- [x] **Step 3: 补会话测试**

`manager` 测试先 `stage_video_privacy(true, 一个矩形)` 再 `start`，断言会话和没有新的生命周期事件。已有的 `update_active_video_config` 调用补上 `None`。

- [x] **Step 4: 说明本机限制**

这台机器编不过 `windows` crate，`cargo test` 不能在这里当作通过。不要为了让 Mac 编译而删掉 Win32 依赖。

- [x] **Step 5: Commit**

```bash
git add src/privacy.rs src/session/models.rs src/session/manager.rs src/recorder.rs src/lib.rs src/session/ffmpeg_loop_runtime.rs src/session/video_ring.rs src/session/uia_observer.rs src/types.rs examples/desktop/src-electron/modules/reqcase-shadow-recorder/service.ts examples/desktop/src-react/features/privacy/PrivacySettingsPanel.tsx
git commit -m "feat: burn privacy masks into new recording segments"
```
