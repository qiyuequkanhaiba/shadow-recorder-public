# ReqCase Shadow Recorder

[English](README.md)

ReqCase Shadow Recorder 是一款 Windows 桌面录制工具，用于本地屏幕采集、
操作和系统事件采集、回放及本地证据导出。仓库包含 Rust + NAPI-RS 原生插件和
Electron + React 桌面应用。

## 范围与状态

- 支持的平台：Windows。采集后端使用 Windows API，桌面安装包面向 Windows x64。
- 数据默认保留在本地设备，除非操作人员主动导出。项目不提供托管的录制或证据服务。
- 录制内容和导出的证据可能包含敏感信息。请在采集前使用隐私控制措施，并按敏感数据
  处理导出的文件。
- 软件按现状提供，不对证据包中的业务事实或业务正确性作出判断。

## 隐私

- 语义明文采集默认关闭，必须在桌面端隐私设置中明确选择
  `允许采集非密码文本` 后才会启用。
- 即使已启用明文采集，密码控件仍会被脱敏。
- 排除和遮罩规则只对之后的采集生效，不会改写已写入磁盘的视频或导出文件。
- 不要提交录制文件、证据导出、诊断包、剪贴板内容、本地路径、凭据或个人数据。公共
  边界审计和 Gitleaks 扫描会在 CI 中执行该策略。
- `v0.1.10` 安装包早于当前“语义明文采集必须显式启用”的默认策略。当该版本按其配置
  启用语义记录时，可能采集非密码语义明文；密码字段仍会被脱敏。`v0.1.10` 不是采用
  当前显式启用默认策略的构建。

## 在 Windows 上构建

安装当前版本的 Rust 工具链、Node.js 和 Visual Studio C++ 构建工具。执行原生环境检查
和插件构建：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows-env-check.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\windows-build-native.ps1
```

运行桌面应用：

```powershell
cd examples/desktop
npm install
npm run dev
```

有关 Electron 命令、打包和受支持的 FFmpeg 工作流，请参阅
[examples/desktop/README.md](examples/desktop/README.md)。

## 现有安装包

Windows EXE 和 MSI 安装包通过 GitHub Releases 发布，不会提交到本仓库。下载前，请验证
发布中的 `SHA256SUMS.txt`、公开源提交、FFmpeg 归属信息、签名状态和制品证明。只有当
安装包的运行时与构建源文件均与某个公开源提交一致时，才可以复用现有安装包。

## 文档

- [架构](docs/architecture.md)
- [Windows 构建环境](docs/windows-build-env.md)
- [发布检查清单](docs/release-checklist.md)
- [发布制品证明](docs/release-artifact-attestation-template.md)
- [v0.1.10 现有安装包证明](docs/releases/v0.1.10-artifact-attestation.md)
- [FFmpeg 归属信息](tools/ffmpeg/README.md)
- [安全策略](SECURITY.md)

## 安全

请在仓库启用私有 GitHub 漏洞报告流程后，通过该流程报告漏洞。请勿创建包含录制内容、
导出文件、诊断包或任何已采集敏感数据的公开 Issue。详见
[SECURITY.md](SECURITY.md)。

## 许可证与品牌

Copyright (c) 2026 ReqCase。源代码依据 [MIT License](LICENSE) 提供。ReqCase 名称、
`com.reqcase.shadowrecorder` 应用 ID 和 `reqcase:shadow-recorder:*` IPC 命名空间均为
保留的项目标识。第三方依赖及任何捆绑的 FFmpeg 二进制文件适用其各自许可证；参见
[NOTICE](NOTICE)。
