# 截图快捷键录入与悬浮条按钮

## 目标

设置页用按键录入三条截图快捷键。悬浮条展开后提供一颗框选按钮，行为与区域截图快捷键相同。

## 快捷键录入

三条截图快捷键仍是 `shortcutCaptureArea`、`shortcutCaptureMonitor`、`shortcutCaptureWindow`。未保存过时继续使用 `CommandOrControl+Shift+A`、`CommandOrControl+Shift+F`、`CommandOrControl+Shift+W`。空字符串继续表示关闭。开始录制和停止录制的输入框保持现在的文本输入，不改成按键录入。

截图输入框获得焦点后开始监听，失焦或写入一次后停止。监听期间先卸下三条截图快捷键，避免录入当前组合时又触发截图；失焦或写入后按保存结果重新注册。开始和停止录制的全局快捷键在监听期间仍然有效。

规则如下：

- 只接受带 Ctrl、Cmd、Alt 或 Shift 的组合键。单独的字母、数字或修饰键不写入。
- 修饰键按 `CommandOrControl`、`Alt`、`Shift` 的顺序拼接，再加主键。Ctrl 和 Cmd 都写成 `CommandOrControl`。
- 退格或 Esc 把该条保存为空字符串，从而关闭它。
- 与开始录制、停止录制，或另一条已生效的截图快捷键相同的组合不保存，输入框留在上一次成功的值。
- 按键重复不写入。

保存后仍走现有设置更新，由 `resolveScreenshotShortcuts` 和 `syncScreenshotHotkeys` 重新注册。冲突项继续进入 rejected，不注销开始和停止录制的快捷键。

## 悬浮条按钮

在现有动作区增加 `screenshot-btn`。待机、录制中和暂停时都显示。收起态不显示动作区，因此没有这颗按钮。

点击调用已经存在的 `beginAreaScreenshot`，进入框选。进行中的另一次点击仍由现有的截图互斥拒绝。按钮不在录制时禁用。全屏和窗口截图不放到悬浮条上。

现有按钮的 id、拖拽、悬停展开、双击打开主窗口、导出状态和录制中禁止导出都保持不变。悬浮窗继续 `focusable: false`，不调用 `setShape` 或 `SetWindowRgn`。

## 尺寸

收起尺寸保持 `58×34`。高度保持 `34`。展开宽度在现有值上增加一颗按钮所占的位置：按钮 `26px`，间距 `3px`。因此待机展开从 `128` 改为 `157`，录制和暂停展开从 `178` 改为 `207`。动作区的最大宽度同步增加 `29px`，避免新按钮被裁掉。UI scale 仍乘在这些核心尺寸上。

## 测试

- 纯函数把键盘事件转成加速键，并覆盖退格清空、无修饰键拒绝、Ctrl 写成 `CommandOrControl`。
- 悬浮条布局测试改为新的展开宽度，并断言页面包含 `screenshot-btn` 和 `beginAreaScreenshot`。
- 现有截图快捷键冲突测试继续通过。

## 不做

不新增第四条截图动作，不改倒计时、标注、贴屏和历史，不改循环录像，不改安装包哈希。
