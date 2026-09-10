use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceFileEntry {
    pub relative_path: String,
    pub bytes: u64,
    pub sha256: String,
}

impl EvidenceFileEntry {
    pub fn new(relative_path: String, bytes: u64, sha256: String) -> Self {
        Self {
            relative_path,
            bytes,
            sha256,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EvidenceManifestV2 {
    pub version: u32,
    pub session_id: u64,
    pub created_at_ms: u64,
    pub app_version: String,
    pub native_version: String,
    pub os: String,
    pub capture_config: serde_json::Value,
    pub files: Vec<EvidenceFileEntry>,
}

impl EvidenceManifestV2 {
    pub fn new(
        session_id: u64,
        created_at_ms: u64,
        app_version: String,
        native_version: String,
        os: String,
        capture_config: serde_json::Value,
        files: Vec<EvidenceFileEntry>,
    ) -> Self {
        Self {
            version: 2,
            session_id,
            created_at_ms,
            app_version,
            native_version,
            os,
            capture_config,
            files,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn builds_v2_manifest_with_required_fields_and_file_hashes() {
        let manifest = EvidenceManifestV2::new(
            42,
            1_710_000_000_000,
            "0.1.1".to_string(),
            "0.1.0".to_string(),
            "windows".to_string(),
            json!({ "captureMode": "target_display" }),
            vec![EvidenceFileEntry::new(
                "summary.html".to_string(),
                123,
                "abc123".to_string(),
            )],
        );

        assert_eq!(manifest.version, 2);
        assert_eq!(manifest.session_id, 42);
        assert_eq!(manifest.created_at_ms, 1_710_000_000_000);
        assert_eq!(manifest.app_version, "0.1.1");
        assert_eq!(manifest.native_version, "0.1.0");
        assert_eq!(manifest.os, "windows");
        assert_eq!(manifest.capture_config["captureMode"], "target_display");
        assert_eq!(manifest.files[0].relative_path, "summary.html");
        assert_eq!(manifest.files[0].bytes, 123);
        assert_eq!(manifest.files[0].sha256, "abc123");
    }

    #[test]
    fn serializes_v2_manifest_with_snake_case_schema() {
        let manifest = EvidenceManifestV2::new(
            7,
            1,
            "app".to_string(),
            "native".to_string(),
            "windows".to_string(),
            json!({}),
            vec![EvidenceFileEntry::new(
                "operations.json".to_string(),
                64,
                "hash".to_string(),
            )],
        );

        let value = serde_json::to_value(manifest).expect("serialize manifest");

        assert_eq!(value["version"], 2);
        assert_eq!(value["session_id"], 7);
        assert_eq!(value["files"][0]["relative_path"], "operations.json");
        assert_eq!(value["files"][0]["bytes"], 64);
        assert_eq!(value["files"][0]["sha256"], "hash");
    }
}
