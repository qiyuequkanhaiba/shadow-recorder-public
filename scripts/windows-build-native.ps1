param(
  [ValidateSet('auto', 'x64', 'arm64')]
  [string]$TargetArch = 'auto',
  [switch]$Release,
  [switch]$SkipEnvCheck,
  [switch]$NoTargetInstall
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

function Ensure-Command {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $cmd) {
    throw ("Missing required command: {0}" -f $Name)
  }
  return $cmd.Source
}

function Get-CommandPath {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $cmd) {
    return ''
  }
  return $cmd.Source
}

function Try-GetRustLldPath {
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

function Ensure-NodeFromDll {
  param([string]$DllPath)

  $nodePath = [System.IO.Path]::ChangeExtension($DllPath, '.node')
  Copy-Item -Path $DllPath -Destination $nodePath -Force
  return $nodePath
}

function Try-FindNodeBinary {
  param(
    [string]$RepoRoot,
    [string]$TargetTriple,
    [string]$Profile
  )

  $preferredDllCandidates = @(
    (Join-Path $RepoRoot ("target\{0}\{1}\shadow_recorder.dll" -f $TargetTriple, $Profile)),
    (Join-Path $RepoRoot ("target\{0}\shadow_recorder.dll" -f $Profile))
  )

  foreach ($candidate in $preferredDllCandidates) {
    if (Test-Path $candidate) {
      return (Ensure-NodeFromDll -DllPath $candidate)
    }
  }

  $preferredNodeCandidates = @(
    (Join-Path $RepoRoot ("target\{0}\{1}\shadow_recorder.node" -f $TargetTriple, $Profile)),
    (Join-Path $RepoRoot ("target\{0}\shadow_recorder.node" -f $Profile))
  )

  foreach ($candidate in $preferredNodeCandidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  $foundDll = Get-ChildItem -Path (Join-Path $RepoRoot 'target') -Recurse -Filter 'shadow_recorder.dll' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($foundDll) {
    return (Ensure-NodeFromDll -DllPath $foundDll.FullName)
  }

  $foundNode = Get-ChildItem -Path (Join-Path $RepoRoot 'target') -Recurse -Filter 'shadow_recorder.node' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($foundNode) {
    return $foundNode.FullName
  }

  return ''
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot

try {
  $nodeArch = Get-NodeArch
  $resolvedArch = Resolve-RequestedArch -Requested $TargetArch -NodeArch $nodeArch
  $targetTriple = Get-TargetTriple -Arch $resolvedArch
  $profile = if ($Release) { 'release' } else { 'debug' }
  $displayNodeArch = if ($nodeArch) { $nodeArch } else { '<not found>' }

  Write-Host '[shadow-recorder] Native build'
  Write-Host ("- repoRoot: {0}" -f $repoRoot)
  Write-Host ("- nodeArch: {0}" -f $displayNodeArch)
  Write-Host ("- targetTriple: {0}" -f $targetTriple)
  Write-Host ("- profile: {0}" -f $profile)

  Ensure-Command -Name 'cargo' | Out-Null
  Ensure-Command -Name 'rustup' | Out-Null

  if (-not $SkipEnvCheck) {
    $linkPath = Get-CommandPath -Name 'link'
    $clPath = Get-CommandPath -Name 'cl'
    $rustLldPath = Try-GetRustLldPath -TargetTriple $targetTriple

    if (-not $linkPath -and -not $rustLldPath) {
      throw 'Neither link.exe nor rust-lld.exe is available. Install VS Build Tools or ensure rustup toolchain is complete.'
    }

    if ($linkPath) {
      Write-Host ("- link.exe: {0}" -f $linkPath)
    } else {
      Write-Host ("- link.exe: <not found>; using rust-lld fallback: {0}" -f $rustLldPath)
    }

    if ($clPath) {
      Write-Host ("- cl.exe: {0}" -f $clPath)
    } else {
      Write-Host '- cl.exe: <not found> (continuing; crates with C/C++ sources may require VS Build Tools)'
    }
  }

  if (-not $NoTargetInstall) {
    Write-Host ("- ensuring rust target installed: {0}" -f $targetTriple)
    & rustup target add $targetTriple
  }

  $buildArgs = @('build', '--target', $targetTriple)
  if ($Release) {
    $buildArgs += '--release'
  }

  Write-Host ("- running: cargo {0}" -f ($buildArgs -join ' '))
  & cargo @buildArgs

  $nodeBinary = Try-FindNodeBinary -RepoRoot $repoRoot -TargetTriple $targetTriple -Profile $profile
  if (-not $nodeBinary) {
    throw "Build finished but shadow_recorder.node was not found under target/. Check cargo output."
  }

  $compatDir = Join-Path $repoRoot ("target\{0}" -f $profile)
  $compatBinary = Join-Path $compatDir 'shadow_recorder.node'
  New-Item -ItemType Directory -Force -Path $compatDir | Out-Null

  $normalizedSource = [System.IO.Path]::GetFullPath($nodeBinary)
  $normalizedCompat = [System.IO.Path]::GetFullPath($compatBinary)
  if ($normalizedSource -ne $normalizedCompat) {
    try {
      Copy-Item -Path $nodeBinary -Destination $compatBinary -Force
    } catch {
      Write-Host ("- compatibility copy skipped: {0}" -f $_.Exception.Message)
    }
  }

  Write-Host ("- built addon: {0}" -f $nodeBinary)
  Write-Host ("- compatibility path: {0}" -f $compatBinary)
  Write-Host 'Result: PASS'
} catch {
  Write-Host ("Result: FAIL - {0}" -f $_.Exception.Message)
  Write-Host 'Tip: run scripts/windows-env-check.ps1 first, then use VS Native Tools shell.'
  throw
} finally {
  Pop-Location
}
