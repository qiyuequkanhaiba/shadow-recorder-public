[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$IncludeReleaseOutput,
  [switch]$IncludeNodeModules,
  [switch]$RemoveLogs
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot

function Resolve-SafePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $resolved = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetFullPath($repoRoot)

  if (-not $resolved.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to touch path outside repo root: $resolved"
  }

  return $resolved
}

function Get-PathSizeBytes {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return 0
  }

  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer) {
    return [int64]$item.Length
  }

  return [int64](
    (Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue |
      Measure-Object -Property Length -Sum).Sum
  )
}

function Format-Size {
  param(
    [Parameter(Mandatory = $true)]
    [Int64]$Bytes
  )

  if ($Bytes -ge 1GB) {
    return ('{0:N2} GB' -f ($Bytes / 1GB))
  }
  if ($Bytes -ge 1MB) {
    return ('{0:N2} MB' -f ($Bytes / 1MB))
  }
  if ($Bytes -ge 1KB) {
    return ('{0:N2} KB' -f ($Bytes / 1KB))
  }
  return "$Bytes B"
}

$targets = @(
  'examples\desktop\reports',
  'reports',
  'target',
  'examples\desktop\dist-electron',
  'examples\desktop\dist-react',
  'examples\desktop\installer\wix\obj',
  'examples\desktop\release\wix-msi',
  'tools\windows-record-poc\target',
  'tools\windows-record-fork\target',
  'tools\ffmpeg\cache',
  'tools\ffmpeg\extract',
  'examples\desktop\tmp-mp4-frames',
  'examples\desktop\tmp-ffmpeg-tests',
  'examples\desktop\tmp-ffmpeg-pts-tests',
  'examples\desktop\tmp-playback-frames'
)

if ($IncludeReleaseOutput) {
  $targets += @(
    'examples\desktop\release\win-unpacked'
  )
}

if ($IncludeNodeModules) {
  $targets += @(
    'examples\desktop\node_modules'
  )
}

$logPatterns = @(
  'examples\desktop\codex-*.log',
  'examples\desktop\tmp-*.log'
)

$resolvedTargets = New-Object System.Collections.Generic.List[object]

foreach ($relativePath in $targets) {
  $fullPath = Resolve-SafePath -Path (Join-Path $repoRoot $relativePath)
  if (-not (Test-Path -LiteralPath $fullPath)) {
    continue
  }

  $resolvedTargets.Add([PSCustomObject]@{
      Path = $fullPath
      Type = 'Path'
      SizeBytes = Get-PathSizeBytes -Path $fullPath
    })
}

if ($RemoveLogs) {
  foreach ($pattern in $logPatterns) {
    $searchRoot = Split-Path -Parent (Join-Path $repoRoot $pattern)
    $leafPattern = Split-Path -Leaf $pattern
    if (-not (Test-Path -LiteralPath $searchRoot)) {
      continue
    }

    Get-ChildItem -LiteralPath $searchRoot -Filter $leafPattern -Force -File -ErrorAction SilentlyContinue |
      ForEach-Object {
        $resolvedTargets.Add([PSCustomObject]@{
            Path = $_.FullName
            Type = 'File'
            SizeBytes = [int64]$_.Length
          })
      }
  }
}

$totalBytes = [int64](($resolvedTargets | Measure-Object -Property SizeBytes -Sum).Sum)

if ($resolvedTargets.Count -eq 0) {
  Write-Output '[safe-clean-workspace] Nothing to clean.'
  exit 0
}

Write-Output '[safe-clean-workspace] Targets:'
$resolvedTargets |
  Sort-Object -Property SizeBytes -Descending |
  Select-Object @{ Name = 'Path'; Expression = { $_.Path } },
  @{ Name = 'Size'; Expression = { Format-Size -Bytes $_.SizeBytes } } |
  Format-Table -AutoSize

Write-Output ("[safe-clean-workspace] Reclaimable: {0}" -f (Format-Size -Bytes $totalBytes))

if ($DryRun) {
  Write-Output '[safe-clean-workspace] Dry run only. No files were removed.'
  exit 0
}

foreach ($target in $resolvedTargets) {
  if ($target.Type -eq 'File') {
    Remove-Item -LiteralPath $target.Path -Force -ErrorAction Stop
  } else {
    Remove-Item -LiteralPath $target.Path -Recurse -Force -ErrorAction Stop
  }
}

Write-Output ("[safe-clean-workspace] Removed {0} targets. Reclaimed about {1}." -f $resolvedTargets.Count, (Format-Size -Bytes $totalBytes))
