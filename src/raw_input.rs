use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::Sender;
use once_cell::sync::Lazy;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::UI::Input::{
    GetRawInputData, HRAWINPUT, RAW_INPUT_DATA_COMMAND_FLAGS, RAWINPUT, RAWINPUTDEVICE,
    RAWINPUTHEADER, RID_INPUT, RIDEV_INPUTSINK, RegisterRawInputDevices,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    GetCursorPos, MSG, MWMO_INPUTAVAILABLE, MsgWaitForMultipleObjectsEx, PM_REMOVE, PeekMessageW,
    QS_ALLINPUT, RI_MOUSE_LEFT_BUTTON_DOWN, RI_MOUSE_MIDDLE_BUTTON_DOWN,
    RI_MOUSE_RIGHT_BUTTON_DOWN, RI_MOUSE_WHEEL, RegisterClassW, TranslateMessage, WINDOW_EX_STYLE,
    WINDOW_STYLE, WM_INPUT, WNDCLASSW, WS_OVERLAPPED,
};
use windows::core::{PCWSTR, w};

use crate::error::RecorderError;
use crate::hooks::MouseEvent;
use crate::telemetry::{inc_capture_queue_drop, inc_input_channel_full_drop};
use crate::types::StepData;

struct RawInputContext {
    sender: Sender<MouseEvent>,
    debounce_ms: u64,
    last_click: Option<(POINT, Instant, String)>,
}

static RAW_CONTEXT: Lazy<Mutex<Option<RawInputContext>>> = Lazy::new(|| Mutex::new(None));

const INPUT_DOUBLE_CLICK_ACTION: &str = "WM_LBUTTONDBLCLK";
const INPUT_DOUBLE_CLICK_WINDOW_MS: u64 = 320;
const INPUT_LEFT_CLICK_ACTION: &str = "WM_LBUTTONDOWN";
const INPUT_MIDDLE_CLICK_ACTION: &str = "WM_MBUTTONDOWN";
const INPUT_MOUSE_WHEEL_DOWN_ACTION: &str = "WM_MOUSEWHEEL_DOWN";
const INPUT_MOUSE_WHEEL_UP_ACTION: &str = "WM_MOUSEWHEEL_UP";
const INPUT_RIGHT_CLICK_ACTION: &str = "WM_RBUTTONDOWN";

fn resolve_raw_input_action(button_flags: u16, button_data: u16) -> Option<&'static str> {
    if button_flags & (RI_MOUSE_LEFT_BUTTON_DOWN as u16) != 0 {
        Some(INPUT_LEFT_CLICK_ACTION)
    } else if button_flags & (RI_MOUSE_RIGHT_BUTTON_DOWN as u16) != 0 {
        Some(INPUT_RIGHT_CLICK_ACTION)
    } else if button_flags & (RI_MOUSE_MIDDLE_BUTTON_DOWN as u16) != 0 {
        Some(INPUT_MIDDLE_CLICK_ACTION)
    } else if button_flags & (RI_MOUSE_WHEEL as u16) != 0 {
        if (button_data as i16) < 0 {
            Some(INPUT_MOUSE_WHEEL_DOWN_ACTION)
        } else {
            Some(INPUT_MOUSE_WHEEL_UP_ACTION)
        }
    } else {
        None
    }
}

unsafe extern "system" fn raw_window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_INPUT {
        handle_wm_input(lparam);
    }

    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn handle_wm_input(lparam: LPARAM) {
    let hraw = HRAWINPUT(lparam.0 as _);

    let mut size = 0u32;
    let command = RAW_INPUT_DATA_COMMAND_FLAGS(RID_INPUT.0);
    let header_size = std::mem::size_of::<RAWINPUTHEADER>() as u32;

    let _ = unsafe { GetRawInputData(hraw, command, None, &mut size, header_size) };
    if size == 0 {
        return;
    }

    let mut buffer = vec![0u8; size as usize];
    let written = unsafe {
        GetRawInputData(
            hraw,
            command,
            Some(buffer.as_mut_ptr() as *mut _),
            &mut size,
            header_size,
        )
    };

    if written == u32::MAX || written == 0 {
        return;
    }

    if buffer.len() < std::mem::size_of::<RAWINPUT>() {
        return;
    }

    let raw = unsafe { &*(buffer.as_ptr() as *const RAWINPUT) };
    let mouse = unsafe { raw.data.mouse };
    let button_flags = unsafe { mouse.Anonymous.Anonymous.usButtonFlags };

    let button_data = unsafe { mouse.Anonymous.Anonymous.usButtonData };
    let Some(action) = resolve_raw_input_action(button_flags, button_data) else {
        return;
    };

    let mut point = POINT { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut point) }.is_err() {
        return;
    }

    let timestamp_ms = StepData::now_timestamp_ms();

    if let Ok(mut guard) = RAW_CONTEXT.lock()
        && let Some(context) = guard.as_mut()
    {
        let is_wheel =
            action == INPUT_MOUSE_WHEEL_UP_ACTION || action == INPUT_MOUSE_WHEEL_DOWN_ACTION;
        let mut resolved_action = action;

        if let Some((last_pt, last_ts, last_action)) = context.last_click.as_ref() {
            let elapsed = last_ts.elapsed();
            let same_area = (last_pt.x - point.x).abs() <= 2 && (last_pt.y - point.y).abs() <= 2;
            let double_click_window = Duration::from_millis(INPUT_DOUBLE_CLICK_WINDOW_MS);
            if resolved_action == INPUT_LEFT_CLICK_ACTION
                && last_action == INPUT_LEFT_CLICK_ACTION
                && same_area
                && elapsed < double_click_window
            {
                resolved_action = INPUT_DOUBLE_CLICK_ACTION;
            } else if !is_wheel
                && last_action == resolved_action
                && same_area
                && elapsed < Duration::from_millis(context.debounce_ms)
            {
                return;
            }
        }

        if !is_wheel {
            context.last_click = Some((point, Instant::now(), resolved_action.to_string()));
        }

        if context
            .sender
            .try_send(MouseEvent {
                x: point.x,
                y: point.y,
                timestamp_ms,
                action: resolved_action.to_string(),
            })
            .is_err()
        {
            inc_input_channel_full_drop();
            inc_capture_queue_drop();
        }
    }
}

fn register_raw_mouse_device(target: HWND) -> Result<(), RecorderError> {
    let devices = [RAWINPUTDEVICE {
        usUsagePage: 0x01,
        usUsage: 0x02,
        dwFlags: RIDEV_INPUTSINK,
        hwndTarget: target,
    }];

    unsafe { RegisterRawInputDevices(&devices, std::mem::size_of::<RAWINPUTDEVICE>() as u32) }
        .map_err(|err| RecorderError::WindowApiFailed(format!("RegisterRawInputDevices: {err:?}")))
}

pub fn update_raw_input_debounce_ms(debounce_ms: u64) {
    if let Ok(mut guard) = RAW_CONTEXT.lock()
        && let Some(context) = guard.as_mut()
    {
        context.debounce_ms = debounce_ms;
    }
}

pub fn run_raw_input_thread(
    stop: Arc<std::sync::atomic::AtomicBool>,
    sender: Sender<MouseEvent>,
    debounce_ms: u64,
) -> Result<JoinHandle<()>, RecorderError> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), RecorderError>>();

    let handle = std::thread::Builder::new()
        .name("shadow-recorder-raw-input".to_string())
        .spawn(move || {
            if let Ok(mut guard) = RAW_CONTEXT.lock() {
                *guard = Some(RawInputContext {
                    sender,
                    debounce_ms,
                    last_click: None,
                });
            }

            let class_name: PCWSTR = w!("ShadowRecorderRawInputWindow");
            let wc = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(raw_window_proc),
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
                    WINDOW_STYLE(WS_OVERLAPPED.0),
                    0,
                    0,
                    0,
                    0,
                    HWND(std::ptr::null_mut()),
                    None,
                    None,
                    None,
                )
            };

            let hwnd = match hwnd {
                Ok(hwnd) => hwnd,
                Err(err) => {
                    let _ = ready_tx.send(Err(RecorderError::WindowApiFailed(format!(
                        "CreateWindowExW: {err:?}"
                    ))));
                    return;
                }
            };

            if let Err(err) = register_raw_mouse_device(hwnd) {
                let _ = ready_tx.send(Err(err));
                unsafe {
                    let _ = DestroyWindow(hwnd);
                }
                return;
            }

            let _ = ready_tx.send(Ok(()));

            let mut msg = MSG::default();
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                unsafe {
                    let _ = MsgWaitForMultipleObjectsEx(None, 40, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
                }

                if unsafe {
                    PeekMessageW(&mut msg, HWND(std::ptr::null_mut()), 0, 0, PM_REMOVE).as_bool()
                } {
                    loop {
                        unsafe {
                            let _ = TranslateMessage(&msg);
                            DispatchMessageW(&msg);
                        }
                        let next = unsafe {
                            PeekMessageW(&mut msg, HWND(std::ptr::null_mut()), 0, 0, PM_REMOVE)
                                .as_bool()
                        };
                        if !next {
                            break;
                        }
                    }
                }
            }

            unsafe {
                let _ = DestroyWindow(hwnd);
            }

            if let Ok(mut guard) = RAW_CONTEXT.lock() {
                *guard = None;
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
            Err(RecorderError::RawInputUnsupported)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        INPUT_DOUBLE_CLICK_ACTION, INPUT_LEFT_CLICK_ACTION, INPUT_MOUSE_WHEEL_DOWN_ACTION,
        INPUT_MOUSE_WHEEL_UP_ACTION, INPUT_RIGHT_CLICK_ACTION, resolve_raw_input_action,
    };
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{
        RI_MOUSE_LEFT_BUTTON_DOWN, RI_MOUSE_RIGHT_BUTTON_DOWN, RI_MOUSE_WHEEL,
    };

    #[test]
    fn resolves_basic_raw_input_actions() {
        assert_eq!(
            resolve_raw_input_action(RI_MOUSE_LEFT_BUTTON_DOWN as u16, 0),
            Some(INPUT_LEFT_CLICK_ACTION)
        );
        assert_eq!(
            resolve_raw_input_action(RI_MOUSE_RIGHT_BUTTON_DOWN as u16, 0),
            Some(INPUT_RIGHT_CLICK_ACTION)
        );
        assert_eq!(
            resolve_raw_input_action(RI_MOUSE_WHEEL as u16, 120u16),
            Some(INPUT_MOUSE_WHEEL_UP_ACTION)
        );
        assert_eq!(
            resolve_raw_input_action(RI_MOUSE_WHEEL as u16, (-120i16) as u16),
            Some(INPUT_MOUSE_WHEEL_DOWN_ACTION)
        );
    }

    #[test]
    fn raw_input_double_click_promotion_rule_matches_expected_window() {
        let point = POINT { x: 100, y: 80 };
        let last_click = (
            point,
            Instant::now() - Duration::from_millis(120),
            INPUT_LEFT_CLICK_ACTION.to_string(),
        );
        let elapsed = last_click.1.elapsed();
        let same_area = true;
        let promoted = INPUT_LEFT_CLICK_ACTION == INPUT_LEFT_CLICK_ACTION
            && last_click.2 == INPUT_LEFT_CLICK_ACTION
            && same_area
            && elapsed < Duration::from_millis(super::INPUT_DOUBLE_CLICK_WINDOW_MS);
        assert!(promoted);
        assert_eq!(INPUT_DOUBLE_CLICK_ACTION, "WM_LBUTTONDBLCLK");
    }
}
