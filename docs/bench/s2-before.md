# S2 baseline: defect pack export blocks the main process

Measured on the unmodified `ba1d03e` addon. No product code was changed for this run.

- Branch checked: `fix/s2-async-export` at `ba1d03e58400e1cd38867d992600d02b2fdb1953`
- Addon: `C:\Users\tenghuiliu\f1-pkg\target\release\shadow_recorder.node`
- Electron: `C:\Users\tenghuiliu\f1-pkg\examples\desktop\node_modules\electron\dist\electron.exe`
- ffmpeg: `C:\Users\tenghuiliu\f1-pkg\tools\ffmpeg\bin\ffmpeg.exe` (9.0.2 essentials), via `REQCASE_SHADOWRECORDER_FFMPEG_PATH`
- Source hashes matched the repo: `src/lib.rs` `e64a7bab…1aa4`, `src/session/defect_pack.rs` `0a81160d…d1a1`
- Host: Parallels Windows 11, one 1198x770 display, desktop capture, software encoder, 40s segments, 600s buffer

The measurement process opened one local probe window. It did not open the product floating toolbar or the product main window. Main-process stalls below are from `setInterval(50ms)` and from IPC pings sent by that probe window. While `exportTestDefectPack` ran, those callbacks did not run, so a click or drag that needs the main process would wait for the whole export.

## Session used for the three stream-copy exports

- Session `ts-1793354750510-1`
- Wall clock `213598` ms (3 min 33.6 s)
- 6 playable segments, each H.264 High, yuv420p, 1198x770, 14 fps
- Durations: five 40.00 s segments plus one 10.57 s segment

## exportTestDefectPack, stream copy, three times

Each export copied all 6 segments and built `video/clip.mp4`. The clip is playable H.264, duration `00:03:30.57`, 653487 bytes.

| Run | Elapsed | Longest event-loop gap | IPC ping gap | clipBuilt |
| --- | ---: | ---: | ---: | --- |
| copy-1 | 181 ms | 181 ms | 182 ms | true |
| copy-2 | 141 ms | 154 ms | 155 ms | true |
| copy-3 | 133 ms | 133 ms | 133 ms | true |

During each call the main process could not service the probe window. The product toolbar and main window were not opened in this run.

Pack layout (copy-1), 12 files, manifest `schemaVersion` 1, `kind` `reqcase.defect-pack`:

| Relative path | Bytes |
| --- | ---: |
| manifest.json | 1157 |
| operations.json | 264 |
| repro_steps.txt | 236 |
| steps.json | 2 |
| summary.json | 712 |
| video/clip.mp4 | 653487 |
| video/segments.txt | 390 |
| video/segments/01-run-0001-00000.mp4 | 178559 |
| video/segments/02-run-0001-00001.mp4 | 105459 |
| video/segments/03-run-0001-00002.mp4 | 105353 |
| video/segments/04-run-0001-00003.mp4 | 105455 |
| video/segments/05-run-0001-00004.mp4 | 105458 |
| video/segments/06-run-0001-00005.mp4 | 57161 |

The manifest lists relative path and byte size. It does not store a content hash. copy-2 and copy-3 have the same relative paths and the same clip size.

## Re-encode group

Putting a different encode into one segment does not, by itself, make this ffmpeg return a failed stream copy. These replacements still exited 0 from `ffmpeg -f concat -c copy`:

| Replacement | Stream-copy exit | Notes |
| --- | ---: | --- |
| mpeg4 640x360, inside `exportTestDefectPack` | success (`clipBuilt` true) | Export elapsed 120 ms, event-loop gap 148 ms. The clip header is mpeg4 and `ffmpeg -f null` exits 69, so the file does not play through. libx264 did not run. |
| yuv444p H.264 | 0 | Standalone concat |
| mpeg2video | 0 | Standalone concat |
| libx265 | 0 | Standalone concat |
| added AAC audio on the first segment only | 0 | Standalone concat |
| video track timescale 1000 | 0 | Standalone concat |

A VP9 segment does fail stream copy. Standalone `ffmpeg -f concat -c copy` exited `-1094995529` (`Invalid data found when processing input`). The same input through the app's libx264 arguments (`-c:v libx264 -preset veryfast -crf 23 -an`) ran libx264 and then exited 69 (`Conversion failed`) after 4089 ms.

That VP9 case was then measured through `exportTestDefectPack` on a second session, `ts-1793355441993-1`, also 213652 ms with 6 segments. Segment `run-0001-00000` was replaced with VP9 (playable, 1198x770). The export returned success with `clipBuilt` false and `clipPath` null. Elapsed 1119 ms, event-loop gap 1120 ms. The directory still contains `video/clip.mp4` (130908 bytes) left by the failed ffmpeg process. The manifest lists a clip only when `clipBuilt` is true, so that file is not part of the manifest. Stderr is discarded by the baseline, so this run does not show the libx264 log line. The extra time versus the 133–181 ms stream-copy exports matches a failed copy plus the re-encode attempt. The pack still has the six segment files and the same manifest kind.

A standalone libx264 concat of the six original H.264 segments, which the app does not reach when stream copy returns 0, took 5068 ms and wrote a 503846 byte file.

## Other native calls on the same sessions

`setInterval` gaps recorded after these calls include Chromium timer delay. The native call itself returned in a few milliseconds, so none of them was changed to async.

| Call | Session | Native elapsed | First timer gap after return |
| --- | --- | ---: | ---: |
| rebuildTestSessionOperations | ts-1793354750510-1 | 0 ms | 149 ms over the following 200 ms window |
| rebuildTestSessionSteps | ts-1793354750510-1 | 1 ms | 98 ms over the following 200 ms window |
| renderTestSessionReproSteps | ts-1793354750510-1 | 5 ms | 178 ms over the following 200 ms window |
| rebuildTestSessionOperations | ts-1793355441993-1 | 0 ms | 64 ms |
| rebuildTestSessionSteps | ts-1793355441993-1 | 2 ms | 63 ms |
| renderTestSessionReproSteps | ts-1793355441993-1 | 2 ms | 130 ms |

## Responsiveness

Stream-copy exports blocked the main process for 133–181 ms. The VP9 export blocked it for 1120 ms. The probe window's IPC was not handled during those gaps. The product floating toolbar and main window were not part of this process, so they were not dragged or clicked here.
