//! Versioned application Semantic Profile (M6).
//!
//! Inspired by qttimer's SemanticProfile / ScenarioRule model:
//! - process-bound profiles
//! - alias rules for control identity → business labels
//! - scenario rules for action → expected completion signals
//!
//! Profiles never invent facts: they only interpret already-observed UIA identity
//! and state transitions. Load/parse failures never block capture.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use super::operation_models::{
    OperationAction, OperationOutcome, OperationOutcomeStatus, OperationReasonCode,
    StateTransition, TestSessionOperationRecord, UiElementIdentity,
};
use super::semantic_alias::{SemanticAliasProfile, SemanticAliasRule};

pub const SEMANTIC_PROFILE_SCHEMA_VERSION: u32 = 1;
pub const SEMANTIC_PROFILE_FILE_NAME: &str = "semantic-profile.json";
pub const SEMANTIC_PROFILE_SNAPSHOT_FILE_NAME: &str = "config.semantic-profile.snapshot.json";

static ACTIVE_SEMANTIC_PROFILE: Lazy<Mutex<Option<SemanticProfile>>> =
    Lazy::new(|| Mutex::new(None));

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticProfile {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub profile_id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub target_process_name: Option<String>,
    #[serde(default = "default_enabled_true")]
    pub enabled: bool,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub alias_rules: Vec<SemanticProfileAliasRule>,
    #[serde(default)]
    pub scenario_rules: Vec<SemanticScenarioRule>,
}

fn default_schema_version() -> u32 {
    SEMANTIC_PROFILE_SCHEMA_VERSION
}

fn default_enabled_true() -> bool {
    true
}

impl Default for SemanticProfile {
    fn default() -> Self {
        Self {
            schema_version: SEMANTIC_PROFILE_SCHEMA_VERSION,
            profile_id: "unnamed".to_string(),
            name: "unnamed".to_string(),
            description: None,
            target_process_name: None,
            enabled: true,
            priority: 0,
            source: None,
            alias_rules: Vec::new(),
            scenario_rules: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticProfileAliasRule {
    #[serde(default)]
    pub rule_id: Option<String>,
    #[serde(default)]
    pub alias: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub automation_id: Option<String>,
    #[serde(default)]
    pub control_name: Option<String>,
    #[serde(default)]
    pub control_type: Option<String>,
    #[serde(default)]
    pub class_name: Option<String>,
    #[serde(default)]
    pub window_title: Option<String>,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub module_name: Option<String>,
    #[serde(default)]
    pub action_type: Option<String>,
    /// Compatibility with legacy thin alias profile fields.
    #[serde(default)]
    pub match_control_name: Option<String>,
    #[serde(default)]
    pub match_automation_id: Option<String>,
    #[serde(default)]
    pub match_window_title_contains: Option<String>,
    #[serde(default)]
    pub match_title_contains: Option<String>,
    #[serde(default)]
    pub alias_prefix: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticScenarioRule {
    #[serde(default)]
    pub rule_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Alias of the triggering action target (from alias rules).
    #[serde(default)]
    pub trigger_action_alias: Option<String>,
    /// Alias expected to appear / complete after the action.
    #[serde(default)]
    pub primary_target_alias: Option<String>,
    #[serde(default)]
    pub loading_alias: Option<String>,
    #[serde(default)]
    pub progress_alias: Option<String>,
    #[serde(default)]
    pub completion_mode: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub transition_type: Option<String>,
    /// When true, matching this signal means failure rather than success.
    #[serde(default)]
    pub negative: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticProfileSnapshot {
    pub schema_version: u32,
    pub kind: String,
    pub session_id: String,
    pub snapshot_at_ms: u64,
    pub profile: SemanticProfile,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AliasMatch {
    pub alias: String,
    pub rule_id: Option<String>,
    pub priority: i32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScenarioMatch {
    pub rule_id: Option<String>,
    pub rule_name: Option<String>,
    pub transition_id: String,
    pub timeout_ms: u64,
    pub negative: bool,
    pub score_boost: f64,
}

pub fn set_active_semantic_profile(profile: Option<SemanticProfile>) {
    if let Ok(mut guard) = ACTIVE_SEMANTIC_PROFILE.lock() {
        *guard = profile;
    }
}

pub fn active_semantic_profile() -> Option<SemanticProfile> {
    ACTIVE_SEMANTIC_PROFILE
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

pub fn load_semantic_profile_from_path(path: &Path) -> Option<SemanticProfile> {
    let content = fs::read_to_string(path).ok()?;
    parse_semantic_profile_json(&content)
}

/// Parse either shadowrecord v1 profile or qttimer snapshot/profile JSON.
pub fn parse_semantic_profile_json(content: &str) -> Option<SemanticProfile> {
    let value: serde_json::Value = serde_json::from_str(content).ok()?;
    // Nested snapshot: { profile: {...} } or { Profile: {...} }
    if let Some(profile_value) = value
        .get("profile")
        .or_else(|| value.get("Profile"))
        .cloned()
        && let Ok(mut profile) = serde_json::from_value::<SemanticProfile>(profile_value)
    {
        normalize_profile(&mut profile);
        return Some(profile);
    }
    // Direct profile object (qttimer SemanticProfileSnapshot shape without wrapper).
    if let Ok(mut profile) = serde_json::from_value::<SemanticProfile>(value.clone())
        && (!profile.profile_id.trim().is_empty() || !profile.alias_rules.is_empty())
    {
        normalize_profile(&mut profile);
        return Some(profile);
    }
    // Legacy thin alias file: { profileId, rules: [...] }
    if let Ok(legacy) = serde_json::from_value::<SemanticAliasProfile>(value.clone()) {
        return Some(semantic_profile_from_alias_profile(legacy));
    }
    // qttimer elements_selected export: [ { locator, semantic_target, ... }, ... ]
    if let Some(mut profile) = parse_qttimer_elements_export(&value) {
        normalize_profile(&mut profile);
        return Some(profile);
    }
    None
}

/// Convert qttimer `elements_selected_*.json` (or `{ elements: [...] }`) into a SemanticProfile.
pub fn parse_qttimer_elements_export(value: &serde_json::Value) -> Option<SemanticProfile> {
    let items = if let Some(arr) = value.as_array() {
        arr.as_slice()
    } else {
        value
            .get("elements")
            .or_else(|| value.get("selectedElements"))
            .or_else(|| value.get("selected_elements"))
            .and_then(|v| v.as_array())?
            .as_slice()
    };

    if items.is_empty() {
        return None;
    }

    let looks_like_elements = items.iter().any(|item| {
        item.get("locator").is_some()
            || item.get("semantic_target").is_some()
            || item.get("component_type").is_some()
            || item.get("componentType").is_some()
    });
    if !looks_like_elements {
        return None;
    }

    let mut product_tag: Option<String> = None;
    let mut alias_rules: Vec<SemanticProfileAliasRule> = Vec::with_capacity(items.len());

    for (index, item) in items.iter().enumerate() {
        if !item.is_object() {
            continue;
        }
        let Some(rule) = element_item_to_alias_rule(item, index) else {
            continue;
        };
        if product_tag.is_none() {
            product_tag = string_field(item, &["product_tag", "productTag"]);
        }
        alias_rules.push(rule);
    }

    if alias_rules.is_empty() {
        return None;
    }

    let product = product_tag.unwrap_or_else(|| "imported".to_string());
    let slug = product
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    let slug = slug.trim_matches('-').to_string();
    let slug = if slug.is_empty() {
        "imported".to_string()
    } else {
        slug
    };

    Some(SemanticProfile {
        schema_version: SEMANTIC_PROFILE_SCHEMA_VERSION,
        profile_id: format!("{slug}-elements"),
        name: format!("{product} 控件画像"),
        description: Some(format!(
            "从 qttimer elements_selected 导入，共 {} 条控件别名",
            alias_rules.len()
        )),
        target_process_name: None,
        enabled: true,
        priority: 10,
        source: Some("qttimer-elements-selected".to_string()),
        alias_rules,
        scenario_rules: Vec::new(),
    })
}

fn string_field(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(s) = value.get(*key).and_then(|v| v.as_str()) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn map_component_type(raw: &str) -> String {
    match raw.trim().to_ascii_uppercase().as_str() {
        "BUTTON" => "Button".to_string(),
        "INPUT" | "EDIT" | "TEXTBOX" | "TEXT" => "Edit".to_string(),
        "CHECKBOX" => "CheckBox".to_string(),
        "RADIO" | "RADIOBUTTON" => "RadioButton".to_string(),
        "DROPDOWN" | "COMBOBOX" | "SELECT" => "ComboBox".to_string(),
        "LABEL" | "TEXTBLOCK" => "Text".to_string(),
        "SLIDER" => "Slider".to_string(),
        "LIST" | "LISTBOX" => "List".to_string(),
        "PANE" | "PANEL" => "Pane".to_string(),
        "WINDOW" => "Window".to_string(),
        "" => "Unknown".to_string(),
        other => {
            if raw
                .chars()
                .next()
                .map(|c| c.is_uppercase())
                .unwrap_or(false)
            {
                raw.to_string()
            } else {
                other.to_string()
            }
        }
    }
}

fn element_item_to_alias_rule(
    item: &serde_json::Value,
    index: usize,
) -> Option<SemanticProfileAliasRule> {
    let st = item
        .get("semantic_target")
        .or_else(|| item.get("semanticTarget"));
    let automation_id = st
        .and_then(|v| string_field(v, &["automation_id", "automationId"]))
        .or_else(|| {
            st.and_then(|v| v.get("locator_hints").or_else(|| v.get("locatorHints")))
                .and_then(|h| string_field(h, &["automation_id", "automationId"]))
        })
        .or_else(|| {
            let locator_type =
                string_field(item, &["locator_type", "locatorType"]).unwrap_or_default();
            let locator = string_field(item, &["locator"]);
            if locator_type.eq_ignore_ascii_case("ACCESSIBILITY_ID")
                || locator_type.eq_ignore_ascii_case("AutomationId")
            {
                locator
            } else {
                None
            }
        });

    let alias = string_field(item, &["name"])
        .or_else(|| st.and_then(|v| string_field(v, &["name", "description"])))
        .or_else(|| string_field(item, &["description"]));

    if automation_id.is_none() && alias.is_none() {
        return None;
    }

    let control_type = string_field(
        item,
        &[
            "component_type",
            "componentType",
            "control_type",
            "controlType",
        ],
    )
    .map(|v| map_component_type(&v));
    let action_type = string_field(item, &["action_type", "actionType"]);
    let module_name = string_field(
        item,
        &["parent_module", "parentModule", "module_name", "moduleName"],
    );
    let description = string_field(item, &["description"]);
    let rule_id = string_field(item, &["id", "ruleId", "rule_id"])
        .unwrap_or_else(|| format!("element-{}", index + 1));

    let control_name = st
        .and_then(|v| string_field(v, &["control_name", "controlName"]))
        .or_else(|| {
            if automation_id.is_none() {
                string_field(item, &["name"])
            } else {
                None
            }
        });

    Some(SemanticProfileAliasRule {
        rule_id: Some(rule_id),
        alias,
        description,
        source: Some("qttimer-element".to_string()),
        automation_id: automation_id.clone(),
        control_name: control_name.clone(),
        control_type,
        class_name: None,
        window_title: None,
        priority: 10,
        module_name,
        action_type,
        match_control_name: control_name,
        match_automation_id: automation_id,
        match_window_title_contains: None,
        match_title_contains: None,
        alias_prefix: None,
    })
}

fn normalize_profile(profile: &mut SemanticProfile) {
    if profile.schema_version == 0 {
        profile.schema_version = SEMANTIC_PROFILE_SCHEMA_VERSION;
    }
    if profile.profile_id.trim().is_empty() {
        profile.profile_id = "imported".to_string();
    }
    if profile.name.trim().is_empty() {
        profile.name = profile.profile_id.clone();
    }
    // qttimer profiles don't have enabled flag → default true when absent via serde default
    for (index, rule) in profile.alias_rules.iter_mut().enumerate() {
        if rule
            .rule_id
            .as_ref()
            .map(|v| v.trim().is_empty())
            .unwrap_or(true)
        {
            rule.rule_id = Some(format!("alias-{}", index + 1));
        }
        // Map qttimer fields into match_* for unified matcher.
        if rule.match_automation_id.is_none() {
            rule.match_automation_id = rule.automation_id.clone();
        }
        if rule.match_control_name.is_none() {
            rule.match_control_name = rule.control_name.clone();
        }
        if rule.match_window_title_contains.is_none() {
            rule.match_window_title_contains = rule.window_title.clone();
        }
    }
    for (index, rule) in profile.scenario_rules.iter_mut().enumerate() {
        if rule
            .rule_id
            .as_ref()
            .map(|v| v.trim().is_empty())
            .unwrap_or(true)
        {
            rule.rule_id = Some(format!("scenario-{}", index + 1));
        }
        if rule.timeout_ms.unwrap_or(0) == 0 {
            rule.timeout_ms = Some(3_000);
        }
    }
}

pub fn semantic_profile_from_alias_profile(legacy: SemanticAliasProfile) -> SemanticProfile {
    SemanticProfile {
        schema_version: SEMANTIC_PROFILE_SCHEMA_VERSION,
        profile_id: legacy
            .profile_id
            .clone()
            .unwrap_or_else(|| "legacy-alias".to_string()),
        name: legacy
            .profile_id
            .clone()
            .unwrap_or_else(|| "Legacy alias profile".to_string()),
        description: Some("Converted from semantic-alias.json".to_string()),
        target_process_name: None,
        enabled: true,
        priority: 0,
        source: Some("legacy-alias".to_string()),
        alias_rules: legacy
            .rules
            .into_iter()
            .enumerate()
            .map(|(index, rule)| SemanticProfileAliasRule {
                rule_id: Some(format!("legacy-{}", index + 1)),
                alias: rule.alias,
                match_control_name: rule.match_control_name,
                match_automation_id: rule.match_automation_id,
                match_window_title_contains: rule.match_window_title_contains,
                match_title_contains: rule.match_title_contains,
                alias_prefix: rule.alias_prefix,
                priority: 0,
                ..SemanticProfileAliasRule::default()
            })
            .collect(),
        scenario_rules: Vec::new(),
    }
}

pub fn alias_profile_from_semantic_profile(profile: &SemanticProfile) -> SemanticAliasProfile {
    SemanticAliasProfile {
        profile_id: Some(profile.profile_id.clone()),
        rules: profile
            .alias_rules
            .iter()
            .map(|rule| SemanticAliasRule {
                match_control_name: rule
                    .match_control_name
                    .clone()
                    .or_else(|| rule.control_name.clone()),
                match_automation_id: rule
                    .match_automation_id
                    .clone()
                    .or_else(|| rule.automation_id.clone()),
                match_window_title_contains: rule
                    .match_window_title_contains
                    .clone()
                    .or_else(|| rule.window_title.clone()),
                match_title_contains: rule.match_title_contains.clone(),
                alias: rule.alias.clone(),
                alias_prefix: rule.alias_prefix.clone(),
            })
            .collect(),
    }
}

pub fn load_semantic_profile_for_session(session_dir: Option<&str>) -> Option<SemanticProfile> {
    if let Some(active) = active_semantic_profile()
        && active.enabled
    {
        return Some(active);
    }
    let session_dir = session_dir?;
    let candidates = [
        Path::new(session_dir).join(SEMANTIC_PROFILE_SNAPSHOT_FILE_NAME),
        Path::new(session_dir).join(SEMANTIC_PROFILE_FILE_NAME),
        Path::new(session_dir).join("semantic-alias.json"),
        Path::new(session_dir)
            .join("..")
            .join(SEMANTIC_PROFILE_FILE_NAME),
        Path::new(session_dir)
            .join("..")
            .join("semantic-alias.json"),
    ];
    for candidate in candidates {
        if candidate.exists()
            && let Some(profile) = load_semantic_profile_from_path(&candidate)
            && profile.enabled
        {
            return Some(profile);
        }
    }
    None
}

pub fn persist_semantic_profile_snapshot(
    session_dir: &Path,
    session_id: &str,
    snapshot_at_ms: u64,
    profile: &SemanticProfile,
) -> Result<PathBuf, std::io::Error> {
    let snapshot = SemanticProfileSnapshot {
        schema_version: SEMANTIC_PROFILE_SCHEMA_VERSION,
        kind: "reqcase.semantic-profile-snapshot".to_string(),
        session_id: session_id.to_string(),
        snapshot_at_ms,
        profile: profile.clone(),
    };
    let path = session_dir.join(SEMANTIC_PROFILE_SNAPSHOT_FILE_NAME);
    let text = serde_json::to_string_pretty(&snapshot)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    fs::write(&path, text)?;
    Ok(path)
}

/// Match profile automation ids against full hierarchical UIA paths.
/// Example: expected `chk.CreateNewProject.BoxCorrection` matches
/// actual `NewProjectUI.CorrectTypeGroupBox.chk.CreateNewProject.BoxCorrection`.
fn automation_id_matches(expected: &str, actual: &str) -> bool {
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
    // Leaf segment equality.
    let expected_leaf = expected_l.rsplit('.').next().unwrap_or("");
    let actual_leaf = actual_l.rsplit('.').next().unwrap_or("");
    if !expected_leaf.is_empty() && expected_leaf == actual_leaf && expected_leaf.len() >= 6 {
        return true;
    }
    // Locator-suffix / truncation tolerant:
    // actual may be a long Qt path truncated mid-token (cap was 256), e.g.
    // "...btn.EnvironmentPreparation.Co" vs expected "btn.EnvironmentPreparation.ControlSystem.Connection".
    if let Some(actual_suffix) = locator_suffix(&actual_l) {
        if (expected_l == actual_suffix || expected_l.starts_with(&actual_suffix))
            && actual_suffix.len() >= 18
        {
            // Require enough shared prefix to avoid over-match on tiny stubs.
            return true;
        }
        if actual_suffix.starts_with(&expected_l) && expected_l.len() >= 12 {
            return true;
        }
    }
    if let Some(expected_suffix) = locator_suffix(&expected_l)
        && actual_l.ends_with(&expected_suffix)
    {
        let prefix_len = actual_l.len().saturating_sub(expected_suffix.len());
        if prefix_len == 0 || actual_l.as_bytes().get(prefix_len - 1) == Some(&b'.') {
            return true;
        }
    }
    false
}

fn locator_suffix(id: &str) -> Option<String> {
    const MARKERS: &[&str] = &[
        "btn.",
        "txt.",
        "rad.",
        "chk.",
        "cmb.",
        "spin.",
        "lbl.",
        "menu.",
        "radio.",
        "collapse.",
        "tab.",
        "list.",
        "item.",
    ];
    let lower = id.to_ascii_lowercase();
    let mut best: Option<usize> = None;
    for marker in MARKERS {
        if let Some(idx) = lower.rfind(marker) {
            best = Some(best.map_or(idx, |cur| cur.max(idx)));
        }
    }
    best.map(|idx| lower[idx..].to_string())
}

pub fn resolve_alias_for_identity(
    profile: &SemanticProfile,
    identity: Option<&UiElementIdentity>,
    window_title: Option<&str>,
    fallback_title: Option<&str>,
) -> Option<AliasMatch> {
    if !profile.enabled {
        return None;
    }
    let mut best: Option<AliasMatch> = None;
    for rule in &profile.alias_rules {
        if !alias_rule_matches(rule, identity, window_title, fallback_title) {
            continue;
        }
        let alias = rule
            .alias
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .map(|v| v.to_string())
            .or_else(|| {
                rule.alias_prefix.as_ref().and_then(|prefix| {
                    let base = fallback_title.unwrap_or("").trim();
                    if prefix.trim().is_empty() {
                        None
                    } else {
                        Some(format!("{}{}", prefix.trim(), base))
                    }
                })
            })?;
        let specificity = rule
            .match_automation_id
            .as_deref()
            .or(rule.automation_id.as_deref())
            .map(|v| v.trim().len())
            .unwrap_or(0) as i32;
        let candidate = AliasMatch {
            alias,
            rule_id: rule.rule_id.clone(),
            // Prefer higher rule priority, then more specific (longer) automationId.
            priority: rule
                .priority
                .saturating_mul(10_000)
                .saturating_add(specificity),
        };
        if best
            .as_ref()
            .is_none_or(|current| candidate.priority > current.priority)
        {
            best = Some(candidate);
        }
    }
    best
}

fn alias_rule_matches(
    rule: &SemanticProfileAliasRule,
    identity: Option<&UiElementIdentity>,
    window_title: Option<&str>,
    fallback_title: Option<&str>,
) -> bool {
    let mut matched_any = false;
    let automation_id = rule
        .match_automation_id
        .as_deref()
        .or(rule.automation_id.as_deref())
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let mut automation_matched = false;
    if let Some(expected) = automation_id {
        matched_any = true;
        let actual = identity
            .and_then(|item| item.automation_id.as_deref())
            .unwrap_or("");
        if !automation_id_matches(expected, actual) {
            return false;
        }
        automation_matched = true;
    }
    // When automationId already matches (incl. hierarchical suffix), do not fail on
    // qttimer-export controlType/name mismatches (e.g. Button vs RadioButton).
    if !automation_matched {
        let control_name = rule
            .match_control_name
            .as_deref()
            .or(rule.control_name.as_deref())
            .map(str::trim)
            .filter(|v| !v.is_empty());
        if let Some(expected) = control_name {
            matched_any = true;
            let actual = identity.and_then(|item| item.name.as_deref()).unwrap_or("");
            if !actual.eq_ignore_ascii_case(expected) {
                return false;
            }
        }
        if let Some(expected) = rule
            .control_type
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            matched_any = true;
            let actual = identity
                .and_then(|item| item.control_type.as_deref())
                .unwrap_or("");
            if !actual.eq_ignore_ascii_case(expected) {
                return false;
            }
        }
    }
    if let Some(expected) = rule
        .class_name
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        matched_any = true;
        let actual = identity
            .and_then(|item| item.class_name.as_deref())
            .unwrap_or("");
        if !actual.eq_ignore_ascii_case(expected) {
            return false;
        }
    }
    let window_needle = rule
        .match_window_title_contains
        .as_deref()
        .or(rule.window_title.as_deref())
        .map(str::trim)
        .filter(|v| !v.is_empty());
    if let Some(needle) = window_needle {
        matched_any = true;
        let hay = window_title.unwrap_or("");
        if !contains_ignore_case(hay, needle) {
            return false;
        }
    }
    if let Some(needle) = rule
        .match_title_contains
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        matched_any = true;
        let hay = fallback_title.unwrap_or("");
        if !contains_ignore_case(hay, needle) {
            return false;
        }
    }
    matched_any
}

pub fn apply_profile_to_operations(
    operations: &mut [TestSessionOperationRecord],
    profile: Option<&SemanticProfile>,
) {
    let Some(profile) = profile.filter(|item| item.enabled) else {
        return;
    };
    for operation in operations.iter_mut() {
        if operation.edited {
            continue;
        }
        let window_title = operation
            .action
            .target
            .as_ref()
            .and_then(|target| {
                target
                    .parent_path
                    .iter()
                    .rev()
                    .find_map(|entry| entry.name.clone())
            })
            .or_else(|| {
                operation
                    .action
                    .target
                    .as_ref()
                    .and_then(|target| target.name.clone())
            });
        if let Some(matched) = resolve_alias_for_identity(
            profile,
            operation.action.target.as_ref(),
            window_title.as_deref(),
            Some(operation.title.as_str()),
        ) {
            operation.business_alias = Some(matched.alias.clone());
            // Always surface business alias as the primary title for review/export.
            operation.title = matched.alias.clone();
            if operation.precision_level == "l2" || operation.precision_level == "l3" {
                operation.precision_level = "l4".to_string();
            }
            operation.display_summary = format!(
                "{} -> {}，耗时 {}ms",
                operation.title, operation.result_summary, operation.outcome.latency_ms
            );
        }
    }
}

/// Find a scenario completion for an action among transitions.
pub fn match_scenario_completion(
    profile: &SemanticProfile,
    action: &OperationAction,
    action_alias: Option<&str>,
    transitions: &[StateTransition],
    window_end_ms: u64,
) -> Option<ScenarioMatch> {
    if !profile.enabled || profile.scenario_rules.is_empty() {
        return None;
    }
    let action_alias = action_alias
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .or_else(|| {
            resolve_alias_for_identity(profile, action.target.as_ref(), None, None).map(|m| m.alias)
        })?;

    let mut best: Option<ScenarioMatch> = None;
    for rule in &profile.scenario_rules {
        let Some(trigger) = rule
            .trigger_action_alias
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        else {
            continue;
        };
        if !trigger.eq_ignore_ascii_case(&action_alias) {
            continue;
        }
        let timeout_ms = rule.timeout_ms.unwrap_or(3_000).clamp(200, 60_000);
        let scenario_end = action
            .occurred_at_ms
            .saturating_add(timeout_ms)
            .min(window_end_ms);
        let target_alias = rule
            .primary_target_alias
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty());

        for transition in transitions
            .iter()
            .filter(|item| item.occurred_at_ms >= action.occurred_at_ms)
            .filter(|item| item.occurred_at_ms <= scenario_end)
        {
            if !transition_matches_scenario(profile, rule, transition, target_alias) {
                continue;
            }
            let latency = transition
                .occurred_at_ms
                .saturating_sub(action.occurred_at_ms) as f64;
            let score_boost =
                40.0 + ((timeout_ms as f64 - latency).max(0.0) / timeout_ms as f64) * 20.0;
            let candidate = ScenarioMatch {
                rule_id: rule.rule_id.clone(),
                rule_name: rule.name.clone(),
                transition_id: transition.transition_id.clone(),
                timeout_ms,
                negative: rule.negative
                    || rule
                        .transition_type
                        .as_deref()
                        .is_some_and(|value| value.to_ascii_lowercase().contains("error")),
                score_boost,
            };
            if best
                .as_ref()
                .is_none_or(|current| candidate.score_boost > current.score_boost)
            {
                best = Some(candidate);
            }
        }
    }
    best
}

fn transition_matches_scenario(
    profile: &SemanticProfile,
    rule: &SemanticScenarioRule,
    transition: &StateTransition,
    target_alias: Option<&str>,
) -> bool {
    if let Some(expected_type) = rule
        .transition_type
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let property = transition.property.as_deref().unwrap_or("");
        let expected = expected_type.to_ascii_lowercase();
        let ok = if expected.contains("popup") {
            property.eq_ignore_ascii_case("popup")
                || transition
                    .reason_codes
                    .iter()
                    .any(|code| matches!(code, OperationReasonCode::PopupAppeared))
        } else if expected.contains("dialog") {
            property.eq_ignore_ascii_case("dialog")
                || transition
                    .reason_codes
                    .iter()
                    .any(|code| matches!(code, OperationReasonCode::DialogAppeared))
        } else if expected.contains("window") {
            property.eq_ignore_ascii_case("window")
        } else {
            property.eq_ignore_ascii_case(expected_type)
                || contains_ignore_case(property, expected_type)
        };
        if !ok {
            return false;
        }
    }

    if let Some(target_alias) = target_alias {
        let matched = resolve_alias_for_identity(
            profile,
            transition.element.as_ref(),
            transition
                .element
                .as_ref()
                .and_then(|element| element.name.as_deref()),
            transition.element.as_ref().and_then(|e| e.name.as_deref()),
        );
        if matched
            .as_ref()
            .is_none_or(|item| !item.alias.eq_ignore_ascii_case(target_alias))
        {
            // Also allow name contains for toast text nodes.
            let name = transition
                .element
                .as_ref()
                .and_then(|element| element.name.as_deref())
                .unwrap_or("");
            if !contains_ignore_case(name, target_alias) {
                return false;
            }
        }
    }
    true
}

pub fn apply_scenario_to_outcome(outcome: &mut OperationOutcome, scenario: &ScenarioMatch) {
    push_unique_reason(
        &mut outcome.reason_codes,
        OperationReasonCode::ExplicitCompletion,
    );
    if scenario.negative {
        push_unique_reason(
            &mut outcome.reason_codes,
            OperationReasonCode::NegativeCompletionSignal,
        );
        if outcome.status == OperationOutcomeStatus::Confirmed {
            // Keep confirmed but marked as negative completion for honest export wording later.
        }
    } else if outcome.status == OperationOutcomeStatus::Incomplete
        || outcome.status == OperationOutcomeStatus::Candidate
    {
        outcome.status = OperationOutcomeStatus::Confirmed;
        outcome.primary_transition_id = Some(scenario.transition_id.clone());
        if !outcome
            .candidate_transition_ids
            .iter()
            .any(|id| id == &scenario.transition_id)
        {
            outcome
                .candidate_transition_ids
                .insert(0, scenario.transition_id.clone());
        }
    } else if outcome.primary_transition_id.is_none() {
        outcome.primary_transition_id = Some(scenario.transition_id.clone());
    }

    let label = scenario
        .rule_name
        .clone()
        .or_else(|| scenario.rule_id.clone())
        .unwrap_or_else(|| "scenario".to_string());
    outcome.summary = Some(if scenario.negative {
        format!("场景规则命中失败信号：{label}")
    } else {
        format!("场景规则命中：{label}")
    });
}

fn push_unique_reason(codes: &mut Vec<OperationReasonCode>, code: OperationReasonCode) {
    if !codes.iter().any(|item| item == &code) {
        codes.push(code);
    }
}

fn contains_ignore_case(haystack: &str, needle: &str) -> bool {
    haystack
        .to_ascii_lowercase()
        .contains(&needle.to_ascii_lowercase())
}

/// Prefer binding the recording target process from the profile when the user
/// did not provide a process name.
pub fn preferred_target_process_name(profile: Option<&SemanticProfile>) -> Option<String> {
    profile
        .and_then(|item| item.target_process_name.clone())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::operation_models::{
        OperationActionKind, StateTransitionConfidence, StateTransitionKind,
    };

    fn sample_profile() -> SemanticProfile {
        SemanticProfile {
            schema_version: 1,
            profile_id: "cc3".to_string(),
            name: "CC3".to_string(),
            description: None,
            target_process_name: Some("QtApp.exe".to_string()),
            enabled: true,
            priority: 10,
            source: Some("test".to_string()),
            alias_rules: vec![
                SemanticProfileAliasRule {
                    rule_id: Some("a1".to_string()),
                    alias: Some("新建项目_确认按钮".to_string()),
                    automation_id: Some("btn.CreateNewProject.Confirm".to_string()),
                    control_type: Some("Button".to_string()),
                    priority: 8,
                    ..SemanticProfileAliasRule::default()
                },
                SemanticProfileAliasRule {
                    rule_id: Some("a2".to_string()),
                    alias: Some("通知弹窗_确定按钮".to_string()),
                    automation_id: Some("btn.Notify.Ok".to_string()),
                    priority: 8,
                    ..SemanticProfileAliasRule::default()
                },
            ],
            scenario_rules: vec![SemanticScenarioRule {
                rule_id: Some("s1".to_string()),
                name: Some("新建项目等待确定弹窗".to_string()),
                trigger_action_alias: Some("新建项目_确认按钮".to_string()),
                primary_target_alias: Some("通知弹窗_确定按钮".to_string()),
                transition_type: Some("popup_transition".to_string()),
                timeout_ms: Some(3_000),
                negative: false,
                ..SemanticScenarioRule::default()
            }],
        }
    }

    #[test]
    fn parses_qttimer_style_snapshot_json() {
        let json = r#"{
          "profileId": "cc3-imported",
          "name": "CC3 控件画像",
          "targetProcessName": "QtApp.exe",
          "aliasRules": [
            {
              "ruleId": "rule_1",
              "alias": "新建项目_确认按钮",
              "automationId": "btn.CreateNewProject.Confirm",
              "controlType": "Button",
              "priority": 8
            }
          ],
          "scenarioRules": [
            {
              "ruleId": "scenario_1",
              "name": "等待弹窗",
              "triggerActionAlias": "新建项目_确认按钮",
              "primaryTargetAlias": "通知弹窗_确定按钮",
              "timeoutMs": 30000,
              "transitionType": "popup_transition"
            }
          ]
        }"#;
        let profile = parse_semantic_profile_json(json).expect("parse");
        assert_eq!(profile.profile_id, "cc3-imported");
        assert_eq!(profile.target_process_name.as_deref(), Some("QtApp.exe"));
        assert_eq!(profile.alias_rules.len(), 1);
        assert_eq!(profile.scenario_rules.len(), 1);
        assert_eq!(
            profile.alias_rules[0].match_automation_id.as_deref(),
            Some("btn.CreateNewProject.Confirm")
        );
    }

    #[test]
    fn resolves_alias_by_automation_id_priority() {
        let profile = sample_profile();
        let identity = UiElementIdentity {
            automation_id: Some("btn.CreateNewProject.Confirm".to_string()),
            control_type: Some("Button".to_string()),
            name: Some("Confirm".to_string()),
            ..UiElementIdentity::default()
        };
        let matched =
            resolve_alias_for_identity(&profile, Some(&identity), None, None).expect("alias match");
        assert_eq!(matched.alias, "新建项目_确认按钮");
    }

    #[test]
    fn matches_scenario_popup_completion() {
        let profile = sample_profile();
        let action = OperationAction {
            action_id: "action-1".to_string(),
            kind: OperationActionKind::Click,
            occurred_at_ms: 1_000,
            ended_at_ms: Some(1_000),
            target: Some(UiElementIdentity {
                automation_id: Some("btn.CreateNewProject.Confirm".to_string()),
                control_type: Some("Button".to_string()),
                ..UiElementIdentity::default()
            }),
            state_before: None,
            coordinate: None,
            source_event_ids: vec!["e1".to_string()],
            target_reason_codes: Vec::new(),
            confidence: Default::default(),
            content_preview: None,
        };
        let transition = StateTransition {
            transition_id: "t-popup".to_string(),
            kind: StateTransitionKind::Lifecycle,
            occurred_at_ms: 1_420,
            element: Some(UiElementIdentity {
                automation_id: Some("btn.Notify.Ok".to_string()),
                name: Some("确定".to_string()),
                ..UiElementIdentity::default()
            }),
            property: Some("popup".to_string()),
            before: None,
            after: Some(serde_json::json!({"visible": true})),
            privacy_class: crate::session::operation_models::PrivacyClass::Unknown,
            source_event_ids: vec!["sem-1".to_string()],
            reason_codes: vec![OperationReasonCode::PopupAppeared],
            confidence: StateTransitionConfidence::default(),
        };
        let matched = match_scenario_completion(
            &profile,
            &action,
            Some("新建项目_确认按钮"),
            &[transition],
            4_000,
        )
        .expect("scenario match");
        assert_eq!(matched.transition_id, "t-popup");
        assert!(!matched.negative);
        assert!(matched.score_boost >= 40.0);
    }

    #[test]
    fn parses_qttimer_elements_selected_array() {
        let json = r#"[
          {
            "name": "新建项目_确认按钮",
            "locator": "btn.CreateNewProject.Confirm",
            "locator_type": "ACCESSIBILITY_ID",
            "component_type": "BUTTON",
            "action_type": "CLICK",
            "parent_module": "新建项目",
            "product_tag": "CC3",
            "semantic_target": {
              "name": "新建项目_确认按钮",
              "automation_id": "btn.CreateNewProject.Confirm"
            },
            "id": "el-1"
          },
          {
            "name": "项目名称输入框",
            "locator": "txt.CreateNewProject.ProjectName",
            "locator_type": "ACCESSIBILITY_ID",
            "component_type": "INPUT",
            "action_type": "TYPE",
            "parent_module": "新建项目",
            "product_tag": "CC3",
            "semantic_target": {
              "automation_id": "txt.CreateNewProject.ProjectName"
            },
            "id": "el-2"
          }
        ]"#;
        let profile = parse_semantic_profile_json(json).expect("parse elements");
        assert_eq!(profile.profile_id, "cc3-elements");
        assert_eq!(profile.source.as_deref(), Some("qttimer-elements-selected"));
        assert_eq!(profile.alias_rules.len(), 2);
        assert_eq!(
            profile.alias_rules[0].alias.as_deref(),
            Some("新建项目_确认按钮")
        );
        assert_eq!(
            profile.alias_rules[0].match_automation_id.as_deref(),
            Some("btn.CreateNewProject.Confirm")
        );
        assert_eq!(
            profile.alias_rules[0].control_type.as_deref(),
            Some("Button")
        );
        assert_eq!(profile.alias_rules[1].control_type.as_deref(), Some("Edit"));
        assert_eq!(
            profile.alias_rules[1].module_name.as_deref(),
            Some("新建项目")
        );
    }

    #[test]
    fn matches_hierarchical_automation_id_suffix() {
        let profile = SemanticProfile {
            profile_id: "cc3".to_string(),
            name: "cc3".to_string(),
            enabled: true,
            alias_rules: vec![SemanticProfileAliasRule {
                rule_id: Some("r1".to_string()),
                alias: Some("新建项目_箱体校正复选框".to_string()),
                automation_id: Some("chk.CreateNewProject.BoxCorrection".to_string()),
                match_automation_id: Some("chk.CreateNewProject.BoxCorrection".to_string()),
                priority: 10,
                ..SemanticProfileAliasRule::default()
            }],
            ..SemanticProfile::default()
        };
        let identity = UiElementIdentity {
            automation_id: Some(
                "NewProjectUI.CorrectTypeGroupBox.chk.CreateNewProject.BoxCorrection".to_string(),
            ),
            control_type: Some("RadioButton".to_string()),
            name: Some("箱体校正".to_string()),
            ..UiElementIdentity::default()
        };
        let matched = resolve_alias_for_identity(&profile, Some(&identity), None, None)
            .expect("suffix alias match");
        assert_eq!(matched.alias, "新建项目_箱体校正复选框");
    }

    #[test]
    fn converts_legacy_alias_profile() {
        let legacy = SemanticAliasProfile {
            profile_id: Some("demo".to_string()),
            rules: vec![SemanticAliasRule {
                match_control_name: Some("保存".to_string()),
                alias: Some("保存订单".to_string()),
                ..SemanticAliasRule::default()
            }],
        };
        let profile = semantic_profile_from_alias_profile(legacy);
        assert_eq!(profile.profile_id, "demo");
        assert_eq!(profile.alias_rules.len(), 1);
        let identity = UiElementIdentity {
            name: Some("保存".to_string()),
            ..UiElementIdentity::default()
        };
        let matched =
            resolve_alias_for_identity(&profile, Some(&identity), None, None).expect("match");
        assert_eq!(matched.alias, "保存订单");
    }
}
