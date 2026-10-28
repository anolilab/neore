//! The headless host the desktop drives over a pipe (`device_core::host`). Started as
//! `neore-host --stdio [--launch <id>]`; it opens no listener, and stdout carries frames only.
//!
//! `--launch` names this run so the desktop that started it can stop it later (`device_core::launch`).

use std::io;
use std::process::ExitCode;

use device_core::launch::{self, Launch};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let usage = || {
        eprintln!("usage: neore-host --stdio [--launch <id>]");

        ExitCode::from(2)
    };

    if args.next().as_deref() != Some("--stdio") {
        return usage();
    }

    let launch_id = match args.next().as_deref() {
        None => None,
        Some("--launch") => match args.next() {
            Some(id) if launch::is_launch_id(&id) => Some(id),
            _ => return usage(),
        },
        Some(_) => return usage(),
    };

    if args.next().is_some() {
        return usage();
    }

    // The host holds no pairing, so a build that links the keyring was packaged wrong (`--no-default-features`).
    if cfg!(feature = "keychain") {
        eprintln!("neore-host: built with the `keychain` feature; it must be built with --no-default-features");
    }

    // Before any thread starts: the environment is edited here.
    let launch = launch_id.as_deref().and_then(|id| {
        let dir = launch::run_dir()?;

        #[cfg(unix)]
        if let Err(error) = launch::stabilise_agent_socket(&dir) {
            eprintln!("neore-host: the agent socket could not be linked: {error}");
        }

        match Launch::register(id, &dir) {
            Ok(launch) => Some(launch),
            Err(error) => {
                eprintln!(
                    "neore-host: the launch could not be filed in {}: {error}",
                    dir.display()
                );

                None
            }
        }
    });
    let served =
        device_core::host::serve_launch(io::stdin().lock(), io::stdout(), launch_id.as_deref());

    drop(launch);

    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("neore-host: {error}");

            ExitCode::FAILURE
        }
    }
}
