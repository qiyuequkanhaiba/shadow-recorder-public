# -*- coding: utf-8 -*-
from pathlib import Path

p = Path("src/session/semantic_profile.rs")
t = p.read_text(encoding="utf-8")

old = """    if let Some(expected) = automation_id {
        matched_any = true;
        let actual = identity
            .and_then(|item| item.automation_id.as_deref())
            .unwrap_or("");
        if !automation_id_matches(expected, actual) {
            return false;
        }
    }
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
    }"""

new = """    let mut automation_matched = false;
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
    }"""

if old not in t:
    raise SystemExit("block not found for control_type skip")
p.write_text(t.replace(old, new, 1), encoding="utf-8")
print("ok")
