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
    /// The approving account as the backend displayed it (a masked address), so `run` can show whose machine this is.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub account: String,
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
    /// `Ok` when the entry is gone, including when there was none.
    fn delete(&self, account: &str) -> Result<(), String>;
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

    fn delete(&self, account: &str) -> Result<(), String> {
        match keyring::Entry::new(SERVICE, account).and_then(|entry| entry.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
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
        xdg_dir(std::env::var_os("XDG_CONFIG_HOME"), home())
    }
}

/// `$XDG_CONFIG_HOME/neore-host`; the spec says to ignore a relative value, which would put the secret file in
/// whatever directory the command happened to start in.
#[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
fn xdg_dir(config_home: Option<std::ffi::OsString>, home: Option<PathBuf>) -> Option<PathBuf> {
    config_home
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join("neore-host"))
        .or_else(|| home.map(|home| home.join(".config/neore-host")))
}

/// The keychain account of a pairing: the device id alone is the backend's, so the backend is part of it, and two
/// pairings against different backends cannot overwrite each other's secret.
fn account_of(backend: &str, device_id: &str) -> String {
    format!("{backend}|{device_id}")
}

pub struct Vault<'a> {
    dir: PathBuf,
    keychain: &'a dyn Keychain,
}

/// What a pairing is saved as.
pub struct NewPairing<'a> {
    pub account: &'a str,
    pub backend: &'a str,
    pub device_id: &'a str,
    pub name: &'a str,
    pub secret: &'a str,
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

        let _ = self.keychain.delete(PROBE_ACCOUNT);

        if works {
            Storage::Keychain
        } else {
            Storage::File
        }
    }

    /// Stores the pairing where `storage` says: the place [`probe`](Self::probe) announced before the owner approved.
    /// It never switches to the other one, because the owner approved THAT choice. When it cannot hold the secret
    /// there, an error: the secret is not kept anywhere, and nothing of it is left behind.
    pub fn save(&self, pairing: &NewPairing<'_>, storage: Storage) -> Result<(), String> {
        let mut record = Record {
            account: pairing.account.to_owned(),
            backend: pairing.backend.to_owned(),
            device_id: pairing.device_id.to_owned(),
            name: pairing.name.to_owned(),
            secret: String::new(),
            storage,
        };

        match storage {
            Storage::Keychain => {
                let account = account_of(pairing.backend, pairing.device_id);

                self.keychain
                    .set(&account, pairing.secret)
                    .map_err(|reason| format!("the keychain refused the secret ({reason})"))?;

                write_private(&self.dir, &self.file(), &record).inspect_err(|_| {
                    let _ = self.keychain.delete(&account);
                })
            }
            Storage::File => {
                record.secret = pairing.secret.to_owned();

                write_private(&self.dir, &self.file(), &record)
                    .map_err(|error| format!("the secret file could not be written: {error}"))
            }
        }
    }

    /// The pairing and its secret. `Ok(None)` when this machine is not paired.
    pub fn load(&self) -> Result<Option<Loaded>, String> {
        let path = self.file();

        refuse_untrusted_dir(&self.dir)?;
        refuse_untrusted_record(&path)?;

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
            Storage::Keychain => match self
                .keychain
                .get(&account_of(&record.backend, &record.device_id))
            {
                Ok(Some(secret)) => secret,
                Ok(None) => {
                    return Err("this machine is paired, but the keychain no longer holds its secret; remove the device in the web app and pair again".into());
                }
                Err(error) => return Err(format!("the keychain could not be read: {error}")),
            },
        };

        Ok(Some(Loaded { record, secret }))
    }

    /// The record alone, without the secret: what `unpair` needs to name and remove a pairing even when the keychain
    /// cannot be read. `Ok(None)` when this machine is not paired.
    pub fn record(&self) -> Result<Option<Record>, String> {
        let path = self.file();

        refuse_untrusted_dir(&self.dir)?;
        refuse_untrusted_record(&path)?;

        match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).map(Some).map_err(|_| {
                format!(
                    "{} is not a pairing record; remove it by hand",
                    path.display()
                )
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("{} could not be read: {error}", path.display())),
        }
    }

    /// Forgets the pairing on this machine (the owner removes the device in the web app). The keychain entry goes
    /// first, and the record only once it is gone: a keychain that cannot be reached (locked) is an error that keeps
    /// the record, so `unpair` can be run again, instead of leaving a secret nothing on disk points to.
    pub fn forget(&self) -> Result<(), String> {
        if let Some(record) = self.record()? {
            if record.storage == Storage::Keychain {
                self.keychain
                    .delete(&account_of(&record.backend, &record.device_id))
                    .map_err(|reason| {
                        format!("the keychain would not give up the secret ({reason}); unlock it and run unpair again")
                    })?;
            }
        }

        match fs::remove_file(self.file()) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

/// The folder holds the record that says which secret to trust, so another user able to write in it could swap that
/// record. A folder that exists must be a real directory of this user that no one else can enter. (A missing one
/// is made 0700 when the record is written.)
#[cfg(unix)]
fn refuse_untrusted_dir(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let metadata = match fs::symlink_metadata(dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("{} could not be read: {error}", dir.display())),
    };

    // SAFETY: `geteuid` takes no arguments and cannot fail.
    let me = unsafe { libc::geteuid() };

    if !metadata.is_dir() || metadata.uid() != me {
        return Err(format!(
            "{} must be a folder of yours (not a link, not another user's)",
            dir.display()
        ));
    }

    let mode = metadata.permissions().mode();

    if mode & 0o077 != 0 {
        return Err(format!(
            "{} holds the pairing and others can enter it (mode {:o}); run chmod 700 on it",
            dir.display(),
            mode & 0o777
        ));
    }

    Ok(())
}

#[cfg(not(unix))]
fn refuse_untrusted_dir(_dir: &Path) -> Result<(), String> {
    Ok(())
}

/// The record is a file of this user, not a link to somewhere else.
#[cfg(unix)]
fn refuse_untrusted_record(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;

    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            // SAFETY: `geteuid` takes no arguments and cannot fail.
            let me = unsafe { libc::geteuid() };

            if !metadata.is_file() || metadata.uid() != me {
                return Err(format!(
                    "{} must be a plain file of yours (not a link, not another user's)",
                    path.display()
                ));
            }

            Ok(())
        }
        Err(_) => Ok(()),
    }
}

#[cfg(not(unix))]
fn refuse_untrusted_record(_path: &Path) -> Result<(), String> {
    Ok(())
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
fn write_private(dir: &Path, path: &Path, record: &Record) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;

        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|error| error.to_string())?;

        // `create` only sets the mode of a folder it makes: one that was already there keeps what it had.
        refuse_untrusted_dir(dir)?;
    }

    #[cfg(not(unix))]
    {
        if record.storage == Storage::File {
            return Err("this system cannot keep a file private".into());
        }

        // The keychain holds the secret; the record has none.
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }

    let bytes = serde_json::to_vec_pretty(record).map_err(|error| error.to_string())?;

    replace_file(path, &bytes)
}

/// A temporary file beside `path`, written and synced, then renamed over it: an interrupted write leaves the old
/// record whole (and no half-written one), on every platform.
fn replace_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let _ = fs::remove_file(&temporary);
    let mut options = fs::OpenOptions::new();

    options.write(true).create_new(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        options.mode(0o600);
    }

    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    let written = file
        .write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| error.to_string());

    drop(file);

    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);

        return Err(error);
    }

    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);

        error.to_string()
    })
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
        /// Deleting fails (a locked secret service) while reading and writing work.
        pub stuck_delete: bool,
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

        fn delete(&self, account: &str) -> Result<(), String> {
            if self.stuck_delete {
                return Err("the secret service is locked".into());
            }

            self.entries.borrow_mut().remove(account);

            Ok(())
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

    fn pairing<'a>(device_id: &'a str) -> NewPairing<'a> {
        NewPairing {
            account: "o***@example.com",
            backend: "https://neore.ai",
            device_id,
            name: "build-box",
            secret: SECRET,
        }
    }

    #[test]
    fn a_keychain_pairing_keeps_the_secret_out_of_the_file() {
        let dir = temp_dir("keychain");
        let keychain = FakeKeychain::default();
        let vault = Vault::new(dir.clone(), &keychain);

        vault.save(&pairing("device-1"), Storage::Keychain).unwrap();

        assert!(!fs::read_to_string(dir.join("host.json"))
            .unwrap()
            .contains(SECRET));

        let loaded = vault.load().unwrap().unwrap();

        assert_eq!(loaded.secret, SECRET);
        assert_eq!(loaded.record.device_id, "device-1");
        assert_eq!(loaded.record.account, "o***@example.com");
        assert_eq!(loaded.record.storage, Storage::Keychain);
    }

    #[test]
    fn the_keychain_entry_is_per_backend_so_equal_device_ids_do_not_collide() {
        let keychain = FakeKeychain::default();
        let other = "0000000000000000000000000000000000000000000000000000000000000000";
        let first = Vault::new(temp_dir("collide-a"), &keychain);
        let second = Vault::new(temp_dir("collide-b"), &keychain);

        first.save(&pairing("same-id"), Storage::Keychain).unwrap();
        second
            .save(
                &NewPairing {
                    backend: "https://staging.neore.ai",
                    secret: other,
                    ..pairing("same-id")
                },
                Storage::Keychain,
            )
            .unwrap();

        assert_eq!(first.load().unwrap().unwrap().secret, SECRET);
        assert_eq!(second.load().unwrap().unwrap().secret, other);
    }

    #[test]
    fn a_keychain_that_refuses_after_the_announcement_fails_instead_of_switching_to_a_file() {
        let dir = temp_dir("no-switch");
        let keychain = FakeKeychain {
            broken: true,
            ..FakeKeychain::default()
        };
        let vault = Vault::new(dir.clone(), &keychain);
        let error = vault
            .save(&pairing("device-1"), Storage::Keychain)
            .unwrap_err();

        assert!(error.contains("keychain refused"), "{error}");
        assert!(!dir.join("host.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_record_that_cannot_be_written_leaves_no_keychain_entry() {
        let blocker = temp_dir("record-fail");

        fs::write(&blocker, "x").unwrap();

        let keychain = FakeKeychain::default();
        let vault = Vault::new(blocker.join("inside"), &keychain);

        assert!(vault.save(&pairing("device-1"), Storage::Keychain).is_err());
        assert!(keychain.entries.borrow().is_empty());
    }

    // Paths like `/etc/xdg` are only absolute on Unix.
    #[cfg(unix)]
    #[test]
    fn a_relative_config_home_is_ignored() {
        let home = Some(PathBuf::from("/home/me"));

        assert_eq!(
            xdg_dir(Some("relative/dir".into()), home.clone()),
            Some(PathBuf::from("/home/me/.config/neore-host"))
        );
        assert_eq!(
            xdg_dir(Some("/etc/xdg".into()), home.clone()),
            Some(PathBuf::from("/etc/xdg/neore-host"))
        );
        assert_eq!(
            xdg_dir(Some("".into()), home),
            Some(PathBuf::from("/home/me/.config/neore-host"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_others_can_enter_or_a_linked_record_is_refused() {
        use std::os::unix::fs::PermissionsExt;

        let keychain = FakeKeychain::default();
        let dir = temp_dir("open-folder");

        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();

        let vault = Vault::new(dir.clone(), &keychain);
        let error = vault
            .save(&pairing("device-1"), Storage::Keychain)
            .unwrap_err();

        assert!(error.contains("others can enter"), "{error}");
        assert!(keychain.entries.borrow().is_empty());
        assert!(vault.load().unwrap_err().contains("others can enter"));

        // Owner-only, it works; and a link standing in for the record is refused.
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        vault.save(&pairing("device-1"), Storage::Keychain).unwrap();
        assert!(vault.load().unwrap().is_some());

        let elsewhere = dir.join("other.json");

        fs::rename(dir.join("host.json"), &elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, dir.join("host.json")).unwrap();

        assert!(vault.load().unwrap_err().contains("plain file"));

        // A link in place of the folder is refused too.
        let link = temp_dir("folder-link");

        std::os::unix::fs::symlink(&dir, &link).unwrap();

        assert!(Vault::new(link, &keychain)
            .load()
            .unwrap_err()
            .contains("must be a folder of yours"));
    }

    #[cfg(unix)]
    #[test]
    fn a_file_pairing_is_a_0600_file_in_a_0700_folder() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir("fallback");
        let keychain = FakeKeychain {
            broken: true,
            ..FakeKeychain::default()
        };
        let vault = Vault::new(dir.clone(), &keychain);

        vault.save(&pairing("device-1"), Storage::File).unwrap();

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

        vault.save(&pairing("device-1"), Storage::File).unwrap();
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

        vault.save(&pairing("device-1"), Storage::Keychain).unwrap();
        keychain.entries.borrow_mut().clear();

        assert!(vault
            .load()
            .unwrap_err()
            .contains("no longer holds its secret"));
    }

    #[test]
    fn forget_keeps_the_record_when_the_keychain_will_not_let_go() {
        let keychain = FakeKeychain {
            stuck_delete: true,
            ..FakeKeychain::default()
        };
        let dir = temp_dir("stuck");
        let vault = Vault::new(dir.clone(), &keychain);

        vault.save(&pairing("device-1"), Storage::Keychain).unwrap();

        let error = vault.forget().unwrap_err();

        assert!(error.contains("unlock it and run unpair again"), "{error}");
        // The record that says where the secret is stays, and so does the secret.
        assert!(dir.join("host.json").exists());
        assert_eq!(keychain.entries.borrow().len(), 1);
    }

    #[test]
    fn forget_removes_the_keychain_secret_even_when_it_cannot_be_read() {
        let keychain = FakeKeychain::default();
        let vault = Vault::new(temp_dir("unreadable"), &keychain);

        vault.save(&pairing("device-1"), Storage::Keychain).unwrap();

        // `load` needs the secret; `forget` must not.
        let broken = FakeKeychain {
            broken: true,
            entries: keychain.entries.clone(),
            ..FakeKeychain::default()
        };

        assert!(Vault::new(vault.dir().to_owned(), &broken).load().is_err());
        assert!(vault.forget().is_ok());
        assert!(keychain.entries.borrow().is_empty());
        assert_eq!(vault.load().unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_write_that_cannot_start_leaves_the_existing_record_whole() {
        use std::os::unix::fs::PermissionsExt;

        let keychain = FakeKeychain::default();
        let dir = temp_dir("interrupted");
        let vault = Vault::new(dir.clone(), &keychain);

        vault.save(&pairing("device-1"), Storage::Keychain).unwrap();

        let before = fs::read(dir.join("host.json")).unwrap();

        // A folder nothing can be created in stands for a write that dies before the rename.
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();

        let result = replace_file(&dir.join("host.json"), b"{ half");

        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();

        // (A superuser ignores the mode; then the write succeeded and there is nothing to preserve.)
        if result.is_err() {
            assert_eq!(fs::read(dir.join("host.json")).unwrap(), before);
        }

        assert!(!dir.join("host.json.tmp").exists());
    }

    #[test]
    fn an_unpaired_machine_loads_nothing_and_forget_clears_a_pairing() {
        let dir = temp_dir("forget");
        let keychain = FakeKeychain::default();
        let vault = Vault::new(dir, &keychain);

        assert_eq!(vault.load().unwrap(), None);

        vault.save(&pairing("device-1"), Storage::Keychain).unwrap();
        vault.forget().unwrap();

        assert_eq!(vault.load().unwrap(), None);
        assert!(keychain.entries.borrow().is_empty());
    }
}
