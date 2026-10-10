//! The device's persisted state: the pairing (with its secret), the shared
//! folders, the local MCP servers, the allow rules and the shell-sandbox policy. One JSON file in the app
//! data dir, owner-only (0600 on Unix), written atomically.
//!
//! Only Rust writes it, and only on the local window's commands or a confirmed
//! pairing — the remote page has no command that changes it.

use std::fs;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::mcp::McpServerConfig;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub account_label: String,
    pub device_id: String,
    pub secret: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Tool names the user chose "Always allow" for. Cleared on every (re)pairing.
    #[serde(default)]
    pub allow_rules: Vec<String>,
    /// The user turned OFF "Require sandbox for shell commands": `shell_run`
    /// may run unconfined where the OS sandbox is unavailable. Stored inverted
    /// so a missing field (and `Settings::default()`) means "required".
    #[serde(default)]
    pub allow_unsandboxed_shell: bool,
    #[serde(default)]
    pub mcp_servers: Vec<McpServerConfig>,
    #[serde(default)]
    pub pairing: Option<Pairing>,
    /// Folders the file and shell tools may reach.
    #[serde(default)]
    pub roots: Vec<String>,
}

pub fn load(path: &Path) -> Settings {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let mut options = fs::OpenOptions::new();

    options.write(true).create(true).truncate(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        options.mode(0o600);
    }

    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;

    file.write_all(text.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_owner_only() {
        let path = std::env::temp_dir().join(format!(
            "neore-device-store-{}/device.json",
            std::process::id()
        ));
        let settings = Settings {
            allow_rules: vec!["fs_read".into()],
            pairing: Some(Pairing {
                account_label: "me".into(),
                device_id: "d".into(),
                secret: "s".into(),
            }),
            roots: vec!["/tmp".into()],
            ..Settings::default()
        };

        save(&path, &settings).unwrap();
        assert_eq!(load(&path), settings);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn the_shell_sandbox_is_required_unless_turned_off() {
        assert!(!Settings::default().allow_unsandboxed_shell);
        assert!(
            !serde_json::from_str::<Settings>(r#"{"roots":[]}"#)
                .unwrap()
                .allow_unsandboxed_shell
        );
    }

    #[test]
    fn a_missing_or_corrupt_file_reads_as_unpaired() {
        assert_eq!(
            load(Path::new("/nonexistent/neore/device.json")),
            Settings::default()
        );
    }
}
