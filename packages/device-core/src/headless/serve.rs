//! The foreground run of a paired headless machine: `neore-host run`.
//!
//! This slice decides ONE thing: whether a call is signed for this device. A line on stdin carries the signed
//! envelope (`{"payload": "...", "signature": "..."}`, the shape the backend hands a relay); the answer on stdout
//! is `accepted` with the call's id and tool, or `refused` with a reason. Nothing is executed and no listener is
//! opened: the machine speaks only through its own pipe. Running the accepted call and fetching calls from the
//! backend are the service slice's work, and this is its seam: [`Service::judge`] is what that loop will call.
//!
//! The checks are the paired side's own (`envelope::verify_call`): the HMAC under this device's secret in the
//! `call` domain, the device id the payload names, its expiry, and a one-time nonce that survives a restart.

use std::io::{BufRead, Read, Write};
use std::path::Path;

use serde_json::{json, Value};

use crate::envelope::{verify_call, NonceSet, Signed};

/// A signed call is a few kilobytes; a line longer than this is not one.
const MAX_LINE_BYTES: u64 = 1024 * 1024;

/// Holds this pairing's run lock until dropped. The used-nonce history is one process's memory plus one file, so two
/// `neore-host run` processes on the same pairing could each accept the same call; the second one is refused.
pub struct RunLock {
    _file: std::fs::File,
}

impl RunLock {
    pub fn acquire(dir: &Path) -> Result<Self, String> {
        // The vault refuses a folder others can enter, so a missing one is made owner-only here too.
        super::vault::ensure_private_dir(dir)?;

        let path = dir.join("run.lock");
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(|error| format!("{} could not be opened: {error}", path.display()))?;

        file.try_lock().map_err(|_| {
            "another `neore-host run` already holds this pairing; stop it first".to_owned()
        })?;

        Ok(RunLock { _file: file })
    }
}

pub struct Service {
    device_id: String,
    nonces: NonceSet,
    secret: String,
}

/// A call this device accepted.
#[derive(Debug, PartialEq, Eq)]
pub struct Accepted {
    pub call_id: String,
    pub tool: String,
}

impl Service {
    /// `nonce_file` keeps the used nonces across restarts, so a replay inside an envelope's window is refused after
    /// the process is restarted too. A file that exists but is unreadable or damaged is an error, not an empty
    /// history: starting on it would accept a call again that was already accepted.
    pub fn new(device_id: &str, secret: &str, nonce_file: &Path, now: u64) -> Result<Self, String> {
        let nonces = NonceSet::persisted_strict(nonce_file, now).map_err(|reason| {
            format!("{reason}; delete it to start with an empty history once every call signed before now has expired")
        })?;

        Ok(Service {
            device_id: device_id.to_owned(),
            nonces,
            secret: secret.to_owned(),
        })
    }

    /// Whether `signed` is a call the backend signed for THIS device. The error is the refusal's reason; it never
    /// echoes the payload or the signature.
    pub fn judge(&mut self, signed: &Signed, now: u64) -> Result<Accepted, String> {
        let call = verify_call(&self.secret, &self.device_id, signed, now, &mut self.nonces)?;

        Ok(Accepted {
            call_id: call.call_id,
            tool: call.tool,
        })
    }

    fn answer(&mut self, line: &str, now: u64) -> Value {
        let Ok(signed) = serde_json::from_str::<Signed>(line) else {
            return json!({ "accepted": false, "reason": "the request is malformed" });
        };

        match self.judge(&signed, now) {
            Ok(accepted) => {
                json!({ "accepted": true, "callId": accepted.call_id, "tool": accepted.tool })
            }
            Err(reason) => json!({ "accepted": false, "reason": reason }),
        }
    }

    /// One answer per input line until the input ends. `now` is read per line.
    pub fn run(
        &mut self,
        mut input: impl BufRead,
        mut output: impl Write,
        now: impl Fn() -> u64,
    ) -> std::io::Result<()> {
        let mut line = Vec::new();

        loop {
            line.clear();

            let read = input
                .by_ref()
                .take(MAX_LINE_BYTES + 1)
                .read_until(b'\n', &mut line)?;

            if read == 0 {
                return Ok(());
            }

            let too_long = read as u64 > MAX_LINE_BYTES && line.last() != Some(&b'\n');

            if too_long {
                // Drop the rest of the oversized line, then answer once.
                let mut sink = Vec::new();

                loop {
                    sink.clear();

                    let skipped = input
                        .by_ref()
                        .take(MAX_LINE_BYTES)
                        .read_until(b'\n', &mut sink)?;

                    if skipped == 0 || sink.last() == Some(&b'\n') {
                        break;
                    }
                }
            }

            let answer = if too_long {
                json!({ "accepted": false, "reason": "the request is too long" })
            } else {
                match std::str::from_utf8(&line) {
                    Ok(text) if text.trim().is_empty() => continue,
                    Ok(text) => self.answer(text.trim(), now()),
                    Err(_) => json!({ "accepted": false, "reason": "the request is malformed" }),
                }
            };

            writeln!(output, "{answer}")?;
            output.flush()?;
        }
    }
}

#[cfg(test)]
#[path = "serve_tests.rs"]
mod tests;
