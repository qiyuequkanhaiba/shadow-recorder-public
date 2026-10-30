# F1 修复前

## 测量

Windows 11 虚拟机（Parallels，正在运行）只有一块显示器。`prlctl set video` 不能加第二块屏。三组双屏操作（两块都是 100%、一块 100% 一块 150%、截完再改缩放或拔掉副屏）没有跑。

`f1-list-screens.ps1` 在虚拟机里的输出：

```
count=1
device=\\.\DISPLAY1 primary=True bounds=0,0,1199,770 work=0,0,1199,722
desktopDpi=96
```

物理机的显示器配置这次没有收到。

## 代码里能确定的事

`beginAreaScreenshot` 每次都会先关掉选区窗口再新建。不是旧窗口留着没更新。

旧的 `ensureOverlay` 用所有显示器 DIP 矩形的并集，只开一个 `BrowserWindow`（`enableLargerThanScreen: true`）。Windows 上一个窗口只有一份 DPI。窗口跨过缩放不同的屏幕时，系统给它的实际大小会小于请求的并集，并集外面没有选区层，所以只能在一部分区域里拖选。

这次没有双屏的 `getBounds()` 对比日志，因为虚拟机里没有第二块屏，看不到窗口被缩小后的像素。

## 根因

不是窗口缓存。是整张虚拟桌面共用一个选区窗口。
