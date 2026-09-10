use std::collections::HashMap;

use super::operation_models::{UiElementIdentity, UiStateSnapshot};

const DEFAULT_TTL_MS: u64 = 5 * 60 * 1_000;

#[derive(Debug, Clone, PartialEq)]
pub struct UiaStateCacheUpdate {
    pub cache_key: String,
    pub before: Option<UiStateSnapshot>,
    pub after: UiStateSnapshot,
}

#[derive(Debug, Clone)]
struct CachedStateEntry {
    snapshot: UiStateSnapshot,
    last_seen_ms: u64,
}

#[derive(Debug, Clone)]
pub struct UiaStateCache {
    ttl_ms: u64,
    entries: HashMap<String, CachedStateEntry>,
}

impl Default for UiaStateCache {
    fn default() -> Self {
        Self::new(DEFAULT_TTL_MS)
    }
}

impl UiaStateCache {
    pub fn new(ttl_ms: u64) -> Self {
        Self {
            ttl_ms,
            entries: HashMap::new(),
        }
    }

    pub fn apply_snapshot(&mut self, snapshot: UiStateSnapshot) -> Option<UiaStateCacheUpdate> {
        let element = snapshot.element.as_ref()?;
        let cache_key = state_cache_key(element)?;
        let last_seen_ms = snapshot.captured_at_ms;
        let before = self
            .entries
            .insert(
                cache_key.clone(),
                CachedStateEntry {
                    snapshot: snapshot.clone(),
                    last_seen_ms,
                },
            )
            .map(|entry| entry.snapshot);

        Some(UiaStateCacheUpdate {
            cache_key,
            before,
            after: snapshot,
        })
    }

    #[cfg(test)]
    pub fn get(&self, element: &UiElementIdentity) -> Option<&UiStateSnapshot> {
        let key = state_cache_key(element)?;
        self.entries.get(&key).map(|entry| &entry.snapshot)
    }

    pub fn remove_element(&mut self, element: &UiElementIdentity) -> Option<UiStateSnapshot> {
        let key = state_cache_key(element)?;
        self.entries.remove(&key).map(|entry| entry.snapshot)
    }

    pub fn remove_window(&mut self, window_hwnd: &str) -> usize {
        let normalized = normalize_cache_part(window_hwnd);
        let before_len = self.entries.len();
        self.entries.retain(|_, entry| {
            entry
                .snapshot
                .element
                .as_ref()
                .and_then(|element| element.window_hwnd.as_deref())
                .map(normalize_cache_part)
                .as_deref()
                != Some(normalized.as_str())
        });
        before_len.saturating_sub(self.entries.len())
    }

    pub fn prune_expired(&mut self, now_ms: u64) -> usize {
        let before_len = self.entries.len();
        let ttl_ms = self.ttl_ms;
        self.entries
            .retain(|_, entry| now_ms.saturating_sub(entry.last_seen_ms) <= ttl_ms);
        before_len.saturating_sub(self.entries.len())
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

pub fn state_cache_key(element: &UiElementIdentity) -> Option<String> {
    if let Some(runtime_id) = element
        .runtime_id
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        let pid = element
            .process_id
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let runtime_id = runtime_id
            .iter()
            .map(i32::to_string)
            .collect::<Vec<_>>()
            .join(".");
        return Some(format!("runtime:{pid}:{runtime_id}"));
    }

    let hwnd = normalize_cache_part(element.window_hwnd.as_deref()?);
    let control_type = normalize_cache_part(element.control_type.as_deref().unwrap_or(""));
    let automation_id = normalize_cache_part(element.automation_id.as_deref().unwrap_or(""));
    let name = normalize_cache_part(element.name.as_deref().unwrap_or(""));
    let bounds = element
        .bounding_rect
        .as_ref()
        .map(|rect| format!("{}:{}:{}:{}", rect.left, rect.top, rect.width, rect.height))
        .unwrap_or_default();
    let parent_path = element
        .parent_path
        .iter()
        .map(|entry| {
            format!(
                "{}:{}:{}",
                normalize_cache_part(entry.control_type.as_deref().unwrap_or("")),
                normalize_cache_part(entry.automation_id.as_deref().unwrap_or("")),
                normalize_cache_part(entry.name.as_deref().unwrap_or(""))
            )
        })
        .collect::<Vec<_>>()
        .join("/");

    let has_locator = !automation_id.is_empty()
        || !name.is_empty()
        || !control_type.is_empty()
        || !bounds.is_empty();
    if !has_locator {
        return None;
    }

    let pid = element
        .process_id
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    Some(format!(
        "locator:{pid}:{hwnd}:{control_type}:{automation_id}:{name}:{parent_path}:{bounds}"
    ))
}

fn normalize_cache_part(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;
    use crate::session::operation_models::{
        PrivacyClass, ToggleState, UiBoundingRect, UiElementPathEntry, UiStateSnapshotSource,
    };

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GoldenLocatorSampleCase {
        case_id: String,
        expected_strategy: String,
        expected_cache_key: String,
        samples: Vec<UiElementIdentity>,
    }

    #[test]
    fn golden_locator_samples_are_stable_across_repeated_sampling() {
        let cases: Vec<GoldenLocatorSampleCase> = serde_json::from_str(include_str!(
            "../../tests/fixtures/operations/uia-locator-samples.json"
        ))
        .expect("golden locator samples should parse");
        assert!(cases.len() >= 3);

        for case in cases {
            assert!(
                !case.samples.is_empty(),
                "{} has no locator samples",
                case.case_id
            );
            let expected_prefix = match case.expected_strategy.as_str() {
                "runtime" => "runtime:",
                "locator" => "locator:",
                other => panic!("{} has unknown strategy {other}", case.case_id),
            };
            assert!(
                case.expected_cache_key.starts_with(expected_prefix),
                "{} expected key does not match strategy",
                case.case_id
            );

            let keys = case.samples.iter().map(state_cache_key).collect::<Vec<_>>();
            assert!(
                keys.iter().all(Option::is_some),
                "{} contains a sample without a stable key: {:?}",
                case.case_id,
                keys
            );
            assert!(
                keys.iter()
                    .all(|key| key.as_deref() == Some(case.expected_cache_key.as_str())),
                "{} samples did not resolve to the frozen key: {:?}",
                case.case_id,
                keys
            );
        }
    }

    #[test]
    fn state_cache_prefers_runtime_id_for_keys() {
        let element = UiElementIdentity {
            runtime_id: Some(vec![42, 7, 19]),
            process_id: Some(1234),
            window_hwnd: Some("0xaaaa".to_string()),
            automation_id: Some("save".to_string()),
            ..UiElementIdentity::default()
        };

        assert_eq!(
            state_cache_key(&element).as_deref(),
            Some("runtime:1234:42.7.19")
        );
    }

    #[test]
    fn state_cache_uses_locator_fallback_and_tracks_before_after() {
        let element = UiElementIdentity {
            process_id: Some(1234),
            window_hwnd: Some("0xABCD".to_string()),
            name: Some("Save".to_string()),
            automation_id: Some("btnSave".to_string()),
            control_type: Some("Button".to_string()),
            parent_path: vec![UiElementPathEntry {
                control_type: Some("Window".to_string()),
                name: Some("Editor".to_string()),
                automation_id: None,
            }],
            bounding_rect: Some(UiBoundingRect {
                left: 1,
                top: 2,
                width: 3,
                height: 4,
            }),
            ..UiElementIdentity::default()
        };
        let mut cache = UiaStateCache::default();
        let first = sample_snapshot("state-1", 10, element.clone(), Some(ToggleState::Off));
        let first_update = cache.apply_snapshot(first.clone()).expect("first update");
        assert!(first_update.before.is_none());
        assert_eq!(cache.get(&element), Some(&first));

        let second = sample_snapshot("state-2", 20, element.clone(), Some(ToggleState::On));
        let second_update = cache.apply_snapshot(second.clone()).expect("second update");
        assert_eq!(second_update.before, Some(first));
        assert_eq!(second_update.after, second);
    }

    #[test]
    fn state_cache_prunes_by_window_and_ttl() {
        let mut cache = UiaStateCache::new(100);
        let element_a = UiElementIdentity {
            window_hwnd: Some("0x1".to_string()),
            automation_id: Some("a".to_string()),
            ..UiElementIdentity::default()
        };
        let element_b = UiElementIdentity {
            window_hwnd: Some("0x2".to_string()),
            automation_id: Some("b".to_string()),
            ..UiElementIdentity::default()
        };
        cache.apply_snapshot(sample_snapshot("state-a", 10, element_a, None));
        cache.apply_snapshot(sample_snapshot("state-b", 200, element_b.clone(), None));

        assert_eq!(cache.prune_expired(150), 1);
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.remove_window("0X2"), 1);
        assert_eq!(cache.len(), 0);
    }

    fn sample_snapshot(
        snapshot_id: &str,
        captured_at_ms: u64,
        element: UiElementIdentity,
        toggle_state: Option<ToggleState>,
    ) -> UiStateSnapshot {
        UiStateSnapshot {
            snapshot_id: snapshot_id.to_string(),
            captured_at_ms,
            element: Some(element),
            is_enabled: Some(true),
            has_keyboard_focus: Some(false),
            is_offscreen: Some(false),
            value_length: None,
            value_text: None,
            value_fingerprint: None,
            toggle_state,
            selection_state: None,
            selected_names: None,
            expand_collapse_state: None,
            range_value: None,
            privacy_class: PrivacyClass::NotSensitive,
            source: Some(UiStateSnapshotSource::UiaPropertyEvent),
        }
    }
}
