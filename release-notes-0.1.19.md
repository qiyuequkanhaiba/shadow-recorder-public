源码：1ab42814d148470c41c36a16f3bbf2da77273742（qiyuequkanhaiba/shadow-recorder-public）

安装包在本地 Windows 11 虚拟机中从这份公开源码生成，没有通过 GitHub Actions。

## 安装包

• ShadowRecorder-Setup-0.1.19-x64.exe
• SHA-256：ed59a6d7f628c1b43197f44404720bca01917986c68a5709d5b5d13f47a20090
• 未做 Authenticode 签名

• ShadowRecorder-0.1.19-x64.msi
• SHA-256：1c69754930855ce8e6e8f558bb5b475317e2bb00d6192b9f7f25e03197fbf1b0
• 未做 Authenticode 签名

## 内容

• 矩形截图时，鼠标停在顶层窗口上会自动框住该窗口。点一下就截取这个窗口，按住拖动仍是自由框选
• 截图冻结后的操作栏末尾增加对号和叉号，分别对应复制和取消
• 程序图标换成圆角浅色图标
• 已经中断、实际不在录制的会话，打开历史与回顾时不再显示为正在录制，可以清除
• 退出程序时会停止正在进行的录制

## FFmpeg

安装包内的 ffmpeg.exe SHA-256 为 227af0691433b703ffc5725e47f7d06eefc34b4a72e7870e73d30e2cda483ecf。
它来自 Gyan.dev 的 ffmpeg-9.0-essentials_build.zip（GPL）。
