# -*- coding: utf-8 -*-
from pathlib import Path

root = Path(__file__).resolve().parents[1]

# ---- uia_enricher: longer ids + prefer leaf controls ----
p = root / "src" / "session" / "uia_enricher.rs"
t = p.read_text(encoding="utf-8")

old_norm = """fn normalize_text(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            let limited: String = trimmed.chars().take(256).collect();
            Some(limited)
        }
    })
}"""

new_norm = """fn normalize_text(value: Option<String>) -> Option<String> {
    normalize_text_with_limit(value, 256)
}

/// Qt hierarchical AutomationIds often exceed 256 chars; keep more so profile suffix match works.
fn normalize_automation_id(value: Option<String>) -> Option<String> {
    normalize_text_with_limit(value, 1024)
}

fn normalize_text_with_limit(value: Option<String>, max_chars: usize) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            let limited: String = trimmed.chars().take(max_chars).collect();
            Some(limited)
        }
    })
}"""

if old_norm not in t:
    raise SystemExit("normalize_text not found")
t = t.replace(old_norm, new_norm, 1)

# snapshot_from_element uses normalize_automation_id for automation_id
old_snap = """    let automation_id = unsafe { element.CurrentAutomationId().ok() }.and_then(bstr_to_string);
    let class_name = unsafe { element.CurrentClassName().ok() }.and_then(bstr_to_string);
    let control_type = unsafe { element.CurrentControlType().ok() }
        .map(|id| control_type_id_name(id.0 as i32).to_string());
    let is_password = unsafe { element.CurrentIsPassword().ok() }
        .map(|value| value.as_bool())
        .unwrap_or(false);

    UiaSnapshot {
        control_name: normalize_text(control_name),
        automation_id: normalize_text(automation_id),
        control_type: normalize_text(control_type),
        class_name: normalize_text(class_name),
        is_password,
    }"""
new_snap = """    let automation_id = unsafe { element.CurrentAutomationId().ok() }.and_then(bstr_to_string);
    let class_name = unsafe { element.CurrentClassName().ok() }.and_then(bstr_to_string);
    let control_type = unsafe { element.CurrentControlType().ok() }
        .map(|id| control_type_id_name(id.0 as i32).to_string());
    let is_password = unsafe { element.CurrentIsPassword().ok() }
        .map(|value| value.as_bool())
        .unwrap_or(false);

    UiaSnapshot {
        control_name: normalize_text(control_name),
        automation_id: normalize_automation_id(automation_id),
        control_type: normalize_text(control_type),
        class_name: normalize_text(class_name),
        is_password,
    }"""
if old_snap not in t:
    raise SystemExit("snapshot_from_element block not found")
t = t.replace(old_snap, new_snap, 1)

old_score = """fn score_snapshot(snapshot: &UiaSnapshot) -> i32 {
    let mut score = 0;
    if snapshot
        .control_name
        .as_ref()
        .map(|value| !value.is_empty())
        .unwrap_or(false)
    {
        score += 100;
    }
    if snapshot
        .automation_id
        .as_ref()
        .map(|value| !value.is_empty())
        .unwrap_or(false)
    {
        score += 80;
    }
    if snapshot
        .control_type
        .as_ref()
        .map(|value| !value.is_empty())
        .unwrap_or(false)
    {
        score += 20;
    }
    if snapshot
        .class_name
        .as_ref()
        .map(|value| !value.is_empty())
        .unwrap_or(false)
    {
        score += 10;
    }
    score
}"""

new_score = """fn score_snapshot(snapshot: &UiaSnapshot) -> i32 {
    let mut score = 0;
    let control_type = snapshot.control_type.as_deref().unwrap_or("");
    let control_name = snapshot.control_name.as_deref().unwrap_or("").trim();
    let automation_id = snapshot.automation_id.as_deref().unwrap_or("");

    // Prefer interactive leaf controls over window/pane containers.
    score += match control_type {
        "Button" | "CheckBox" | "RadioButton" | "Edit" | "ComboBox" | "Hyperlink"
        | "MenuItem" | "TabItem" | "ListItem" | "TreeItem" | "SplitButton" | "Spinner"
        | "Slider" | "Text" => 120,
        "Custom" | "Group" | "Thumb" | "DataItem" => 40,
        "Pane" | "Document" | "Table" | "List" | "Tree" => 10,
        "Window" | "TitleBar" | "ToolBar" | "StatusBar" | "MenuBar" => -60,
        _ => 15,
    };

    if !control_name.is_empty() {
        // Generic window titles are weak signals for leaf identity.
        let generic = matches!(
            control_name.to_ascii_lowercase().as_str(),
            "cc3" | "window" | "dialog" | "form" | "mainwindow" | "main window"
        );
        score += if generic { 15 } else { 90 };
    }
    if !automation_id.is_empty() {
        score += 100;
        // Longer hierarchical ids are more specific.
        score += (automation_id.len().min(400) / 8) as i32;
        // Prefer ids that look like control locators, not bare window frames.
        let leaf = automation_id.rsplit('.').next().unwrap_or(automation_id);
        if leaf.starts_with("btn")
            || leaf.starts_with("txt")
            || leaf.starts_with("rad")
            || leaf.starts_with("chk")
            || leaf.starts_with("cmb")
            || leaf.starts_with("spin")
            || leaf.starts_with("lbl")
            || leaf.starts_with("menu")
            || leaf.starts_with("radio")
        {
            score += 40;
        }
        if matches!(leaf, "MainFrame" | "NewProjectUI" | "cc3") {
            score -= 50;
        }
    }
    if snapshot
        .class_name
        .as_ref()
        .map(|value| !value.is_empty())
        .unwrap_or(false)
    {
        score += 10;
    }
    score
}"""

if old_score not in t:
    raise SystemExit("score_snapshot not found")
t = t.replace(old_score, new_score, 1)
p.write_text(t, encoding="utf-8")
print("uia_enricher updated")

# ---- semantic_profile: truncation-tolerant match ----
sp = root / "src" / "session" / "semantic_profile.rs"
st = sp.read_text(encoding="utf-8")
old_m = """fn automation_id_matches(expected: &str, actual: &str) -> bool {
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
    // Leaf segment equality: "...rad.CreateNewProject.X" vs "rad.CreateNewProject.X"
    // or same trailing token when full path prefixes differ slightly.
    let expected_leaf = expected_l.rsplit('.').next().unwrap_or("");
    let actual_leaf = actual_l.rsplit('.').next().unwrap_or("");
    if !expected_leaf.is_empty()
        && expected_leaf == actual_leaf
        && expected_leaf.len() >= 6
    {
        return true;
    }
    false
}"""
new_m = """fn automation_id_matches(expected: &str, actual: &str) -> bool {
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
    if !expected_leaf.is_empty()
        && expected_leaf == actual_leaf
        && expected_leaf.len() >= 6
    {
        return true;
    }
    // Locator-suffix / truncation tolerant:
    // actual may be a long Qt path truncated mid-token (cap was 256), e.g.
    // "...btn.EnvironmentPreparation.Co" vs expected "btn.EnvironmentPreparation.ControlSystem.Connection".
    if let Some(actual_suffix) = locator_suffix(&actual_l) {
        if expected_l == actual_suffix || expected_l.starts_with(&actual_suffix) {
            // Require enough shared prefix to avoid over-match on tiny stubs.
            if actual_suffix.len() >= 18 {
                return true;
            }
        }
        if actual_suffix.starts_with(&expected_l) && expected_l.len() >= 12 {
            return true;
        }
    }
    if let Some(expected_suffix) = locator_suffix(&expected_l) {
        if actual_l.ends_with(&expected_suffix) {
            let prefix_len = actual_l.len().saturating_sub(expected_suffix.len());
            if prefix_len == 0 || actual_l.as_bytes().get(prefix_len - 1) == Some(&b'.') {
                return true;
            }
        }
    }
    false
}

fn locator_suffix(id: &str) -> Option<String> {
    const MARKERS: &[&str] = &[
        "btn.", "txt.", "rad.", "chk.", "cmb.", "spin.", "lbl.", "menu.", "radio.",
        "collapse.", "tab.", "list.", "item.",
    ];
    let lower = id.to_ascii_lowercase();
    let mut best: Option<usize> = None;
    for marker in MARKERS {
        if let Some(idx) = lower.rfind(marker) {
            best = Some(best.map_or(idx, |cur| cur.max(idx)));
        }
    }
    best.map(|idx| lower[idx..].to_string())
}"""
if old_m not in st:
    raise SystemExit("automation_id_matches block not found for replace")
sp.write_text(st.replace(old_m, new_m), encoding="utf-8")
print("semantic_profile truncation match ok")

# mirror key parts into semantic_alias automation_id_matches_alias - replace whole fn similarly
sa = root / "src" / "session" / "semantic_alias.rs"
at = sa.read_text(encoding="utf-8")
# replace the leaf version with call to shared logic - or duplicate
import re
at2, n = re.subn(
    r"fn automation_id_matches_alias\(expected: &str, actual: &str\) -> bool \{[\s\S]*?\n\}",
    """fn automation_id_matches_alias(expected: &str, actual: &str) -> bool {
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
    if let Some(idx) = ["btn.", "txt.", "rad.", "chk.", "cmb.", "spin.", "lbl.", "menu.", "radio."]
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
}""",
    at,
    count=1,
)
if n != 1:
    print("WARN semantic_alias replace count", n)
else:
    sa.write_text(at2, encoding="utf-8")
    print("semantic_alias updated")

print("DONE")
