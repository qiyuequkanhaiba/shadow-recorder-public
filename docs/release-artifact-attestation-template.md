# Release Artifact Attestation

Copy this file into a GitHub Release body or attach a completed copy next to
the installers. Complete every field before publishing. Do not include a
private repository URL, private commit ID, local filesystem path, recording,
or credential.

## Public Source

| Field | Required value |
| --- | --- |
| Release tag | Public tag, for example `v0.1.10` |
| Public source commit | Full commit ID reachable from the public repository |
| Source relationship | State whether the installer was rebuilt from this commit or is an attested existing artifact with identical runtime/build source files |
| Release notes | Public-safe summary of behavior, privacy, compatibility, and known limitations |

## Artifacts

| File name | Architecture | SHA-256 | Signature status | Manual smoke |
| --- | --- | --- | --- | --- |
| NSIS EXE | x64 | Required | Valid, invalid, or unsigned | Passed, failed, or not run |
| WiX MSI | x64 | Required | Valid, invalid, or unsigned | Passed, failed, or not run |

Publish `SHA256SUMS.txt` with the EXE and MSI. The checksum must be computed
from the exact uploaded files. An unsigned installer must be identified as
unsigned; do not claim SmartScreen or signature verification passed without
evidence.

## FFmpeg Attribution

| Field | Required value |
| --- | --- |
| Bundled | Yes or no |
| Source URL | Exact archive URL, or `not bundled` |
| Version | Exact FFmpeg archive version, or `not bundled` |
| Archive SHA-256 | Verified archive checksum, or `not bundled` |
| License material | Name of the license and notice files copied from the exact archive |

## Acceptance

- Release owner confirms the recorded smoke result reflects the uploaded
  installer, not a different local build.
- Privacy defaults and the plaintext-capture opt-in are described accurately.
- The public source commit, artifact hashes, FFmpeg attribution, and security
  reporting route are available before the download link is made public.
