# Release Operations Runbook

This runbook documents release-time operations that are not safe to encode as repository defaults: code signing identity, signing commands, update channel policy, staged rollout rules, and rollback steps. It complements `docs/release-checklist.md` and must be reviewed for every release candidate.

## Scope

- Applies to Windows NSIS/MSI desktop releases built from `examples/desktop`.
- Assumes `npm run release:preflight` has already passed before packaging or signing.
- Treats auto-update as a release policy and future integration point; the current app does not ship an `electron-updater` runtime path yet.
- Keeps signing secrets, certificate passwords, private keys, and token values outside the repository.

## Signing Certificate Source

- Preferred source: organization-owned OV or EV code-signing certificate issued for the legal publisher name used by the desktop product.
- Preferred storage: hardware-backed key store, HSM, cloud key vault, or CI secret store with audited access.
- Local release machine fallback: Windows certificate store under `CurrentUser\My` or `LocalMachine\My`, imported only on a dedicated release host.
- Disallowed: committing `.pfx`, `.p12`, private keys, passwords, timestamp credentials, or vendor portal tokens.
- Required release note: certificate subject, issuer, thumbprint, expiry date, timestamp server, and operator initials.

## Signing Environment Variables

Electron Builder can sign Windows artifacts when the release environment provides signing configuration. Use the smallest set that matches the release host policy.

| Variable | Purpose | Handling |
| --- | --- | --- |
| `CSC_LINK` | Path or secure URL to a certificate bundle when certificate-file signing is used. | Store in CI or release-host secret storage only. |
| `CSC_KEY_PASSWORD` | Password for `CSC_LINK`. | Secret; never echo in logs. |
| `WIN_CSC_LINK` | Windows-specific certificate override. | Prefer when cross-platform signing config also exists. |
| `WIN_CSC_KEY_PASSWORD` | Password for `WIN_CSC_LINK`. | Secret; never echo in logs. |
| `CSC_NAME` | Certificate subject name when signing from Windows certificate store. | Record value in release evidence. |
| `CSC_IDENTITY_AUTO_DISCOVERY` | Controls automatic identity lookup. | Set to `false` when release must pin an identity explicitly. |

## Signing Commands

Run from `examples/desktop` after preflight. Use the NSIS path for the standard Windows installer and the MSI path only when MSI delivery is required.

```powershell
npm run release:preflight
npm run dist:nsis
```

Optional MSI packaging:

```powershell
npm run dist:wix-msi
```

Post-build signature verification should inspect every generated `.exe` and `.msi` under `examples/desktop/release`.

```powershell
Get-ChildItem .\release -Recurse -Include *.exe,*.msi | ForEach-Object {
  Get-AuthenticodeSignature $_.FullName | Format-List Path,Status,StatusMessage,SignerCertificate,TimeStamperCertificate
}
```

The release owner must block publication if any artifact has a signature status other than `Valid`, lacks a timestamp, or has a signer certificate that does not match the approved publisher identity.

## Auto-Update Channel Policy

Auto-update is not enabled in the current Electron runtime. Until an updater is implemented and reviewed, release distribution is manual: publish signed installers plus release notes, and do not advertise in-app update prompts.

When auto-update is introduced, use explicit channels and keep the default channel conservative:

| Channel | Audience | Rule |
| --- | --- | --- |
| `internal` | Maintainers and QA machines | May receive every signed release candidate after preflight and smoke pass. |
| `beta` | Opt-in users | Requires compatibility matrix coverage for NVIDIA, Intel, AMD, and RDP rows. |
| `stable` | Default users | Requires beta soak completion, no open P0/P1 issues, and rollback artifact availability. |

Updater metadata must be signed or hosted on a protected release system. The app should verify channel, version monotonicity, artifact hash, and signature before installation.

## Staged Rollout Rules

- `0%` hold: artifacts are signed, checksums recorded, and release notes drafted, but no users receive the build.
- `5%` canary: internal or beta audience only; monitor startup, tray, recording start/stop, export, diagnostics export, and crash reports for at least one business day.
- `25%` expansion: allowed only when canary has no P0/P1 regressions and diagnostics do not show privacy-sensitive payload leakage.
- `50%` expansion: allowed only after NVIDIA, Intel, AMD, and RDP smoke rows are updated or explicitly waived by the release owner.
- `100%` stable: allowed only after support, rollback artifact, and previous signed installer availability are confirmed.

Pause rollout immediately for any of these triggers:

- Installer fails signature or SmartScreen validation on a clean machine.
- Recording cannot start or stop on any required GPU/RDP matrix row.
- Evidence export omits manifest/checksum data or bypasses privacy acknowledgement.
- Diagnostics bundle includes screenshots, video, clipboard text, or full window titles.
- Crash rate, startup failure rate, or support reports exceed the release owner's threshold.

## Rollback Procedure

1. Freeze rollout by removing or disabling update metadata for the affected channel; if distribution is manual, remove the public download link.
2. Promote the previous signed installer and release notes as the recommended version.
3. Publish a user-facing advisory with affected versions, rollback version, mitigation, and data-safety notes.
4. Archive safe diagnostics bundles only; do not collect screenshots, video, clipboard text, or full window titles by default.
5. Create a hotfix branch from the last known good tag or revert the offending commits on the release branch.
6. Re-run `npm run release:preflight`, `npm run test:recording-smoke`, signature verification, and compatibility matrix updates before resuming rollout.
7. Record the incident owner, trigger, timeline, rollback artifact, diagnostics location, and follow-up tasks in the release notes or incident tracker.

## Release Evidence Package

Each release should archive these text artifacts alongside installers:

- `docs/release-checklist.md` with operator sign-off notes.
- `docs/compatibility-matrix.md` updated for the candidate.
- `npm run release:preflight` output summary.
- `npm run test:recording-smoke` output summary.
- Signature verification output for `.exe` and `.msi` artifacts.
- SHA-256 checksums for installers and updater metadata if present.
- Rollout decision log covering canary, expansion, pause, or rollback decisions.
