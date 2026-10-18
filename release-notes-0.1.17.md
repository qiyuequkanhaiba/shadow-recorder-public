源码：b3d4b7b98dfa6e7a8b900b11edf54d7da09fa280（qiyuequkanhaiba/shadow-recorder-public）

安装包在本地 Windows 11 虚拟机中从这份公开源码生成，没有通过 GitHub Actions。

## 安装包

• ShadowRecorder-Setup-0.1.17-x64.exe
• SHA-256：69bad1a4ff0f04e2b4e5675b8143ef23c4faded52ef167f0448a0073fdc6bc19
• 未做 Authenticode 签名

• ShadowRecorder-0.1.17-x64.msi
• SHA-256：288645490eea97561815a80e29b20dbb97805aff9139a0a1206b7d791e6eab6a

## 内容

• 彻底解决桌面悬浮窗在失焦、主窗口失去焦点或调出系统原生文件对话框时的非客户区蓝框/白色标题栏残留问题
• 原生拦截 WM_ACTIVATEAPP / WM_ACTIVATE / WM_NCACTIVATE / WM_NCPAINT / WM_ERASEBKGND，阻断 Chromium HWNDMessageHandler 在多线程激活切换时错误触发的 DefWindowProc 标题栏重绘
• 注入 DWMWA_WINDOW_CORNER_PREFERENCE(DWMWCP_DONOTROUND)、DWMWA_NCRENDERING_POLICY(DWMNCRP_DISABLED)、DWMWA_CAPTION_COLOR 与 DWMWA_BORDER_COLOR 防护，消除 Windows 11 DWM 自动圆角与强调色回退机制
• 剔除腐蚀 DWM Per-Pixel Alpha 混合通道的 Win32 SetWindowRgn 破损调用，保障全透明胶囊在任意窗口聚焦与失焦场景下 100% 像素级纯净透明
• 当前实现（2026-10-18）：滚出环形窗口的录像切片会保留到 video/retained，可按段数或小时清理
• 主工作室时间轴显示保留窗口内的切片，不再只保留最新 72 段
• 历史回放和语义步骤分开打开
• 会话 ZIP 只包含合成视频、events.json 和 operations.json
• 导出进度会收到完成、取消或失败终态，主窗口只显示一条通知
• 语义明文采集默认仍然关闭

## FFmpeg

安装包内的 ffmpeg.exe SHA-256 为 3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec。
它来自 Gyan.dev 的 ffmpeg-release-essentials.zip（GPL）。
