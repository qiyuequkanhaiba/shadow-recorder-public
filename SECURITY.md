# Security Policy

## Reporting A Vulnerability

Do not open a public issue containing a vulnerability report, recording,
evidence export, diagnostic bundle, window title, clipboard content, API key,
or other sensitive data.

After the GitHub repository is created, use its private vulnerability-reporting
flow under the repository Security tab. Until that flow is enabled, contact the
ReqCase release contact through the private channel used to obtain the
installer. Include a minimal reproduction, affected version, and impact; redact
all captured content before sending it.

## Scope

Reports about the Windows native addon, Electron main process, IPC validation,
local evidence storage, export behavior, installer integrity, and privacy
controls are in scope. Reports should state whether semantic plaintext capture
was explicitly enabled, because it is disabled by default.
