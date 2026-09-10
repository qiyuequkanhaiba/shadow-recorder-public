# FFmpeg Attribution And Bundling

The Git source does not contain `ffmpeg.exe`. The MIT License for ReqCase
Shadow Recorder does not apply to FFmpeg.

Pinned Windows encoder workflow:

- `tools/ffmpeg/bin/ffmpeg.exe`
- version: `ffmpeg 9.0 essentials`
- primary archive: `https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip`
- primary checksum: `https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256`
- fallback archive: `https://github.com/GyanD/codexffmpeg/releases/download/9.0/ffmpeg-9.0-essentials_build.zip`
- fallback archive SHA-256:
  `E6B54767A6065919048F1A098EB27211CA4E12B4348A05D88777A5855D0B6E71`

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

## Release Requirement

For every installer that embeds FFmpeg, copy the license and notice files from
the exact downloaded archive into the release assets, then record the source
URL, version, archive SHA-256, and copied file names in the release artifact
attestation. Do not label bundled FFmpeg as MIT unless the exact FFmpeg archive
license permits that statement.
