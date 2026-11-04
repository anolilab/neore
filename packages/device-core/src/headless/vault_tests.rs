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

    CLEANUP.with(|cleanup| cleanup.0.borrow_mut().push(dir.clone()));

    dir
}

/// Every path `temp_dir` handed out, removed when the test's thread ends (each test runs on its own), whether the
/// test passed or panicked.
struct Cleanup(RefCell<Vec<PathBuf>>);

impl Drop for Cleanup {
    fn drop(&mut self) {
        for path in self.0.borrow().iter() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;

                // A test may have left a folder it made unreadable.
                let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
            }

            if fs::remove_dir_all(path).is_err() {
                let _ = fs::remove_file(path);
            }
        }
    }
}

thread_local! {
    static CLEANUP: Cleanup = const { Cleanup(RefCell::new(Vec::new())) };
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
