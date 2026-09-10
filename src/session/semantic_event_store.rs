#![allow(dead_code)]

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use super::semantic_event::{SEMANTIC_EVENTS_FILE_NAME, SemanticEventRecord};
use super::semantic_privacy::sanitize_semantic_event_for_storage;

#[derive(Debug)]
pub enum SemanticEventStoreError {
    Io(io::Error),
    ParseLine {
        line_number: usize,
        source: serde_json::Error,
    },
    QueueFull {
        capacity: usize,
    },
}

impl std::fmt::Display for SemanticEventStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(err) => write!(f, "semantic event store io failed: {err}"),
            Self::ParseLine {
                line_number,
                source,
            } => {
                write!(
                    f,
                    "semantic event store parse failed at line {line_number}: {source}"
                )
            }
            Self::QueueFull { capacity } => {
                write!(
                    f,
                    "semantic event store queue is full at capacity {capacity}"
                )
            }
        }
    }
}

impl std::error::Error for SemanticEventStoreError {}

impl From<io::Error> for SemanticEventStoreError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

#[derive(Debug, Clone)]
pub struct SemanticEventStore {
    path: PathBuf,
}

#[derive(Debug, Clone, Default)]
pub struct SemanticEventReadReport {
    pub events: Vec<SemanticEventRecord>,
    pub ignored_truncated_tail: bool,
    pub malformed_line_count: u32,
}

pub struct SemanticEventBatchWriter {
    store: SemanticEventStore,
    queue: Vec<SemanticEventRecord>,
    capacity: usize,
}

impl SemanticEventStore {
    pub fn for_session_dir(session_dir: impl AsRef<Path>) -> Self {
        Self {
            path: session_dir.as_ref().join(SEMANTIC_EVENTS_FILE_NAME),
        }
    }

    pub fn from_path(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn append(&self, event: &SemanticEventRecord) -> Result<(), SemanticEventStoreError> {
        self.append_batch(std::slice::from_ref(event))
    }

    pub fn append_batch(
        &self,
        events: &[SemanticEventRecord],
    ) -> Result<(), SemanticEventStoreError> {
        if events.is_empty() {
            return Ok(());
        }

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        for event in events {
            let sanitized = sanitize_semantic_event_for_storage(event);
            serde_json::to_writer(&mut file, &sanitized).map_err(|source| {
                SemanticEventStoreError::ParseLine {
                    line_number: 0,
                    source,
                }
            })?;
            file.write_all(b"\n")?;
        }
        file.flush()?;
        Ok(())
    }

    pub fn read(&self) -> Result<SemanticEventReadReport, SemanticEventStoreError> {
        if !self.path.exists() {
            return Ok(SemanticEventReadReport::default());
        }

        let content = fs::read_to_string(&self.path)?;
        let ends_with_newline = content.ends_with('\n') || content.ends_with('\r');
        let lines = content.lines().collect::<Vec<_>>();
        let last_index = lines.len().saturating_sub(1);
        let mut report = SemanticEventReadReport::default();

        for (index, line) in lines.iter().enumerate() {
            if line.trim().is_empty() {
                continue;
            }

            match serde_json::from_str::<SemanticEventRecord>(line) {
                Ok(event) => report.events.push(event),
                Err(_) if index == last_index && !ends_with_newline => {
                    report.ignored_truncated_tail = true;
                    report.malformed_line_count = report.malformed_line_count.saturating_add(1);
                    break;
                }
                Err(source) => {
                    return Err(SemanticEventStoreError::ParseLine {
                        line_number: index + 1,
                        source,
                    });
                }
            }
        }

        Ok(report)
    }
}

impl SemanticEventBatchWriter {
    pub fn new(store: SemanticEventStore, capacity: usize) -> Self {
        Self {
            store,
            queue: Vec::with_capacity(capacity),
            capacity,
        }
    }

    pub fn enqueue(&mut self, event: SemanticEventRecord) -> Result<(), SemanticEventStoreError> {
        if self.queue.len() >= self.capacity {
            return Err(SemanticEventStoreError::QueueFull {
                capacity: self.capacity,
            });
        }
        self.queue.push(event);
        Ok(())
    }

    pub fn flush(&mut self) -> Result<(), SemanticEventStoreError> {
        self.store.append_batch(&self.queue)?;
        self.queue.clear();
        Ok(())
    }

    pub fn pending_len(&self) -> usize {
        self.queue.len()
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;

    use super::{SemanticEventBatchWriter, SemanticEventStore, SemanticEventStoreError};
    use crate::session::semantic_event::{
        OperationReasonCode, PrivacyClass, SEMANTIC_EVENT_SCHEMA_VERSION, SemanticEventRecord,
        SemanticEventType, TEST_SESSION_SEMANTIC_EVENT_KIND,
    };

    #[test]
    fn semantic_event_store_appends_and_reads_events_in_order() {
        let temp_dir = unique_temp_dir("shadowrecord-semantic-store-order");
        let store = SemanticEventStore::for_session_dir(&temp_dir);
        store.append(&sample_event(1)).expect("append first event");
        store.append(&sample_event(2)).expect("append second event");

        let report = store.read().expect("read semantic events");
        assert_eq!(report.events.len(), 2);
        assert_eq!(report.events[0].event_id, "sem-1");
        assert_eq!(report.events[1].event_id, "sem-2");
        assert!(!report.ignored_truncated_tail);
        assert_eq!(report.malformed_line_count, 0);

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn semantic_event_store_ignores_only_truncated_tail() {
        let temp_dir = unique_temp_dir("shadowrecord-semantic-store-tail");
        let store = SemanticEventStore::for_session_dir(&temp_dir);
        store
            .append_batch(&[sample_event(1), sample_event(2)])
            .expect("append batch");
        fs::OpenOptions::new()
            .append(true)
            .open(store.path())
            .expect("open semantic events")
            .write_all(b"{\"schemaVersion\":1,\"kind\"")
            .expect("append partial tail");

        let report = store.read().expect("read prefix");
        assert_eq!(report.events.len(), 2);
        assert!(report.ignored_truncated_tail);
        assert_eq!(report.malformed_line_count, 1);

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn semantic_event_store_errors_on_middle_malformed_line() {
        let temp_dir = unique_temp_dir("shadowrecord-semantic-store-middle-error");
        let store = SemanticEventStore::for_session_dir(&temp_dir);
        store.append(&sample_event(1)).expect("append first event");
        fs::OpenOptions::new()
            .append(true)
            .open(store.path())
            .expect("open semantic events")
            .write_all(b"{not-json}\n")
            .expect("append malformed line");
        store.append(&sample_event(2)).expect("append second event");

        let err = store.read().expect_err("middle malformed line should fail");
        assert!(matches!(
            err,
            SemanticEventStoreError::ParseLine { line_number: 2, .. }
        ));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn semantic_event_batch_writer_enforces_capacity_and_flushes() {
        let temp_dir = unique_temp_dir("shadowrecord-semantic-store-batch-writer");
        let store = SemanticEventStore::for_session_dir(&temp_dir);
        let mut writer = SemanticEventBatchWriter::new(store.clone(), 2);
        writer.enqueue(sample_event(1)).expect("enqueue first");
        writer.enqueue(sample_event(2)).expect("enqueue second");
        let err = writer
            .enqueue(sample_event(3))
            .expect_err("queue should be full");
        assert!(matches!(
            err,
            SemanticEventStoreError::QueueFull { capacity: 2 }
        ));
        assert_eq!(writer.pending_len(), 2);

        writer.flush().expect("flush queue");
        assert_eq!(writer.pending_len(), 0);
        let report = store.read().expect("read flushed events");
        assert_eq!(report.events.len(), 2);

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn semantic_event_store_writes_100k_ordered_events() {
        let temp_dir = unique_temp_dir("shadowrecord-semantic-store-100k");
        let store = SemanticEventStore::for_session_dir(&temp_dir);
        let events = (0..100_000).map(sample_event).collect::<Vec<_>>();
        store.append_batch(&events).expect("append 100k events");

        let report = store.read().expect("read 100k events");
        assert_eq!(report.events.len(), 100_000);
        assert_eq!(
            report.events.first().map(|event| event.event_id.as_str()),
            Some("sem-0")
        );
        assert_eq!(
            report.events.last().map(|event| event.event_id.as_str()),
            Some("sem-99999")
        );
        assert!(!report.ignored_truncated_tail);

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn semantic_event_store_sanitizes_events_before_write() {
        let temp_dir = unique_temp_dir("shadowrecord-semantic-store-privacy");
        let store = SemanticEventStore::for_session_dir(&temp_dir);
        let mut event = sample_event(1);
        event.payload = json!({
            "property": "Value.Value",
            "value": "SENTINEL_STORE_SECRET",
            "before": "old",
            "after": "SENTINEL_STORE_SECRET"
        });

        store.append(&event).expect("append sensitive event");

        let raw = fs::read_to_string(store.path()).expect("read semantic events raw file");
        assert!(!raw.contains("SENTINEL_STORE_SECRET"));
        assert!(raw.contains("valueLength"));
        let report = store.read().expect("read sanitized event");
        assert_eq!(report.events[0].privacy_class, PrivacyClass::TextLengthOnly);

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    fn sample_event(index: usize) -> SemanticEventRecord {
        SemanticEventRecord {
            schema_version: SEMANTIC_EVENT_SCHEMA_VERSION,
            kind: TEST_SESSION_SEMANTIC_EVENT_KIND.to_string(),
            event_id: format!("sem-{index}"),
            session_id: "ts-semantic".to_string(),
            event_type: SemanticEventType::UiaPropertyChanged,
            occurred_at_ms: index as u64,
            monotonic_offset_ms: Some(index as u64),
            source_event_id: Some(format!("evt-{index}")),
            target: None,
            payload: json!({
                "property": "toggleState",
                "before": "off",
                "after": "on"
            }),
            privacy_class: PrivacyClass::NotSensitive,
            reason_codes: vec![OperationReasonCode::ToggleStateChanged],
        }
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!("{prefix}-{unique}"))
    }
}
