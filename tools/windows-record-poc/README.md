# windows-record WR-0 PoC

This is a standalone compatibility PoC for evaluating `windows-record` as the replacement video capture core.

It is intentionally isolated from the main `shadow_recorder` crate so WR-0 can be validated without disturbing the current production path.

Current status:

- The PoC now depends on the local fork at `tools/windows-record-fork`
- WR-0.6 fixed the released crate's `exact_match` forwarding bug
- Runtime compatibility is still not established on this machine because the first hard failure now occurs inside the Media Foundation write/finalize path
- WR-0.7 exposes encoder-chain switches so hardware transforms, async video processor, bitrate and profile combinations can be compared directly
- WR-0.8 confirms the key compatibility split:
  - `--sample-transport dxgi` still fails on this machine
  - `--sample-transport memory` can produce non-empty playable `mp4`

## What It Verifies

- `windows-record` can compile in the current repository environment
- a visible target window can be recorded into a playable `mp4`
- replay-buffer mode can be exercised separately

## Important Caveat

`windows-record` exposes `with_process_name(...)`, but the current public API actually matches a visible **window title** string, not an executable file name. Use the helper script below to find a good title first.

## List Visible Window Titles

```powershell
powershell -ExecutionPolicy Bypass -File scripts/list-visible-window-titles.ps1
```

## Run

```powershell
cargo run --manifest-path tools/windows-record-poc/Cargo.toml -- `
  --window "shadowrecord" `
  --duration 6 `
  --audio off `
  --debug
```

You can also force the capture/output dimensions explicitly when comparing WR-0.5 cases:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run-windows-record-poc.ps1 `
  -Window "Codex" `
  -Duration 5 `
  -Audio off `
  -Debug `
  -SampleTransport memory `
  -InputWidth 2560 `
  -InputHeight 1600 `
  -OutputWidth 2560 `
  -OutputHeight 1600
```

## WR-0.5 Caveats Confirmed

- The crate's `with_process_name(...)` still matches visible window title text, not executable name.
- The released `with_exact_match(...)` path is currently broken in practice because the exact-match flag is not forwarded into `RecorderInner::init_with_exact_match(...)`.
- The capture path hard-gates content on `GetForegroundWindow() == hwnd`.
- Even with focus satisfied and dimensions matched, the current crate still fails with `Processed 0 frames` / `HRESULT(0x80004005)` on this machine.

## WR-0.7 Encoder-Chain Flags

The PoC now supports these extra flags for encoder compatibility experiments:

- `--bitrate <bps>`
- `--encoder h264|hevc`
- `--profile auto|h264-baseline|h264-main|h264-high|hevc-main`
- `--disable-hw-transforms`
- `--enable-sink-throttling`
- `--disable-low-latency`
- `--disable-async-converter`

## WR-0.8 Sample-Transport Flag

The PoC now supports:

- `--sample-transport dxgi|memory`

Meaning:

- `dxgi`: pass the converted DXGI-backed sample directly into the sink writer
- `memory`: clone the converted sample into a CPU memory-backed `IMFSample` first

Recommended WR-0.8 verification command:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run-windows-record-poc.ps1 `
  -Window "Codex" `
  -Duration 5 `
  -Audio off `
  -Debug `
  -Exact `
  -SampleTransport memory `
  -InputWidth 2560 `
  -InputHeight 1600 `
  -OutputWidth 2560 `
  -OutputHeight 1600
```

WR-0.8 conclusion on this machine:

- `sample-transport=memory` is the first path that consistently produced non-empty `mp4`
- `sample-transport=dxgi` still reproduces `Processed 0 frames` or `WriteSample/Finalize` failure
- The current strongest hypothesis is therefore confirmed: the core incompatibility is in the `DXGI surface sample -> sink writer` transport shape, not mainly in encoder/profile selection

## Replay Buffer Example

```powershell
cargo run --manifest-path tools/windows-record-poc/Cargo.toml -- `
  --window "shadowrecord" `
  --duration 10 `
  --audio off `
  --replay-buffer-seconds 10 `
  --save-replay D:/python/shadowrecord/reports/windows-record-poc/replay.mp4
```
