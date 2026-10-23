源码：1af5c99a548d90a5ce0ad5cf2b27fcfb2ebd9369（qiyuequkanhaiba/shadow-recorder-public）

安装包在本地 Windows 11 虚拟机中从这份公开源码生成，没有通过 GitHub Actions。

## 安装包

• ShadowRecorder-Setup-0.1.21-x64.exe
• SHA-256：a20ca58ed0cea58dbf68a73a53230bf7a73a7c108d48217fe6b63f2671f8b210
• 未做 Authenticode 签名

• ShadowRecorder-0.1.21-x64.msi
• SHA-256：7f8944d08334dead90ac6b2b1d9bc5fd7d3ff535821ea57c5626834be3e24880
• 未做 Authenticode 签名

## 内容

• 新增视频选区截取导出能力（支持入点与出点精确剪辑，以及快速分段导出）
• 优化三轨时间轴交互：支持在时间轴画布直接指针拖拽框选、双击分段一键选区、顶部内联选区控制栏与循环播放
• 瘦身播放器底部控制坞：上一帧/下一帧升级为紧凑矢量图标，入出点按键升级为胶囊样式
• 优化画布遥测数据显示：空闲与回放模式下自动折叠为单行胶囊，避免遮挡画面；录制时自动展开
• 历史会话回顾切片条支持 Shift+点击连续多选批量导出，未命名会话标题去重优化
• 桌面悬浮灵动岛微交互增强：鼠标悬停拖拽手柄显示已录制时长轻提示，右键导出切换回溯预设增加弹性动效

## FFmpeg

安装包内的 ffmpeg.exe SHA-256 为 3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec。
它来自 www.gyan.dev 的 release-essentials 构建，版本 9.0.2-essentials_build-www.gyan.dev（GPL v3）。
