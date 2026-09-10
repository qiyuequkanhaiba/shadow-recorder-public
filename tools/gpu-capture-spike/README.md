# GPU Capture Spike Tooling

This directory is reserved for an isolated GPU-resident capture-to-encoder prototype. The prototype must stay separate from production session recording until the hardware matrix proves that the path is faster, safe to fall back from, and compatible with Electron playback.

## Scope

- Capture a WGC frame as a D3D11 texture.
- Submit that texture to a hardware encoder without intentional CPU readback.
- Compare against the current WGC/DXGI CPU readback plus WebP/FFmpeg baseline.
- Record initialization time, encode latency, dropped frames, fallback reason, and output playback compatibility.

## Candidate Paths

| Option | Capture | Encoder | Purpose |
| --- | --- | --- | --- |
| A | WGC D3D11 texture | Media Foundation H.264 MFT | Validate native Windows capture-to-encode feasibility. |
| B | WGC D3D11 texture | FFmpeg d3d11va/NVENC | Validate FFmpeg hardware-device interop and vendor encoder reuse. |
| C | Current WGC/DXGI CPU readback | WebP/FFmpeg | Preserve the stable fallback and benchmark baseline. |

## Required Matrix

| Matrix | Minimum Result |
| --- | --- |
| NVIDIA | `h264_nvenc` path initializes or falls back within 3 seconds. |
| Intel | `h264_qsv` or Media Foundation hardware MFT path initializes or falls back within 3 seconds. |
| AMD | `h264_amf` path initializes or falls back within 3 seconds. |
| RDP / virtual display | GPU-resident path is skipped or falls back within 3 seconds. |

## Guardrails

- Do not remove or weaken existing WGC, DXGI, WebP, or software FFmpeg paths.
- Do not run the GPU-resident path by default.
- Do not block input hook, event capture, or session shutdown on GPU device or encoder initialization.
- Do not promote AV1/HEVC output before baseline H.264 MP4 playback is verified in Electron Chromium.

## Expected Prototype CLI

The eventual prototype should expose a small command surface similar to:

```powershell
gpu-capture-spike.exe --source target-display --path ffmpeg-d3d11-nvenc --duration 30 --output out\gpu-spike.mp4
```

The command should emit JSON or Markdown metrics that can be copied into `docs/spikes/gpu-resident-capture-encoder.md` and the existing encoding benchmark report.
