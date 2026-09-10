#[derive(Debug, Clone, PartialEq, Eq, Default)]
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
}
