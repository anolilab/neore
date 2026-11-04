//! The `neore-host pair | run | unpair` commands: argument handling around [`pair`](super::pair),
//! [`serve`](super::serve) and [`vault`](super::vault). Nothing here opens a listener.

use std::io;
use std::process::ExitCode;

use super::http::UreqHttp;
use super::pair::{self, Identity, SystemTimer, Timer};
use super::serve::{RunLock, Service};
use super::vault::{default_dir, OsKeychain, Vault};

pub const USAGE: &str = "usage:
  neore-host pair --backend <https-origin> [--name <machine name>]   show a code to approve in the web app
  neore-host run                                                     decide which signed calls are for this machine
  neore-host unpair [--dry-run | --yes]                              forget the pairing on this machine (asks first; --yes skips the question, --dry-run only shows it)
  neore-host --stdio [--launch <id> [--desktop <tag>]]               the pipe a desktop drives (built without `headless`)

The backend can also be given as NEORE_BACKEND_URL. Files live in NEORE_HOST_DIR when set.";

/// This machine's name, reduced the way the backend reduces it. Never an error: a pairing can use a typed name.
fn machine_name() -> String {
    #[cfg(unix)]
    {
        let mut buffer = [0u8; 256];

        // SAFETY: the buffer is writable for its whole length, and `gethostname` NUL-terminates within it.
        let status = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };

        if status == 0 {
            let end = buffer
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(buffer.len());

            if let Ok(name) = std::str::from_utf8(&buffer[..end]) {
                if !name.is_empty() {
                    return name.to_owned();
                }
            }
        }
    }

    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "unknown-host".into())
}

fn flag(args: &mut impl Iterator<Item = String>, name: &str, into: &mut Option<String>) -> bool {
    match args.next() {
        Some(value) if !value.starts_with("--") && into.is_none() => {
            *into = Some(value);

            true
        }
        _ => {
            eprintln!("neore-host: {name} needs a value, once");

            false
        }
    }
}

/// Runs a headless command; `command` is the first argument.
pub fn main(command: &str, args: impl Iterator<Item = String>) -> ExitCode {
    let mut args = args.collect::<Vec<_>>().into_iter();

    // Asking for help is not an error, and it must not do the command's work.
    if matches!(command, "pair" | "run" | "unpair") && asks_for_help(args.as_slice()) {
        println!("{USAGE}");

        return ExitCode::SUCCESS;
    }

    let Some(dir) = default_dir() else {
        eprintln!("neore-host: no folder to keep the pairing in; set NEORE_HOST_DIR");

        return ExitCode::FAILURE;
    };
    let keychain = OsKeychain;
    let vault = Vault::new(dir, &keychain);

    match command {
        "pair" => {
            let mut backend = None;
            let mut name = None;

            while let Some(argument) = args.next() {
                let ok = match argument.as_str() {
                    "--backend" => flag(&mut args, "--backend", &mut backend),
                    "--name" => flag(&mut args, "--name", &mut name),
                    _ => false,
                };

                if !ok {
                    eprintln!("{USAGE}");

                    return ExitCode::from(2);
                }
            }

            let Some(backend) = backend.or_else(|| std::env::var("NEORE_BACKEND_URL").ok()) else {
                eprintln!("neore-host: pair needs --backend or NEORE_BACKEND_URL\n{USAGE}");

                return ExitCode::from(2);
            };

            match vault.load() {
                Ok(Some(loaded)) => {
                    eprintln!(
                        "neore-host: this machine is already paired as \"{}\" (device {}). Run `neore-host unpair` first, and remove the device in the web app.",
                        loaded.record.name, loaded.record.device_id
                    );

                    return ExitCode::FAILURE;
                }
                Ok(None) => {}
                Err(error) => {
                    eprintln!("neore-host: {error}");

                    return ExitCode::FAILURE;
                }
            }

            let hostname = name.unwrap_or_else(machine_name);
            let outcome = pair::pair(
                &UreqHttp::new(),
                &SystemTimer,
                &vault,
                &backend,
                &Identity {
                    hostname: &hostname,
                    platform: pair::this_platform(),
                },
                &mut io::stdout(),
            );

            match outcome {
                Ok(paired) => {
                    let owner = if paired.account.is_empty() {
                        String::new()
                    } else {
                        format!(" to {}", paired.account)
                    };

                    println!(
                        "Paired{owner} as \"{}\" (device {}). The device secret is kept in {}.",
                        paired.name,
                        paired.device_id,
                        paired.storage.describe()
                    );
                    println!(
                        "If that is not your account, run `neore-host unpair` and remove the device in the web app."
                    );

                    println!(
                        "Run `neore-host run` to have this machine decide which calls are for it."
                    );

                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("neore-host: {error}");

                    ExitCode::FAILURE
                }
            }
        }
        "run" => {
            if args.next().is_some() {
                eprintln!("{USAGE}");

                return ExitCode::from(2);
            }

            let _lock = match RunLock::acquire(vault.dir()) {
                Ok(lock) => lock,
                Err(error) => {
                    eprintln!("neore-host: {error}");

                    return ExitCode::FAILURE;
                }
            };

            let loaded = match vault.load() {
                Ok(Some(loaded)) => loaded,
                Ok(None) => {
                    eprintln!(
                        "neore-host: this machine is not paired; run `neore-host pair` first"
                    );

                    return ExitCode::FAILURE;
                }
                Err(error) => {
                    eprintln!("neore-host: {error}");

                    return ExitCode::FAILURE;
                }
            };

            eprintln!(
                "neore-host: \"{}\" (device {}){}, secret in {}. Reading signed calls on stdin.",
                loaded.record.name,
                loaded.record.device_id,
                if loaded.record.account.is_empty() {
                    String::new()
                } else {
                    format!(" of {}", loaded.record.account)
                },
                loaded.record.storage.describe()
            );

            let timer = SystemTimer;
            let mut service = match Service::new(
                &loaded.record.device_id,
                &loaded.secret,
                &vault.dir().join("nonces.json"),
                timer.now_ms(),
            ) {
                Ok(service) => service,
                Err(error) => {
                    eprintln!("neore-host: {error}");

                    return ExitCode::FAILURE;
                }
            };

            match service.run(io::stdin().lock(), io::stdout(), || timer.now_ms()) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("neore-host: {error}");

                    ExitCode::FAILURE
                }
            }
        }
        "unpair" => match unpair_request(args.as_slice()) {
            UnpairRequest::Usage => {
                eprintln!("{USAGE}");

                ExitCode::from(2)
            }
            UnpairRequest::DryRun => unpair_dry_run(&vault),
            UnpairRequest::Forget { confirmed } => unpair(&vault, confirmed),
        },
        _ => {
            eprintln!("{USAGE}");

            ExitCode::from(2)
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum UnpairRequest {
    DryRun,
    Forget { confirmed: bool },
    Usage,
}

/// `unpair` takes `--yes` (do not ask) or `--dry-run` (only say what would go), never both and nothing else: a
/// typo must not delete the pairing.
fn unpair_request(args: &[String]) -> UnpairRequest {
    match args {
        [] => UnpairRequest::Forget { confirmed: false },
        [one] if one == "--yes" => UnpairRequest::Forget { confirmed: true },
        [one] if one == "--dry-run" => UnpairRequest::DryRun,
        _ => UnpairRequest::Usage,
    }
}

fn unpair_dry_run(vault: &Vault<'_>) -> ExitCode {
    match vault.record() {
        Ok(Some(record)) => {
            println!(
                "Would forget \"{}\" (device {}) on {}, and remove its secret from {}. Nothing was changed.",
                record.name,
                record.device_id,
                record.backend,
                record.storage.describe()
            );

            ExitCode::SUCCESS
        }
        Ok(None) => {
            println!("This machine holds no pairing. Nothing to remove.");

            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("neore-host: {error}");

            ExitCode::FAILURE
        }
    }
}

/// Erases the local credential only after a yes: `--yes`, or an answer at a terminal. Refused while `run` holds the
/// pairing, whose copy of the secret would go on accepting calls.
fn unpair(vault: &Vault<'_>, confirmed: bool) -> ExitCode {
    let _lock = match RunLock::acquire(vault.dir()) {
        Ok(lock) => lock,
        Err(_) => {
            eprintln!(
                "neore-host: `neore-host run` is using this pairing; stop it first, then unpair"
            );

            return ExitCode::FAILURE;
        }
    };

    if !confirmed && !confirmed_at_terminal(vault) {
        eprintln!("neore-host: nothing was removed. Run `neore-host unpair --yes` to confirm, or `--dry-run` to see what it would remove.");

        return ExitCode::FAILURE;
    }

    match vault.forget() {
        Ok(()) => {
            println!("This machine no longer holds a pairing. Remove the device in the web app (Settings, Devices) to end it there.");

            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("neore-host: {error}");

            ExitCode::FAILURE
        }
    }
}

fn confirmed_at_terminal(vault: &Vault<'_>) -> bool {
    use std::io::{BufRead, IsTerminal, Write};

    if !io::stdin().is_terminal() {
        return false;
    }

    let what = match vault.record() {
        Ok(Some(record)) => format!("\"{}\" (device {})", record.name, record.device_id),
        _ => "the pairing on this machine".to_owned(),
    };

    eprint!("Forget {what} and erase its secret from this machine? [y/N] ");

    let _ = io::stderr().flush();
    let mut answer = String::new();

    io::stdin().lock().read_line(&mut answer).is_ok()
        && matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}

/// `--help` or `-h` anywhere among a command's arguments. (`--name` values never start with `-`.)
fn asks_for_help(args: &[String]) -> bool {
    args.iter()
        .any(|argument| matches!(argument.as_str(), "--help" | "-h"))
}

#[cfg(test)]
mod tests {
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
}
