//! The device's persisted state: the pairing, the servers reached over SSH, the shared
//! folders, the local MCP servers, the allow rules and the shell-sandbox policy. One JSON
//! file in the app data dir, owner-only (0600 on Unix), written atomically.
//!
//! Every secret lives in the OS keychain (service `dev.neore.device`, account = device
//! id): the pairing's and one per server, which only this desktop ever holds. The file
//! keeps one only when the keychain refuses.
//!
//! Only Rust writes it, and only on the local window's commands or a confirmed
//! pairing — the remote page has no command that changes it.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::acp::{AcpAgent, AcpConsent, EnvVars};
use super::mcp::McpServerConfig;

const KEYCHAIN_SERVICE: &str = "dev.neore.device";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub account_label: String,
    pub device_id: String,
    /// Empty once the keychain holds it; present in the file only as a fallback.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub secret: String,
}

/// A server this desktop reaches over SSH and speaks for. It is a device of its own on the backend, so it has
/// its own secret; the server itself never sees it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub address: String,
    /// "Allow network for shell commands" turned ON for this server.
    #[serde(default)]
    pub allow_shell_network: bool,
    /// "Require sandbox for shell commands" turned OFF for this server, stored inverted like the desktop's.
    #[serde(default)]
    pub allow_unsandboxed_shell: bool,
    pub device_id: String,
    #[serde(default)]
    pub forward_agent: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    pub name: String,
    pub port: u16,
    /// Absolute folders ON THE SERVER; the server checks them against its own filesystem.
    #[serde(default)]
    pub roots: Vec<String>,
    /// Empty once the keychain holds it; present in the file only as a fallback.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub secret: String,
    pub user: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Coding agents (ACP) the user registered in the local window.
    #[serde(default)]
    pub acp_agents: Vec<AcpAgent>,
    /// The (agent, folder) pairs the user approved in the local window. An agent starts in nothing else.
    #[serde(default)]
    pub acp_consents: Vec<AcpConsent>,
    /// Environment variables every agent gets, on top of the built environment. Values are secrets.
    #[serde(default)]
    pub acp_env: EnvVars,
    /// Tool names the user chose "Always allow" for. Cleared on every (re)pairing.
    #[serde(default)]
    pub allow_rules: Vec<String>,
    /// The user turned OFF "Require sandbox for shell commands": `shell_run`
    /// may run unconfined where the OS sandbox is unavailable. Stored inverted
    /// so a missing field (and `Settings::default()`) means "required".
    #[serde(default)]
    pub allow_unsandboxed_shell: bool,
    /// The user turned ON "Allow network for shell commands". Absent means
    /// restricted, where the OS sandbox can enforce it.
    #[serde(default)]
    pub allow_shell_network: bool,
    /// The servers this desktop speaks for (`transport: ssh` on the backend).
    #[serde(default)]
    pub hosts: Vec<Host>,
    #[serde(default)]
    pub mcp_servers: Vec<McpServerConfig>,
    #[serde(default)]
    pub pairing: Option<Pairing>,
    /// Folders the file and shell tools may reach.
    #[serde(default)]
    pub roots: Vec<String>,
}

/// Reads the settings file. A missing file is the first run and gives the defaults. A file that cannot be read or
/// parsed is moved aside (not overwritten) before the defaults are used: the next save would otherwise replace the
/// only copy of the pairing, the folders and the rules.
fn read_file(path: &Path) -> Option<Settings> {
    match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(settings) => Some(settings),
            // Line and column only: serde's message can quote a stored value, and the file holds secrets.
            Err(error) => {
                move_aside(
                    path,
                    &format!(
                        "parse error at line {} column {}",
                        error.line(),
                        error.column()
                    ),
                );
                None
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            move_aside(path, &error.to_string());
            None
        }
    }
}

fn move_aside(path: &Path, reason: &str) {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|age| age.as_nanos())
        .unwrap_or_default();
    let aside = path.with_extension(format!("json.corrupt-{stamp}"));

    eprintln!(
        "[device-core] device.json could not be read ({reason}); moved to {}",
        aside.display()
    );
    let _ = fs::rename(path, aside);
}

fn keychain_set(device_id: &str, secret: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, device_id)
        .and_then(|entry| entry.set_password(secret))
        .map_err(|error| error.to_string())
}

fn keychain_get(device_id: &str) -> Result<String, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, device_id)
        .and_then(|entry| entry.get_password())
        .map_err(|error| error.to_string())
}

fn keychain_delete(device_id: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, device_id) {
        let _ = entry.delete_credential();
    }
}

/// Every secret a settings value holds, by the device id it belongs to: the pairing's and each server's.
fn secrets_mut(settings: &mut Settings) -> Vec<(&str, &mut String)> {
    let paired = settings
        .pairing
        .iter_mut()
        .map(|pairing| (pairing.device_id.as_str(), &mut pairing.secret));
    let hosts = settings
        .hosts
        .iter_mut()
        .map(|host| (host.device_id.as_str(), &mut host.secret));

    paired.chain(hosts).collect()
}

/// The device ids whose secrets a settings value keeps in the keychain.
fn device_ids(settings: &Settings) -> Vec<&str> {
    settings
        .pairing
        .iter()
        .map(|pairing| pairing.device_id.as_str())
        .chain(settings.hosts.iter().map(|host| host.device_id.as_str()))
        .collect()
}

/// Reads the settings, moving a secret found in the file into the keychain. A
/// keychain that cannot be read keeps the pairing with an empty secret (calls
/// fail closed) and retries on the next load, rather than unpairing.
pub fn load(path: &Path) -> Settings {
    let mut settings = read_file(path).unwrap_or_default();
    let mut inline = false;

    for (device_id, secret) in secrets_mut(&mut settings) {
        if secret.is_empty() {
            match keychain_get(device_id) {
                Ok(stored) => *secret = stored,
                Err(error) => eprintln!("[device-core] pairing secret unavailable: {error}"),
            }
        } else {
            inline = true;
        }
    }

    if inline {
        // A file from before the keychain: `save` moves the secrets and strips them.
        let _ = save(path, &settings);
    }

    settings
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    let previous = read_file(path).unwrap_or_default();

    save_over(path, &previous, settings)
}

/// Writes the settings over the ones they replace. The engine passes the settings it holds in memory, so a save
/// does not reread the file.
pub fn save_over(path: &Path, previous: &Settings, settings: &Settings) -> Result<(), String> {
    let mut stored = settings.clone();
    let before = device_ids(previous);

    // Re-pairing the same device overwrites its keychain entry; keep the old one to restore on failure.
    let overwritten: Vec<(String, String)> = stored
        .pairing
        .iter()
        .map(|pairing| pairing.device_id.as_str())
        .chain(stored.hosts.iter().map(|host| host.device_id.as_str()))
        .filter(|device_id| before.contains(device_id))
        .filter_map(|device_id| {
            keychain_get(device_id)
                .ok()
                .map(|secret| (device_id.to_owned(), secret))
        })
        .collect();

    for (device_id, secret) in secrets_mut(&mut stored) {
        if !secret.is_empty() {
            match keychain_set(device_id, secret) {
                Ok(()) => secret.clear(),
                Err(error) => eprintln!(
                    "[device-core] keychain unavailable, secret kept in device.json: {error}"
                ),
            }
        }
    }

    let saved = serde_json::to_string_pretty(&stored)
        .map_err(|error| error.to_string())
        .and_then(|text| write_owner_only(path, &text));

    if let Err(error) = saved {
        for (device_id, secret) in overwritten {
            let _ = keychain_set(&device_id, &secret);
        }

        return Err(error);
    }

    // A replaced or removed pairing, or a removed server, takes its keychain entry with it, once the new settings
    // are on disk.
    let after = device_ids(settings);

    for device_id in before.into_iter().filter(|id| !after.contains(id)) {
        keychain_delete(device_id);
    }

    Ok(())
}

/// The envelope nonces seen so far, as `nonce → expiresAt`. Unreadable reads as none.
pub fn load_nonces(path: &Path) -> HashMap<String, u64> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_nonces(path: &Path, nonces: &HashMap<String, u64>) -> Result<(), String> {
    let text = serde_json::to_string(nonces).map_err(|error| error.to_string())?;

    write_owner_only(path, &text)
}

fn write_owner_only(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

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

    // The mode above applies only when the file is created: a leftover temporary file keeps its own.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }

    file.write_all(text.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

/// An in-process keychain for tests, so they never touch the real one. A device id
/// that starts with `unavailable` is refused on write, like a locked keychain. Public so the integration tests
/// that drive a whole `DeviceState` can use it, behind `test-support`, which no shipped build enables.
#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub mod test_keychain {
    use std::collections::BTreeMap;
    use std::sync::{Mutex, Once};

    use keyring::credential::{Credential, CredentialApi, CredentialBuilderApi};

    use super::KEYCHAIN_SERVICE;

    static SECRETS: Mutex<BTreeMap<(String, String), Vec<u8>>> = Mutex::new(BTreeMap::new());
    static INSTALL: Once = Once::new();

    pub fn install() {
        INSTALL.call_once(|| keyring::set_default_credential_builder(Box::new(Builder)));
    }

    pub fn holds(device_id: &str) -> bool {
        SECRETS
            .lock()
            .unwrap()
            .contains_key(&(KEYCHAIN_SERVICE.to_owned(), device_id.to_owned()))
    }

    struct Builder;

    impl CredentialBuilderApi for Builder {
        fn build(
            &self,
            _target: Option<&str>,
            service: &str,
            user: &str,
        ) -> keyring::Result<Box<Credential>> {
            Ok(Box::new(Item {
                key: (service.to_owned(), user.to_owned()),
            }))
        }

        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }

    struct Item {
        key: (String, String),
    }

    impl CredentialApi for Item {
        fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
            if self.key.1.starts_with("unavailable") {
                return Err(keyring::Error::NoStorageAccess("locked".into()));
            }

            SECRETS
                .lock()
                .unwrap()
                .insert(self.key.clone(), secret.to_vec());
            Ok(())
        }

        fn get_secret(&self) -> keyring::Result<Vec<u8>> {
            SECRETS
                .lock()
                .unwrap()
                .get(&self.key)
                .cloned()
                .ok_or(keyring::Error::NoEntry)
        }

        fn delete_credential(&self) -> keyring::Result<()> {
            SECRETS
                .lock()
                .unwrap()
                .remove(&self.key)
                .map(|_| ())
                .ok_or(keyring::Error::NoEntry)
        }

        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_keychain::{self, holds};
    use super::*;

    fn pairing(device_id: &str, secret: &str) -> Settings {
        Settings {
            pairing: Some(Pairing {
                account_label: "me".into(),
                device_id: device_id.into(),
                secret: secret.into(),
            }),
            ..Settings::default()
        }
    }

    fn temp_file(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("neore-device-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir.join("device.json")
    }

    #[test]
    fn the_secret_lives_in_the_keychain_not_the_file() {
        test_keychain::install();
        let path = temp_file("keychain");

        save(&path, &pairing("kc-1", "secret-kc")).unwrap();

        assert!(holds("kc-1"));
        assert!(!fs::read_to_string(&path).unwrap().contains("secret-kc"));
        assert_eq!(load(&path), pairing("kc-1", "secret-kc"));
    }

    #[test]
    fn migrates_an_inline_secret_into_the_keychain() {
        test_keychain::install();
        let path = temp_file("migrate");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"pairing":{"accountLabel":"me","deviceId":"mig-1","secret":"inline-secret"},"roots":[]}"#,
        )
        .unwrap();

        assert_eq!(load(&path), pairing("mig-1", "inline-secret"));
        assert!(holds("mig-1"));
        assert!(!fs::read_to_string(&path).unwrap().contains("inline-secret"));
    }

    #[test]
    fn keeps_the_secret_in_the_file_when_the_keychain_refuses() {
        test_keychain::install();
        let path = temp_file("fallback");

        save(&path, &pairing("unavailable-1", "fallback-secret")).unwrap();

        assert!(!holds("unavailable-1"));
        assert_eq!(load(&path), pairing("unavailable-1", "fallback-secret"));
    }

    #[test]
    fn a_replaced_pairing_drops_its_keychain_entry() {
        test_keychain::install();
        let path = temp_file("replace");

        save(&path, &pairing("old-1", "old-secret")).unwrap();
        save(&path, &pairing("new-1", "new-secret")).unwrap();

        assert!(!holds("old-1"));
        assert!(holds("new-1"));
    }

    #[test]
    fn a_failed_save_keeps_the_previous_secret() {
        test_keychain::install();
        let path = temp_file("rollback");

        save(&path, &pairing("rb-1", "old-secret")).unwrap();
        fs::create_dir(path.with_extension("json.tmp")).unwrap();

        assert!(save(&path, &pairing("rb-1", "new-secret")).is_err());
        assert_eq!(keychain_get("rb-1").unwrap(), "old-secret");
        assert_eq!(load(&path), pairing("rb-1", "old-secret"));
    }

    fn host(device_id: &str, secret: &str) -> Host {
        Host {
            address: "build.example.com".into(),
            allow_shell_network: false,
            allow_unsandboxed_shell: false,
            device_id: device_id.into(),
            forward_agent: false,
            identity_file: None,
            name: "build-box".into(),
            port: 22,
            roots: vec!["/srv/app".into()],
            secret: secret.into(),
            user: "deploy".into(),
        }
    }

    fn with_hosts(device_id: &str, secret: &str, hosts: Vec<Host>) -> Settings {
        Settings {
            hosts,
            ..pairing(device_id, secret)
        }
    }

    #[test]
    fn each_server_keeps_its_own_secret_in_the_keychain() {
        test_keychain::install();
        let path = temp_file("hosts");
        let settings = with_hosts(
            "hk-desktop",
            "desktop-secret",
            vec![host("hk-a", "secret-a"), host("hk-b", "secret-b")],
        );

        save(&path, &settings).unwrap();

        let text = fs::read_to_string(&path).unwrap();

        assert!(holds("hk-desktop") && holds("hk-a") && holds("hk-b"));
        assert!(!text.contains("secret-a") && !text.contains("secret-b"));
        assert_eq!(keychain_get("hk-a").unwrap(), "secret-a");
        assert_eq!(keychain_get("hk-b").unwrap(), "secret-b");
        assert_eq!(load(&path), settings);
    }

    #[test]
    fn a_removed_server_drops_its_keychain_entry_and_the_rest_stay() {
        test_keychain::install();
        let path = temp_file("host-removed");

        save(
            &path,
            &with_hosts(
                "hr-desktop",
                "desktop-secret",
                vec![host("hr-a", "secret-a"), host("hr-b", "secret-b")],
            ),
        )
        .unwrap();
        // The in-memory settings come back without secrets; the keychain still has them.
        let loaded = load(&path);
        let without_a = Settings {
            hosts: loaded
                .hosts
                .iter()
                .filter(|h| h.device_id != "hr-a")
                .cloned()
                .collect(),
            ..loaded.clone()
        };

        save_over(&path, &loaded, &without_a).unwrap();

        assert!(!holds("hr-a"));
        assert!(holds("hr-b") && holds("hr-desktop"));
        assert_eq!(load(&path), without_a);
    }

    #[test]
    fn dropping_the_pairing_drops_the_servers_it_held() {
        test_keychain::install();
        let path = temp_file("host-unpair");
        let paired = with_hosts(
            "hu-desktop",
            "desktop-secret",
            vec![host("hu-a", "secret-a")],
        );

        save(&path, &paired).unwrap();
        save_over(&path, &paired, &Settings::default()).unwrap();

        assert!(!holds("hu-desktop") && !holds("hu-a"));
    }

    #[test]
    fn a_failed_save_keeps_a_servers_previous_secret() {
        test_keychain::install();
        let path = temp_file("host-rollback");

        save(
            &path,
            &with_hosts("hb-desktop", "d", vec![host("hb-a", "old-secret")]),
        )
        .unwrap();
        fs::create_dir(path.with_extension("json.tmp")).unwrap();

        assert!(save(
            &path,
            &with_hosts("hb-desktop", "d", vec![host("hb-a", "new-secret")])
        )
        .is_err());
        assert_eq!(keychain_get("hb-a").unwrap(), "old-secret");
    }

    #[test]
    fn a_servers_secret_stays_in_the_file_when_the_keychain_refuses() {
        test_keychain::install();
        let path = temp_file("host-fallback");
        let settings = with_hosts(
            "hf-desktop",
            "d",
            vec![host("unavailable-host", "fallback-secret")],
        );

        save(&path, &settings).unwrap();

        assert!(!holds("unavailable-host"));
        assert_eq!(load(&path), settings);
    }

    #[test]
    fn round_trips_owner_only() {
        test_keychain::install();
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

    #[test]
    fn a_damaged_file_is_moved_aside_before_the_defaults_are_used() {
        let path = temp_file("damaged");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ not json").unwrap();

        assert_eq!(load(&path), Settings::default());
        assert!(!path.exists());

        let aside = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("device.json.corrupt-"))
            .count();
        assert_eq!(aside, 1);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
