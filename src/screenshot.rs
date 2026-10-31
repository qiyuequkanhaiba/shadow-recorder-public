use std::io::Cursor;

use base64::Engine;
use image::ImageEncoder;
use image::codecs::png::PngEncoder;

use crate::dxgi::{
    ScreenshotMonitorFrame, capture_monitor_bgra_for_screenshot, list_monitor_rects,
    monitor_rect_at_point, window_rect_at_point,
};
use crate::privacy::MaskRegion;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenshotRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub struct ScreenshotCaptureRequest {
    pub mode: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub privacy_enabled: bool,
    pub masks: Vec<MaskRegion>,
}

pub struct ScreenshotCaptureOutput {
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
    pub origin_x: i32,
    pub origin_y: i32,
}

pub fn capture_screenshot(
    request: ScreenshotCaptureRequest,
) -> Result<ScreenshotCaptureOutput, String> {
    let selection = match request.mode.as_str() {
        "monitor" => {
            let monitor =
                monitor_rect_at_point(request.x, request.y).map_err(|err| err.to_string())?;
            rect_from_bounds(monitor).ok_or("屏幕区域无效")?
        }
        "window" => {
            let (window, _) =
                window_rect_at_point(request.x, request.y).map_err(|err| err.to_string())?;
            rect_from_bounds(window).ok_or("窗口区域无效")?
        }
        "region" => {
            if request.width == 0 || request.height == 0 {
                return Err("选区太小".to_string());
            }
            ScreenshotRect {
                x: request.x,
                y: request.y,
                width: request.width,
                height: request.height,
            }
        }
        _ => return Err("未知截图模式".to_string()),
    };
    let pixel_count = (selection.width as u64).saturating_mul(selection.height as u64);
    if pixel_count == 0 {
        return Err("选区太小".to_string());
    }
    if pixel_count > 32_000_000 {
        return Err("选区太大".to_string());
    }
    if let Ok(pixels) = capture_rect_gdi(&selection) {
        return finish_screenshot(selection, pixels, request.privacy_enabled, &request.masks);
    }
    capture_region_across_monitors(selection, request.privacy_enabled, &request.masks)
}

fn finish_screenshot(
    selection: ScreenshotRect,
    mut pixels: Vec<u8>,
    privacy_enabled: bool,
    masks: &[MaskRegion],
) -> Result<ScreenshotCaptureOutput, String> {
    let expected = (selection.width as usize)
        .checked_mul(selection.height as usize)
        .and_then(|count| count.checked_mul(4))
        .ok_or("选区太大")?;
    if pixels.len() < expected {
        return Err("截图数据不完整".to_string());
    }
    pixels.truncate(expected);
    if privacy_enabled {
        paint_solid_masks(
            &mut pixels,
            selection.width,
            selection.height,
            selection.x,
            selection.y,
            masks,
        );
    }
    let png = encode_png_from_bgra(&pixels, selection.width, selection.height)?;
    Ok(ScreenshotCaptureOutput {
        png_base64: base64::engine::general_purpose::STANDARD.encode(png),
        width: selection.width,
        height: selection.height,
        origin_x: selection.x,
        origin_y: selection.y,
    })
}

fn capture_rect_gdi(selection: &ScreenshotRect) -> Result<Vec<u8>, String> {
    use std::ffi::c_void;

    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleDC,
        CreateDIBSection, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, HGDIOBJ, ReleaseDC,
        SRCCOPY, SelectObject,
    };

    let width = i32::try_from(selection.width).map_err(|_| "选区太大")?;
    let height = i32::try_from(selection.height).map_err(|_| "选区太大")?;
    if width <= 0 || height <= 0 {
        return Err("选区太小".to_string());
    }

    unsafe {
        let desktop = HWND(std::ptr::null_mut());
        let screen = GetDC(desktop);
        if screen.is_invalid() {
            return Err("无法读取屏幕".to_string());
        }
        let memory = CreateCompatibleDC(screen);
        if memory.is_invalid() {
            let _ = ReleaseDC(desktop, screen);
            return Err("无法创建截图画布".to_string());
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        let bitmap = match CreateDIBSection(memory, &info, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(bitmap) if !bits.is_null() => bitmap,
            _ => {
                let _ = DeleteDC(memory);
                let _ = ReleaseDC(desktop, screen);
                return Err("无法创建截图位图".to_string());
            }
        };
        let previous = SelectObject(memory, HGDIOBJ(bitmap.0));
        let copied = BitBlt(
            memory,
            0,
            0,
            width,
            height,
            screen,
            selection.x,
            selection.y,
            SRCCOPY | CAPTUREBLT,
        );
        let byte_len = (width as usize)
            .saturating_mul(height as usize)
            .saturating_mul(4);
        let mut pixels = vec![0u8; byte_len];
        if copied.is_ok() && byte_len > 0 {
            std::ptr::copy_nonoverlapping(bits as *const u8, pixels.as_mut_ptr(), byte_len);
            for pixel in pixels.chunks_exact_mut(4) {
                pixel[3] = 255;
            }
        }
        if !previous.is_invalid() {
            SelectObject(memory, previous);
        }
        let _ = DeleteObject(bitmap);
        let _ = DeleteDC(memory);
        let _ = ReleaseDC(desktop, screen);
        copied.map_err(|err| err.to_string())?;
        Ok(pixels)
    }
}

#[allow(dead_code)] // screenshot unit tests call this; the recording path does not
pub fn clip_rect_to_frame(
    selection: ScreenshotRect,
    frame_width: u32,
    frame_height: u32,
    origin_x: i32,
    origin_y: i32,
) -> Option<ScreenshotRect> {
    if selection.width == 0 || selection.height == 0 || frame_width == 0 || frame_height == 0 {
        return None;
    }
    let frame_right = origin_x.saturating_add(frame_width as i32);
    let frame_bottom = origin_y.saturating_add(frame_height as i32);
    let selection_right = selection.x.saturating_add(selection.width as i32);
    let selection_bottom = selection.y.saturating_add(selection.height as i32);
    let left = selection.x.max(origin_x);
    let top = selection.y.max(origin_y);
    let right = selection_right.min(frame_right);
    let bottom = selection_bottom.min(frame_bottom);
    if right <= left || bottom <= top {
        return None;
    }
    Some(ScreenshotRect {
        x: left - origin_x,
        y: top - origin_y,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    })
}

#[allow(dead_code)] // screenshot unit tests call this; the recording path does not
pub fn crop_bgra(
    pixels: &[u8],
    frame_width: u32,
    frame_height: u32,
    local: ScreenshotRect,
) -> Option<Vec<u8>> {
    if local.width == 0 || local.height == 0 || local.x < 0 || local.y < 0 {
        return None;
    }
    let right = local.x.checked_add(local.width as i32)?;
    let bottom = local.y.checked_add(local.height as i32)?;
    if right > frame_width as i32 || bottom > frame_height as i32 {
        return None;
    }
    let expected = (frame_width as usize)
        .checked_mul(frame_height as usize)?
        .checked_mul(4)?;
    if pixels.len() < expected {
        return None;
    }
    let mut cropped = Vec::with_capacity(local.width as usize * local.height as usize * 4);
    for row in local.y as u32..(local.y as u32 + local.height) {
        let start = (row as usize * frame_width as usize + local.x as usize) * 4;
        let end = start + local.width as usize * 4;
        cropped.extend_from_slice(&pixels[start..end]);
    }
    Some(cropped)
}

pub fn paint_solid_masks(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    origin_x: i32,
    origin_y: i32,
    masks: &[MaskRegion],
) {
    if width == 0 || height == 0 {
        return;
    }
    for mask in masks {
        if mask.width == 0 || mask.height == 0 {
            continue;
        }
        let mask_left = mask.x as i32 - origin_x;
        let mask_top = mask.y as i32 - origin_y;
        let mask_right = mask_left.saturating_add(mask.width as i32);
        let mask_bottom = mask_top.saturating_add(mask.height as i32);
        let left = mask_left.max(0).min(width as i32);
        let top = mask_top.max(0).min(height as i32);
        let right = mask_right.max(0).min(width as i32);
        let bottom = mask_bottom.max(0).min(height as i32);
        if right <= left || bottom <= top {
            continue;
        }
        for y in top..bottom {
            for x in left..right {
                let offset = ((y as usize * width as usize) + x as usize) * 4;
                if offset + 3 < pixels.len() {
                    pixels[offset] = 0;
                    pixels[offset + 1] = 0;
                    pixels[offset + 2] = 0;
                    pixels[offset + 3] = 255;
                }
            }
        }
    }
}

#[allow(dead_code)] // screenshot unit tests call this; the recording path does not
#[allow(clippy::too_many_arguments)] // one crop needs frame size, origin, selection, and privacy masks
pub fn compose_screenshot_png(
    pixels: &[u8],
    frame_width: u32,
    frame_height: u32,
    origin_x: i32,
    origin_y: i32,
    selection: ScreenshotRect,
    privacy_enabled: bool,
    masks: &[MaskRegion],
) -> Result<(Vec<u8>, u32, u32, i32, i32), String> {
    let local = clip_rect_to_frame(selection, frame_width, frame_height, origin_x, origin_y)
        .ok_or("选区超出屏幕")?;
    let mut cropped = crop_bgra(pixels, frame_width, frame_height, local).ok_or("选区超出屏幕")?;
    let screen_x = origin_x + local.x;
    let screen_y = origin_y + local.y;
    if privacy_enabled {
        paint_solid_masks(
            &mut cropped,
            local.width,
            local.height,
            screen_x,
            screen_y,
            masks,
        );
    }
    let png = encode_png_from_bgra(&cropped, local.width, local.height)?;
    Ok((png, local.width, local.height, screen_x, screen_y))
}

fn capture_region_across_monitors(
    selection: ScreenshotRect,
    privacy_enabled: bool,
    masks: &[MaskRegion],
) -> Result<ScreenshotCaptureOutput, String> {
    let pixel_count = (selection.width as u64).saturating_mul(selection.height as u64);
    if pixel_count == 0 {
        return Err("选区太小".to_string());
    }
    if pixel_count > 32_000_000 {
        return Err("选区太大".to_string());
    }
    let mut monitors = list_monitor_rects();
    if monitors.is_empty() {
        let center_x = selection.x.saturating_add((selection.width / 2) as i32);
        let center_y = selection.y.saturating_add((selection.height / 2) as i32);
        monitors.push(monitor_rect_at_point(center_x, center_y).map_err(|err| err.to_string())?);
    }
    let mut frames = Vec::new();
    for monitor in monitors {
        if !selection_intersects_bounds(
            selection,
            monitor.left,
            monitor.top,
            monitor.right,
            monitor.bottom,
        ) {
            continue;
        }
        frames.push(capture_monitor_bgra_for_screenshot(monitor).map_err(|err| err.to_string())?);
    }
    if frames.is_empty() {
        return Err("选区超出屏幕".to_string());
    }
    let (png, width, height, origin_x, origin_y) =
        composite_screenshot_png(&frames, selection, privacy_enabled, masks)?;
    Ok(ScreenshotCaptureOutput {
        png_base64: base64::engine::general_purpose::STANDARD.encode(png),
        width,
        height,
        origin_x,
        origin_y,
    })
}

pub fn composite_screenshot_png(
    frames: &[ScreenshotMonitorFrame],
    selection: ScreenshotRect,
    privacy_enabled: bool,
    masks: &[MaskRegion],
) -> Result<(Vec<u8>, u32, u32, i32, i32), String> {
    let mut pixels = composite_bgra_region(selection, frames).ok_or("选区超出屏幕")?;
    if privacy_enabled {
        paint_solid_masks(
            &mut pixels,
            selection.width,
            selection.height,
            selection.x,
            selection.y,
            masks,
        );
    }
    let png = encode_png_from_bgra(&pixels, selection.width, selection.height)?;
    Ok((
        png,
        selection.width,
        selection.height,
        selection.x,
        selection.y,
    ))
}

fn selection_intersects_bounds(
    selection: ScreenshotRect,
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
) -> bool {
    let selection_right = selection.x.saturating_add(selection.width as i32);
    let selection_bottom = selection.y.saturating_add(selection.height as i32);
    selection.x < right && selection_right > left && selection.y < bottom && selection_bottom > top
}

fn composite_bgra_region(
    selection: ScreenshotRect,
    frames: &[ScreenshotMonitorFrame],
) -> Option<Vec<u8>> {
    let width = selection.width as usize;
    let height = selection.height as usize;
    let mut output = vec![0u8; width.checked_mul(height)?.checked_mul(4)?];
    for pixel in output.chunks_exact_mut(4) {
        pixel[3] = 255;
    }
    let mut copied = false;
    for frame in frames {
        if blit_frame_into_selection(&mut output, selection, frame) {
            copied = true;
        }
    }
    if copied { Some(output) } else { None }
}

fn blit_frame_into_selection(
    output: &mut [u8],
    selection: ScreenshotRect,
    frame: &ScreenshotMonitorFrame,
) -> bool {
    let frame_right = frame.origin_x.saturating_add(frame.width as i32);
    let frame_bottom = frame.origin_y.saturating_add(frame.height as i32);
    let selection_right = selection.x.saturating_add(selection.width as i32);
    let selection_bottom = selection.y.saturating_add(selection.height as i32);
    let left = selection.x.max(frame.origin_x);
    let top = selection.y.max(frame.origin_y);
    let right = selection_right.min(frame_right);
    let bottom = selection_bottom.min(frame_bottom);
    if right <= left || bottom <= top {
        return false;
    }
    let Some(expected) = (frame.width as usize)
        .checked_mul(frame.height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
    else {
        return false;
    };
    if frame.bgra.len() < expected {
        return false;
    }
    for y in top..bottom {
        let src_x = (left - frame.origin_x) as usize;
        let src_y = (y - frame.origin_y) as usize;
        let dst_x = (left - selection.x) as usize;
        let dst_y = (y - selection.y) as usize;
        let row_bytes = (right - left) as usize * 4;
        let src_start = (src_y * frame.width as usize + src_x) * 4;
        let dst_start = (dst_y * selection.width as usize + dst_x) * 4;
        let Some(src_end) = src_start.checked_add(row_bytes) else {
            return false;
        };
        let Some(dst_end) = dst_start.checked_add(row_bytes) else {
            return false;
        };
        if src_end > frame.bgra.len() || dst_end > output.len() {
            return false;
        }
        output[dst_start..dst_end].copy_from_slice(&frame.bgra[src_start..src_end]);
    }
    true
}

fn rect_from_bounds(rect: crate::dxgi::Rect) -> Option<ScreenshotRect> {
    let width = rect.right.checked_sub(rect.left)?;
    let height = rect.bottom.checked_sub(rect.top)?;
    if width <= 0 || height <= 0 {
        return None;
    }
    Some(ScreenshotRect {
        x: rect.left,
        y: rect.top,
        width: width as u32,
        height: height as u32,
    })
}

fn encode_png_from_bgra(bgra: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut rgba = Vec::with_capacity(bgra.len());
    for pixel in bgra.chunks_exact(4) {
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
    }
    let mut png = Vec::new();
    PngEncoder::new(Cursor::new(&mut png))
        .write_image(&rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|err| err.to_string())?;
    Ok(png)
}

#[cfg(test)]
mod tests {
    use super::{
        ScreenshotRect, clip_rect_to_frame, compose_screenshot_png, composite_screenshot_png,
        crop_bgra, paint_solid_masks,
    };
    use crate::privacy::MaskRegion;

    fn pixel(b: u8, g: u8, r: u8) -> [u8; 4] {
        [b, g, r, 255]
    }

    #[test]
    fn clip_rect_to_frame_drops_the_part_outside_the_monitor() {
        let clipped = clip_rect_to_frame(
            ScreenshotRect {
                x: -10,
                y: 5,
                width: 30,
                height: 20,
            },
            100,
            50,
            0,
            0,
        )
        .expect("clipped selection");
        assert_eq!(
            clipped,
            ScreenshotRect {
                x: 0,
                y: 5,
                width: 20,
                height: 20,
            }
        );
        assert!(
            clip_rect_to_frame(
                ScreenshotRect {
                    x: 200,
                    y: 0,
                    width: 10,
                    height: 10,
                },
                100,
                50,
                0,
                0,
            )
            .is_none()
        );
    }

    #[test]
    fn crop_bgra_copies_only_the_selected_pixels() {
        let mut pixels = Vec::new();
        pixels.extend_from_slice(&pixel(1, 2, 3));
        pixels.extend_from_slice(&pixel(5, 6, 7));
        pixels.extend_from_slice(&pixel(9, 10, 11));
        pixels.extend_from_slice(&pixel(13, 14, 15));
        let cropped = crop_bgra(
            &pixels,
            2,
            2,
            ScreenshotRect {
                x: 1,
                y: 1,
                width: 1,
                height: 1,
            },
        )
        .expect("cropped pixel");
        assert_eq!(cropped, pixel(13, 14, 15));
    }

    #[test]
    fn paint_solid_masks_blacks_the_overlapping_rectangle() {
        let mut pixels = Vec::new();
        pixels.extend_from_slice(&pixel(1, 2, 3));
        pixels.extend_from_slice(&pixel(4, 5, 6));
        pixels.extend_from_slice(&pixel(7, 8, 9));
        pixels.extend_from_slice(&pixel(10, 11, 12));
        paint_solid_masks(
            &mut pixels,
            4,
            1,
            10,
            20,
            &[MaskRegion {
                x: 11,
                y: 20,
                width: 2,
                height: 1,
                label: "secret".to_string(),
            }],
        );
        assert_eq!(&pixels[0..4], &pixel(1, 2, 3));
        assert_eq!(&pixels[4..8], &[0, 0, 0, 255]);
        assert_eq!(&pixels[8..12], &[0, 0, 0, 255]);
        assert_eq!(&pixels[12..16], &pixel(10, 11, 12));
    }

    #[test]
    fn compose_screenshot_png_burns_masks_only_when_privacy_is_enabled() {
        let mut pixels = Vec::new();
        pixels.extend_from_slice(&pixel(1, 2, 3));
        pixels.extend_from_slice(&pixel(4, 5, 6));
        pixels.extend_from_slice(&pixel(7, 8, 9));
        pixels.extend_from_slice(&pixel(10, 11, 12));
        let mask = MaskRegion {
            x: 11,
            y: 10,
            width: 1,
            height: 1,
            label: String::new(),
        };
        let selection = ScreenshotRect {
            x: 10,
            y: 10,
            width: 2,
            height: 2,
        };
        let (png, width, height, origin_x, origin_y) = compose_screenshot_png(
            &pixels,
            2,
            2,
            10,
            10,
            selection,
            true,
            std::slice::from_ref(&mask),
        )
        .expect("masked png");
        assert_eq!((width, height, origin_x, origin_y), (2, 2, 10, 10));
        let masked = image::load_from_memory(&png)
            .expect("decode masked png")
            .to_rgba8();
        assert_eq!(masked.get_pixel(0, 0).0, [3, 2, 1, 255]);
        assert_eq!(masked.get_pixel(1, 0).0, [0, 0, 0, 255]);

        let (plain, _, _, _, _) =
            compose_screenshot_png(&pixels, 2, 2, 10, 10, selection, false, &[mask])
                .expect("plain png");
        let decoded = image::load_from_memory(&plain)
            .expect("decode plain png")
            .to_rgba8();
        assert_eq!(decoded.get_pixel(1, 0).0, [6, 5, 4, 255]);
    }

    #[test]
    fn composite_screenshot_png_stitches_adjacent_monitors() {
        use crate::dxgi::ScreenshotMonitorFrame;

        let left = ScreenshotMonitorFrame {
            origin_x: 0,
            origin_y: 0,
            width: 2,
            height: 1,
            bgra: vec![1, 2, 3, 255, 4, 5, 6, 255],
        };
        let right = ScreenshotMonitorFrame {
            origin_x: 2,
            origin_y: 0,
            width: 2,
            height: 1,
            bgra: vec![7, 8, 9, 255, 10, 11, 12, 255],
        };
        let (png, width, height, origin_x, origin_y) = composite_screenshot_png(
            &[left, right],
            ScreenshotRect {
                x: 1,
                y: 0,
                width: 2,
                height: 1,
            },
            true,
            &[MaskRegion {
                x: 2,
                y: 0,
                width: 1,
                height: 1,
                label: String::new(),
            }],
        )
        .expect("stitched png");
        assert_eq!((width, height, origin_x, origin_y), (2, 1, 1, 0));
        let image = image::load_from_memory(&png)
            .expect("decode stitched png")
            .to_rgba8();
        assert_eq!(image.get_pixel(0, 0).0, [6, 5, 4, 255]);
        assert_eq!(image.get_pixel(1, 0).0, [0, 0, 0, 255]);
    }
}
