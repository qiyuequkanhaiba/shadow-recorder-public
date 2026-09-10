use std::ptr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::Sender;
use once_cell::sync::Lazy;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, HC_ACTION, HHOOK, MSG, MSLLHOOKSTRUCT, MWMO_INPUTAVAILABLE,
    MsgWaitForMultipleObjectsEx, PM_REMOVE, PeekMessageW, QS_ALLINPUT, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, WH_MOUSE_LL, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN,
    WM_MBUTTONDOWN, WM_MOUSEWHEEL, WM_RBUTTONDOWN,
};
use windows::core::PCWSTR;

use crate::error::RecorderError;
use crate::telemetry::{inc_capture_queue_drop, inc_input_channel_full_drop};
use crate::types::StepData;

const INPUT_DOUBLE_CLICK_ACTION: &str = "WM_LBUTTONDBLCLK";
const INPUT_WHEEL_ACTION: &str = "WM_MOUSEWHEEL";

#[derive(Debug, Clone)]
pub struct MouseEvent {
    pub x: i32,
    pub y: i32,
    pub timestamp_ms: u64,
    pub action: String,
}

#[derive(Debug, Default)]
struct HookState {
    sender: Option<Sender<MouseEvent>>,
    last_click: Option<(POINT, Instant)>,
    debounce_ms: u64,
}

static HOOK_STATE: Lazy<Mutex<HookState>> = Lazy::new(|| {
    Mutex::new(HookState {
        sender: None,
        last_click: None,
        debounce_ms: crate::config::DEFAULT_DEBOUNCE_MS,
    })
});
static HOOK_HANDLE: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(ptr::null_mut());

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let wm = wparam.0 as u32;
    let action = match wm {
        WM_LBUTTONDOWN => Some("WM_LBUTTONDOWN"),
        WM_RBUTTONDOWN => Some("WM_RBUTTONDOWN"),
        WM_LBUTTONDBLCLK => Some("WM_LBUTTONDBLCLK"),
        WM_MOUSEWHEEL => Some("WM_MOUSEWHEEL"),
        WM_MBUTTONDOWN => Some("WM_MBUTTONDOWN"),
        _ => None,
    };

    if code == HC_ACTION as i32
        && let Some(action_str) = action
    {
        let mut should_emit = true;
        let mut point = POINT { x: 0, y: 0 };

        if lparam.0 != 0 {
            let hook = unsafe { *(lparam.0 as *const MSLLHOOKSTRUCT) };
            point = hook.pt;
        }

        if let Ok(mut state) = HOOK_STATE.lock() {
            if let Some((last_pt, last_ts)) = state.last_click {
                let elapsed = last_ts.elapsed();
                let same_area =
                    (last_pt.x - point.x).abs() <= 2 && (last_pt.y - point.y).abs() <= 2;
                let should_bypass_debounce =
                    action_str == INPUT_DOUBLE_CLICK_ACTION || action_str == INPUT_WHEEL_ACTION;
                if !should_bypass_debounce
                    && same_area
                    && elapsed < Duration::from_millis(state.debounce_ms)
                {
                    should_emit = false;
                }
            }

            state.last_click = Some((point, Instant::now()));

            if should_emit
                && let Some(sender) = &state.sender
                && sender
                    .try_send(MouseEvent {
                        x: point.x,
                        y: point.y,
                        timestamp_ms: StepData::now_timestamp_ms(),
                        action: action_str.to_string(),
                    })
                    .is_err()
            {
                inc_input_channel_full_drop();
                inc_capture_queue_drop();
            }
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

pub fn install_hook(sender: Sender<MouseEvent>, debounce_ms: u64) -> Result<(), RecorderError> {
    if let Ok(mut state) = HOOK_STATE.lock() {
        state.sender = Some(sender);
        state.debounce_ms = debounce_ms;
        state.last_click = None;
    }

    if !HOOK_HANDLE.load(Ordering::SeqCst).is_null() {
        return Ok(());
    }

    let module = unsafe { GetModuleHandleW(PCWSTR::null()) }.map_err(|err| {
        RecorderError::WindowApiFailed(format!("GetModuleHandleW failed: {err:?}"))
    })?;

    let hook = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), HINSTANCE(module.0), 0) }
        .map_err(|err| RecorderError::HookInstallFailed(format!("{err:?}")))?;

    HOOK_HANDLE.store(hook.0, Ordering::SeqCst);
    Ok(())
}

pub fn uninstall_hook() {
    let raw = HOOK_HANDLE.swap(ptr::null_mut(), Ordering::SeqCst);
    if !raw.is_null() {
        unsafe {
            let _ = UnhookWindowsHookEx(HHOOK(raw));
        }
    }

    if let Ok(mut state) = HOOK_STATE.lock() {
        state.sender = None;
        state.last_click = None;
    }
}

pub fn update_debounce_ms(debounce_ms: u64) {
    if let Ok(mut state) = HOOK_STATE.lock() {
        state.debounce_ms = debounce_ms;
    }
}

pub fn run_message_loop(stop: &AtomicBool) {
    let mut msg = MSG::default();

    while !stop.load(Ordering::SeqCst) {
        unsafe {
            let _ = MsgWaitForMultipleObjectsEx(None, 40, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
        }

        if unsafe { PeekMessageW(&mut msg, HWND(std::ptr::null_mut()), 0, 0, PM_REMOVE).as_bool() }
        {
            loop {
                unsafe {
                    let _ = TranslateMessage(&msg);
                    windows::Win32::UI::WindowsAndMessaging::DispatchMessageW(&msg);
                }
                let next = unsafe {
                    PeekMessageW(&mut msg, HWND(std::ptr::null_mut()), 0, 0, PM_REMOVE).as_bool()
                };
                if !next {
                    break;
                }
            }
        }
    }
}

pub fn reset_stop_flag(flag: &AtomicBool) {
    flag.store(false, Ordering::SeqCst);
}

pub fn run_hook_thread(
    stop: std::sync::Arc<AtomicBool>,
    sender: Sender<MouseEvent>,
    debounce_ms: u64,
) -> Result<JoinHandle<()>, RecorderError> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), RecorderError>>();

    let handle = std::thread::Builder::new()
        .name("shadow-recorder-hook".to_string())
        .spawn(move || match install_hook(sender, debounce_ms) {
            Ok(()) => {
                let _ = ready_tx.send(Ok(()));
                run_message_loop(&stop);
            }
            Err(err) => {
                let _ = ready_tx.send(Err(err));
            }
        })
        .map_err(|_| RecorderError::ThreadStartFailed)?;

    match ready_rx.recv() {
        Ok(Ok(())) => Ok(handle),
        Ok(Err(err)) => {
            let _ = handle.join();
            Err(err)
        }
        Err(_) => {
            let _ = handle.join();
            Err(RecorderError::HookInstallFailed(
                "hook init channel closed".to_string(),
            ))
        }
    }
}
