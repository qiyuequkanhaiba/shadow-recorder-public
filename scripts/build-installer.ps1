$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$desktopDir = Join-Path $repoRoot 'examples\desktop'

try {
    Write-Host "======================================" -ForegroundColor Cyan
    Write-Host " 1. Building Native Addon (Release)" -ForegroundColor Cyan
    Write-Host "======================================" -ForegroundColor Cyan
    & powershell -ExecutionPolicy Bypass -File "$PSScriptRoot\windows-build-native.ps1" -Release -SkipEnvCheck
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) { throw "Native build failed." }

    Set-Location $desktopDir

    Write-Host "`n======================================" -ForegroundColor Cyan
    Write-Host " 2. Installing Node Dependencies" -ForegroundColor Cyan
    Write-Host "======================================" -ForegroundColor Cyan
    & npm install
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) { throw "npm install failed." }

    Write-Host "`n======================================" -ForegroundColor Cyan
    Write-Host " 3. Building Formats (TS -> JS)" -ForegroundColor Cyan
    Write-Host "======================================" -ForegroundColor Cyan
    & npm run build
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) { throw "npm run build failed." }

    Write-Host "`n======================================" -ForegroundColor Cyan
    Write-Host " 3.5. Preparing Application Assets" -ForegroundColor Cyan
    Write-Host "======================================" -ForegroundColor Cyan
    $buildDir = Join-Path $desktopDir 'build'
    if (-not (Test-Path $buildDir)) { New-Item -ItemType Directory -Path $buildDir | Out-Null }
    Copy-Item -Path (Join-Path $repoRoot 'ico.ico') -Destination (Join-Path $buildDir 'icon.ico') -Force
    
    Write-Host "`n======================================" -ForegroundColor Cyan
    Write-Host " 4. Packaging with electron-builder" -ForegroundColor Cyan
    Write-Host "======================================" -ForegroundColor Cyan
    & npm run dist
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) { throw "npm run dist failed." }

    Write-Host "`n======================================" -ForegroundColor Green
    Write-Host " SUCCESS: Installer ready in \examples\desktop\release" -ForegroundColor Green
    Write-Host "======================================" -ForegroundColor Green
}
catch {
    Write-Error $_
    exit 1
}
finally {
    Set-Location $repoRoot
}
