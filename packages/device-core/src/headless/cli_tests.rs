use super::*;

fn words(list: &[&str]) -> Vec<String> {
    list.iter().map(|word| (*word).to_owned()).collect()
}

#[test]
fn help_is_asked_for_by_either_spelling_in_any_position() {
    assert!(asks_for_help(&words(&["--help"])));
    assert!(asks_for_help(&words(&["-h"])));
    assert!(asks_for_help(&words(&[
        "--backend",
        "https://neore.ai",
        "--help"
    ])));
    assert!(!asks_for_help(&words(&[])));
    assert!(!asks_for_help(&words(&["--hlep"])));
    assert!(!asks_for_help(&words(&["--backend", "https://neore.ai"])));
}

#[test]
fn each_command_has_its_own_help_with_a_command_to_copy() {
    for (command, example) in [
        ("pair", "neore-host pair --backend https://neore.ai"),
        ("run", "| neore-host run"),
        ("unpair", "neore-host unpair --dry-run"),
    ] {
        let help = help_for(command);

        assert!(help.starts_with(&format!("neore-host {command}")), "{help}");
        assert!(
            help.contains("Example:") && help.contains(example),
            "{help}"
        );
    }
}

#[test]
fn unpair_erases_only_when_asked_plainly() {
    assert_eq!(
        unpair_request(&words(&[])),
        UnpairRequest::Forget { confirmed: false }
    );
    assert_eq!(
        unpair_request(&words(&["--yes"])),
        UnpairRequest::Forget { confirmed: true }
    );
    assert_eq!(
        unpair_request(&words(&["--dry-run"])),
        UnpairRequest::DryRun
    );
    assert_eq!(
        unpair_request(&words(&["--yes", "--dry-run"])),
        UnpairRequest::Usage
    );
    assert_eq!(unpair_request(&words(&["--yse"])), UnpairRequest::Usage);
}

#[test]
fn unpair_is_refused_while_a_run_holds_the_pairing_and_nothing_is_asked() {
    use super::super::vault::tests::{temp_dir, FakeKeychain};
    use super::super::vault::{NewPairing, Storage};

    let failure = format!("{:?}", ExitCode::FAILURE);
    let success = format!("{:?}", ExitCode::SUCCESS);

    let keychain = FakeKeychain::default();
    let dir = temp_dir("unpair-locked");
    let vault = Vault::new(dir.clone(), &keychain);

    vault
        .save(
            &NewPairing {
                account: "",
                backend: "https://neore.ai",
                device_id: "d1",
                name: "box",
                secret: "x",
            },
            Storage::Keychain,
        )
        .unwrap();

    let running = RunLock::acquire(&dir).unwrap();

    assert_eq!(format!("{:?}", unpair(&vault, true)), failure);
    assert!(dir.join("host.json").exists());
    assert_eq!(keychain.entries.borrow().len(), 1);

    drop(running);

    assert_eq!(
        format!("{:?}", unpair(&vault, false)),
        failure,
        "no terminal, no yes"
    );
    assert!(dir.join("host.json").exists());
    assert_eq!(format!("{:?}", unpair(&vault, true)), success);
    assert!(!dir.join("host.json").exists());
    assert!(keychain.entries.borrow().is_empty());
}

#[test]
fn version_is_asked_for_as_a_command_or_after_one() {
    assert!(asks_for_version("--version", &[]));
    assert!(asks_for_version("-V", &[]));
    assert!(asks_for_version("pair", &words(&["--version"])));
    assert!(asks_for_version("run", &words(&["-V"])));
    assert!(asks_for_version("unpair", &words(&["--yes", "--version"])));
    assert!(!asks_for_version(
        "pair",
        &words(&["--backend", "https://neore.ai"])
    ));
    assert!(!asks_for_version("--stdio", &[]));
}

#[test]
fn unpairing_a_machine_that_is_not_paired_succeeds_and_asks_nothing() {
    use super::super::vault::tests::{temp_dir, FakeKeychain};

    let keychain = FakeKeychain::default();
    let vault = Vault::new(temp_dir("unpair-none"), &keychain);

    // No `--yes` and no terminal: still a success, because there is nothing to confirm.
    assert_eq!(
        format!("{:?}", unpair(&vault, false)),
        format!("{:?}", ExitCode::SUCCESS)
    );
}
