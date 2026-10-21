源码：99548b4ea12137c241cfe83b1a4a60b63799bfb6（qiyuequkanhaiba/shadow-recorder-public）

安装包在本地 Windows 11 虚拟机中从这份公开源码生成，没有通过 GitHub Actions。

## 安装包

• ShadowRecorder-Setup-0.1.20-x64.exe
• SHA-256：76fcb8b27cfb5c7a1f77a44709a6bdc9f67a4e8f6c658526009400ff4f29ed51
• 未做 Authenticode 签名

• ShadowRecorder-0.1.20-x64.msi
• SHA-256：737bac1845d1341c3c6caebccafebffccc93bb898b81149f08083fba12dad3f4
• 未做 Authenticode 签名

## 内容

• 截图标注改为按住鼠标左键拖动，松开后图形固定
• 马赛克在拖动过程中直接打马赛克，不再画出和矩形相同的彩色边框
• 上一笔若没有收到松开事件，下一次按下只固定该笔，不会同时开始新图形

## FFmpeg

安装包内的 ffmpeg.exe SHA-256 为 3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec。
它来自 www.gyan.dev 的 release-essentials 构建，版本 9.0.2-essentials_build-www.gyan.dev（GPL v3）。
