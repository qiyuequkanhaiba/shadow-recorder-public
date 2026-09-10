//! Host-runnable checks for perception/correlation logic that does not need Win32.
//!
//! Run on macOS:
//!   rustc --edition 2024 --test scripts/verify-perception-logic.rs -o /tmp/verify-perception-logic
//!   /tmp/verify-perception-logic

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HitQuality {
    Leaf,
    Ancestor,
    Container,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EventType {
    Focus,
    Snapshot,
    Property,
    Selection,
    Structure,
    Popup,
    Health,
}

#[derive(Clone, Debug)]
struct Rect {
    left: i32,
    top: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Debug)]
struct Recent {
    source_event_id: String,
    x: i32,
    y: i32,
    occurred_at_ms: u64,
}

fn hit_quality_for_control_type(control_type: Option<&str>) -> HitQuality {
    match control_type.unwrap_or("") {
        "Button" | "CheckBox" | "RadioButton" | "Edit" | "ComboBox" | "Hyperlink" | "MenuItem"
        | "TabItem" | "ListItem" | "TreeItem" | "SplitButton" | "Spinner" | "Slider" => {
            HitQuality::Leaf
        }
        "Pane" | "Document" | "Window" | "TitleBar" | "ToolBar" | "StatusBar" | "MenuBar"
        | "Table" | "List" | "Tree" => HitQuality::Container,
        "Custom" | "Group" | "Thumb" | "DataItem" | "Text" => HitQuality::Ancestor,
        _ => HitQuality::Ancestor,
    }
}

fn normalize_process_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed
        .rsplit(['\\', '/'])
        .next()
        .map(|name| name.to_ascii_lowercase())
        .filter(|name| !name.is_empty())
}

fn process_names_match(left: &str, right: &str) -> bool {
    match (normalize_process_name(left), normalize_process_name(right)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

fn is_mouse_button_down_action(action: &str) -> bool {
    action.eq_ignore_ascii_case("WM_LBUTTONDOWN")
        || action.eq_ignore_ascii_case("WM_RBUTTONDOWN")
        || action.eq_ignore_ascii_case("WM_MBUTTONDOWN")
        || action.eq_ignore_ascii_case("WM_LBUTTONDBLCLK")
}

fn physical_point(x: Option<i32>, logical_x: Option<i32>, y: Option<i32>, logical_y: Option<i32>) -> Option<(i32, i32)> {
    Some((x.or(logical_x)?, y.or(logical_y)?))
}

fn point_hits(x: i32, y: i32, rect: &Rect) -> bool {
    let right = rect.left.saturating_add(rect.width as i32);
    let bottom = rect.top.saturating_add(rect.height as i32);
    x >= rect.left && x <= right && y >= rect.top && y <= bottom
}

fn should_bind_source_event(
    event_type: EventType,
    existing_source: Option<&str>,
    event_at: u64,
    recent: &Recent,
    rect: Option<&Rect>,
    window_ms: u64,
) -> bool {
    if existing_source.is_some_and(|value| !value.trim().is_empty()) {
        return false;
    }
    if event_at.abs_diff(recent.occurred_at_ms) > window_ms {
        return false;
    }
    match event_type {
        EventType::Focus | EventType::Popup => true,
        EventType::Snapshot | EventType::Property | EventType::Selection => {
            rect.is_some_and(|rect| point_hits(recent.x, recent.y, rect))
        }
        EventType::Structure | EventType::Health => false,
    }
}

fn state_before_accepted(action_at: u64, captured_at: u64, slack_ms: u64) -> bool {
    captured_at <= action_at.saturating_add(slack_ms)
}

fn outcome_without_candidates(observer_facts_present: bool) -> &'static str {
    if observer_facts_present {
        "incomplete"
    } else {
        "observerDegraded"
    }
}

#[test]
fn hit_quality_prefers_leaves() {
    assert_eq!(hit_quality_for_control_type(Some("Button")), HitQuality::Leaf);
    assert_eq!(hit_quality_for_control_type(Some("CheckBox")), HitQuality::Leaf);
    assert_eq!(hit_quality_for_control_type(Some("Pane")), HitQuality::Container);
    assert_eq!(hit_quality_for_control_type(Some("Window")), HitQuality::Container);
}

#[test]
fn process_names_ignore_path_and_case() {
    assert!(process_names_match(r"C:\Apps\CC3.exe", "cc3.exe"));
    assert!(!process_names_match("notepad.exe", "explorer.exe"));
    assert!(normalize_process_name("  ").is_none());
}

#[test]
fn mouse_down_covers_left_right_double_not_wheel() {
    assert!(is_mouse_button_down_action("WM_LBUTTONDOWN"));
    assert!(is_mouse_button_down_action("WM_RBUTTONDOWN"));
    assert!(is_mouse_button_down_action("wm_lbuttondblclk"));
    assert!(!is_mouse_button_down_action("WM_MOUSEWHEEL"));
    assert!(!is_mouse_button_down_action("WM_LBUTTONUP"));
}

#[test]
fn point_hit_uses_physical_not_logical() {
    let rect = Rect {
        left: 240,
        top: 420,
        width: 40,
        height: 32,
    };
    let (x, y) = physical_point(Some(250), Some(125), Some(440), Some(220)).unwrap();
    assert!(point_hits(x, y, &rect));
    let (logical_x, logical_y) = (125, 220);
    assert!(!point_hits(logical_x, logical_y, &rect));
}

#[test]
fn bind_focus_in_window_and_reject_late_or_prebound() {
    let recent = Recent {
        source_event_id: "evt-click".into(),
        x: 120,
        y: 220,
        occurred_at_ms: 1_000,
    };
    assert!(should_bind_source_event(
        EventType::Focus,
        None,
        1_080,
        &recent,
        None,
        300
    ));
    assert!(!should_bind_source_event(
        EventType::Focus,
        None,
        1_400,
        &recent,
        None,
        300
    ));
    assert!(!should_bind_source_event(
        EventType::Focus,
        Some("evt-other"),
        1_050,
        &recent,
        None,
        300
    ));
}

#[test]
fn bind_property_requires_physical_hit() {
    let recent = Recent {
        source_event_id: "evt-click".into(),
        x: 120,
        y: 220,
        occurred_at_ms: 1_000,
    };
    let hit = Rect {
        left: 100,
        top: 200,
        width: 80,
        height: 40,
    };
    let miss = Rect {
        left: 400,
        top: 400,
        width: 20,
        height: 20,
    };
    assert!(should_bind_source_event(
        EventType::Property,
        None,
        1_200,
        &recent,
        Some(&hit),
        300
    ));
    assert!(!should_bind_source_event(
        EventType::Property,
        None,
        1_200,
        &recent,
        Some(&miss),
        300
    ));
    assert!(!should_bind_source_event(
        EventType::Property,
        None,
        1_200,
        &recent,
        None,
        300
    ));
}

#[test]
fn pre_state_slack_accepts_one_ms_late_snapshot() {
    assert!(state_before_accepted(7_000, 7_001, 80));
    assert!(state_before_accepted(7_000, 7_080, 80));
    assert!(!state_before_accepted(7_000, 7_081, 80));
}

#[test]
fn missing_observer_facts_are_degraded_not_incomplete() {
    assert_eq!(outcome_without_candidates(true), "incomplete");
    assert_eq!(outcome_without_candidates(false), "observerDegraded");
}
