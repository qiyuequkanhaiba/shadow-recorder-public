param(
  [ValidateSet('auto', 'x64', 'arm64')]
  [string]$TargetArch = 'auto',
  [switch]$Json
)

$ErrorActionPreference = 'Stop'

function Get-NodeArch {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $node) {
    return ''
  }

  try {
    return (& node -p "process.arch" 2>$null).Trim()
  } catch {
    return ''
  }
}

function Resolve-RequestedArch {
  param(
    [string]$Requested,
    [string]$NodeArch
  )

  if ($Requested -ne 'auto') {
    return $Requested
  }

  if ($NodeArch -eq 'x64' -or $NodeArch -eq 'arm64') {
    return $NodeArch
  }

  if ($env:PROCESSOR_ARCHITECTURE -match 'ARM64') {
    return 'arm64'
  }

  return 'x64'
}

function Get-TargetTriple {
  param([string]$Arch)
  if ($Arch -eq 'arm64') {
    return 'aarch64-pc-windows-msvc'
  }
  return 'x86_64-pc-windows-msvc'
}

function Get-CommandPath {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $cmd) {
    return ''
  }
  return $cmd.Source
}

function Get-RustLldPath {
  param([string]$TargetTriple)

  $rustcPath = Get-CommandPath -Name 'rustc'
  if (-not $rustcPath) {
    return ''
  }

  try {
    $sysroot = (& rustc --print sysroot 2>$null).Trim()
  } catch {
    return ''
  }

  if ([string]::IsNullOrWhiteSpace($sysroot)) {
    return ''
  }

  $candidate = Join-Path $sysroot ("lib\rustlib\{0}\bin\rust-lld.exe" -f $TargetTriple)
  if (Test-Path $candidate) {
    return $candidate
  }

  return ''
}

function Write-CheckLine {
  param(
    [string]$Key,
    [string]$Value
  )

  Write-Host ("- {0}: {1}" -f $Key, $Value)
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nodeArch = Get-NodeArch
$resolvedArch = Resolve-RequestedArch -Requested $TargetArch -NodeArch $nodeArch
$targetTriple = Get-TargetTriple -Arch $resolvedArch

$cargoPath = Get-CommandPath -Name 'cargo'
$rustupPath = Get-CommandPath -Name 'rustup'
$linkPath = Get-CommandPath -Name 'link'
$clPath = Get-CommandPath -Name 'cl'
$rustLldPath = Get-RustLldPath -TargetTriple $targetTriple

$installedTargets = @()
if ($rustupPath) {
  try {
    $installedTargets = @(& rustup target list --installed 2>$null | Where-Object { $_ -and $_.Trim().Length -gt 0 })
  } catch {
    $installedTargets = @()
  }
}

$defaultHost = ''
$activeToolchain = ''
if ($rustupPath) {
  try {
    $rustupShow = @(& rustup show 2>$null)
    foreach ($line in $rustupShow) {
      if ($line -match '^Default host:\s+(.+)$') {
        $defaultHost = $Matches[1].Trim()
      }
      if ($line -match '^name:\s+(.+)$') {
        $activeToolchain = $Matches[1].Trim()
      }
    }
  } catch {
    $defaultHost = ''
    $activeToolchain = ''
  }
}

$addonCandidates = @(
  (Join-Path $repoRoot 'target\debug\shadow_recorder.node'),
  (Join-Path $repoRoot 'target\release\shadow_recorder.node'),
  (Join-Path $repoRoot ("target\{0}\debug\shadow_recorder.node" -f $targetTriple)),
  (Join-Path $repoRoot ("target\{0}\release\shadow_recorder.node" -f $targetTriple))
)
$existingAddon = $addonCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
$dllCandidates = @(
  (Join-Path $repoRoot 'target\debug\shadow_recorder.dll'),
  (Join-Path $repoRoot 'target\release\shadow_recorder.dll'),
  (Join-Path $repoRoot ("target\{0}\debug\shadow_recorder.dll" -f $targetTriple)),
  (Join-Path $repoRoot ("target\{0}\release\shadow_recorder.dll" -f $targetTriple))
)
$existingDll = $dllCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

$errors = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

if (-not $cargoPath) {
  $errors.Add('cargo not found in PATH.')
}
if (-not $rustupPath) {
  $errors.Add('rustup not found in PATH.')
}
if (-not $linkPath -and -not $rustLldPath) {
  $errors.Add('Neither link.exe nor rust-lld.exe is available. Install VS Build Tools or ensure rustup toolchain is complete.')
} elseif (-not $linkPath -and $rustLldPath) {
  $warnings.Add(("link.exe not found in PATH; using rust-lld fallback: {0}" -f $rustLldPath))
}
if (-not $clPath) {
  $warnings.Add('cl.exe not found in PATH. This is acceptable for pure Rust crates but C/C++ build scripts may fail.')
}
if ($installedTargets.Count -gt 0 -and -not ($installedTargets -contains $targetTriple)) {
  $warnings.Add(("Rust target '{0}' is not installed. Run: rustup target add {0}" -f $targetTriple))
}
if (-not $env:WindowsSdkDir) {
  $warnings.Add('WindowsSdkDir is empty (often expected only inside VS Native Tools shell).')
}
if (-not $env:VCToolsInstallDir) {
  $warnings.Add('VCToolsInstallDir is empty (often expected only inside VS Native Tools shell).')
}
if ($existingAddon -and $existingDll) {
  $addonTime = (Get-Item $existingAddon).LastWriteTimeUtc
  $dllTime = (Get-Item $existingDll).LastWriteTimeUtc
  if ($addonTime -lt $dllTime) {
    $warnings.Add(("shadow_recorder.node appears stale (node: {0:u}, dll: {1:u}). Run scripts/windows-build-native.ps1 to refresh addon." -f $addonTime, $dllTime))
  }
}

$result = [ordered]@{
  repoRoot = $repoRoot
  nodeArch = if ($nodeArch) { $nodeArch } else { $null }
  targetArch = $resolvedArch
  targetTriple = $targetTriple
  cargoPath = if ($cargoPath) { $cargoPath } else { $null }
  rustupPath = if ($rustupPath) { $rustupPath } else { $null }
  linkPath = if ($linkPath) { $linkPath } else { $null }
  clPath = if ($clPath) { $clPath } else { $null }
  rustLldPath = if ($rustLldPath) { $rustLldPath } else { $null }
  defaultHost = if ($defaultHost) { $defaultHost } else { $null }
  activeToolchain = if ($activeToolchain) { $activeToolchain } else { $null }
  installedTargets = $installedTargets
  windowsSdkDir = if ($env:WindowsSdkDir) { $env:WindowsSdkDir } else { $null }
  vcToolsInstallDir = if ($env:VCToolsInstallDir) { $env:VCToolsInstallDir } else { $null }
  addonFound = [bool]$existingAddon
  addonPath = if ($existingAddon) { $existingAddon } else { $null }
  errors = @($errors)
  warnings = @($warnings)
  ok = ($errors.Count -eq 0)
}

if ($Json) {
  $result | ConvertTo-Json -Depth 6
  if ($errors.Count -gt 0) {
    $host.SetShouldExit(1)
  }
  return
}

Write-Host '[shadow-recorder] Windows env check'
$displayNodeArch = if ($nodeArch) { $nodeArch } else { '<not found>' }
$displayCargoPath = if ($cargoPath) { $cargoPath } else { '<not found>' }
$displayRustupPath = if ($rustupPath) { $rustupPath } else { '<not found>' }
$displayLinkPath = if ($linkPath) { $linkPath } else { '<not found>' }
$displayClPath = if ($clPath) { $clPath } else { '<not found>' }
$displayRustLldPath = if ($rustLldPath) { $rustLldPath } else { '<not found>' }
$displayDefaultHost = if ($defaultHost) { $defaultHost } else { '<unknown>' }
$displayActiveToolchain = if ($activeToolchain) { $activeToolchain } else { '<unknown>' }
$displayTargetInstalled = if ($installedTargets -contains $targetTriple) { 'yes' } else { 'no' }
$displayAddon = if ($existingAddon) { $existingAddon } else { '<not found>' }

Write-CheckLine -Key 'repoRoot' -Value $repoRoot
Write-CheckLine -Key 'nodeArch' -Value $displayNodeArch
Write-CheckLine -Key 'targetTriple' -Value $targetTriple
Write-CheckLine -Key 'cargo' -Value $displayCargoPath
Write-CheckLine -Key 'rustup' -Value $displayRustupPath
Write-CheckLine -Key 'link.exe' -Value $displayLinkPath
Write-CheckLine -Key 'cl.exe' -Value $displayClPath
Write-CheckLine -Key 'rust-lld.exe' -Value $displayRustLldPath
Write-CheckLine -Key 'defaultHost' -Value $displayDefaultHost
Write-CheckLine -Key 'activeToolchain' -Value $displayActiveToolchain
Write-CheckLine -Key 'targetInstalled' -Value $displayTargetInstalled
Write-CheckLine -Key 'addon' -Value $displayAddon

if ($warnings.Count -gt 0) {
  Write-Host ''
  Write-Host 'Warnings:'
  foreach ($warning in $warnings) {
    Write-Host ("- {0}" -f $warning)
  }
}

if ($errors.Count -gt 0) {
  Write-Host ''
  Write-Host 'Errors:'
  foreach ($errorText in $errors) {
    Write-Host ("- {0}" -f $errorText)
  }
  Write-Host ''
  Write-Host 'Result: FAIL'
} else {
  Write-Host ''
  Write-Host 'Result: PASS'
}

if ($errors.Count -gt 0) {
  $host.SetShouldExit(1)
}
