# ReqCase Shadow Recorder Desktop

This directory contains the Electron + React desktop application for the
ReqCase Shadow Recorder native module.

The application is Windows-only. It stores recordings and evidence locally,
where they may contain sensitive data. Review the root [privacy guidance](../../README.md#privacy),
[security policy](../../SECURITY.md), [MIT License](../../LICENSE), and
[third-party notices](../../NOTICE) before distributing a build.

## Current scope

The desktop app is now focused on the core workflow only:

- loop desktop recording
- operation and system event capture
- video playback with event lookup
- local evidence export
- compact floating toolbar + main window

Removed from the public product surface:

- legacy analysis workflows
- old assistant-style helper flows
- historical import/export helpers unrelated to recording playback
- comparison and evaluation tooling unrelated to the core recorder

## Main entry points

- Electron main: `examples/desktop/src-electron/main.ts`
- IPC channels: `examples/desktop/src-electron/modules/reqcase-shadow-recorder/ipc-channels.ts`
- IPC registration: `examples/desktop/src-electron/modules/reqcase-shadow-recorder/ipc.ts`
- Service layer: `examples/desktop/src-electron/modules/reqcase-shadow-recorder/service.ts`
- Evidence export: `examples/desktop/src-electron/modules/reqcase-shadow-recorder/evidence-export.ts`
- Report export: `examples/desktop/src-electron/modules/reqcase-shadow-recorder/report-export.ts`
- Renderer page: `examples/desktop/src-react/pages/RecorderPage.tsx`
- Floating toolbar: `examples/desktop/src-electron/floating-toolbar.ts`

## Renderer structure

Main renderer modules:

- `examples/desktop/src-react/components/RecorderPlaybackStage.tsx`
- `examples/desktop/src-react/components/RecorderSessionTimelinePanel.tsx`
- `examples/desktop/src-react/components/RecorderControlPanel.tsx`
- `examples/desktop/src-react/hooks/useRecorderRuntime.ts`
- `examples/desktop/src-react/hooks/useRecorderBootstrap.ts`
- `examples/desktop/src-react/hooks/useTuningAdvisor.ts`
- `examples/desktop/src-react/lib/recorder-page-bindings.ts`

## Native prerequisite

Build the Rust addon in repo root first:

```powershell
cargo build
```

Expected output:

- `target/debug/shadow_recorder.node`
- or `target/release/shadow_recorder.node`

## Run the desktop demo

```powershell
cd examples/desktop
npm install
npm run dev
```

Default behavior:

- app starts with the floating toolbar
- main window opens on demand from toolbar, tray, or shortcut
- recording, playback, event log, and export workflows are exposed through Electron IPC

## Common scripts

Development:

```powershell
npm run dev
npm run build:native
npm run build
```

Typecheck:

```powershell
npm run typecheck:react
npm run typecheck:electron
```

Core tests:

```powershell
npm run test:ipc-validators
npm run test:recorder-page-bindings
npm run test:evidence-export
```

Quality gate:

```powershell
npm run check:quality
npm run check:quality:quick
```

## Packaging

Optional bundled `ffmpeg.exe` is staged during pack/dist:

```powershell
npm run prepare:ffmpeg
npm run pack
npm run dist
```

The GitHub source repository never commits the FFmpeg binary or generated EXE
and MSI installers. Every published installer needs a public-source commit,
SHA-256 checksum, and the FFmpeg license material from the exact bundled
archive. See `../../docs/release-artifact-attestation-template.md`.

Windows installers:

```powershell
# EXE installer with install-directory selection
npm run dist:nsis

# WiX MSI installer with install-directory selection
npm run dist:msi
```

Preferred bundled source location:

- `tools/ffmpeg/bin/ffmpeg.exe`

Current behavior:

- `npm run prepare:ffmpeg` validates the local `ffmpeg.exe` against the actual loop-recording requirements
- if it is missing or too old, the script downloads the pinned `ffmpeg 9.0 essentials` Windows build automatically, falling back to the Gyan GitHub mirror when the primary metadata endpoint is unavailable
- the staged packaged binary is written to `build-resources/ffmpeg/bin/ffmpeg.exe`
- `npm run dist:msi` now builds `release/win-unpacked` first, then packages it with the repo-local WiX project under `examples/desktop/installer/wix/`
- both `NSIS .exe` and `WiX MSI` now support changing the installation directory
- the custom WiX MSI also creates desktop and start-menu shortcuts by default
- the WiX build relies on the local `.NET SDK` and restores `WixToolset.Sdk` / `WixToolset.UI.wixext` automatically; no separate `candle/light` install is required

## Evidence export

The current evidence export keeps the core bundle only:

- one continuous `mp4` recording per exported display
- `events-timeline.md` with display-aware timeline rows
- optional ZIP package

## Recording smoke validation

- quick real-desktop smoke:
  `npm run test:recording-smoke -- target_display 12 4 30`
- foreground window smoke:
  `npm run test:recording-smoke -- foreground_window 15 5 40`

## Encoding benchmark

- quick encoder benchmark:
  `npm run test:encoding-benchmark -- --mode target_display --duration 12 --profiles balanced --encoders auto,hardware,software`
- compare recording profiles:
  `npm run test:encoding-benchmark -- --mode foreground_window --duration 12 --profiles efficiency,balanced,smooth --encoders auto`

The benchmark reuses the live loop-recording runtime and writes:

- `encoding-benchmark.json`
- `encoding-benchmark.md`

Default output root:

- `examples/desktop/reports/encoding-benchmark/`

Current benchmark focuses on:

- actual selected encoder (`libx264 / h264_nvenc / h264_qsv / h264_amf`)
- playable segment count and total playable duration
- combined Node + child `ffmpeg` CPU estimate
- combined and `ffmpeg` working set usage
- warning count and recorder metric deltas

Current baseline conclusion on this repository's validation machine (`2026-04-06`):

- keep the default as `recordingProfile=balanced`
- keep the default as `encoderPreference=auto`
- on this machine, `auto / hardware / software` all fell back to `ffmpeg:gdigrab-libx264`
- `foreground_window` consumed noticeably less CPU and memory than `target_display`
- `efficiency / balanced / smooth` did not show a decisive enough gap to justify changing the current default away from `balanced`

The bundled `ffmpeg.exe` must support both `gdigrab` and the `segment` muxer. An outdated binary such as `ffmpeg 1.0.1`
is now rejected during `prepare:ffmpeg`, and the script will replace it with the pinned modern
Windows build automatically.

## Notes

- `ipc.ts` is now maintained as source TypeScript again; it should no longer be edited by copying build artifacts back into `src-electron`.
- If you add features, keep them aligned with the current product boundary: recording, event capture, playback, export.
