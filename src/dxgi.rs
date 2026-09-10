use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Instant;

use once_cell::sync::Lazy;
use windows::Win32::Foundation::{CloseHandle, HWND, RECT};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    DXGI_ERROR_MORE_DATA, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO, IDXGIAdapter1,
    IDXGIDevice, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication,
};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId,
};
use windows::core::{Interface, PWSTR};

use crate::error::RecorderError;
use crate::retry::{RetryFailure, run_with_single_retry};
use crate::telemetry::inc_capture_context_reset;

macro_rules! debug_log {
    ($($arg:tt)*) => {};
}

#[derive(Debug, Clone)]
pub struct WindowContext {
    pub hwnd: isize,
    pub display_id: String,
    pub dpi_scale: f32,
    pub process_name: String,
    pub window_title: String,
    pub rect: Rect,
    pub logical_rect: Rect,
    pub monitor_rect: Option<Rect>,
}

#[derive(Debug, Clone, Copy)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Debug, Clone)]
pub struct CaptureOutput {
    pub window: WindowContext,
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub capture_latency_ms: u32,
    pub frame_delta_hint: FrameDeltaHint,
}

#[derive(Debug, Clone, Copy)]
pub struct FrameDeltaHint {
    pub dirty_regions_supported: bool,
    pub has_updates: bool,
    pub coverage: f32,
}

impl Default for FrameDeltaHint {
    fn default() -> Self {
        Self {
            dirty_regions_supported: false,
            has_updates: true,
            coverage: 1.0,
        }
    }
}

const FRAME_SAMPLE_STRIDE: usize = 16;
const MIN_NON_ZERO_SAMPLES: usize = 10;
const MIN_NON_ZERO_PIXELS_FULL_SCAN: usize = 100;
const BLANK_FRAME_FUSE_THRESHOLD: u32 = 3;

static DXGI_BLANK_FRAME_STREAK: AtomicU32 = AtomicU32::new(0);

fn sampled_non_zero_hits(data: &[u8], width: u32, height: u32) -> usize {
    let w = width as usize;
    let h = height as usize;
    let mut hits = 0usize;

    let mut y = 0usize;
    while y < h {
        let mut x = 0usize;
        while x < w {
            let offset = (y * w + x) * 4;
            if offset + 3 < data.len()
                && (data[offset] != 0 || data[offset + 1] != 0 || data[offset + 2] != 0)
            {
                hits = hits.saturating_add(1);
                if hits >= MIN_NON_ZERO_SAMPLES {
                    return hits;
                }
            }
            x = x.saturating_add(FRAME_SAMPLE_STRIDE);
        }
        y = y.saturating_add(FRAME_SAMPLE_STRIDE);
    }

    hits
}

fn full_non_zero_pixels(data: &[u8]) -> usize {
    data.chunks_exact(4)
        .filter(|pixel| pixel[0] != 0 || pixel[1] != 0 || pixel[2] != 0)
        .count()
}

fn has_visible_content_bgra(data: &[u8], width: u32, height: u32) -> bool {
    let sampled_hits = sampled_non_zero_hits(data, width, height);
    if sampled_hits >= MIN_NON_ZERO_SAMPLES {
        DXGI_BLANK_FRAME_STREAK.store(0, Ordering::Relaxed);
        return true;
    }

    let blank_streak = DXGI_BLANK_FRAME_STREAK.fetch_add(1, Ordering::Relaxed) + 1;
    if blank_streak >= BLANK_FRAME_FUSE_THRESHOLD {
        return false;
    }

    let non_zero_pixels = full_non_zero_pixels(data);
    if non_zero_pixels >= MIN_NON_ZERO_PIXELS_FULL_SCAN {
        DXGI_BLANK_FRAME_STREAK.store(0, Ordering::Relaxed);
        return true;
    }
    false
}

pub fn capture_active_window_webp(
    _quality: f32,
    reuse_context: bool,
    enable_dirty_rect: bool,
) -> Result<CaptureOutput, RecorderError> {
    let capture_started = Instant::now();

    let context = get_active_window_context()?;
    let bgra = capture_desktop_bgra(
        reuse_context,
        context.monitor_rect.as_ref(),
        enable_dirty_rect,
    )?;

    if bgra.width == 0 || bgra.height == 0 || bgra.data.is_empty() {
        return Err(RecorderError::DxgiCaptureFailed(
            "received empty frame".to_string(),
        ));
    }

    if !has_visible_content_bgra(&bgra.data, bgra.width, bgra.height) {
        return Err(RecorderError::DxgiCaptureFailed(
            "received entirely black frame".to_string(),
        ));
    }

    // 将窗口坐标转换为相对于当前显示器的坐标
    let (left, top, right, bottom) = if let Some(monitor) = &context.monitor_rect {
        // 窗口在扩展显示器上，需要减去显示器偏移量
        // 注意：monitor.left/top 可能是负数（当扩展显示器在主显示器左侧/上方时）

        // 首先将窗口坐标限制在显示器范围内
        let window_left_in_monitor = context.rect.left - monitor.left;
        let window_top_in_monitor = context.rect.top - monitor.top;
        let window_right_in_monitor = context.rect.right - monitor.left;
        let window_bottom_in_monitor = context.rect.bottom - monitor.top;

        // 显示器尺寸
        let monitor_width = monitor.right - monitor.left;
        let monitor_height = monitor.bottom - monitor.top;

        // 裁剪到显示器边界内
        let left = window_left_in_monitor.max(0) as u32;
        let top = window_top_in_monitor.max(0) as u32;
        let right = (window_right_in_monitor.min(monitor_width) as u32).min(bgra.width);
        let bottom = (window_bottom_in_monitor.min(monitor_height) as u32).min(bgra.height);

        // 调试日志
        debug_log!("[DXGI] Window rect: {:?}", context.rect);
        debug_log!("[DXGI] Monitor rect: {:?}", monitor);
        debug_log!(
            "[DXGI] Window in monitor coords: L={}, T={}, R={}, B={}",
            window_left_in_monitor,
            window_top_in_monitor,
            window_right_in_monitor,
            window_bottom_in_monitor
        );
        debug_log!("[DXGI] Monitor size: {}x{}", monitor_width, monitor_height);
        debug_log!(
            "[DXGI] Calculated crop: left={}, top={}, right={}, bottom={}",
            left,
            top,
            right,
            bottom
        );
        debug_log!("[DXGI] BGRA size: {}x{}", bgra.width, bgra.height);

        (left, top, right, bottom)
    } else {
        // 主显示器或无法获取显示器信息时使用原始坐标
        let left = context.rect.left.max(0) as u32;
        let top = context.rect.top.max(0) as u32;
        let right = (context.rect.right.max(0) as u32).min(bgra.width);
        let bottom = (context.rect.bottom.max(0) as u32).min(bgra.height);
        (left, top, right, bottom)
    };

    if left >= right || top >= bottom {
        return Err(RecorderError::DxgiCaptureFailed(
            "active window has invalid bounds".to_string(),
        ));
    }

    let window_width = right - left;
    let window_height = bottom - top;
    let mut rgba = vec![0u8; (window_width * window_height * 4) as usize];

    let src_stride = bgra.width as usize * 4;
    let dst_stride = window_width as usize * 4;

    for row in 0..window_height as usize {
        let src_offset = (top as usize + row) * src_stride + (left as usize * 4);
        let dst_offset = row * dst_stride;
        let src_row = &bgra.data[src_offset..src_offset + dst_stride];

        for (index, pixel) in src_row.chunks_exact(4).enumerate() {
            let out = dst_offset + index * 4;
            rgba[out] = pixel[2];
            rgba[out + 1] = pixel[1];
            rgba[out + 2] = pixel[0];
            rgba[out + 3] = pixel[3];
        }
    }

    let capture_latency_ms = capture_started.elapsed().as_millis() as u32;

    Ok(CaptureOutput {
        window: context,
        rgba,
        width: window_width,
        height: window_height,
        capture_latency_ms,
        frame_delta_hint: bgra.frame_delta_hint,
    })
}

pub(crate) fn get_active_window_context() -> Result<WindowContext, RecorderError> {
    let hwnd: HWND = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Err(RecorderError::WindowApiFailed(
            "GetForegroundWindow returned null".to_string(),
        ));
    }

    let mut rect = RECT::default();
    unsafe {
        GetWindowRect(hwnd, &mut rect)
            .map_err(|err| RecorderError::WindowApiFailed(format!("GetWindowRect: {err:?}")))?;
    }

    // 获取窗口所在的显示器信息
    let hmonitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let mut monitor_info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let monitor_rect = unsafe {
        if GetMonitorInfoW(hmonitor, &mut monitor_info).as_bool() {
            Some(Rect {
                left: monitor_info.rcMonitor.left,
                top: monitor_info.rcMonitor.top,
                right: monitor_info.rcMonitor.right,
                bottom: monitor_info.rcMonitor.bottom,
            })
        } else {
            None
        }
    };
    let display_id = format!("monitor-{:#x}", hmonitor.0 as usize);

    let dpi = unsafe { GetDpiForWindow(hwnd) };
    let dpi_scale = if dpi == 0 {
        1.0
    } else {
        (dpi as f32 / 96.0).max(0.5)
    };

    let title_len = unsafe { GetWindowTextLengthW(hwnd) };
    let mut title_buf = vec![0u16; title_len.max(0) as usize + 1];
    let copied = unsafe { GetWindowTextW(hwnd, &mut title_buf) };
    let window_title = String::from_utf16_lossy(&title_buf[..copied.max(0) as usize]);

    let mut pid = 0u32;
    unsafe {
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }

    let process_name = query_process_name(pid).unwrap_or_else(|_| format!("pid:{pid}"));

    Ok(WindowContext {
        hwnd: hwnd.0 as isize,
        display_id,
        dpi_scale,
        process_name,
        window_title,
        rect: Rect {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        },
        logical_rect: Rect {
            left: ((rect.left as f32) / dpi_scale).round() as i32,
            top: ((rect.top as f32) / dpi_scale).round() as i32,
            right: ((rect.right as f32) / dpi_scale).round() as i32,
            bottom: ((rect.bottom as f32) / dpi_scale).round() as i32,
        },
        monitor_rect,
    })
}

fn query_process_name(pid: u32) -> Result<String, RecorderError> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
        .map_err(|err| RecorderError::WindowApiFailed(format!("OpenProcess failed: {err:?}")))?;

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
    .map_err(|err| {
        RecorderError::WindowApiFailed(format!("QueryFullProcessImageNameW failed: {err:?}"))
    });

    unsafe {
        let _ = CloseHandle(handle);
    }

    query_result?;
    let name = String::from_utf16_lossy(&buf[..size as usize]);

    if let Some(last) = name.rsplit(['\\', '/']).next() {
        return Ok(last.to_string());
    }

    Ok(name)
}

struct DesktopFrame {
    width: u32,
    height: u32,
    data: Vec<u8>,
    frame_delta_hint: FrameDeltaHint,
}

#[derive(Clone)]
struct DxgiCaptureContext {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: IDXGIOutputDuplication,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct MonitorKey {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[derive(Clone)]
struct DxgiCaptureContextPoolEntry {
    key: MonitorKey,
    context: DxgiCaptureContext,
    last_used: u64,
}

const DXGI_CAPTURE_CONTEXT_POOL_CAPACITY: usize = 4;
static DXGI_CAPTURE_CONTEXT_POOL_CLOCK: AtomicU64 = AtomicU64::new(1);
static DXGI_CAPTURE_CONTEXT_POOL: Lazy<Mutex<Vec<DxgiCaptureContextPoolEntry>>> =
    Lazy::new(|| Mutex::new(Vec::new()));

fn monitor_key_for(monitor_rect: Option<&Rect>) -> MonitorKey {
    if let Some(rect) = monitor_rect {
        return MonitorKey {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        };
    }

    MonitorKey {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    }
}

fn resolve_dxgi_retry_result<T>(
    result: Result<T, RetryFailure<RecorderError>>,
) -> Result<T, RecorderError> {
    match result {
        Ok(frame) => Ok(frame),
        Err(failure) => Err(failure.second),
    }
}

fn build_dxgi_capture_context_for_monitor(
    monitor_rect: Option<&Rect>,
) -> Result<DxgiCaptureContext, RecorderError> {
    // 创建 DXGI Factory 以枚举所有适配器
    let factory: IDXGIFactory1 = unsafe {
        windows::Win32::Graphics::Dxgi::CreateDXGIFactory1().map_err(|err| {
            RecorderError::DxgiCaptureFailed(format!("CreateDXGIFactory1: {err:?}"))
        })?
    };

    // 查找与窗口所在显示器匹配的输出
    let mut found_device = None;
    let mut found_context = None;
    let mut found_output = None;

    if let Some(target_rect) = monitor_rect {
        debug_log!(
            "[DXGI] Looking for output matching monitor: {:?}",
            target_rect
        );
        'adapter_loop: for adapter_idx in 0.. {
            let adapter = match unsafe { factory.EnumAdapters(adapter_idx) } {
                Ok(adapter) => adapter,
                Err(_) => break,
            };

            for output_idx in 0.. {
                match unsafe { adapter.EnumOutputs(output_idx) } {
                    Ok(output) => {
                        if let Ok(output_desc) = unsafe { output.GetDesc() } {
                            let desktop_rect = &output_desc.DesktopCoordinates;
                            debug_log!(
                                "[DXGI] Adapter {}, Output {}: {:?}",
                                adapter_idx,
                                output_idx,
                                desktop_rect
                            );

                            // 检查显示器矩形是否匹配（使用工作区坐标，允许一定的误差）
                            let left_match = desktop_rect.left == target_rect.left;
                            let right_match = desktop_rect.right == target_rect.right;
                            // 对于top/bottom，允许任务栏高度的差异
                            let height_match = (desktop_rect.bottom - desktop_rect.top)
                                == (target_rect.bottom - target_rect.top);

                            if left_match && right_match && height_match {
                                debug_log!(
                                    "[DXGI] Found matching output on adapter {}, output {}",
                                    adapter_idx,
                                    output_idx
                                );
                                found_output = Some(output);

                                // 为这个适配器创建设备
                                let mut device: Option<ID3D11Device> = None;
                                let mut context: Option<ID3D11DeviceContext> = None;
                                unsafe {
                                    D3D11CreateDevice(
                                        Some(&adapter),
                                        D3D_DRIVER_TYPE_UNKNOWN,
                                        None,
                                        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                                        None,
                                        D3D11_SDK_VERSION,
                                        Some(&mut device),
                                        None,
                                        Some(&mut context),
                                    )
                                    .map_err(|err| {
                                        RecorderError::DxgiCaptureFailed(format!(
                                            "D3D11CreateDevice: {err:?}"
                                        ))
                                    })?;
                                }

                                found_device = device;
                                found_context = context;
                                break 'adapter_loop;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    }

    // 如果没有找到匹配的显示器，使用默认适配器和第一个输出
    let (device, context, output) = if let (Some(device), Some(context), Some(output)) =
        (found_device, found_context, found_output)
    {
        (device, context, output)
    } else {
        debug_log!("[DXGI] No matching output found, using default");
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                None,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .map_err(|err| {
                RecorderError::DxgiCaptureFailed(format!("D3D11CreateDevice: {err:?}"))
            })?;
        }

        let dxgi_device: IDXGIDevice = device.as_ref().unwrap().cast().map_err(|err| {
            RecorderError::DxgiCaptureFailed(format!("cast IDXGIDevice: {err:?}"))
        })?;

        let adapter: IDXGIAdapter1 = unsafe { dxgi_device.GetAdapter() }
            .map_err(|err| RecorderError::DxgiCaptureFailed(format!("GetAdapter: {err:?}")))?
            .cast()
            .map_err(|err| {
                RecorderError::DxgiCaptureFailed(format!("cast IDXGIAdapter1: {err:?}"))
            })?;

        let output = unsafe { adapter.EnumOutputs(0) }
            .map_err(|err| RecorderError::DxgiCaptureFailed(format!("EnumOutputs: {err:?}")))?;

        let device = device.ok_or(RecorderError::DxgiUnsupported)?;
        let context = context.ok_or(RecorderError::DxgiUnsupported)?;
        (device, context, output)
    };

    let output1: IDXGIOutput1 = output
        .cast()
        .map_err(|err| RecorderError::DxgiCaptureFailed(format!("cast IDXGIOutput1: {err:?}")))?;

    let duplication = unsafe { output1.DuplicateOutput(&device) }
        .map_err(|err| RecorderError::DxgiCaptureFailed(format!("DuplicateOutput: {err:?}")))?;

    // 获取实际使用的显示器矩形
    let _actual_monitor_rect = match unsafe { output.GetDesc() } {
        Ok(desc) => Rect {
            left: desc.DesktopCoordinates.left,
            top: desc.DesktopCoordinates.top,
            right: desc.DesktopCoordinates.right,
            bottom: desc.DesktopCoordinates.bottom,
        },
        Err(_) => monitor_rect.cloned().unwrap_or(Rect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        }),
    };

    debug_log!(
        "[DXGI] Created context for monitor: {:?}",
        _actual_monitor_rect
    );

    Ok(DxgiCaptureContext {
        device,
        context,
        duplication,
    })
}

fn compute_dirty_region_coverage(rects: &[RECT], width: u32, height: u32) -> f32 {
    let frame_width = width.max(1) as i64;
    let frame_height = height.max(1) as i64;
    let mut dirty_area = 0i64;

    for rect in rects {
        let left = i64::from(rect.left).clamp(0, frame_width);
        let top = i64::from(rect.top).clamp(0, frame_height);
        let right = i64::from(rect.right).clamp(0, frame_width);
        let bottom = i64::from(rect.bottom).clamp(0, frame_height);
        if right > left && bottom > top {
            dirty_area = dirty_area.saturating_add((right - left) * (bottom - top));
        }
    }

    let frame_area = frame_width.saturating_mul(frame_height).max(1);
    (dirty_area as f32 / frame_area as f32).clamp(0.0, 1.0)
}

fn read_dxgi_dirty_rect_hint(
    duplication: &IDXGIOutputDuplication,
    metadata_size_bytes: u32,
    frame_width: u32,
    frame_height: u32,
    enable_dirty_rect: bool,
) -> FrameDeltaHint {
    if !enable_dirty_rect {
        return FrameDeltaHint::default();
    }

    if metadata_size_bytes == 0 {
        return FrameDeltaHint {
            dirty_regions_supported: true,
            has_updates: false,
            coverage: 0.0,
        };
    }

    let rect_size = std::mem::size_of::<RECT>() as u32;
    let mut buffer_bytes = metadata_size_bytes.max(rect_size);
    let dirty_rects = loop {
        let rect_count =
            usize::try_from((buffer_bytes.saturating_add(rect_size - 1) / rect_size) as u64)
                .unwrap_or(0)
                .max(1);
        let mut dirty_rects = vec![RECT::default(); rect_count];
        let mut written_bytes = 0u32;
        let fetch_result = unsafe {
            duplication.GetFrameDirtyRects(
                rect_count as u32 * rect_size,
                dirty_rects.as_mut_ptr(),
                &mut written_bytes,
            )
        };
        match fetch_result {
            Ok(()) => {
                let written_count = usize::try_from((written_bytes / rect_size) as u64)
                    .unwrap_or(0)
                    .min(dirty_rects.len());
                dirty_rects.truncate(written_count);
                break dirty_rects;
            }
            Err(err) if err.code() == DXGI_ERROR_MORE_DATA => {
                if written_bytes <= buffer_bytes || written_bytes == 0 {
                    return FrameDeltaHint::default();
                }
                buffer_bytes = written_bytes;
            }
            Err(_) => return FrameDeltaHint::default(),
        }
    };

    let coverage = compute_dirty_region_coverage(&dirty_rects, frame_width, frame_height);
    let has_updates = !dirty_rects.is_empty() && coverage > 0.0;

    FrameDeltaHint {
        dirty_regions_supported: true,
        has_updates,
        coverage,
    }
}

fn capture_with_context(
    capture_context: &DxgiCaptureContext,
    enable_dirty_rect: bool,
) -> Result<DesktopFrame, RecorderError> {
    let device = &capture_context.device;
    let context = &capture_context.context;
    let duplication = &capture_context.duplication;

    let duplication_desc = unsafe { duplication.GetDesc() };

    let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
    let mut resource = None;
    let acquire = unsafe { duplication.AcquireNextFrame(16, &mut info, &mut resource) };
    if let Err(err) = acquire {
        if err.code() == DXGI_ERROR_WAIT_TIMEOUT {
            return Err(RecorderError::DxgiCaptureFailed(
                "AcquireNextFrame timeout".to_string(),
            ));
        }

        return Err(RecorderError::DxgiCaptureFailed(format!(
            "AcquireNextFrame: {err:?}"
        )));
    }

    let resource = match resource {
        Some(resource) => resource,
        None => {
            unsafe {
                let _ = duplication.ReleaseFrame();
            }
            return Err(RecorderError::DxgiCaptureFailed(
                "AcquireNextFrame returned no resource".to_string(),
            ));
        }
    };

    let texture: ID3D11Texture2D = resource
        .cast()
        .map_err(|err| RecorderError::DxgiCaptureFailed(format!("cast texture: {err:?}")))?;

    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe {
        texture.GetDesc(&mut desc);
    }
    let frame_delta_hint = read_dxgi_dirty_rect_hint(
        duplication,
        info.TotalMetadataBufferSize,
        desc.Width,
        desc.Height,
        enable_dirty_rect,
    );

    let staging_desc = D3D11_TEXTURE2D_DESC {
        Width: desc.Width,
        Height: desc.Height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };

    let mut staging = None;
    unsafe {
        device
            .CreateTexture2D(&staging_desc, None, Some(&mut staging))
            .map_err(|err| RecorderError::DxgiCaptureFailed(format!("CreateTexture2D: {err:?}")))?;
    }
    let staging = staging.ok_or_else(|| {
        RecorderError::DxgiCaptureFailed("CreateTexture2D returned null".to_string())
    })?;

    unsafe {
        context.CopyResource(&staging, &texture);
    }

    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    if let Err(err) = unsafe { context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) } {
        unsafe {
            let _ = duplication.ReleaseFrame();
        }
        return Err(RecorderError::DxgiCaptureFailed(format!("Map: {err:?}")));
    }

    let row_pitch = mapped.RowPitch as usize;
    let width = desc.Width as usize;
    let height = desc.Height as usize;
    let mut data = vec![0u8; width * height * 4];

    // 调试日志
    debug_log!(
        "[DXGI] Capture texture: {}x{}, row_pitch={}",
        width,
        height,
        row_pitch
    );

    unsafe {
        let src = mapped.pData as *const u8;
        for row in 0..height {
            let src_row = src.add(row * row_pitch);
            let dst_offset = row * width * 4;
            let copy_len = (width * 4).min(row_pitch); // 确保不越界
            std::ptr::copy_nonoverlapping(
                src_row,
                data[dst_offset..dst_offset + copy_len].as_mut_ptr(),
                copy_len,
            );
        }

        context.Unmap(&staging, 0);
    }

    unsafe {
        let _ = duplication.ReleaseFrame();
    }

    let _monitor_width = duplication_desc.ModeDesc.Width;
    let _monitor_height = duplication_desc.ModeDesc.Height;

    Ok(DesktopFrame {
        width: desc.Width,
        height: desc.Height,
        data,
        frame_delta_hint,
    })
}

fn clear_dxgi_context_pool_internal(emit_metric: bool) {
    if let Ok(mut pool) = DXGI_CAPTURE_CONTEXT_POOL.lock()
        && !pool.is_empty()
    {
        pool.clear();
        if emit_metric {
            inc_capture_context_reset();
        }
    }
}

pub fn release_dxgi_capture_resources() {
    clear_dxgi_context_pool_internal(false);
}

fn capture_desktop_bgra(
    reuse_context: bool,
    monitor_rect: Option<&Rect>,
    enable_dirty_rect: bool,
) -> Result<DesktopFrame, RecorderError> {
    let result = if reuse_context {
        run_with_single_retry(
            || {
                let context_snapshot = {
                    let mut pool = DXGI_CAPTURE_CONTEXT_POOL
                        .lock()
                        .map_err(|_| RecorderError::LockPoisoned)?;
                    let key = monitor_key_for(monitor_rect);
                    let now = DXGI_CAPTURE_CONTEXT_POOL_CLOCK.fetch_add(1, Ordering::Relaxed);

                    if let Some(entry) = pool.iter_mut().find(|entry| entry.key == key) {
                        entry.last_used = now;
                        entry.context.clone()
                    } else {
                        let context = build_dxgi_capture_context_for_monitor(monitor_rect)?;
                        pool.push(DxgiCaptureContextPoolEntry {
                            key,
                            context: context.clone(),
                            last_used: now,
                        });
                        if pool.len() > DXGI_CAPTURE_CONTEXT_POOL_CAPACITY {
                            let lru_index = pool
                                .iter()
                                .enumerate()
                                .min_by_key(|(_, entry)| entry.last_used)
                                .map(|(index, _)| index)
                                .unwrap_or(0);
                            pool.remove(lru_index);
                        }
                        context
                    }
                };

                capture_with_context(&context_snapshot, enable_dirty_rect)
            },
            || {
                clear_dxgi_context_pool_internal(true);
            },
        )
    } else {
        run_with_single_retry(
            || {
                let context = build_dxgi_capture_context_for_monitor(monitor_rect)?;
                capture_with_context(&context, enable_dirty_rect)
            },
            || {},
        )
    };

    resolve_dxgi_retry_result(result)
}

#[cfg(test)]
mod tests {
    use super::resolve_dxgi_retry_result;
    use crate::error::RecorderError;
    use crate::retry::RetryFailure;

    #[test]
    fn resolve_dxgi_retry_result_preserves_success_payload() {
        let resolved = resolve_dxgi_retry_result::<u32>(Ok(9u32));
        assert_eq!(resolved.ok(), Some(9u32));
    }

    #[test]
    fn resolve_dxgi_retry_result_uses_second_error() {
        let resolved = resolve_dxgi_retry_result::<u32>(Err(RetryFailure {
            first: RecorderError::DxgiCaptureFailed("first".to_string()),
            second: RecorderError::DxgiCaptureFailed("second".to_string()),
        }));

        match resolved {
            Err(RecorderError::DxgiCaptureFailed(message)) => {
                assert_eq!(message, "second".to_string());
            }
            _ => panic!("expected second error to be returned"),
        }
    }

    #[test]
    fn resolve_dxgi_retry_result_keeps_second_error_variant() {
        let resolved = resolve_dxgi_retry_result::<u32>(Err(RetryFailure {
            first: RecorderError::DxgiCaptureFailed("first".to_string()),
            second: RecorderError::LockPoisoned,
        }));

        assert!(matches!(resolved, Err(RecorderError::LockPoisoned)));
    }
}
