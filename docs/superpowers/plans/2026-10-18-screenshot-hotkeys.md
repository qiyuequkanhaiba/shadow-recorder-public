# 快捷键截图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 用三条全局快捷键截取区域、光标所在屏幕或光标下的窗口，并复制或保存成 PNG。

**Architecture:** 像素裁剪、遮罩涂黑和 PNG 编码在 Rust。Electron 主进程注册快捷键、弹出可聚焦的选区层，并把 DIP 坐标换成物理像素后调用 `captureScreenshot`。设置页只增加快捷键字段和一颗「框选截图」按钮。循环录像的 ffmpeg 进程不参与截图。

**Tech Stack:** Rust DXGI 单帧、Electron `globalShortcut` / 剪贴板 / 保存对话框、React 设置页、`tsx` 脚本测试。

## Global Constraints

- 悬浮条保持 `focusable: false`，不恢复 `SetWindowRgn`。截图选区是另一扇可聚焦的窗口。
- 不改 gdigrab 监督循环，不把循环录像换成 DXGI / WGC。
- 语义明文缺省保持关闭。
- 不恢复证据 ZIP 里的 HTML、manifest 或校验文件。
- 不改 `release-notes-0.1.17.md` 里的安装包 SHA-256。
- 隐私未启用时，即使填了矩形，也不往截图里涂黑。
- 证据包里的步骤缩略图不是这次的用户截图，不改那条链路。
- 默认快捷键是 `CommandOrControl+Shift+A`、`CommandOrControl+Shift+F`、`CommandOrControl+Shift+W`。不得占用已经使用的开始键和停止键。
- 滚动长图、OCR、美化、去背景、上传和 GIF 仍不做。跨屏拼接、3/5 秒倒计时、矩形/箭头/文字/实心打码、贴屏和本地历史见 Task 3。

## File structure

- `src/screenshot.rs`：把屏幕坐标裁进 BGRA 帧，按隐私开关涂黑，编码 PNG。
- `src/dxgi.rs`：为截图抓一块显示器的 BGRA，不走黑帧熔断。按物理坐标找显示器和窗口。
- `src/lib.rs`：导出 `captureScreenshot`。
- `examples/desktop/src-electron/screenshot-capture.ts`：快捷键冲突、DIP 选区和物理像素矩形。
- `examples/desktop/src-electron/screenshot-hotkeys.ts`：注册和注销三条全局快捷键。
- `examples/desktop/src-electron/screenshot-overlay-html.ts`：选区层页面。
- `examples/desktop/src-electron/screenshot-session.ts`：选区窗、抓图、复制、保存。
- `examples/desktop/src-electron/modules/reqcase-shadow-recorder/ipc.ts`：把快捷键和选区 IPC 接到现有设置更新。
- `examples/desktop/src-react/components/RecorderControlPanel.tsx`：快捷键输入和框选按钮。
- `examples/desktop/types/contracts.ts` 与 `ipc-validators.ts`：三个新字段能通过设置校验并保存。

---

### Task 1: 裁剪、涂黑和 PNG

**Files:**
- Create: `src/screenshot.rs`
- Modify: `src/dxgi.rs`
- Modify: `src/lib.rs`
- Test: `src/screenshot.rs` 内的 `mod tests`

**Interfaces:**
- Consumes: `MaskRegion`、`capture_desktop_bgra`。
- Produces: `capture_screenshot(request) -> Result<ScreenshotCaptureOutput, String>`。`captureScreenshot` 的请求字段是 `mode`、`x`、`y`、`width`、`height`、`privacyEnabled`、`masks`。返回 `pngBase64`、`width`、`height`、`originX`、`originY`。`mode` 只接受 `region`、`monitor`、`window`。

- [x] **Step 1: 写失败测试**

断言：选区超出显示器时被裁掉；裁剪只复制选中的 BGRA 像素；隐私开启时重叠矩形变成不透明黑，关闭时像素不变；输出 PNG 能被解码。

- [x] **Step 2: 跑测试确认失败**

Run: Windows 虚拟机 `cargo test --lib screenshot::`
Expected: 模块不存在，FAIL。

- [x] **Step 3: 实现裁剪和单帧抓取**

区域按中心点所在显示器裁切。全屏和窗口模式用物理坐标找目标，再裁到该显示器内。截图路径不调用黑帧熔断。

- [x] **Step 4: 跑测试**

Run: `cargo test --lib screenshot::`
Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add src/screenshot.rs src/dxgi.rs src/lib.rs
git commit -m "feat: crop a screenshot frame and burn privacy masks"
```

### Task 2: 快捷键、选区层和设置

**Files:**
- Create: `examples/desktop/src-electron/screenshot-capture.ts`
- Create: `examples/desktop/src-electron/screenshot-hotkeys.ts`
- Create: `examples/desktop/src-electron/screenshot-overlay-html.ts`
- Create: `examples/desktop/src-electron/screenshot-session.ts`
- Create: `examples/desktop/scripts/screenshot-capture-test.ts`
- Modify: `examples/desktop/package.json`
- Modify: `examples/desktop/src-electron/native-binding.ts`
- Modify: `examples/desktop/src-electron/preload.ts`
- Modify: `examples/desktop/src-electron/modules/reqcase-shadow-recorder/ipc.ts`
- Modify: `examples/desktop/src-electron/modules/reqcase-shadow-recorder/ipc-validators.ts`
- Modify: `examples/desktop/types/contracts.ts`
- Modify: `examples/desktop/src-react/lib/i18n.ts`
- Modify: `examples/desktop/src-react/components/RecorderControlPanel.tsx`

**Interfaces:**
- Consumes: `captureScreenshot`，以及 Task 1 的遮罩字段。
- Produces: `resolveScreenshotShortcuts`、`physicalRectFromDipCorners`、`unionDisplayBounds`。选区层快捷键是 Enter 复制、Ctrl+S 或 Cmd+S 保存、Esc 取消。即时的全屏和窗口截图直接复制到剪贴板。

- [x] **Step 1: 写失败测试**

`screenshot-capture-test.ts` 断言缺省三条快捷键、与开始/停止冲突时丢弃冲突项、空字符串表示关闭、DIP 角点换成物理矩形、选区校验拒绝零尺寸。页面源码包含「Enter 复制」「Esc 取消」，选区窗是 `focusable: true`，并且抓图前会隐藏选区层。设置 schema 含三个新字段。

- [x] **Step 2: 跑测试确认失败**

Run: `examples/desktop/node_modules/.bin/tsx examples/desktop/scripts/screenshot-capture-test.ts`
Expected: 模块不存在，FAIL。

- [x] **Step 3: 接上主进程、预加载和设置页**

未保存过的快捷键用缺省值。用户把输入清空则关闭该条。框选按钮调用 `beginAreaScreenshot`。

- [x] **Step 4: 跑测试**

Run: `examples/desktop/node_modules/.bin/tsx scripts/screenshot-capture-test.ts`
Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add examples/desktop/src-electron/screenshot-capture.ts examples/desktop/src-electron/screenshot-hotkeys.ts examples/desktop/src-electron/screenshot-overlay-html.ts examples/desktop/src-electron/screenshot-session.ts examples/desktop/scripts/screenshot-capture-test.ts examples/desktop/package.json examples/desktop/src-electron/native-binding.ts examples/desktop/src-electron/preload.ts examples/desktop/src-electron/modules/reqcase-shadow-recorder/ipc.ts examples/desktop/src-electron/modules/reqcase-shadow-recorder/ipc-validators.ts examples/desktop/types/contracts.ts examples/desktop/src-react/lib/i18n.ts examples/desktop/src-react/components/RecorderControlPanel.tsx docs/superpowers/plans/2026-10-18-screenshot-hotkeys.md
git commit -m "feat: capture a region, screen, or window from a hotkey"
```

### Task 3: 跨屏拼接、倒计时、标注、贴屏和本地历史

**Files:**
- Modify: `src/dxgi.rs`
- Modify: `src/screenshot.rs`
- Modify: `examples/desktop/src-electron/screenshot-capture.ts`
- Modify: `examples/desktop/src-electron/screenshot-overlay-html.ts`
- Modify: `examples/desktop/src-electron/screenshot-session.ts`
- Modify: `examples/desktop/src-electron/preload.ts`
- Modify: `examples/desktop/src-electron/modules/reqcase-shadow-recorder/ipc.ts`
- Modify: `examples/desktop/src-electron/modules/reqcase-shadow-recorder/ipc-validators.ts`
- Modify: `examples/desktop/types/contracts.ts`
- Modify: `examples/desktop/src-react/lib/i18n.ts`
- Modify: `examples/desktop/src-react/components/RecorderControlPanel.tsx`
- Modify: `examples/desktop/scripts/screenshot-capture-test.ts`

**Interfaces:**
- 框选模式把所有相交显示器拼进同一张 PNG。缝隙保持黑色。隐私开启时，遮罩按选区原点涂黑。
- `screenshotDelaySeconds` 只接受 3 或 5，其余值当作关闭。倒计时期间按 Esc 取消。
- 复制、保存和贴屏使用画布上的标注结果。历史最多保留 30 张，写在 `userData/screenshot-history`。

- [x] **Step 1: 写拼接、倒计时和历史上限测试**

`composite_screenshot_png_stitches_adjacent_monitors` 断言相邻两帧拼成一张，并且落在右帧上的遮罩被涂黑。脚本断言倒计时只认 3 和 5，历史上限按时间丢掉最旧的一张，选区页包含矩形、箭头、文字、打码和贴在屏幕上。

- [x] **Step 2: 接上抓图、预加载和设置页**

抓图前先倒计时，倒计时窗口关掉后再等 80 毫秒。复制和保存接受画布 PNG。贴屏是独立的置顶窗口。设置页可以选择倒计时、打开截图目录，并把最近的图贴回屏幕。

- [x] **Step 3: 跑测试**

Run: `examples/desktop/node_modules/.bin/tsx examples/desktop/scripts/screenshot-capture-test.ts`
Expected: PASS。

Run: `examples/desktop/node_modules/.bin/tsc -p examples/desktop/tsconfig.electron.json --noEmit`
Expected: 通过。

Run: Windows 虚拟机 `cargo test --lib screenshot::`
Expected: 5 passed。

- [x] **Step 4: Commit**

```bash
git add src/dxgi.rs src/screenshot.rs examples/desktop/src-electron/screenshot-capture.ts examples/desktop/src-electron/screenshot-overlay-html.ts examples/desktop/src-electron/screenshot-session.ts examples/desktop/src-electron/preload.ts examples/desktop/src-electron/modules/reqcase-shadow-recorder/ipc.ts examples/desktop/src-electron/modules/reqcase-shadow-recorder/ipc-validators.ts examples/desktop/types/contracts.ts examples/desktop/src-react/lib/i18n.ts examples/desktop/src-react/components/RecorderControlPanel.tsx examples/desktop/scripts/screenshot-capture-test.ts docs/superpowers/plans/2026-10-18-screenshot-hotkeys.md
git commit -m "feat: stitch screenshots across monitors and keep a local history"
```
