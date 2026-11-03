//! The `neore-host pair | run | unpair` commands: argument handling around [`pair`](super::pair),
//! [`serve`](super::serve) and [`vault`](super::vault). Nothing here opens a listener.

use std::io;
use std::process::ExitCode;

use super::http::UreqHttp;
use super::pair::{self, Identity, SystemTimer, Timer};
use super::serve::Service;
use super::vault::{default_dir, OsKeychain, Vault};

pub const USAGE: &str = "usage:
  neore-host pair --backend <https-origin> [--name <machine name>]   show a code to approve in the web app
  neore-host run                                                     decide which signed calls are for this machine
  neore-host unpair                                                  forget the pairing on this machine
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
pub fn main(command: &str, mut args: impl Iterator<Item = String>) -> ExitCode {
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
                    println!(
                        "Paired as \"{}\" (device {}). The device secret is kept in {}.",
                        paired.name,
                        paired.device_id,
                        paired.storage.describe()
                    );

                    if let Some(notice) = paired.notice {
                        println!("{notice}");
                    }

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
                "neore-host: \"{}\" (device {}), secret in {}. Reading signed calls on stdin.",
                loaded.record.name,
                loaded.record.device_id,
                loaded.record.storage.describe()
            );

            let timer = SystemTimer;
            let mut service = Service::new(
                &loaded.record.device_id,
                &loaded.secret,
                &vault.dir().join("nonces.json"),
                timer.now_ms(),
            );

            match service.run(io::stdin().lock(), io::stdout(), || timer.now_ms()) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("neore-host: {error}");

                    ExitCode::FAILURE
                }
            }
        }
        "unpair" => match vault.forget() {
            Ok(()) => {
                println!("This machine no longer holds a pairing. Remove the device in the web app (Settings, Devices) to end it there.");

                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("neore-host: {error}");

                ExitCode::FAILURE
            }
        },
        _ => {
            eprintln!("{USAGE}");

            ExitCode::from(2)
        }
    }
}
