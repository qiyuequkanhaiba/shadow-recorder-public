Bundled Windows encoder workflow:

- `tools/ffmpeg/bin/ffmpeg.exe`

Packaging flow:

- `examples/desktop/scripts/prepare-ffmpeg-resource.ts` first looks for a supported local binary
  with the required `gdigrab + segment` recording capabilities
- if the local binary is missing or too old, it automatically downloads the Gyan.dev
  `ffmpeg-release-essentials.zip` Windows build and verifies the archive `.sha256`
- the validated binary is staged into `examples/desktop/build-resources/ffmpeg/bin/ffmpeg.exe`
- `examples/desktop` `pack` / `dist` will stage this binary into `build-resources/ffmpeg/bin/ffmpeg.exe`
- `electron-builder` will then bundle it into the packaged app under `resources/ffmpeg/bin/ffmpeg.exe`
- the Electron main process sets `REQCASE_SHADOWRECORDER_FFMPEG_PATH` so the Rust runtime uses the bundled encoder

Local cache directories created by the script:

- `tools/ffmpeg/cache`
- `tools/ffmpeg/extract`

If you do not want the script to manage the binary automatically, you can still set:

- `REQCASE_SHADOWRECORDER_FFMPEG_PATH=<absolute path to ffmpeg.exe>`

before running `npm run pack` or `npm run dist`.
