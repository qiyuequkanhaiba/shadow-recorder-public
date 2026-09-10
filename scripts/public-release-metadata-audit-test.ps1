$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$auditScript = Join-Path $repoRoot 'scripts/public-release-metadata-audit.ps1'
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'shadow-recorder-public-release-metadata-test-' + [guid]::NewGuid().ToString('N')
)

function Invoke-MetadataAudit {
    param([string]$Fixture)

    Push-Location $Fixture
    try {
        $output = @(& pwsh -NoProfile -File '.\scripts\public-release-metadata-audit.ps1' 2>&1)
        return [pscustomobject]@{
            ExitCode = $LASTEXITCODE
            Output = $output | Out-String
        }
    } finally {
        Pop-Location
    }
}

function Assert-AuditPasses {
    param([string]$Fixture, [string]$Scenario)

    $result = Invoke-MetadataAudit -Fixture $Fixture
    if ($result.ExitCode -ne 0) {
        throw "$Scenario should pass. $($result.Output)"
    }
}

function Assert-AuditFails {
    param([string]$Fixture, [string]$Scenario)

    $result = Invoke-MetadataAudit -Fixture $Fixture
    if ($result.ExitCode -eq 0) {
        throw "$Scenario should fail."
    }
}

function New-CompleteFixture {
    param([string]$Name)

    $fixture = Join-Path $fixtureRoot $Name
    New-Item -ItemType Directory -Path (Join-Path $fixture 'scripts') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'examples/desktop') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $fixture 'docs/releases') -Force | Out-Null
    Copy-Item -LiteralPath $auditScript -Destination (Join-Path $fixture 'scripts/public-release-metadata-audit.ps1')
    Set-Content -LiteralPath (Join-Path $fixture 'LICENSE') -Value "MIT License`nCopyright (c) 2026 ReqCase"
    Set-Content -LiteralPath (Join-Path $fixture 'NOTICE') -Value 'FFmpeg remains separately licensed.'
    Set-Content -LiteralPath (Join-Path $fixture 'SECURITY.md') -Value 'Report security issues through GitHub without publishing recordings.'
    Set-Content -LiteralPath (Join-Path $fixture 'README.md') -Value 'ReqCase Shadow Recorder uses the MIT License and documents privacy.'
    Set-Content -LiteralPath (Join-Path $fixture 'Cargo.toml') -Value '[package]`nlicense = "MIT"'
    Set-Content -LiteralPath (Join-Path $fixture 'examples/desktop/package.json') -Value '{"license":"MIT","author":"ReqCase"}'
    Set-Content -LiteralPath (Join-Path $fixture 'docs/release-artifact-attestation-template.md') -Value 'SHA256SUMS and FFmpeg attribution'
    Set-Content -LiteralPath (Join-Path $fixture 'docs/releases/v0.1.10-artifact-attestation.md') -Value '4f8355d8ae3e4e477025ee20cf4b1f415934c817'
    return $fixture
}

try {
    if (-not (Test-Path -LiteralPath $auditScript)) {
        throw "Missing public release metadata audit script: $auditScript"
    }

    New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
    $fixture = New-CompleteFixture -Name 'complete'
    Assert-AuditPasses -Fixture $fixture -Scenario 'Complete public release metadata'

    Remove-Item -LiteralPath (Join-Path $fixture 'NOTICE') -Force
    Assert-AuditFails -Fixture $fixture -Scenario 'Missing third-party notice'

    $templateFixture = New-CompleteFixture -Name 'missing-attestation-template'
    Remove-Item -LiteralPath (Join-Path $templateFixture 'docs/release-artifact-attestation-template.md') -Force
    Assert-AuditFails -Fixture $templateFixture -Scenario 'Missing artifact attestation template'

    Write-Output 'public-release-metadata-audit tests passed'
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
