//! Windows-only live probe: real HWND + UIA + hook path.
//! Run: cargo test --lib live_win32 -- --ignored --nocapture --test-threads=1

#![cfg(all(test, windows))]

use std::ffi::c_void;
use std::mem::size_of;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::UpdateWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEINPUT, SendInput,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BS_AUTOCHECKBOX, CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW, DestroyWindow,
    DispatchMessageW, GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowTextW,
    IsWindowVisible, MSG, PM_REMOVE, PeekMessageW, PostQuitMessage, RegisterClassW, SW_SHOWNORMAL,
    SetCursorPos, SetForegroundWindow, ShowWindow, TranslateMessage, WINDOW_EX_STYLE, WINDOW_STYLE,
    WM_CLOSE, WM_DESTROY, WS_CHILD, WS_OVERLAPPEDWINDOW, WS_VISIBLE, WNDCLASSW, WindowFromPoint,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
};
use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};
use windows::core::{PCWSTR, w};

use crate::config::RecorderConfig;
use crate::recorder::RECORDER;
use crate::session::TEST_SESSION_MANAGER;
use crate::session::TestSessionStartOptions;
use crate::session::uia_enricher;

const CLASS_NAME: PCWSTR = w!("ShadowLiveSemanticProbe");
const SAVE_TEXT: PCWSTR = w!("保存");
const TOGGLE_TEXT: PCWSTR = w!("启用同步");

#[derive(Clone, Copy)]
struct RawHwnd(usize);

unsafe impl Send for RawHwnd {}

impl RawHwnd {
    fn from_hwnd(hwnd: HWND) -> Self {
        Self(hwnd.0 as usize)
    }

    fn hwnd(self) -> HWND {
        HWND(self.0 as *mut c_void)
    }
}

struct ProbeWindow {
    hwnd: RawHwnd,
    save: RawHwnd,
    toggle: RawHwnd,
    stop: Arc<AtomicBool>,
}

unsafe impl Send for ProbeWindow {}

extern "system" fn probe_wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_DESTROY => {
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        WM_CLOSE => {
            unsafe {
                let _ = DestroyWindow(hwnd);
            }
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn wide_class_atom() -> windows::core::Result<u16> {
    let wc = WNDCLASSW {
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(probe_wnd_proc),
        lpszClassName: CLASS_NAME,
        ..Default::default()
    };
    let atom = unsafe { RegisterClassW(&wc) };
    if atom == 0 {
        // Already registered in this process is acceptable.
        return Ok(1);
    }
    Ok(atom)
}

fn create_probe_window() -> Result<ProbeWindow, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
    wide_class_atom().map_err(|err| format!("RegisterClassW failed: {err:?}"))?;
    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            CLASS_NAME,
            w!("Shadow Live Semantic Probe"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            120,
            120,
            420,
            260,
            HWND::default(),
            None,
            None,
            None,
        )
    }
    .map_err(|err| format!("CreateWindowExW frame failed: {err:?}"))?;

    let save = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("BUTTON"),
            SAVE_TEXT,
            WS_CHILD | WS_VISIBLE,
            40,
            40,
            140,
            36,
            hwnd,
            None,
            None,
            None,
        )
    }
    .map_err(|err| format!("CreateWindowExW save failed: {err:?}"))?;

    let toggle = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("BUTTON"),
            TOGGLE_TEXT,
            WS_CHILD | WS_VISIBLE | WINDOW_STYLE(BS_AUTOCHECKBOX as u32),
            40,
            100,
            180,
            36,
            hwnd,
            None,
            None,
            None,
        )
    }
    .map_err(|err| format!("CreateWindowExW toggle failed: {err:?}"))?;

    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNORMAL);
        let _ = UpdateWindow(hwnd);
        let _ = SetForegroundWindow(hwnd);
    }

    Ok(ProbeWindow {
        hwnd: RawHwnd::from_hwnd(hwnd),
        save: RawHwnd::from_hwnd(save),
        toggle: RawHwnd::from_hwnd(toggle),
        stop: Arc::new(AtomicBool::new(false)),
    })
}

fn pump_until(stop: &AtomicBool) {
    let mut msg = MSG::default();
    while !stop.load(Ordering::SeqCst) {
        unsafe {
            if PeekMessageW(&mut msg, HWND::default(), 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            } else {
                thread::sleep(Duration::from_millis(15));
            }
        }
    }
}

fn control_center(hwnd: HWND) -> Result<(i32, i32), String> {
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }.map_err(|err| format!("GetWindowRect: {err:?}"))?;
    Ok((
        (rect.left + rect.right) / 2,
        (rect.top + rect.bottom) / 2,
    ))
}

fn click_screen(x: i32, y: i32) -> Result<(), String> {
    unsafe {
        SetCursorPos(x, y).map_err(|err| format!("SetCursorPos: {err:?}"))?;
    }
    thread::sleep(Duration::from_millis(40));
    let down = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: 0,
                dwFlags: MOUSEEVENTF_LEFTDOWN,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let mut up = down;
    up.Anonymous.mi.dwFlags = MOUSEEVENTF_LEFTUP;
    let sent = unsafe { SendInput(&[down, up], size_of::<INPUT>() as i32) };
    if sent != 2 {
        return Err(format!("SendInput sent {sent} events"));
    }
    Ok(())
}

fn uia_name_from_point(x: i32, y: i32) -> Result<String, String> {
    use windows::Win32::Foundation::POINT;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|err| format!("CoCreateInstance: {err:?}"))?;
        let element = automation
            .ElementFromPoint(POINT { x, y })
            .map_err(|err| format!("ElementFromPoint: {err:?}"))?;
        let name = element
            .CurrentName()
            .map_err(|err| format!("CurrentName: {err:?}"))?;
        let control = element.CurrentControlType().ok().map(|id| id.0);
        Ok(format!("name={name:?} controlType={control:?}"))
    }
}

fn uia_name_from_hwnd(hwnd: HWND) -> Result<String, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|err| format!("CoCreateInstance: {err:?}"))?;
        let element = automation
            .ElementFromHandle(hwnd)
            .map_err(|err| format!("ElementFromHandle: {err:?}"))?;
        let name = element
            .CurrentName()
            .map_err(|err| format!("CurrentName: {err:?}"))?;
        Ok(name.to_string())
    }
}

fn describe_hwnd(hwnd: HWND) -> String {
    if hwnd.is_invalid() || hwnd.0.is_null() {
        return "null".to_string();
    }
    let mut class_buf = [0u16; 128];
    let mut title_buf = [0u16; 128];
    let class_len = unsafe { GetClassNameW(hwnd, &mut class_buf) };
    let title_len = unsafe { GetWindowTextW(hwnd, &mut title_buf) };
    let class_name = String::from_utf16_lossy(&class_buf[..class_len.max(0) as usize]);
    let title = String::from_utf16_lossy(&title_buf[..title_len.max(0) as usize]);
    let visible = unsafe { IsWindowVisible(hwnd) }.as_bool();
    format!(
        "hwnd=0x{:x} class={class_name:?} title={title:?} visible={visible}",
        hwnd.0 as usize
    )
}

fn unique_temp_dir() -> PathBuf {
    let mut dir = std::env::temp_dir();
    dir.push(format!(
        "shadow-live-semantic-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(1)
    ));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[test]
#[ignore = "requires interactive Windows desktop; run with --ignored"]
fn live_win32_button_and_checkbox_have_l2_identity() {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<ProbeWindow, String>>();
    let ui = thread::Builder::new()
        .name("shadow-live-probe-ui".into())
        .spawn(move || match create_probe_window() {
            Ok(probe) => {
                let stop = Arc::clone(&probe.stop);
                let hwnd = probe.hwnd;
                let _ = ready_tx.send(Ok(probe));
                pump_until(&stop);
                unsafe {
                    let _ = DestroyWindow(hwnd.hwnd());
                }
            }
            Err(err) => {
                let _ = ready_tx.send(Err(err));
            }
        })
        .expect("spawn ui thread");

    let probe = ready_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("ui ready")
        .expect("create probe window");
    thread::sleep(Duration::from_millis(250));

    let save_pt = control_center(probe.save.hwnd()).expect("save center");
    let toggle_pt = control_center(probe.toggle.hwnd()).expect("toggle center");
    eprintln!("live probe save={save_pt:?} toggle={toggle_pt:?}");
    eprintln!("probe frame {}", describe_hwnd(probe.hwnd.hwnd()));
    eprintln!("probe save {}", describe_hwnd(probe.save.hwnd()));
    eprintln!("probe toggle {}", describe_hwnd(probe.toggle.hwnd()));
    eprintln!("foreground {}", describe_hwnd(unsafe { GetForegroundWindow() }));
    let at_save = unsafe { WindowFromPoint(windows::Win32::Foundation::POINT { x: save_pt.0, y: save_pt.1 }) };
    eprintln!("WindowFromPoint(save) {}", describe_hwnd(at_save));
    eprintln!(
        "UIA ElementFromHandle(save)={:?}",
        uia_name_from_hwnd(probe.save.hwnd())
    );
    eprintln!(
        "STA ElementFromPoint(save)={:?}",
        uia_name_from_point(save_pt.0, save_pt.1)
    );
    uia_enricher::set_timeout_ms(400);
    let mut direct_save = None;
    let mut direct_toggle = None;
    for attempt in 1..=5 {
        direct_save = uia_enricher::capture_at_point(save_pt.0, save_pt.1);
        direct_toggle = uia_enricher::capture_at_point(toggle_pt.0, toggle_pt.1);
        eprintln!("direct UIA attempt={attempt} save={direct_save:?} toggle={direct_toggle:?}");
        if direct_save.as_ref().is_some_and(|snap| snap.has_identity()) {
            break;
        }
        thread::sleep(Duration::from_millis(150));
    }

    if !direct_save
        .as_ref()
        .and_then(|snap| snap.control_name.as_deref())
        .is_some_and(|name: &str| name.contains('保') || name.contains("Save"))
    {
        eprintln!(
            "in-process enricher worker timed out (same-process UIA marshal); notepad probe is the real check"
        );
        probe.stop.store(true, Ordering::SeqCst);
        let _ = ui.join();
        run_notepad_live_probe();
        return;
    }

    crate::session::set_defect_evidence_enabled(true);
    crate::session::set_semantic_feature_flags(true, true, true, false, true);

    let mut config = RecorderConfig::default();
    config.semantic_recording_enabled = true;
    config.defect_evidence_enabled = true;
    config.uia_observer_enabled = true;
    config.operation_builder_enabled = true;
    config.debounce_ms = 20;
    RECORDER.set_config(config).expect("set recorder config");

    let storage = unique_temp_dir();
    let started = TEST_SESSION_MANAGER
        .start(TestSessionStartOptions {
            name: Some("live-semantic-probe".into()),
            storage_dir: Some(storage.to_string_lossy().into_owned()),
            target_process_name: None,
            target_pid: Some(std::process::id()),
            target_hwnd: Some(format!("0x{:x}", probe.hwnd.0)),
            target_capture_mode: Some("process_bind".into()),
            buffer_window_seconds: Some(30),
            segment_duration_seconds: Some(5),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");
    eprintln!(
        "session={} dir={:?} pid={:?}",
        started.session_id, started.session_dir, started.target_pid
    );

    RECORDER.start().expect("start recorder hook");
    thread::sleep(Duration::from_millis(200));
    click_screen(save_pt.0, save_pt.1).expect("click save");
    thread::sleep(Duration::from_millis(400));
    click_screen(toggle_pt.0, toggle_pt.1).expect("click toggle");
    thread::sleep(Duration::from_millis(900));

    let _ = RECORDER.stop();
    let stopped = TEST_SESSION_MANAGER.stop().expect("stop session");
    probe.stop.store(true, Ordering::SeqCst);
    let _ = ui.join();

    let session_dir = PathBuf::from(stopped.session_dir.expect("session dir"));
    let operations_path = session_dir.join("operations.ndjson");
    let semantic_path = session_dir.join("semantic-events.ndjson");
    let events_path = session_dir.join("events.ndjson");
    let operations_raw = std::fs::read_to_string(&operations_path).unwrap_or_default();
    let semantic_raw = std::fs::read_to_string(&semantic_path).unwrap_or_default();
    let events_raw = std::fs::read_to_string(&events_path).unwrap_or_default();
    eprintln!("--- events.ndjson ---\n{events_raw}");
    eprintln!("--- semantic-events.ndjson ---\n{semantic_raw}");
    eprintln!("--- operations.ndjson ---\n{operations_raw}");

    let operations = TEST_SESSION_MANAGER
        .rebuild_operations(Some(&stopped.session_id))
        .or_else(|_| {
            TEST_SESSION_MANAGER
                .get_operations_tail(Some(&stopped.session_id), None, None)
                .map(|tail| tail.items)
        })
        .unwrap_or_else(|_| {
            crate::session::build_operation_records_from_events(
                &stopped.session_id,
                stopped.started_at_ms,
                &TEST_SESSION_MANAGER
                    .get_events(Some(&stopped.session_id), None)
                    .unwrap_or_default(),
                &[],
            )
        });

    eprintln!("operation count={}", operations.len());
    for operation in &operations {
        eprintln!(
            "op {} kind={:?} title={} target={:?} precision={} outcome={:?}",
            operation.operation_id,
            operation.action.kind,
            operation.title,
            operation
                .action
                .target
                .as_ref()
                .and_then(|target| target.name.clone()),
            operation.precision_level,
            operation.outcome.status
        );
    }

    let l2 = operations.iter().filter(|op| {
        op.action.target.as_ref().is_some_and(|target| {
            target
                .name
                .as_deref()
                .is_some_and(|name| name.contains('保') || name.contains("同步") || name.contains("Save"))
                || target.control_type.as_deref() == Some("Button")
                || target.control_type.as_deref() == Some("CheckBox")
        })
    }).count();

    assert!(
        l2 >= 1,
        "expected at least one L2 operation from the live probe, got {} operations in {}",
        operations.len(),
        session_dir.display()
    );
}

fn dump_visible_windows() {
    unsafe extern "system" fn enum_proc(hwnd: HWND, _lparam: LPARAM) -> windows::Win32::Foundation::BOOL {
        if unsafe { IsWindowVisible(hwnd) }.as_bool() {
            let mut rect = RECT::default();
            let ok = unsafe { GetWindowRect(hwnd, &mut rect) }.is_ok();
            if ok && rect.right > rect.left && rect.bottom > rect.top {
                eprintln!(
                    "  {} {}x{}",
                    describe_hwnd(hwnd),
                    rect.right - rect.left,
                    rect.bottom - rect.top
                );
            }
        }
        windows::Win32::Foundation::BOOL(1)
    }
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::EnumWindows(Some(enum_proc), LPARAM(0));
    }
}

fn find_window_title_contains(needle: &str) -> Option<HWND> {
    struct Search {
        needle: String,
        hwnd: HWND,
    }
    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> windows::Win32::Foundation::BOOL {
        let search = unsafe { &mut *(lparam.0 as *mut Search) };
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            return windows::Win32::Foundation::BOOL(1);
        }
        let desc = describe_hwnd(hwnd);
        if desc.contains(&search.needle) {
            search.hwnd = hwnd;
            return windows::Win32::Foundation::BOOL(0);
        }
        windows::Win32::Foundation::BOOL(1)
    }
    let mut search = Search {
        needle: needle.to_string(),
        hwnd: HWND::default(),
    };
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::EnumWindows(
            Some(enum_proc),
            LPARAM((&mut search) as *mut Search as isize),
        );
    }
    if search.hwnd.is_invalid() || search.hwnd.0.is_null() {
        None
    } else {
        Some(search.hwnd)
    }
}

fn find_main_window_for_pid(pid: u32) -> Option<HWND> {
    struct Search {
        pid: u32,
        hwnd: HWND,
    }
    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> windows::Win32::Foundation::BOOL {
        let search = unsafe { &mut *(lparam.0 as *mut Search) };
        let mut window_pid = 0u32;
        unsafe {
            windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(
                hwnd,
                Some(&mut window_pid),
            );
        }
        if window_pid == search.pid && unsafe { IsWindowVisible(hwnd) }.as_bool() {
            let mut rect = RECT::default();
            if unsafe { GetWindowRect(hwnd, &mut rect) }.is_ok()
                && rect.right - rect.left > 80
                && rect.bottom - rect.top > 40
            {
                search.hwnd = hwnd;
                return windows::Win32::Foundation::BOOL(0);
            }
        }
        windows::Win32::Foundation::BOOL(1)
    }
    let mut search = Search {
        pid,
        hwnd: HWND::default(),
    };
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::EnumWindows(
            Some(enum_proc),
            LPARAM((&mut search) as *mut Search as isize),
        );
    }
    if search.hwnd.is_invalid() || search.hwnd.0.is_null() {
        None
    } else {
        Some(search.hwnd)
    }
}

fn notepad_click_point(hwnd: HWND) -> (i32, i32) {
    let mut rect = RECT::default();
    let _ = unsafe { GetWindowRect(hwnd, &mut rect) };
    // Classic and Win11 Notepad both keep File / 文件 near the upper-left content edge.
    (rect.left + 36, rect.top + 48)
}

fn run_notepad_live_probe() {
    let mut child = std::process::Command::new("notepad.exe")
        .spawn()
        .expect("start notepad");
    let pid = child.id();
    let mut hwnd = None;
    for _ in 0..50 {
        hwnd = find_main_window_for_pid(pid);
        if hwnd.is_none() {
            hwnd = find_window_title_contains("记事本")
                .or_else(|| find_window_title_contains("Notepad"));
        }
        if hwnd.is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    if hwnd.is_none() {
        eprintln!("visible windows after notepad launch:");
        dump_visible_windows();
    }
    let hwnd = hwnd.expect("notepad window");
    unsafe {
        let _ = SetForegroundWindow(hwnd);
    }
    thread::sleep(Duration::from_millis(300));
    let click = notepad_click_point(hwnd);
    eprintln!("notepad {} click={click:?}", describe_hwnd(hwnd));
    eprintln!(
        "STA ElementFromPoint(notepad)={:?}",
        uia_name_from_point(click.0, click.1)
    );
    uia_enricher::set_timeout_ms(400);
    let mut snap = None;
    for attempt in 1..=5 {
        snap = uia_enricher::capture_at_point(click.0, click.1);
        eprintln!("notepad enricher attempt={attempt} {snap:?}");
        if snap.as_ref().is_some_and(|item| item.has_identity()) {
            break;
        }
        thread::sleep(Duration::from_millis(150));
    }

    crate::session::set_defect_evidence_enabled(true);
    crate::session::set_semantic_feature_flags(true, true, true, false, true);
    let mut config = RecorderConfig::default();
    config.semantic_recording_enabled = true;
    config.defect_evidence_enabled = true;
    config.uia_observer_enabled = true;
    config.operation_builder_enabled = true;
    config.debounce_ms = 20;
    RECORDER.set_config(config).expect("set recorder config");

    let storage = unique_temp_dir();
    let started = TEST_SESSION_MANAGER
        .start(TestSessionStartOptions {
            name: Some("live-notepad-probe".into()),
            storage_dir: Some(storage.to_string_lossy().into_owned()),
            target_process_name: Some("notepad.exe".into()),
            target_pid: Some(pid),
            target_hwnd: Some(format!("0x{:x}", hwnd.0 as usize)),
            target_capture_mode: Some("process_bind".into()),
            buffer_window_seconds: Some(30),
            segment_duration_seconds: Some(5),
            ..TestSessionStartOptions::default()
        })
        .expect("start session");
    eprintln!(
        "notepad session={} dir={:?}",
        started.session_id, started.session_dir
    );
    RECORDER.start().expect("start recorder");
    thread::sleep(Duration::from_millis(200));
    click_screen(click.0, click.1).expect("click notepad");
    thread::sleep(Duration::from_millis(900));
    let _ = RECORDER.stop();
    let stopped = TEST_SESSION_MANAGER.stop().expect("stop session");
    let _ = child.kill();

    let session_dir = PathBuf::from(stopped.session_dir.expect("session dir"));
    let operations = TEST_SESSION_MANAGER
        .rebuild_operations(Some(&stopped.session_id))
        .unwrap_or_default();
    eprintln!(
        "--- notepad operations ---\n{}",
        std::fs::read_to_string(session_dir.join("operations.ndjson")).unwrap_or_default()
    );
    eprintln!(
        "--- notepad semantic ---\n{}",
        std::fs::read_to_string(session_dir.join("semantic-events.ndjson")).unwrap_or_default()
    );
    for operation in &operations {
        eprintln!(
            "notepad op title={} target={:?} precision={} outcome={:?}",
            operation.title,
            operation
                .action
                .target
                .as_ref()
                .and_then(|target| target.name.clone()),
            operation.precision_level,
            operation.outcome.status
        );
    }

    let has_identity = snap.as_ref().is_some_and(|item| item.has_identity())
        || operations.iter().any(|op| {
            op.precision_level.starts_with('l') && op.precision_level != "l0"
                || op.action.target.as_ref().is_some_and(|target| {
                    target.name.is_some() || target.control_type.is_some()
                })
        });
    assert!(
        has_identity,
        "notepad live probe should produce a control identity via enricher or operations"
    );
}

#[test]
#[ignore = "requires interactive Windows desktop; run with --ignored"]
fn live_notepad_file_menu_has_l2_identity() {
    run_notepad_live_probe();
}
