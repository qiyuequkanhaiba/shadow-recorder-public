//! On-demand UI Automation snapshots for click enrichment.
//! Best-effort only: timeouts and failures never affect the recording main path.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Sender, SyncSender, TrySendError};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

use super::operation_models::{
    ExpandCollapseState, PrivacyClass, SelectionState, ToggleState, UiBoundingRect,
    UiElementIdentity, UiElementPathEntry, UiStateSnapshot, UiStateSnapshotSource,
};

const DEFAULT_TIMEOUT_MS: u64 = 80;
const CIRCUIT_FAIL_THRESHOLD: u32 = 20;
const CIRCUIT_COOLDOWN: Duration = Duration::from_secs(30);
const PARENT_WALK_LIMIT: usize = 8;
const CHILD_WALK_DEPTH: usize = 4;
const CHILD_WALK_NODE_LIMIT: usize = 32;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum HitQuality {
    Leaf,
    Ancestor,
    Container,
    #[default]
    None,
}

impl HitQuality {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Leaf => "leaf",
            Self::Ancestor => "ancestor",
            Self::Container => "container",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct UiaSnapshot {
    pub control_name: Option<String>,
    pub automation_id: Option<String>,
    pub control_type: Option<String>,
    pub class_name: Option<String>,
    pub is_password: bool,
    /// ValuePattern text (when plaintext capture is enabled).
    pub value_text: Option<String>,
    pub value_length: Option<u32>,
    /// SelectionPattern / SelectionItem selected labels.
    pub selected_names: Option<Vec<String>>,
    pub runtime_id: Option<Vec<i32>>,
    pub process_id: Option<u32>,
    pub window_hwnd: Option<String>,
    pub localized_control_type: Option<String>,
    pub framework_id: Option<String>,
    pub parent_path: Vec<UiElementPathEntry>,
    pub bounding_rect: Option<UiBoundingRect>,
    pub is_enabled: Option<bool>,
    pub has_keyboard_focus: Option<bool>,
    pub is_offscreen: Option<bool>,
    pub toggle_state: Option<ToggleState>,
    pub selection_state: Option<SelectionState>,
    pub expand_collapse_state: Option<ExpandCollapseState>,
    pub range_value: Option<f64>,
    pub hit_quality: HitQuality,
}

#[derive(Debug, Default)]
struct CircuitState {
    consecutive_failures: u32,
    open_until: Option<Instant>,
}

static CIRCUIT: Lazy<Mutex<CircuitState>> = Lazy::new(|| Mutex::new(CircuitState::default()));
static TIMEOUT_MS: AtomicU32 = AtomicU32::new(DEFAULT_TIMEOUT_MS as u32);
static UIA_WORKER: Lazy<Mutex<Option<SyncSender<UiaRequest>>>> = Lazy::new(|| Mutex::new(None));

#[derive(Debug, Clone, Copy)]
enum UiaRequestKind {
    Point { x: i32, y: i32 },
    Focused,
}

struct UiaRequest {
    kind: UiaRequestKind,
    reply: Sender<Option<UiaSnapshot>>,
}

#[allow(dead_code)]
pub fn set_timeout_ms(timeout_ms: u32) {
    TIMEOUT_MS.store(timeout_ms.clamp(10, 500), Ordering::Relaxed);
}

pub fn capture_at_point(x: i32, y: i32) -> Option<UiaSnapshot> {
    capture(UiaRequestKind::Point { x, y })
}

/// Capture the current keyboard focus element. Used for typing summaries; unlike
/// point capture, this follows UI Automation focus instead of the mouse cursor.
pub fn capture_focused() -> Option<UiaSnapshot> {
    capture(UiaRequestKind::Focused)
}

fn capture(kind: UiaRequestKind) -> Option<UiaSnapshot> {
    if is_circuit_open() {
        return None;
    }

    let timeout = Duration::from_millis(u64::from(TIMEOUT_MS.load(Ordering::Relaxed)));
    match capture_with_timeout(kind, timeout) {
        Some(snapshot) if snapshot.is_meaningful() => {
            note_success();
            Some(snapshot)
        }
        Some(snapshot) => {
            note_failure();
            #[cfg(test)]
            eprintln!(
                "uia enricher got non-meaningful snapshot: name={:?} type={:?} class={:?}",
                snapshot.control_name, snapshot.control_type, snapshot.class_name
            );
            Some(snapshot)
        }
        None => {
            note_failure();
            #[cfg(test)]
            eprintln!("uia enricher timeout/empty for {kind:?}");
            None
        }
    }
}

impl UiaSnapshot {
    pub fn has_identity(&self) -> bool {
        self.control_name
            .as_ref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
            || self
                .automation_id
                .as_ref()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
            || self
                .control_type
                .as_ref()
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
    }

    pub fn is_meaningful(&self) -> bool {
        self.has_identity() || self.is_password
    }

    pub fn precision_level(&self, has_window_title: bool) -> &'static str {
        if self.has_identity() {
            "l2"
        } else if has_window_title {
            "l1"
        } else {
            "l0"
        }
    }

    pub fn to_identity(&self) -> UiElementIdentity {
        UiElementIdentity {
            runtime_id: self.runtime_id.clone(),
            process_id: self.process_id,
            window_hwnd: self.window_hwnd.clone(),
            name: self.control_name.clone(),
            automation_id: self.automation_id.clone(),
            control_type: self.control_type.clone(),
            localized_control_type: self.localized_control_type.clone(),
            class_name: self.class_name.clone(),
            framework_id: self.framework_id.clone(),
            parent_path: self.parent_path.clone(),
            bounding_rect: self.bounding_rect.clone(),
        }
    }

    pub fn to_state_snapshot(&self, snapshot_id: String, captured_at_ms: u64) -> UiStateSnapshot {
        UiStateSnapshot {
            snapshot_id,
            captured_at_ms,
            element: Some(self.to_identity()),
            is_enabled: self.is_enabled,
            has_keyboard_focus: self.has_keyboard_focus,
            is_offscreen: self.is_offscreen,
            value_length: if self.is_password {
                None
            } else {
                self.value_length
            },
            value_text: if self.is_password {
                None
            } else {
                self.value_text.clone()
            },
            value_fingerprint: None,
            toggle_state: self.toggle_state.clone(),
            selection_state: self.selection_state.clone(),
            selected_names: if self.is_password {
                None
            } else {
                self.selected_names.clone()
            },
            expand_collapse_state: self.expand_collapse_state.clone(),
            range_value: self.range_value,
            privacy_class: if self.is_password {
                PrivacyClass::PasswordRedacted
            } else if self.value_text.is_some() {
                PrivacyClass::NotSensitive
            } else if self.value_length.is_some() {
                PrivacyClass::TextLengthOnly
            } else {
                PrivacyClass::NotSensitive
            },
            source: Some(UiStateSnapshotSource::UiaSnapshot),
        }
    }
}

pub(crate) fn hit_quality_for_control_type(control_type: Option<&str>) -> HitQuality {
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

fn is_circuit_open() -> bool {
    let Ok(state) = CIRCUIT.lock() else {
        return false;
    };
    if let Some(until) = state.open_until
        && Instant::now() < until
    {
        return true;
    }
    false
}

fn note_success() {
    if let Ok(mut state) = CIRCUIT.lock() {
        state.consecutive_failures = 0;
        state.open_until = None;
    }
}

fn note_failure() {
    if let Ok(mut state) = CIRCUIT.lock() {
        state.consecutive_failures = state.consecutive_failures.saturating_add(1);
        if state.consecutive_failures >= CIRCUIT_FAIL_THRESHOLD {
            state.open_until = Some(Instant::now() + CIRCUIT_COOLDOWN);
            state.consecutive_failures = 0;
        }
    }
}

fn capture_with_timeout(kind: UiaRequestKind, timeout: Duration) -> Option<UiaSnapshot> {
    let (reply, rx) = mpsc::channel();
    let request = UiaRequest { kind, reply };
    send_worker_request(request).ok()?;
    rx.recv_timeout(timeout).ok().flatten()
}

fn send_worker_request(request: UiaRequest) -> Result<(), ()> {
    let mut request = Some(request);
    for _ in 0..2 {
        let Some(sender) = ensure_worker_sender() else {
            return Err(());
        };
        let next_request = request.take().ok_or(())?;
        match sender.try_send(next_request) {
            Ok(()) => return Ok(()),
            Err(TrySendError::Full(_)) => return Err(()),
            Err(TrySendError::Disconnected(returned)) => {
                reset_worker_sender();
                request = Some(returned);
            }
        }
    }
    Err(())
}

fn ensure_worker_sender() -> Option<SyncSender<UiaRequest>> {
    let mut worker = UIA_WORKER.lock().ok()?;
    if let Some(sender) = worker.as_ref() {
        return Some(sender.clone());
    }

    let (tx, rx) = mpsc::sync_channel::<UiaRequest>(1);
    std::thread::Builder::new()
        .name("shadow-uia-worker".to_string())
        .spawn(move || run_uia_worker(rx))
        .ok()?;
    *worker = Some(tx.clone());
    Some(tx)
}

fn reset_worker_sender() {
    if let Ok(mut worker) = UIA_WORKER.lock() {
        *worker = None;
    }
}

fn run_uia_worker(rx: mpsc::Receiver<UiaRequest>) {
    for request in rx {
        let result = match request.kind {
            UiaRequestKind::Point { x, y } => capture_at_point_blocking(x, y),
            UiaRequestKind::Focused => capture_focused_blocking(),
        };
        let _ = request.reply.send(result);
    }
}

#[cfg(windows)]
fn capture_at_point_blocking(x: i32, y: i32) -> Option<UiaSnapshot> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize,
    };
    use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};

    unsafe {
        let com_owned = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let result = (|| {
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            let element = automation.ElementFromPoint(POINT { x, y }).ok()?;
            pick_best_element_at_point(&automation, &element, x, y)
        })();
        if com_owned {
            CoUninitialize();
        }
        result
    }
}

#[cfg(windows)]
fn pick_best_element(
    automation: &windows::Win32::UI::Accessibility::IUIAutomation,
    start: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<UiaSnapshot> {
    let walker = unsafe { automation.RawViewWalker().ok() };
    pick_best_from_candidates(
        collect_ancestor_candidates(walker.as_ref(), start),
        walker.as_ref(),
    )
}

#[cfg(windows)]
fn pick_best_element_at_point(
    automation: &windows::Win32::UI::Accessibility::IUIAutomation,
    start: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    x: i32,
    y: i32,
) -> Option<UiaSnapshot> {
    let walker = unsafe { automation.RawViewWalker().ok() };
    let start_snapshot = snapshot_from_element(start, walker.as_ref());
    if start_snapshot.is_meaningful() && start_snapshot.hit_quality == HitQuality::Leaf {
        return Some(start_snapshot);
    }
    let mut candidates = collect_ancestor_candidates(walker.as_ref(), start);
    candidates.extend(collect_child_point_hits(walker.as_ref(), start, x, y));
    pick_best_from_candidates(candidates, walker.as_ref())
        .or(Some(start_snapshot).filter(UiaSnapshot::is_meaningful))
}

#[cfg(windows)]
fn pick_best_from_candidates(
    candidates: Vec<windows::Win32::UI::Accessibility::IUIAutomationElement>,
    tree_walker: Option<&windows::Win32::UI::Accessibility::IUIAutomationTreeWalker>,
) -> Option<UiaSnapshot> {
    let mut best: Option<UiaSnapshot> = None;
    let mut best_score = i32::MIN;
    for element in candidates {
        let mut snapshot = snapshot_from_element(&element, tree_walker);
        snapshot.hit_quality = hit_quality_for_control_type(snapshot.control_type.as_deref());
        let score = score_snapshot(&snapshot);
        if score > best_score {
            best_score = score;
            best = Some(snapshot);
        }
    }
    best.filter(UiaSnapshot::is_meaningful)
}

#[cfg(windows)]
fn collect_ancestor_candidates(
    tree_walker: Option<&windows::Win32::UI::Accessibility::IUIAutomationTreeWalker>,
    start: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Vec<windows::Win32::UI::Accessibility::IUIAutomationElement> {
    use windows::Win32::UI::Accessibility::IUIAutomationElement;

    let mut candidates = Vec::new();
    let mut current: Option<IUIAutomationElement> = Some(start.clone());
    for _ in 0..PARENT_WALK_LIMIT {
        let Some(element) = current else {
            break;
        };
        current = tree_walker.and_then(|walker| unsafe { walker.GetParentElement(&element).ok() });
        candidates.push(element);
    }
    candidates
}

#[cfg(windows)]
fn collect_child_point_hits(
    tree_walker: Option<&windows::Win32::UI::Accessibility::IUIAutomationTreeWalker>,
    start: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    x: i32,
    y: i32,
) -> Vec<windows::Win32::UI::Accessibility::IUIAutomationElement> {
    use windows::Win32::UI::Accessibility::IUIAutomationElement;

    let Some(walker) = tree_walker else {
        return Vec::new();
    };

    let mut hits = Vec::new();
    let mut stack: Vec<(IUIAutomationElement, usize)> = Vec::new();
    if let Ok(child) = unsafe { walker.GetFirstChildElement(start) } {
        stack.push((child, 1));
    }

    while let Some((element, depth)) = stack.pop() {
        if hits.len() >= CHILD_WALK_NODE_LIMIT {
            break;
        }
        if !element_contains_point(&element, x, y) {
            if let Ok(sibling) = unsafe { walker.GetNextSiblingElement(&element) } {
                stack.push((sibling, depth));
            }
            continue;
        }
        hits.push(element.clone());
        if depth < CHILD_WALK_DEPTH
            && let Ok(child) = unsafe { walker.GetFirstChildElement(&element) }
        {
            stack.push((child, depth + 1));
        }
        if let Ok(sibling) = unsafe { walker.GetNextSiblingElement(&element) } {
            stack.push((sibling, depth));
        }
    }
    hits
}

#[cfg(windows)]
fn element_contains_point(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    x: i32,
    y: i32,
) -> bool {
    let Ok(rect) = (unsafe { element.CurrentBoundingRectangle() }) else {
        return false;
    };
    x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
}

const VALUE_TEXT_MAX_CHARS: usize = 256;
const SELECTED_NAMES_MAX: usize = 8;

#[cfg(windows)]
fn snapshot_from_element(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    tree_walker: Option<&windows::Win32::UI::Accessibility::IUIAutomationTreeWalker>,
) -> UiaSnapshot {
    let control_name = unsafe { element.CurrentName().ok() }.and_then(bstr_to_string);
    let automation_id = unsafe { element.CurrentAutomationId().ok() }.and_then(bstr_to_string);
    let class_name = unsafe { element.CurrentClassName().ok() }.and_then(bstr_to_string);
    let control_type = unsafe { element.CurrentControlType().ok() }
        .map(|id| control_type_id_name(id.0).to_string());
    let is_password = unsafe { element.CurrentIsPassword().ok() }
        .map(|value| value.as_bool())
        .unwrap_or(false);
    let (value_length, value_text) = if is_password {
        (None, None)
    } else {
        read_value_content(element)
    };
    let selected_names = if is_password {
        None
    } else {
        read_selected_names(element)
    };
    let native_hwnd =
        unsafe { element.CurrentNativeWindowHandle().ok() }.filter(|hwnd| !hwnd.is_invalid());
    let rect = unsafe { element.CurrentBoundingRectangle() }.ok();

    UiaSnapshot {
        control_name: normalize_text(control_name),
        automation_id: normalize_automation_id(automation_id),
        control_type: normalize_text(control_type.clone()),
        class_name: normalize_text(class_name),
        is_password,
        value_text,
        value_length,
        selected_names,
        runtime_id: unsafe { element.GetRuntimeId().ok() }.and_then(runtime_id_from_safe_array),
        process_id: unsafe { element.CurrentProcessId().ok() }
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| *value != 0),
        window_hwnd: native_hwnd.and_then(hwnd_to_hex),
        localized_control_type: unsafe { element.CurrentLocalizedControlType().ok() }
            .and_then(bstr_to_string)
            .and_then(|value| normalize_text(Some(value))),
        framework_id: unsafe { element.CurrentFrameworkId().ok() }
            .and_then(bstr_to_string)
            .and_then(|value| normalize_text(Some(value))),
        parent_path: parent_path_from_element(element, tree_walker),
        bounding_rect: rect.and_then(rect_to_bounding_rect),
        is_enabled: unsafe { element.CurrentIsEnabled().ok() }.map(|value| value.as_bool()),
        has_keyboard_focus: unsafe { element.CurrentHasKeyboardFocus().ok() }
            .map(|value| value.as_bool()),
        is_offscreen: unsafe { element.CurrentIsOffscreen().ok() }.map(|value| value.as_bool()),
        toggle_state: if is_password {
            None
        } else {
            read_toggle_state(element)
        },
        selection_state: if is_password {
            None
        } else {
            read_selection_state(element)
        },
        expand_collapse_state: read_expand_collapse_state(element),
        range_value: if is_password {
            None
        } else {
            read_range_value(element)
        },
        hit_quality: hit_quality_for_control_type(control_type.as_deref()),
    }
}

#[cfg(windows)]
fn hwnd_to_hex(hwnd: windows::Win32::Foundation::HWND) -> Option<String> {
    if hwnd.is_invalid() {
        return None;
    }
    Some(format!("0x{:x}", hwnd.0 as usize))
}

#[cfg(windows)]
fn rect_to_bounding_rect(rect: windows::Win32::Foundation::RECT) -> Option<UiBoundingRect> {
    let width = u32::try_from(rect.right.saturating_sub(rect.left)).ok()?;
    let height = u32::try_from(rect.bottom.saturating_sub(rect.top)).ok()?;
    if width == 0 || height == 0 {
        return None;
    }
    Some(UiBoundingRect {
        left: rect.left,
        top: rect.top,
        width,
        height,
    })
}

#[cfg(windows)]
fn runtime_id_from_safe_array(
    runtime_id: *mut windows::Win32::System::Com::SAFEARRAY,
) -> Option<Vec<i32>> {
    use windows::Win32::System::Ole::{
        SafeArrayAccessData, SafeArrayDestroy, SafeArrayGetLBound, SafeArrayGetUBound,
        SafeArrayUnaccessData,
    };

    if runtime_id.is_null() {
        return None;
    }

    let mut values = Vec::new();
    unsafe {
        let lower = SafeArrayGetLBound(runtime_id, 1).ok();
        let upper = SafeArrayGetUBound(runtime_id, 1).ok();
        if let (Some(lower), Some(upper)) = (lower, upper)
            && upper >= lower
        {
            let count = upper.saturating_sub(lower).saturating_add(1);
            let len = usize::try_from(count).unwrap_or_default().min(64);
            let mut data = std::ptr::null_mut();
            let accessed = SafeArrayAccessData(runtime_id, &mut data).is_ok();
            if accessed && !data.is_null() && len > 0 {
                let slice = std::slice::from_raw_parts(data.cast::<i32>(), len);
                values.extend_from_slice(slice);
            }
            if accessed {
                let _ = SafeArrayUnaccessData(runtime_id);
            }
        }
        let _ = SafeArrayDestroy(runtime_id);
    }

    (!values.is_empty()).then_some(values)
}

#[cfg(windows)]
fn parent_path_from_element(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    tree_walker: Option<&windows::Win32::UI::Accessibility::IUIAutomationTreeWalker>,
) -> Vec<UiElementPathEntry> {
    let Some(walker) = tree_walker else {
        return Vec::new();
    };

    let mut path = Vec::new();
    let mut current = element.clone();
    for _ in 0..PARENT_WALK_LIMIT {
        let Ok(parent) = (unsafe { walker.GetParentElement(&current) }) else {
            break;
        };
        let entry = UiElementPathEntry {
            control_type: unsafe { parent.CurrentControlType().ok() }
                .map(|id| control_type_id_name(id.0).to_string()),
            name: unsafe { parent.CurrentName().ok() }.and_then(bstr_to_string),
            automation_id: unsafe { parent.CurrentAutomationId().ok() }
                .and_then(bstr_to_string)
                .and_then(|value| normalize_automation_id(Some(value))),
        };
        if entry.control_type.is_some() || entry.name.is_some() || entry.automation_id.is_some() {
            path.push(entry);
        }
        current = parent;
    }
    path.reverse();
    path
}

#[cfg(windows)]
fn read_toggle_state(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<ToggleState> {
    use windows::Win32::UI::Accessibility::{
        IUIAutomationTogglePattern, ToggleState_Indeterminate, ToggleState_Off, ToggleState_On,
        UIA_TogglePatternId,
    };

    let pattern =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) }
            .ok()?;
    let state = unsafe { pattern.CurrentToggleState() }.ok()?;
    Some(match state {
        ToggleState_On => ToggleState::On,
        ToggleState_Off => ToggleState::Off,
        ToggleState_Indeterminate => ToggleState::Indeterminate,
        _ => ToggleState::Unknown,
    })
}

#[cfg(windows)]
fn read_selection_state(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<SelectionState> {
    use windows::Win32::UI::Accessibility::{
        IUIAutomationSelectionItemPattern, UIA_SelectionItemPatternId,
    };

    let pattern = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
    }
    .ok()?;
    let selected = unsafe { pattern.CurrentIsSelected() }
        .ok()
        .map(|value| value.as_bool())?;
    Some(if selected {
        SelectionState::Selected
    } else {
        SelectionState::NotSelected
    })
}

#[cfg(windows)]
fn read_expand_collapse_state(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<ExpandCollapseState> {
    use windows::Win32::UI::Accessibility::{
        ExpandCollapseState_Collapsed, ExpandCollapseState_Expanded, ExpandCollapseState_LeafNode,
        ExpandCollapseState_PartiallyExpanded, IUIAutomationExpandCollapsePattern,
        UIA_ExpandCollapsePatternId,
    };

    let pattern = unsafe {
        element
            .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
    }
    .ok()?;
    let state = unsafe { pattern.CurrentExpandCollapseState() }.ok()?;
    Some(match state {
        ExpandCollapseState_Expanded => ExpandCollapseState::Expanded,
        ExpandCollapseState_Collapsed => ExpandCollapseState::Collapsed,
        ExpandCollapseState_PartiallyExpanded => ExpandCollapseState::PartiallyExpanded,
        ExpandCollapseState_LeafNode => ExpandCollapseState::LeafNode,
        _ => ExpandCollapseState::Unknown,
    })
}

#[cfg(windows)]
fn read_range_value(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<f64> {
    use windows::Win32::UI::Accessibility::{
        IUIAutomationRangeValuePattern, UIA_RangeValuePatternId,
    };

    let pattern = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationRangeValuePattern>(UIA_RangeValuePatternId)
    }
    .ok()?;
    unsafe { pattern.CurrentValue() }.ok()
}

#[cfg(windows)]
fn read_value_content(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> (Option<u32>, Option<String>) {
    use windows::Win32::UI::Accessibility::{IUIAutomationValuePattern, UIA_ValuePatternId};

    let Ok(pattern) =
        (unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) })
    else {
        return (None, None);
    };
    let Ok(raw) = (unsafe { pattern.CurrentValue() }) else {
        return (None, None);
    };
    let text = raw.to_string();
    let length = u32::try_from(text.chars().count()).ok();
    let value_text = if crate::session::defect_config::is_semantic_plaintext_input_enabled() {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(truncate_chars(trimmed, VALUE_TEXT_MAX_CHARS))
        }
    } else {
        None
    };
    (length, value_text)
}

#[cfg(windows)]
fn read_selected_names(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<Vec<String>> {
    use windows::Win32::UI::Accessibility::{
        IUIAutomationSelectionItemPattern, IUIAutomationSelectionPattern,
        UIA_SelectionItemPatternId, UIA_SelectionPatternId,
    };

    if let Ok(pattern) = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationSelectionPattern>(UIA_SelectionPatternId)
    } && let Ok(selected) = unsafe { pattern.GetCurrentSelection() }
    {
        let mut names = Vec::new();
        let len = unsafe { selected.Length() }.unwrap_or(0);
        let limit = len.min(SELECTED_NAMES_MAX as i32);
        for index in 0..limit {
            if let Ok(item) = unsafe { selected.GetElement(index) }
                && let Ok(name) = unsafe { item.CurrentName() }
            {
                let text = name.to_string();
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    names.push(truncate_chars(trimmed, VALUE_TEXT_MAX_CHARS));
                }
            }
        }
        if !names.is_empty() {
            return Some(names);
        }
    }

    if let Ok(pattern) = unsafe {
        element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
    } && unsafe { pattern.CurrentIsSelected() }
        .ok()
        .map(|v| v.as_bool())
        .unwrap_or(false)
        && let Ok(name) = unsafe { element.CurrentName() }
    {
        let text = name.to_string();
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(vec![truncate_chars(trimmed, VALUE_TEXT_MAX_CHARS)]);
        }
    }
    None
}

#[cfg(windows)]
fn truncate_chars(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(windows)]
fn bstr_to_string(value: windows::core::BSTR) -> Option<String> {
    let text = value.to_string();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(windows)]
fn control_type_id_name(id: i32) -> &'static str {
    match id {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        _ => "Control",
    }
}

#[cfg(windows)]
fn capture_focused_blocking() -> Option<UiaSnapshot> {
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize,
    };
    use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};

    unsafe {
        let com_owned = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let result = (|| {
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
            let element = automation.GetFocusedElement().ok()?;
            pick_best_element(&automation, &element)
        })();
        if com_owned {
            CoUninitialize();
        }
        result
    }
}

#[cfg(not(windows))]
fn capture_at_point_blocking(_x: i32, _y: i32) -> Option<UiaSnapshot> {
    None
}

#[cfg(not(windows))]
fn capture_focused_blocking() -> Option<UiaSnapshot> {
    None
}

fn normalize_text(value: Option<String>) -> Option<String> {
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
}

fn score_snapshot(snapshot: &UiaSnapshot) -> i32 {
    let mut score = 0;
    let control_type = snapshot.control_type.as_deref().unwrap_or("");
    let control_name = snapshot.control_name.as_deref().unwrap_or("").trim();
    let automation_id = snapshot.automation_id.as_deref().unwrap_or("");

    // Prefer interactive leaf controls over window/pane containers.
    score += match control_type {
        "Button" | "CheckBox" | "RadioButton" | "Edit" | "ComboBox" | "Hyperlink" | "MenuItem"
        | "TabItem" | "ListItem" | "TreeItem" | "SplitButton" | "Spinner" | "Slider" | "Text" => {
            120
        }
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
    score += match snapshot.hit_quality {
        HitQuality::Leaf => 35,
        HitQuality::Ancestor => 8,
        HitQuality::Container => -20,
        HitQuality::None => 0,
    };
    if snapshot
        .runtime_id
        .as_ref()
        .is_some_and(|id| !id.is_empty())
    {
        score += 20;
    }
    if snapshot.bounding_rect.is_some() {
        score += 8;
    }
    score
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn precision_level_prefers_identity() {
        let snapshot = UiaSnapshot {
            control_name: Some("保存".to_string()),
            control_type: Some("Button".to_string()),
            ..UiaSnapshot::default()
        };
        assert_eq!(snapshot.precision_level(true), "l2");
        assert_eq!(UiaSnapshot::default().precision_level(true), "l1");
        assert_eq!(UiaSnapshot::default().precision_level(false), "l0");
    }

    #[test]
    fn password_snapshot_is_meaningful_without_plain_identity() {
        let snapshot = UiaSnapshot {
            is_password: true,
            ..UiaSnapshot::default()
        };

        assert!(snapshot.is_meaningful());
        assert!(!UiaSnapshot::default().is_meaningful());
    }

    #[test]
    fn hit_quality_prefers_interactive_leaves_over_containers() {
        assert_eq!(
            hit_quality_for_control_type(Some("Button")),
            HitQuality::Leaf
        );
        assert_eq!(
            hit_quality_for_control_type(Some("CheckBox")),
            HitQuality::Leaf
        );
        assert_eq!(
            hit_quality_for_control_type(Some("Pane")),
            HitQuality::Container
        );
        assert_eq!(
            hit_quality_for_control_type(Some("Window")),
            HitQuality::Container
        );
    }

    #[test]
    fn snapshot_projects_full_identity_and_before_state() {
        let snapshot = UiaSnapshot {
            control_name: Some("启用同步".to_string()),
            automation_id: Some("chkSync".to_string()),
            control_type: Some("CheckBox".to_string()),
            runtime_id: Some(vec![1, 2, 3]),
            process_id: Some(42),
            window_hwnd: Some("0x100".to_string()),
            bounding_rect: Some(UiBoundingRect {
                left: 10,
                top: 20,
                width: 80,
                height: 24,
            }),
            toggle_state: Some(ToggleState::Off),
            is_enabled: Some(true),
            hit_quality: HitQuality::Leaf,
            ..UiaSnapshot::default()
        };

        let identity = snapshot.to_identity();
        assert_eq!(identity.runtime_id.as_deref(), Some(&[1, 2, 3][..]));
        assert_eq!(identity.automation_id.as_deref(), Some("chkSync"));
        assert_eq!(identity.process_id, Some(42));

        let state = snapshot.to_state_snapshot("state-pre-1".to_string(), 1_000);
        assert_eq!(state.captured_at_ms, 1_000);
        assert_eq!(state.toggle_state, Some(ToggleState::Off));
        assert_eq!(
            state.element.as_ref().and_then(|item| item.name.as_deref()),
            Some("启用同步")
        );
    }
}
