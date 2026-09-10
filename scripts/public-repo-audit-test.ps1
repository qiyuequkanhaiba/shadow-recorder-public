$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$auditScript = Join-Path $repoRoot 'scripts/public-repo-audit.ps1'
$gitleaksConfig = Join-Path $repoRoot '.gitleaks.toml'
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    'shadow-recorder-public-audit-test-' + [guid]::NewGuid().ToString('N')
)

$gitleaksConfigText = Get-Content -LiteralPath $gitleaksConfig -Raw
if ($gitleaksConfigText -match 'SENTINEL_\[A-Z_\]\+') {
    throw 'Gitleaks synthetic exceptions must name exact sentinel values.'
}

function Invoke-Git {
    param(
        [string]$Directory,
        [string[]]$Arguments
    )

    Push-Location $Directory
    try {
        $output = @(& git @Arguments 2>&1)
        if ($LASTEXITCODE -ne 0) {
            throw "git $($Arguments -join ' ') failed: $($output | Out-String)"
        }
    } finally {
        Pop-Location
    }
}

function New-AuditFixture {
    param([string]$Name)

    $fixture = Join-Path $fixtureRoot $Name
    $scriptsDirectory = Join-Path $fixture 'scripts'
    New-Item -ItemType Directory -Path $scriptsDirectory -Force | Out-Null
    Copy-Item -LiteralPath $auditScript -Destination (Join-Path $scriptsDirectory 'public-repo-audit.ps1')

    Invoke-Git -Directory $fixture -Arguments @('init', '-q')
    Invoke-Git -Directory $fixture -Arguments @('config', 'user.email', 'test@example.invalid')
    Invoke-Git -Directory $fixture -Arguments @('config', 'user.name', 'Public Audit Test')
    Invoke-Git -Directory $fixture -Arguments @('add', 'scripts/public-repo-audit.ps1')
    Invoke-Git -Directory $fixture -Arguments @('commit', '-qm', 'fixture')

    return $fixture
}

function Invoke-Audit {
    param([string]$Fixture)

    Push-Location $Fixture
    try {
        $output = @(& pwsh -NoProfile -File '.\scripts\public-repo-audit.ps1' 2>&1)
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

    $result = Invoke-Audit -Fixture $Fixture
    if ($result.ExitCode -ne 0) {
        throw "$Scenario should pass. $($result.Output)"
    }
}

function Assert-AuditFails {
    param([string]$Fixture, [string]$Scenario)

    $result = Invoke-Audit -Fixture $Fixture
    if ($result.ExitCode -eq 0) {
        throw "$Scenario should fail."
    }
}

try {
    New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null

    $cleanFixture = New-AuditFixture -Name 'clean'
    Assert-AuditPasses -Fixture $cleanFixture -Scenario 'A clean tracked repository containing the audit script'

    $envFixture = New-AuditFixture -Name 'environment-file'
    New-Item -ItemType File -Path (Join-Path $envFixture ('.' + 'env')) | Out-Null
    Invoke-Git -Directory $envFixture -Arguments @('add', '-f', '.env')
    Assert-AuditFails -Fixture $envFixture -Scenario 'A tracked environment file'

    $envExampleFixture = New-AuditFixture -Name 'environment-example'
    Set-Content -LiteralPath (Join-Path $envExampleFixture '.env.example') -Value 'SETTING=example'
    Invoke-Git -Directory $envExampleFixture -Arguments @('add', '.env.example')
    Assert-AuditPasses -Fixture $envExampleFixture -Scenario 'A tracked environment example file'

    $nestedEnvFixture = New-AuditFixture -Name 'nested-environment-file'
    $nestedDirectory = Join-Path $nestedEnvFixture 'config'
    New-Item -ItemType Directory -Path $nestedDirectory -Force | Out-Null
    New-Item -ItemType File -Path (Join-Path $nestedDirectory '.env.production') | Out-Null
    Invoke-Git -Directory $nestedEnvFixture -Arguments @('add', 'config/.env.production')
    Assert-AuditFails -Fixture $nestedEnvFixture -Scenario 'A tracked nested environment file'

    $evidenceFixture = New-AuditFixture -Name 'evidence-directory'
    $evidenceDirectory = Join-Path $evidenceFixture 'evidence'
    New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $evidenceDirectory 'session.json') -Value '{}'
    Invoke-Git -Directory $evidenceFixture -Arguments @('add', 'evidence/session.json')
    Assert-AuditFails -Fixture $evidenceFixture -Scenario 'A tracked evidence directory'

    $sourceFixture = New-AuditFixture -Name 'source-module'
    $sourceEvidenceDirectory = Join-Path $sourceFixture 'src-react/features/evidence'
    New-Item -ItemType Directory -Path $sourceEvidenceDirectory -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $sourceEvidenceDirectory 'Panel.tsx') -Value 'export {}'
    Invoke-Git -Directory $sourceFixture -Arguments @('add', 'src-react/features/evidence/Panel.tsx')
    Assert-AuditPasses -Fixture $sourceFixture -Scenario 'A source module whose name matches an output directory'

    $textFixture = New-AuditFixture -Name 'private-path'
    Set-Content -LiteralPath (Join-Path $textFixture 'metadata.txt') -Value ('/Us' + 'ers/example')
    Invoke-Git -Directory $textFixture -Arguments @('add', 'metadata.txt')
    Assert-AuditFails -Fixture $textFixture -Scenario 'A tracked private filesystem path'

    if (Get-Command gitleaks -ErrorAction SilentlyContinue) {
        $gitleaksFixture = Join-Path $fixtureRoot 'gitleaks-default-rules'
        New-Item -ItemType Directory -Path $gitleaksFixture -Force | Out-Null
        $syntheticToken = 'gh' + 'p_' + (
            ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')).Substring(0, 36)
        )
        Set-Content -LiteralPath (Join-Path $gitleaksFixture 'credential.txt') -Value $syntheticToken
        $gitleaksOutput = @(& gitleaks dir --config $gitleaksConfig --no-banner $gitleaksFixture 2>&1)
        if ($LASTEXITCODE -eq 0) {
            throw "Gitleaks should detect the synthetic credential. $($gitleaksOutput | Out-String)"
        }

        $allowlistedPathFixture = Join-Path $fixtureRoot 'gitleaks-allowlisted-path'
        $allowlistedPath = Join-Path $allowlistedPathFixture 'src/session'
        New-Item -ItemType Directory -Path $allowlistedPath -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $allowlistedPath 'credential.rs') -Value $syntheticToken
        $gitleaksOutput = @(& gitleaks dir --config $gitleaksConfig --no-banner $allowlistedPathFixture 2>&1)
        if ($LASTEXITCODE -eq 0) {
            throw "Gitleaks should not suppress a credential merely because its path is allowlisted. $($gitleaksOutput | Out-String)"
        }
    }

    Write-Output 'public-repo-audit tests passed'
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
