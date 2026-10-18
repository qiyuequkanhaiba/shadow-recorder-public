# 截图快捷键录入与悬浮条按钮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 用按键录入三条截图快捷键，并在悬浮条展开后提供框选按钮。

**Architecture:** 键盘事件到 Electron 加速键的转换放在 `screenshot-capture.ts`。设置页监听期间通过 IPC 卸下三条截图快捷键，失焦后按已保存配置重新注册。悬浮条按钮调用现有的 `beginAreaScreenshot`。

**Tech Stack:** Electron `globalShortcut`、React 设置页、现有悬浮条布局测试。

## Global Constraints

- 未保存的三条截图快捷键仍是 `CommandOrControl+Shift+A`、`CommandOrControl+Shift+F`、`CommandOrControl+Shift+W`。空字符串关闭。
- 开始和停止录制的输入框保持文本输入。
- 监听期间卸下三条截图快捷键。开始和停止录制的全局快捷键仍然有效。
- 悬浮窗保持 `focusable: false`，不调用 `setShape` 或 `SetWindowRgn`。
- 收起尺寸保持 `58×34`。待机展开 `157`，录制和暂停展开 `207`。动作区最大宽度增加 `29px`。
- 不改倒计时、标注、贴屏、历史、循环录像和安装包哈希。

### Task 1: 按键录入

**Files:**
- Modify: `examples/desktop/src-electron/screenshot-capture.ts`
- Modify: `examples/desktop/src-electron/screenshot-hotkeys.ts`
- Modify: `examples/desktop/src-electron/preload.ts`
- Modify: `examples/desktop/src-electron/modules/reqcase-shadow-recorder/ipc.ts`
- Modify: `examples/desktop/src-react/components/RecorderControlPanel.tsx`
- Test: `examples/desktop/scripts/screenshot-capture-test.ts`

**Interfaces:**
- Produces: `acceleratorFromKeyboardEvent(event) => string | null`，空字符串表示关闭，`null` 表示忽略。
- Produces: `canAssignScreenshotShortcut(kind, accelerator, config) => boolean`
- Produces: `suspendScreenshotHotkeys()`，以及 IPC `reqcase:screenshot:suspend-hotkeys` / `reqcase:screenshot:resume-hotkeys`

- [x] **Step 1: 写失败测试并实现**

Ctrl+Shift+A 写成 `CommandOrControl+Shift+A`。没有修饰键返回 `null`。退格返回空字符串。重复按键返回 `null`。已被另一条截图快捷键或开始录制占用的组合不能分配。

- [x] **Step 2: 跑测试**

Run: `examples/desktop/node_modules/.bin/tsx examples/desktop/scripts/screenshot-capture-test.ts`
Expected: PASS。

### Task 2: 悬浮条框选按钮

**Files:**
- Modify: `examples/desktop/src-electron/floating-toolbar-layout.ts`
- Modify: `examples/desktop/src-electron/floating-toolbar.ts`
- Test: `examples/desktop/scripts/floating-toolbar-layout-test.ts`

**Interfaces:**
- Consumes: `beginAreaScreenshot`
- Produces: `screenshot-btn`，待机、录制中和暂停都显示。

- [x] **Step 1: 加按钮并改尺寸**

待机展开 `157`，录制和暂停展开 `207`。动作区最大宽度 `169px`。点击调用 `beginAreaScreenshot`。

- [x] **Step 2: 跑测试**

Run: `examples/desktop/node_modules/.bin/tsx examples/desktop/scripts/floating-toolbar-layout-test.ts`
Expected: PASS。

Run: `examples/desktop/node_modules/.bin/tsc -p examples/desktop/tsconfig.electron.json --noEmit`
Expected: 通过。
