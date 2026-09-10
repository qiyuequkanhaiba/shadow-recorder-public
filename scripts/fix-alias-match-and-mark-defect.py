# -*- coding: utf-8 -*-
"""1) Flexible automationId alias match  2) mark_defect for stopped sessions."""
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]

# ---------- semantic_profile.rs: flexible automation id ----------
sp = root / "src" / "session" / "semantic_profile.rs"
text = sp.read_text(encoding="utf-8")

old_match = """    if let Some(expected) = automation_id {
        matched_any = true;
        let actual = identity
            .and_then(|item| item.automation_id.as_deref())
            .unwrap_or("");
        if !actual.eq_ignore_ascii_case(expected) {
            return false;
        }
    }"""

new_match = """    if let Some(expected) = automation_id {
        matched_any = true;
        let actual = identity
            .and_then(|item| item.automation_id.as_deref())
            .unwrap_or("");
        if !automation_id_matches(expected, actual) {
            return false;
        }
    }"""

if "fn automation_id_matches" not in text:
    if old_match not in text:
        raise SystemExit("alias_rule_matches automation block not found")
    text = text.replace(old_match, new_match, 1)

    # Improve scoring: longer automation id wins over equal priority
    old_best = """        let candidate = AliasMatch {
            alias,
            rule_id: rule.rule_id.clone(),
            priority: rule.priority,
        };
        if best
            .as_ref()
            .is_none_or(|current| candidate.priority > current.priority)
        {
            best = Some(candidate);
        }"""
    new_best = """        let specificity = rule
            .match_automation_id
            .as_deref()
            .or(rule.automation_id.as_deref())
            .map(|v| v.trim().len())
            .unwrap_or(0) as i32;
        let candidate = AliasMatch {
            alias,
            rule_id: rule.rule_id.clone(),
            // Prefer higher rule priority, then more specific (longer) automationId.
            priority: rule.priority.saturating_mul(10_000).saturating_add(specificity),
        };
        if best
            .as_ref()
            .is_none_or(|current| candidate.priority > current.priority)
        {
            best = Some(candidate);
        }"""
    if old_best not in text:
        raise SystemExit("best candidate block not found")
    text = text.replace(old_best, new_best, 1)

    helper = """
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
    false
}

"""
    # insert before resolve_alias_for_identity
    anchor = "pub fn resolve_alias_for_identity("
    if anchor not in text:
        raise SystemExit("resolve_alias_for_identity not found")
    text = text.replace(anchor, helper + anchor, 1)

    # force title rewrite to alias
    old_title = """            operation.business_alias = Some(matched.alias.clone());
            // Rewrite user-facing title while keeping generic summary rebuild simple.
            if !operation.title.contains(&matched.alias) {
                operation.title = matched.alias.clone();
            }"""
    new_title = """            operation.business_alias = Some(matched.alias.clone());
            // Always surface business alias as the primary title for review/export.
            operation.title = matched.alias.clone();"""
    if old_title in text:
        text = text.replace(old_title, new_title, 1)

    sp.write_text(text, encoding="utf-8")
    print("semantic_profile.rs patched")
else:
    print("semantic_profile already has automation_id_matches")

# ---------- semantic_alias.rs ----------
sa = root / "src" / "session" / "semantic_alias.rs"
at = sa.read_text(encoding="utf-8")
old_a = """    if let Some(expected) = rule
        .match_automation_id
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        matched_any_condition = true;
        let actual = step.automation_id.as_deref().unwrap_or("");
        if !actual.eq_ignore_ascii_case(expected) {
            return false;
        }
    }"""
new_a = """    if let Some(expected) = rule
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
    }"""
if "fn automation_id_matches_alias" not in at:
    if old_a not in at:
        raise SystemExit("semantic_alias automation match not found")
    at = at.replace(old_a, new_a, 1)
    helper_a = """
fn automation_id_matches_alias(expected: &str, actual: &str) -> bool {
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
}

"""
    # insert before rule_matches
    at = at.replace("fn rule_matches(", helper_a + "fn rule_matches(", 1)
    sa.write_text(at, encoding="utf-8")
    print("semantic_alias.rs patched")
else:
    print("semantic_alias already patched")

# Add unit test for suffix match in semantic_profile
if "matches_hierarchical_automation_id_suffix" not in sp.read_text(encoding="utf-8"):
    sp_text = sp.read_text(encoding="utf-8")
    test = r'''
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
    marker = "fn converts_legacy_alias_profile() {"
    if marker not in sp_text:
        # try existing test name
        marker = "fn parses_qttimer_elements_selected_array() {"
    if marker in sp_text:
        sp_text = sp_text.replace(marker, test + marker, 1)
        sp.write_text(sp_text, encoding="utf-8")
        print("suffix match test added")
    else:
        print("WARN: could not add test")

# ---------- mark_defect session_id support ----------
models = root / "src" / "session" / "models.rs"
mt = models.read_text(encoding="utf-8")
if "session_id: Option<String>" not in mt[mt.find("TestSessionDefectMarkInput"):mt.find("TestSessionDefectMarkInput")+300]:
    mt = mt.replace(
        """pub struct TestSessionDefectMarkInput {
    pub note: Option<String>,
    pub expected: Option<String>,
    pub actual: Option<String>,
    pub marked_at_ms: Option<u64>,
    pub pre_window_seconds: Option<u32>,
    pub post_window_seconds: Option<u32>,
}""",
        """pub struct TestSessionDefectMarkInput {
    /// Optional session to mark. When recording has stopped, pass the review session id.
    pub session_id: Option<String>,
    pub note: Option<String>,
    pub expected: Option<String>,
    pub actual: Option<String>,
    pub marked_at_ms: Option<u64>,
    pub pre_window_seconds: Option<u32>,
    pub post_window_seconds: Option<u32>,
}""",
    )
    models.write_text(mt, encoding="utf-8")
    print("models DefectMarkInput +session_id")
else:
    print("models already has session_id on defect mark")

types = root / "src" / "types.rs"
tt = types.read_text(encoding="utf-8")
if "pub session_id: Option<String>" not in tt[tt.find("JsTestSessionDefectMarkInput"):tt.find("JsTestSessionDefectMarkInput")+250]:
    tt = tt.replace(
        """pub struct JsTestSessionDefectMarkInput {
    pub note: Option<String>,
    pub expected: Option<String>,
    pub actual: Option<String>,
    pub marked_at_ms: Option<f64>,
    pub pre_window_seconds: Option<u32>,
    pub post_window_seconds: Option<u32>,
}""",
        """pub struct JsTestSessionDefectMarkInput {
    pub session_id: Option<String>,
    pub note: Option<String>,
    pub expected: Option<String>,
    pub actual: Option<String>,
    pub marked_at_ms: Option<f64>,
    pub pre_window_seconds: Option<u32>,
    pub post_window_seconds: Option<u32>,
}""",
    )
    tt = tt.replace(
        """impl From<JsTestSessionDefectMarkInput> for TestSessionDefectMarkInput {
    fn from(value: JsTestSessionDefectMarkInput) -> Self {
        Self {
            note: value.note,
            expected: value.expected,
            actual: value.actual,
            marked_at_ms: value.marked_at_ms.map(|ms| ms.max(0.0) as u64),
            pre_window_seconds: value.pre_window_seconds,
            post_window_seconds: value.post_window_seconds,
        }
    }
}""",
        """impl From<JsTestSessionDefectMarkInput> for TestSessionDefectMarkInput {
    fn from(value: JsTestSessionDefectMarkInput) -> Self {
        Self {
            session_id: value.session_id,
            note: value.note,
            expected: value.expected,
            actual: value.actual,
            marked_at_ms: value.marked_at_ms.map(|ms| ms.max(0.0) as u64),
            pre_window_seconds: value.pre_window_seconds,
            post_window_seconds: value.post_window_seconds,
        }
    }
}""",
    )
    types.write_text(tt, encoding="utf-8")
    print("types.js defect mark +session_id")
else:
    print("types already session_id")

# lib.rs mark_test_defect pass session_id
lib = root / "src" / "lib.rs"
lt = lib.read_text(encoding="utf-8")
old_lib = """        .mark_defect(crate::session::TestSessionDefectMarkInput {
            note: input.note,
            expected: input.expected,
            actual: input.actual,
            marked_at_ms,
            pre_window_seconds: input.pre_window_seconds,
            post_window_seconds: input.post_window_seconds,
        })"""
new_lib = """        .mark_defect(crate::session::TestSessionDefectMarkInput {
            session_id: input.session_id,
            note: input.note,
            expected: input.expected,
            actual: input.actual,
            marked_at_ms,
            pre_window_seconds: input.pre_window_seconds,
            post_window_seconds: input.post_window_seconds,
        })"""
if old_lib in lt:
    lib.write_text(lt.replace(old_lib, new_lib), encoding="utf-8")
    print("lib.rs mark pass session_id")
else:
    print("lib mark block already or missing")

# manager mark_defect rewrite to support historical sessions
mgr = root / "src" / "session" / "manager.rs"
ms = mgr.read_text(encoding="utf-8")

old_mark_body_start = """    pub fn mark_defect(
        &self,
        input: TestSessionDefectMarkInput,
    ) -> Result<TestSessionDefectMarkRecord, SessionError> {
        if !crate::session::is_defect_evidence_enabled() {
            return Err(SessionError::InvalidLookup(
                "defect evidence capture is disabled; enable it in settings first".to_string(),
            ));
        }
        let now_ms = now_timestamp_ms();
        let marked_at_ms = input.marked_at_ms.unwrap_or(now_ms).max(1);
        let pre_window_seconds = input
            .pre_window_seconds
            .unwrap_or_else(crate::session::defect_pre_window_seconds)
            .clamp(5, 600);
        let post_window_seconds = input
            .post_window_seconds
            .unwrap_or_else(crate::session::defect_post_window_seconds)
            .clamp(0, 300);
        let note = normalize_optional_string(input.note.clone());
        let expected = normalize_optional_string(input.expected.clone());
        let actual = normalize_optional_string(input.actual.clone());

        let (event, window_start_ms, window_end_ms) = {
            let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;
            let active = state.active.as_mut().ok_or(SessionError::NoActiveSession)?;
            let (_effective_mark, window_start_ms, window_end_ms) = clamp_defect_time_window(
                active.started_at_ms,
                active.ended_at_ms.or(Some(active.updated_at_ms)),
                marked_at_ms,
                pre_window_seconds,
                post_window_seconds,
            );
            active.updated_at_ms = active.updated_at_ms.max(marked_at_ms);
            let event = TestSessionEventRecord::new_defect_mark(
                self.next_event_id(marked_at_ms),
                active.session_id.clone(),
                marked_at_ms,
                note.clone(),
                expected.clone(),
                actual.clone(),
                window_start_ms,
                window_end_ms,
            );
            append_event_to_storage(active, &event)?;
            persist_manifest(active)?;
            let session_id = active.session_id.clone();
            push_event(&mut state.events_by_session, session_id, event.clone());
            (event, window_start_ms, window_end_ms)
        };"""

new_mark_body_start = """    pub fn mark_defect(
        &self,
        input: TestSessionDefectMarkInput,
    ) -> Result<TestSessionDefectMarkRecord, SessionError> {
        if !crate::session::is_defect_evidence_enabled() {
            return Err(SessionError::InvalidLookup(
                "defect evidence capture is disabled; enable it in settings first".to_string(),
            ));
        }
        let now_ms = now_timestamp_ms();
        let marked_at_ms = input.marked_at_ms.unwrap_or(now_ms).max(1);
        let pre_window_seconds = input
            .pre_window_seconds
            .unwrap_or_else(crate::session::defect_pre_window_seconds)
            .clamp(5, 600);
        let post_window_seconds = input
            .post_window_seconds
            .unwrap_or_else(crate::session::defect_post_window_seconds)
            .clamp(0, 300);
        let note = normalize_optional_string(input.note.clone());
        let expected = normalize_optional_string(input.expected.clone());
        let actual = normalize_optional_string(input.actual.clone());
        let requested_session_id = input
            .session_id
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let (event, window_start_ms, window_end_ms) = {
            let mut state = self.state.lock().map_err(|_| SessionError::LockPoisoned)?;

            // Prefer active session when recording; otherwise mark the reviewed/historical session.
            let use_active = state.active.as_ref().is_some_and(|active| {
                requested_session_id
                    .as_ref()
                    .map(|id| id == &active.session_id)
                    .unwrap_or(true)
            });

            if use_active {
                let active = state.active.as_mut().ok_or(SessionError::NoActiveSession)?;
                let (_effective_mark, window_start_ms, window_end_ms) = clamp_defect_time_window(
                    active.started_at_ms,
                    active.ended_at_ms.or(Some(active.updated_at_ms)),
                    marked_at_ms,
                    pre_window_seconds,
                    post_window_seconds,
                );
                active.updated_at_ms = active.updated_at_ms.max(marked_at_ms);
                let event = TestSessionEventRecord::new_defect_mark(
                    self.next_event_id(marked_at_ms),
                    active.session_id.clone(),
                    marked_at_ms,
                    note.clone(),
                    expected.clone(),
                    actual.clone(),
                    window_start_ms,
                    window_end_ms,
                );
                append_event_to_storage(active, &event)?;
                persist_manifest(active)?;
                let session_id = active.session_id.clone();
                push_event(&mut state.events_by_session, session_id, event.clone());
                (event, window_start_ms, window_end_ms)
            } else {
                let target_id = requested_session_id.clone().or_else(|| {
                    state.history.last().map(|record| record.session_id.clone())
                });
                let Some(target_id) = target_id else {
                    return Err(SessionError::NoActiveSession);
                };
                let history_index = state
                    .history
                    .iter()
                    .position(|record| record.session_id == target_id)
                    .ok_or_else(|| SessionError::SessionNotFound(target_id.clone()))?;
                let record = &mut state.history[history_index];
                let (_effective_mark, window_start_ms, window_end_ms) = clamp_defect_time_window(
                    record.started_at_ms,
                    record.ended_at_ms.or(Some(record.updated_at_ms)),
                    marked_at_ms,
                    pre_window_seconds,
                    post_window_seconds,
                );
                record.updated_at_ms = record.updated_at_ms.max(marked_at_ms);
                let event = TestSessionEventRecord::new_defect_mark(
                    self.next_event_id(marked_at_ms),
                    record.session_id.clone(),
                    marked_at_ms,
                    note.clone(),
                    expected.clone(),
                    actual.clone(),
                    window_start_ms,
                    window_end_ms,
                );
                append_event_to_storage(record, &event)?;
                persist_manifest(record)?;
                let session_id = record.session_id.clone();
                push_event(&mut state.events_by_session, session_id, event.clone());
                (event, window_start_ms, window_end_ms)
            }
        };"""

if old_mark_body_start not in ms:
    raise SystemExit("mark_defect body start not found for replace")
ms = ms.replace(old_mark_body_start, new_mark_body_start, 1)
mgr.write_text(ms, encoding="utf-8")
print("manager mark_defect historical support")

# ---------- UI: pass sessionId + better disabled state ----------
panel = root / "examples" / "desktop" / "src-react" / "features" / "evidence" / "RecordingReviewPanel.tsx"
pt = panel.read_text(encoding="utf-8")
old_ui = """      const result = await api.markTestDefect({
        note: note.trim() || undefined,
        expected: expected.trim() || undefined,
        actual: actual.trim() || undefined,
        preWindowSeconds: props.preWindowSeconds,
        postWindowSeconds: props.postWindowSeconds,
      });"""
new_ui = """      if (!sessionId) {
        props.onError('当前没有可标记的会话。请先开始录制，或在时间线中选中历史会话后再标记。');
        return;
      }
      const result = await api.markTestDefect({
        sessionId,
        note: note.trim() || undefined,
        expected: expected.trim() || undefined,
        actual: actual.trim() || undefined,
        preWindowSeconds: props.preWindowSeconds,
        postWindowSeconds: props.postWindowSeconds,
      });"""
if old_ui not in pt:
    raise SystemExit("UI markTestDefect block not found")
pt = pt.replace(old_ui, new_ui, 1)
# marker disabled when no session
pt = pt.replace(
    "const markerDisabled = busy || !props.enabled;",
    "const markerDisabled = busy || !props.enabled || !sessionId;",
    1,
)
# catch message for not active
pt = pt.replace(
    """    } catch (error) {
      props.onError(props.toUiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleRebuild(): Promise<void> {""",
    """    } catch (error) {
      const message = props.toUiErrorMessage(error);
      if (/not active/i.test(message)) {
        props.onError(
          '当前没有进行中的录制会话。请在录制过程中标记，或选中已结束的会话后重试（已支持对历史会话标记）。',
        );
      } else {
        props.onError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRebuild(): Promise<void> {""",
    1,
)
panel.write_text(pt, encoding="utf-8")
print("RecordingReviewPanel sessionId + UX")

# service.ts markTestDefect - pass through sessionId if any wrapper strips it
svc = root / "examples" / "desktop" / "src-electron" / "modules" / "reqcase-shadow-recorder" / "service.ts"
st = svc.read_text(encoding="utf-8")
# usually just forwards input - check
if "markTestDefect" in st:
    print("service has markTestDefect")
else:
    print("service no markTestDefect (may use native direct)")

print("DONE")
