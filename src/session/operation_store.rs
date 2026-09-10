use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::operation_models::{TestSessionOperationRecord, operation_schema_version};

pub const OPERATIONS_FILE_NAME: &str = "operations.ndjson";

#[derive(Debug)]
pub enum OperationStoreError {
    Io(io::Error),
    Serialize(serde_json::Error),
    ParseLine {
        line_number: usize,
        source: serde_json::Error,
    },
}

impl std::fmt::Display for OperationStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(err) => write!(f, "operation store io failed: {err}"),
            Self::Serialize(err) => write!(f, "operation store serialization failed: {err}"),
            Self::ParseLine {
                line_number,
                source,
            } => {
                write!(
                    f,
                    "operation store parse failed at line {line_number}: {source}"
                )
            }
        }
    }
}

impl std::error::Error for OperationStoreError {}

impl From<io::Error> for OperationStoreError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationStoreDiagnostic {
    pub code: String,
    pub severity: String,
    pub line_number: Option<usize>,
    pub schema_version: Option<u32>,
    pub message: String,
}

impl OperationStoreDiagnostic {
    fn corrupt_tail(line_number: usize, source: impl std::fmt::Display) -> Self {
        Self {
            code: "corruptTail".to_string(),
            severity: "warning".to_string(),
            line_number: Some(line_number),
            schema_version: None,
            message: format!(
                "operations.ndjson is corrupt at line {line_number}; loaded the complete prefix: {source}"
            ),
        }
    }

    fn future_schema(line_number: usize, schema_version: u32) -> Self {
        Self {
            code: "futureSchema".to_string(),
            severity: "warning".to_string(),
            line_number: Some(line_number),
            schema_version: Some(schema_version),
            message: format!(
                "operation line {line_number} uses future schemaVersion {schema_version}; session is read-only for operation rebuild/update"
            ),
        }
    }

    fn legacy_schema(line_number: usize, schema_version: u32) -> Self {
        Self {
            code: "legacySchema".to_string(),
            severity: "info".to_string(),
            line_number: Some(line_number),
            schema_version: Some(schema_version),
            message: format!(
                "operation line {line_number} uses legacy schemaVersion {schema_version}; loaded through the v1 adapter"
            ),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct OperationStoreReadReport {
    pub operations: Vec<TestSessionOperationRecord>,
    pub diagnostics: Vec<OperationStoreDiagnostic>,
}

impl OperationStoreReadReport {
    pub fn has_future_schema(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "futureSchema")
    }
}

#[derive(Debug, Clone)]
pub struct OperationStore {
    path: PathBuf,
}

impl OperationStore {
    pub fn for_session_dir(session_dir: impl AsRef<Path>) -> Self {
        Self {
            path: session_dir.as_ref().join(OPERATIONS_FILE_NAME),
        }
    }

    pub fn from_path(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn persist_atomic(
        &self,
        operations: &[TestSessionOperationRecord],
    ) -> Result<(), OperationStoreError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }

        let tmp_path = self.path.with_extension("ndjson.tmp");
        let mut file = fs::File::create(&tmp_path)?;
        for operation in operations {
            serde_json::to_writer(&mut file, operation).map_err(OperationStoreError::Serialize)?;
            file.write_all(b"\n")?;
        }
        file.flush()?;
        file.sync_all()?;
        drop(file);

        fs::rename(&tmp_path, &self.path)?;
        Ok(())
    }

    pub fn read(&self) -> Result<Vec<TestSessionOperationRecord>, OperationStoreError> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }

        let file = fs::File::open(&self.path)?;
        let reader = BufReader::new(file);
        let mut operations = Vec::new();
        for (index, line) in reader.lines().enumerate() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let operation =
                serde_json::from_str::<TestSessionOperationRecord>(&line).map_err(|source| {
                    OperationStoreError::ParseLine {
                        line_number: index + 1,
                        source,
                    }
                })?;
            operations.push(operation);
        }
        Ok(operations)
    }

    pub fn read_compatible(&self) -> Result<OperationStoreReadReport, OperationStoreError> {
        if !self.path.exists() {
            return Ok(OperationStoreReadReport::default());
        }

        let file = fs::File::open(&self.path)?;
        let reader = BufReader::new(file);
        let mut report = OperationStoreReadReport::default();
        let current_schema_version = operation_schema_version();

        for (index, line) in reader.lines().enumerate() {
            let line_number = index + 1;
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }

            let mut value = match serde_json::from_str::<Value>(&line) {
                Ok(value) => value,
                Err(source) => {
                    report
                        .diagnostics
                        .push(OperationStoreDiagnostic::corrupt_tail(line_number, source));
                    break;
                }
            };

            let schema_version = value
                .get("schemaVersion")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or(0);

            if schema_version > current_schema_version {
                report
                    .diagnostics
                    .push(OperationStoreDiagnostic::future_schema(
                        line_number,
                        schema_version,
                    ));
            } else if schema_version < current_schema_version {
                report
                    .diagnostics
                    .push(OperationStoreDiagnostic::legacy_schema(
                        line_number,
                        schema_version,
                    ));
                if let Some(object) = value.as_object_mut() {
                    object.insert(
                        "schemaVersion".to_string(),
                        Value::Number(serde_json::Number::from(current_schema_version)),
                    );
                }
            }

            let operation = match serde_json::from_value::<TestSessionOperationRecord>(value) {
                Ok(operation) => operation,
                Err(source) => {
                    report
                        .diagnostics
                        .push(OperationStoreDiagnostic::corrupt_tail(line_number, source));
                    break;
                }
            };
            report.operations.push(operation);
        }

        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;

    use super::*;

    #[test]
    fn operation_store_persists_and_replaces_ndjson_atomically() {
        let temp_dir = unique_temp_dir("shadowrecord-operation-store");
        let store = OperationStore::for_session_dir(&temp_dir);
        let first = operation("operation-a", 1);
        let second = operation("operation-b", 2);

        store
            .persist_atomic(std::slice::from_ref(&first))
            .expect("persist first operation set");
        assert_eq!(store.read().expect("read first operation set"), vec![first]);

        store
            .persist_atomic(std::slice::from_ref(&second))
            .expect("replace operation set");
        let text = fs::read_to_string(store.path()).expect("read operations.ndjson");
        assert!(text.contains("operation-b"));
        assert!(!text.contains("operation-a"));
        assert!(!store.path().with_extension("ndjson.tmp").exists());
        assert_eq!(
            store.read().expect("read replaced operations"),
            vec![second]
        );

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn operation_compatibility_read_keeps_prefix_and_reports_corrupt_tail() {
        let temp_dir = unique_temp_dir("shadowrecord-operation-store-corrupt-tail");
        let store = OperationStore::for_session_dir(&temp_dir);
        fs::create_dir_all(&temp_dir).expect("create temp dir");
        fs::write(
            store.path(),
            format!(
                "{}\n{{\"schemaVersion\":1,\"kind\":\"reqcase.test-session-operation\"\n",
                serde_json::to_string(&operation("operation-a", 1)).expect("serialize operation")
            ),
        )
        .expect("write corrupt operations");

        let report = store.read_compatible().expect("compatible read");

        assert_eq!(report.operations.len(), 1);
        assert_eq!(report.operations[0].operation_id, "operation-a");
        assert_eq!(report.diagnostics.len(), 1);
        assert_eq!(report.diagnostics[0].code, "corruptTail");
        assert_eq!(report.diagnostics[0].line_number, Some(2));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn operation_compatibility_read_reports_schema_versions_without_writing_back() {
        let temp_dir = unique_temp_dir("shadowrecord-operation-store-schema");
        let store = OperationStore::for_session_dir(&temp_dir);
        fs::create_dir_all(&temp_dir).expect("create temp dir");
        let legacy = serde_json::json!({
            "schemaVersion": 0,
            "kind": "reqcase.test-session-operation",
            "operationId": "operation-legacy",
            "sessionId": "ts-1",
            "sequence": 1,
            "startedAtMs": 1000,
            "endedAtMs": 1420,
            "relativeMsFromSessionStart": 1000,
            "action": {
                "actionId": "action-legacy",
                "kind": "click",
                "occurredAtMs": 1000
            },
            "outcome": {
                "outcomeId": "outcome-legacy",
                "status": "legacyUnknown",
                "summary": "旧记录未采集操作结果",
                "observedAtMs": 1420,
                "latencyMs": 420
            },
            "title": "Legacy click",
            "resultSummary": "旧记录未采集操作结果",
            "displaySummary": "Legacy click -> 旧记录未采集操作结果",
            "precisionLevel": "legacy",
            "businessAlias": null
        });
        let mut future =
            serde_json::to_value(operation("operation-future", 2)).expect("operation to value");
        future["schemaVersion"] = serde_json::json!(999);
        let original_text = format!(
            "{}\n{}\n",
            serde_json::to_string(&legacy).expect("serialize legacy"),
            serde_json::to_string(&future).expect("serialize future"),
        );
        fs::write(store.path(), &original_text).expect("write operations");

        let report = store.read_compatible().expect("compatible read");

        assert_eq!(report.operations.len(), 2);
        assert_eq!(report.operations[0].schema_version, 1);
        assert_eq!(report.operations[0].operation_id, "operation-legacy");
        assert_eq!(report.operations[1].schema_version, 999);
        assert!(report.has_future_schema());
        assert_eq!(
            report
                .diagnostics
                .iter()
                .map(|diagnostic| diagnostic.code.as_str())
                .collect::<Vec<_>>(),
            vec!["legacySchema", "futureSchema"]
        );
        assert_eq!(
            fs::read_to_string(store.path()).expect("read operations after compatible read"),
            original_text
        );

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    fn operation(id: &str, sequence: u32) -> TestSessionOperationRecord {
        serde_json::from_value(json!({
            "schemaVersion": 1,
            "kind": "reqcase.test-session-operation",
            "operationId": id,
            "sessionId": "ts-1",
            "sequence": sequence,
            "startedAtMs": 1000,
            "endedAtMs": 1420,
            "relativeMsFromSessionStart": 1000,
            "action": {
                "actionId": format!("action-{id}"),
                "kind": "click",
                "occurredAtMs": 1000,
                "sourceEventIds": [format!("input-{id}")]
            },
            "outcome": {
                "outcomeId": format!("outcome-{id}"),
                "status": "confirmed",
                "summary": "Done",
                "observedAtMs": 1420,
                "latencyMs": 420
            },
            "title": "Click Save",
            "resultSummary": "Done",
            "displaySummary": "Click Save -> Done, 420ms",
            "precisionLevel": "l3",
            "businessAlias": null
        }))
        .expect("operation fixture should deserialize")
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!("{prefix}-{unique}"))
    }
}
