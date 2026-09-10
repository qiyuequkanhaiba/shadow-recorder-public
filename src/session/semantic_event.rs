#![allow(dead_code, unused_imports)]

use super::models::TEST_SESSION_SCHEMA_VERSION;
pub use super::operation_models::{
    ObserverHealthPayload, ObserverHealthState, OperationReasonCode, PrivacyClass,
    SemanticEventRecord, SemanticEventType, TEST_SESSION_SEMANTIC_EVENT_KIND, UiElementIdentity,
};

pub const SEMANTIC_EVENTS_FILE_NAME: &str = "semantic-events.ndjson";
pub const SEMANTIC_EVENT_SCHEMA_VERSION: u32 = TEST_SESSION_SCHEMA_VERSION;
