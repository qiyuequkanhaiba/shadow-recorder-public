# Windows 构建环境修复（`link.exe` / `kernel32.lib`）

当 Rust Windows `msvc` 目标报错：

- `link.exe not found`
- `kernel32.lib not found`

本质原因通常是：缺少 Visual C++ Build Tools 或未在正确的 VS 开发者环境中构建。

## 1) 安装必须组件

安装 **Visual Studio 2022 Build Tools**（不是 VS Code）：

1. 下载：<https://visualstudio.microsoft.com/visual-cpp-build-tools/>
2. 勾选工作负载：`Desktop development with C++`
3. 确认包含：
   - `MSVC v143 - VS 2022 C++ x64/x86 build tools`
   - `Windows 10 SDK (10.0.19041.0+)` 或 `Windows 11 SDK`

## 2) 使用正确终端编译

优先使用：`x64 Native Tools Command Prompt for VS 2022`

在该终端执行：

```powershell
rustup default stable-x86_64-pc-windows-msvc
rustup target add x86_64-pc-windows-msvc
cargo build
```

## 3) 快速自检

```powershell
where link
where cl
echo $env:WindowsSdkDir
echo $env:VCToolsInstallDir
rustup show
node -p "process.arch"
```

预期：

- `where link` 能定位到 `...\VC\Tools\MSVC\...\link.exe`
- `WindowsSdkDir` 非空
- `process.arch` 与 Rust target 架构匹配（常见是 `x64`）

## 4) 仍报 `kernel32.lib not found`

先注入 VS 环境，再开 PowerShell：

```cmd
"C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x64
powershell
```

然后重新执行 `cargo build`。

## 5) 架构一致性建议

- Node/Electron 是 `x64`：建议 Rust 用 `x86_64-pc-windows-msvc`
- Node/Electron 是 `arm64`：Rust 用 `aarch64-pc-windows-msvc`，并安装 ARM64 对应 MSVC/SDK

## 6) 使用仓库内置脚本

在仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows-env-check.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\windows-build-native.ps1
```

说明：

- `windows-env-check.ps1` 会输出：工具链可用性、建议 target、已安装 target、已存在 `.node` 产物路径。
- `windows-build-native.ps1` 会按 Node 架构自动选 target 并执行 `cargo build --target ...`。
- 构建脚本会将生成的 `.node` 对齐到兼容路径（`target/debug` 或 `target/release`），便于 Electron 示例直接加载。

常用参数示例：

```powershell
# 强制 x64 target
powershell -ExecutionPolicy Bypass -File .\scripts\windows-build-native.ps1 -TargetArch x64

# Release 构建
powershell -ExecutionPolicy Bypass -File .\scripts\windows-build-native.ps1 -Release
```
