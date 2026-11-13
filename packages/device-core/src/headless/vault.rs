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
use zeroize::{Zeroize, Zeroizing};

const SERVICE: &str = "dev.neore.host";
const PROBE_ACCOUNT: &str = "probe";
const FILE_NAME: &str = "host.json";
const LOCK_NAME: &str = "vault.lock";

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
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
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

impl std::fmt::Debug for Record {
    // Hand-written: a derived `Debug` would print the secret of a file pairing into any log that formats a record.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Record")
            .field("account", &self.account)
            .field("backend", &self.backend)
            .field("device_id", &self.device_id)
            .field("name", &self.name)
            .field("secret", &(!self.secret.is_empty()).then_some("<redacted>"))
            .field("storage", &self.storage)
            .finish()
    }
}

impl Drop for Record {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
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

/// The folder the record lives in. `NEORE_HOST_DIR` overrides it (tests, and a person who wants it elsewhere); it must
/// be absolute, because a relative one would put the secret in whatever folder the command happened to start in.
pub fn default_dir() -> Result<PathBuf, String> {
    let set = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty());

    resolve_dir(
        set("NEORE_HOST_DIR"),
        set("XDG_CONFIG_HOME"),
        set("HOME").map(PathBuf::from),
        set("APPDATA"),
    )
}

fn resolve_dir(
    host_dir: Option<std::ffi::OsString>,
    config_home: Option<std::ffi::OsString>,
    home: Option<PathBuf>,
    app_data: Option<std::ffi::OsString>,
) -> Result<PathBuf, String> {
    if let Some(dir) = host_dir {
        let dir = PathBuf::from(dir);

        return if dir.is_absolute() {
            Ok(dir)
        } else {
            Err(format!(
                "NEORE_HOST_DIR must be an absolute path (it is {})",
                dir.display()
            ))
        };
    }

    let found = if cfg!(target_os = "macos") {
        home.map(|home| home.join("Library/Application Support/Neore Host"))
    } else if cfg!(windows) {
        app_data.map(|dir| PathBuf::from(dir).join("Neore Host"))
    } else {
        xdg_dir(config_home, home)
    };

    found.ok_or_else(|| {
        "no place to keep the pairing was found; set NEORE_HOST_DIR to an absolute folder".into()
    })
}

/// `$XDG_CONFIG_HOME/neore-host`; the spec says to ignore a relative value, which would put the secret file in
/// whatever directory the command happened to start in.
fn xdg_dir(config_home: Option<std::ffi::OsString>, home: Option<PathBuf>) -> Option<PathBuf> {
    config_home
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join("neore-host"))
        .or_else(|| home.map(|home| home.join(".config/neore-host")))
}

/// The keychain account of a pairing: the device id alone is the backend's, so the backend is part of it, and two
/// pairings against different backends cannot overwrite each other's secret. The backend's length leads, so no pair
/// can read as another (`a|b` + `c` against `a` + `b|c`).
fn account_of(backend: &str, device_id: &str) -> String {
    format!("{}:{backend}|{device_id}", backend.len())
}

/// The keychain if it works; else the file, but only where a file can be kept private (Unix permissions).
fn choose_storage(keychain_works: bool, can_keep_file_private: bool) -> Result<Storage, String> {
    if keychain_works {
        Ok(Storage::Keychain)
    } else if can_keep_file_private {
        Ok(Storage::File)
    } else {
        Err("this machine has no keychain it can use, and this system cannot keep a secret file private, so there is nowhere safe to keep the device secret".into())
    }
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

#[derive(PartialEq, Eq)]
pub struct Loaded {
    pub record: Record,
    pub secret: String,
}

impl Drop for Loaded {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

impl std::fmt::Debug for Loaded {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Loaded")
            .field("record", &self.record)
            .field("secret", &"<redacted>")
            .finish()
    }
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
    /// code, so the owner sees the choice before approving. The probe entry is removed. An error when neither can
    /// hold it, or when the folder the pairing would be saved in is not one the vault accepts (created owner-only if
    /// missing, its parent checked), so a pairing stops before a code is shown that `save` could only refuse.
    pub fn probe(&self) -> Result<Storage, String> {
        ensure_private_dir(&self.dir)?;

        let value = "neore-host-probe";
        let works = self.keychain.set(PROBE_ACCOUNT, value).is_ok()
            && self.keychain.get(PROBE_ACCOUNT).ok().flatten().as_deref() == Some(value);

        let _ = self.keychain.delete(PROBE_ACCOUNT);

        choose_storage(works, cfg!(unix))
    }

    /// Stores the pairing where `storage` says: the place [`probe`](Self::probe) announced before the owner approved.
    /// It never switches to the other one, because the owner approved THAT choice. When it cannot hold the secret
    /// there, an error: the secret is not kept anywhere, and nothing of it is left behind.
    ///
    /// Under the vault's lock, so a second `save` or an `unpair` cannot interleave with this one. The record goes
    /// first and the keychain second: a crash between them leaves a record whose secret is missing, which `load`
    /// reports and `forget` clears, where the other order would leave a secret nothing points to.
    pub fn save(&self, pairing: &NewPairing<'_>, storage: Storage) -> Result<(), String> {
        let _lock = Lock::acquire(&self.dir)?;

        // Saving over a pairing would leave its keychain entry behind with nothing pointing to it.
        if fs::symlink_metadata(self.file()).is_ok() {
            return Err(format!(
                "this machine is already paired ({} exists); run `neore-host unpair` first",
                self.file().display()
            ));
        }

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
                write_private(&self.dir, &self.file(), &record)?;

                let account = account_of(pairing.backend, pairing.device_id);

                match self.keychain.set(&account, pairing.secret) {
                    Ok(()) => Ok(()),
                    Err(reason) => Err(self.undo_keychain_save(&account, &reason)),
                }
            }
            Storage::File => {
                record.secret = pairing.secret.to_owned();

                write_private(&self.dir, &self.file(), &record)
                    .map_err(|error| format!("the secret file could not be written: {error}"))
            }
        }
    }

    /// The keychain refused the secret after the record was written: take the record back, and the entry in case
    /// the refusal came after it was stored. What cannot be undone is named, so the person can remove it by hand.
    fn undo_keychain_save(&self, account: &str, reason: &str) -> String {
        let mut message = format!("the keychain refused the secret ({reason})");

        if let Err(error) = fs::remove_file(self.file()) {
            message.push_str(&format!(
                "; {} could not be removed ({error}): remove it by hand",
                self.file().display()
            ));
        }

        if let Err(error) = self.keychain.delete(account) {
            message.push_str(&format!(
                "; the keychain entry (service {SERVICE}, account {account}) could not be removed ({error}): remove it by hand if it exists"
            ));
        }

        message
    }

    /// The pairing and its secret. `Ok(None)` when this machine is not paired.
    pub fn load(&self) -> Result<Option<Loaded>, String> {
        let Some(_lock) = Lock::acquire_existing(&self.dir)? else {
            return Ok(None);
        };

        let path = self.file();
        let Some((text, mode)) = read_trusted(&path)? else {
            return Ok(None);
        };
        let record: Record = serde_json::from_str(&text)
            .map_err(|_| format!("{} is not a pairing record", path.display()))?;

        let secret = match record.storage {
            Storage::File => {
                refuse_shared_mode(&path, mode)?;

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
        let Some(_lock) = Lock::acquire_existing(&self.dir)? else {
            return Ok(None);
        };

        self.record_locked()
    }

    fn record_locked(&self) -> Result<Option<Record>, String> {
        let path = self.file();

        match read_trusted(&path)? {
            Some((text, _)) => serde_json::from_str(&text).map(Some).map_err(|_| {
                format!(
                    "{} is not a pairing record; remove it by hand",
                    path.display()
                )
            }),
            None => Ok(None),
        }
    }

    /// Forgets the pairing on this machine (the owner removes the device in the web app). The keychain entry goes
    /// first, and the record only once it is gone: a keychain that cannot be reached (locked) is an error that keeps
    /// the record, so `unpair` can be run again, instead of leaving a secret nothing on disk points to. Under the
    /// vault's lock, so it cannot interleave with a `save`.
    pub fn forget(&self) -> Result<(), String> {
        let Some(_lock) = Lock::acquire_existing(&self.dir)? else {
            return Ok(());
        };

        if let Some(record) = self.record_locked()? {
            if record.storage == Storage::Keychain {
                self.keychain
                    .delete(&account_of(&record.backend, &record.device_id))
                    .map_err(|reason| {
                        format!("the keychain would not give up the secret ({reason}); unlock it and run unpair again")
                    })?;
            }
        }

        // A write that died before its rename leaves a temporary that can hold the secret of a file pairing.
        for path in [temporary_of(&self.file()), self.file()] {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }

        Ok(())
    }
}

/// Held while the vault changes or reads the pairing, so `save`, `forget` and `load` of two commands never
/// interleave. An operating-system lock on a file in the vault folder: it goes with the process, so a crash
/// leaves nothing stale. A lock that is held is refused rather than waited for.
struct Lock {
    _file: fs::File,
}

impl Lock {
    /// Creates the (owner-only) folder if it is missing, and the lock with it.
    fn acquire(dir: &Path) -> Result<Self, String> {
        ensure_private_dir(dir)?;

        let path = dir.join(LOCK_NAME);
        let mut options = fs::OpenOptions::new();

        options.write(true).create(true).truncate(false);

        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;

            options.mode(0o600);
        }

        let file = options
            .open(&path)
            .map_err(|error| format!("{} could not be opened: {error}", path.display()))?;

        file.try_lock().map_err(|_| {
            "another neore-host command is changing this pairing; wait for it to finish and try again"
                .to_owned()
        })?;

        Ok(Lock { _file: file })
    }

    /// `None` when there is no folder, so nothing is paired and nothing needs holding.
    fn acquire_existing(dir: &Path) -> Result<Option<Self>, String> {
        match fs::symlink_metadata(dir) {
            Ok(_) => Self::acquire(dir).map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("{} could not be read: {error}", dir.display())),
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

    // Whoever can write in the parent can swap the folder for their own (unless it is sticky, as /tmp is). Only the
    // immediate parent is checked: the rest of the path is the system's to keep.
    if let Some(parent) = dir.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        if let Ok(parent_metadata) = fs::metadata(parent) {
            let parent_mode = parent_metadata.permissions().mode();

            if parent_mode & 0o022 != 0 && parent_mode & 0o1000 == 0 {
                return Err(format!(
                    "{} is writable by others (mode {:o}), so they could replace the folder that holds the pairing; run chmod go-w on it, or choose another folder",
                    parent.display(),
                    parent_mode & 0o7777
                ));
            }
        }
    }

    Ok(())
}

#[cfg(not(unix))]
fn refuse_untrusted_dir(_dir: &Path) -> Result<(), String> {
    Ok(())
}

/// Opens the record without following a link, checks the OPENED file (a plain file of this user), and reads from that
/// same handle, so the path cannot be swapped between the check and the read. Returns the text and the file's mode.
/// `Ok(None)` when there is no record.
#[cfg(unix)]
fn read_trusted(path: &Path) -> Result<Option<(Zeroizing<String>, u32)>, String> {
    read_trusted_with(path, || {})
}

/// [`read_trusted`] with a hook between the open and the check, so a swap at that moment can be tested.
#[cfg(unix)]
fn read_trusted_with(
    path: &Path,
    between: impl FnOnce(),
) -> Result<Option<(Zeroizing<String>, u32)>, String> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

    let not_plain = || {
        format!(
            "{} must be a plain file of yours (not a link, not another user's)",
            path.display()
        )
    };
    let mut file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => return Err(not_plain()),
        Err(error) => return Err(format!("{} could not be read: {error}", path.display())),
    };

    between();

    let metadata = file
        .metadata()
        .map_err(|error| format!("{} could not be read: {error}", path.display()))?;

    // SAFETY: `geteuid` takes no arguments and cannot fail.
    let me = unsafe { libc::geteuid() };

    if !metadata.is_file() || metadata.uid() != me {
        return Err(not_plain());
    }

    let mut text = Zeroizing::new(String::new());

    file.read_to_string(&mut text)
        .map_err(|error| format!("{} could not be read: {error}", path.display()))?;

    Ok(Some((text, metadata.permissions().mode())))
}

#[cfg(not(unix))]
fn read_trusted(path: &Path) -> Result<Option<(Zeroizing<String>, u32)>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some((Zeroizing::new(text), 0))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{} could not be read: {error}", path.display())),
    }
}

/// A secret file that others can read is not a secret any more.
#[cfg(unix)]
fn refuse_shared_mode(path: &Path, mode: u32) -> Result<(), String> {
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
fn refuse_shared_mode(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

/// The folder, made owner-only if it is missing, and refused if it is there and others can enter it. Everything
/// that creates the vault folder goes through this, so no command leaves one the vault would then refuse.
fn ensure_private_dir(dir: &Path) -> Result<(), String> {
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

    let bytes =
        Zeroizing::new(serde_json::to_vec_pretty(record).map_err(|error| error.to_string())?);

    replace_file(path, &bytes)
}

fn temporary_of(path: &Path) -> PathBuf {
    path.with_extension("json.tmp")
}

/// A temporary file beside `path`, written and synced, then renamed over it: an interrupted write leaves the old
/// record whole (and no half-written one), on every platform.
fn replace_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    replace_file_with(path, |file| {
        file.write_all(bytes).and_then(|()| file.sync_all())
    })
}

/// [`replace_file`] with the writing as a parameter, so a write that fails halfway can be tested.
fn replace_file_with(
    path: &Path,
    write: impl FnOnce(&mut fs::File) -> std::io::Result<()>,
) -> Result<(), String> {
    let temporary = temporary_of(path);
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
    let written = write(&mut file).map_err(|error| error.to_string());

    drop(file);

    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);

        return Err(error);
    }

    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);

        error.to_string()
    })?;

    // The rename is in the folder's entry: sync it so the record survives a crash right after. Best effort, because
    // a folder cannot be opened for syncing on every system and the record itself is already whole.
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
        if let Ok(dir) = fs::File::open(dir) {
            let _ = dir.sync_all();
        }
    }

    Ok(())
}

#[cfg(test)]
#[path = "vault_tests.rs"]
mod tests;
