# Hardware Encoder Comparison Spike

## Goal

Compare software H.264 against available FFmpeg hardware encoders while keeping `libx264` as the stable fallback path.

## Encoder Probe Coverage

| Codec | Encoder | Default Candidate | Explicit Preference |
| --- | --- | --- | --- |
| H.264 | `h264_nvenc` | Yes | `hardware` / `auto` |
| H.264 | `h264_qsv` | Yes | `hardware` / `auto` |
| H.264 | `h264_amf` | Yes | `hardware` / `auto` |
| AV1 | `av1_nvenc` | No | `hardware:av1` |
| HEVC | `hevc_nvenc` | No | `hardware:hevc` |

## Matrix Results

| Matrix | Profile | Encoder | Capture P95 | Encode P95 | Drop Total | File Size | Result | Notes |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| NVIDIA | hardware | h264_nvenc | 0 | 0 | 0 | 1429755 | Passed | Local benchmark used NVENC |
| Intel | hardware | h264_qsv | 0 | 0 | 0 | 0 | Skipped | No matching hardware result in this run |
| AMD | hardware | h264_amf | 0 | 0 | 0 | 0 | Skipped | No matching hardware result in this run |
| RDP | software | libx264 | 0 | 0 | 0 | 3409646 | Passed | Software fallback run completed |

## Decision Rule

Use hardware encoder by default only if:

```text
encode p95 improves by >= 20%
drop total does not increase
early exit fallback rate < 5%
output can be played by Electron Chromium video element
```

## Decision

Keep hardware H.264 as an ordered candidate path with software fallback. AV1/HEVC probing is allowed but remains opt-in and excluded from default `hardware` / `auto` ordering until compatibility and playback support are proven.

## Follow-up Tasks

- Run the same benchmark on Intel Quick Sync and AMD AMF systems.
- Run the software profile under RDP or a virtual display session and record it as the RDP matrix row.
- Add persisted benchmark artifacts only after defining stable artifact retention policy.
