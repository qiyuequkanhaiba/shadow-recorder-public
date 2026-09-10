param(
  [Parameter(Mandatory = $true)]
  [string]$Window,

  [int]$Duration = 6,

  [int]$Fps = 30,

  [int]$Bitrate = 5000000,

  [int]$InputWidth = 0,

  [int]$InputHeight = 0,

  [int]$OutputWidth = 0,

  [int]$OutputHeight = 0,

  [string]$Output = "",

  [ValidateSet('h264', 'hevc')]
  [string]$Encoder = 'h264',

  [ValidateSet('auto', 'h264-baseline', 'h264-main', 'h264-high', 'hevc-main')]
  [string]$Profile = 'auto',

  [ValidateSet('dxgi', 'memory')]
  [string]$SampleTransport = 'dxgi',

  [ValidateSet('off', 'desktop', 'window')]
  [string]$Audio = 'off',

  [switch]$Exact,

  [switch]$Debug,

  [switch]$DisableHwTransforms,

  [switch]$EnableSinkThrottling,

  [switch]$DisableLowLatency,

  [switch]$DisableAsyncConverter
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot 'tools/windows-record-poc/Cargo.toml'

$arguments = @(
  'run',
  '--manifest-path',
  $manifestPath,
  '--',
  '--window',
  $Window,
  '--duration',
  $Duration.ToString(),
  '--fps',
  $Fps.ToString(),
  '--bitrate',
  $Bitrate.ToString(),
  '--encoder',
  $Encoder,
  '--profile',
  $Profile,
  '--sample-transport',
  $SampleTransport,
  '--audio',
  $Audio
)

if ($Output -ne '') {
  $arguments += @('--output', $Output)
}

if ($InputWidth -gt 0) {
  $arguments += @('--input-width', $InputWidth.ToString())
}

if ($InputHeight -gt 0) {
  $arguments += @('--input-height', $InputHeight.ToString())
}

if ($OutputWidth -gt 0) {
  $arguments += @('--output-width', $OutputWidth.ToString())
}

if ($OutputHeight -gt 0) {
  $arguments += @('--output-height', $OutputHeight.ToString())
}

if ($Exact) {
  $arguments += '--exact'
}

if ($Debug) {
  $arguments += '--debug'
}

if ($DisableHwTransforms) {
  $arguments += '--disable-hw-transforms'
}

if ($EnableSinkThrottling) {
  $arguments += '--enable-sink-throttling'
}

if ($DisableLowLatency) {
  $arguments += '--disable-low-latency'
}

if ($DisableAsyncConverter) {
  $arguments += '--disable-async-converter'
}

Push-Location $repoRoot
try {
  cargo @arguments
} finally {
  Pop-Location
}
