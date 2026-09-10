# -*- coding: utf-8 -*-
from pathlib import Path

root = Path(__file__).resolve().parents[1]

# manager
mp = root / "src" / "session" / "manager.rs"
ms = mp.read_text(encoding="utf-8")
old = """    pub fn load_semantic_profile_file(&self, path: String) -> Result<SemanticProfile, SessionError> {
        let profile = load_semantic_profile_from_path(Path::new(&path)).ok_or_else(|| {
            SessionError::InvalidLookup(format!(
                \"failed to load semantic profile from path: {path}\"
            ))
        })?;
        self.set_semantic_profile(Some(profile.clone()))?;
        Ok(profile)
    }"""
new = """    pub fn load_semantic_profile_file(&self, path: String) -> Result<SemanticProfile, SessionError> {
        let profile = load_semantic_profile_from_path(Path::new(&path)).ok_or_else(|| {
            SessionError::InvalidLookup(format!(
                \"failed to load semantic profile from path: {path}. Supported: semantic-profile JSON, qttimer profile snapshot, or elements_selected array export.\"
            ))
        })?;
        self.set_semantic_profile(Some(profile.clone()))?;
        Ok(profile)
    }

    pub fn load_semantic_profile_json(&self, content: String) -> Result<SemanticProfile, SessionError> {
        use crate::session::semantic_profile::parse_semantic_profile_json;
        let profile = parse_semantic_profile_json(&content).ok_or_else(|| {
            SessionError::InvalidLookup(
                \"failed to parse semantic profile JSON. Supported: semantic-profile object, qttimer snapshot, or elements_selected array export.\".to_string(),
            )
        })?;
        self.set_semantic_profile(Some(profile.clone()))?;
        Ok(profile)
    }"""
if "load_semantic_profile_json" not in ms:
    if old not in ms:
        idx = ms.find("pub fn load_semantic_profile_file")
        raise SystemExit(f"manager load method not exact match at {idx}: {ms[idx:idx+400]!r}")
    ms = ms.replace(old, new)
    mp.write_text(ms, encoding="utf-8")
    print("manager patched")
else:
    print("manager already")

# lib.rs
lp = root / "src" / "lib.rs"
ls = lp.read_text(encoding="utf-8")
old_napi = """#[napi]
pub fn clear_semantic_profile() -> Result<()> {
    TEST_SESSION_MANAGER
        .set_semantic_profile(None)
        .map_err(map_session_error)
}"""
new_napi = """#[napi]
pub fn clear_semantic_profile() -> Result<()> {
    TEST_SESSION_MANAGER
        .set_semantic_profile(None)
        .map_err(map_session_error)
}

/// Activate a Semantic Profile from JSON content (profile object or qttimer elements_selected array).
#[napi]
pub fn set_semantic_profile_json(content: String) -> Result<String> {
    let profile = TEST_SESSION_MANAGER
        .load_semantic_profile_json(content)
        .map_err(map_session_error)?;
    serde_json::to_string(&profile).map_err(|err| {
        napi::Error::from_reason(format!(\"failed to serialize semantic profile: {err}\"))
    })
}"""
if "set_semantic_profile_json" not in ls:
    if old_napi not in ls:
        idx = ls.find("pub fn clear_semantic_profile")
        raise SystemExit(f"lib clear not found: {ls[idx:idx+250]!r}")
    ls = ls.replace(old_napi, new_napi)
    lp.write_text(ls, encoding="utf-8")
    print("lib patched")
else:
    print("lib already")

# export parse_qttimer if needed in mod - parse is pub already
print("done")
