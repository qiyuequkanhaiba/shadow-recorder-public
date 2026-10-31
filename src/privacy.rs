use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub label: String,
}

pub const DEFAULT_SEMANTIC_LABEL_MAX_CHARS: usize = 120;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PrivacyPolicy {
    pub enabled: bool,
    pub excluded_window_title_keywords: Vec<String>,
    pub excluded_process_names: Vec<String>,
    pub mask_regions: Vec<MaskRegion>,
}

impl PrivacyPolicy {
    pub fn should_exclude_window(&self, process_name: &str, window_title: &str) -> bool {
        if !self.enabled {
            return false;
        }

        matches_any_keyword(process_name, &self.excluded_process_names)
            || matches_any_keyword(window_title, &self.excluded_window_title_keywords)
    }

    pub fn should_exclude_semantic_text(
        &self,
        process_name: Option<&str>,
        window_title: Option<&str>,
        label: Option<&str>,
    ) -> bool {
        if !self.enabled {
            return false;
        }

        process_name
            .map(|value| matches_any_keyword(value, &self.excluded_process_names))
            .unwrap_or(false)
            || window_title
                .map(|value| matches_any_keyword(value, &self.excluded_window_title_keywords))
                .unwrap_or(false)
            || label
                .map(|value| matches_any_keyword(value, &self.excluded_window_title_keywords))
                .unwrap_or(false)
    }
}

pub fn truncate_semantic_label(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if max_chars == 0 || trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    if max_chars <= 3 {
        return ".".repeat(max_chars);
    }

    let keep_chars = max_chars.saturating_sub(3);
    let mut truncated = trimmed.chars().take(keep_chars).collect::<String>();
    truncated.push_str("...");
    truncated
}

fn matches_any_keyword(value: &str, keywords: &[String]) -> bool {
    let value = value.to_ascii_lowercase();
    keywords
        .iter()
        .map(|keyword| keyword.trim().to_ascii_lowercase())
        .any(|keyword| !keyword.is_empty() && value.contains(&keyword))
}

impl PrivacyPolicy {
    pub fn apply_masks(&self, rgba: &mut [u8], width: u32, height: u32) -> bool {
        if !self.enabled || rgba.is_empty() || width == 0 || height == 0 {
            return false;
        }

        let expected_len = usize::try_from(width)
            .unwrap_or(0)
            .saturating_mul(usize::try_from(height).unwrap_or(0))
            .saturating_mul(4);
        if rgba.len() < expected_len {
            return false;
        }

        let mut changed = false;
        for region in &self.mask_regions {
            changed |= apply_mask_region(rgba, width, height, region);
        }
        changed
    }
}

fn apply_mask_region(rgba: &mut [u8], width: u32, height: u32, region: &MaskRegion) -> bool {
    if region.width == 0 || region.height == 0 || region.x >= width || region.y >= height {
        return false;
    }

    let end_x = region.x.saturating_add(region.width).min(width);
    let end_y = region.y.saturating_add(region.height).min(height);
    let stride = width as usize;
    for y in region.y..end_y {
        for x in region.x..end_x {
            let offset = ((y as usize * stride) + x as usize) * 4;
            rgba[offset] = 0;
            rgba[offset + 1] = 0;
            rgba[offset + 2] = 0;
            rgba[offset + 3] = 255;
        }
    }
    true
}

pub fn build_video_privacy_drawbox_filter(
    enabled: bool,
    masks: &[MaskRegion],
    offset_x: i32,
    offset_y: i32,
    capture_width: u32,
    capture_height: u32,
) -> Option<String> {
    if !enabled || capture_width == 0 || capture_height == 0 {
        return None;
    }

    let mut filters = Vec::new();
    for mask in masks {
        let Some((x, y, width, height)) =
            clip_mask_to_capture(mask, offset_x, offset_y, capture_width, capture_height)
        else {
            continue;
        };
        filters.push(format!(
            "drawbox=x={x}:y={y}:w={width}:h={height}:color=black:t=fill"
        ));
    }

    if filters.is_empty() {
        None
    } else {
        Some(filters.join(","))
    }
}

fn clip_mask_to_capture(
    mask: &MaskRegion,
    offset_x: i32,
    offset_y: i32,
    capture_width: u32,
    capture_height: u32,
) -> Option<(u32, u32, u32, u32)> {
    if mask.width == 0 || mask.height == 0 {
        return None;
    }

    let x0 = i64::from(mask.x) - i64::from(offset_x);
    let y0 = i64::from(mask.y) - i64::from(offset_y);
    let x1 = x0 + i64::from(mask.width);
    let y1 = y0 + i64::from(mask.height);
    let clip_x0 = x0.max(0);
    let clip_y0 = y0.max(0);
    let clip_x1 = x1.min(i64::from(capture_width));
    let clip_y1 = y1.min(i64::from(capture_height));
    if clip_x1 <= clip_x0 || clip_y1 <= clip_y0 {
        return None;
    }

    Some((
        u32::try_from(clip_x0).unwrap_or(0),
        u32::try_from(clip_y0).unwrap_or(0),
        u32::try_from(clip_x1 - clip_x0).unwrap_or(0),
        u32::try_from(clip_y1 - clip_y0).unwrap_or(0),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_policy_does_not_exclude_or_mask() {
        let policy = PrivacyPolicy::default();
        let mut rgba = vec![255; 2 * 2 * 4];

        assert!(!policy.should_exclude_window("secret.exe", "Password Manager"));
        assert!(!policy.apply_masks(&mut rgba, 2, 2));
        assert_eq!(rgba, vec![255; 2 * 2 * 4]);
    }

    #[test]
    fn enabled_policy_excludes_process_and_title_keywords_case_insensitively() {
        let policy = PrivacyPolicy {
            enabled: true,
            excluded_window_title_keywords: vec!["password".to_string()],
            excluded_process_names: vec!["secret.exe".to_string()],
            mask_regions: Vec::new(),
        };

        assert!(policy.should_exclude_window("SECRET.EXE", "safe title"));
        assert!(policy.should_exclude_window("other.exe", "Password Manager"));
        assert!(!policy.should_exclude_window("other.exe", "safe title"));
        assert!(policy.should_exclude_semantic_text(
            Some("other.exe"),
            Some("safe title"),
            Some("Password field")
        ));
    }

    #[test]
    fn semantic_label_truncation_keeps_stable_char_limit() {
        let value = "abcdef";
        assert_eq!(truncate_semantic_label(value, 4), "a...");
        assert_eq!(truncate_semantic_label(" ok ", 120), "ok");
    }

    #[test]
    fn enabled_policy_masks_configured_regions() {
        let policy = PrivacyPolicy {
            enabled: true,
            excluded_window_title_keywords: Vec::new(),
            excluded_process_names: Vec::new(),
            mask_regions: vec![MaskRegion {
                x: 1,
                y: 0,
                width: 2,
                height: 2,
                label: "token".to_string(),
            }],
        };
        let mut rgba = vec![255; 3 * 2 * 4];

        assert!(policy.apply_masks(&mut rgba, 3, 2));

        assert_eq!(&rgba[0..4], &[255, 255, 255, 255]);
        assert_eq!(&rgba[4..8], &[0, 0, 0, 255]);
        assert_eq!(&rgba[8..12], &[0, 0, 0, 255]);
        assert_eq!(&rgba[12..16], &[255, 255, 255, 255]);
        assert_eq!(&rgba[16..20], &[0, 0, 0, 255]);
        assert_eq!(&rgba[20..24], &[0, 0, 0, 255]);
    }

    fn mask(x: u32, y: u32, width: u32, height: u32) -> MaskRegion {
        MaskRegion {
            x,
            y,
            width,
            height,
            label: String::new(),
        }
    }

    #[test]
    fn video_privacy_filter_is_absent_until_privacy_is_enabled() {
        let filter =
            build_video_privacy_drawbox_filter(false, &[mask(10, 20, 30, 40)], 0, 0, 100, 100);
        assert_eq!(filter, None);
    }

    #[test]
    fn video_privacy_filter_draws_boxes_inside_the_capture() {
        let filter =
            build_video_privacy_drawbox_filter(true, &[mask(10, 20, 30, 40)], 0, 0, 200, 200);
        assert_eq!(
            filter.as_deref(),
            Some("drawbox=x=10:y=20:w=30:h=40:color=black:t=fill")
        );
    }

    #[test]
    fn video_privacy_filter_subtracts_capture_origin_and_clips() {
        let filter = build_video_privacy_drawbox_filter(
            true,
            &[mask(80, 40, 50, 30), mask(0, 0, 10, 10), mask(0, 0, 0, 20)],
            100,
            50,
            200,
            100,
        );
        assert_eq!(
            filter.as_deref(),
            Some("drawbox=x=0:y=0:w=30:h=20:color=black:t=fill")
        );
    }

    #[test]
    fn video_privacy_filter_joins_multiple_boxes() {
        let filter = build_video_privacy_drawbox_filter(
            true,
            &[mask(1, 2, 3, 4), mask(5, 6, 7, 8)],
            0,
            0,
            100,
            100,
        );
        assert_eq!(
            filter.as_deref(),
            Some(
                "drawbox=x=1:y=2:w=3:h=4:color=black:t=fill,drawbox=x=5:y=6:w=7:h=8:color=black:t=fill"
            )
        );
    }
}
