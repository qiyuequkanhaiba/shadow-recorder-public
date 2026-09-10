# GPU-Resident Capture Encoder Spike

## Goal

Evaluate whether Shadow Recorder should add an optional GPU-resident capture-to-encoder path that keeps frames on the D3D11 device from Windows Graphics Capture through hardware encoding, while preserving the current WGC/DXGI CPU readback, WebP, and FFmpeg fallback behavior.

## Current Baseline

- Capture currently keeps stable WGC/DXGI paths and reports dirty-region metrics through the shared `FrameDeltaHint` instrumentation.
- Encoding currently probes FFmpeg encoders and keeps software H.264 as the stable fallback. Hardware H.264 candidates cover NVIDIA NVENC, Intel Quick Sync, and AMD AMF; AV1/HEVC NVENC remain explicit opt-ins.
- The next optimization frontier is reducing GPU-to-CPU readback and redundant memory copies before encode, not replacing the proven fallback path.

## Candidate Comparison

| Option | Capture | Encoder | Pros | Risks | Decision |
| --- | --- | --- | --- | --- | --- |
| A | WGC D3D11 texture | Media Foundation H.264 MFT | Native Windows stack | Complex COM/MFT integration | Spike only |
| B | WGC D3D11 texture | FFmpeg d3d11va/NVENC | Leverages FFmpeg | Device interop complexity | Spike only |
| C | Current WGC/DXGI CPU readback | WebP/FFmpeg | Stable fallback | CPU overhead | Keep fallback |

## Hardware Matrix

| Matrix | Primary Path To Test | Required Encoder | Expected Fallback | Notes |
| --- | --- | --- | --- | --- |
| NVIDIA | WGC D3D11 texture -> FFmpeg D3D11 device -> NVENC | `h264_nvenc` first; optional `av1_nvenc` / `hevc_nvenc` by preference | `libx264` through existing FFmpeg path | Highest value prototype target because NVENC is already probed and verified locally. |
| Intel | WGC D3D11 texture -> Media Foundation or FFmpeg hardware device -> Quick Sync | `h264_qsv` or Windows H.264 hardware MFT | `libx264` through existing FFmpeg path | Validate adapter matching carefully on hybrid systems. |
| AMD | WGC D3D11 texture -> FFmpeg hardware device -> AMF | `h264_amf` | `libx264` through existing FFmpeg path | Confirm whether D3D11 frames avoid readback before AMF submission. |
| RDP / virtual display | Existing WGC/DXGI fallback path first | none required | CPU readback + `libx264` / WebP | GPU-resident mode must degrade quickly and predictably when a hardware encoder or shared device is unavailable. |

## Non-Breaking Constraints

```text
No removal of existing WGC/DXGI/WebP path.
New path must be behind config flag.
If encoder initialization fails, fallback must complete within 3 seconds.
No GPU path may block input hook thread.
```

Additional implementation constraints:

- Keep GPU-resident capture isolated behind a capability probe such as `capturePipeline=gpu_resident` or `experimentalGpuResidentCapture=true`; default remains the current stable path.
- Initialize GPU capture and encoder resources on a dedicated worker thread or async task. Input hook delivery, event persistence, and session stop must not wait on COM/MFT/FFmpeg device setup.
- Treat device loss, monitor change, protected content, RDP session transition, and encoder open failure as normal fallback cases with structured telemetry.
- Emit a single fallback reason per session so benchmark reports can distinguish unsupported hardware from runtime failures.

## Prototype Scope

1. Add a standalone prototype under `tools/gpu-capture-spike` before touching the production session manager.
2. Build the prototype around a single foreground window or target display WGC source.
3. Measure end-to-end latency, CPU utilization, dropped frames, device initialization time, and fallback time against the current benchmark command.
4. Keep output compatibility scoped to H.264 MP4 first; AV1/HEVC are optional follow-up checks only after Chromium playback is verified.

## Evaluation Criteria

| Criterion | Proceed Threshold | Reject / Defer Trigger |
| --- | --- | --- |
| CPU reduction | CPU time drops by at least 20% during active capture at equal resolution/FPS | Less than 10% improvement or increased input latency |
| Encode latency | Encode p95 improves or remains within 5% of current hardware FFmpeg path | Encode p95 regresses by more than 15% |
| Fallback behavior | Unsupported matrix rows fall back within 3 seconds | Any failure blocks session start/stop or input hooks |
| Compatibility | MP4 plays in Electron Chromium and external Windows player | Output requires non-default codecs for baseline H.264 |
| Maintainability | Prototype remains isolated and does not duplicate session orchestration | Requires replacing stable WGC/DXGI/WebP code |

## Decision

Proceed to prototype.

Rationale: the existing software and hardware encoder work establishes a safe fallback and benchmark harness, so the next bounded experiment should focus on removing CPU readback when hardware and session conditions support it. The prototype must not be promoted into production until the NVIDIA / Intel / AMD / RDP matrix proves fast fallback, playable output, and no input-hook blocking.

## Follow-up Tasks

- Create a minimal `tools/gpu-capture-spike` prototype that can run independently from Electron session capture.
- Add benchmark report fields for `gpu_resident_enabled`, `gpu_device_vendor`, `encoder_init_ms`, and `fallback_reason` before comparing results.
- Run the matrix on native NVIDIA, native Intel, native AMD, and RDP / virtual display environments.
- Promote only the capability probe, configuration flag, and telemetry first; keep production data path disabled until two hardware vendors pass.

## Reference Notes

- Microsoft Windows Graphics Capture exposes each frame as a Direct3D surface and includes dirty-region metadata on supported Windows versions: <https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframe>.
- Microsoft Media Foundation H.264 encoder supports hardware-backed transform paths but requires careful COM, media type, and device-manager setup: <https://learn.microsoft.com/en-us/windows/win32/medfound/h-264-video-encoder>.
- FFmpeg hardware paths can use D3D11 hardware device contexts and vendor encoders, but production use needs explicit device interop and fallback handling: <https://ffmpeg.org/ffmpeg.html>.
- NVIDIA documents FFmpeg NVENC integration and lists the NVENC codec families used by the current optional hardware probe: <https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/ffmpeg-with-nvidia-gpu/index.html>.
