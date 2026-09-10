# Public Release Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the public Shadow Recorder source and existing Windows installer release for MIT distribution under the ReqCase brand without changing recording behavior.

**Architecture:** Keep legal and provenance statements in repository-root documents, while package manifests and the WiX installer present the same license to users. Treat prebuilt EXE/MSI files as external GitHub Release assets: do not commit them, and publish only with a public-source commit, SHA-256 file, FFmpeg attribution, and the completed smoke record.

**Tech Stack:** Rust/Cargo, Electron/Node package metadata, WiX RTF, PowerShell, Gitleaks, GitHub Releases.

## Global Constraints

- License: MIT, copyright holder `ReqCase`.
- Retain the ReqCase brand, installer publisher, App ID, and IPC namespace.
- Do not change recorder, capture, privacy, or Electron runtime behavior.
- Do not add installer binaries, recording data, credentials, or historical private commit IDs to Git.
- The release may reuse existing manually-smoke-tested installers only when their public source commit and SHA-256 are recorded.

---

### Task 1: Establish License And Attribution Boundaries

**Files:**
- Create: `LICENSE`
- Create: `NOTICE`
- Modify: `Cargo.toml`
- Modify: `examples/desktop/package.json`
- Modify: `examples/desktop/installer/wix/license.rtf`

- [ ] Add the canonical MIT license with `Copyright (c) 2026 ReqCase`.
- [ ] Add `license = "MIT"` to Cargo package metadata and `"license": "MIT"` to desktop package metadata.
- [ ] State in `NOTICE` that MIT covers this repository's source only; release-bundled FFmpeg and dependencies retain their own licenses.
- [ ] Update the WiX RTF text to identify ReqCase, the MIT license, and the repository `LICENSE` file without presenting third-party components as MIT-licensed.
- [ ] Run `rg -n 'MIT|ReqCase|FFmpeg' LICENSE NOTICE Cargo.toml examples/desktop/package.json examples/desktop/installer/wix/license.rtf`.

### Task 2: Publish Accurate User And Release Documentation

**Files:**
- Modify: `README.md`
- Modify: `examples/desktop/README.md`
- Modify: `tools/ffmpeg/README.md`
- Modify: `docs/release-checklist.md`
- Create: `SECURITY.md`
- Create: `docs/release-artifact-attestation-template.md`

- [ ] Document the Windows scope, local-only evidence storage, explicit plaintext-capture consent, source build steps, and manual installer distribution in `README.md`.
- [ ] Retitle the desktop readme for public ReqCase use and link its license, privacy, FFmpeg, and security notices.
- [ ] Document the pinned FFmpeg download URL, version, checksum source, and the requirement to ship the archive's own attribution with every installer that embeds it.
- [ ] Create `SECURITY.md` with a private reporting instruction and explicitly prohibit public disclosure of recordings, exports, logs, or credentials in an issue.
- [ ] Add an artifact-attestation template requiring a public source commit, release tag, artifact filename, SHA-256, signing state, FFmpeg source/license, and completed manual smoke cases.
- [ ] Update the release checklist to allow reuse of existing installers only through that completed attestation; no private commit IDs may appear in a public release.

### Task 3: Verify Public Boundaries And Release Evidence

**Files:**
- Verify: `.gitignore`
- Verify: `.gitleaks.toml`
- Verify: `scripts/public-repo-audit.ps1`
- Verify: `.github/workflows/secret-scan.yml`

- [ ] Run `pwsh -NoProfile -File scripts/public-repo-audit.ps1` and require exit code 0.
- [ ] Run `gitleaks detect --source . --no-banner --redact` and require no leaks.
- [ ] Run `pwsh -NoProfile -File scripts/public-repo-audit-test.ps1` and require its pass message.
- [ ] Run `git diff --check` and inspect `git status --short` before committing.
- [ ] Commit only documentation, metadata, and license files with the neutral public maintainer identity.

### Task 4: Publish Existing Installers After Repository Creation

**Files:**
- Release asset: existing `.exe` and `.msi` files outside Git
- Release asset: `SHA256SUMS.txt`
- Release body: completed `docs/release-artifact-attestation-template.md`

- [ ] Compute file hashes in the installer directory with `Get-FileHash -Algorithm SHA256` and save release-local `SHA256SUMS.txt`.
- [ ] Confirm the attestation's public source commit exists in the new GitHub repository before upload.
- [ ] Attach only the EXE, MSI, checksums, FFmpeg attribution, and public-safe release notes to the GitHub Release.
- [ ] Enable GitHub Secret Scanning, Push Protection, and required `Secret Scan / Public Repository Boundary` checks before accepting external contributions.
