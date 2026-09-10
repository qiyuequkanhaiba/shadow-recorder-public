$ErrorActionPreference = 'Stop'
$forbiddenPath = '((^|/)\.env($|\.)|^(diagnostics|evidence|test-sessions)(/|$)|\.(pem|key|p12|pfx|mobileprovision|mp4|mov|avi|mkv|webm|wav|mp3|sqlite|db)$)'
$forbiddenText = '/Users/|/Volumes/|[A-Za-z]:\\Users\\'

$badPaths = git ls-files | Where-Object {
  $_ -match $forbiddenPath -and $_ -notmatch '(^|/)\.env\.example$'
}
$badText = @(& git grep -n -I -E $forbiddenText -- ':!scripts/public-repo-audit.ps1' 2>&1)
if ($LASTEXITCODE -eq 1) {
  $badText = @()
} elseif ($LASTEXITCODE -ne 0) {
  throw "Tracked-content scan failed: $($badText | Out-String)"
}

if ($badPaths -or $badText) {
  $badPaths
  $badText
  throw 'Public repository boundary audit failed.'
}
