use super::*;

#[derive(Debug)]
pub enum SessionError {
    AlreadyActive(String),
    NoActiveSession,
    SessionNotFound(String),
    InvalidLookup(String),
    AlreadyPaused,
    NotPaused,
    LockPoisoned,
    Io(io::Error),
    Serialize(serde_json::Error),
    FfmpegLoopRuntime(FfmpegLoopRuntimeError),
    DefectPack(DefectPackError),
    SemanticEventStore(SemanticEventStoreError),
    UiaObserver(UiaObserverError),
    OperationStore(OperationStoreError),
    OperationOverride(OperationOverrideError),
    DiskSpace(String),
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyActive(session_id) => {
                write!(f, "test session is already active: {session_id}")
            }
            Self::NoActiveSession => write!(f, "test session is not active"),
            Self::SessionNotFound(session_id) => write!(f, "test session not found: {session_id}"),
            Self::InvalidLookup(message) => write!(f, "test session lookup is invalid: {message}"),
            Self::AlreadyPaused => write!(f, "test session is already paused"),
            Self::NotPaused => write!(f, "test session is not paused"),
            Self::LockPoisoned => write!(f, "test session state lock is poisoned"),
            Self::Io(err) => write!(f, "test session io failed: {err}"),
            Self::Serialize(err) => write!(f, "test session serialization failed: {err}"),
            Self::FfmpegLoopRuntime(err) => write!(f, "ffmpeg loop runtime failed: {err}"),
            Self::DefectPack(crate::session::defect_pack::DefectPackError::DiskSpace(message)) => {
                write!(f, "{message}")
            }
            Self::DefectPack(err) => write!(f, "defect pack failed: {err}"),
            Self::DiskSpace(message) => write!(f, "{message}"),
            Self::SemanticEventStore(err) => write!(f, "semantic event store failed: {err}"),
            Self::UiaObserver(err) => write!(f, "UIA observer failed: {err}"),
            Self::OperationStore(err) => write!(f, "operation store failed: {err}"),
            Self::OperationOverride(err) => write!(f, "operation override failed: {err}"),
        }
    }
}

impl std::error::Error for SessionError {}

impl From<io::Error> for SessionError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for SessionError {
    fn from(value: serde_json::Error) -> Self {
        Self::Serialize(value)
    }
}

impl From<FfmpegLoopRuntimeError> for SessionError {
    fn from(value: FfmpegLoopRuntimeError) -> Self {
        Self::FfmpegLoopRuntime(value)
    }
}

impl From<DefectPackError> for SessionError {
    fn from(value: DefectPackError) -> Self {
        Self::DefectPack(value)
    }
}

impl From<SemanticEventStoreError> for SessionError {
    fn from(value: SemanticEventStoreError) -> Self {
        Self::SemanticEventStore(value)
    }
}

impl From<UiaObserverError> for SessionError {
    fn from(value: UiaObserverError) -> Self {
        Self::UiaObserver(value)
    }
}

impl From<OperationStoreError> for SessionError {
    fn from(value: OperationStoreError) -> Self {
        Self::OperationStore(value)
    }
}

impl From<OperationOverrideError> for SessionError {
    fn from(value: OperationOverrideError) -> Self {
        Self::OperationOverride(value)
    }
}
