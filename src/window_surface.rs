#[cfg(windows)]
use std::sync::atomic::{AtomicIsize, Ordering};
#[cfg(windows)]
use windows::Win32::Foundation::{FreeLibrary, HWND, LPARAM, LRESULT, WPARAM};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, DefWindowProcW, GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos,
    GWL_EXSTYLE, GWL_STYLE, GWLP_WNDPROC, SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    WNDPROC, WS_CAPTION, WS_EX_TOOLWINDOW, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_POPUP, WS_THICKFRAME,
    WM_ACTIVATE, WM_ACTIVATEAPP, WM_ERASEBKGND, WM_NCACTIVATE, WM_NCCALCSIZE, WM_NCPAINT,
};
#[cfg(windows)]
use windows_core::HRESULT;

#[cfg(windows)]
static PREV_WNDPROC: AtomicIsize = AtomicIsize::new(0);

#[cfg(windows)]
#[inline]
unsafe fn call_prev(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let prev = PREV_WNDPROC.load(Ordering::SeqCst);
    if prev != 0 {
        let prev_fn: WNDPROC = unsafe { std::mem::transmute(prev) };
        unsafe { CallWindowProcW(prev_fn, hwnd, msg, wparam, lparam) }
    } else {
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }
}

#[cfg(windows)]
unsafe extern "system" fn toolbar_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_ACTIVATEAPP => {
            // CRITICAL FIX: Intercept WM_ACTIVATEAPP to block Chromium's HWNDMessageHandler::OnActivateApp
            // from invoking DefWindowProcWithRedrawLock(WM_NCACTIVATE, FALSE, 0).
            // That Chromium call paints the native Windows 11 inactive title bar / accent frame on focus loss.
            LRESULT(0)
        }
        WM_ACTIVATE => {
            // Floating toolbar is unfocusable (WS_EX_NOACTIVATE) and should ignore activation changes.
            LRESULT(0)
        }
        WM_NCACTIVATE => {
            // Returning TRUE tells Windows that the non-client activation state is handled.
            // This prevents DefWindowProc from painting the native Windows 11 title bar caption.
            LRESULT(1)
        }
        WM_NCPAINT => {
            // Returning 0 tells Windows that the non-client frame painting is handled.
            // This prevents DefWindowProc from painting native window borders.
            LRESULT(0)
        }
        WM_ERASEBKGND => {
            // Transparent surface: do not allow GDI to erase background with default window brush.
            LRESULT(1)
        }
        WM_NCCALCSIZE => {
            // When wParam is TRUE (1), returning 0 tells Windows that the client area
            // covers the entire window, preventing native non-client caption/border calculation.
            if wparam.0 != 0 {
                LRESULT(0)
            } else {
                unsafe { call_prev(hwnd, msg, wparam, lparam) }
            }
        }
        _ => unsafe { call_prev(hwnd, msg, wparam, lparam) },
    }
}

#[cfg(windows)]
unsafe fn apply_dwm_safeguards(hwnd: HWND) {
    type DwmSetWindowAttributeFn = unsafe extern "system" fn(
        HWND,
        u32,
        *const std::ffi::c_void,
        u32,
    ) -> HRESULT;

    let module = unsafe { windows::Win32::System::LibraryLoader::LoadLibraryW(windows::core::w!("dwmapi.dll")) };
    if let Ok(hmod) = module {
        if let Some(proc) = unsafe {
            windows::Win32::System::LibraryLoader::GetProcAddress(
                hmod,
                windows::core::s!("DwmSetWindowAttribute"),
            )
        } {
            let dwm_set_window_attribute: DwmSetWindowAttributeFn = unsafe { std::mem::transmute(proc) };

            // DWMWA_NCRENDERING_POLICY = 2 (DWMNCRP_DISABLED = 1)
            let nc_policy: u32 = 1;
            let _ = unsafe {
                dwm_set_window_attribute(
                    hwnd,
                    2,
                    &nc_policy as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<u32>() as u32,
                )
            };

            // DWMWA_WINDOW_CORNER_PREFERENCE = 33 (DWMWCP_DONOTROUND = 1)
            // Prevents Windows 11 DWM from rendering rounded corners and inactive corner accents.
            let corner: u32 = 1;
            let _ = unsafe {
                dwm_set_window_attribute(
                    hwnd,
                    33,
                    &corner as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<u32>() as u32,
                )
            };

            // DWMWA_BORDER_COLOR = 34 (DWMWA_COLOR_NONE = 0xFFFFFFFE)
            let border_color: u32 = 0xFFFFFFFE;
            let _ = unsafe {
                dwm_set_window_attribute(
                    hwnd,
                    34,
                    &border_color as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<u32>() as u32,
                )
            };

            // DWMWA_CAPTION_COLOR = 35 (DWMWA_COLOR_NONE = 0xFFFFFFFE)
            let caption_color: u32 = 0xFFFFFFFE;
            let _ = unsafe {
                dwm_set_window_attribute(
                    hwnd,
                    35,
                    &caption_color as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<u32>() as u32,
                )
            };
        }
        let _ = unsafe { FreeLibrary(hmod) };
    }
}

pub fn protect_floating_toolbar_hwnd(hwnd_val: i64) -> bool {
    #[cfg(windows)]
    {
        if hwnd_val == 0 {
            return false;
        }
        let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
        unsafe {
            // Apply DWM attributes to suppress native frame rendering and rounded corners
            apply_dwm_safeguards(hwnd);

            // Ensure window styles exclude caption and frame, and include WS_POPUP and WS_EX_TOOLWINDOW
            let current_style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            let stripped_style = (current_style | (WS_POPUP.0 as isize))
                & !(WS_CAPTION.0 as isize
                    | WS_THICKFRAME.0 as isize
                    | WS_MINIMIZEBOX.0 as isize
                    | WS_MAXIMIZEBOX.0 as isize);
            let _ = SetWindowLongPtrW(hwnd, GWL_STYLE, stripped_style);

            let current_ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let new_ex_style = current_ex_style | (WS_EX_TOOLWINDOW.0 as isize);
            let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex_style);

            let _ = SetWindowPos(
                hwnd,
                HWND(std::ptr::null_mut()),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
            );

            let prev = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
            if prev == 0 {
                return false;
            }
            let current = toolbar_wndproc as usize as isize;
            if prev == current {
                return true;
            }
            PREV_WNDPROC.store(prev, Ordering::SeqCst);
            let res = SetWindowLongPtrW(
                hwnd,
                GWLP_WNDPROC,
                current,
            );
            res != 0
        }
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd_val;
        true
    }
}
