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

/// The folder, made owner-only if it is missing, and refused if it is there and others can enter it. Everything
/// that creates the vault folder goes through this, so no command leaves one the vault would then refuse.
pub(super) fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;

        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|error| error.to_string())?;
    }

    #[cfg(not(unix))]
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;

    refuse_untrusted_dir(dir)
}

/// Writes `record` atomically into `dir`, owner-only. The folder is created 0700. Without Unix permissions there is
/// no way to keep a file private, so a secret is not written to one.
fn write_private(dir: &Path, path: &Path, record: &Record) -> Result<(), String> {
    ensure_private_dir(dir)?;

    #[cfg(not(unix))]
    {
        if record.storage == Storage::File {
            return Err("this system cannot keep a file private".into());
        }
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
#[path = "vault_tests.rs"]
pub(crate) mod tests;
