param(
  [switch]$SkipWindowsEnvCheck,
  [switch]$SkipBuild,
  [string]$BenchmarkBaselinePath = "",
  [string]$BenchmarkCandidatePath = "",
  [double]$BenchmarkCaptureGoal = 0.15,
  [double]$BenchmarkEncodeGoal = 0.15,
  [double]$BenchmarkDropGoal = 0.30
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Path $PSScriptRoot -Parent
$desktopRoot = Join-Path $repoRoot "examples/desktop"

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Action
  )

  Write-Host "==> $Name"
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "Step failed: $Name (exit code $LASTEXITCODE)"
  }
}

function Read-BenchmarkReport {
  param(
    [string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Benchmark report not found: $Path"
  }

  Get-Content -Path $Path -Raw | ConvertFrom-Json
}

function Get-BenchmarkMetric {
  param(
    [object]$Report,
    [string]$MetricName
  )

  if ($null -eq $Report.metrics) {
    throw "Benchmark report is missing metrics object."
  }

  $metric = $Report.metrics.PSObject.Properties[$MetricName]
  if ($null -eq $metric) {
    throw "Benchmark report is missing metrics.$MetricName."
  }

  [double]$metric.Value
}

function Get-BenchmarkDropTotal {
  param(
    [object]$Report
  )

  (Get-BenchmarkMetric -Report $Report -MetricName "droppedStepsTotal") +
    (Get-BenchmarkMetric -Report $Report -MetricName "captureQueueDropTotal") +
    (Get-BenchmarkMetric -Report $Report -MetricName "encodeQueueDropTotal")
}

function New-BenchmarkComparison {
  param(
    [string]$Name,
    [double]$BaselineValue,
    [double]$CandidateValue,
    [double]$Threshold
  )

  $increase = $CandidateValue - $BaselineValue
  $ratioValue = $null
  $ratioLabel = "0.00%"
  $failed = $false

  if ($BaselineValue -le 0) {
    if ($CandidateValue -gt $BaselineValue) {
      $ratioLabel = "new regression from zero baseline"
      $failed = $true
    }
  } else {
    $ratio = $increase / $BaselineValue
    $ratioValue = [Math]::Round($ratio, 6)
    $ratioLabel = "{0:P2}" -f $ratio
    $failed = $CandidateValue -gt $BaselineValue -and $ratio -gt $Threshold
  }

  [pscustomobject]@{
    metric = $Name
    baseline = $BaselineValue
    candidate = $CandidateValue
    increase = [Math]::Round($increase, 6)
    regressionRatio = $ratioValue
    regressionRatioLabel = $ratioLabel
    threshold = $Threshold
    status = $(if ($failed) { "fail" } else { "pass" })
  }
}

function Invoke-BenchmarkCompareGate {
  param(
    [string]$BaselinePath,
    [string]$CandidatePath,
    [double]$CaptureGoal,
    [double]$EncodeGoal,
    [double]$DropGoal,
    [string]$ResultJsonPath,
    [string]$ResultMarkdownPath
  )

  $baseline = Read-BenchmarkReport -Path $BaselinePath
  $candidate = Read-BenchmarkReport -Path $CandidatePath

  $comparisons = @(
    New-BenchmarkComparison `
      -Name "captureLatencyP95Ms" `
      -BaselineValue (Get-BenchmarkMetric -Report $baseline -MetricName "captureLatencyP95Ms") `
      -CandidateValue (Get-BenchmarkMetric -Report $candidate -MetricName "captureLatencyP95Ms") `
      -Threshold $CaptureGoal
    New-BenchmarkComparison `
      -Name "encodeLatencyP95Ms" `
      -BaselineValue (Get-BenchmarkMetric -Report $baseline -MetricName "encodeLatencyP95Ms") `
      -CandidateValue (Get-BenchmarkMetric -Report $candidate -MetricName "encodeLatencyP95Ms") `
      -Threshold $EncodeGoal
    New-BenchmarkComparison `
      -Name "dropTotal" `
      -BaselineValue (Get-BenchmarkDropTotal -Report $baseline) `
      -CandidateValue (Get-BenchmarkDropTotal -Report $candidate) `
      -Threshold $DropGoal
  )

  $failedComparisons = @($comparisons | Where-Object { $_.status -eq "fail" })
  $passed = $failedComparisons.Count -eq 0
  $result = [pscustomobject]@{
    passed = $passed
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    baselinePath = (Resolve-Path -LiteralPath $BaselinePath).Path
    candidatePath = (Resolve-Path -LiteralPath $CandidatePath).Path
    thresholds = [pscustomobject]@{
      captureLatencyP95Ms = $CaptureGoal
      encodeLatencyP95Ms = $EncodeGoal
      dropTotal = $DropGoal
    }
    comparisons = $comparisons
  }

  $result | ConvertTo-Json -Depth 8 | Set-Content -Path $ResultJsonPath -Encoding UTF8

  $markdown = @(
    "# Benchmark Compare Result",
    "",
    "- Passed: $passed",
    "- Baseline: $($result.baselinePath)",
    "- Candidate: $($result.candidatePath)",
    "",
    "| Metric | Baseline | Candidate | Increase | Regression | Threshold | Status |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |"
  )
  foreach ($comparison in $comparisons) {
    $thresholdLabel = "{0:P2}" -f $comparison.threshold
    $markdown += "| $($comparison.metric) | $($comparison.baseline) | $($comparison.candidate) | $($comparison.increase) | $($comparison.regressionRatioLabel) | $thresholdLabel | $($comparison.status) |"
  }
  $markdown += ""
  [System.IO.File]::WriteAllLines($ResultMarkdownPath, $markdown, [System.Text.UTF8Encoding]::new($false))

  if (-not $passed) {
    $failedNames = ($failedComparisons | ForEach-Object { $_.metric }) -join ", "
    throw "Benchmark compare gate failed: $failedNames"
  }
}

Write-Host "[shadow-recorder] quality gate"
Write-Host "- repoRoot: $repoRoot"
Write-Host "- desktopRoot: $desktopRoot"

if ([string]::IsNullOrWhiteSpace($BenchmarkBaselinePath)) {
  $BenchmarkBaselinePath = $env:SHADOW_RECORDER_BENCHMARK_BASELINE_PATH
}
if ([string]::IsNullOrWhiteSpace($BenchmarkCandidatePath)) {
  $BenchmarkCandidatePath = $env:SHADOW_RECORDER_BENCHMARK_CANDIDATE_PATH
}
if (-not [string]::IsNullOrWhiteSpace($env:SHADOW_RECORDER_BENCHMARK_CAPTURE_GOAL)) {
  $BenchmarkCaptureGoal = [double]$env:SHADOW_RECORDER_BENCHMARK_CAPTURE_GOAL
}
if (-not [string]::IsNullOrWhiteSpace($env:SHADOW_RECORDER_BENCHMARK_ENCODE_GOAL)) {
  $BenchmarkEncodeGoal = [double]$env:SHADOW_RECORDER_BENCHMARK_ENCODE_GOAL
}
if (-not [string]::IsNullOrWhiteSpace($env:SHADOW_RECORDER_BENCHMARK_DROP_GOAL)) {
  $BenchmarkDropGoal = [double]$env:SHADOW_RECORDER_BENCHMARK_DROP_GOAL
}
if ($BenchmarkCaptureGoal -lt 0 -or $BenchmarkCaptureGoal -gt 1) {
  throw "BenchmarkCaptureGoal must be in [0,1], got $BenchmarkCaptureGoal"
}
if ($BenchmarkEncodeGoal -lt 0 -or $BenchmarkEncodeGoal -gt 1) {
  throw "BenchmarkEncodeGoal must be in [0,1], got $BenchmarkEncodeGoal"
}
if ($BenchmarkDropGoal -lt 0 -or $BenchmarkDropGoal -gt 1) {
  throw "BenchmarkDropGoal must be in [0,1], got $BenchmarkDropGoal"
}

$hasBaseline = -not [string]::IsNullOrWhiteSpace($BenchmarkBaselinePath)
$hasCandidate = -not [string]::IsNullOrWhiteSpace($BenchmarkCandidatePath)
if (($hasBaseline -and -not $hasCandidate) -or (-not $hasBaseline -and $hasCandidate)) {
  throw "Benchmark gate misconfigured: both BenchmarkBaselinePath and BenchmarkCandidatePath are required together."
}

if (-not $SkipWindowsEnvCheck) {
  Invoke-Step "windows env check" {
    powershell -ExecutionPolicy Bypass -File (Join-Path $repoRoot "scripts/windows-env-check.ps1")
  }
} else {
  Write-Host "==> windows env check (skipped)"
}

Invoke-Step "cargo fmt --all -- --check" {
  cargo fmt --all -- --check
}

Invoke-Step "cargo test" {
  cargo test
}

Invoke-Step "cargo clippy --all-targets -- -D warnings" {
  cargo clippy --all-targets -- -D warnings
}

Push-Location $desktopRoot
try {
  $packageJson = Get-Content -Path (Join-Path $desktopRoot "package.json") -Raw | ConvertFrom-Json
  $availableScripts = @{}
  $packageJson.scripts.PSObject.Properties | ForEach-Object {
    $availableScripts[$_.Name] = $true
  }

  function Invoke-NpmScript {
    param(
      [string]$ScriptName
    )

    if (-not $availableScripts.ContainsKey($ScriptName)) {
      throw "Required npm script is missing from examples/desktop/package.json: $ScriptName"
    }

    Invoke-Step "npm run $ScriptName" { npm run $ScriptName }
  }

  $benchmarkArtifactsDir = Join-Path $desktopRoot ".ci-artifacts"
  $benchmarkResultJson = Join-Path $benchmarkArtifactsDir "quality-gate-benchmark-compare-result.json"
  $benchmarkResultMd = Join-Path $benchmarkArtifactsDir "quality-gate-benchmark-compare-result.md"
  New-Item -ItemType Directory -Path $benchmarkArtifactsDir -Force | Out-Null

  Invoke-NpmScript "typecheck:electron"
  Invoke-NpmScript "typecheck:react"
  Invoke-NpmScript "test:floating-toolbar"
  Invoke-NpmScript "test:metrics-stream"
  Invoke-NpmScript "test:quick-defect-fallback"
  Invoke-NpmScript "test:recorder-page-bindings"
  Invoke-NpmScript "test:tuning-advisor-commands"
  Invoke-NpmScript "test:recorder-bootstrap-bindings"
  Invoke-NpmScript "test:recorder-bootstrap-loader"
  Invoke-NpmScript "test:ipc-validators"
  Invoke-NpmScript "test:report-export"
  Invoke-NpmScript "test:evidence-export"
  Invoke-NpmScript "test:evidence-manifest-v2"

  # Operation semantic Release A contract/compatibility suite (M8-T1 skeleton)
  Invoke-NpmScript "test:operation-golden-contract"
  Invoke-NpmScript "test:operation-ipc-validators"
  Invoke-NpmScript "test:operation-compatibility"
  Invoke-NpmScript "test:recording-review-interaction"
  Invoke-NpmScript "test:operation-performance-skeleton"
  Invoke-NpmScript "test:semantic-profile-contract"

  if ($hasBaseline -and $hasCandidate) {
    Invoke-Step "benchmark compare gate" {
      Invoke-BenchmarkCompareGate `
        -BaselinePath $BenchmarkBaselinePath `
        -CandidatePath $BenchmarkCandidatePath `
        -CaptureGoal $BenchmarkCaptureGoal `
        -EncodeGoal $BenchmarkEncodeGoal `
        -DropGoal $BenchmarkDropGoal `
        -ResultJsonPath $benchmarkResultJson `
        -ResultMarkdownPath $benchmarkResultMd
    }
    Write-Host "==> benchmark compare artifacts"
    Write-Host "   - $benchmarkResultJson"
    Write-Host "   - $benchmarkResultMd"
  } else {
    Write-Host "==> benchmark compare gate (skipped)"
  }

  if (-not $SkipBuild) {
    Invoke-NpmScript "build:electron"
    Invoke-NpmScript "build:react"
  } else {
    Write-Host "==> build steps (skipped)"
  }
} finally {
  Pop-Location
}

# Write a compact machine-readable summary for CI / release notes.
$gateSummary = [pscustomobject]@{
  passed = $true
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  repoRoot = $repoRoot
  desktopRoot = $desktopRoot
  layers = @(
    [pscustomobject]@{ name = "rust-fmt"; status = "pass" }
    [pscustomobject]@{ name = "rust-test"; status = "pass" }
    [pscustomobject]@{ name = "rust-clippy"; status = "pass" }
    [pscustomobject]@{ name = "typescript"; status = "pass" }
    [pscustomobject]@{ name = "operation-contracts"; status = "pass" }
    [pscustomobject]@{ name = "operation-compatibility"; status = "pass" }
    [pscustomobject]@{ name = "recording-review"; status = "pass" }
  )
  notes = @(
    "M8 skeleton: unit/golden/contract/UI interaction scripts are required.",
    "Full performance long-run and manual compatibility matrix remain separate Release A sign-off steps."
  )
}
$summaryDir = Join-Path $desktopRoot ".ci-artifacts"
New-Item -ItemType Directory -Path $summaryDir -Force | Out-Null
$summaryPath = Join-Path $summaryDir "quality-gate-summary.json"
$gateSummary | ConvertTo-Json -Depth 6 | Set-Content -Path $summaryPath -Encoding UTF8

Write-Host ""
Write-Host "[shadow-recorder] quality gate passed"
Write-Host "   - summary: $summaryPath"
