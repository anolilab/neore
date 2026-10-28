//! The headless host the desktop drives over a pipe (`device_core::host`). Started as
//! `neore-host --stdio`; it opens no listener, and stdout carries frames only.

use std::io;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);

    if args.next().as_deref() != Some("--stdio") || args.next().is_some() {
        eprintln!("usage: neore-host --stdio");

        return ExitCode::from(2);
    }

    // The host holds no pairing, so a build that links the keyring was packaged wrong (`--no-default-features`).
    if cfg!(feature = "keychain") {
        eprintln!("neore-host: built with the `keychain` feature; it must be built with --no-default-features");
    }

    match device_core::host::serve(io::stdin().lock(), io::stdout()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("neore-host: {error}");

            ExitCode::FAILURE
        }
    }
}
