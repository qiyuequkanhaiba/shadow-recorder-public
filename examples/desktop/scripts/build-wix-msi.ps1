[CmdletBinding()]
param(
  [string]$PayloadDir = "",
  [string]$OutputDir = "",
  [string]$Configuration = "Release",
  [switch]$SkipPack
)

$ErrorActionPreference = "Stop"

$desktopRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $desktopRoot)
$packageJsonPath = Join-Path $desktopRoot "package.json"
$installerRoot = Join-Path $desktopRoot "installer"
$wixRoot = Join-Path $installerRoot "wix"
$wixProjectPath = Join-Path $wixRoot "ShadowRecorder.wixproj"
$defaultOutputDir = Join-Path $desktopRoot "release"
$defaultPayloadDir = Join-Path $defaultOutputDir "win-unpacked"
$iconPath = Join-Path $repoRoot "ico.ico"

if ([string]::IsNullOrWhiteSpace($PayloadDir)) {
  $PayloadDir = $defaultPayloadDir
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = $defaultOutputDir
}

if (-not (Test-Path $packageJsonPath)) {
  throw "package.json not found: $packageJsonPath"
}

$packageJson = Get-Content -Raw -Encoding UTF8 $packageJsonPath | ConvertFrom-Json
$productName = [string]$packageJson.build.productName
$productVersion = [string]$packageJson.version
$appExeName = "$productName.exe"

$payloadExePath = Join-Path $PayloadDir $appExeName

if (-not $SkipPack -and -not (Test-Path -LiteralPath $payloadExePath)) {
  Push-Location $desktopRoot
  try {
    npm run pack
    if ($LASTEXITCODE -ne 0) {
      throw "npm run pack failed with exit code $LASTEXITCODE"
    }
  }
  finally {
    Pop-Location
  }
}

if (-not (Test-Path -LiteralPath $payloadExePath)) {
  throw "Packaged app payload not found: $PayloadDir"
}

if (-not (Test-Path $wixProjectPath)) {
  throw "WiX project not found: $wixProjectPath"
}

if (-not (Test-Path $iconPath)) {
  throw "Installer icon not found: $iconPath"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$msbuildOutputDir = Join-Path $OutputDir "wix-msi"
$outputName = "$productName $productVersion"

$arguments = @(
  "build",
  $wixProjectPath,
  "-c", $Configuration,
  "-p:AppPayloadDir=$PayloadDir",
  "-p:OutputPath=$msbuildOutputDir",
  "-p:OutputName=$outputName",
  "-p:ProductName=$productName",
  "-p:ProductVersion=$productVersion",
  "-p:Manufacturer=ReqCase",
  "-p:AppExeName=$appExeName",
  "-p:IconPath=$iconPath",
  "-nologo"
)

& dotnet @arguments
if ($LASTEXITCODE -ne 0) {
  throw "dotnet build failed with exit code $LASTEXITCODE"
}

$builtMsiPath = Join-Path $msbuildOutputDir "$outputName.msi"
if (-not (Test-Path $builtMsiPath)) {
  throw "WiX MSI not found after build: $builtMsiPath"
}

$finalMsiPath = Join-Path $OutputDir "$outputName.msi"
Copy-Item -LiteralPath $builtMsiPath -Destination $finalMsiPath -Force

Write-Output "WiX MSI ready: $finalMsiPath"
