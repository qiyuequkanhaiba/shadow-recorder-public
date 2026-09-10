# Shadow Recorder (Rust + NAPI-RS)

本仓库包含：

- Rust + NAPI-RS 的 `Shadow Recorder` 插件（Windows 全局点击事件记录 + 截图缓冲）
- 一个 `Electron + React + TypeScript` 桌面示例（可作为 ReqCaseIntelligence 子模块嵌入）

## Rust 导出接口

- `start_recording()`
- `stop_recording()`
- `get_buffer()`
- `get_buffer_since(last_id)`
- `set_config(config)`
- `get_metrics()`
- `subscribe_steps(callback)`
- `unsubscribe_steps()`

## Desktop 示例

请查看 `examples/desktop/README.md`，已包含：

- 统一 IPC 命名：`reqcase:shadow-recorder:*`
- Node 侧 `index.js / index.ts` 调用示例
- React 时间线数据契约（含红点标注坐标）
- 监控开始后最小化到系统托盘
- 报告导出按钮 + Mock AI 重现步骤接口

## Windows 构建环境问题

若出现 `link.exe` 或 `kernel32.lib` 缺失，请先处理本机工具链：

- 文档：`docs/windows-build-env.md`

## Windows 快速自检与构建

仓库提供了两个 PowerShell 脚本，方便快速定位和修复本机构建问题：

1. 环境自检（检查 `cargo/rustup/link/cl`、目标架构、已安装 target、`.node` 产物）  
   `powershell -ExecutionPolicy Bypass -File .\scripts\windows-env-check.ps1`
2. 一键构建原生插件（默认按 Node 架构自动选择 target）  
   `powershell -ExecutionPolicy Bypass -File .\scripts\windows-build-native.ps1`

可选参数：

- 指定架构：`-TargetArch x64` 或 `-TargetArch arm64`
- Release 构建：`-Release`
- 跳过环境检查（已在 VS Native Tools shell 内时可用）：`-SkipEnvCheck`

## 一键安全清理

仓库提供了一个可重复执行的安全清理脚本，只删除可再生成的构建产物、测试录制产物、WiX 中间目录和下载缓存，不会动源码、`examples/desktop/node_modules`、最终安装包和 `tools/ffmpeg/bin/ffmpeg.exe`。

- 预览将清理什么：  
  `powershell -ExecutionPolicy Bypass -File .\scripts\safe-clean-workspace.ps1 -DryRun`
- 直接清理：  
  `powershell -ExecutionPolicy Bypass -File .\scripts\safe-clean-workspace.ps1`

桌面示例目录也提供了快捷命令：

- `cd examples/desktop && npm run clean:safe:dry-run`
- `cd examples/desktop && npm run clean:safe`

构建完成后，脚本会确保兼容路径存在：

- `target/debug/shadow_recorder.node`（或 `target/release/shadow_recorder.node`）

这样 `examples/desktop/src-electron/native-binding.ts` 可以直接加载插件。
