# Operation Semantic Manual Test (M8-T3 skeleton)

> Status: skeleton for Release A sign-off  
> Related: `docs/操作结果链路语义记录详细实施计划.md`, `docs/compatibility-matrix.md`

## Purpose

Quantify real-application quality that automation cannot fully prove:

- target identification rate
- confirmed outcome accuracy / false-confirm rate
- honest `incomplete` / `observerDegraded` rate
- seek accuracy
- privacy leakage = 0

## Environment matrix

| Dimension | Values |
|---|---|
| OS | Windows 10, Windows 11 |
| DPI | 100%, 125%, 150%, 200% |
| Displays | single, multi |
| Stacks | Win32, WPF, Qt, Electron/Chromium, one weak-UIA app |
| Themes | all app theme presets |
| Feature flags | observer on/off, builder on/off, review v2 on/off |

## Per-stack scenario checklist

For each stack, execute and attach session IDs:

1. Target identity (button / toggle / select / expand / type summary)
2. Observable state change
3. Popup / dialog result
4. No-result incomplete honesty
5. Rapid consecutive actions
6. Pause / resume continuity
7. Copy repro text + defect pack export
8. Old session open / seek / no write-back

## Acceptance thresholds (Release A)

| Metric | Target |
|---|---|
| Strong-UIA target recognition | >= 90% |
| Full-matrix target recognition | >= 80% |
| Strong-UIA coordinate-only | <= 10% |
| Full-matrix coordinate-only | <= 20% |
| Confirmed accuracy | >= 90% |
| False confirmed | <= 2% |
| Incomplete/degraded honesty | = 100% |
| Seek within ±500ms | >= 95% |
| Seek within 1s | = 100% |
| Password / default plaintext leaks | = 0 |

## Report template

```text
Date:
Tester:
Build/commit:
OS/DPI/Displays:
App under test / stack:
Sessions:
  - sessionId=
Metrics:
  targetRecognition= / 
  confirmedAccuracy= / 
  falseConfirm= / 
  incompleteHonesty= / 
  seekOk= / 
Privacy scan: pass/fail
Notes / known issues:
```

## Automation companions

```powershell
cd examples/desktop
npm run test:operation-semantic-suite
npm run test:historical-session-matrix
cargo test operation_golden --test operation_golden
```
