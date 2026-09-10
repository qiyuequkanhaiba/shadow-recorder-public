//! Keyboard summary capture for Phase B.
//! Named keys/shortcuts always recorded. Typed text is taken from UIA ValuePattern
//! after a typing burst when semantic plaintext capture is enabled (not keylogging).

#![cfg_attr(test, allow(dead_code))]

use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_ESCAPE, VK_LEFT,
    VK_LWIN, VK_MENU, VK_RETURN, VK_RIGHT, VK_RWIN, VK_SHIFT, VK_SPACE, VK_TAB, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, HC_ACTION, HHOOK, KBDLLHOOKSTRUCT, MSG, MWMO_INPUTAVAILABLE,
    MsgWaitForMultipleObjectsEx, PM_REMOVE, PeekMessageW, QS_ALLINPUT, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
};
use windows::core::PCWSTR;

use crate::session::TestSessionSystemEventInput;
use crate::session::manager::TEST_SESSION_MANAGER;
use crate::session::models::TestSessionEventType;
use crate::session::uia_enricher;
use crate::types::StepData;

const FLUSH_IDLE: Duration = Duration::from_millis(900);
const FLUSH_MAX_CHARS: u32 = 24;
const POLL_INTERVAL_MS: u32 = 40;

#[derive(Debug)]
pub enum KeyboardSummaryError {
    ThreadStartFailed,
    HookInstall(String),
}

impl std::fmt::Display for KeyboardSummaryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ThreadStartFailed => write!(f, "keyboard summary thread failed to start"),
            Self::HookInstall(message) => write!(f, "keyboard hook install failed: {message}"),
        }
    }
}

impl std::error::Error for KeyboardSummaryError {}

#[derive(Default)]
pub struct KeyboardSummaryRuntime {
    stop: Option<Arc<AtomicBool>>,
    handle: Option<JoinHandle<()>>,
}

impl KeyboardSummaryRuntime {
    pub fn ensure_started(&mut self) -> Result<(), KeyboardSummaryError> {
        if self.handle.is_some() {
            return Ok(());
        }

        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), KeyboardSummaryError>>();
        let thread_stop = Arc::clone(&stop);
        let handle = std::thread::Builder::new()
            .name("shadow-keyboard-summary".to_string())
            .spawn(move || match install_keyboard_hook() {
                Ok(()) => {
                    let _ = ready_tx.send(Ok(()));
                    run_keyboard_loop(&thread_stop);
                    uninstall_keyboard_hook();
                }
                Err(err) => {
                    let _ = ready_tx.send(Err(err));
                }
            })
            .map_err(|_| KeyboardSummaryError::ThreadStartFailed)?;

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
                Err(KeyboardSummaryError::ThreadStartFailed)
            }
        }
    }

    pub fn stop(&mut self) {
        flush_pending(true);
        if let Some(stop) = self.stop.take() {
            stop.store(true, Ordering::SeqCst);
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        uninstall_keyboard_hook();
    }
}

#[derive(Debug, Default)]
struct PendingSummary {
    char_count: u32,
    has_password_focus: bool,
    control_name: Option<String>,
    control_type: Option<String>,
    automation_id: Option<String>,
    class_name: Option<String>,
    window_title: Option<String>,
    process_name: Option<String>,
    /// Final control value from UIA (not keystroke stream).
    value_text: Option<String>,
    selected_names: Option<Vec<String>>,
    started_at: Option<Instant>,
    last_at: Option<Instant>,
}

static HOOK_HANDLE: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(ptr::null_mut());
static PENDING: Lazy<Mutex<PendingSummary>> = Lazy::new(|| Mutex::new(PendingSummary::default()));

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let msg = wparam.0 as u32;
        if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
            let info = if lparam.0 != 0 {
                unsafe { *(lparam.0 as *const KBDLLHOOKSTRUCT) }
            } else {
                KBDLLHOOKSTRUCT::default()
            };
            handle_key_down(info.vkCode);
        }
    }

    unsafe {
        CallNextHookEx(
            HHOOK(HOOK_HANDLE.load(Ordering::SeqCst)),
            code,
            wparam,
            lparam,
        )
    }
}

fn install_keyboard_hook() -> Result<(), KeyboardSummaryError> {
    if !HOOK_HANDLE.load(Ordering::SeqCst).is_null() {
        return Ok(());
    }

    let module = unsafe { GetModuleHandleW(PCWSTR::null()) }.map_err(|err| {
        KeyboardSummaryError::HookInstall(format!("GetModuleHandleW failed: {err:?}"))
    })?;

    let hook =
        unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), HINSTANCE(module.0), 0) }
            .map_err(|err| KeyboardSummaryError::HookInstall(format!("{err:?}")))?;

    HOOK_HANDLE.store(hook.0, Ordering::SeqCst);
    Ok(())
}

fn uninstall_keyboard_hook() {
    let raw = HOOK_HANDLE.swap(ptr::null_mut(), Ordering::SeqCst);
    if !raw.is_null() {
        unsafe {
            let _ = UnhookWindowsHookEx(HHOOK(raw));
        }
    }
}

fn run_keyboard_loop(stop: &AtomicBool) {
    let mut msg = MSG::default();
    while !stop.load(Ordering::SeqCst) {
        flush_if_idle();
        unsafe {
            let _ = MsgWaitForMultipleObjectsEx(
                None,
                POLL_INTERVAL_MS,
                QS_ALLINPUT,
                MWMO_INPUTAVAILABLE,
            );
        }
        while unsafe {
            PeekMessageW(&mut msg, HWND(std::ptr::null_mut()), 0, 0, PM_REMOVE).as_bool()
        } {
            unsafe {
                let _ = TranslateMessage(&msg);
                windows::Win32::UI::WindowsAndMessaging::DispatchMessageW(&msg);
            }
        }
    }
    flush_pending(true);
}

fn handle_key_down(vk_code: u32) {
    let vk = VIRTUAL_KEY(vk_code as u16);
    let ctrl = is_down(VK_CONTROL);
    let alt = is_down(VK_MENU);
    let shift = is_down(VK_SHIFT);
    let win = is_down(VK_LWIN) || is_down(VK_RWIN);

    if let Some(name) = named_key(vk) {
        // Special keys flush typing buffer first, then emit their own event.
        flush_pending(false);
        if ctrl || alt || win {
            emit_shortcut(build_shortcut_label(ctrl, alt, shift, win, name));
        } else {
            emit_named_key(name);
        }
        return;
    }

    if ctrl || alt || win {
        if let Some(ch) = printable_key_token(vk, shift) {
            flush_pending(false);
            emit_shortcut(build_shortcut_label(ctrl, alt, shift, win, &ch));
        }
        return;
    }

    // Plain character: count only in the hook; content is read from UIA on flush.
    if is_text_like_key(vk) {
        note_char_input();
    }
}

fn note_char_input() {
    let now = Instant::now();
    if let Ok(mut pending) = PENDING.lock() {
        if pending.char_count == 0 {
            pending.started_at = Some(now);
            // Best-effort focus snapshot once per burst (may be empty).
            if let Some(snapshot) = uia_enricher::capture_focused() {
                pending.has_password_focus = snapshot.is_password;
                pending.control_name = snapshot.control_name;
                pending.control_type = snapshot.control_type;
                pending.automation_id = snapshot.automation_id;
                pending.class_name = snapshot.class_name;
                pending.value_text = snapshot.value_text;
                pending.selected_names = snapshot.selected_names;
            }
            if let Some((process, title)) = foreground_window_context() {
                pending.process_name = process;
                pending.window_title = title;
            }
        }
        pending.char_count = pending.char_count.saturating_add(1);
        pending.last_at = Some(now);
        if pending.char_count >= FLUSH_MAX_CHARS {
            drop(pending);
            flush_pending(false);
        }
    }
}

fn flush_if_idle() {
    let should_flush = PENDING
        .lock()
        .ok()
        .and_then(|pending| {
            if pending.char_count == 0 {
                return Some(false);
            }
            pending.last_at.map(|last| last.elapsed() >= FLUSH_IDLE)
        })
        .unwrap_or(false);
    if should_flush {
        flush_pending(false);
    }
}

fn flush_pending(force: bool) {
    let snapshot = {
        let Ok(mut pending) = PENDING.lock() else {
            return;
        };
        if pending.char_count == 0 {
            return;
        }
        if !force
            && pending
                .last_at
                .map(|last| last.elapsed() < FLUSH_IDLE)
                .unwrap_or(true)
            && pending.char_count < FLUSH_MAX_CHARS
        {
            return;
        }
        std::mem::take(&mut *pending)
    };

    let char_count = snapshot.char_count;
    if char_count == 0 {
        return;
    }

    let process_name = snapshot.process_name;
    let window_title = snapshot.window_title;

    // Re-read focused control at flush so ValuePattern reflects the typed result
    // (not individual keystrokes). Password never stores value text.
    let mut value_text = snapshot.value_text;
    let mut selected_names = snapshot.selected_names;
    let mut control_name = snapshot.control_name;
    let mut control_type = snapshot.control_type;
    let mut automation_id = snapshot.automation_id;
    let mut class_name = snapshot.class_name;
    let mut has_password = snapshot.has_password_focus;
    if let Some(fresh) = uia_enricher::capture_focused() {
        has_password = fresh.is_password || has_password;
        if control_name.is_none() {
            control_name = fresh.control_name;
        }
        if control_type.is_none() {
            control_type = fresh.control_type;
        }
        if automation_id.is_none() {
            automation_id = fresh.automation_id;
        }
        if class_name.is_none() {
            class_name = fresh.class_name;
        }
        if !has_password {
            if fresh.value_text.is_some() {
                value_text = fresh.value_text;
            }
            if fresh.selected_names.is_some() {
                selected_names = fresh.selected_names;
            }
        } else {
            value_text = None;
            selected_names = None;
        }
    }
    if has_password {
        value_text = None;
        selected_names = None;
    }

    let content_label = value_text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .or_else(|| {
            selected_names.as_ref().and_then(|names| {
                let joined = names
                    .iter()
                    .map(String::as_str)
                    .filter(|name| !name.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join("、");
                if joined.is_empty() {
                    None
                } else {
                    Some(joined)
                }
            })
        });

    let message = if has_password {
        format!("在密码框输入 {char_count} 个字符")
    } else if let Some(ref content) = content_label {
        if let Some(control) = control_name.as_deref() {
            format!("在「{control}」输入「{content}」")
        } else {
            format!("输入「{content}」")
        }
    } else if let Some(control) = control_name.as_deref() {
        format!("在「{control}」输入 {char_count} 个字符")
    } else {
        format!("输入 {char_count} 个字符")
    };

    let title = if content_label.is_some() {
        "键盘输入".to_string()
    } else {
        "键盘输入摘要".to_string()
    };

    let precision_probe = PendingSummary {
        has_password_focus: has_password,
        control_name: control_name.clone(),
        control_type: control_type.clone(),
        automation_id: automation_id.clone(),
        window_title: window_title.clone(),
        ..PendingSummary::default()
    };
    let precision_level = typing_precision_level(&precision_probe);

    let _ = TEST_SESSION_MANAGER.append_system_event(TestSessionSystemEventInput {
        event_type: TestSessionEventType::KeyboardSummary,
        occurred_at_ms: StepData::now_timestamp_ms(),
        title: Some(title),
        message: Some(message),
        process_name,
        window_title,
        window_hwnd: None,
        window_pid: None,
        system_source: Some("keyboard".to_string()),
        clipboard_content_type: None,
        action: Some("type".to_string()),
        control_name,
        control_type,
        automation_id,
        class_name,
        precision_level: Some(precision_level.to_string()),
        char_count: Some(char_count),
        is_password: Some(has_password),
        shortcut: None,
    });
}

fn has_keyboard_target(snapshot: &PendingSummary) -> bool {
    snapshot.has_password_focus
        || snapshot.control_name.is_some()
        || snapshot.automation_id.is_some()
        || snapshot.control_type.is_some()
}

fn typing_precision_level(snapshot: &PendingSummary) -> &'static str {
    if has_keyboard_target(snapshot) {
        "l3"
    } else if snapshot.window_title.is_some() {
        "l1"
    } else {
        "l0"
    }
}

fn emit_named_key(name: &str) {
    let (process, title) = foreground_window_context().unwrap_or((None, None));
    let _ = TEST_SESSION_MANAGER.append_system_event(TestSessionSystemEventInput {
        event_type: TestSessionEventType::KeyboardSummary,
        occurred_at_ms: StepData::now_timestamp_ms(),
        title: Some(format!("按键 {name}")),
        message: Some(format!("按下 {name}")),
        process_name: process,
        window_title: title,
        window_hwnd: None,
        window_pid: None,
        system_source: Some("keyboard".to_string()),
        clipboard_content_type: None,
        action: Some("key".to_string()),
        control_name: None,
        control_type: None,
        automation_id: None,
        class_name: None,
        precision_level: Some("l1".to_string()),
        char_count: None,
        is_password: None,
        shortcut: Some(name.to_string()),
    });
}

fn emit_shortcut(label: String) {
    let (process, title) = foreground_window_context().unwrap_or((None, None));
    let _ = TEST_SESSION_MANAGER.append_system_event(TestSessionSystemEventInput {
        event_type: TestSessionEventType::KeyboardSummary,
        occurred_at_ms: StepData::now_timestamp_ms(),
        title: Some(format!("快捷键 {label}")),
        message: Some(format!("使用快捷键 {label}")),
        process_name: process,
        window_title: title,
        window_hwnd: None,
        window_pid: None,
        system_source: Some("keyboard".to_string()),
        clipboard_content_type: None,
        action: Some("shortcut".to_string()),
        control_name: None,
        control_type: None,
        automation_id: None,
        class_name: None,
        precision_level: Some("l2".to_string()),
        char_count: None,
        is_password: None,
        shortcut: Some(label),
    });
}

fn build_shortcut_label(ctrl: bool, alt: bool, shift: bool, win: bool, key: &str) -> String {
    let mut parts = Vec::new();
    if ctrl {
        parts.push("Ctrl");
    }
    if alt {
        parts.push("Alt");
    }
    if shift {
        parts.push("Shift");
    }
    if win {
        parts.push("Win");
    }
    parts.push(key);
    parts.join("+")
}

fn named_key(vk: VIRTUAL_KEY) -> Option<&'static str> {
    match vk {
        VK_RETURN => Some("Enter"),
        VK_TAB => Some("Tab"),
        VK_ESCAPE => Some("Esc"),
        VK_BACK => Some("Backspace"),
        VK_DELETE => Some("Delete"),
        VK_LEFT => Some("Left"),
        VK_RIGHT => Some("Right"),
        VK_UP => Some("Up"),
        VK_DOWN => Some("Down"),
        VK_SPACE => Some("Space"),
        _ => None,
    }
}

fn printable_key_token(vk: VIRTUAL_KEY, shift: bool) -> Option<String> {
    let code = vk.0 as u32;
    match code {
        0x30..=0x39 => Some(((b'0' + (code - 0x30) as u8) as char).to_string()),
        0x41..=0x5A => {
            let ch = (b'A' + (code - 0x41) as u8) as char;
            Some(if shift {
                ch.to_string()
            } else {
                ch.to_ascii_lowercase().to_string()
            })
        }
        0x70..=0x7B => Some(format!("F{}", code - 0x6F)),
        _ => None,
    }
}

fn is_text_like_key(vk: VIRTUAL_KEY) -> bool {
    let code = vk.0 as u32;
    (0x30..=0x39).contains(&code)
        || (0x41..=0x5A).contains(&code)
        || (0x60..=0x69).contains(&code) // numpad
        || (0xBA..=0xC0).contains(&code)
        || (0xDB..=0xDE).contains(&code)
        || code == VK_SPACE.0 as u32
}

fn is_down(vk: VIRTUAL_KEY) -> bool {
    unsafe { GetAsyncKeyState(vk.0 as i32) as u16 & 0x8000 != 0 }
}

fn foreground_window_context() -> Option<(Option<String>, Option<String>)> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let title_len = GetWindowTextLengthW(hwnd);
        let mut title = None;
        if title_len > 0 {
            let mut buf = vec![0u16; title_len as usize + 1];
            let copied = GetWindowTextW(hwnd, &mut buf);
            if copied > 0 {
                title = Some(String::from_utf16_lossy(&buf[..copied as usize]));
            }
        }
        let mut process_name = None;
        if pid != 0
            && let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
        {
            let mut buf = [0u16; 260];
            let mut size = buf.len() as u32;
            if QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut size,
            )
            .is_ok()
            {
                let full = String::from_utf16_lossy(&buf[..size as usize]);
                process_name = std::path::Path::new(&full)
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string());
            }
            let _ = CloseHandle(handle);
        }
        Some((process_name, title))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_label_orders_modifiers() {
        assert_eq!(
            build_shortcut_label(true, false, true, false, "S"),
            "Ctrl+Shift+S"
        );
    }

    #[test]
    fn named_keys_cover_navigation() {
        assert_eq!(named_key(VK_RETURN), Some("Enter"));
        assert_eq!(named_key(VK_TAB), Some("Tab"));
        assert_eq!(named_key(VK_ESCAPE), Some("Esc"));
    }

    #[test]
    fn typing_precision_uses_focused_control_identity() {
        assert_eq!(
            typing_precision_level(&PendingSummary {
                control_name: Some("客户名称".to_string()),
                window_title: Some("订单管理".to_string()),
                ..PendingSummary::default()
            }),
            "l3"
        );
        assert_eq!(
            typing_precision_level(&PendingSummary {
                has_password_focus: true,
                window_title: Some("登录".to_string()),
                ..PendingSummary::default()
            }),
            "l3"
        );
        assert_eq!(
            typing_precision_level(&PendingSummary {
                window_title: Some("订单管理".to_string()),
                ..PendingSummary::default()
            }),
            "l1"
        );
    }
}
