## Components

- `src/`: Rust native addon for Windows capture, input correlation, privacy filtering, and session persistence.
- `examples/desktop/src-electron/`: Electron main-process boundary, local session management, exports, and trusted IPC validation.
- `examples/desktop/src-react/`: local renderer UI; it has no direct filesystem or native-addon access.
- `tools/ffmpeg/`: documented acquisition and packaging support for an external encoder binary; no binary is committed.
