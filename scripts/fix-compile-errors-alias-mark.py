# -*- coding: utf-8 -*-
from pathlib import Path

mgr = Path("src/session/manager.rs")
s = mgr.read_text(encoding="utf-8")
old = """            manager.mark_defect(TestSessionDefectMarkInput {
                marked_at_ms: Some(step.timestamp_ms + 500),
                pre_window_seconds: Some(5),
                post_window_seconds: Some(5),
                note: Some("保存后金额未刷新".to_string()),
                expected: Some("金额刷新为最新值".to_string()),
                actual: Some("金额仍显示旧值".to_string()),
            })"""
new = """            manager.mark_defect(TestSessionDefectMarkInput {
                session_id: None,
                marked_at_ms: Some(step.timestamp_ms + 500),
                pre_window_seconds: Some(5),
                post_window_seconds: Some(5),
                note: Some("保存后金额未刷新".to_string()),
                expected: Some("金额刷新为最新值".to_string()),
                actual: Some("金额仍显示旧值".to_string()),
            })"""
if old not in s:
    raise SystemExit("manager test block not found")
mgr.write_text(s.replace(old, new), encoding="utf-8")
print("manager test ok")

sp = Path("src/session/semantic_profile.rs")
t = sp.read_text(encoding="utf-8")
t = t.replace(
    """    #[test]
    
    #[test]
    fn parses_qttimer_elements_selected_array()""",
    """    #[test]
    fn parses_qttimer_elements_selected_array()""",
)

if "fn matches_hierarchical_automation_id_suffix" not in t:
    insert = r'''
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

'''
    t = t.replace(
        "    #[test]\n    fn parses_qttimer_elements_selected_array()",
        insert + "    #[test]\n    fn parses_qttimer_elements_selected_array()",
        1,
    )

sp.write_text(t, encoding="utf-8")
print("semantic profile tests ok", "matches_hierarchical_automation_id_suffix" in t)
