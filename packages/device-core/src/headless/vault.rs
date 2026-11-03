//! Where a headless machine keeps its device secret: the OS keychain where there is one, a 0600 file only where
//! there is none. The pairing says which, before the owner approves and again once it is stored.
//!
//! The record (`host.json`) names the device and where the secret lives. It carries the secret itself only when
//! the keychain was not usable. A keychain that worked at pairing but is empty at the next start is an error,
//! never a quiet re-pairing: the secret is gone and the owner removes the device in the web app.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const SERVICE: &str = "dev.neore.host";
const PROBE_ACCOUNT: &str = "probe";
const FILE_NAME: &str = "host.json";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Storage {
    Keychain,
    File,
}

impl Storage {
    /// The word the backend and the approval page use.
    pub fn as_str(self) -> &'static str {
        match self {
            Storage::Keychain => "keychain",
            Storage::File => "file",
        }
    }

    /// The sentence a person reads in the terminal.
    pub fn describe(self) -> &'static str {
        match self {
            Storage::Keychain => "the operating system keychain",
            Storage::File => "a file only you can read (this machine has no keychain it can use)",
        }
    }
}

/// What the machine knows about its pairing besides the secret.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub backend: String,
    pub device_id: String,
    pub name: String,
    /// Present only when `storage` is `file`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub secret: String,
    pub storage: Storage,
}

/// The OS keychain, by account. A trait so the fallback is tested without one.
pub trait Keychain {
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    /// `Ok(None)` when there is no entry.
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn delete(&self, account: &str);
}

pub struct OsKeychain;

impl Keychain for OsKeychain {
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, account)
            .and_then(|entry| entry.set_password(secret))
            .map_err(|error| error.to_string())
    }

    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match keyring::Entry::new(SERVICE, account).and_then(|entry| entry.get_password()) {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn delete(&self, account: &str) {
        if let Ok(entry) = keyring::Entry::new(SERVICE, account) {
            let _ = entry.delete_credential();
        }
    }
}

/// The folder the record lives in. `NEORE_HOST_DIR` overrides it (tests, and a person who wants it elsewhere).
pub fn default_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("NEORE_HOST_DIR").filter(|dir| !dir.is_empty()) {
        return Some(PathBuf::from(dir));
    }

    let home = || {
        std::env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .map(PathBuf::from)
    };

    if cfg!(target_os = "macos") {
        home().map(|home| home.join("Library/Application Support/Neore Host"))
    } else if cfg!(windows) {
        std::env::var_os("APPDATA")
            .filter(|dir| !dir.is_empty())
            .map(|dir| PathBuf::from(dir).join("Neore Host"))
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .filter(|dir| !dir.is_empty())
            .map(|dir| PathBuf::from(dir).join("neore-host"))
            .or_else(|| home().map(|home| home.join(".config/neore-host")))
    }
}

pub struct Vault<'a> {
    dir: PathBuf,
    keychain: &'a dyn Keychain,
}

/// What `save` did: where the secret went, and a notice when that was not the first choice.
#[derive(Debug, PartialEq, Eq)]
pub struct Saved {
    pub notice: Option<String>,
    pub storage: Storage,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Loaded {
    pub record: Record,
    pub secret: String,
}

impl<'a> Vault<'a> {
    pub fn new(dir: PathBuf, keychain: &'a dyn Keychain) -> Self {
        Vault { dir, keychain }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn file(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    /// Where a secret would go right now: the keychain if it round-trips a value, else the file. Announced with the
    /// code, so the owner sees the choice before approving. The probe entry is removed.
    pub fn probe(&self) -> Storage {
        let value = "neore-host-probe";
        let works = self.keychain.set(PROBE_ACCOUNT, value).is_ok()
            && self.keychain.get(PROBE_ACCOUNT).ok().flatten().as_deref() == Some(value);

        self.keychain.delete(PROBE_ACCOUNT);

        if works {
            Storage::Keychain
        } else {
            Storage::File
        }
    }

    /// Stores the pairing. The keychain first; when it refuses, the 0600 file, with a notice saying so. When neither
    /// can hold it, an error: the secret is not kept anywhere.
    pub fn save(
        &self,
        backend: &str,
        device_id: &str,
        name: &str,
        secret: &str,
    ) -> Result<Saved, String> {
        let mut record = Record {
            backend: backend.to_owned(),
            device_id: device_id.to_owned(),
            name: name.to_owned(),
            secret: String::new(),
            storage: Storage::Keychain,
        };

        match self.keychain.set(device_id, secret) {
            Ok(()) => {
                write_private(&self.dir, &self.file(), &record)?;

                Ok(Saved {
                    notice: None,
                    storage: Storage::Keychain,
                })
            }
            Err(reason) => {
                record.storage = Storage::File;
                record.secret = secret.to_owned();
                write_private(&self.dir, &self.file(), &record).map_err(|error| {
                    format!("the keychain refused the secret ({reason}) and the file could not be written: {error}")
                })?;

                Ok(Saved {
                    notice: Some(format!(
                        "The keychain could not hold the secret ({reason}), so it is kept in {} instead.",
                        self.file().display()
                    )),
                    storage: Storage::File,
                })
            }
        }
    }

    /// The pairing and its secret. `Ok(None)` when this machine is not paired.
    pub fn load(&self) -> Result<Option<Loaded>, String> {
        let path = self.file();
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("{} could not be read: {error}", path.display())),
        };
        let record: Record = serde_json::from_str(&text)
            .map_err(|_| format!("{} is not a pairing record", path.display()))?;

        let secret = match record.storage {
            Storage::File => {
                refuse_shared_file(&path)?;

                if record.secret.is_empty() {
                    return Err(format!("{} holds no secret", path.display()));
                }

                record.secret.clone()
            }
            Storage::Keychain => match self.keychain.get(&record.device_id) {
                Ok(Some(secret)) => secret,
                Ok(None) => {
                    return Err("this machine is paired, but the keychain no longer holds its secret; remove the device in the web app and pair again".into());
                }
                Err(error) => return Err(format!("the keychain could not be read: {error}")),
            },
        };

        Ok(Some(Loaded { record, secret }))
    }

    /// Forgets the pairing on this machine (the owner removes the device in the web app).
    pub fn forget(&self) -> Result<(), String> {
        if let Some(loaded) = self.load().ok().flatten() {
            self.keychain.delete(&loaded.record.device_id);
        }

        match fs::remove_file(self.file()) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

/// A secret file that others can read is not a secret any more.
#[cfg(unix)]
fn refuse_shared_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let mode = fs::metadata(path)
        .map_err(|error| error.to_string())?
        .permissions()
        .mode();

    if mode & 0o077 != 0 {
        return Err(format!(
            "{} holds the device secret and is readable by others (mode {:o}); run chmod 600 on it, or remove the device in the web app and pair again",
            path.display(),
            mode & 0o777
        ));
    }

    Ok(())
}

#[cfg(not(unix))]
fn refuse_shared_file(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Writes `record` atomically into `dir`, owner-only. The folder is created 0700. Without Unix permissions there is
/// no way to keep a file private, so a secret is not written to one.
#[cfg(unix)]
fn write_private(dir: &Path, path: &Path, record: &Record) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};

    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|error| error.to_string())?;

    let temporary = path.with_extension("json.tmp");
    let _ = fs::remove_file(&temporary);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|error| error.to_string())?;

    let written = serde_json::to_vec_pretty(record)
        .map_err(|error| error.to_string())
        .and_then(|bytes| file.write_all(&bytes).map_err(|error| error.to_string()))
        .and_then(|()| file.sync_all().map_err(|error| error.to_string()));

    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);

        return Err(error);
    }

    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);

        error.to_string()
    })
}

#[cfg(not(unix))]
fn write_private(dir: &Path, path: &Path, record: &Record) -> Result<(), String> {
    if record.storage == Storage::File {
        return Err("this system cannot keep a file private".into());
    }

    // The keychain holds the secret; the record has none.
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;

    let mut file = fs::File::create(path).map_err(|error| error.to_string())?;

    file.write_all(&serde_json::to_vec_pretty(record).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// A keychain in memory, or one that refuses everything (a server with no Secret Service).
    #[derive(Default)]
    pub struct FakeKeychain {
        pub entries: RefCell<HashMap<String, String>>,
        pub broken: bool,
    }

    impl Keychain for FakeKeychain {
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            if self.broken {
                return Err("no secret service on the session bus".into());
            }

            self.entries
                .borrow_mut()
                .insert(account.to_owned(), secret.to_owned());

            Ok(())
        }

        fn get(&self, account: &str) -> Result<Option<String>, String> {
            if self.broken {
                return Err("no secret service on the session bus".into());
            }

            Ok(self.entries.borrow().get(account).cloned())
        }

        fn delete(&self, account: &str) {
            self.entries.borrow_mut().remove(account);
        }
    }

    pub fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "neore-host-test-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|age| age.as_nanos())
                .unwrap_or_default()
        ));

        let _ = fs::remove_dir_all(&dir);

        dir
    }

    const SECRET: &str = concat!(
        "0123456789abcdef",
        "0123456789abcdef",
        "0123456789abcdef",
        "0123456789abcdef"
    );

    #[test]
    fn probe_names_the_keychain_when_it_round_trips_and_removes_its_entry() {
        let keychain = FakeKeychain::default();
        let vault = Vault::new(temp_dir("probe"), &keychain);

        assert_eq!(vault.probe(), Storage::Keychain);
        assert!(keychain.entries.borrow().is_empty());
    }

    #[test]
    fn probe_names_the_file_when_the_keychain_is_unusable() {
        let keychain = FakeKeychain {
            broken: true,
            ..FakeKeychain::default()
        };

        assert_eq!(
            Vault::new(temp_dir("probe-broken"), &keychain).probe(),
            Storage::File
        );
    }

    #[test]
    fn a_keychain_pairing_keeps_the_secret_out_of_the_file() {
        let dir = temp_dir("keychain");
        let keychain = FakeKeychain::default();
        let vault = Vault::new(dir.clone(), &keychain);
        let saved = vault
            .save("https://neore.ai", "device-1", "build-box", SECRET)
            .unwrap();

        assert_eq!(saved.storage, Storage::Keychain);
        assert_eq!(saved.notice, None);
        assert!(!fs::read_to_string(dir.join("host.json"))
            .unwrap()
            .contains(SECRET));

        let loaded = vault.load().unwrap().unwrap();

        assert_eq!(loaded.secret, SECRET);
        assert_eq!(loaded.record.device_id, "device-1");
        assert_eq!(loaded.record.storage, Storage::Keychain);
    }

    #[cfg(unix)]
    #[test]
    fn a_broken_keychain_falls_back_to_a_0600_file_and_says_so() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("fallback");
        let keychain = FakeKeychain {
            broken: true,
            ..FakeKeychain::default()
        };
        let vault = Vault::new(dir.clone(), &keychain);
        let saved = vault
            .save("https://neore.ai", "device-1", "build-box", SECRET)
            .unwrap();

        assert_eq!(saved.storage, Storage::File);
        assert!(saved.notice.unwrap().contains("keychain could not hold"));

        let file = dir.join("host.json");

        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );

        let loaded = vault.load().unwrap().unwrap();

        assert_eq!(loaded.secret, SECRET);
        assert_eq!(loaded.record.storage, Storage::File);
        // No half-written temporary is left beside it.
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_secret_file_others_can_read_is_refused() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("shared");
        let keychain = FakeKeychain {
            broken: true,
            ..FakeKeychain::default()
        };
        let vault = Vault::new(dir.clone(), &keychain);

        vault
            .save("https://neore.ai", "device-1", "build-box", SECRET)
            .unwrap();
        fs::set_permissions(dir.join("host.json"), fs::Permissions::from_mode(0o644)).unwrap();

        let error = vault.load().unwrap_err();

        assert!(error.contains("readable by others"), "{error}");
        assert!(!error.contains(SECRET));
    }

    #[test]
    fn a_keychain_that_lost_the_secret_is_an_error_not_a_new_pairing() {
        let dir = temp_dir("lost");
        let keychain = FakeKeychain::default();
        let vault = Vault::new(dir, &keychain);

        vault
            .save("https://neore.ai", "device-1", "build-box", SECRET)
            .unwrap();
        keychain.entries.borrow_mut().clear();

        assert!(vault
            .load()
            .unwrap_err()
            .contains("no longer holds its secret"));
    }

    #[test]
    fn an_unpaired_machine_loads_nothing_and_forget_clears_a_pairing() {
        let dir = temp_dir("forget");
        let keychain = FakeKeychain::default();
        let vault = Vault::new(dir, &keychain);

        assert_eq!(vault.load().unwrap(), None);

        vault
            .save("https://neore.ai", "device-1", "build-box", SECRET)
            .unwrap();
        vault.forget().unwrap();

        assert_eq!(vault.load().unwrap(), None);
        assert!(keychain.entries.borrow().is_empty());
    }
}
