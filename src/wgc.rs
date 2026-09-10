use std::cell::Cell;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureDirtyRegionMode,
    GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::{IDirect3DDevice, IDirect3DSurface};
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::{HWND, RPC_E_CHANGED_MODE};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoGetActivationFactory, RoInitialize};
use windows::core::{HSTRING, Interface};

use crate::context_reset::reset_context_slot_with;
use crate::dxgi::{CaptureOutput, FrameDeltaHint, get_active_window_context};
use crate::error::RecorderError;
use crate::retry::{RetryFailure, run_with_single_retry};
use crate::telemetry::inc_capture_context_reset;

const WGC_NEXT_FRAME_TIMEOUT: Duration = Duration::from_millis(120);
const WGC_NEXT_FRAME_INTERVAL: Duration = Duration::from_millis(5);
const FRAME_SAMPLE_STRIDE: usize = 16;
const MIN_NON_ZERO_SAMPLES: usize = 10;
const MIN_NON_ZERO_PIXELS_FULL_SCAN: usize = 100;
const BLANK_FRAME_FUSE_THRESHOLD: u32 = 3;

thread_local! {
    static WINRT_INIT_DONE: Cell<bool> = const { Cell::new(false) };
}

#[derive(Clone)]
struct WgcDeviceContext {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
}

#[derive(Clone)]
struct WgcItemCacheEntry {
    hwnd: isize,
    item: GraphicsCaptureItem,
    last_used: u64,
}

#[derive(Clone)]
struct WgcSessionPoolEntry {
    hwnd: isize,
    frame_pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    frame_size: SizeInt32,
    dirty_region_enabled: bool,
    last_used: u64,
}

const WGC_ITEM_CACHE_CAPACITY: usize = 8;
const WGC_SESSION_POOL_CAPACITY: usize = 4;
static WGC_ITEM_CACHE_CLOCK: AtomicU64 = AtomicU64::new(1);
static WGC_SESSION_POOL_CLOCK: AtomicU64 = AtomicU64::new(1);
static WGC_DEVICE_CONTEXT: Lazy<Mutex<Option<WgcDeviceContext>>> = Lazy::new(|| Mutex::new(None));
static WGC_ITEM_CACHE: Lazy<Mutex<Vec<WgcItemCacheEntry>>> = Lazy::new(|| Mutex::new(Vec::new()));
static WGC_SESSION_POOL: Lazy<Mutex<Vec<WgcSessionPoolEntry>>> =
    Lazy::new(|| Mutex::new(Vec::new()));
static WGC_BLANK_FRAME_STREAK: AtomicU32 = AtomicU32::new(0);

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
        WGC_BLANK_FRAME_STREAK.store(0, Ordering::Relaxed);
        return true;
    }

    let blank_streak = WGC_BLANK_FRAME_STREAK.fetch_add(1, Ordering::Relaxed) + 1;
    if blank_streak >= BLANK_FRAME_FUSE_THRESHOLD {
        return false;
    }

    let non_zero_pixels = full_non_zero_pixels(data);
    if non_zero_pixels >= MIN_NON_ZERO_PIXELS_FULL_SCAN {
        WGC_BLANK_FRAME_STREAK.store(0, Ordering::Relaxed);
        return true;
    }
    false
}

fn resolve_wgc_retry_result<T>(
    result: Result<T, RetryFailure<RecorderError>>,
) -> Result<T, RecorderError> {
    match result {
        Ok(output) => Ok(output),
        Err(failure) => Err(RecorderError::DxgiCaptureFailed(format!(
            "WGC capture failed after context reset: {}",
            failure.first
        ))),
    }
}

fn compute_dirty_region_coverage_from_rects(
    width: u32,
    height: u32,
    rects: &[windows::Graphics::RectInt32],
) -> f32 {
    let frame_width = width.max(1) as i64;
    let frame_height = height.max(1) as i64;
    let mut dirty_area = 0i64;

    for rect in rects {
        let left = i64::from(rect.X).clamp(0, frame_width);
        let top = i64::from(rect.Y).clamp(0, frame_height);
        let right = i64::from(rect.X.saturating_add(rect.Width)).clamp(0, frame_width);
        let bottom = i64::from(rect.Y.saturating_add(rect.Height)).clamp(0, frame_height);
        if right > left && bottom > top {
            dirty_area = dirty_area.saturating_add((right - left) * (bottom - top));
        }
    }

    let frame_area = frame_width.saturating_mul(frame_height).max(1);
    (dirty_area as f32 / frame_area as f32).clamp(0.0, 1.0)
}

fn read_wgc_dirty_region_hint(
    frame: &Direct3D11CaptureFrame,
    width: u32,
    height: u32,
    dirty_region_enabled: bool,
) -> FrameDeltaHint {
    if !dirty_region_enabled {
        return FrameDeltaHint::default();
    }

    let regions = match frame.DirtyRegions() {
        Ok(regions) => regions,
        Err(_) => return FrameDeltaHint::default(),
    };

    let count = regions.Size().unwrap_or(0);
    if count == 0 {
        return FrameDeltaHint {
            dirty_regions_supported: true,
            has_updates: false,
            coverage: 0.0,
        };
    }

    let mut rects: Vec<windows::Graphics::RectInt32> =
        Vec::with_capacity(usize::try_from(count).unwrap_or(0));
    for index in 0..count {
        if let Ok(rect) = regions.GetAt(index) {
            rects.push(rect);
        }
    }
    if rects.is_empty() {
        return FrameDeltaHint {
            dirty_regions_supported: true,
            has_updates: false,
            coverage: 0.0,
        };
    }

    let coverage = compute_dirty_region_coverage_from_rects(width, height, &rects);
    FrameDeltaHint {
        dirty_regions_supported: true,
        has_updates: coverage > 0.0,
        coverage,
    }
}

fn resolve_capture_item_size(
    capture_item: &GraphicsCaptureItem,
    window: &crate::dxgi::WindowContext,
) -> Result<SizeInt32, RecorderError> {
    let mut frame_size = capture_item.Size().map_err(|err| {
        RecorderError::DxgiCaptureFailed(format!("WGC item size failed: {err:?}"))
    })?;

    if frame_size.Width <= 0 || frame_size.Height <= 0 {
        frame_size = SizeInt32 {
            Width: (window.rect.right - window.rect.left).max(1),
            Height: (window.rect.bottom - window.rect.top).max(1),
        };
    }
    Ok(frame_size)
}

fn create_wgc_capture_session(
    wgc_device: &IDirect3DDevice,
    capture_item: &GraphicsCaptureItem,
    frame_size: SizeInt32,
    enable_dirty_rect: bool,
) -> Result<(Direct3D11CaptureFramePool, GraphicsCaptureSession, bool), RecorderError> {
    let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        wgc_device,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        2,
        frame_size,
    )
    .map_err(|err| {
        RecorderError::DxgiCaptureFailed(format!("WGC CreateFreeThreaded failed: {err:?}"))
    })?;

    let session = frame_pool
        .CreateCaptureSession(capture_item)
        .map_err(|err| {
            RecorderError::DxgiCaptureFailed(format!("WGC CreateCaptureSession failed: {err:?}"))
        })?;

    let dirty_region_enabled = if enable_dirty_rect {
        session
            .SetDirtyRegionMode(GraphicsCaptureDirtyRegionMode::ReportAndRender)
            .is_ok()
    } else {
        false
    };

    session.StartCapture().map_err(|err| {
        RecorderError::DxgiCaptureFailed(format!("WGC StartCapture failed: {err:?}"))
    })?;

    Ok((frame_pool, session, dirty_region_enabled))
}

fn capture_frame_from_pool(
    frame_pool: &Direct3D11CaptureFramePool,
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    dirty_region_enabled: bool,
) -> Result<DesktopFrame, RecorderError> {
    let frame = wait_next_frame(frame_pool)?;
    let frame_result = (|| {
        let content_size = frame.ContentSize().map_err(|err| {
            RecorderError::DxgiCaptureFailed(format!("WGC ContentSize failed: {err:?}"))
        })?;
        let hint = read_wgc_dirty_region_hint(
            &frame,
            content_size.Width.max(1) as u32,
            content_size.Height.max(1) as u32,
            dirty_region_enabled,
        );
        let surface = frame.Surface().map_err(|err| {
            RecorderError::DxgiCaptureFailed(format!("WGC Surface failed: {err:?}"))
        })?;
        copy_surface_to_cpu_bgra(device, context, &surface, content_size, hint)
    })();

    let _ = frame.Close();
    frame_result
}

fn close_wgc_session_entry(entry: WgcSessionPoolEntry) {
    let _ = entry.session.Close();
    let _ = entry.frame_pool.Close();
}

fn get_or_create_wgc_session_frame_pool(
    window: &crate::dxgi::WindowContext,
    wgc_device: &IDirect3DDevice,
    enable_dirty_rect: bool,
) -> Result<(Direct3D11CaptureFramePool, bool), RecorderError> {
    let hwnd = window.hwnd;
    let capture_item = create_capture_item_for_window(HWND(window.hwnd as *mut std::ffi::c_void))?;
    let frame_size = resolve_capture_item_size(&capture_item, window)?;

    let mut pool = WGC_SESSION_POOL
        .lock()
        .map_err(|_| RecorderError::LockPoisoned)?;

    let now = WGC_SESSION_POOL_CLOCK.fetch_add(1, Ordering::Relaxed);
    if let Some(entry) = pool.iter_mut().find(|entry| entry.hwnd == hwnd) {
        if entry.frame_size.Width != frame_size.Width
            || entry.frame_size.Height != frame_size.Height
        {
            entry
                .frame_pool
                .Recreate(
                    wgc_device,
                    DirectXPixelFormat::B8G8R8A8UIntNormalized,
                    2,
                    frame_size,
                )
                .map_err(|err| {
                    RecorderError::DxgiCaptureFailed(format!(
                        "WGC FramePool Recreate failed: {err:?}"
                    ))
                })?;
            entry.frame_size = frame_size;
        }
        if enable_dirty_rect && !entry.dirty_region_enabled {
            entry.dirty_region_enabled = entry
                .session
                .SetDirtyRegionMode(GraphicsCaptureDirtyRegionMode::ReportAndRender)
                .is_ok();
        }
        entry.last_used = now;
        return Ok((
            entry.frame_pool.clone(),
            enable_dirty_rect && entry.dirty_region_enabled,
        ));
    }

    let (frame_pool, session, dirty_region_enabled) =
        create_wgc_capture_session(wgc_device, &capture_item, frame_size, enable_dirty_rect)?;

    pool.push(WgcSessionPoolEntry {
        hwnd,
        frame_pool: frame_pool.clone(),
        session,
        frame_size,
        dirty_region_enabled,
        last_used: now,
    });

    if pool.len() > WGC_SESSION_POOL_CAPACITY {
        let lru_index = pool
            .iter()
            .enumerate()
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(index, _)| index)
            .unwrap_or(0);
        let removed = pool.remove(lru_index);
        close_wgc_session_entry(removed);
    }

    Ok((frame_pool, dirty_region_enabled))
}

fn clear_wgc_session_pool() -> bool {
    if let Ok(mut pool) = WGC_SESSION_POOL.lock() {
        if pool.is_empty() {
            return false;
        }
        for entry in pool.drain(..) {
            close_wgc_session_entry(entry);
        }
        return true;
    }
    false
}

pub fn release_wgc_capture_resources() {
    let _ = clear_wgc_device_context_internal(false);
}

pub fn capture_active_window_wgc_webp(
    quality: f32,
    reuse_context: bool,
    enable_dirty_rect: bool,
) -> Result<CaptureOutput, RecorderError> {
    let is_supported = GraphicsCaptureSession::IsSupported().map_err(|err| {
        RecorderError::DxgiCaptureFailed(format!("WGC IsSupported failed: {err:?}"))
    })?;
    if !is_supported {
        return Err(RecorderError::DxgiCaptureFailed(
            "WGC is not supported on current system".to_string(),
        ));
    }

    let window = get_active_window_context()?;
    ensure_winrt_multithreaded()?;
    let capture_started = Instant::now();

    resolve_wgc_retry_result(run_with_single_retry(
        || {
            capture_active_window_wgc_webp_once(
                &window,
                quality,
                capture_started,
                reuse_context,
                enable_dirty_rect,
            )
        },
        || {
            if reuse_context {
                clear_wgc_device_context();
            }
        },
    ))
}

fn capture_active_window_wgc_webp_once(
    window: &crate::dxgi::WindowContext,
    _quality: f32,
    capture_started: Instant,
    reuse_context: bool,
    enable_dirty_rect: bool,
) -> Result<CaptureOutput, RecorderError> {
    let (device, context) = get_wgc_device_context(reuse_context)?;
    let wgc_device = create_winrt_device_from_dxgi(&device)?;
    let bgra = if reuse_context {
        let (frame_pool, dirty_region_enabled) =
            get_or_create_wgc_session_frame_pool(window, &wgc_device, enable_dirty_rect)?;
        capture_frame_from_pool(&frame_pool, &device, &context, dirty_region_enabled)?
    } else {
        let capture_item =
            create_capture_item_for_window(HWND(window.hwnd as *mut std::ffi::c_void))?;
        let frame_size = resolve_capture_item_size(&capture_item, window)?;
        let (frame_pool, session, dirty_region_enabled) =
            create_wgc_capture_session(&wgc_device, &capture_item, frame_size, enable_dirty_rect)?;
        let frame = capture_frame_from_pool(&frame_pool, &device, &context, dirty_region_enabled);
        let _ = session.Close();
        let _ = frame_pool.Close();
        frame?
    };

    if bgra.width == 0 || bgra.height == 0 || bgra.data.is_empty() {
        return Err(RecorderError::DxgiCaptureFailed(
            "WGC received empty frame".to_string(),
        ));
    }

    if !has_visible_content_bgra(&bgra.data, bgra.width, bgra.height) {
        return Err(RecorderError::DxgiCaptureFailed(
            "WGC received entirely black frame".to_string(),
        ));
    }

    let window_width = bgra.width;
    let window_height = bgra.height;
    let mut rgba = vec![0u8; (window_width * window_height * 4) as usize];

    let src_stride = bgra.width as usize * 4;
    let dst_stride = window_width as usize * 4;

    for row in 0..window_height as usize {
        let src_offset = row * src_stride;
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
        window: window.clone(),
        rgba,
        width: window_width,
        height: window_height,
        capture_latency_ms,
        frame_delta_hint: bgra.frame_delta_hint,
    })
}

fn ensure_winrt_multithreaded() -> Result<(), RecorderError> {
    WINRT_INIT_DONE.with(|flag| {
        if flag.get() {
            return Ok(());
        }

        let init = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
        match init {
            Ok(()) => {
                flag.set(true);
                Ok(())
            }
            Err(err) if err.code() == RPC_E_CHANGED_MODE => {
                flag.set(true);
                Ok(())
            }
            Err(err) => Err(RecorderError::DxgiCaptureFailed(format!(
                "RoInitialize failed: {err:?}"
            ))),
        }
    })
}

fn get_wgc_device_context(
    reuse_context: bool,
) -> Result<(ID3D11Device, ID3D11DeviceContext), RecorderError> {
    if reuse_context {
        get_or_create_wgc_device_context()
    } else {
        create_d3d11_device()
    }
}

fn get_or_create_wgc_device_context() -> Result<(ID3D11Device, ID3D11DeviceContext), RecorderError>
{
    if let Ok(slot) = WGC_DEVICE_CONTEXT.lock()
        && let Some(cached) = slot.as_ref()
    {
        return Ok((cached.device.clone(), cached.context.clone()));
    }

    let (device, context) = create_d3d11_device()?;
    if let Ok(mut slot) = WGC_DEVICE_CONTEXT.lock() {
        *slot = Some(WgcDeviceContext {
            device: device.clone(),
            context: context.clone(),
        });
    }
    Ok((device, context))
}

fn clear_wgc_device_context_internal(emit_metric: bool) -> bool {
    if let Ok(mut cache) = WGC_ITEM_CACHE.lock() {
        cache.clear();
    }

    let sessions_cleared = clear_wgc_session_pool();
    let device_cleared = if let Ok(mut slot) = WGC_DEVICE_CONTEXT.lock() {
        if emit_metric {
            reset_context_slot_with(&mut slot, inc_capture_context_reset)
        } else {
            slot.take().is_some()
        }
    } else {
        false
    };

    if emit_metric && sessions_cleared && !device_cleared {
        inc_capture_context_reset();
    }

    sessions_cleared || device_cleared
}

fn clear_wgc_device_context() -> bool {
    clear_wgc_device_context_internal(true)
}

fn create_d3d11_device() -> Result<(ID3D11Device, ID3D11DeviceContext), RecorderError> {
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
        .map_err(|err| RecorderError::DxgiCaptureFailed(format!("D3D11CreateDevice: {err:?}")))?;
    }

    let device = device.ok_or(RecorderError::DxgiUnsupported)?;
    let context = context.ok_or(RecorderError::DxgiUnsupported)?;
    Ok((device, context))
}

fn create_winrt_device_from_dxgi(device: &ID3D11Device) -> Result<IDirect3DDevice, RecorderError> {
    let dxgi_device: IDXGIDevice = device.cast().map_err(|err| {
        RecorderError::DxgiCaptureFailed(format!("cast IDXGIDevice failed: {err:?}"))
    })?;

    let inspectable =
        unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device) }.map_err(|err| {
            RecorderError::DxgiCaptureFailed(format!(
                "CreateDirect3D11DeviceFromDXGIDevice failed: {err:?}"
            ))
        })?;

    inspectable.cast().map_err(|err| {
        RecorderError::DxgiCaptureFailed(format!("cast IDirect3DDevice failed: {err:?}"))
    })
}

fn create_capture_item_for_window(hwnd: HWND) -> Result<GraphicsCaptureItem, RecorderError> {
    let hwnd_key = hwnd.0 as isize;
    if let Ok(mut cache) = WGC_ITEM_CACHE.lock()
        && let Some(entry) = cache.iter_mut().find(|entry| entry.hwnd == hwnd_key)
    {
        entry.last_used = WGC_ITEM_CACHE_CLOCK.fetch_add(1, Ordering::Relaxed);
        return Ok(entry.item.clone());
    }

    let class_name = HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureItem");
    let interop: IGraphicsCaptureItemInterop = unsafe { RoGetActivationFactory(&class_name) }
        .map_err(|err| {
            RecorderError::DxgiCaptureFailed(format!("RoGetActivationFactory failed: {err:?}"))
        })?;

    let item =
        unsafe { interop.CreateForWindow::<HWND, GraphicsCaptureItem>(hwnd) }.map_err(|err| {
            RecorderError::DxgiCaptureFailed(format!("CreateForWindow failed: {err:?}"))
        })?;

    if let Ok(mut cache) = WGC_ITEM_CACHE.lock() {
        cache.push(WgcItemCacheEntry {
            hwnd: hwnd_key,
            item: item.clone(),
            last_used: WGC_ITEM_CACHE_CLOCK.fetch_add(1, Ordering::Relaxed),
        });
        if cache.len() > WGC_ITEM_CACHE_CAPACITY {
            let lru_index = cache
                .iter()
                .enumerate()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(index, _)| index)
                .unwrap_or(0);
            cache.remove(lru_index);
        }
    }

    Ok(item)
}

fn wait_next_frame(
    frame_pool: &Direct3D11CaptureFramePool,
) -> Result<windows::Graphics::Capture::Direct3D11CaptureFrame, RecorderError> {
    let deadline = Instant::now() + WGC_NEXT_FRAME_TIMEOUT;
    loop {
        match frame_pool.TryGetNextFrame() {
            Ok(frame) => return Ok(frame),
            Err(err) => {
                if Instant::now() >= deadline {
                    return Err(RecorderError::DxgiCaptureFailed(format!(
                        "WGC TryGetNextFrame timeout: {err:?}"
                    )));
                }
                std::thread::sleep(WGC_NEXT_FRAME_INTERVAL);
            }
        }
    }
}

struct DesktopFrame {
    width: u32,
    height: u32,
    data: Vec<u8>,
    frame_delta_hint: FrameDeltaHint,
}

fn copy_surface_to_cpu_bgra(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    surface: &IDirect3DSurface,
    content_size: SizeInt32,
    frame_delta_hint: FrameDeltaHint,
) -> Result<DesktopFrame, RecorderError> {
    let access: IDirect3DDxgiInterfaceAccess = surface.cast().map_err(|err| {
        RecorderError::DxgiCaptureFailed(format!(
            "cast IDirect3DDxgiInterfaceAccess failed: {err:?}"
        ))
    })?;

    let texture: ID3D11Texture2D = unsafe { access.GetInterface() }.map_err(|err| {
        RecorderError::DxgiCaptureFailed(format!("GetInterface texture failed: {err:?}"))
    })?;

    let mut source_desc = D3D11_TEXTURE2D_DESC::default();
    unsafe {
        texture.GetDesc(&mut source_desc);
    }

    let width = (content_size.Width.max(1) as u32).min(source_desc.Width.max(1));
    let height = (content_size.Height.max(1) as u32).min(source_desc.Height.max(1));

    let staging_desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
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

    let mut staging: Option<ID3D11Texture2D> = None;
    unsafe {
        device
            .CreateTexture2D(&staging_desc, None, Some(&mut staging))
            .map_err(|err| {
                RecorderError::DxgiCaptureFailed(format!("CreateTexture2D failed: {err:?}"))
            })?;
    }
    let staging = staging.ok_or_else(|| {
        RecorderError::DxgiCaptureFailed("WGC CreateTexture2D returned null".to_string())
    })?;

    unsafe {
        context.CopySubresourceRegion(
            &staging,
            0,
            0,
            0,
            0,
            &texture,
            0,
            Some(&windows::Win32::Graphics::Direct3D11::D3D11_BOX {
                left: 0,
                top: 0,
                front: 0,
                right: width,
                bottom: height,
                back: 1,
            }),
        );
    }

    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    if let Err(err) = unsafe { context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) } {
        return Err(RecorderError::DxgiCaptureFailed(format!(
            "WGC Map failed: {err:?}"
        )));
    }

    let row_pitch = mapped.RowPitch as usize;
    let width_usize = width as usize;
    let height_usize = height as usize;
    let mut data = vec![0u8; width_usize * height_usize * 4];

    unsafe {
        let src = mapped.pData as *const u8;
        for row in 0..height_usize {
            let src_row = src.add(row * row_pitch);
            let dst_offset = row * width_usize * 4;
            std::ptr::copy_nonoverlapping(
                src_row,
                data[dst_offset..dst_offset + width_usize * 4].as_mut_ptr(),
                width_usize * 4,
            );
        }
        context.Unmap(&staging, 0);
    }

    Ok(DesktopFrame {
        width,
        height,
        data,
        frame_delta_hint,
    })
}

#[cfg(test)]
mod tests {
    use super::resolve_wgc_retry_result;
    use crate::error::RecorderError;
    use crate::retry::RetryFailure;

    #[test]
    fn resolve_wgc_retry_result_preserves_success_payload() {
        let resolved = resolve_wgc_retry_result::<u32>(Ok(42u32));
        assert_eq!(resolved.ok(), Some(42u32));
    }

    #[test]
    fn resolve_wgc_retry_result_uses_first_error_context() {
        let resolved = resolve_wgc_retry_result::<u32>(Err(RetryFailure {
            first: RecorderError::DxgiCaptureFailed("first".to_string()),
            second: RecorderError::DxgiCaptureFailed("second".to_string()),
        }));

        match resolved {
            Err(RecorderError::DxgiCaptureFailed(message)) => {
                assert!(message.contains("first"));
                assert!(!message.contains("second"));
            }
            _ => panic!("expected DxgiCaptureFailed after retry failure"),
        }
    }

    #[test]
    fn resolve_wgc_retry_result_normalizes_error_variant() {
        let resolved = resolve_wgc_retry_result::<u32>(Err(RetryFailure {
            first: RecorderError::WindowApiFailed("window".to_string()),
            second: RecorderError::DxgiCaptureFailed("dxgi".to_string()),
        }));

        assert!(matches!(resolved, Err(RecorderError::DxgiCaptureFailed(_))));
    }
}
