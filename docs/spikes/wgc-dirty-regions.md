# WGC Dirty Regions Spike

## Goal

Validate whether Windows Graphics Capture dirty regions provide enough signal to reduce redundant encoding work without weakening the existing WGC/DXGI/WebP fallback path.

## Test Matrix

| Matrix | Capture Mode | Delta Mode | Expected Signal | Status |
| --- | --- | --- | --- | --- |
| Local display | WGC foreground window | dirty_rect | Non-zero dirty frames during UI motion | Pending hardware run |
| Local display | WGC target display | dirty_rect | Empty frames while idle, partial coverage while active | Pending hardware run |
| RDP / virtual display | WGC or DXGI fallback | dirty_rect | Explicit supported=false or low-confidence signal | Pending hardware run |

## Results

- Instrumentation added to expose `dirty_region_frame_total`, `dirty_region_empty_frame_total`, and `dirty_region_coverage_avg` through Rust metrics and the Electron metrics bridge.
- WGC now carries per-frame dirty-region coverage from `Direct3D11CaptureFrame::DirtyRegions()` into the shared `FrameDeltaHint` path.
- DXGI dirty-rect coverage is also surfaced through the same hint so benchmark output can compare capture backends consistently.
- Benchmark markdown includes the required line: `- Dirty region frames: <count>, empty frames: <count>, average coverage: <ratio>`.

## Decision

Keep dirty-region handling as an observable spike signal only. Do not make additional skip/encode policy changes until hardware runs show stable coverage and empty-frame behavior across local displays and RDP/virtual display sessions.

## Follow-up Tasks

- Run `npm run test:encoding-benchmark -- --profiles balanced --encoders software,hardware --duration 30 --keep-artifacts` on local WGC-capable hardware.
- Capture separate reports for idle window, active UI changes, video playback, and RDP/virtual display.
- Promote dirty-region thresholds only if empty-frame detection is stable and average coverage correlates with visible changes.
