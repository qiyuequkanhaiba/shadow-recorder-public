//! Lightweight L4 business alias mapping for step titles.
//! Rules are loaded from optional JSON; failures never block capture.

use std::fs;
use std::path::Path;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use crate::session::models::TestSessionStepRecord;

static ACTIVE_PROFILE: Lazy<Mutex<Option<SemanticAliasProfile>>> = Lazy::new(|| Mutex::new(None));

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticAliasProfile {
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub rules: Vec<SemanticAliasRule>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticAliasRule {
    // public fields for NAPI mapping
    #[serde(default)]
    pub match_control_name: Option<String>,
    #[serde(default)]
    pub match_automation_id: Option<String>,
    #[serde(default)]
    pub match_window_title_contains: Option<String>,
    #[serde(default)]
    pub match_title_contains: Option<String>,
    #[serde(default)]
    pub alias: Option<String>,
    #[serde(default)]
    pub alias_prefix: Option<String>,
}

pub fn set_active_profile(profile: Option<SemanticAliasProfile>) {
    if let Ok(mut guard) = ACTIVE_PROFILE.lock() {
        *guard = profile;
    }
}

pub fn active_profile() -> Option<SemanticAliasProfile> {
    ACTIVE_PROFILE.lock().ok().and_then(|guard| guard.clone())
}

pub fn load_profile_from_path(path: &Path) -> Option<SemanticAliasProfile> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn load_profile_for_session(session_dir: Option<&str>) -> Option<SemanticAliasProfile> {
    if let Some(active) = active_profile() {
        return Some(active);
    }
    let session_dir = session_dir?;
    let candidates = [
        Path::new(session_dir).join("semantic-alias.json"),
        Path::new(session_dir)
            .join("..")
            .join("semantic-alias.json"),
    ];
    for candidate in candidates {
        if candidate.exists()
            && let Some(profile) = load_profile_from_path(&candidate)
        {
            return Some(profile);
        }
    }
    None
}

pub fn apply_aliases_to_steps(
    steps: &mut [TestSessionStepRecord],
    profile: Option<&SemanticAliasProfile>,
) {
    let Some(profile) = profile else {
        return;
    };
    if profile.rules.is_empty() {
        return;
    }

    for step in steps.iter_mut() {
        if step.edited {
            continue;
        }
        if let Some(alias_title) = resolve_alias(step, profile) {
            if step.original_title.is_none() {
                step.original_title = Some(step.title.clone());
            }
            step.business_alias = Some(alias_title.clone());
            step.title = alias_title.clone();
            step.summary = alias_title;
            if step.precision_level == "l2" || step.precision_level == "l3" {
                step.precision_level = "l4".to_string();
                step.confidence = step.confidence.max(0.90);
            }
        }
    }
}

fn resolve_alias(step: &TestSessionStepRecord, profile: &SemanticAliasProfile) -> Option<String> {
    for rule in &profile.rules {
        if !rule_matches(step, rule) {
            continue;
        }
        if let Some(alias) = rule
            .alias
            .as_ref()
            .map(|value| value.trim())
            .filter(|v| !v.is_empty())
        {
            return Some(alias.to_string());
        }
        if let Some(prefix) = rule
            .alias_prefix
            .as_ref()
            .map(|value| value.trim())
            .filter(|v| !v.is_empty())
        {
            return Some(format!("{prefix}{}", step.title));
        }
    }
    None
}

fn automation_id_matches_alias(expected: &str, actual: &str) -> bool {
    // Keep in sync with semantic_profile::automation_id_matches.
    let expected = expected.trim();
    let actual = actual.trim();
    if expected.is_empty() || actual.is_empty() {
        return false;
    }
    if actual.eq_ignore_ascii_case(expected) {
        return true;
    }
    let expected_l = expected.to_ascii_lowercase();
    let actual_l = actual.to_ascii_lowercase();
    if actual_l.ends_with(&expected_l) {
        let prefix_len = actual_l.len().saturating_sub(expected_l.len());
        return prefix_len == 0 || actual_l.as_bytes().get(prefix_len - 1) == Some(&b'.');
    }
    if expected_l.ends_with(&actual_l) {
        let prefix_len = expected_l.len().saturating_sub(actual_l.len());
        return prefix_len == 0 || expected_l.as_bytes().get(prefix_len - 1) == Some(&b'.');
    }
    let expected_leaf = expected_l.rsplit('.').next().unwrap_or("");
    let actual_leaf = actual_l.rsplit('.').next().unwrap_or("");
    if !expected_leaf.is_empty() && expected_leaf == actual_leaf && expected_leaf.len() >= 6 {
        return true;
    }
    if let Some(idx) = [
        "btn.", "txt.", "rad.", "chk.", "cmb.", "spin.", "lbl.", "menu.", "radio.",
    ]
    .iter()
    .filter_map(|m| actual_l.rfind(m))
    .max()
    {
        let actual_suffix = &actual_l[idx..];
        if actual_suffix.len() >= 18
            && (expected_l == actual_suffix || expected_l.starts_with(actual_suffix))
        {
            return true;
        }
    }
    false
}

fn rule_matches(step: &TestSessionStepRecord, rule: &SemanticAliasRule) -> bool {
    let mut matched_any_condition = false;

    if let Some(expected) = rule
        .match_control_name
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        matched_any_condition = true;
        let actual = step.control_name.as_deref().unwrap_or("");
        if !actual.eq_ignore_ascii_case(expected) {
            return false;
        }
    }

    if let Some(expected) = rule
        .match_automation_id
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        matched_any_condition = true;
        let actual = step.automation_id.as_deref().unwrap_or("");
        if !automation_id_matches_alias(expected, actual) {
            return false;
        }
    }

    if let Some(needle) = rule
        .match_window_title_contains
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        matched_any_condition = true;
        let hay = step.window_title.as_deref().unwrap_or("");
        if !contains_ignore_case(hay, needle) {
            return false;
        }
    }

    if let Some(needle) = rule
        .match_title_contains
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        matched_any_condition = true;
        if !contains_ignore_case(&step.title, needle) {
            return false;
        }
    }

    matched_any_condition
}

fn contains_ignore_case(haystack: &str, needle: &str) -> bool {
    haystack
        .to_ascii_lowercase()
        .contains(&needle.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::models::TEST_SESSION_SCHEMA_VERSION;

    fn sample_step(title: &str, control: Option<&str>) -> TestSessionStepRecord {
        TestSessionStepRecord {
            schema_version: TEST_SESSION_SCHEMA_VERSION,
            kind: "reqcase.test-session-step".to_string(),
            step_id: "step-1".to_string(),
            session_id: "ts-1".to_string(),
            started_at_ms: 1,
            ended_at_ms: 1,
            relative_ms_from_session_start: 1,
            step_type: "click".to_string(),
            title: title.to_string(),
            summary: title.to_string(),
            process_name: None,
            window_title: Some("订单管理".to_string()),
            control_name: control.map(|value| value.to_string()),
            control_type: Some("Button".to_string()),
            automation_id: Some("btnSave".to_string()),
            class_name: None,
            x: None,
            y: None,
            display_id: None,
            precision_level: "l2".to_string(),
            confidence: 0.86,
            source_event_ids: vec![],
            artifact_refs: vec![],
            full_image_path: None,
            thumb_image_path: None,
            edited: false,
            original_title: None,
            business_alias: None,
        }
    }

    #[test]
    fn applies_control_name_alias() {
        let profile = SemanticAliasProfile {
            profile_id: Some("demo".to_string()),
            rules: vec![SemanticAliasRule {
                match_control_name: Some("保存".to_string()),
                alias: Some("保存订单".to_string()),
                ..SemanticAliasRule::default()
            }],
        };
        let mut steps = vec![sample_step("点击按钮「保存」", Some("保存"))];
        apply_aliases_to_steps(&mut steps, Some(&profile));
        assert_eq!(steps[0].title, "保存订单");
        assert_eq!(steps[0].precision_level, "l4");
        assert_eq!(steps[0].original_title.as_deref(), Some("点击按钮「保存」"));
    }

    #[test]
    fn skips_edited_steps() {
        let profile = SemanticAliasProfile {
            profile_id: None,
            rules: vec![SemanticAliasRule {
                match_title_contains: Some("保存".to_string()),
                alias: Some("业务保存".to_string()),
                ..SemanticAliasRule::default()
            }],
        };
        let mut step = sample_step("点击按钮「保存」", Some("保存"));
        step.edited = true;
        let mut steps = vec![step];
        apply_aliases_to_steps(&mut steps, Some(&profile));
        assert_eq!(steps[0].title, "点击按钮「保存」");
    }
}
