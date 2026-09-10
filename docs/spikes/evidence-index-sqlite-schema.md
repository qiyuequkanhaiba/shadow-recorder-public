# Evidence Index SQLite Schema

## Goal

Define the next-stage SQLite evidence index used to locate exported evidence bundles, verify file checksums, and prepare for future FTS search without changing the current directory or zip export formats.

## Schema

```sql
CREATE TABLE IF NOT EXISTS evidence_sessions (
  session_id TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  native_version TEXT NOT NULL,
  manifest_path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES evidence_sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_evidence_files_session_id ON evidence_files(session_id);
```

## Ingestion Rules

- `evidence_sessions.manifest_path` points to `manifest.v2.json` for new exports.
- `evidence_files` is populated from `manifest.v2.json.files`.
- `manifest.v2.json.files` includes checksums for every exported file except `manifest.v2.json` itself.
- `sha256-manifest.json` remains in the export for compatibility and is indexed as a normal evidence file when listed by `manifest.v2.json`.

## Deferred FTS Extension

Add FTS only after privacy rules and export confirmation are in place, so searchable text never bypasses masking or exclusion policies.
