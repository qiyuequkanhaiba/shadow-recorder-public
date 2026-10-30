# F1b baseline: screenshot overlay is invisible to screen capture

Measured on `fix/f1b-remote-capture-visible` at `e5dbbd3`, before the setting change. The product still calls `setContentProtection(true)` from `showExcludedFromCapture` in `examples/desktop/src-electron/screenshot-session.ts`.

The Parallels Windows 11 VM has one display, 1199x770 at 96 DPI. A second monitor cannot be added here. The product applies the same call to every selection window, so this single display is the capture check.

Capture tool: ffmpeg 9.0.2 `gdigrab` of the desktop, one frame each. The overlay is a fullscreen transparent Electron window with the same flags as the area-selection window: always on top, no frame, a dark mask, a cyan selection rectangle, and an 80x80 magenta marker. `gdigrab` was started with `prlctl exec --current-user` because session 0 cannot grab the desktop.

| Run | `setContentProtection` | Magenta marker pixels | Cyan selection-border pixels | Sample at the marker |
| --- | --- | ---: | ---: | --- |
| Current product behavior | true | 0 | 0 of the border | rgb(12, 12, 12), the desktop underneath |
| Protection removed | false | 6400 (the full 80x80 marker) | 3616 | rgb(255, 0, 255) |

With protection on, the desktop recording shows the terminal and wallpaper and does not show the mask, the selection rectangle, or the marker. With protection off, the same recording shows the dark mask, the cyan rectangle, and the magenta marker. Frames: `task-reports/f1b/t0-protected.png` and `task-reports/f1b/t0-visible.png`.

This matches the remote-desktop report. A remote session that forwards a desktop capture cannot see the selection UI while `WDA_EXCLUDEFROMCAPTURE` is set. The cursor is not part of that window, so it can still be visible.
