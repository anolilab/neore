//! The `neore-host pair | run | unpair` commands: argument handling around [`pair`](super::pair),
//! [`serve`](super::serve) and [`vault`](super::vault). Nothing here opens a listener.

use std::io;
use std::path::Path;
use std::process::ExitCode;

use super::http::UreqHttp;
use super::pair::{self, Identity, SystemTimer, Timer};
use super::serve::{RunLock, Service};
use super::vault::{default_dir, OsKeychain, Vault};

/// The used-nonce history `run` keeps beside the pairing.
const NONCE_FILE: &str = "nonces.json";

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

    // The build's version is not an error either: `neore-host --version`, or after a command.
    if asks_for_version(command, args.as_slice()) {
        println!("neore-host {}", env!("CARGO_PKG_VERSION"));

        return ExitCode::SUCCESS;
    }

    // Asking for help is not an error, and it must not do the command's work.
    if matches!(command, "pair" | "run" | "unpair") && asks_for_help(args.as_slice()) {
        println!("{}", help_for(command));

        return ExitCode::SUCCESS;
    }

    let dir = match default_dir() {
        Ok(dir) => dir,
        Err(reason) => {
            eprintln!("neore-host: {reason}");

            return ExitCode::FAILURE;
        }
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

            // Held until the pairing is stored: two `pair` commands could both find the vault empty, both be approved,
            // and the later record would replace the first, leaving a registered device nothing here points to.
            let _lock = match RunLock::acquire(vault.dir()) {
                Ok(lock) => lock,
                Err(error) => {
                    eprintln!("neore-host: {error}");

                    return ExitCode::FAILURE;
                }
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

                    ExitCode::from(error.exit_code())
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
                &vault.dir().join(NONCE_FILE),
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

/// Previews what `unpair --yes` would do, including its refusal while `run` holds the pairing, so a script can use it
/// as a check before the real command.
fn unpair_dry_run(vault: &Vault<'_>) -> ExitCode {
    match vault.record() {
        Ok(Some(_)) if RunLock::acquire(vault.dir()).is_err() => {
            eprintln!("neore-host: `neore-host run` is using this pairing, so unpair would be refused; stop it first. Nothing was changed.");

            ExitCode::FAILURE
        }
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

fn hold_unless_running(vault: &Vault<'_>) -> Option<RunLock> {
    let lock = RunLock::acquire(vault.dir()).ok();

    if lock.is_none() {
        eprintln!("neore-host: `neore-host run` is using this pairing; stop it first, then unpair");
    }

    lock
}

/// Erases the local credential only after a yes: `--yes`, or an answer at a terminal. Refused while `run` holds the
/// pairing, whose copy of the secret would go on accepting calls.
fn unpair(vault: &Vault<'_>, confirmed: bool) -> ExitCode {
    let Some(mut lock) = hold_unless_running(vault) else {
        return ExitCode::FAILURE;
    };

    // Nothing paired is already the state `unpair` aims for, so it asks nothing. A history left by an earlier unpair
    // whose clean-up failed is removed here, so running it again finishes that clean-up.
    let asked_about = match vault.record() {
        Ok(None) => {
            return match forget_nonces(vault.dir()) {
                Ok(()) => {
                    println!("This machine holds no pairing. Nothing to remove.");

                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("neore-host: {error}");

                    ExitCode::FAILURE
                }
            };
        }
        Ok(Some(record)) => record,
        Err(error) => {
            eprintln!("neore-host: {error}");

            return ExitCode::FAILURE;
        }
    };

    if !confirmed {
        // The question may stay open for as long as the person likes, so `run` is not shut out while it does. The lock
        // is taken again for the removal, and only the pairing that was asked about is removed.
        drop(lock);

        if !confirmed_at_terminal(vault) {
            eprintln!("neore-host: nothing was removed. Run `neore-host unpair --yes` to confirm, or `--dry-run` to see what it would remove.");

            return ExitCode::FAILURE;
        }

        let Some(again) = hold_unless_running(vault) else {
            return ExitCode::FAILURE;
        };

        lock = again;

        match vault.record() {
            Ok(Some(record)) if record == asked_about => {}
            Ok(_) => {
                eprintln!("neore-host: the pairing changed while the question was open; nothing was removed");

                return ExitCode::FAILURE;
            }
            Err(error) => {
                eprintln!("neore-host: {error}");

                return ExitCode::FAILURE;
            }
        }
    }

    let outcome = vault.forget().and_then(|()| forget_nonces(vault.dir()));

    drop(lock);

    match outcome {
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

/// The used-nonce history belongs to the pairing it was kept for. After the pairing is gone it protects nothing (the
/// old secret is erased), and a damaged one would stop the next pairing's `run` from starting.
fn forget_nonces(dir: &Path) -> Result<(), String> {
    let path = dir.join(NONCE_FILE);

    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "the pairing was removed, but its call history {} could not be: {error}. Remove it before pairing again.",
            path.display()
        )),
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

/// What `neore-host <command> --help` prints: the command, its arguments, what it prints, and a command to copy.
fn help_for(command: &str) -> String {
    match command {
        "pair" => "neore-host pair --backend <https-origin> [--name <machine name>]

Shows a short code and a link, then waits until the signed-in owner approves the code in the web app.
Prints the code, where the device secret will be kept, and on success the device name, id and approving
account. The backend can also be given as NEORE_BACKEND_URL; the name defaults to this machine's host name.
Exit codes: 0 paired; 2 bad command line; 3 denied by the owner; 4 the code expired; 5 the code is not
valid or was already used; 6 the backend refused; 7 the backend could not be reached (worth retrying
with a pause); 8 the machine may be registered without holding its secret (remove it in the web app
first); 1 any other failure.

Example:
  neore-host pair --backend https://neore.ai --name build-box"
            .to_owned(),
        "run" => "neore-host run

Reads one signed call per line on stdin and answers one JSON line each on stdout: {\"accepted\":true,\"callId\":...,\"tool\":...}
or {\"accepted\":false,\"reason\":...}. Takes no arguments. Needs a pairing and holds it until it ends, so
`unpair` is refused meanwhile.

Only calls the backend signed for this device are accepted; a line written by hand is refused. Here
calls.jsonl holds such lines.

Example:
  neore-host run < calls.jsonl"
            .to_owned(),
        _ => "neore-host unpair [--dry-run | --yes]

Forgets the pairing on this machine and erases its device secret. Asks first at a terminal; --yes skips the
question (needed without one), --dry-run prints what would be removed and changes nothing. The device stays
listed in the web app until it is removed there (Settings, Devices).

Example:
  neore-host unpair --dry-run"
            .to_owned(),
    }
}

/// `--version` or `-V` as the command, or anywhere among a headless command's arguments.
fn asks_for_version(command: &str, args: &[String]) -> bool {
    let is_flag = |word: &str| matches!(word, "--version" | "-V");

    is_flag(command)
        || (matches!(command, "pair" | "run" | "unpair") && args.iter().any(|word| is_flag(word)))
}

/// `--help` or `-h` anywhere among a command's arguments. (`--name` values never start with `-`.)
fn asks_for_help(args: &[String]) -> bool {
    args.iter()
        .any(|argument| matches!(argument.as_str(), "--help" | "-h"))
}

#[cfg(test)]
#[path = "cli_tests.rs"]
mod tests;
