use std::io::Cursor;

use base64::Engine;
use image::ImageEncoder;
use image::codecs::png::PngEncoder;

use crate::dxgi::{
    capture_monitor_bgra_for_screenshot, monitor_rect_at_point, window_rect_at_point,
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
    let (selection, monitor) = match request.mode.as_str() {
        "monitor" => {
            let monitor = monitor_rect_at_point(request.x, request.y).map_err(|err| err.to_string())?;
            (rect_from_bounds(monitor).ok_or("屏幕区域无效")?, monitor)
        }
        "window" => {
            let (window, monitor) =
                window_rect_at_point(request.x, request.y).map_err(|err| err.to_string())?;
            (rect_from_bounds(window).ok_or("窗口区域无效")?, monitor)
        }
        "region" => {
            if request.width == 0 || request.height == 0 {
                return Err("选区太小".to_string());
            }
            let center_x = request.x.saturating_add((request.width / 2) as i32);
            let center_y = request.y.saturating_add((request.height / 2) as i32);
            let monitor =
                monitor_rect_at_point(center_x, center_y).map_err(|err| err.to_string())?;
            (
                ScreenshotRect {
                    x: request.x,
                    y: request.y,
                    width: request.width,
                    height: request.height,
                },
                monitor,
            )
        }
        _ => return Err("未知截图模式".to_string()),
    };

    let frame = capture_monitor_bgra_for_screenshot(monitor).map_err(|err| err.to_string())?;
    let (png, width, height, origin_x, origin_y) = compose_screenshot_png(
        &frame.bgra,
        frame.width,
        frame.height,
        frame.origin_x,
        frame.origin_y,
        selection,
        request.privacy_enabled,
        &request.masks,
    )?;
    Ok(ScreenshotCaptureOutput {
        png_base64: base64::engine::general_purpose::STANDARD.encode(png),
        width,
        height,
        origin_x,
        origin_y,
    })
}

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
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }
    let mut png = Vec::new();
    PngEncoder::new(Cursor::new(&mut png))
        .write_image(
            &rgba,
            width,
            height,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|err| err.to_string())?;
    Ok(png)
}

#[cfg(test)]
mod tests {
    use super::{
        ScreenshotRect, clip_rect_to_frame, compose_screenshot_png, crop_bgra, paint_solid_masks,
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
            &[mask.clone()],
        )
        .expect("masked png");
        assert_eq!((width, height, origin_x, origin_y), (2, 2, 10, 10));
        let masked = image::load_from_memory(&png)
            .expect("decode masked png")
            .to_rgba8();
        assert_eq!(masked.get_pixel(0, 0).0, [3, 2, 1, 255]);
        assert_eq!(masked.get_pixel(1, 0).0, [0, 0, 0, 255]);

        let (plain, _, _, _, _) = compose_screenshot_png(
            &pixels, 2, 2, 10, 10, selection, false, &[mask],
        )
        .expect("plain png");
        let decoded = image::load_from_memory(&plain)
            .expect("decode plain png")
            .to_rgba8();
        assert_eq!(decoded.get_pixel(1, 0).0, [6, 5, 4, 255]);
    }
}
