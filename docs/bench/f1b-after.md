# F1b after: screenshot UI stays visible unless this app is recording

Branch `fix/f1b-remote-capture-visible`. The rule is `shouldHideScreenshotUiFromCapture` in `examples/desktop/src-electron/screenshot-capture.ts`: hide the screenshot UI from screen capture only when this app is recording and `hideScreenshotUiFromCapture` is true. The default is true. Remote desktop users who are not recording, or who turn the switch off, keep the selection UI visible to a desktop capture.

The Parallels Windows 11 VM still has one display, 1199x770 at 96 DPI. A second monitor cannot be added here. The same call is applied to every selection window.

The live check uses the same fullscreen overlay as `docs/bench/f1b-before.md`: dark mask, cyan selection rectangle, 80x80 magenta marker. `setContentProtection` follows the four-way rule above. Capture tool is ffmpeg `gdigrab` of the desktop, started with `prlctl exec --current-user`. The product's own recording is `startTestSession` with `targetCaptureMode: desktop` and the existing `shadow_recorder.node`. The captured still is `captureScreenshot` of the marker rectangle after the overlay is hidden, which is the same order as `confirmAreaSelection`.

| Case | Recording | Setting | What was checked | Magenta pixels | Cyan pixels | Result |
| --- | --- | --- | --- | ---: | ---: | --- |
| 1a | no | on | gdigrab while the overlay is shown | 6400 | 3616 | The mask, the cyan box, and the marker are visible. Marker sample rgb(255, 0, 255). Mask samples average 60 versus 108 on the bare desktop. |
| 1b | no | on | `captureScreenshot` of the 80x80 marker after the overlay is hidden | 0 | 0 | The captured image does not contain the marker or the selection border. |
| 2 | yes | on | One frame from this app's mp4 while the overlay is protected | 0 | 388 | The recording does not show the mask, the box, or the marker. The 388 cyan pixels match desktop chrome, not the 3616-pixel selection border. |
| 3 | yes | off | gdigrab while the session is recording | 6400 | 3616 | The capture tool sees the mask and the marker. Marker sample rgb(255, 0, 255). |

Case 2 session `ts-1793375173895-1`, file `C:\Users\tenghuiliu\f1b-bench\case2\ts-1793375173895-1\video\streams\vs-display-primary\segments\run-0001-00000.mp4`, 48362 bytes. The extracted frame is 1198x770. gdigrab frames are 1199x770. Case 3 session `ts-1793375190661-2`.

Frames: `task-reports/f1b/t1-case1-visible.png`, `t1-case1-captured-region.png`, `t1-case2-recorded.png`, `t1-case3-gdigrab.png`. Counts are in `task-reports/f1b/t1-result.json`.

`npm run test:screenshot-capture` covers the four combinations: recording and on returns true; the other three return false.
