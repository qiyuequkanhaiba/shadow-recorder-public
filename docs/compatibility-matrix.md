# Shadow Recorder Compatibility Matrix

This matrix tracks release smoke coverage for capture backends, encoders, display topology, DPI, and remote desktop behavior. Each row should be updated with the latest `npm run test:recording-smoke` summary before release.

| OS | GPU | Display | DPI | Capture Mode | Encoder | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Windows 10 | Intel | Single | 100% | WGC | libx264 | Pending | Baseline software encode path. |
| Windows 11 | NVIDIA | Dual | 150% | WGC | h264_nvenc | Pending | Hardware encode path for NVIDIA. |
| Windows 11 | AMD | Dual | 125% | DXGI | h264_amf | Pending | DXGI fallback and AMD encoder path. |
| Windows 11 RDP | Virtual | Single | 100% | auto | libx264 | Pending | Remote Desktop / virtual adapter fallback. |

## Smoke Report Metadata

`examples/desktop/scripts/recording-smoke-test.ts` prints a `matrix` object in the final summary so the run can be mapped back to this table:

- `os` and `arch`: current runtime platform.
- `dpi`: observed DPI scale from captured timeline events, or `unknown` when no step event exposes DPI.
- `displayCount` and `displayMode`: display topology from native display enumeration, falling back to stream display IDs.
- `captureMode`: requested smoke capture mode.
- `captureBackend`: effective backend inferred from event metadata and recorder metrics.
- `encoder`: encoder names reported by playable video segments, or `unknown` when native metadata is unavailable.

## Release Rule

- A release candidate should have at least one passing row for NVIDIA, Intel, AMD, and RDP coverage.
- Rows with `Pending` or `Blocked` must include owner, machine, driver, and failure notes before release sign-off.
