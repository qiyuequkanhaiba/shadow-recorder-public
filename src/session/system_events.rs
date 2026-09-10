#![cfg_attr(test, allow(dead_code))]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use windows::Win32::Foundation::{BOOL, CloseHandle, HMODULE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::DataExchange::{
    AddClipboardFormatListener, GetClipboardSequenceNumber, IsClipboardFormatAvailable,
    RegisterClipboardFormatW, RemoveClipboardFormatListener,
};
use windows::Win32::System::Ole::{CF_BITMAP, CF_DIB, CF_DIBV5, CF_HDROP, CF_UNICODETEXT};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    EVENT_OBJECT_FOCUS, EVENT_OBJECT_HIDE, EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_SHOW,
    EVENT_SYSTEM_FOREGROUND, EnumWindows, GA_ROOT, GetAncestor, GetForegroundWindow, GetWindowRect,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, HWND_MESSAGE, IsWindowVisible,
    MSG, MWMO_INPUTAVAILABLE, MsgWaitForMultipleObjectsEx, OBJECT_IDENTIFIER, OBJID_WINDOW,
    PM_REMOVE, PeekMessageW, QS_ALLINPUT, RegisterClassW, TranslateMessage, WINDOW_EX_STYLE,
    WINDOW_STYLE, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_CLIPBOARDUPDATE, WNDCLASSW,
};
use windows::core::{PCWSTR, PWSTR, w};

use crate::session::TestSessionSystemEventInput;
use crate::session::manager::TEST_SESSION_MANAGER;
use crate::session::models::TestSessionEventType;
use crate::types::StepData;

const FOREGROUND_EVENT_DEBOUNCE: Duration = Duration::from_millis(240);
const FOCUS_EVENT_DEBOUNCE: Duration = Duration::from_millis(180);
const SHOW_EVENT_DEBOUNCE: Duration = Duration::from_millis(280);
const HIDE_EVENT_DEBOUNCE: Duration = Duration::from_millis(280);
const TITLE_EVENT_DEBOUNCE: Duration = Duration::from_millis(420);
const CLIPBOARD_EVENT_DEBOUNCE: Duration = Duration::from_millis(120);
const ACTIVE_WINDOW_REPEAT_COOLDOWN: Duration = Duration::from_millis(900);
const WINDOW_STATE_RETENTION: Duration = Duration::from_secs(120);
const STOP_JOIN_TIMEOUT_MS: u64 = 2_000;

#[derive(Debug)]
pub enum SystemEventListenerError {
    ThreadStartFailed,
    InitChannelClosed,
    WindowCreation(String),
    ClipboardRegistration(String),
    HookInstall(String),
}

impl std::fmt::Display for SystemEventListenerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ThreadStartFailed => write!(f, "system event listener thread failed to start"),
            Self::InitChannelClosed => write!(f, "system event listener init channel closed"),
            Self::WindowCreation(message) => write!(f, "system event window failed: {message}"),
            Self::ClipboardRegistration(message) => {
                write!(f, "clipboard listener registration failed: {message}")
            }
            Self::HookInstall(message) => write!(f, "win event hook install failed: {message}"),
        }
    }
}

impl std::error::Error for SystemEventListenerError {}

#[derive(Default)]
pub struct SystemEventRuntime {
    stop: Option<Arc<AtomicBool>>,
    handle: Option<JoinHandle<()>>,
}

impl SystemEventRuntime {
    pub fn ensure_started(&mut self) -> Result<(), SystemEventListenerError> {
        if self.handle.is_some() {
            return Ok(());
        }

        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), SystemEventListenerError>>();
        let thread_stop = Arc::clone(&stop);
        let handle = std::thread::Builder::new()
            .name("shadow-record-system-events".to_string())
            .spawn(move || run_system_event_thread(thread_stop, ready_tx))
            .map_err(|_| SystemEventListenerError::ThreadStartFailed)?;

        match ready_rx.recv() {
            Ok(Ok(())) => {
                self.stop = Some(stop);
                self.handle = Some(handle);
                Ok(())
            }
            Ok(Err(err)) => {
                let _ = handle.join();
                Err(err)
            }
            Err(_) => {
                let _ = handle.join();
                Err(SystemEventListenerError::InitChannelClosed)
            }
        }
    }

    pub fn stop(&mut self) {
        if let Some(flag) = self.stop.take() {
            flag.store(true, Ordering::SeqCst);
        }
        if let Some(handle) = self.handle.take() {
            join_with_timeout(
                handle,
                Duration::from_millis(STOP_JOIN_TIMEOUT_MS),
                "system-event",
            );
        }
    }
}

impl Drop for SystemEventRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

fn join_with_timeout(handle: JoinHandle<()>, timeout: Duration, label: &str) {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if handle.is_finished() {
            let _ = handle.join();
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    eprintln!(
        "[shadowrecord] timed out waiting for {label} worker to stop after {} ms; detaching thread",
        timeout.as_millis()
    );
}

#[derive(Default)]
struct SystemEventThreadState {
    last_signature_at: HashMap<String, Instant>,
    last_focused_window: Option<String>,
    window_state_by_hwnd: HashMap<String, WindowNoiseState>,
    clipboard_sequence: u32,
    html_format: u32,
}

#[derive(Debug, Clone, Copy, Default)]
struct WindowNoiseState {
    last_attention_at: Option<Instant>,
    visible: Option<bool>,
    last_visibility_at: Option<Instant>,
}

static THREAD_STATE: Lazy<Mutex<Option<SystemEventThreadState>>> = Lazy::new(|| Mutex::new(None));

#[derive(Debug, Clone)]
struct WindowSnapshot {
    hwnd: String,
    pid: u32,
    process_name: String,
    window_title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForegroundProcess {
    pub pid: u32,
    pub process_name: String,
    pub window_hwnd: String,
}

pub fn find_foreground_process() -> Option<ForegroundProcess> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return None;
    }
    let snapshot = snapshot_window(hwnd)?;
    if snapshot.pid == 0 || snapshot.pid == std::process::id() {
        return None;
    }
    Some(ForegroundProcess {
        pid: snapshot.pid,
        process_name: snapshot.process_name,
        window_hwnd: snapshot.hwnd,
    })
}

pub fn process_names_match(left: &str, right: &str) -> bool {
    match (normalize_process_name(left), normalize_process_name(right)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

pub fn find_visible_process_pid_by_name(process_name: &str) -> Option<u32> {
    let target = normalize_process_name(process_name)?;
    let mut context = ProcessWindowSearch {
        target,
        matched_pid: None,
    };
    unsafe {
        let _ = EnumWindows(
            Some(enum_process_window_proc),
            LPARAM((&mut context as *mut ProcessWindowSearch) as isize),
        );
    }
    context.matched_pid
}

struct ProcessWindowSearch {
    target: String,
    matched_pid: Option<u32>,
}

unsafe extern "system" fn enum_process_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if hwnd.0.is_null() || lparam.0 == 0 || unsafe { !IsWindowVisible(hwnd).as_bool() } {
        return BOOL(1);
    }

    let context = unsafe { &mut *(lparam.0 as *mut ProcessWindowSearch) };
    let mut pid = 0u32;
    unsafe {
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    if pid == 0 {
        return BOOL(1);
    }

    if query_process_name(pid)
        .ok()
        .and_then(|name| normalize_process_name(&name))
        .as_deref()
        == Some(context.target.as_str())
    {
        context.matched_pid = Some(pid);
        return BOOL(0);
    }

    BOOL(1)
}

unsafe extern "system" fn clipboard_window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_CLIPBOARDUPDATE {
        handle_clipboard_update();
        return LRESULT(0);
    }

    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

unsafe extern "system" fn session_win_event_proc(
    _hook: windows::Win32::UI::Accessibility::HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    _id_child: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    if hwnd.0.is_null() {
        return;
    }

    let maybe_input = match event {
        EVENT_SYSTEM_FOREGROUND => build_window_event_input(
            TestSessionEventType::WindowForegroundChanged,
            hwnd,
            Some("前台窗口已切换".to_string()),
            FOREGROUND_EVENT_DEBOUNCE,
        ),
        EVENT_OBJECT_FOCUS => build_window_event_input(
            TestSessionEventType::WindowFocusChanged,
            hwnd,
            Some("窗口焦点已变化".to_string()),
            FOCUS_EVENT_DEBOUNCE,
        ),
        EVENT_OBJECT_SHOW if is_window_object(id_object) => build_window_event_input(
            TestSessionEventType::WindowShown,
            hwnd,
            Some("窗口已显示".to_string()),
            SHOW_EVENT_DEBOUNCE,
        ),
        EVENT_OBJECT_HIDE if is_window_object(id_object) => build_window_event_input(
            TestSessionEventType::WindowHidden,
            hwnd,
            Some("窗口已隐藏".to_string()),
            HIDE_EVENT_DEBOUNCE,
        ),
        EVENT_OBJECT_NAMECHANGE if is_window_object(id_object) => build_window_event_input(
            TestSessionEventType::WindowTitleChanged,
            hwnd,
            Some("窗口标题已变化".to_string()),
            TITLE_EVENT_DEBOUNCE,
        ),
        _ => None,
    };

    if let Some(input) = maybe_input {
        let _ = TEST_SESSION_MANAGER.append_system_event(input);
    }
}

fn run_system_event_thread(
    stop: Arc<AtomicBool>,
    ready_tx: mpsc::Sender<Result<(), SystemEventListenerError>>,
) {
    if let Ok(mut guard) = THREAD_STATE.lock() {
        *guard = Some(SystemEventThreadState {
            html_format: unsafe { RegisterClipboardFormatW(w!("HTML Format")) },
            ..SystemEventThreadState::default()
        });
    }

    let class_name: PCWSTR = w!("ShadowRecorderSessionSystemEvents");
    let wc = WNDCLASSW {
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(clipboard_window_proc),
        lpszClassName: class_name,
        ..Default::default()
    };

    unsafe {
        let _ = RegisterClassW(&wc);
    }

    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class_name,
            class_name,
            WINDOW_STYLE::default(),
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            None,
            None,
            None,
        )
    };

    let hwnd = match hwnd {
        Ok(value) => value,
        Err(err) => {
            let _ = ready_tx.send(Err(SystemEventListenerError::WindowCreation(format!(
                "{err:?}"
            ))));
            reset_thread_state();
            return;
        }
    };

    if let Err(err) = unsafe { AddClipboardFormatListener(hwnd) } {
        let _ = ready_tx.send(Err(SystemEventListenerError::ClipboardRegistration(
            format!("{err:?}"),
        )));
        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        reset_thread_state();
        return;
    }

    let foreground_hook = unsafe {
        SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            HMODULE::default(),
            Some(session_win_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        )
    };
    if foreground_hook.is_invalid() {
        let _ = ready_tx.send(Err(SystemEventListenerError::HookInstall(
            "EVENT_SYSTEM_FOREGROUND".to_string(),
        )));
        unsafe {
            let _ = RemoveClipboardFormatListener(hwnd);
            let _ = DestroyWindow(hwnd);
        }
        reset_thread_state();
        return;
    }

    let focus_hook = unsafe {
        SetWinEventHook(
            EVENT_OBJECT_FOCUS,
            EVENT_OBJECT_FOCUS,
            HMODULE::default(),
            Some(session_win_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        )
    };
    if focus_hook.is_invalid() {
        let _ = ready_tx.send(Err(SystemEventListenerError::HookInstall(
            "EVENT_OBJECT_FOCUS".to_string(),
        )));
        unsafe {
            let _ = UnhookWinEvent(foreground_hook);
            let _ = RemoveClipboardFormatListener(hwnd);
            let _ = DestroyWindow(hwnd);
        }
        reset_thread_state();
        return;
    }

    let show_hook = unsafe {
        SetWinEventHook(
            EVENT_OBJECT_SHOW,
            EVENT_OBJECT_SHOW,
            HMODULE::default(),
            Some(session_win_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        )
    };
    if show_hook.is_invalid() {
        let _ = ready_tx.send(Err(SystemEventListenerError::HookInstall(
            "EVENT_OBJECT_SHOW".to_string(),
        )));
        unsafe {
            let _ = UnhookWinEvent(focus_hook);
            let _ = UnhookWinEvent(foreground_hook);
            let _ = RemoveClipboardFormatListener(hwnd);
            let _ = DestroyWindow(hwnd);
        }
        reset_thread_state();
        return;
    }

    let hide_hook = unsafe {
        SetWinEventHook(
            EVENT_OBJECT_HIDE,
            EVENT_OBJECT_HIDE,
            HMODULE::default(),
            Some(session_win_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        )
    };
    if hide_hook.is_invalid() {
        let _ = ready_tx.send(Err(SystemEventListenerError::HookInstall(
            "EVENT_OBJECT_HIDE".to_string(),
        )));
        unsafe {
            let _ = UnhookWinEvent(show_hook);
            let _ = UnhookWinEvent(focus_hook);
            let _ = UnhookWinEvent(foreground_hook);
            let _ = RemoveClipboardFormatListener(hwnd);
            let _ = DestroyWindow(hwnd);
        }
        reset_thread_state();
        return;
    }

    let title_hook = unsafe {
        SetWinEventHook(
            EVENT_OBJECT_NAMECHANGE,
            EVENT_OBJECT_NAMECHANGE,
            HMODULE::default(),
            Some(session_win_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        )
    };
    if title_hook.is_invalid() {
        let _ = ready_tx.send(Err(SystemEventListenerError::HookInstall(
            "EVENT_OBJECT_NAMECHANGE".to_string(),
        )));
        unsafe {
            let _ = UnhookWinEvent(hide_hook);
            let _ = UnhookWinEvent(show_hook);
            let _ = UnhookWinEvent(focus_hook);
            let _ = UnhookWinEvent(foreground_hook);
            let _ = RemoveClipboardFormatListener(hwnd);
            let _ = DestroyWindow(hwnd);
        }
        reset_thread_state();
        return;
    }

    let _ = ready_tx.send(Ok(()));

    let mut msg = MSG::default();
    while !stop.load(Ordering::SeqCst) {
        unsafe {
            let _ = MsgWaitForMultipleObjectsEx(None, 40, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
        }

        if unsafe { PeekMessageW(&mut msg, HWND::default(), 0, 0, PM_REMOVE).as_bool() } {
            loop {
                unsafe {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                let next =
                    unsafe { PeekMessageW(&mut msg, HWND::default(), 0, 0, PM_REMOVE).as_bool() };
                if !next {
                    break;
                }
            }
        }
    }

    unsafe {
        let _ = UnhookWinEvent(title_hook);
        let _ = UnhookWinEvent(hide_hook);
        let _ = UnhookWinEvent(show_hook);
        let _ = UnhookWinEvent(focus_hook);
        let _ = UnhookWinEvent(foreground_hook);
        let _ = RemoveClipboardFormatListener(hwnd);
        let _ = DestroyWindow(hwnd);
    }
    reset_thread_state();
}

fn build_window_event_input(
    event_type: TestSessionEventType,
    hwnd: HWND,
    title: Option<String>,
    debounce: Duration,
) -> Option<TestSessionSystemEventInput> {
    let snapshot = snapshot_window(hwnd)?;
    let signature = format!(
        "{}:{}:{}:{}",
        event_type.as_str(),
        snapshot.hwnd,
        snapshot.process_name,
        snapshot.window_title
    );
    if !should_emit_signature(signature, debounce) {
        return None;
    }
    if !should_emit_window_state_event(&event_type, &snapshot.hwnd) {
        return None;
    }

    let message = match event_type {
        TestSessionEventType::WindowForegroundChanged => Some(format!(
            "前台切换到 {} · {}",
            snapshot.process_name,
            sanitize_window_title(&snapshot.window_title)
        )),
        TestSessionEventType::WindowFocusChanged => Some(format!(
            "焦点进入 {} · {}",
            snapshot.process_name,
            sanitize_window_title(&snapshot.window_title)
        )),
        TestSessionEventType::WindowShown => Some(format!(
            "窗口已显示 {} · {}",
            snapshot.process_name,
            sanitize_window_title(&snapshot.window_title)
        )),
        TestSessionEventType::WindowHidden => Some(format!(
            "窗口已隐藏 {} · {}",
            snapshot.process_name,
            sanitize_window_title(&snapshot.window_title)
        )),
        TestSessionEventType::WindowTitleChanged => Some(format!(
            "标题更新为 {}",
            sanitize_window_title(&snapshot.window_title)
        )),
        _ => None,
    };

    Some(TestSessionSystemEventInput {
        event_type,
        occurred_at_ms: StepData::now_timestamp_ms(),
        title,
        message,
        process_name: Some(snapshot.process_name),
        window_title: Some(snapshot.window_title),
        window_hwnd: Some(snapshot.hwnd),
        window_pid: Some(snapshot.pid),
        system_source: Some("win_event".to_string()),
        clipboard_content_type: None,
        ..TestSessionSystemEventInput::default()
    })
}

fn handle_clipboard_update() {
    let (clipboard_type, html_format) = {
        let mut guard = match THREAD_STATE.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        let Some(state) = guard.as_mut() else {
            return;
        };

        let sequence = unsafe { GetClipboardSequenceNumber() };
        if sequence == 0 || sequence == state.clipboard_sequence {
            return;
        }
        state.clipboard_sequence = sequence;
        (
            detect_clipboard_content_type(state.html_format),
            state.html_format,
        )
    };

    let snapshot = unsafe { GetForegroundWindow() };
    let window_context = if snapshot.0.is_null() {
        None
    } else {
        snapshot_window(snapshot)
    };

    let process_name = window_context
        .as_ref()
        .map(|value| value.process_name.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let window_title = window_context
        .as_ref()
        .map(|value| value.window_title.clone())
        .unwrap_or_default();
    let window_hwnd = window_context.as_ref().map(|value| value.hwnd.clone());
    let window_pid = window_context.as_ref().map(|value| value.pid);

    let signature = format!(
        "clipboard:{}:{}:{}",
        clipboard_type,
        process_name,
        sanitize_window_title(&window_title)
    );
    if !should_emit_signature(signature, CLIPBOARD_EVENT_DEBOUNCE) {
        return;
    }

    let message = if window_title.is_empty() {
        format!("剪贴板内容已更新，类型摘要为 {clipboard_type}。")
    } else {
        format!(
            "剪贴板内容已更新，类型摘要为 {clipboard_type}，当前窗口 {} · {}。",
            process_name,
            sanitize_window_title(&window_title)
        )
    };

    let _ = TEST_SESSION_MANAGER.append_system_event(TestSessionSystemEventInput {
        event_type: TestSessionEventType::ClipboardUpdated,
        occurred_at_ms: StepData::now_timestamp_ms(),
        title: Some("剪贴板已更新".to_string()),
        message: Some(message),
        process_name: Some(process_name),
        window_title: if window_title.is_empty() {
            None
        } else {
            Some(window_title)
        },
        window_hwnd,
        window_pid,
        system_source: Some("clipboard".to_string()),
        clipboard_content_type: Some(clipboard_type.to_string()),
        ..TestSessionSystemEventInput::default()
    });

    let _ = html_format;
}

fn detect_clipboard_content_type(html_format: u32) -> &'static str {
    if html_format != 0 && unsafe { IsClipboardFormatAvailable(html_format) }.is_ok() {
        return "html";
    }
    if unsafe { IsClipboardFormatAvailable(CF_HDROP.0.into()) }.is_ok() {
        return "file_list";
    }
    if unsafe { IsClipboardFormatAvailable(CF_DIBV5.0.into()) }.is_ok()
        || unsafe { IsClipboardFormatAvailable(CF_DIB.0.into()) }.is_ok()
        || unsafe { IsClipboardFormatAvailable(CF_BITMAP.0.into()) }.is_ok()
    {
        return "image";
    }
    if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT.0.into()) }.is_ok() {
        return "text";
    }
    "unknown"
}

fn should_emit_signature(signature: String, debounce: Duration) -> bool {
    let mut guard = match THREAD_STATE.lock() {
        Ok(guard) => guard,
        Err(_) => return false,
    };
    let Some(state) = guard.as_mut() else {
        return false;
    };

    let now = Instant::now();
    if let Some(last_seen) = state.last_signature_at.get(&signature)
        && now.duration_since(*last_seen) < debounce
    {
        return false;
    }

    state.last_signature_at.insert(signature, now);
    state
        .last_signature_at
        .retain(|_, last_seen| now.duration_since(*last_seen) <= Duration::from_secs(30));
    true
}

fn should_emit_window_state_event(event_type: &TestSessionEventType, hwnd: &str) -> bool {
    let mut guard = match THREAD_STATE.lock() {
        Ok(guard) => guard,
        Err(_) => return false,
    };
    let Some(state) = guard.as_mut() else {
        return false;
    };

    let now = Instant::now();
    prune_window_noise_state(state, now);

    match event_type {
        TestSessionEventType::WindowForegroundChanged
        | TestSessionEventType::WindowFocusChanged => {
            if state.last_focused_window.as_deref() == Some(hwnd)
                && state
                    .window_state_by_hwnd
                    .get(hwnd)
                    .and_then(|value| value.last_attention_at)
                    .is_some_and(|last_seen| {
                        now.duration_since(last_seen) < ACTIVE_WINDOW_REPEAT_COOLDOWN
                    })
            {
                return false;
            }

            let entry = state
                .window_state_by_hwnd
                .entry(hwnd.to_string())
                .or_default();
            entry.last_attention_at = Some(now);
            state.last_focused_window = Some(hwnd.to_string());
            true
        }
        TestSessionEventType::WindowShown => {
            let entry = state
                .window_state_by_hwnd
                .entry(hwnd.to_string())
                .or_default();
            if entry.visible == Some(true) {
                entry.last_visibility_at = Some(now);
                return false;
            }
            entry.visible = Some(true);
            entry.last_visibility_at = Some(now);
            true
        }
        TestSessionEventType::WindowHidden => {
            let entry = state
                .window_state_by_hwnd
                .entry(hwnd.to_string())
                .or_default();
            if entry.visible == Some(false) {
                entry.last_visibility_at = Some(now);
                return false;
            }
            entry.visible = Some(false);
            entry.last_visibility_at = Some(now);
            if state.last_focused_window.as_deref() == Some(hwnd) {
                state.last_focused_window = None;
            }
            true
        }
        _ => true,
    }
}

fn prune_window_noise_state(state: &mut SystemEventThreadState, now: Instant) {
    state.window_state_by_hwnd.retain(|hwnd, entry| {
        let recent_attention = entry
            .last_attention_at
            .is_some_and(|last_seen| now.duration_since(last_seen) <= WINDOW_STATE_RETENTION);
        let recent_visibility = entry
            .last_visibility_at
            .is_some_and(|last_seen| now.duration_since(last_seen) <= WINDOW_STATE_RETENTION);
        let keep = recent_attention || recent_visibility;
        if !keep && state.last_focused_window.as_deref() == Some(hwnd.as_str()) {
            state.last_focused_window = None;
        }
        keep
    });
}

fn snapshot_window(hwnd: HWND) -> Option<WindowSnapshot> {
    let hwnd = normalize_window_handle(hwnd);
    if hwnd.0.is_null() {
        return None;
    }

    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
        return None;
    }

    let title_len = unsafe { GetWindowTextLengthW(hwnd) };
    let mut title_buf = vec![0u16; title_len.max(0) as usize + 1];
    let copied = unsafe { GetWindowTextW(hwnd, &mut title_buf) };
    let window_title = String::from_utf16_lossy(&title_buf[..copied.max(0) as usize]);

    let mut pid = 0u32;
    unsafe {
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    let process_name = query_process_name(pid).unwrap_or_else(|_| format!("pid:{pid}"));

    let _ = unsafe { GetDpiForWindow(hwnd) };

    Some(WindowSnapshot {
        hwnd: format!("0x{:x}", hwnd.0 as usize),
        pid,
        process_name,
        window_title,
    })
}

fn normalize_window_handle(hwnd: HWND) -> HWND {
    if hwnd.0.is_null() {
        return hwnd;
    }
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    if root.0.is_null() { hwnd } else { root }
}

fn is_window_object(id_object: i32) -> bool {
    id_object == OBJECT_IDENTIFIER(OBJID_WINDOW.0).0
}

fn query_process_name(pid: u32) -> Result<String, String> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
        .map_err(|err| format!("OpenProcess failed: {err:?}"))?;

    let mut size = 260u32;
    let mut buf = vec![0u16; size as usize];
    let query_result = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        )
    }
    .map_err(|err| format!("QueryFullProcessImageNameW failed: {err:?}"));

    unsafe {
        let _ = CloseHandle(handle);
    }

    query_result?;
    let path = String::from_utf16_lossy(&buf[..size as usize]);
    Ok(path
        .rsplit(['\\', '/'])
        .next()
        .map(|value| value.to_string())
        .unwrap_or(path))
}

fn normalize_process_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed
        .rsplit(['\\', '/'])
        .next()
        .map(|name| name.to_ascii_lowercase())
        .filter(|name| !name.is_empty())
}

fn sanitize_window_title(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "Untitled Window".to_string()
    } else {
        trimmed.to_string()
    }
}

fn reset_thread_state() {
    if let Ok(mut guard) = THREAD_STATE.lock() {
        *guard = None;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ACTIVE_WINDOW_REPEAT_COOLDOWN, SystemEventThreadState, WINDOW_STATE_RETENTION,
        WindowNoiseState, normalize_process_name, process_names_match, prune_window_noise_state,
        should_emit_window_state_event,
    };
    use crate::session::models::TestSessionEventType;

    fn with_thread_state<T>(state: SystemEventThreadState, action: impl FnOnce() -> T) -> T {
        if let Ok(mut guard) = super::THREAD_STATE.lock() {
            *guard = Some(state);
        }
        let result = action();
        if let Ok(mut guard) = super::THREAD_STATE.lock() {
            *guard = None;
        }
        result
    }

    #[test]
    fn focus_noise_filter_suppresses_repeated_same_window_attention() {
        with_thread_state(SystemEventThreadState::default(), || {
            assert!(should_emit_window_state_event(
                &TestSessionEventType::WindowFocusChanged,
                "0x100",
            ));
            assert!(!should_emit_window_state_event(
                &TestSessionEventType::WindowForegroundChanged,
                "0x100",
            ));
            assert!(should_emit_window_state_event(
                &TestSessionEventType::WindowFocusChanged,
                "0x200",
            ));
        });
    }

    #[test]
    fn show_hide_noise_filter_suppresses_duplicate_visibility_state() {
        with_thread_state(SystemEventThreadState::default(), || {
            assert!(should_emit_window_state_event(
                &TestSessionEventType::WindowShown,
                "0x100",
            ));
            assert!(!should_emit_window_state_event(
                &TestSessionEventType::WindowShown,
                "0x100",
            ));
            assert!(should_emit_window_state_event(
                &TestSessionEventType::WindowHidden,
                "0x100",
            ));
            assert!(!should_emit_window_state_event(
                &TestSessionEventType::WindowHidden,
                "0x100",
            ));
        });
    }

    #[test]
    fn prune_window_noise_state_discards_stale_entries() {
        let now = std::time::Instant::now();
        let mut state = SystemEventThreadState {
            last_signature_at: Default::default(),
            last_focused_window: Some("0x100".to_string()),
            window_state_by_hwnd: std::iter::once((
                "0x100".to_string(),
                WindowNoiseState {
                    last_attention_at: Some(
                        now - ACTIVE_WINDOW_REPEAT_COOLDOWN - WINDOW_STATE_RETENTION,
                    ),
                    visible: Some(true),
                    last_visibility_at: Some(
                        now - WINDOW_STATE_RETENTION - std::time::Duration::from_secs(1),
                    ),
                },
            ))
            .collect(),
            clipboard_sequence: 0,
            html_format: 0,
        };

        prune_window_noise_state(&mut state, now);
        assert!(state.window_state_by_hwnd.is_empty());
        assert!(state.last_focused_window.is_none());
    }

    #[test]
    fn normalize_process_name_accepts_paths_and_plain_names() {
        assert_eq!(
            normalize_process_name(r"C:\Program Files\Demo\QtApp.exe").as_deref(),
            Some("qtapp.exe")
        );
        assert_eq!(
            normalize_process_name("/Applications/Demo/QtApp.exe").as_deref(),
            Some("qtapp.exe")
        );
        assert_eq!(normalize_process_name("  ").as_deref(), None);
    }

    #[test]
    fn process_names_match_ignores_path_and_case() {
        assert!(process_names_match(r"C:\Apps\CC3.exe", "cc3.exe"));
        assert!(!process_names_match("notepad.exe", "explorer.exe"));
    }
}
