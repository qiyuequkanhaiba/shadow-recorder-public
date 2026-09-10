//! UI Automation observer lifecycle and semantic-event writer ownership.
//!
//! M2-T1 keeps real UIA callbacks off the recording path: callbacks enqueue
//! already-minimized semantic records into this worker, and the worker is the
//! only owner of the append-only semantic-events writer while it is active.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde_json::{Map, Value, from_value, to_value};

#[cfg(all(windows, not(test)))]
use std::sync::Mutex;
#[cfg(all(windows, not(test)))]
use std::sync::atomic::AtomicU64;

use super::models::TestSessionRecord;
#[cfg(all(windows, not(test)))]
use super::operation_models::{
    ExpandCollapseState, SelectionState, ToggleState, UiElementIdentity, UiElementPathEntry,
};
use super::operation_models::{UiStateSnapshot, UiStateSnapshotSource};
use super::semantic_event::{
    ObserverHealthPayload, ObserverHealthState, OperationReasonCode, PrivacyClass,
    SEMANTIC_EVENT_SCHEMA_VERSION, SemanticEventRecord, SemanticEventType,
    TEST_SESSION_SEMANTIC_EVENT_KIND,
};
use super::semantic_event_store::{
    SemanticEventBatchWriter, SemanticEventStore, SemanticEventStoreError,
};
use super::uia_state_cache::{UiaStateCache, state_cache_key};
#[cfg(all(windows, not(test)))]
use crate::config::DEFAULT_UIA_OBSERVER_POLLING_DELAYS_MS;
use crate::config::{
    DEFAULT_UIA_OBSERVER_DEDUP_MS, DEFAULT_UIA_OBSERVER_EVENT_BUDGET_PER_SECOND,
    DEFAULT_UIA_OBSERVER_LOW_PRIORITY_EVENT_BUDGET_PER_SECOND,
    DEFAULT_UIA_OBSERVER_QUEUE_HIGH_WATERMARK,
};
#[cfg(all(windows, not(test)))]
use crate::telemetry::inc_uia_observer_polling_attempt;
use crate::telemetry::{
    inc_uia_observer_dropped, inc_uia_observer_duplicate_drop, inc_uia_observer_queue_overflow,
    inc_uia_observer_rate_limit_drop, inc_uia_observer_restart, inc_uia_observer_timeout,
    read_uia_observer_circuit_open, set_uia_observer_circuit_open, set_uia_observer_queue_depth,
};

const OBSERVER_QUEUE_CAPACITY: usize = 1024;
const WRITER_BATCH_CAPACITY: usize = 128;
const STOP_JOIN_TIMEOUT: Duration = Duration::from_millis(2_000);
const FLUSH_ACK_TIMEOUT: Duration = Duration::from_millis(2_000);
const WORKER_POLL_INTERVAL: Duration = Duration::from_millis(40);
const CRASH_RESTART_BACKOFF_MS: [u64; 5] = [50, 100, 250, 500, 1_000];
const INTERACTION_POLL_DELAYS_MS: [u64; 5] = [100, 300, 700, 1_500, 3_000];
const RECENT_INTERACTION_BIND_WINDOW_MS: u64 = 300;

#[derive(Debug)]
pub enum UiaObserverError {
    MissingSessionDir,
    ThreadStartFailed,
    QueueFull {
        capacity: usize,
    },
    WrongSession {
        active: String,
        event: String,
    },
    CommandChannelClosed,
    #[allow(dead_code)]
    NativeInit(String),
    Store(SemanticEventStoreError),
    FlushTimeout,
}

impl std::fmt::Display for UiaObserverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingSessionDir => write!(f, "UIA observer requires a session directory"),
            Self::ThreadStartFailed => write!(f, "UIA observer worker failed to start"),
            Self::QueueFull { capacity } => {
                write!(f, "UIA observer queue is full at capacity {capacity}")
            }
            Self::WrongSession { active, event } => write!(
                f,
                "UIA observer event belongs to session {event}, active observer session is {active}"
            ),
            Self::CommandChannelClosed => write!(f, "UIA observer command channel is closed"),
            Self::NativeInit(message) => write!(f, "UIA observer native init failed: {message}"),
            Self::Store(err) => write!(f, "{err}"),
            Self::FlushTimeout => write!(f, "UIA observer flush timed out"),
        }
    }
}

impl std::error::Error for UiaObserverError {}

impl From<SemanticEventStoreError> for UiaObserverError {
    fn from(value: SemanticEventStoreError) -> Self {
        Self::Store(value)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UiaObserverStopReport {
    pub drained_event_count: usize,
    pub dropped_event_count: u32,
    pub duplicate_drop_count: u32,
    pub rate_limit_drop_count: u32,
    pub queue_overflow_count: u32,
    pub timeout_count: u32,
    pub restart_count: u32,
    pub polling_attempt_count: u32,
    pub write_error_count: u32,
}

#[derive(Debug)]
enum UiaObserverCommand {
    Pause(bool),
    Event(Box<SemanticEventRecord>),
    Flush(mpsc::SyncSender<Result<(), SemanticEventStoreError>>),
    Reconfigure(UiaObserverSession),
    /// Schedule limited compensation polls for the most recent interaction point.
    ScheduleInteractionPoll {
        source_event_id: String,
        x: i32,
        y: i32,
        base_at: Instant,
    },
    /// Cancel pending interaction compensation polls (next input / pause / stop).
    CancelInteractionPolls,
}

/// Pure schedule for interaction compensation polls (unit-testable).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InteractionCompensationPoll {
    pub source_event_id: String,
    pub x: i32,
    pub y: i32,
    pub base_at: Instant,
    pub delays_ms: Vec<u64>,
    pub next_index: usize,
}

impl InteractionCompensationPoll {
    pub fn new(source_event_id: impl Into<String>, x: i32, y: i32, base_at: Instant) -> Self {
        Self {
            source_event_id: source_event_id.into(),
            x,
            y,
            base_at,
            delays_ms: INTERACTION_POLL_DELAYS_MS.to_vec(),
            next_index: 0,
        }
    }

    pub fn next_due_at(&self) -> Option<Instant> {
        self.delays_ms
            .get(self.next_index)
            .map(|delay| self.base_at + Duration::from_millis(*delay))
    }

    /// Returns true when a poll slot is due and advances the cursor.
    pub fn take_due(&mut self, now: Instant) -> bool {
        let Some(due_at) = self.next_due_at() else {
            return false;
        };
        if now < due_at {
            return false;
        }
        self.next_index = self.next_index.saturating_add(1);
        true
    }

    pub fn is_finished(&self) -> bool {
        self.next_index >= self.delays_ms.len()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentInteraction {
    pub source_event_id: String,
    pub x: i32,
    pub y: i32,
    pub occurred_at_ms: u64,
}

pub fn should_bind_source_event(
    event: &SemanticEventRecord,
    recent: &RecentInteraction,
    window_ms: u64,
) -> bool {
    if event
        .source_event_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return false;
    }
    let delta = event.occurred_at_ms.abs_diff(recent.occurred_at_ms);
    if delta > window_ms {
        return false;
    }
    match event.event_type {
        SemanticEventType::UiaFocusChanged
        | SemanticEventType::WindowOpened
        | SemanticEventType::WindowClosed
        | SemanticEventType::PopupAppeared
        | SemanticEventType::DialogAppeared => true,
        SemanticEventType::UiaSnapshot
        | SemanticEventType::UiaPropertyChanged
        | SemanticEventType::UiaSelectionChanged => point_hits_recent(event, recent),
        _ => false,
    }
}

fn point_hits_recent(event: &SemanticEventRecord, recent: &RecentInteraction) -> bool {
    let rect = event
        .target
        .as_ref()
        .and_then(|target| target.bounding_rect.clone())
        .or_else(|| {
            event
                .payload
                .get("stateSnapshot")
                .and_then(|snapshot| snapshot.get("element"))
                .and_then(|element| element.get("boundingRect"))
                .and_then(|rect| serde_json::from_value(rect.clone()).ok())
        })
        .or_else(|| {
            event
                .payload
                .get("boundingRect")
                .and_then(|rect| serde_json::from_value(rect.clone()).ok())
        });
    let Some(rect) = rect else {
        return false;
    };
    let right = rect.left.saturating_add(rect.width as i32);
    let bottom = rect.top.saturating_add(rect.height as i32);
    recent.x >= rect.left && recent.x <= right && recent.y >= rect.top && recent.y <= bottom
}

pub fn crash_restart_backoff(attempt: u32) -> Duration {
    let index = attempt.saturating_sub(1) as usize;
    let ms = CRASH_RESTART_BACKOFF_MS
        .get(index)
        .copied()
        .unwrap_or(*CRASH_RESTART_BACKOFF_MS.last().unwrap_or(&1_000));
    Duration::from_millis(ms)
}

#[derive(Debug, Clone)]
struct UiaObserverSession {
    session_id: String,
    session_dir: PathBuf,
    scope: UiaObserverScope,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct UiaObserverScope {
    allowed_process_ids: Vec<u32>,
    target_hwnd: Option<String>,
}

#[cfg(all(windows, not(test)))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UiaObservedEventKind {
    FocusChanged,
    PropertyChanged,
    StructureChanged,
    WindowOpened,
    WindowClosed,
}

#[derive(Default)]
pub struct UiaObserverRuntime {
    session_id: Option<String>,
    scope: Option<UiaObserverScope>,
    sender: Option<mpsc::SyncSender<UiaObserverCommand>>,
    stop: Option<Arc<AtomicBool>>,
    overflow_count: Option<Arc<AtomicU32>>,
    polling_attempt_count: Option<Arc<AtomicU32>>,
    queue_depth: Option<Arc<AtomicU32>>,
    handle: Option<JoinHandle<UiaObserverStopReport>>,
    crash_restart_attempts: u32,
}

impl UiaObserverRuntime {
    pub fn ensure_started(&mut self, record: &TestSessionRecord) -> Result<(), UiaObserverError> {
        let session = observer_session_from_record(record)?;
        let needs_restart = self
            .handle
            .as_ref()
            .is_some_and(|handle| handle.is_finished());
        if self.session_id.as_deref() == Some(session.session_id.as_str())
            && self.scope.as_ref() == Some(&session.scope)
            && !needs_restart
        {
            return Ok(());
        }
        if self.session_id.as_deref() == Some(session.session_id.as_str())
            && !needs_restart
            && let Some(sender) = self.sender.as_ref()
        {
            let worker_scope = session.scope.clone();
            let queue_depth = self
                .queue_depth
                .as_ref()
                .ok_or(UiaObserverError::CommandChannelClosed)?;
            try_send_queued_command(
                sender,
                queue_depth,
                UiaObserverCommand::Reconfigure(session),
            )
            .map_err(|err| self.map_command_send_error(err))?;
            self.scope = Some(worker_scope);
            return Ok(());
        }

        let restarting = self.sender.is_some() || needs_restart;
        if needs_restart {
            self.crash_restart_attempts = self.crash_restart_attempts.saturating_add(1);
            let backoff = crash_restart_backoff(self.crash_restart_attempts);
            std::thread::sleep(backoff);
        } else if !restarting {
            self.crash_restart_attempts = 0;
        }
        let _ = self.stop();

        let (tx, rx) = mpsc::sync_channel::<UiaObserverCommand>(OBSERVER_QUEUE_CAPACITY);
        let stop = Arc::new(AtomicBool::new(false));
        let overflow_count = Arc::new(AtomicU32::new(0));
        let polling_attempt_count = Arc::new(AtomicU32::new(0));
        let queue_depth = Arc::new(AtomicU32::new(0));
        set_uia_observer_queue_depth(0);
        let worker_stop = Arc::clone(&stop);
        let worker_overflow_count = Arc::clone(&overflow_count);
        let worker_polling_attempt_count = Arc::clone(&polling_attempt_count);
        let worker_queue_depth = Arc::clone(&queue_depth);
        let native_sender = tx.clone();
        let worker_session_id = session.session_id.clone();
        let worker_scope = session.scope.clone();
        let handle = std::thread::Builder::new()
            .name("shadow-uia-observer".to_string())
            .spawn(move || {
                run_uia_observer_worker(
                    session,
                    rx,
                    native_sender,
                    worker_stop,
                    worker_overflow_count,
                    worker_polling_attempt_count,
                    worker_queue_depth,
                    restarting,
                )
            })
            .map_err(|_| UiaObserverError::ThreadStartFailed)?;

        self.session_id = Some(worker_session_id);
        self.scope = Some(worker_scope);
        self.sender = Some(tx);
        self.stop = Some(stop);
        self.overflow_count = Some(overflow_count);
        self.polling_attempt_count = Some(polling_attempt_count);
        self.queue_depth = Some(queue_depth);
        self.handle = Some(handle);
        Ok(())
    }

    pub fn set_paused(&mut self, paused: bool) -> Result<(), UiaObserverError> {
        let Some(sender) = self.sender.as_ref() else {
            return Ok(());
        };
        let Some(queue_depth) = self.queue_depth.as_ref() else {
            return Err(UiaObserverError::CommandChannelClosed);
        };
        if paused {
            let _ = try_send_queued_command(
                sender,
                queue_depth,
                UiaObserverCommand::CancelInteractionPolls,
            );
        }
        try_send_queued_command(sender, queue_depth, UiaObserverCommand::Pause(paused))
            .map_err(|err| self.map_command_send_error(err))
    }

    /// Schedule 100/300/700/1500/3000ms compensation polls for the last interaction point.
    pub fn schedule_interaction_poll(
        &mut self,
        source_event_id: impl Into<String>,
        x: i32,
        y: i32,
    ) -> Result<(), UiaObserverError> {
        let Some(sender) = self.sender.as_ref() else {
            return Err(UiaObserverError::CommandChannelClosed);
        };
        let Some(queue_depth) = self.queue_depth.as_ref() else {
            return Err(UiaObserverError::CommandChannelClosed);
        };
        try_send_queued_command(
            sender,
            queue_depth,
            UiaObserverCommand::ScheduleInteractionPoll {
                source_event_id: source_event_id.into(),
                x,
                y,
                base_at: Instant::now(),
            },
        )
        .map_err(|err| self.map_command_send_error(err))
    }

    pub fn cancel_interaction_polls(&mut self) -> Result<(), UiaObserverError> {
        let Some(sender) = self.sender.as_ref() else {
            return Ok(());
        };
        let Some(queue_depth) = self.queue_depth.as_ref() else {
            return Err(UiaObserverError::CommandChannelClosed);
        };
        try_send_queued_command(
            sender,
            queue_depth,
            UiaObserverCommand::CancelInteractionPolls,
        )
        .map_err(|err| self.map_command_send_error(err))
    }

    pub fn enqueue_event(&mut self, event: SemanticEventRecord) -> Result<(), UiaObserverError> {
        let Some(sender) = self.sender.as_ref() else {
            return Err(UiaObserverError::CommandChannelClosed);
        };
        let Some(active_session_id) = self.session_id.as_deref() else {
            return Err(UiaObserverError::CommandChannelClosed);
        };
        if event.session_id != active_session_id {
            return Err(UiaObserverError::WrongSession {
                active: active_session_id.to_string(),
                event: event.session_id,
            });
        }

        let Some(queue_depth) = self.queue_depth.as_ref() else {
            return Err(UiaObserverError::CommandChannelClosed);
        };
        match try_send_queued_command(
            sender,
            queue_depth,
            UiaObserverCommand::Event(Box::new(event)),
        ) {
            Ok(()) => Ok(()),
            Err(mpsc::TrySendError::Full(_)) => {
                self.note_queue_overflow();
                Err(UiaObserverError::QueueFull {
                    capacity: OBSERVER_QUEUE_CAPACITY,
                })
            }
            Err(mpsc::TrySendError::Disconnected(_)) => Err(UiaObserverError::CommandChannelClosed),
        }
    }

    pub fn flush(&mut self) -> Result<(), UiaObserverError> {
        let Some(sender) = self.sender.as_ref() else {
            return Ok(());
        };
        let Some(queue_depth) = self.queue_depth.as_ref() else {
            return Err(UiaObserverError::CommandChannelClosed);
        };
        let (ack_tx, ack_rx) = mpsc::sync_channel(1);
        try_send_queued_command(sender, queue_depth, UiaObserverCommand::Flush(ack_tx))
            .map_err(|err| self.map_command_send_error(err))?;
        match ack_rx.recv_timeout(FLUSH_ACK_TIMEOUT) {
            Ok(result) => result.map_err(UiaObserverError::Store),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(UiaObserverError::FlushTimeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(UiaObserverError::CommandChannelClosed)
            }
        }
    }

    pub fn is_running(&self) -> bool {
        self.handle
            .as_ref()
            .is_some_and(|handle| !handle.is_finished())
    }

    pub fn stop(&mut self) -> Option<UiaObserverStopReport> {
        if let Some(flag) = self.stop.take() {
            flag.store(true, Ordering::SeqCst);
        }
        self.sender.take();
        self.session_id.take();
        self.scope.take();
        self.overflow_count.take();
        self.polling_attempt_count.take();
        self.queue_depth.take();
        self.handle
            .take()
            .and_then(|handle| join_observer_with_timeout(handle, STOP_JOIN_TIMEOUT))
    }

    fn map_command_send_error(
        &self,
        error: mpsc::TrySendError<UiaObserverCommand>,
    ) -> UiaObserverError {
        match error {
            mpsc::TrySendError::Full(_) => {
                self.note_queue_overflow();
                UiaObserverError::QueueFull {
                    capacity: OBSERVER_QUEUE_CAPACITY,
                }
            }
            mpsc::TrySendError::Disconnected(_) => UiaObserverError::CommandChannelClosed,
        }
    }

    fn note_queue_overflow(&self) {
        if let Some(counter) = self.overflow_count.as_ref() {
            counter.fetch_add(1, Ordering::SeqCst);
        }
        inc_uia_observer_queue_overflow();
    }
}

impl Drop for UiaObserverRuntime {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn observer_session_from_record(
    record: &TestSessionRecord,
) -> Result<UiaObserverSession, UiaObserverError> {
    let Some(session_dir) = record.session_dir.as_ref() else {
        return Err(UiaObserverError::MissingSessionDir);
    };
    Ok(UiaObserverSession {
        session_id: record.session_id.clone(),
        session_dir: PathBuf::from(session_dir),
        scope: UiaObserverScope::from_record(record),
    })
}

impl UiaObserverScope {
    fn from_record(record: &TestSessionRecord) -> Self {
        let mut allowed_process_ids = Vec::new();
        if let Some(pid) = record.target_pid
            && pid != 0
        {
            allowed_process_ids.push(pid);
        }

        Self {
            allowed_process_ids,
            target_hwnd: normalize_hwnd_string(record.target_hwnd.as_deref()),
        }
    }

    #[cfg(test)]
    fn allows_pid(&self, pid: Option<u32>) -> bool {
        let Some(pid) = pid.filter(|value| *value != 0) else {
            return false;
        };
        self.allowed_process_ids.contains(&pid)
    }

    fn can_install_native_handlers(&self) -> bool {
        !self.allowed_process_ids.is_empty()
    }

    fn describe(&self) -> String {
        let pids = if self.allowed_process_ids.is_empty() {
            "none".to_string()
        } else {
            self.allowed_process_ids
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(",")
        };
        match self.target_hwnd.as_deref() {
            Some(hwnd) => format!("pid allowlist [{pids}], target hwnd {hwnd}"),
            None => format!("pid allowlist [{pids}]"),
        }
    }
}

#[cfg(all(windows, not(test)))]
impl UiaObservedEventKind {
    fn event_type(self) -> SemanticEventType {
        match self {
            Self::FocusChanged => SemanticEventType::UiaFocusChanged,
            Self::PropertyChanged => SemanticEventType::UiaPropertyChanged,
            Self::StructureChanged => SemanticEventType::UiaStructureChanged,
            Self::WindowOpened => SemanticEventType::WindowOpened,
            Self::WindowClosed => SemanticEventType::WindowClosed,
        }
    }

    fn reason_code(self) -> OperationReasonCode {
        match self {
            Self::FocusChanged => OperationReasonCode::FocusChanged,
            Self::PropertyChanged => OperationReasonCode::Other("uia-property-changed".to_string()),
            Self::StructureChanged => OperationReasonCode::StructureChanged,
            Self::WindowOpened => OperationReasonCode::WindowOpened,
            Self::WindowClosed => OperationReasonCode::WindowClosed,
        }
    }

    fn source_label(self) -> &'static str {
        match self {
            Self::FocusChanged => "uia-focus",
            Self::PropertyChanged => "uia-property",
            Self::StructureChanged => "uia-structure",
            Self::WindowOpened => "uia-window-opened",
            Self::WindowClosed => "uia-window-closed",
        }
    }
}

#[cfg(test)]
fn should_record_observed_event(scope: &UiaObserverScope, process_id: Option<u32>) -> bool {
    scope.allows_pid(process_id)
}

fn normalize_hwnd_string(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    if let Some(hex) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        && let Ok(parsed) = usize::from_str_radix(hex, 16)
    {
        return Some(format!("0x{parsed:x}"));
    }
    Some(value.to_ascii_lowercase())
}

#[cfg(all(windows, not(test)))]
fn normalize_text(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.chars().take(256).collect())
        }
    })
}

fn try_send_queued_command(
    sender: &mpsc::SyncSender<UiaObserverCommand>,
    queue_depth: &Arc<AtomicU32>,
    command: UiaObserverCommand,
) -> Result<(), mpsc::TrySendError<UiaObserverCommand>> {
    increment_queue_depth(queue_depth);
    match sender.try_send(command) {
        Ok(()) => Ok(()),
        Err(err) => {
            decrement_queue_depth(queue_depth);
            Err(err)
        }
    }
}

fn increment_queue_depth(queue_depth: &Arc<AtomicU32>) {
    let depth = queue_depth.fetch_add(1, Ordering::SeqCst).saturating_add(1);
    set_uia_observer_queue_depth(depth);
}

fn decrement_queue_depth(queue_depth: &Arc<AtomicU32>) {
    let mut current = queue_depth.load(Ordering::SeqCst);
    loop {
        if current == 0 {
            set_uia_observer_queue_depth(0);
            return;
        }
        let next = current.saturating_sub(1);
        match queue_depth.compare_exchange(current, next, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => {
                set_uia_observer_queue_depth(next);
                return;
            }
            Err(actual) => current = actual,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_uia_observer_worker(
    session: UiaObserverSession,
    rx: mpsc::Receiver<UiaObserverCommand>,
    native_sender: mpsc::SyncSender<UiaObserverCommand>,
    stop: Arc<AtomicBool>,
    overflow_count: Arc<AtomicU32>,
    polling_attempt_count: Arc<AtomicU32>,
    queue_depth: Arc<AtomicU32>,
    restarting: bool,
) -> UiaObserverStopReport {
    let mut worker =
        UiaObserverWorker::new(session, overflow_count, polling_attempt_count, queue_depth);
    let mut native = match NativeUiaObserver::start(
        worker.session.clone(),
        native_sender.clone(),
        Arc::clone(&worker.overflow_count),
        Arc::clone(&worker.queue_depth),
        Arc::clone(&worker.polling_attempt_count),
        worker.started_at,
    ) {
        Ok(native) => {
            set_uia_observer_circuit_open(false);
            let state = if restarting {
                worker.note_restart();
                ObserverHealthState::Restarted
            } else {
                ObserverHealthState::Healthy
            };
            let reason_codes = if restarting {
                vec![OperationReasonCode::ObserverRestarted]
            } else {
                Vec::new()
            };
            worker.write_health(
                state,
                format!(
                    "UIA observer worker started with {}",
                    worker.session.scope.describe()
                ),
                reason_codes,
            );
            Some(native)
        }
        Err(err) => {
            set_uia_observer_circuit_open(true);
            worker.note_timeout();
            worker.write_health(
                ObserverHealthState::Timeout,
                format!("UIA observer native init failed: {err}"),
                vec![OperationReasonCode::UiaTimeout],
            );
            None
        }
    };

    while !stop.load(Ordering::SeqCst) {
        match rx.recv_timeout(WORKER_POLL_INTERVAL) {
            Ok(command) => {
                worker.note_command_dequeued();
                handle_worker_command(&mut worker, &mut native, &native_sender, command);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                worker.tick_interaction_polls(Instant::now());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    while let Ok(command) = rx.try_recv() {
        worker.note_command_dequeued();
        handle_worker_command(&mut worker, &mut native, &native_sender, command);
    }

    let _ = native.take();
    worker.write_health(
        ObserverHealthState::Healthy,
        "UIA observer worker stopped and drained".to_string(),
        Vec::new(),
    );
    worker.finish()
}

fn handle_worker_command(
    worker: &mut UiaObserverWorker,
    native: &mut Option<NativeUiaObserver>,
    native_sender: &mpsc::SyncSender<UiaObserverCommand>,
    command: UiaObserverCommand,
) {
    match command {
        UiaObserverCommand::Reconfigure(session) => {
            reconfigure_native_observer(worker, native, native_sender, session);
        }
        other => worker.handle_command(other),
    }
}

fn reconfigure_native_observer(
    worker: &mut UiaObserverWorker,
    native: &mut Option<NativeUiaObserver>,
    native_sender: &mpsc::SyncSender<UiaObserverCommand>,
    session: UiaObserverSession,
) {
    let result = match native.as_mut() {
        Some(observer) => observer.reconfigure(session.clone()),
        None => NativeUiaObserver::start(
            session.clone(),
            native_sender.clone(),
            Arc::clone(&worker.overflow_count),
            Arc::clone(&worker.queue_depth),
            Arc::clone(&worker.polling_attempt_count),
            worker.started_at,
        )
        .map(|observer| {
            *native = Some(observer);
        }),
    };

    match result {
        Ok(()) => {
            set_uia_observer_circuit_open(false);
            worker.session = session;
            worker.note_restart();
            worker.write_health(
                ObserverHealthState::Restarted,
                format!(
                    "UIA observer reconfigured with {}",
                    worker.session.scope.describe()
                ),
                vec![OperationReasonCode::ObserverRestarted],
            );
        }
        Err(err) => {
            set_uia_observer_circuit_open(true);
            worker.note_timeout();
            worker.write_health(
                ObserverHealthState::Timeout,
                format!("UIA observer native reconfigure failed: {err}"),
                vec![OperationReasonCode::UiaTimeout],
            );
        }
    }
}

struct UiaObserverWorker {
    session: UiaObserverSession,
    writer: SemanticEventBatchWriter,
    state_cache: UiaStateCache,
    deduper: UiaEventDeduper,
    rate_limiter: UiaEventRateLimiter,
    started_at: Instant,
    paused: bool,
    event_counter: u64,
    drained_event_count: usize,
    dropped_event_count: u32,
    duplicate_drop_count: u32,
    rate_limit_drop_count: u32,
    timeout_count: u32,
    restart_count: u32,
    write_error_count: u32,
    overflow_count: Arc<AtomicU32>,
    polling_attempt_count: Arc<AtomicU32>,
    queue_depth: Arc<AtomicU32>,
    interaction_polls: Vec<InteractionCompensationPoll>,
    recent_interaction: Option<RecentInteraction>,
}

impl UiaObserverWorker {
    fn new(
        session: UiaObserverSession,
        overflow_count: Arc<AtomicU32>,
        polling_attempt_count: Arc<AtomicU32>,
        queue_depth: Arc<AtomicU32>,
    ) -> Self {
        let store = SemanticEventStore::for_session_dir(&session.session_dir);
        Self {
            session,
            writer: SemanticEventBatchWriter::new(store, WRITER_BATCH_CAPACITY),
            state_cache: UiaStateCache::default(),
            deduper: UiaEventDeduper::default(),
            rate_limiter: UiaEventRateLimiter::default(),
            started_at: Instant::now(),
            paused: false,
            event_counter: 0,
            drained_event_count: 0,
            dropped_event_count: 0,
            duplicate_drop_count: 0,
            rate_limit_drop_count: 0,
            timeout_count: 0,
            restart_count: 0,
            write_error_count: 0,
            overflow_count,
            polling_attempt_count,
            queue_depth,
            interaction_polls: Vec::new(),
            recent_interaction: None,
        }
    }

    fn handle_command(&mut self, command: UiaObserverCommand) {
        match command {
            UiaObserverCommand::Pause(paused) => {
                if self.paused == paused {
                    return;
                }
                self.paused = paused;
                if paused {
                    self.interaction_polls.clear();
                }
                let message = if paused {
                    "UIA observer paused".to_string()
                } else {
                    "UIA observer resumed".to_string()
                };
                self.write_health(ObserverHealthState::Healthy, message, Vec::new());
            }
            UiaObserverCommand::Event(event) => {
                let mut event = *event;
                if self.paused {
                    self.drop_event();
                    return;
                }
                if let Some(recent) = self.recent_interaction.as_ref()
                    && should_bind_source_event(&event, recent, RECENT_INTERACTION_BIND_WINDOW_MS)
                {
                    event.source_event_id = Some(recent.source_event_id.clone());
                }
                if self.deduper.is_duplicate(&event) {
                    self.drop_duplicate_event();
                    return;
                }
                if !self
                    .rate_limiter
                    .allow(&event, self.queue_depth.load(Ordering::SeqCst))
                {
                    self.drop_rate_limited_event();
                    return;
                }
                // Explicit state change or focus can end compensation polling early.
                if is_explicit_result_signal(&event) {
                    self.interaction_polls.clear();
                }
                self.enrich_event_with_state_cache(&mut event);
                self.write_event(event);
            }
            UiaObserverCommand::Flush(reply) => {
                let _ = reply.send(self.flush());
            }
            UiaObserverCommand::ScheduleInteractionPoll {
                source_event_id,
                x,
                y,
                base_at,
            } => {
                if self.paused {
                    return;
                }
                // One active plan per source; latest schedule wins.
                self.recent_interaction = Some(RecentInteraction {
                    source_event_id: source_event_id.clone(),
                    x,
                    y,
                    occurred_at_ms: now_timestamp_ms(),
                });
                self.interaction_polls
                    .retain(|poll| poll.source_event_id != source_event_id);
                self.interaction_polls
                    .push(InteractionCompensationPoll::new(
                        source_event_id,
                        x,
                        y,
                        base_at,
                    ));
            }
            UiaObserverCommand::CancelInteractionPolls => {
                self.interaction_polls.clear();
            }
            UiaObserverCommand::Reconfigure(_) => {}
        }
    }

    fn tick_interaction_polls(&mut self, now: Instant) {
        if self.paused || self.interaction_polls.is_empty() {
            return;
        }

        let mut due_events = Vec::new();
        self.interaction_polls.retain_mut(|poll| {
            while poll.take_due(now) {
                note_polling_attempt_safe(&self.polling_attempt_count);
                if let Some(event) = build_interaction_poll_event(
                    &self.session,
                    &mut self.event_counter,
                    self.started_at,
                    poll,
                ) {
                    due_events.push(event);
                }
                // Stop further polls for this source once an explicit state signal
                // has been observed elsewhere (handled on Event). Keep remaining
                // slots only while unfinished.
                if poll.is_finished() {
                    return false;
                }
            }
            !poll.is_finished()
        });

        for mut event in due_events {
            self.enrich_event_with_state_cache(&mut event);
            self.write_event(event);
        }
    }

    fn enrich_event_with_state_cache(&mut self, event: &mut SemanticEventRecord) {
        if let Some(snapshot) = event_state_snapshot(event)
            && let Some(update) = self.state_cache.apply_snapshot(snapshot)
        {
            let before = update
                .before
                .as_ref()
                .and_then(|snapshot| to_value(snapshot).ok())
                .unwrap_or(Value::Null);
            let after = to_value(&update.after).unwrap_or(Value::Null);
            let payload = ensure_payload_object(event);
            payload.insert("stateCacheKey".to_string(), Value::String(update.cache_key));
            payload.insert("stateBefore".to_string(), before);
            payload.insert("stateAfter".to_string(), after);
        }

        let removed_count = match event.event_type {
            SemanticEventType::WindowClosed => event
                .target
                .as_ref()
                .and_then(|target| target.window_hwnd.as_deref())
                .map(|hwnd| self.state_cache.remove_window(hwnd))
                .unwrap_or(0),
            SemanticEventType::UiaStructureChanged
                if event
                    .payload
                    .get("changeType")
                    .and_then(|value| value.as_str())
                    == Some("childRemoved") =>
            {
                event
                    .target
                    .as_ref()
                    .and_then(|target| self.state_cache.remove_element(target))
                    .map(|_| 1)
                    .unwrap_or(0)
            }
            _ => 0,
        };
        if removed_count > 0 {
            ensure_payload_object(event).insert(
                "stateCacheRemovedCount".to_string(),
                Value::from(removed_count as u64),
            );
        }

        let pruned_count = self.state_cache.prune_expired(event.occurred_at_ms);
        if pruned_count > 0 {
            ensure_payload_object(event).insert(
                "stateCachePrunedCount".to_string(),
                Value::from(pruned_count as u64),
            );
        }
    }

    fn write_event(&mut self, event: SemanticEventRecord) {
        let flush_after_enqueue = should_flush_after_event(&event);
        if self.writer.pending_len() >= WRITER_BATCH_CAPACITY {
            let _ = self.flush();
        }
        if self.writer.enqueue(event).is_err() {
            self.drop_event();
            self.write_error_count = self.write_error_count.saturating_add(1);
            return;
        }
        if flush_after_enqueue || self.writer.pending_len() >= WRITER_BATCH_CAPACITY {
            let _ = self.flush();
        }
        self.drained_event_count = self.drained_event_count.saturating_add(1);
    }

    fn write_health(
        &mut self,
        state: ObserverHealthState,
        message: String,
        reason_codes: Vec<OperationReasonCode>,
    ) {
        let overflow_count = self.overflow_count.load(Ordering::SeqCst);
        let payload = ObserverHealthPayload {
            state,
            queue_overflow_count: overflow_count,
            message: Some(message),
        };
        let mut payload = to_value(payload).unwrap_or_else(|_| serde_json::json!({}));
        if let Value::Object(payload) = &mut payload {
            payload.insert(
                "queueDepth".to_string(),
                Value::from(self.queue_depth.load(Ordering::SeqCst)),
            );
            payload.insert(
                "droppedEventCount".to_string(),
                Value::from(self.dropped_event_count),
            );
            payload.insert(
                "duplicateDropCount".to_string(),
                Value::from(self.duplicate_drop_count),
            );
            payload.insert(
                "rateLimitDropCount".to_string(),
                Value::from(self.rate_limit_drop_count),
            );
            payload.insert("timeoutCount".to_string(), Value::from(self.timeout_count));
            payload.insert("restartCount".to_string(), Value::from(self.restart_count));
            payload.insert(
                "pollingAttemptCount".to_string(),
                Value::from(self.polling_attempt_count.load(Ordering::SeqCst)),
            );
            payload.insert(
                "circuitOpen".to_string(),
                Value::Bool(read_uia_observer_circuit_open()),
            );
        }
        let event = SemanticEventRecord {
            schema_version: SEMANTIC_EVENT_SCHEMA_VERSION,
            kind: TEST_SESSION_SEMANTIC_EVENT_KIND.to_string(),
            event_id: self.next_event_id(),
            session_id: self.session.session_id.clone(),
            event_type: SemanticEventType::ObserverHealth,
            occurred_at_ms: now_timestamp_ms(),
            monotonic_offset_ms: Some(elapsed_ms(self.started_at)),
            source_event_id: None,
            target: None,
            payload,
            privacy_class: PrivacyClass::NotSensitive,
            reason_codes,
        };
        self.write_event(event);
    }

    fn flush(&mut self) -> Result<(), SemanticEventStoreError> {
        match self.writer.flush() {
            Ok(()) => Ok(()),
            Err(err) => {
                self.write_error_count = self.write_error_count.saturating_add(1);
                Err(err)
            }
        }
    }

    fn finish(mut self) -> UiaObserverStopReport {
        let _ = self.flush();
        self.queue_depth.store(0, Ordering::SeqCst);
        set_uia_observer_queue_depth(0);
        set_uia_observer_circuit_open(false);
        UiaObserverStopReport {
            drained_event_count: self.drained_event_count,
            dropped_event_count: self.dropped_event_count,
            duplicate_drop_count: self.duplicate_drop_count,
            rate_limit_drop_count: self.rate_limit_drop_count,
            queue_overflow_count: self.overflow_count.load(Ordering::SeqCst),
            timeout_count: self.timeout_count,
            restart_count: self.restart_count,
            polling_attempt_count: self.polling_attempt_count.load(Ordering::SeqCst),
            write_error_count: self.write_error_count,
        }
    }

    fn note_command_dequeued(&self) {
        decrement_queue_depth(&self.queue_depth);
    }

    fn note_timeout(&mut self) {
        self.timeout_count = self.timeout_count.saturating_add(1);
        inc_uia_observer_timeout();
    }

    fn note_restart(&mut self) {
        self.restart_count = self.restart_count.saturating_add(1);
        inc_uia_observer_restart();
    }

    fn drop_event(&mut self) {
        self.dropped_event_count = self.dropped_event_count.saturating_add(1);
        inc_uia_observer_dropped();
    }

    fn drop_duplicate_event(&mut self) {
        self.drop_event();
        self.duplicate_drop_count = self.duplicate_drop_count.saturating_add(1);
        inc_uia_observer_duplicate_drop();
    }

    fn drop_rate_limited_event(&mut self) {
        self.drop_event();
        self.rate_limit_drop_count = self.rate_limit_drop_count.saturating_add(1);
        inc_uia_observer_rate_limit_drop();
    }

    fn next_event_id(&mut self) -> String {
        self.event_counter = self.event_counter.saturating_add(1);
        format!(
            "sem-{}-{}-{}",
            self.session.session_id,
            now_timestamp_ms(),
            self.event_counter
        )
    }
}

fn note_polling_attempt_safe(polling_attempt_count: &Arc<AtomicU32>) {
    polling_attempt_count.fetch_add(1, Ordering::SeqCst);
    #[cfg(all(windows, not(test)))]
    {
        inc_uia_observer_polling_attempt();
    }
}

fn is_explicit_result_signal(event: &SemanticEventRecord) -> bool {
    matches!(
        event.event_type,
        SemanticEventType::UiaPropertyChanged
            | SemanticEventType::WindowOpened
            | SemanticEventType::WindowClosed
            | SemanticEventType::PopupAppeared
            | SemanticEventType::DialogAppeared
            | SemanticEventType::UiaStructureChanged
    )
}

fn build_interaction_poll_event(
    session: &UiaObserverSession,
    event_counter: &mut u64,
    started_at: Instant,
    poll: &InteractionCompensationPoll,
) -> Option<SemanticEventRecord> {
    *event_counter = event_counter.saturating_add(1);
    let occurred_at_ms = now_timestamp_ms();
    let attempt = poll.next_index; // already advanced by take_due
    let mut payload = Map::new();
    payload.insert(
        "source".to_string(),
        Value::String("interaction-compensation-poll".to_string()),
    );
    payload.insert("pollAttempt".to_string(), Value::from(attempt as u64));
    payload.insert("x".to_string(), Value::from(poll.x));
    payload.insert("y".to_string(), Value::from(poll.y));
    payload.insert(
        "sourceEventId".to_string(),
        Value::String(poll.source_event_id.clone()),
    );

    // Best-effort point snapshot; never blocks recording path for long (enricher timeout).
    let (target, privacy_class) =
        if let Some(snapshot) = super::uia_enricher::capture_at_point(poll.x, poll.y) {
            payload.insert(
                "hitQuality".to_string(),
                Value::String(snapshot.hit_quality.as_str().to_string()),
            );
            if let Some(name) = snapshot.control_name.clone() {
                payload.insert("name".to_string(), Value::String(name));
            }
            if let Some(automation_id) = snapshot.automation_id.clone() {
                payload.insert("automationId".to_string(), Value::String(automation_id));
            }
            if let Some(control_type) = snapshot.control_type.clone() {
                payload.insert("controlType".to_string(), Value::String(control_type));
            }
            if let Some(class_name) = snapshot.class_name.clone() {
                payload.insert("className".to_string(), Value::String(class_name));
            }
            payload.insert("isPassword".to_string(), Value::Bool(snapshot.is_password));
            let identity = snapshot.to_identity();
            let state = snapshot.to_state_snapshot(
                format!("state-poll-{}-{}", poll.source_event_id, attempt),
                occurred_at_ms,
            );
            let privacy_class = state.privacy_class.clone();
            if let Ok(value) = to_value(&state) {
                payload.insert("stateSnapshot".to_string(), value);
            }
            (Some(identity), privacy_class)
        } else {
            (None, PrivacyClass::Unknown)
        };

    Some(SemanticEventRecord {
        schema_version: SEMANTIC_EVENT_SCHEMA_VERSION,
        kind: TEST_SESSION_SEMANTIC_EVENT_KIND.to_string(),
        event_id: format!(
            "sem-{}-{}-poll-{}",
            session.session_id, occurred_at_ms, *event_counter
        ),
        session_id: session.session_id.clone(),
        event_type: SemanticEventType::UiaSnapshot,
        occurred_at_ms,
        monotonic_offset_ms: Some(elapsed_ms(started_at)),
        source_event_id: Some(poll.source_event_id.clone()),
        target,
        payload: Value::Object(payload),
        privacy_class,
        reason_codes: vec![OperationReasonCode::CoordinateFallback],
    })
}

#[derive(Debug)]
struct UiaEventDeduper {
    window_ms: u64,
    last_seen_by_key: HashMap<String, u64>,
}

impl Default for UiaEventDeduper {
    fn default() -> Self {
        Self {
            window_ms: DEFAULT_UIA_OBSERVER_DEDUP_MS,
            last_seen_by_key: HashMap::new(),
        }
    }
}

impl UiaEventDeduper {
    fn is_duplicate(&mut self, event: &SemanticEventRecord) -> bool {
        let observed_at_ms = event.monotonic_offset_ms.unwrap_or(event.occurred_at_ms);
        let retention_ms = self.window_ms.saturating_mul(4).max(self.window_ms);
        self.last_seen_by_key.retain(|_, last_seen_ms| {
            *last_seen_ms > observed_at_ms
                || observed_at_ms.saturating_sub(*last_seen_ms) <= retention_ms
        });

        let key = event_dedup_key(event);
        if self
            .last_seen_by_key
            .get(&key)
            .is_some_and(|last_seen_ms| observed_at_ms.abs_diff(*last_seen_ms) <= self.window_ms)
        {
            return true;
        }

        self.last_seen_by_key.insert(key, observed_at_ms);
        false
    }
}

#[derive(Debug, Default)]
struct UiaEventRateLimiter {
    second_bucket: Option<u64>,
    event_count: u32,
    low_priority_event_count: u32,
}

impl UiaEventRateLimiter {
    fn allow(&mut self, event: &SemanticEventRecord, queue_depth: u32) -> bool {
        let observed_at_ms = event.monotonic_offset_ms.unwrap_or(event.occurred_at_ms);
        let second_bucket = observed_at_ms / 1_000;
        if self.second_bucket != Some(second_bucket) {
            self.second_bucket = Some(second_bucket);
            self.event_count = 0;
            self.low_priority_event_count = 0;
        }

        if is_high_value_event(event) {
            return true;
        }

        let low_priority = is_low_priority_event(event);
        if low_priority && queue_depth >= DEFAULT_UIA_OBSERVER_QUEUE_HIGH_WATERMARK {
            return false;
        }
        if self.event_count >= DEFAULT_UIA_OBSERVER_EVENT_BUDGET_PER_SECOND {
            return false;
        }
        if low_priority
            && self.low_priority_event_count
                >= DEFAULT_UIA_OBSERVER_LOW_PRIORITY_EVENT_BUDGET_PER_SECOND
        {
            return false;
        }

        self.event_count = self.event_count.saturating_add(1);
        if low_priority {
            self.low_priority_event_count = self.low_priority_event_count.saturating_add(1);
        }
        true
    }
}

fn event_dedup_key(event: &SemanticEventRecord) -> String {
    let target_key = event_target_key(event).unwrap_or_else(|| "target:unknown".to_string());
    let reason_codes = event
        .reason_codes
        .iter()
        .map(|code| code.as_str())
        .collect::<Vec<_>>()
        .join(",");
    let payload_parts = [
        ("source", payload_value_key(&event.payload, "source")),
        ("property", payload_value_key(&event.payload, "property")),
        (
            "propertyId",
            payload_value_key(&event.payload, "propertyId"),
        ),
        (
            "changeType",
            payload_value_key(&event.payload, "changeType"),
        ),
        (
            "changeTypeId",
            payload_value_key(&event.payload, "changeTypeId"),
        ),
        ("after", payload_value_key(&event.payload, "after")),
        (
            "valueLength",
            payload_value_key(&event.payload, "valueLength"),
        ),
        (
            "toggleState",
            payload_value_key(&event.payload, "toggleState"),
        ),
        (
            "selectionState",
            payload_value_key(&event.payload, "selectionState"),
        ),
        (
            "expandCollapseState",
            payload_value_key(&event.payload, "expandCollapseState"),
        ),
        (
            "rangeValue",
            payload_value_key(&event.payload, "rangeValue"),
        ),
        ("isEnabled", payload_value_key(&event.payload, "isEnabled")),
        (
            "hasKeyboardFocus",
            payload_value_key(&event.payload, "hasKeyboardFocus"),
        ),
        (
            "isOffscreen",
            payload_value_key(&event.payload, "isOffscreen"),
        ),
    ]
    .into_iter()
    .filter_map(|(key, value)| value.map(|value| format!("{key}:{value}")))
    .collect::<Vec<_>>()
    .join("|");
    let snapshot_state = event_state_snapshot(event)
        .map(|snapshot| snapshot_state_dedup_key(&snapshot))
        .unwrap_or_default();

    format!(
        "{}|{}|{}|{}|{}",
        event.event_type.as_str(),
        target_key,
        reason_codes,
        payload_parts,
        snapshot_state
    )
}

fn event_target_key(event: &SemanticEventRecord) -> Option<String> {
    event.target.as_ref().and_then(state_cache_key).or_else(|| {
        event_state_snapshot(event)
            .and_then(|snapshot| snapshot.element)
            .as_ref()
            .and_then(state_cache_key)
    })
}

fn payload_value_key(payload: &Value, key: &str) -> Option<String> {
    payload.get(key).map(canonical_value_key)
}

fn canonical_value_key(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.trim().to_ascii_lowercase(),
        Value::Array(_) | Value::Object(_) => {
            serde_json::to_string(value).unwrap_or_else(|_| "<json>".to_string())
        }
    }
}

fn snapshot_state_dedup_key(snapshot: &UiStateSnapshot) -> String {
    format!(
        "enabled:{:?}|focus:{:?}|offscreen:{:?}|valueLength:{:?}|toggle:{}|selection:{}|expand:{}|range:{:?}",
        snapshot.is_enabled,
        snapshot.has_keyboard_focus,
        snapshot.is_offscreen,
        snapshot.value_length,
        snapshot
            .toggle_state
            .as_ref()
            .map(|value| value.as_str())
            .unwrap_or(""),
        snapshot
            .selection_state
            .as_ref()
            .map(|value| value.as_str())
            .unwrap_or(""),
        snapshot
            .expand_collapse_state
            .as_ref()
            .map(|value| value.as_str())
            .unwrap_or(""),
        snapshot.range_value,
    )
}

fn is_high_value_event(event: &SemanticEventRecord) -> bool {
    matches!(
        event.event_type,
        SemanticEventType::UiaFocusChanged
            | SemanticEventType::WindowOpened
            | SemanticEventType::WindowClosed
            | SemanticEventType::PopupAppeared
            | SemanticEventType::DialogAppeared
    ) || event.reason_codes.iter().any(|reason| {
        matches!(
            reason,
            OperationReasonCode::ValueLengthChanged
                | OperationReasonCode::ToggleStateChanged
                | OperationReasonCode::SelectionChanged
                | OperationReasonCode::ExpandStateChanged
                | OperationReasonCode::RangeValueChanged
                | OperationReasonCode::EnabledStateChanged
                | OperationReasonCode::FocusChanged
                | OperationReasonCode::WindowOpened
                | OperationReasonCode::WindowClosed
                | OperationReasonCode::PopupAppeared
                | OperationReasonCode::DialogAppeared
        )
    }) || (event.event_type == SemanticEventType::UiaPropertyChanged
        && event
            .payload
            .get("property")
            .and_then(Value::as_str)
            .is_some_and(is_value_bearing_property))
}

fn should_flush_after_event(event: &SemanticEventRecord) -> bool {
    event
        .source_event_id
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
        || matches!(
            event.event_type,
            SemanticEventType::UiaSnapshot | SemanticEventType::ObserverHealth
        )
        || is_high_value_event(event)
}

fn is_value_bearing_property(property: &str) -> bool {
    matches!(
        property,
        "value"
            | "toggleState"
            | "selectionState"
            | "expandCollapseState"
            | "rangeValue"
            | "isEnabled"
    )
}

fn is_low_priority_event(event: &SemanticEventRecord) -> bool {
    matches!(event.event_type, SemanticEventType::UiaStructureChanged)
}

fn ensure_payload_object(event: &mut SemanticEventRecord) -> &mut Map<String, Value> {
    if !event.payload.is_object() {
        event.payload = Value::Object(Map::new());
    }

    match &mut event.payload {
        Value::Object(payload) => payload,
        _ => unreachable!("semantic event payload was normalized to an object"),
    }
}

fn event_state_snapshot(event: &SemanticEventRecord) -> Option<UiStateSnapshot> {
    if let Some(snapshot_value) = event
        .payload
        .get("stateSnapshot")
        .filter(|value| !value.is_null())
        && let Ok(mut snapshot) = from_value::<UiStateSnapshot>(snapshot_value.clone())
    {
        fill_snapshot_defaults_from_event(&mut snapshot, event);
        return Some(snapshot);
    }

    let element = event.target.clone()?;
    let privacy_class = payload_field(&event.payload, "privacyClass")
        .unwrap_or_else(|| event.privacy_class.clone());

    Some(UiStateSnapshot {
        snapshot_id: format!("state-{}", event.event_id),
        captured_at_ms: event.occurred_at_ms,
        element: Some(element),
        is_enabled: event.payload.get("isEnabled").and_then(Value::as_bool),
        has_keyboard_focus: event
            .payload
            .get("hasKeyboardFocus")
            .and_then(Value::as_bool),
        is_offscreen: event.payload.get("isOffscreen").and_then(Value::as_bool),
        value_length: event
            .payload
            .get("valueLength")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok()),
        value_text: event
            .payload
            .get("valueText")
            .and_then(Value::as_str)
            .map(str::to_string),
        value_fingerprint: None,
        toggle_state: payload_field(&event.payload, "toggleState"),
        selection_state: payload_field(&event.payload, "selectionState"),
        selected_names: event
            .payload
            .get("selectedNames")
            .and_then(|value| match value {
                Value::Array(items) => {
                    let names = items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect::<Vec<_>>();
                    if names.is_empty() { None } else { Some(names) }
                }
                Value::String(text) if !text.trim().is_empty() => Some(vec![text.clone()]),
                _ => None,
            }),
        expand_collapse_state: payload_field(&event.payload, "expandCollapseState"),
        range_value: event.payload.get("rangeValue").and_then(Value::as_f64),
        privacy_class,
        source: Some(snapshot_source_for_event(&event.event_type)),
    })
}

fn fill_snapshot_defaults_from_event(snapshot: &mut UiStateSnapshot, event: &SemanticEventRecord) {
    if snapshot.snapshot_id.trim().is_empty() {
        snapshot.snapshot_id = format!("state-{}", event.event_id);
    }
    if snapshot.captured_at_ms == 0 {
        snapshot.captured_at_ms = event.occurred_at_ms;
    }
    if snapshot.element.is_none() {
        snapshot.element = event.target.clone();
    }
    if snapshot.privacy_class == PrivacyClass::Unknown {
        snapshot.privacy_class = event.privacy_class.clone();
    }
    if snapshot.source.is_none() {
        snapshot.source = Some(snapshot_source_for_event(&event.event_type));
    }
}

fn snapshot_source_for_event(event_type: &SemanticEventType) -> UiStateSnapshotSource {
    match event_type {
        SemanticEventType::UiaSnapshot => UiStateSnapshotSource::UiaSnapshot,
        SemanticEventType::UiaFocusChanged => UiStateSnapshotSource::UiaFocusEvent,
        SemanticEventType::UiaPropertyChanged => UiStateSnapshotSource::UiaPropertyEvent,
        _ => UiStateSnapshotSource::DerivedFromEvent,
    }
}

fn payload_field<T>(payload: &Value, key: &str) -> Option<T>
where
    T: DeserializeOwned,
{
    payload
        .get(key)
        .cloned()
        .and_then(|value| from_value(value).ok())
}

#[cfg(all(windows, not(test)))]
#[allow(clippy::too_many_arguments)]
fn build_observed_semantic_event(
    session: &UiaObserverSession,
    event_kind: UiaObservedEventKind,
    event_counter: u64,
    started_at: Instant,
    target: Option<super::semantic_event::UiElementIdentity>,
    payload: serde_json::Value,
    privacy_class: PrivacyClass,
    reason_codes: Vec<OperationReasonCode>,
) -> SemanticEventRecord {
    let occurred_at_ms = now_timestamp_ms();
    SemanticEventRecord {
        schema_version: SEMANTIC_EVENT_SCHEMA_VERSION,
        kind: TEST_SESSION_SEMANTIC_EVENT_KIND.to_string(),
        event_id: format!(
            "sem-{}-{}-{}",
            session.session_id, occurred_at_ms, event_counter
        ),
        session_id: session.session_id.clone(),
        event_type: event_kind.event_type(),
        occurred_at_ms,
        monotonic_offset_ms: Some(elapsed_ms(started_at)),
        source_event_id: None,
        target,
        payload,
        privacy_class,
        reason_codes,
    }
}

fn join_observer_with_timeout(
    handle: JoinHandle<UiaObserverStopReport>,
    timeout: Duration,
) -> Option<UiaObserverStopReport> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if handle.is_finished() {
            return handle.join().ok();
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    eprintln!(
        "[shadowrecord] timed out waiting for UIA observer worker to stop after {} ms; detaching thread",
        timeout.as_millis()
    );
    None
}

fn elapsed_ms(started_at: Instant) -> u64 {
    let millis = started_at.elapsed().as_millis();
    millis.min(u128::from(u64::MAX)) as u64
}

fn now_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

#[cfg(all(windows, not(test)))]
#[allow(dead_code)]
struct NativeUiaObserver {
    automation: windows::Win32::UI::Accessibility::IUIAutomation,
    core: Arc<UiaNativeHandlerCore>,
    // Keeping roots and handlers alive is required for COM event subscriptions.
    roots: Vec<windows::Win32::UI::Accessibility::IUIAutomationElement>,
    automation_handler: windows::Win32::UI::Accessibility::IUIAutomationEventHandler,
    focus_handler: windows::Win32::UI::Accessibility::IUIAutomationFocusChangedEventHandler,
    property_handler: windows::Win32::UI::Accessibility::IUIAutomationPropertyChangedEventHandler,
    structure_handler: windows::Win32::UI::Accessibility::IUIAutomationStructureChangedEventHandler,
    com_owned: bool,
}

#[cfg(all(windows, not(test)))]
#[derive(Clone)]
struct NativeObservationScope {
    allowed_process_ids: Vec<u32>,
    root_hwnd_keys: Vec<usize>,
}

#[cfg(all(windows, not(test)))]
struct NativeObservationState {
    session: UiaObserverSession,
    observation_scope: NativeObservationScope,
}

#[cfg(all(windows, not(test)))]
impl NativeObservationScope {
    fn new(scope: UiaObserverScope, root_hwnds: &[windows::Win32::Foundation::HWND]) -> Self {
        Self {
            allowed_process_ids: scope.allowed_process_ids,
            root_hwnd_keys: hwnd_keys(root_hwnds),
        }
    }

    fn allows(
        &self,
        process_id: Option<u32>,
        native_hwnd: Option<windows::Win32::Foundation::HWND>,
    ) -> bool {
        if let Some(pid) = process_id.filter(|value| *value != 0)
            && self.allowed_process_ids.contains(&pid)
        {
            return true;
        }

        native_hwnd
            .filter(|hwnd| !hwnd.is_invalid())
            .is_some_and(|hwnd| hwnd_matches_observed_roots(hwnd, &self.root_hwnd_keys))
    }
}

#[cfg(all(windows, not(test)))]
impl NativeUiaObserver {
    #[allow(clippy::arc_with_non_send_sync)]
    fn start(
        session: UiaObserverSession,
        sender: mpsc::SyncSender<UiaObserverCommand>,
        overflow_count: Arc<AtomicU32>,
        queue_depth: Arc<AtomicU32>,
        polling_attempt_count: Arc<AtomicU32>,
        started_at: Instant,
    ) -> Result<Self, UiaObserverError> {
        use windows::Win32::System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
        };
        use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};

        unsafe {
            let com_owned = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                    .map_err(|err| UiaObserverError::NativeInit(format!("{err:?}")))?;
            if !session.scope.can_install_native_handlers() {
                return Err(UiaObserverError::NativeInit(
                    "target PID is required; refusing desktop-wide UIA registration".to_string(),
                ));
            }

            let root_hwnds =
                target_root_windows_with_polling(&session.scope, &polling_attempt_count);
            if root_hwnds.is_empty() {
                return Err(UiaObserverError::NativeInit(format!(
                    "no top-level windows found for {}",
                    session.scope.describe()
                )));
            }
            let observation_scope = NativeObservationScope::new(session.scope.clone(), &root_hwnds);
            let tree_walker = automation.RawViewWalker().ok();

            let core = Arc::new(UiaNativeHandlerCore {
                state: Mutex::new(NativeObservationState {
                    session: session.clone(),
                    observation_scope: observation_scope.clone(),
                }),
                tree_walker,
                sender,
                overflow_count,
                queue_depth,
                polling_attempt_count,
                event_counter: AtomicU64::new(0),
                started_at,
            });
            let automation_handler: windows::Win32::UI::Accessibility::IUIAutomationEventHandler =
                UiaAutomationEventHandler {
                    core: Arc::clone(&core),
                }
                .into();
            let focus_handler: windows::Win32::UI::Accessibility::IUIAutomationFocusChangedEventHandler =
                UiaFocusChangedEventHandler {
                    core: Arc::clone(&core),
                }
                .into();
            let property_handler: windows::Win32::UI::Accessibility::IUIAutomationPropertyChangedEventHandler =
                UiaPropertyChangedEventHandler {
                    core: Arc::clone(&core),
                }
                .into();
            let structure_handler: windows::Win32::UI::Accessibility::IUIAutomationStructureChangedEventHandler =
                UiaStructureChangedEventHandler {
                    core: Arc::clone(&core),
                }
                .into();

            let mut roots = Vec::new();
            for hwnd in root_hwnds {
                let element = automation
                    .ElementFromHandle(hwnd)
                    .map_err(|err| UiaObserverError::NativeInit(format!("{err:?}")))?;
                let process_id = element
                    .CurrentProcessId()
                    .ok()
                    .and_then(|pid| u32::try_from(pid).ok());
                if !observation_scope.allows(process_id, Some(hwnd)) {
                    continue;
                }
                register_root_handlers(
                    &automation,
                    &element,
                    &automation_handler,
                    &property_handler,
                    &structure_handler,
                )?;
                roots.push(element);
            }

            if roots.is_empty() {
                return Err(UiaObserverError::NativeInit(format!(
                    "no UIA roots matched {}",
                    session.scope.describe()
                )));
            }

            automation
                .AddFocusChangedEventHandler(None, &focus_handler)
                .map_err(|err| UiaObserverError::NativeInit(format!("{err:?}")))?;

            Ok(Self {
                automation,
                core,
                roots,
                automation_handler,
                focus_handler,
                property_handler,
                structure_handler,
                com_owned,
            })
        }
    }

    fn reconfigure(&mut self, session: UiaObserverSession) -> Result<(), UiaObserverError> {
        if !session.scope.can_install_native_handlers() {
            return Err(UiaObserverError::NativeInit(
                "target PID is required; refusing desktop-wide UIA registration".to_string(),
            ));
        }

        let root_hwnds =
            target_root_windows_with_polling(&session.scope, &self.core.polling_attempt_count);
        if root_hwnds.is_empty() {
            return Err(UiaObserverError::NativeInit(format!(
                "no top-level windows found for {}",
                session.scope.describe()
            )));
        }
        let observation_scope = NativeObservationScope::new(session.scope.clone(), &root_hwnds);

        let mut new_roots = Vec::new();
        for hwnd in root_hwnds {
            let element = unsafe { self.automation.ElementFromHandle(hwnd) }
                .map_err(|err| UiaObserverError::NativeInit(format!("{err:?}")))?;
            let process_id = unsafe { element.CurrentProcessId() }
                .ok()
                .and_then(|pid| u32::try_from(pid).ok());
            if !observation_scope.allows(process_id, Some(hwnd)) {
                continue;
            }
            register_root_handlers(
                &self.automation,
                &element,
                &self.automation_handler,
                &self.property_handler,
                &self.structure_handler,
            )?;
            new_roots.push(element);
        }

        if new_roots.is_empty() {
            return Err(UiaObserverError::NativeInit(format!(
                "no UIA roots matched {}",
                session.scope.describe()
            )));
        }

        let mut state = match self.core.state.lock() {
            Ok(state) => state,
            Err(_) => {
                for element in &new_roots {
                    unregister_root_handlers(
                        &self.automation,
                        element,
                        &self.automation_handler,
                        &self.property_handler,
                        &self.structure_handler,
                    );
                }
                return Err(UiaObserverError::NativeInit(
                    "native observation state lock poisoned".to_string(),
                ));
            }
        };
        *state = NativeObservationState {
            session,
            observation_scope,
        };
        drop(state);

        let old_roots = std::mem::replace(&mut self.roots, new_roots);
        for element in old_roots {
            unregister_root_handlers(
                &self.automation,
                &element,
                &self.automation_handler,
                &self.property_handler,
                &self.structure_handler,
            );
        }

        Ok(())
    }
}

#[cfg(all(windows, not(test)))]
struct UiaNativeHandlerCore {
    state: Mutex<NativeObservationState>,
    tree_walker: Option<windows::Win32::UI::Accessibility::IUIAutomationTreeWalker>,
    sender: mpsc::SyncSender<UiaObserverCommand>,
    overflow_count: Arc<AtomicU32>,
    queue_depth: Arc<AtomicU32>,
    polling_attempt_count: Arc<AtomicU32>,
    event_counter: AtomicU64,
    started_at: Instant,
}

#[cfg(all(windows, not(test)))]
impl UiaNativeHandlerCore {
    fn handle_event(
        &self,
        sender: Option<&windows::Win32::UI::Accessibility::IUIAutomationElement>,
        event_kind: UiaObservedEventKind,
        payload: serde_json::Value,
        reason_codes: Vec<OperationReasonCode>,
    ) -> windows::core::Result<()> {
        let Some(element) = sender else {
            return Ok(());
        };
        let process_id = native_element_process_id(element);
        let native_hwnd = native_element_hwnd(element);
        let session = {
            let Ok(state) = self.state.lock() else {
                return Ok(());
            };
            if !state.observation_scope.allows(process_id, native_hwnd) {
                return Ok(());
            }
            state.session.clone()
        };

        let snapshot = native_element_snapshot(
            element,
            self.tree_walker.as_ref(),
            process_id,
            native_hwnd,
            event_kind,
        );
        let privacy_class = snapshot.state.privacy_class.clone();
        let mut enriched_payload = match payload {
            Value::Object(payload) => payload,
            _ => Map::new(),
        };
        enriched_payload.insert(
            "stateSnapshot".to_string(),
            to_value(&snapshot.state).unwrap_or(Value::Null),
        );
        // Flatten content fields so correlator/transitions can read them without
        // digging into stateSnapshot (and so sanitizer sees top-level keys).
        if let Some(length) = snapshot.state.value_length {
            enriched_payload.insert("valueLength".to_string(), Value::from(length));
        }
        if let Some(ref text) = snapshot.state.value_text {
            enriched_payload.insert("valueText".to_string(), Value::String(text.clone()));
        }
        if let Some(ref names) = snapshot.state.selected_names {
            enriched_payload.insert(
                "selectedNames".to_string(),
                Value::Array(names.iter().cloned().map(Value::String).collect()),
            );
        }
        if let Some(ref toggle) = snapshot.state.toggle_state {
            enriched_payload.insert(
                "toggleState".to_string(),
                Value::String(toggle.as_str().to_string()),
            );
        }
        if let Some(ref selection) = snapshot.state.selection_state {
            enriched_payload.insert(
                "selectionState".to_string(),
                Value::String(selection.as_str().to_string()),
            );
        }
        if let Some(range) = snapshot.state.range_value
            && let Some(number) = serde_json::Number::from_f64(range)
        {
            enriched_payload.insert("rangeValue".to_string(), Value::Number(number));
        }
        enriched_payload.insert(
            "privacyClass".to_string(),
            Value::String(privacy_class.as_str().to_string()),
        );
        if snapshot.is_password {
            enriched_payload.insert("isPassword".to_string(), Value::Bool(true));
        }
        let event = build_observed_semantic_event(
            &session,
            event_kind,
            self.event_counter.fetch_add(1, Ordering::SeqCst) + 1,
            self.started_at,
            Some(snapshot.identity),
            Value::Object(enriched_payload),
            privacy_class,
            reason_codes,
        );

        match try_send_queued_command(
            &self.sender,
            &self.queue_depth,
            UiaObserverCommand::Event(Box::new(event)),
        ) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full(_)) => {
                self.overflow_count.fetch_add(1, Ordering::SeqCst);
                inc_uia_observer_queue_overflow();
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {}
        }
        Ok(())
    }
}

#[cfg(all(windows, not(test)))]
#[windows::core::implement(windows::Win32::UI::Accessibility::IUIAutomationEventHandler)]
struct UiaAutomationEventHandler {
    core: Arc<UiaNativeHandlerCore>,
}

#[cfg(all(windows, not(test)))]
#[allow(non_snake_case)]
impl windows::Win32::UI::Accessibility::IUIAutomationEventHandler_Impl
    for UiaAutomationEventHandler_Impl
{
    fn HandleAutomationEvent(
        &self,
        sender: Option<&windows::Win32::UI::Accessibility::IUIAutomationElement>,
        eventid: windows::Win32::UI::Accessibility::UIA_EVENT_ID,
    ) -> windows::core::Result<()> {
        let Some(event_kind) = automation_event_kind(eventid) else {
            return Ok(());
        };
        self.core.handle_event(
            sender,
            event_kind,
            serde_json::json!({
                "source": event_kind.source_label(),
                "eventId": eventid.0,
            }),
            vec![event_kind.reason_code()],
        )
    }
}

#[cfg(all(windows, not(test)))]
#[windows::core::implement(
    windows::Win32::UI::Accessibility::IUIAutomationFocusChangedEventHandler
)]
struct UiaFocusChangedEventHandler {
    core: Arc<UiaNativeHandlerCore>,
}

#[cfg(all(windows, not(test)))]
#[allow(non_snake_case)]
impl windows::Win32::UI::Accessibility::IUIAutomationFocusChangedEventHandler_Impl
    for UiaFocusChangedEventHandler_Impl
{
    fn HandleFocusChangedEvent(
        &self,
        sender: Option<&windows::Win32::UI::Accessibility::IUIAutomationElement>,
    ) -> windows::core::Result<()> {
        self.core.handle_event(
            sender,
            UiaObservedEventKind::FocusChanged,
            serde_json::json!({ "source": UiaObservedEventKind::FocusChanged.source_label() }),
            vec![OperationReasonCode::FocusChanged],
        )
    }
}

#[cfg(all(windows, not(test)))]
#[windows::core::implement(
    windows::Win32::UI::Accessibility::IUIAutomationPropertyChangedEventHandler
)]
struct UiaPropertyChangedEventHandler {
    core: Arc<UiaNativeHandlerCore>,
}

#[cfg(all(windows, not(test)))]
#[allow(non_snake_case)]
impl windows::Win32::UI::Accessibility::IUIAutomationPropertyChangedEventHandler_Impl
    for UiaPropertyChangedEventHandler_Impl
{
    fn HandlePropertyChangedEvent(
        &self,
        sender: Option<&windows::Win32::UI::Accessibility::IUIAutomationElement>,
        propertyid: windows::Win32::UI::Accessibility::UIA_PROPERTY_ID,
        _newvalue: &windows::core::VARIANT,
    ) -> windows::core::Result<()> {
        let property = uia_property_label(propertyid);
        self.core.handle_event(
            sender,
            UiaObservedEventKind::PropertyChanged,
            serde_json::json!({
                "source": UiaObservedEventKind::PropertyChanged.source_label(),
                "property": property,
                "propertyId": propertyid.0,
            }),
            vec![uia_property_reason_code(property)],
        )
    }
}

#[cfg(all(windows, not(test)))]
#[windows::core::implement(
    windows::Win32::UI::Accessibility::IUIAutomationStructureChangedEventHandler
)]
struct UiaStructureChangedEventHandler {
    core: Arc<UiaNativeHandlerCore>,
}

#[cfg(all(windows, not(test)))]
#[allow(non_snake_case)]
impl windows::Win32::UI::Accessibility::IUIAutomationStructureChangedEventHandler_Impl
    for UiaStructureChangedEventHandler_Impl
{
    fn HandleStructureChangedEvent(
        &self,
        sender: Option<&windows::Win32::UI::Accessibility::IUIAutomationElement>,
        changetype: windows::Win32::UI::Accessibility::StructureChangeType,
        runtimeid: *const windows::Win32::System::Com::SAFEARRAY,
    ) -> windows::core::Result<()> {
        self.core.handle_event(
            sender,
            UiaObservedEventKind::StructureChanged,
            serde_json::json!({
                "source": UiaObservedEventKind::StructureChanged.source_label(),
                "changeType": structure_change_label(changetype),
                "changeTypeId": changetype.0,
                "runtimeIdAvailable": !runtimeid.is_null(),
            }),
            vec![OperationReasonCode::StructureChanged],
        )
    }
}

#[cfg(all(windows, not(test)))]
struct NativeElementSnapshot {
    identity: UiElementIdentity,
    state: UiStateSnapshot,
    is_password: bool,
}

#[cfg(all(windows, not(test)))]
fn register_root_handlers(
    automation: &windows::Win32::UI::Accessibility::IUIAutomation,
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    automation_handler: &windows::Win32::UI::Accessibility::IUIAutomationEventHandler,
    property_handler: &windows::Win32::UI::Accessibility::IUIAutomationPropertyChangedEventHandler,
    structure_handler: &windows::Win32::UI::Accessibility::IUIAutomationStructureChangedEventHandler,
) -> Result<(), UiaObserverError> {
    use windows::Win32::UI::Accessibility::{
        TreeScope_Subtree, UIA_BoundingRectanglePropertyId,
        UIA_ExpandCollapseExpandCollapseStatePropertyId, UIA_IsEnabledPropertyId,
        UIA_NamePropertyId, UIA_RangeValueValuePropertyId, UIA_SelectionItemIsSelectedPropertyId,
        UIA_ToggleToggleStatePropertyId, UIA_ValueValuePropertyId, UIA_Window_WindowClosedEventId,
        UIA_Window_WindowOpenedEventId,
    };

    let property_whitelist = [
        UIA_ValueValuePropertyId,
        UIA_ToggleToggleStatePropertyId,
        UIA_SelectionItemIsSelectedPropertyId,
        UIA_ExpandCollapseExpandCollapseStatePropertyId,
        UIA_RangeValueValuePropertyId,
        UIA_IsEnabledPropertyId,
        UIA_NamePropertyId,
        UIA_BoundingRectanglePropertyId,
    ];

    unsafe {
        automation
            .AddAutomationEventHandler(
                UIA_Window_WindowOpenedEventId,
                element,
                TreeScope_Subtree,
                None,
                automation_handler,
            )
            .map_err(|err| UiaObserverError::NativeInit(format!("{err:?}")))?;
        automation
            .AddAutomationEventHandler(
                UIA_Window_WindowClosedEventId,
                element,
                TreeScope_Subtree,
                None,
                automation_handler,
            )
            .map_err(|err| UiaObserverError::NativeInit(format!("{err:?}")))?;
        automation
            .AddStructureChangedEventHandler(element, TreeScope_Subtree, None, structure_handler)
            .map_err(|err| UiaObserverError::NativeInit(format!("{err:?}")))?;
        automation
            .AddPropertyChangedEventHandlerNativeArray(
                element,
                TreeScope_Subtree,
                None,
                property_handler,
                &property_whitelist,
            )
            .map_err(|err| UiaObserverError::NativeInit(format!("{err:?}")))?;
    }

    Ok(())
}

#[cfg(all(windows, not(test)))]
fn unregister_root_handlers(
    automation: &windows::Win32::UI::Accessibility::IUIAutomation,
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    automation_handler: &windows::Win32::UI::Accessibility::IUIAutomationEventHandler,
    property_handler: &windows::Win32::UI::Accessibility::IUIAutomationPropertyChangedEventHandler,
    structure_handler: &windows::Win32::UI::Accessibility::IUIAutomationStructureChangedEventHandler,
) {
    use windows::Win32::UI::Accessibility::{
        UIA_Window_WindowClosedEventId, UIA_Window_WindowOpenedEventId,
    };

    unsafe {
        let _ = automation.RemoveAutomationEventHandler(
            UIA_Window_WindowOpenedEventId,
            element,
            automation_handler,
        );
        let _ = automation.RemoveAutomationEventHandler(
            UIA_Window_WindowClosedEventId,
            element,
            automation_handler,
        );
        let _ = automation.RemoveStructureChangedEventHandler(element, structure_handler);
        let _ = automation.RemovePropertyChangedEventHandler(element, property_handler);
    }
}

#[cfg(all(windows, not(test)))]
fn target_root_windows(scope: &UiaObserverScope) -> Vec<windows::Win32::Foundation::HWND> {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::WindowsAndMessaging::EnumWindows;

    let explicit_target_hwnds = scope
        .target_hwnd
        .as_deref()
        .and_then(parse_hwnd)
        .filter(|hwnd| !is_sensitive_window(*hwnd))
        .into_iter()
        .collect::<Vec<_>>();

    let mut context = TargetWindowEnumContext {
        allowed_process_ids: scope.allowed_process_ids.clone(),
        windows: Vec::new(),
    };
    unsafe {
        let _ = EnumWindows(
            Some(enum_target_window_proc),
            LPARAM((&mut context as *mut TargetWindowEnumContext) as isize),
        );
    }

    let mut roots = explicit_target_hwnds;
    roots.extend(
        context
            .windows
            .iter()
            .filter(|window| window.is_target_process && !window.is_sensitive)
            .map(|window| window.hwnd),
    );

    let target_keys = hwnd_keys(&roots);
    roots.extend(
        context
            .windows
            .iter()
            .filter(|window| !window.is_target_process && !window.is_sensitive)
            .filter(|window| owner_chain_contains_target(window.hwnd, &target_keys))
            .map(|window| window.hwnd),
    );

    dedupe_hwnds(roots)
}

#[cfg(all(windows, not(test)))]
fn target_root_windows_with_polling(
    scope: &UiaObserverScope,
    polling_attempt_count: &Arc<AtomicU32>,
) -> Vec<windows::Win32::Foundation::HWND> {
    let mut roots = target_root_windows(scope);
    if !roots.is_empty() {
        return roots;
    }

    for delay_ms in DEFAULT_UIA_OBSERVER_POLLING_DELAYS_MS {
        note_polling_attempt(polling_attempt_count);
        std::thread::sleep(Duration::from_millis(delay_ms));
        roots = target_root_windows(scope);
        if !roots.is_empty() {
            break;
        }
    }
    roots
}

#[cfg(all(windows, not(test)))]
fn note_polling_attempt(polling_attempt_count: &Arc<AtomicU32>) {
    polling_attempt_count.fetch_add(1, Ordering::SeqCst);
    inc_uia_observer_polling_attempt();
}

#[cfg(all(windows, not(test)))]
struct TargetWindowEnumContext {
    allowed_process_ids: Vec<u32>,
    windows: Vec<TargetWindowInfo>,
}

#[cfg(all(windows, not(test)))]
struct TargetWindowInfo {
    hwnd: windows::Win32::Foundation::HWND,
    is_target_process: bool,
    is_sensitive: bool,
}

#[cfg(all(windows, not(test)))]
unsafe extern "system" fn enum_target_window_proc(
    hwnd: windows::Win32::Foundation::HWND,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::BOOL {
    use windows::Win32::Foundation::BOOL;
    use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;

    if hwnd.is_invalid() || !unsafe { IsWindowVisible(hwnd) }.as_bool() || lparam.0 == 0 {
        return BOOL(1);
    }

    let context = unsafe { &mut *(lparam.0 as *mut TargetWindowEnumContext) };
    let process_id = hwnd_process_id(hwnd);
    let class_name = hwnd_class_name(hwnd);
    context.windows.push(TargetWindowInfo {
        hwnd,
        is_target_process: process_id.is_some_and(|pid| context.allowed_process_ids.contains(&pid)),
        is_sensitive: class_name.as_deref().is_some_and(is_sensitive_window_class),
    });

    BOOL(1)
}

#[cfg(all(windows, not(test)))]
fn hwnd_process_id(hwnd: windows::Win32::Foundation::HWND) -> Option<u32> {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    let mut pid = 0u32;
    unsafe {
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    (pid != 0).then_some(pid)
}

#[cfg(all(windows, not(test)))]
fn hwnd_class_name(hwnd: windows::Win32::Foundation::HWND) -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;

    let mut buffer = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, &mut buffer) };
    if len <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[..len as usize]))
}

fn is_sensitive_window_class(class_name: &str) -> bool {
    let normalized = class_name.trim().to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "shell_traywnd"
            | "shell_secondarytraywnd"
            | "progman"
            | "workerw"
            | "windows.internal.shell.tabproxywindow"
    ) || normalized.contains("credential")
        || normalized.contains("lockscreen")
}

#[cfg(all(windows, not(test)))]
fn is_sensitive_window(hwnd: windows::Win32::Foundation::HWND) -> bool {
    hwnd_class_name(hwnd)
        .as_deref()
        .is_some_and(is_sensitive_window_class)
}

#[cfg(all(windows, not(test)))]
fn owner_chain_contains_target(
    hwnd: windows::Win32::Foundation::HWND,
    target_keys: &[usize],
) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GW_OWNER, GetWindow};

    if target_keys.is_empty() {
        return false;
    }

    if hwnd_matches_observed_roots(hwnd, target_keys) {
        return true;
    }

    let mut visited = Vec::new();
    let mut current = hwnd;
    for _ in 0..16 {
        let owner = unsafe { GetWindow(current, GW_OWNER) }.ok();
        let Some(owner) = owner.filter(|value| !value.is_invalid()) else {
            return false;
        };

        let owner_key = hwnd_key(owner);
        if owner_key == 0 || visited.contains(&owner_key) {
            return false;
        }
        if hwnd_matches_observed_roots(owner, target_keys) {
            return true;
        }
        visited.push(owner_key);
        current = owner;
    }

    false
}

#[cfg(all(windows, not(test)))]
fn parse_hwnd(value: &str) -> Option<windows::Win32::Foundation::HWND> {
    let normalized = normalize_hwnd_string(Some(value))?;
    let hex = normalized.strip_prefix("0x").unwrap_or(normalized.as_str());
    let parsed = usize::from_str_radix(hex, 16).ok()?;
    if parsed == 0 {
        return None;
    }
    Some(windows::Win32::Foundation::HWND(
        parsed as *mut std::ffi::c_void,
    ))
}

#[cfg(all(windows, not(test)))]
fn hwnd_matches_observed_roots(
    hwnd: windows::Win32::Foundation::HWND,
    root_keys: &[usize],
) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GA_ROOT, GA_ROOTOWNER, GetAncestor};

    if root_keys.is_empty() {
        return false;
    }

    if root_keys.contains(&hwnd_key(hwnd)) {
        return true;
    }

    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    if !root.is_invalid() && root_keys.contains(&hwnd_key(root)) {
        return true;
    }

    let root_owner = unsafe { GetAncestor(hwnd, GA_ROOTOWNER) };
    !root_owner.is_invalid() && root_keys.contains(&hwnd_key(root_owner))
}

#[cfg(all(windows, not(test)))]
fn hwnd_keys(hwnds: &[windows::Win32::Foundation::HWND]) -> Vec<usize> {
    let mut keys = Vec::new();
    for hwnd in hwnds {
        let key = hwnd_key(*hwnd);
        if key != 0 && !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

#[cfg(all(windows, not(test)))]
fn hwnd_key(hwnd: windows::Win32::Foundation::HWND) -> usize {
    hwnd.0 as usize
}

#[cfg(all(windows, not(test)))]
fn dedupe_hwnds(
    hwnds: Vec<windows::Win32::Foundation::HWND>,
) -> Vec<windows::Win32::Foundation::HWND> {
    let mut seen = Vec::new();
    let mut deduped = Vec::new();
    for hwnd in hwnds {
        let key = hwnd_key(hwnd);
        if key == 0 || seen.contains(&key) {
            continue;
        }
        seen.push(key);
        deduped.push(hwnd);
    }
    deduped
}

#[cfg(all(windows, not(test)))]
fn automation_event_kind(
    eventid: windows::Win32::UI::Accessibility::UIA_EVENT_ID,
) -> Option<UiaObservedEventKind> {
    use windows::Win32::UI::Accessibility::{
        UIA_Window_WindowClosedEventId, UIA_Window_WindowOpenedEventId,
    };
    match eventid {
        value if value == UIA_Window_WindowOpenedEventId => {
            Some(UiaObservedEventKind::WindowOpened)
        }
        value if value == UIA_Window_WindowClosedEventId => {
            Some(UiaObservedEventKind::WindowClosed)
        }
        _ => None,
    }
}

#[cfg(all(windows, not(test)))]
fn native_element_process_id(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<u32> {
    unsafe { element.CurrentProcessId() }
        .ok()
        .and_then(|value| u32::try_from(value).ok())
}

#[cfg(all(windows, not(test)))]
fn native_element_hwnd(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<windows::Win32::Foundation::HWND> {
    unsafe { element.CurrentNativeWindowHandle() }
        .ok()
        .filter(|hwnd| !hwnd.is_invalid())
}

#[cfg(all(windows, not(test)))]
fn native_element_snapshot(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    tree_walker: Option<&windows::Win32::UI::Accessibility::IUIAutomationTreeWalker>,
    process_id: Option<u32>,
    native_hwnd: Option<windows::Win32::Foundation::HWND>,
    event_kind: UiaObservedEventKind,
) -> NativeElementSnapshot {
    let is_password = unsafe { element.CurrentIsPassword() }
        .ok()
        .map(|value| value.as_bool())
        .unwrap_or(false);
    let rect = unsafe { element.CurrentBoundingRectangle() }.ok();
    let identity = UiElementIdentity {
        runtime_id: unsafe { element.GetRuntimeId().ok() }.and_then(runtime_id_from_safe_array),
        process_id,
        window_hwnd: native_hwnd.and_then(hwnd_to_string),
        name: unsafe { element.CurrentName().ok() }.and_then(bstr_to_string),
        automation_id: unsafe { element.CurrentAutomationId().ok() }.and_then(bstr_to_string),
        control_type: unsafe { element.CurrentControlType().ok() }
            .map(|id| control_type_id_name(id.0).to_string()),
        localized_control_type: unsafe { element.CurrentLocalizedControlType().ok() }
            .and_then(bstr_to_string),
        class_name: unsafe { element.CurrentClassName().ok() }.and_then(bstr_to_string),
        framework_id: unsafe { element.CurrentFrameworkId().ok() }.and_then(bstr_to_string),
        parent_path: native_parent_path(tree_walker, element),
        bounding_rect: rect.and_then(rect_to_bounding_rect),
    };
    let captured_at_ms = now_timestamp_ms();
    let (value_length, value_text) = if is_password {
        (None, None)
    } else {
        native_value_content(element)
    };
    let selected_names = if is_password {
        None
    } else {
        native_selected_names(element)
    };
    let privacy_class =
        native_snapshot_privacy_class(is_password, value_length, value_text.as_ref());
    let state = UiStateSnapshot {
        snapshot_id: native_state_snapshot_id(&identity, captured_at_ms),
        captured_at_ms,
        element: Some(identity.clone()),
        is_enabled: unsafe { element.CurrentIsEnabled() }
            .ok()
            .map(|value| value.as_bool()),
        has_keyboard_focus: unsafe { element.CurrentHasKeyboardFocus() }
            .ok()
            .map(|value| value.as_bool()),
        is_offscreen: unsafe { element.CurrentIsOffscreen() }
            .ok()
            .map(|value| value.as_bool()),
        value_length,
        value_text,
        value_fingerprint: None,
        toggle_state: native_toggle_state(element),
        selection_state: native_selection_state(element),
        selected_names,
        expand_collapse_state: native_expand_collapse_state(element),
        range_value: native_range_value(element),
        privacy_class,
        source: Some(snapshot_source_for_observed_event(event_kind)),
    };

    NativeElementSnapshot {
        identity,
        state,
        is_password,
    }
}

#[cfg(all(windows, not(test)))]
fn runtime_id_from_safe_array(
    runtime_id: *mut windows::Win32::System::Com::SAFEARRAY,
) -> Option<Vec<i32>> {
    use windows::Win32::System::Ole::{
        SafeArrayAccessData, SafeArrayDestroy, SafeArrayGetLBound, SafeArrayGetUBound,
        SafeArrayUnaccessData,
    };

    if runtime_id.is_null() {
        return None;
    }

    let mut values = Vec::new();
    unsafe {
        let lower = SafeArrayGetLBound(runtime_id, 1).ok();
        let upper = SafeArrayGetUBound(runtime_id, 1).ok();
        if let (Some(lower), Some(upper)) = (lower, upper)
            && upper >= lower
        {
            let count = upper.saturating_sub(lower).saturating_add(1);
            let len = usize::try_from(count).unwrap_or_default().min(64);
            let mut data = std::ptr::null_mut();
            let accessed = SafeArrayAccessData(runtime_id, &mut data).is_ok();
            if accessed && !data.is_null() && len > 0 {
                let slice = std::slice::from_raw_parts(data.cast::<i32>(), len);
                values.extend_from_slice(slice);
            }
            if accessed {
                let _ = SafeArrayUnaccessData(runtime_id);
            }
        }
        let _ = SafeArrayDestroy(runtime_id);
    }

    (!values.is_empty()).then_some(values)
}

#[cfg(all(windows, not(test)))]
fn native_parent_path(
    tree_walker: Option<&windows::Win32::UI::Accessibility::IUIAutomationTreeWalker>,
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Vec<UiElementPathEntry> {
    let Some(tree_walker) = tree_walker else {
        return Vec::new();
    };

    let mut path = Vec::new();
    let mut current = element.clone();
    for _ in 0..8 {
        let Ok(parent) = (unsafe { tree_walker.GetParentElement(&current) }) else {
            break;
        };
        let entry = native_parent_path_entry(&parent);
        if path_entry_has_identity(&entry) {
            path.push(entry);
        }
        current = parent;
    }
    path.reverse();
    path
}

#[cfg(all(windows, not(test)))]
fn native_parent_path_entry(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> UiElementPathEntry {
    UiElementPathEntry {
        control_type: unsafe { element.CurrentControlType().ok() }
            .map(|id| control_type_id_name(id.0).to_string()),
        name: unsafe { element.CurrentName().ok() }.and_then(bstr_to_string),
        automation_id: unsafe { element.CurrentAutomationId().ok() }.and_then(bstr_to_string),
    }
}

#[cfg(all(windows, not(test)))]
fn path_entry_has_identity(entry: &UiElementPathEntry) -> bool {
    entry
        .control_type
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
        || entry
            .name
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty())
        || entry
            .automation_id
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty())
}

#[cfg(all(windows, not(test)))]
const VALUE_TEXT_MAX_CHARS: usize = 256;
#[cfg(all(windows, not(test)))]
const SELECTED_NAMES_MAX: usize = 8;

#[cfg(all(windows, not(test)))]
fn native_value_content(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> (Option<u32>, Option<String>) {
    use windows::Win32::UI::Accessibility::{IUIAutomationValuePattern, UIA_ValuePatternId};

    let pattern =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
            .ok();
    let Some(pattern) = pattern else {
        return (None, None);
    };
    let Ok(raw) = (unsafe { pattern.CurrentValue() }) else {
        return (None, None);
    };
    let text = raw.to_string();
    let length = u32::try_from(text.chars().count()).ok();
    let value_text = if crate::session::defect_config::is_semantic_plaintext_input_enabled() {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(truncate_chars(trimmed, VALUE_TEXT_MAX_CHARS))
        }
    } else {
        None
    };
    (length, value_text)
}

#[cfg(all(windows, not(test)))]
fn native_selected_names(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<Vec<String>> {
    use windows::Win32::UI::Accessibility::{
        IUIAutomationSelectionItemPattern, IUIAutomationSelectionPattern,
        UIA_SelectionItemPatternId, UIA_SelectionPatternId,
    };

    // Prefer multi-selection container pattern (ComboBox / List / File picker).
    if let Ok(pattern) = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationSelectionPattern>(UIA_SelectionPatternId)
    } && let Ok(selected) = unsafe { pattern.GetCurrentSelection() }
    {
        let mut names = Vec::new();
        let len = unsafe { selected.Length() }.unwrap_or(0);
        let limit = len.min(SELECTED_NAMES_MAX as i32);
        for index in 0..limit {
            if let Ok(item) = unsafe { selected.GetElement(index) }
                && let Ok(name) = unsafe { item.CurrentName() }
            {
                let text = name.to_string();
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    names.push(truncate_chars(trimmed, VALUE_TEXT_MAX_CHARS));
                }
            }
        }
        if !names.is_empty() {
            return Some(names);
        }
    }

    // Fall back: SelectionItem on the element itself (list/tree item click).
    if let Ok(pattern) = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
    } && unsafe { pattern.CurrentIsSelected() }
        .ok()
        .map(|v| v.as_bool())
        .unwrap_or(false)
        && let Ok(name) = unsafe { element.CurrentName() }
    {
        let text = name.to_string();
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(vec![truncate_chars(trimmed, VALUE_TEXT_MAX_CHARS)]);
        }
    }

    None
}

#[cfg(all(windows, not(test)))]
fn truncate_chars(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(all(windows, not(test)))]
fn native_toggle_state(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<ToggleState> {
    use windows::Win32::UI::Accessibility::{
        IUIAutomationTogglePattern, ToggleState_Indeterminate, ToggleState_Off, ToggleState_On,
        UIA_TogglePatternId,
    };

    let pattern =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) }
            .ok()?;
    let state = unsafe { pattern.CurrentToggleState() }.ok()?;
    Some(match state {
        value if value == ToggleState_On => ToggleState::On,
        value if value == ToggleState_Off => ToggleState::Off,
        value if value == ToggleState_Indeterminate => ToggleState::Indeterminate,
        _ => ToggleState::Unknown,
    })
}

#[cfg(all(windows, not(test)))]
fn native_selection_state(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<SelectionState> {
    use windows::Win32::UI::Accessibility::{
        IUIAutomationSelectionItemPattern, UIA_SelectionItemPatternId,
    };

    let pattern = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
    }
    .ok()?;
    let selected = unsafe { pattern.CurrentIsSelected() }.ok()?.as_bool();
    Some(if selected {
        SelectionState::Selected
    } else {
        SelectionState::NotSelected
    })
}

#[cfg(all(windows, not(test)))]
fn native_expand_collapse_state(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<ExpandCollapseState> {
    use windows::Win32::UI::Accessibility::{
        ExpandCollapseState_Collapsed, ExpandCollapseState_Expanded, ExpandCollapseState_LeafNode,
        ExpandCollapseState_PartiallyExpanded, IUIAutomationExpandCollapsePattern,
        UIA_ExpandCollapsePatternId,
    };

    let pattern = unsafe {
        element
            .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
    }
    .ok()?;
    let state = unsafe { pattern.CurrentExpandCollapseState() }.ok()?;
    Some(match state {
        value if value == ExpandCollapseState_Expanded => ExpandCollapseState::Expanded,
        value if value == ExpandCollapseState_Collapsed => ExpandCollapseState::Collapsed,
        value if value == ExpandCollapseState_PartiallyExpanded => {
            ExpandCollapseState::PartiallyExpanded
        }
        value if value == ExpandCollapseState_LeafNode => ExpandCollapseState::LeafNode,
        _ => ExpandCollapseState::Unknown,
    })
}

#[cfg(all(windows, not(test)))]
fn native_range_value(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<f64> {
    use windows::Win32::UI::Accessibility::{
        IUIAutomationRangeValuePattern, UIA_RangeValuePatternId,
    };

    let pattern = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationRangeValuePattern>(UIA_RangeValuePatternId)
    }
    .ok()?;
    unsafe { pattern.CurrentValue() }.ok()
}

#[cfg(all(windows, not(test)))]
fn native_snapshot_privacy_class(
    is_password: bool,
    value_length: Option<u32>,
    value_text: Option<&String>,
) -> PrivacyClass {
    if is_password {
        PrivacyClass::PasswordRedacted
    } else if value_text.is_some_and(|text| !text.is_empty()) {
        PrivacyClass::NotSensitive
    } else if value_length.is_some() {
        PrivacyClass::TextLengthOnly
    } else {
        PrivacyClass::NotSensitive
    }
}

#[cfg(all(windows, not(test)))]
fn native_state_snapshot_id(identity: &UiElementIdentity, captured_at_ms: u64) -> String {
    if let Some(runtime_id) = identity
        .runtime_id
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        let runtime_id = runtime_id
            .iter()
            .map(i32::to_string)
            .collect::<Vec<_>>()
            .join(".");
        return format!(
            "state-uia-{}-{runtime_id}-{captured_at_ms}",
            identity.process_id.unwrap_or_default()
        );
    }

    let hwnd = identity
        .window_hwnd
        .as_deref()
        .unwrap_or("unknown-window")
        .replace(':', "_");
    format!(
        "state-uia-{}-{hwnd}-{captured_at_ms}",
        identity.process_id.unwrap_or_default()
    )
}

#[cfg(all(windows, not(test)))]
fn snapshot_source_for_observed_event(event_kind: UiaObservedEventKind) -> UiStateSnapshotSource {
    match event_kind {
        UiaObservedEventKind::FocusChanged => UiStateSnapshotSource::UiaFocusEvent,
        UiaObservedEventKind::PropertyChanged => UiStateSnapshotSource::UiaPropertyEvent,
        _ => UiStateSnapshotSource::UiaSnapshot,
    }
}

#[cfg(all(windows, not(test)))]
fn hwnd_to_string(hwnd: windows::Win32::Foundation::HWND) -> Option<String> {
    if hwnd.is_invalid() {
        None
    } else {
        Some(format!("0x{:x}", hwnd.0 as usize))
    }
}

#[cfg(all(windows, not(test)))]
fn rect_to_bounding_rect(
    rect: windows::Win32::Foundation::RECT,
) -> Option<super::operation_models::UiBoundingRect> {
    let width = rect.right.saturating_sub(rect.left);
    let height = rect.bottom.saturating_sub(rect.top);
    if width <= 0 || height <= 0 {
        return None;
    }
    Some(super::operation_models::UiBoundingRect {
        left: rect.left,
        top: rect.top,
        width: u32::try_from(width).ok()?,
        height: u32::try_from(height).ok()?,
    })
}

#[cfg(all(windows, not(test)))]
fn bstr_to_string(value: windows::core::BSTR) -> Option<String> {
    normalize_text(Some(value.to_string()))
}

#[cfg(all(windows, not(test)))]
fn uia_property_label(
    propertyid: windows::Win32::UI::Accessibility::UIA_PROPERTY_ID,
) -> &'static str {
    use windows::Win32::UI::Accessibility::{
        UIA_BoundingRectanglePropertyId, UIA_ExpandCollapseExpandCollapseStatePropertyId,
        UIA_IsEnabledPropertyId, UIA_NamePropertyId, UIA_RangeValueValuePropertyId,
        UIA_SelectionItemIsSelectedPropertyId, UIA_ToggleToggleStatePropertyId,
        UIA_ValueValuePropertyId,
    };

    match propertyid {
        value if value == UIA_ValueValuePropertyId => "value",
        value if value == UIA_ToggleToggleStatePropertyId => "toggleState",
        value if value == UIA_SelectionItemIsSelectedPropertyId => "selectionState",
        value if value == UIA_ExpandCollapseExpandCollapseStatePropertyId => "expandCollapseState",
        value if value == UIA_RangeValueValuePropertyId => "rangeValue",
        value if value == UIA_IsEnabledPropertyId => "isEnabled",
        value if value == UIA_NamePropertyId => "name",
        value if value == UIA_BoundingRectanglePropertyId => "boundingRectangle",
        _ => "unknown",
    }
}

#[cfg(all(windows, not(test)))]
fn uia_property_reason_code(property: &str) -> OperationReasonCode {
    match property {
        "value" => OperationReasonCode::ValueLengthChanged,
        "toggleState" => OperationReasonCode::ToggleStateChanged,
        "selectionState" => OperationReasonCode::SelectionChanged,
        "expandCollapseState" => OperationReasonCode::ExpandStateChanged,
        "rangeValue" => OperationReasonCode::RangeValueChanged,
        "isEnabled" => OperationReasonCode::EnabledStateChanged,
        "name" | "boundingRectangle" => OperationReasonCode::StructureChanged,
        _ => OperationReasonCode::Other("uia-property-changed".to_string()),
    }
}

#[cfg(all(windows, not(test)))]
fn structure_change_label(
    changetype: windows::Win32::UI::Accessibility::StructureChangeType,
) -> &'static str {
    use windows::Win32::UI::Accessibility::{
        StructureChangeType_ChildAdded, StructureChangeType_ChildRemoved,
        StructureChangeType_ChildrenBulkAdded, StructureChangeType_ChildrenBulkRemoved,
        StructureChangeType_ChildrenInvalidated, StructureChangeType_ChildrenReordered,
    };

    match changetype {
        value if value == StructureChangeType_ChildAdded => "childAdded",
        value if value == StructureChangeType_ChildRemoved => "childRemoved",
        value if value == StructureChangeType_ChildrenInvalidated => "childrenInvalidated",
        value if value == StructureChangeType_ChildrenBulkAdded => "childrenBulkAdded",
        value if value == StructureChangeType_ChildrenBulkRemoved => "childrenBulkRemoved",
        value if value == StructureChangeType_ChildrenReordered => "childrenReordered",
        _ => "unknown",
    }
}

#[cfg(all(windows, not(test)))]
fn control_type_id_name(id: i32) -> &'static str {
    match id {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        _ => "Control",
    }
}

#[cfg(all(windows, not(test)))]
impl Drop for NativeUiaObserver {
    fn drop(&mut self) {
        use windows::Win32::System::Com::CoUninitialize;

        unsafe {
            for element in &self.roots {
                unregister_root_handlers(
                    &self.automation,
                    element,
                    &self.automation_handler,
                    &self.property_handler,
                    &self.structure_handler,
                );
            }
            let _ = self
                .automation
                .RemoveFocusChangedEventHandler(&self.focus_handler);
            if self.com_owned {
                CoUninitialize();
            }
        }
    }
}

#[cfg(any(test, not(windows)))]
struct NativeUiaObserver;

#[cfg(any(test, not(windows)))]
impl NativeUiaObserver {
    fn start(
        _session: UiaObserverSession,
        _sender: mpsc::SyncSender<UiaObserverCommand>,
        _overflow_count: Arc<AtomicU32>,
        _queue_depth: Arc<AtomicU32>,
        _polling_attempt_count: Arc<AtomicU32>,
        _started_at: Instant,
    ) -> Result<Self, UiaObserverError> {
        Ok(Self)
    }

    fn reconfigure(&mut self, _session: UiaObserverSession) -> Result<(), UiaObserverError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use serde_json::{Value, json};

    use super::{
        InteractionCompensationPoll, RecentInteraction, UiaEventDeduper, UiaEventRateLimiter,
        UiaObserverRuntime, UiaObserverScope, UiaObserverStopReport, crash_restart_backoff,
        is_sensitive_window_class, normalize_hwnd_string, should_bind_source_event,
        should_record_observed_event,
    };
    use crate::config::{
        DEFAULT_UIA_OBSERVER_LOW_PRIORITY_EVENT_BUDGET_PER_SECOND,
        DEFAULT_UIA_OBSERVER_QUEUE_HIGH_WATERMARK,
    };
    use crate::session::models::{TestSessionRecord, TestSessionStartOptions};
    use crate::session::operation_models::UiBoundingRect;
    use crate::session::semantic_event::{
        OperationReasonCode, PrivacyClass, SEMANTIC_EVENT_SCHEMA_VERSION, SemanticEventRecord,
        SemanticEventType, TEST_SESSION_SEMANTIC_EVENT_KIND,
    };
    use crate::session::semantic_event_store::SemanticEventStore;
    use crate::session::{ToggleState, UiElementIdentity, UiStateSnapshot, UiStateSnapshotSource};
    use crate::telemetry::read_uia_observer_queue_depth;

    #[test]
    fn observer_runtime_drains_events_on_stop() {
        let temp_dir = unique_temp_dir("shadowrecord-uia-observer-drain");
        let record = test_record("ts-observer-drain", &temp_dir);
        let mut runtime = UiaObserverRuntime::default();

        runtime.ensure_started(&record).expect("start observer");
        runtime
            .enqueue_event(sample_event(&record.session_id, "sem-observed-1", 10))
            .expect("enqueue event");
        let report = runtime.stop().expect("observer stop report");

        assert!(report.drained_event_count >= 3);
        assert_eq!(report.dropped_event_count, 0);
        let events = SemanticEventStore::for_session_dir(&temp_dir)
            .read()
            .expect("read events")
            .events;
        assert_eq!(events[0].event_type, SemanticEventType::ObserverHealth);
        assert!(
            events
                .iter()
                .any(|event| event.event_id == "sem-observed-1")
        );
        assert_eq!(
            events.last().map(|event| event.event_type.clone()),
            Some(SemanticEventType::ObserverHealth)
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn observer_runtime_drops_observed_events_while_paused() {
        let temp_dir = unique_temp_dir("shadowrecord-uia-observer-paused");
        let record = test_record("ts-observer-paused", &temp_dir);
        let mut runtime = UiaObserverRuntime::default();

        runtime.ensure_started(&record).expect("start observer");
        runtime.set_paused(true).expect("pause observer");
        runtime
            .enqueue_event(sample_event(&record.session_id, "sem-paused-drop", 10))
            .expect("enqueue paused event");
        runtime.set_paused(false).expect("resume observer");
        runtime
            .enqueue_event(sample_event(&record.session_id, "sem-after-resume", 20))
            .expect("enqueue resumed event");
        let report = runtime.stop().expect("observer stop report");

        assert_eq!(report.dropped_event_count, 1);
        let events = SemanticEventStore::for_session_dir(&temp_dir)
            .read()
            .expect("read events")
            .events;
        assert!(
            !events
                .iter()
                .any(|event| event.event_id == "sem-paused-drop")
        );
        assert!(
            events
                .iter()
                .any(|event| event.event_id == "sem-after-resume")
        );

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn observer_runtime_rejects_different_session_events() {
        let temp_dir = unique_temp_dir("shadowrecord-uia-observer-wrong-session");
        let record = test_record("ts-observer-active", &temp_dir);
        let mut runtime = UiaObserverRuntime::default();

        runtime.ensure_started(&record).expect("start observer");
        let err = runtime
            .enqueue_event(sample_event("ts-other", "sem-other", 10))
            .expect_err("wrong session should be rejected");
        assert!(err.to_string().contains("ts-other"));
        let _: Option<UiaObserverStopReport> = runtime.stop();

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn observer_runtime_reconfigures_only_when_target_scope_changes() {
        let temp_dir = unique_temp_dir("shadowrecord-uia-observer-scope-restart");
        let mut record = test_record("ts-observer-scope-restart", &temp_dir);
        record.target_pid = Some(1111);
        let mut runtime = UiaObserverRuntime::default();

        runtime.ensure_started(&record).expect("start observer");
        runtime
            .ensure_started(&record)
            .expect("same scope should be idempotent");

        let mut changed_record = record.clone();
        changed_record.target_pid = Some(2222);
        runtime
            .ensure_started(&changed_record)
            .expect("changed target PID should restart observer");
        let _ = runtime.stop().expect("observer stop report");

        let events = SemanticEventStore::for_session_dir(&temp_dir)
            .read()
            .expect("read events")
            .events;
        let restart_health_count = events
            .iter()
            .filter(|event| {
                event
                    .reason_codes
                    .contains(&OperationReasonCode::ObserverRestarted)
            })
            .count();
        assert_eq!(restart_health_count, 1);
        assert!(events.iter().any(|event| {
            event
                .payload
                .get("message")
                .and_then(|value| value.as_str())
                .is_some_and(|message| message.contains("reconfigured"))
        }));
        assert!(!events.iter().any(|event| {
            event
                .reason_codes
                .contains(&OperationReasonCode::ObserverRestarted)
                && event
                    .payload
                    .get("message")
                    .and_then(|value| value.as_str())
                    .is_some_and(|message| message.contains("worker started"))
        }));
        assert_eq!(
            runtime.scope, None,
            "stop should clear the active observer scope"
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn uia_observer_scope_requires_explicit_target_before_native_registration() {
        let temp_dir = unique_temp_dir("shadowrecord-uia-observer-scope-required");
        let record = test_record("ts-observer-no-target", &temp_dir);
        let scope = UiaObserverScope::from_record(&record);

        assert!(!scope.can_install_native_handlers());
        assert!(!should_record_observed_event(&scope, Some(42)));
        assert!(!should_record_observed_event(&scope, None));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn uia_observer_scope_allows_only_target_pid_and_normalizes_hwnd() {
        let temp_dir = unique_temp_dir("shadowrecord-uia-observer-scope-pid");
        let mut record = test_record("ts-observer-target", &temp_dir);
        record.target_pid = Some(4242);
        record.target_hwnd = Some("0X0000ABCD".to_string());
        let scope = UiaObserverScope::from_record(&record);

        assert!(scope.can_install_native_handlers());
        assert!(should_record_observed_event(&scope, Some(4242)));
        assert!(!should_record_observed_event(&scope, Some(4243)));
        assert!(!should_record_observed_event(&scope, Some(0)));
        assert_eq!(scope.target_hwnd.as_deref(), Some("0xabcd"));
        assert_eq!(
            normalize_hwnd_string(Some(" 0X0000002A ")).as_deref(),
            Some("0x2a")
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn recent_interaction_binds_focus_and_point_hit_within_300ms() {
        let recent = RecentInteraction {
            source_event_id: "evt-click".to_string(),
            x: 120,
            y: 220,
            occurred_at_ms: 1_000,
        };
        let mut focus = sample_event("ts-1", "sem-focus", 1_080);
        focus.event_type = SemanticEventType::UiaFocusChanged;
        assert!(should_bind_source_event(&focus, &recent, 300));

        let mut property = sample_event("ts-1", "sem-prop", 1_200);
        property.event_type = SemanticEventType::UiaPropertyChanged;
        property.target = Some(UiElementIdentity {
            bounding_rect: Some(UiBoundingRect {
                left: 100,
                top: 200,
                width: 80,
                height: 40,
            }),
            ..UiElementIdentity::default()
        });
        assert!(should_bind_source_event(&property, &recent, 300));

        let mut late = sample_event("ts-1", "sem-late", 1_400);
        late.event_type = SemanticEventType::UiaFocusChanged;
        assert!(!should_bind_source_event(&late, &recent, 300));

        let mut already = sample_event("ts-1", "sem-already", 1_050);
        already.event_type = SemanticEventType::UiaFocusChanged;
        already.source_event_id = Some("evt-other".to_string());
        assert!(!should_bind_source_event(&already, &recent, 300));
    }

    #[test]
    fn uia_observer_scope_excludes_default_sensitive_system_window_classes() {
        assert!(is_sensitive_window_class("Shell_TrayWnd"));
        assert!(is_sensitive_window_class(" shell_secondarytraywnd "));
        assert!(is_sensitive_window_class("Credential Dialog Xaml Host"));
        assert!(is_sensitive_window_class("LockScreenInputWindow"));
        assert!(!is_sensitive_window_class("Qt5152QWindowIcon"));
        assert!(!is_sensitive_window_class("Chrome_WidgetWin_1"));
        assert!(!is_sensitive_window_class("#32770"));
    }

    #[test]
    fn observer_runtime_enriches_events_with_state_cache_before_after() {
        let temp_dir = unique_temp_dir("shadowrecord-uia-observer-state-cache");
        let record = test_record("ts-observer-state-cache", &temp_dir);
        let element = UiElementIdentity {
            runtime_id: Some(vec![42, 7]),
            process_id: Some(4242),
            window_hwnd: Some("0x100".to_string()),
            automation_id: Some("sync-toggle".to_string()),
            control_type: Some("CheckBox".to_string()),
            ..UiElementIdentity::default()
        };
        let mut runtime = UiaObserverRuntime::default();

        runtime.ensure_started(&record).expect("start observer");
        runtime
            .enqueue_event(sample_state_event(
                &record.session_id,
                "sem-toggle-off",
                100,
                element.clone(),
                ToggleState::Off,
            ))
            .expect("enqueue initial state");
        runtime
            .enqueue_event(sample_state_event(
                &record.session_id,
                "sem-toggle-on",
                160,
                element,
                ToggleState::On,
            ))
            .expect("enqueue changed state");
        let _ = runtime.stop().expect("observer stop report");

        let events = SemanticEventStore::for_session_dir(&temp_dir)
            .read()
            .expect("read events")
            .events;
        let first = events
            .iter()
            .find(|event| event.event_id == "sem-toggle-off")
            .expect("first state event should be written");
        let second = events
            .iter()
            .find(|event| event.event_id == "sem-toggle-on")
            .expect("second state event should be written");

        assert_eq!(
            first
                .payload
                .get("stateCacheKey")
                .and_then(|value| value.as_str()),
            Some("runtime:4242:42.7")
        );
        assert!(first.payload.get("stateBefore").is_some_and(Value::is_null));
        assert_eq!(
            first.payload["stateAfter"]["toggleState"].as_str(),
            Some("off")
        );
        assert_eq!(
            second.payload["stateBefore"]["toggleState"].as_str(),
            Some("off")
        );
        assert_eq!(
            second.payload["stateAfter"]["toggleState"].as_str(),
            Some("on")
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn observer_runtime_flushes_queued_events_before_stop() {
        let temp_dir = unique_temp_dir("shadowrecord-uia-observer-flush");
        let record = test_record("ts-observer-flush", &temp_dir);
        let mut runtime = UiaObserverRuntime::default();

        runtime.ensure_started(&record).expect("start observer");
        runtime
            .enqueue_event(sample_structure_event(
                &record.session_id,
                "sem-flushed",
                100,
                7,
            ))
            .expect("enqueue event");
        runtime.flush().expect("flush observer");

        let events = SemanticEventStore::for_session_dir(&temp_dir)
            .read()
            .expect("read events")
            .events;
        assert!(events.iter().any(|event| event.event_id == "sem-flushed"));
        assert!(runtime.is_running());

        let _ = runtime.stop().expect("observer stop report");
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn uia_event_deduper_drops_same_semantic_key_within_window() {
        let mut deduper = UiaEventDeduper::default();

        assert!(!deduper.is_duplicate(&sample_event("ts-dedup", "sem-first", 100)));
        assert!(deduper.is_duplicate(&sample_event("ts-dedup", "sem-repeat", 149)));
        assert!(!deduper.is_duplicate(&sample_event("ts-dedup", "sem-after-window", 151)));
    }

    #[test]
    fn uia_event_rate_limiter_caps_low_priority_structure_and_keeps_focus() {
        let mut limiter = UiaEventRateLimiter::default();
        for index in 0..DEFAULT_UIA_OBSERVER_LOW_PRIORITY_EVENT_BUDGET_PER_SECOND {
            assert!(limiter.allow(
                &sample_structure_event("ts-rate", &format!("sem-structure-{index}"), 1_000, index),
                0,
            ));
        }

        assert!(!limiter.allow(
            &sample_structure_event("ts-rate", "sem-structure-over", 1_999, 99_999),
            0,
        ));
        assert!(limiter.allow(
            &sample_focus_event("ts-rate", "sem-focus-survives", 1_999),
            DEFAULT_UIA_OBSERVER_QUEUE_HIGH_WATERMARK,
        ));

        let mut high_watermark_limiter = UiaEventRateLimiter::default();
        assert!(!high_watermark_limiter.allow(
            &sample_structure_event("ts-rate", "sem-structure-high-watermark", 2_000, 1),
            DEFAULT_UIA_OBSERVER_QUEUE_HIGH_WATERMARK,
        ));
    }

    #[test]
    fn observer_runtime_reports_duplicate_drops() {
        let temp_dir = unique_temp_dir("shadowrecord-uia-observer-duplicate");
        let record = test_record("ts-observer-duplicate", &temp_dir);
        let mut runtime = UiaObserverRuntime::default();

        runtime.ensure_started(&record).expect("start observer");
        runtime
            .enqueue_event(sample_event(&record.session_id, "sem-first", 100))
            .expect("enqueue first event");
        runtime
            .enqueue_event(sample_event(&record.session_id, "sem-duplicate", 125))
            .expect("enqueue duplicate event");
        let report = runtime.stop().expect("observer stop report");

        assert_eq!(report.duplicate_drop_count, 1);
        assert_eq!(report.dropped_event_count, 1);
        let events = SemanticEventStore::for_session_dir(&temp_dir)
            .read()
            .expect("read events")
            .events;
        assert!(events.iter().any(|event| event.event_id == "sem-first"));
        assert!(!events.iter().any(|event| event.event_id == "sem-duplicate"));
        assert_eq!(
            events
                .last()
                .and_then(|event| event.payload.get("duplicateDropCount"))
                .and_then(Value::as_u64),
            Some(1)
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn observer_runtime_rate_limits_low_priority_structure_but_keeps_focus() {
        let temp_dir = unique_temp_dir("shadowrecord-uia-observer-rate-limit");
        let record = test_record("ts-observer-rate-limit", &temp_dir);
        let mut runtime = UiaObserverRuntime::default();
        let attempted = DEFAULT_UIA_OBSERVER_LOW_PRIORITY_EVENT_BUDGET_PER_SECOND + 5;

        runtime.ensure_started(&record).expect("start observer");
        for index in 0..attempted {
            runtime
                .enqueue_event(sample_structure_event(
                    &record.session_id,
                    &format!("sem-structure-{index}"),
                    1_000 + u64::from(index),
                    index,
                ))
                .expect("enqueue structure event");
        }
        runtime
            .enqueue_event(sample_focus_event(
                &record.session_id,
                "sem-focus-after-budget",
                1_999,
            ))
            .expect("enqueue focus event");
        let report = runtime.stop().expect("observer stop report");

        assert_eq!(report.rate_limit_drop_count, 5);
        assert_eq!(report.dropped_event_count, 5);
        let events = SemanticEventStore::for_session_dir(&temp_dir)
            .read()
            .expect("read events")
            .events;
        assert_eq!(
            events
                .iter()
                .filter(|event| event.event_type == SemanticEventType::UiaStructureChanged)
                .count(),
            DEFAULT_UIA_OBSERVER_LOW_PRIORITY_EVENT_BUDGET_PER_SECOND as usize
        );
        assert!(
            events
                .iter()
                .any(|event| event.event_id == "sem-focus-after-budget")
        );

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn observer_runtime_resets_queue_depth_metric_on_stop() {
        let temp_dir = unique_temp_dir("shadowrecord-uia-observer-queue-depth");
        let record = test_record("ts-observer-queue-depth", &temp_dir);
        let mut runtime = UiaObserverRuntime::default();

        runtime.ensure_started(&record).expect("start observer");
        runtime
            .enqueue_event(sample_event(&record.session_id, "sem-queued", 100))
            .expect("enqueue event");
        let _ = runtime.stop().expect("observer stop report");

        assert_eq!(read_uia_observer_queue_depth(), 0);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn event_state_snapshot_derives_minimal_snapshot_from_target_payload() {
        let element = UiElementIdentity {
            runtime_id: Some(vec![5, 6]),
            process_id: Some(100),
            automation_id: Some("save".to_string()),
            ..UiElementIdentity::default()
        };
        let event = SemanticEventRecord {
            schema_version: SEMANTIC_EVENT_SCHEMA_VERSION,
            kind: TEST_SESSION_SEMANTIC_EVENT_KIND.to_string(),
            event_id: "sem-derived".to_string(),
            session_id: "ts-derived".to_string(),
            event_type: SemanticEventType::UiaPropertyChanged,
            occurred_at_ms: 250,
            monotonic_offset_ms: Some(250),
            source_event_id: None,
            target: Some(element),
            payload: json!({
                "isEnabled": false,
                "hasKeyboardFocus": true,
                "toggleState": "on",
                "valueLength": 4,
            }),
            privacy_class: PrivacyClass::TextLengthOnly,
            reason_codes: vec![OperationReasonCode::ValueLengthChanged],
        };

        let snapshot = super::event_state_snapshot(&event).expect("derived state snapshot");

        assert_eq!(snapshot.snapshot_id, "state-sem-derived");
        assert_eq!(snapshot.captured_at_ms, 250);
        assert_eq!(snapshot.is_enabled, Some(false));
        assert_eq!(snapshot.has_keyboard_focus, Some(true));
        assert_eq!(snapshot.value_length, Some(4));
        assert_eq!(snapshot.toggle_state, Some(ToggleState::On));
        assert_eq!(snapshot.privacy_class, PrivacyClass::TextLengthOnly);
        assert_eq!(
            snapshot.source,
            Some(UiStateSnapshotSource::UiaPropertyEvent)
        );
    }

    fn test_record(session_id: &str, session_dir: &Path) -> TestSessionRecord {
        let options = TestSessionStartOptions {
            storage_dir: Some(session_dir.to_string_lossy().into_owned()),
            ..TestSessionStartOptions::default()
        };
        let mut record =
            TestSessionRecord::from_start_options(session_id.to_string(), 1, options, None, None);
        record.session_dir = Some(session_dir.to_string_lossy().into_owned());
        record
    }

    fn sample_event(session_id: &str, event_id: &str, occurred_at_ms: u64) -> SemanticEventRecord {
        SemanticEventRecord {
            schema_version: SEMANTIC_EVENT_SCHEMA_VERSION,
            kind: TEST_SESSION_SEMANTIC_EVENT_KIND.to_string(),
            event_id: event_id.to_string(),
            session_id: session_id.to_string(),
            event_type: SemanticEventType::UiaPropertyChanged,
            occurred_at_ms,
            monotonic_offset_ms: Some(occurred_at_ms),
            source_event_id: None,
            target: None,
            payload: json!({ "property": "toggleState", "after": "on" }),
            privacy_class: PrivacyClass::NotSensitive,
            reason_codes: vec![OperationReasonCode::ToggleStateChanged],
        }
    }

    fn sample_structure_event(
        session_id: &str,
        event_id: &str,
        occurred_at_ms: u64,
        runtime_id: u32,
    ) -> SemanticEventRecord {
        SemanticEventRecord {
            schema_version: SEMANTIC_EVENT_SCHEMA_VERSION,
            kind: TEST_SESSION_SEMANTIC_EVENT_KIND.to_string(),
            event_id: event_id.to_string(),
            session_id: session_id.to_string(),
            event_type: SemanticEventType::UiaStructureChanged,
            occurred_at_ms,
            monotonic_offset_ms: Some(occurred_at_ms),
            source_event_id: None,
            target: Some(UiElementIdentity {
                runtime_id: Some(vec![runtime_id as i32]),
                process_id: Some(4242),
                window_hwnd: Some("0x100".to_string()),
                control_type: Some("Pane".to_string()),
                ..UiElementIdentity::default()
            }),
            payload: json!({
                "source": "uia-structure",
                "changeType": "childrenInvalidated",
            }),
            privacy_class: PrivacyClass::NotSensitive,
            reason_codes: vec![OperationReasonCode::StructureChanged],
        }
    }

    fn sample_focus_event(
        session_id: &str,
        event_id: &str,
        occurred_at_ms: u64,
    ) -> SemanticEventRecord {
        SemanticEventRecord {
            schema_version: SEMANTIC_EVENT_SCHEMA_VERSION,
            kind: TEST_SESSION_SEMANTIC_EVENT_KIND.to_string(),
            event_id: event_id.to_string(),
            session_id: session_id.to_string(),
            event_type: SemanticEventType::UiaFocusChanged,
            occurred_at_ms,
            monotonic_offset_ms: Some(occurred_at_ms),
            source_event_id: None,
            target: Some(UiElementIdentity {
                runtime_id: Some(vec![9, 9]),
                process_id: Some(4242),
                window_hwnd: Some("0x100".to_string()),
                control_type: Some("Button".to_string()),
                ..UiElementIdentity::default()
            }),
            payload: json!({ "source": "uia-focus" }),
            privacy_class: PrivacyClass::NotSensitive,
            reason_codes: vec![OperationReasonCode::FocusChanged],
        }
    }

    fn sample_state_event(
        session_id: &str,
        event_id: &str,
        occurred_at_ms: u64,
        element: UiElementIdentity,
        toggle_state: ToggleState,
    ) -> SemanticEventRecord {
        let snapshot = UiStateSnapshot {
            snapshot_id: format!("state-{event_id}"),
            captured_at_ms: occurred_at_ms,
            element: Some(element.clone()),
            is_enabled: Some(true),
            has_keyboard_focus: Some(false),
            is_offscreen: Some(false),
            value_length: None,
            value_text: None,
            value_fingerprint: None,
            toggle_state: Some(toggle_state),
            selection_state: None,
            selected_names: None,
            expand_collapse_state: None,
            range_value: None,
            privacy_class: PrivacyClass::NotSensitive,
            source: Some(UiStateSnapshotSource::UiaPropertyEvent),
        };

        SemanticEventRecord {
            schema_version: SEMANTIC_EVENT_SCHEMA_VERSION,
            kind: TEST_SESSION_SEMANTIC_EVENT_KIND.to_string(),
            event_id: event_id.to_string(),
            session_id: session_id.to_string(),
            event_type: SemanticEventType::UiaPropertyChanged,
            occurred_at_ms,
            monotonic_offset_ms: Some(occurred_at_ms),
            source_event_id: None,
            target: Some(element),
            payload: json!({
                "property": "toggleState",
                "stateSnapshot": snapshot,
            }),
            privacy_class: PrivacyClass::NotSensitive,
            reason_codes: vec![OperationReasonCode::ToggleStateChanged],
        }
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!("{prefix}-{unique}"))
    }

    #[test]
    fn interaction_compensation_poll_advances_100_300_700_1500_3000_slots() {
        let base = Instant::now();
        let mut poll = InteractionCompensationPoll::new("evt-1", 10, 20, base);
        assert!(!poll.take_due(base + Duration::from_millis(50)));
        assert!(poll.take_due(base + Duration::from_millis(100)));
        assert_eq!(poll.next_index, 1);
        assert!(poll.take_due(base + Duration::from_millis(300)));
        assert!(poll.take_due(base + Duration::from_millis(700)));
        assert!(poll.take_due(base + Duration::from_millis(1_500)));
        assert!(poll.take_due(base + Duration::from_millis(3_000)));
        assert!(poll.is_finished());
        assert!(!poll.take_due(base + Duration::from_millis(10_000)));
    }

    #[test]
    fn crash_restart_backoff_grows_and_caps() {
        assert_eq!(crash_restart_backoff(1), Duration::from_millis(50));
        assert_eq!(crash_restart_backoff(2), Duration::from_millis(100));
        assert_eq!(crash_restart_backoff(5), Duration::from_millis(1_000));
        assert_eq!(crash_restart_backoff(99), Duration::from_millis(1_000));
    }
}
