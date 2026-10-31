# S2 after: defect pack export stays off the main-process event loop

Measured with the S2 native addon, after `export_test_defect_pack` became a napi `AsyncTask` and ffmpeg concat gained a timeout.

- Addon: `C:\Users\tenghuiliu\s2-bench\shadow_recorder.node` (4,691,456 bytes), built with `cargo build --release --target x86_64-pc-windows-msvc`
- Electron: `C:\Users\tenghuiliu\f1-pkg\examples\desktop\node_modules\electron\dist\electron.exe`
- ffmpeg: `C:\Users\tenghuiliu\f1-pkg\tools\ffmpeg\bin\ffmpeg.exe` (9.0.2 essentials), via `REQCASE_SHADOWRECORDER_FFMPEG_PATH`
- Host: Parallels Windows 11, desktop capture, software encoder, 40s segments, 600s buffer
- Launch: `prlctl exec --current-user`. A first attempt without `--current-user` ran in session 0. gdigrab exited -22 there, the session produced no segments, and that attempt is not the table below.

The original T0 sessions `ts-1793354750510-1` and `ts-1793355441993-1` cannot be reloaded. Test-session history lives in the measurement process, and that process has exited. This run recorded a new session with the same capture settings.

The measurement process opened one local probe window and sent IPC pings during each export. It did not open the product floating toolbar or the product main window, so those windows were not dragged or clicked.

## Session

- Session `ts-1793357659468-1`
- Wall clock `213683` ms (3 min 33.7 s)
- 6 playable segments, each H.264 High, yuv420p, 1198x770, 14 fps
- Durations: five 40.00 s segments plus one 10.71 s segment

## exportTestDefectPack, stream copy, three times

`setInterval(50ms)` kept firing while each `await` was in progress. The longest gap is the largest timer interval, including the gap from the last tick to the moment the promise settled. A blocked main thread would show one gap about as long as the elapsed time and almost no ticks.

| Run | Elapsed | Longest event-loop gap | IPC ping gap | Ticks during await | clipBuilt |
| --- | ---: | ---: | ---: | ---: | --- |
| copy-1 | 224 ms | 58 ms | 88 ms | 4 | true |
| copy-2 | 173 ms | 63 ms | 48 ms | 2 | true |
| copy-3 | 168 ms | 63 ms | 48 ms | 2 | true |

All three clips play. `ffmpeg -f null` exits 0. Duration `00:03:30.71`, H.264 High, yuv420p, 1198x770, 14 fps, 787356 bytes. copy-2 and copy-3 have the same relative paths and the same clip size.

Pack layout (copy-1), 12 files, manifest `schemaVersion` 1, `kind` `reqcase.defect-pack`:

| Relative path | Bytes |
| --- | ---: |
| manifest.json | 1160 |
| operations.json | 2752 |
| repro_steps.txt | 235 |
| steps.json | 904 |
| summary.json | 724 |
| video/clip.mp4 | 787356 |
| video/segments.txt | 390 |
| video/segments/01-run-0001-00000.mp4 | 192303 |
| video/segments/02-run-0001-00001.mp4 | 133526 |
| video/segments/03-run-0001-00002.mp4 | 132211 |
| video/segments/04-run-0001-00003.mp4 | 132222 |
| video/segments/05-run-0001-00004.mp4 | 132076 |
| video/segments/06-run-0001-00005.mp4 | 68976 |

File names and manifest kind match T0. Byte sizes differ because this is a new recording, and this session captured window events, so `operations.json` and `steps.json` are larger. The manifest still stores relative path and byte size, not a content hash.

## VP9 re-encode path

Segment `run-0001-00000` was replaced with VP9, then `exportTestDefectPack` was called once. The call returned success with `clipBuilt` false and `clipPath` null, same as T0. Elapsed 1286 ms, longest event-loop gap 66 ms, 22 timer ticks, IPC ping gap 88 ms. The main process kept running while ffmpeg failed the stream copy and the libx264 fallback.

The pack keeps manifest `schemaVersion` 1, `kind` `reqcase.defect-pack`, and the six segment files. A `video/clip.mp4` of 163417 bytes was left on disk by the failed ffmpeg process. It is not returned as `clipPath` and is not listed in the manifest, because the manifest adds `video/clip.mp4` only when `clipBuilt` is true. The T0 VP9 directory has the same kind of leftover file (130908 bytes).

## Responsiveness

The longest main-process stall during the four exports was 66 ms, under the 100 ms acceptance line. The probe window's IPC was handled during every export. The product floating toolbar and main window were not opened.
