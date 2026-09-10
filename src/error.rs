use std::fmt::{Display, Formatter};

#[derive(Debug)]
pub enum RecorderError {
    AlreadyRunning,
    NotRunning,
    HookInstallFailed(String),
    ThreadStartFailed,
    LockPoisoned,
    WindowApiFailed(String),
    DxgiUnsupported,
    DxgiCaptureFailed(String),
    RawInputUnsupported,
}

impl Display for RecorderError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyRunning => write!(f, "recording is already running"),
            Self::NotRunning => write!(f, "recording is not running"),
            Self::HookInstallFailed(msg) => write!(f, "failed to install mouse hook: {msg}"),
            Self::ThreadStartFailed => write!(f, "failed to start recorder thread"),
            Self::LockPoisoned => write!(f, "shared state lock is poisoned"),
            Self::WindowApiFailed(msg) => write!(f, "window api failed: {msg}"),
            Self::DxgiUnsupported => write!(f, "dxgi desktop duplication unsupported"),
            Self::DxgiCaptureFailed(msg) => write!(f, "dxgi capture failed: {msg}"),
            Self::RawInputUnsupported => write!(f, "raw input is not enabled in current build"),
        }
    }
}

impl std::error::Error for RecorderError {}
