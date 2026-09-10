# Performance Baseline

Shadow Recorder uses a lightweight baseline report to keep recorder performance changes measurable before longer native benchmark suites are stable in CI.

## Generate a Baseline

Run from `examples/desktop`:

```powershell
npm run test:performance-baseline -- --output-root .ci-artifacts/performance-baseline
```

On Windows, `npm run` may forward the values without their `--name` keys when invoking `tsx`; the script accepts both named flags and the positional order shown in the measured-values example below.

The command writes a timestamped report directory containing:

- `performance-baseline.json`: machine-readable environment, native mode, latency, drop, and memory metrics.
- `performance-baseline.md`: human-readable summary with regression notes.

By default the script records the current host and uses conservative placeholder metrics. Supply measured values when a native benchmark run is available:

```powershell
npm run test:performance-baseline -- `
  --output-root .ci-artifacts/performance-baseline `
  --capture-backend wgc `
  --input-mode raw_input `
  --transport-mode push `
  --delta-mode dirty_rect `
  --capture-p50 8 `
  --capture-p95 14 `
  --encode-p50 10 `
  --encode-p95 18 `
  --dropped-steps 0 `
  --capture-drops 0 `
  --encode-drops 0 `
  --max-rss 420
```

## Compare Candidate Runs

Run the quality gate with both report paths to enable the benchmark compare gate:

```powershell
powershell -ExecutionPolicy Bypass -File ..\..\scripts\quality-gate.ps1 `
  -SkipWindowsEnvCheck `
  -SkipBuild `
  -BenchmarkBaselinePath .ci-artifacts\performance-baseline\baseline\performance-baseline.json `
  -BenchmarkCandidatePath .ci-artifacts\performance-baseline\candidate\performance-baseline.json
```

When both paths are provided, the gate compares:

- `metrics.captureLatencyP95Ms` against `-BenchmarkCaptureGoal`.
- `metrics.encodeLatencyP95Ms` against `-BenchmarkEncodeGoal`.
- Combined drop total against `-BenchmarkDropGoal`.

The default goals allow up to 15% p95 capture regression, 15% p95 encode regression, and 30% drop total regression. Any new drop from a zero baseline fails because the ratio is undefined and should be reviewed explicitly.

## Artifacts

Store local baseline artifacts under `examples/desktop/.ci-artifacts/`. The directory is ignored by Git and is safe for repeated local runs.

The compare gate writes:

- `examples/desktop/.ci-artifacts/quality-gate-benchmark-compare-result.json`
- `examples/desktop/.ci-artifacts/quality-gate-benchmark-compare-result.md`

Keep the latest accepted baseline path in release notes or CI configuration before enabling this gate as a required release check.
