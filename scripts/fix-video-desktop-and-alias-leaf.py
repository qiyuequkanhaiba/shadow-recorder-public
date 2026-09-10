# -*- coding: utf-8 -*-
"""1) process_bind video = full multi-display capture
   2) alias match also by automationId leaf segment
"""
from pathlib import Path

root = Path(__file__).resolve().parents[1]

# ---- video_ring: process_bind uses all_displays video plan ----
vr = root / "src" / "session" / "video_ring.rs"
vt = vr.read_text(encoding="utf-8")
old = '''    match session.target_capture_mode.as_str() {
        "all_displays" => {
            let sources = resolve_selected_displays(session, displays);
            let sources = if sources.is_empty() {
                vec![fallback_display_target()]
            } else {
                sources
            };
            sources
                .iter()
                .enumerate()
                .map(|(index, display)| {
                    create_display_stream_record(
                        session,
                        &format!("vs-display-{}", index + 1),
                        display,
                    )
                })
                .collect()
        }
        "target_display" | "desktop" => {
            let display =
                resolve_target_display(session, displays).unwrap_or_else(fallback_display_target);
            vec![create_display_stream_record(
                session,
                "vs-display-primary",
                &display,
            )]
        }
        _ => vec![create_window_stream_record(session, "vs-window-primary")],
    }'''
new = '''    match session.target_capture_mode.as_str() {
        // process_bind: UIA/steps bind to process, but video should still cover full desktop
        // (previously fell into window stream with null geometry → gdigrab 0,0 1920x1080 only).
        "all_displays" | "process_bind" => {
            let sources = resolve_selected_displays(session, displays);
            let sources = if sources.is_empty() {
                vec![fallback_display_target()]
            } else {
                sources
            };
            sources
                .iter()
                .enumerate()
                .map(|(index, display)| {
                    create_display_stream_record(
                        session,
                        &format!("vs-display-{}", index + 1),
                        display,
                    )
                })
                .collect()
        }
        "target_display" | "desktop" => {
            let display =
                resolve_target_display(session, displays).unwrap_or_else(fallback_display_target);
            vec![create_display_stream_record(
                session,
                "vs-display-primary",
                &display,
            )]
        }
        _ => vec![create_window_stream_record(session, "vs-window-primary")],
    }'''
if old not in vt:
    raise SystemExit("video_ring match block not found")
vr.write_text(vt.replace(old, new), encoding="utf-8")
print("video_ring process_bind -> multi display ok")

# Also allow process_bind in should_use_ffmpeg_loop
ff = root / "src" / "session" / "ffmpeg_loop_runtime.rs"
ft = ff.read_text(encoding="utf-8")
old_ff = '''        "desktop" | "target_display" | "all_displays" | "foreground_window" | "target_window"'''
new_ff = '''        "desktop" | "target_display" | "all_displays" | "process_bind" | "foreground_window" | "target_window"'''
if old_ff in ft:
    ff.write_text(ft.replace(old_ff, new_ff), encoding="utf-8")
    print("ffmpeg should_use process_bind ok")
else:
    print("ffmpeg should_use pattern missing or already patched")

# ---- semantic_profile automation_id_matches: leaf segment ----
sp = root / "src" / "session" / "semantic_profile.rs"
st = sp.read_text(encoding="utf-8")
old_m = '''fn automation_id_matches(expected: &str, actual: &str) -> bool {
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
    false
}'''
new_m = '''fn automation_id_matches(expected: &str, actual: &str) -> bool {
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
}'''
if old_m not in st:
    raise SystemExit("automation_id_matches not found for leaf update")
sp.write_text(st.replace(old_m, new_m), encoding="utf-8")
print("semantic_profile leaf match ok")

# mirror in semantic_alias.rs
sa = root / "src" / "session" / "semantic_alias.rs"
at = sa.read_text(encoding="utf-8")
old_a = '''fn automation_id_matches_alias(expected: &str, actual: &str) -> bool {
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
    false
}'''
new_a = '''fn automation_id_matches_alias(expected: &str, actual: &str) -> bool {
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
    if !expected_leaf.is_empty()
        && expected_leaf == actual_leaf
        && expected_leaf.len() >= 6
    {
        return true;
    }
    false
}'''
if old_a in at:
    sa.write_text(at.replace(old_a, new_a), encoding="utf-8")
    print("semantic_alias leaf match ok")
else:
    print("semantic_alias leaf already or missing")

print("DONE")
