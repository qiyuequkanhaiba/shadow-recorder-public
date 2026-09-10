# -*- coding: utf-8 -*-
from pathlib import Path

p = Path(__file__).resolve().parents[1] / "src" / "session" / "semantic_profile.rs"
s = p.read_text(encoding="utf-8")

old_enabled = """    #[serde(default)]
    pub enabled: bool,"""
new_enabled = """    #[serde(default = "default_enabled_true")]
    pub enabled: bool,"""
if "default_enabled_true" not in s:
    s = s.replace(old_enabled, new_enabled, 1)
    s = s.replace(
        """fn default_schema_version() -> u32 {
    SEMANTIC_PROFILE_SCHEMA_VERSION
}""",
        """fn default_schema_version() -> u32 {
    SEMANTIC_PROFILE_SCHEMA_VERSION
}

fn default_enabled_true() -> bool {
    true
}""",
        1,
    )
    print("enabled default true")

old_parse = """pub fn parse_semantic_profile_json(content: &str) -> Option<SemanticProfile> {
    let value: serde_json::Value = serde_json::from_str(content).ok()?;
    // Nested snapshot: { profile: {...} } or { Profile: {...} }
    if let Some(profile_value) = value
        .get("profile")
        .or_else(|| value.get("Profile"))
        .cloned()
    {
        if let Ok(mut profile) = serde_json::from_value::<SemanticProfile>(profile_value) {
            normalize_profile(&mut profile);
            return Some(profile);
        }
    }
    // Direct profile object (qttimer SemanticProfileSnapshot shape without wrapper).
    if let Ok(mut profile) = serde_json::from_value::<SemanticProfile>(value.clone()) {
        if !profile.profile_id.trim().is_empty() || !profile.alias_rules.is_empty() {
            normalize_profile(&mut profile);
            return Some(profile);
        }
    }
    // Legacy thin alias file: { profileId, rules: [...] }
    if let Ok(legacy) = serde_json::from_value::<SemanticAliasProfile>(value) {
        return Some(semantic_profile_from_alias_profile(legacy));
    }
    None
}"""

new_parse = r'''pub fn parse_semantic_profile_json(content: &str) -> Option<SemanticProfile> {
    let value: serde_json::Value = serde_json::from_str(content).ok()?;
    // Nested snapshot: { profile: {...} } or { Profile: {...} }
    if let Some(profile_value) = value
        .get("profile")
        .or_else(|| value.get("Profile"))
        .cloned()
    {
        if let Ok(mut profile) = serde_json::from_value::<SemanticProfile>(profile_value) {
            normalize_profile(&mut profile);
            return Some(profile);
        }
    }
    // Direct profile object (qttimer SemanticProfileSnapshot shape without wrapper).
    if let Ok(mut profile) = serde_json::from_value::<SemanticProfile>(value.clone()) {
        if !profile.profile_id.trim().is_empty() || !profile.alias_rules.is_empty() {
            normalize_profile(&mut profile);
            return Some(profile);
        }
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
    } else if let Some(arr) = value
        .get("elements")
        .or_else(|| value.get("selectedElements"))
        .or_else(|| value.get("selected_elements"))
        .and_then(|v| v.as_array())
    {
        arr.as_slice()
    } else {
        return None;
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
        other if other.is_empty() => "Unknown".to_string(),
        other => {
            if raw.chars().next().map(|c| c.is_uppercase()).unwrap_or(false) {
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
    let st = item.get("semantic_target").or_else(|| item.get("semanticTarget"));
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

    let control_type =
        string_field(item, &["component_type", "componentType", "control_type", "controlType"])
            .map(|v| map_component_type(&v));
    let action_type = string_field(item, &["action_type", "actionType"]);
    let module_name =
        string_field(item, &["parent_module", "parentModule", "module_name", "moduleName"]);
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
'''

if "parse_qttimer_elements_export" not in s:
    if old_parse not in s:
        raise SystemExit("old_parse not found")
    s = s.replace(old_parse, new_parse)
    print("parse replaced")
else:
    print("parse already has elements export")

test_marker = "fn converts_legacy_alias_profile() {"
if "parses_qttimer_elements_selected_array" not in s:
    test_fn = r'''
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
        assert_eq!(profile.alias_rules[0].alias.as_deref(), Some("新建项目_确认按钮"));
        assert_eq!(
            profile.alias_rules[0].match_automation_id.as_deref(),
            Some("btn.CreateNewProject.Confirm")
        );
        assert_eq!(profile.alias_rules[0].control_type.as_deref(), Some("Button"));
        assert_eq!(profile.alias_rules[1].control_type.as_deref(), Some("Edit"));
        assert_eq!(profile.alias_rules[1].module_name.as_deref(), Some("新建项目"));
    }

    '''
    if test_marker not in s:
        raise SystemExit("test marker not found")
    s = s.replace(test_marker, test_fn + test_marker)
    print("test added")

p.write_text(s, encoding="utf-8")
print("written", p, "len", len(s))
