# Release Checklist

## Versioning

- Confirm `examples/desktop/package.json` version matches the release tag.
- Confirm user-facing release notes include recorder, AI, privacy, and compatibility changes.
- Confirm rollback target tag and installer artifact are available before publishing.

## Public Source And Artifact Provenance

- Confirm `LICENSE`, `NOTICE`, `SECURITY.md`, Cargo metadata, and desktop
  package metadata pass `pwsh -NoProfile -File .\scripts\public-release-metadata-audit.ps1`.
- Complete `docs/release-artifact-attestation-template.md` with a public source
  commit, artifact SHA-256 values, FFmpeg attribution, signing state, and
  manual smoke result.
- Existing installers may be reused only when their runtime and build source
  files match a public commit. The public release must name that public commit,
  never the private build commit or a private filesystem path.
- Upload `SHA256SUMS.txt` generated from the exact EXE and MSI files attached
  to the GitHub Release.

## Native Build

- Run the Windows native release build with `npm run build:native:release` from `examples/desktop`.
- Confirm `target/release/shadow_recorder.node` exists and is copied by the Electron Builder `extraResources` rule.
- Confirm `cargo test` and `cargo clippy --all-targets -- -D warnings` pass in the release branch.

## FFmpeg Resource

- Run `npm run prepare:ffmpeg` from `examples/desktop`.
- Confirm `examples/desktop/build-resources/ffmpeg/ffmpeg.exe` exists.
- Confirm FFmpeg source, version, archive checksum, and the exact archive's
  license and notice files are attached or linked in the release attestation.

## Quality Gate

- Run `npm run release:preflight` from `examples/desktop` before packaging.
- Confirm the quality gate covers Rust tests, clippy, Electron typecheck, React typecheck, and recorder script tests.
- Confirm operation semantic scripts are included:
  - `test:operation-golden-contract`
  - `test:operation-ipc-validators`
  - `test:operation-compatibility`
  - `test:recording-review-interaction`
  - `test:operation-performance-skeleton`
- Confirm `.ci-artifacts/quality-gate-summary.json` was produced and archived with the build.
- Attach any benchmark comparison artifacts when a baseline/candidate gate is configured.

## Operation Semantic Release A Sign-off

- Complete manual matrix rows in `docs/operation-semantic-manual-test.md`.
- Confirm rollback drills for:
  - `operationReviewV2Enabled=false` (UI falls back)
  - `uiaObserverEnabled=false` (no observer)
  - `operationBuilderEnabled=false` (steps-only path)
- Confirm diagnostics expose schema/builder/observer health counters without sensitive values.
- Confirm release notes state: results are observable software state, not business-correctness judgments.

## Installer

- Run the target installer command only after preflight passes, for example `npm run dist:nsis`.
- Confirm generated artifacts land under `examples/desktop/release`.
- Install on a clean Windows machine or VM and verify startup, tray, recording, export, and uninstall.

## Code Signing

- Confirm signing certificate, timestamp server, and secure key storage are configured on the release machine.
- Confirm `docs/release-operations.md` has the approved certificate source, signing commands, update channel policy, staged rollout rules, and rollback procedure for this release.
- Confirm Windows SmartScreen/signature metadata after installer generation.
- Never commit signing secrets, certificate passwords, or generated private key files.

## Auto-Update And Rollout

- Confirm whether this release is manual distribution or uses an updater channel; the current app has no enabled `electron-updater` runtime path.
- If updater metadata is used, confirm channel, artifact hash, signature, and version monotonicity before publication.
- Follow the staged rollout gates in `docs/release-operations.md` before expanding beyond canary users.

## Smoke Test

- Run `npm run test:recording-smoke` from `examples/desktop` on the release candidate build.
- Update `docs/compatibility-matrix.md` for NVIDIA, Intel, AMD, and RDP coverage.
- Confirm smoke output includes OS, DPI, display count, capture backend, and encoder metadata.

## Rollback

- Keep the previous signed installer and release tag available until post-release validation completes.
- Document the rollback trigger, owner, and user communication path.
- If rollback is triggered, archive diagnostics bundles without screenshots, video, clipboard text, or full window titles.
- Freeze updater metadata or remove manual download links before publishing the previous signed installer as the recommended build.
