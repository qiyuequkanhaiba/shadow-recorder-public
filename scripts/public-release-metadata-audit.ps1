$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot

function Require-File {
    param([string]$RelativePath)

    $path = Join-Path $repoRoot $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required public release metadata file is missing: $RelativePath"
    }
    return $path
}

function Require-Text {
    param([string]$RelativePath, [string]$Pattern, [string]$Description)

    $path = Require-File -RelativePath $RelativePath
    $content = Get-Content -LiteralPath $path -Raw
    if ($content -notmatch $Pattern) {
        throw "$RelativePath must contain $Description."
    }
}

$licensePath = Require-File -RelativePath 'LICENSE'
$licenseText = Get-Content -LiteralPath $licensePath -Raw
if ($licenseText -notmatch '(?m)^MIT License\s*$' -or $licenseText -notmatch 'Copyright \(c\) 2026 ReqCase') {
    throw 'LICENSE must contain the ReqCase MIT license notice.'
}

Require-Text -RelativePath 'NOTICE' -Pattern 'FFmpeg' -Description 'the FFmpeg attribution boundary'
Require-Text -RelativePath 'NOTICE' -Pattern 'separately\s+licensed' -Description 'the separate third-party license boundary'
Require-Text -RelativePath 'SECURITY.md' -Pattern 'GitHub' -Description 'the private GitHub reporting route'
Require-Text -RelativePath 'SECURITY.md' -Pattern '(?i)recording' -Description 'the sensitive-recording disclosure rule'
Require-Text -RelativePath 'README.md' -Pattern 'MIT License' -Description 'the MIT license link'
Require-Text -RelativePath 'README.md' -Pattern '(?i)privacy' -Description 'the privacy disclosure'
Require-Text -RelativePath 'docs/release-artifact-attestation-template.md' -Pattern 'SHA256SUMS' -Description 'the release checksum requirement'
Require-Text -RelativePath 'docs/release-artifact-attestation-template.md' -Pattern 'FFmpeg' -Description 'the FFmpeg attribution requirement'
Require-Text -RelativePath 'docs/releases/v0.1.10-artifact-attestation.md' -Pattern '4f8355d8ae3e4e477025ee20cf4b1f415934c817' -Description 'the public v0.1.10 source commit'
Require-Text -RelativePath 'Cargo.toml' -Pattern 'license\s*=\s*"MIT"' -Description 'Cargo MIT metadata'

$desktopPackagePath = Require-File -RelativePath 'examples/desktop/package.json'
$desktopPackage = Get-Content -LiteralPath $desktopPackagePath -Raw | ConvertFrom-Json
if ($desktopPackage.license -ne 'MIT') {
    throw 'examples/desktop/package.json must declare the MIT license.'
}
if ($desktopPackage.author -ne 'ReqCase') {
    throw 'examples/desktop/package.json must retain the approved ReqCase author identity.'
}

Write-Output 'public-release-metadata-audit passed'
