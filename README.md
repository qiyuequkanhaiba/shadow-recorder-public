# ReqCase Shadow Recorder

ReqCase Shadow Recorder is a Windows desktop recorder for local screen capture,
operation and system-event capture, playback, and local evidence export. The
repository contains a Rust + NAPI-RS native addon and an Electron + React
desktop application.

## Scope And Status

- Supported platform: Windows. The capture backend uses Windows APIs and the
  desktop installers target Windows x64.
- Data stays on the local machine unless the operator exports it. The project
  does not provide a hosted recording or evidence service.
- Recordings and exported evidence can contain sensitive information. Use the
  privacy controls before capture and handle exported files as sensitive data.
- This software is provided as-is. It does not make an evidence bundle a
  business-correctness determination.

## Privacy

- Semantic plaintext capture is disabled by default and requires the explicit
  `允许采集非密码文本` opt-in in the desktop privacy settings.
- Password controls are redacted even when plaintext capture is enabled.
- Exclusion and masking rules apply to future capture only; they do not rewrite
  video or exports already written to disk.
- Do not commit recordings, evidence exports, diagnostics bundles, clipboard
  content, local paths, credentials, or personal data. The public boundary
  audit and Gitleaks scan enforce this policy in CI.

## Build On Windows

Install a current Rust toolchain, Node.js, and the Visual Studio C++ build
tools. For the native environment check and addon build:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows-env-check.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\windows-build-native.ps1
```

Run the desktop application:

```powershell
cd examples/desktop
npm install
npm run dev
```

See [examples/desktop/README.md](examples/desktop/README.md) for Electron
commands, packaging, and the supported FFmpeg workflow.

## Existing Installers

Windows EXE and MSI installers are distributed through GitHub Releases rather
than committed to this repository. Before downloading, verify the release's
`SHA256SUMS.txt`, public source commit, FFmpeg attribution, signing status, and
artifact attestation. Existing installers may only be reused when their runtime
and build source files match a public source commit.

## Documentation

- [Architecture](docs/architecture.md)
- [Windows build environment](docs/windows-build-env.md)
- [Release checklist](docs/release-checklist.md)
- [Release artifact attestation](docs/release-artifact-attestation-template.md)
- [v0.1.10 existing installer attestation](docs/releases/v0.1.10-artifact-attestation.md)
- [FFmpeg attribution](tools/ffmpeg/README.md)
- [Security policy](SECURITY.md)

## Security

Report vulnerabilities through the repository's private GitHub vulnerability
reporting flow after it is enabled. Do not create a public issue containing a
recording, export, diagnostic bundle, or any captured sensitive data. Details
are in [SECURITY.md](SECURITY.md).

## License And Brand

Copyright (c) 2026 ReqCase. The source code is available under the
[MIT License](LICENSE). The ReqCase name, the `com.reqcase.shadowrecorder` app
ID, and the `reqcase:shadow-recorder:*` IPC namespace are retained project
identifiers. Third-party dependencies and any bundled FFmpeg binary keep their
own licenses; see [NOTICE](NOTICE).
