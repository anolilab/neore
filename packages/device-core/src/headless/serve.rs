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
mod tests {
    use std::io::Cursor;

    use super::*;
    use crate::envelope::{sign_value, Domain};
    use crate::headless::vault::tests::temp_dir;

    const SECRET: &str = concat!(
        "0123456789abcdef",
        "0123456789abcdef",
        "0123456789abcdef",
        "0123456789abcdef"
    );
    const OTHER: &str = concat!(
        "fedcba9876543210",
        "fedcba9876543210",
        "fedcba9876543210",
        "fedcba9876543210"
    );
    const NOW: u64 = 1_800_000_000_000;

    fn call(device: &str, nonce: &str, expires_in: i64) -> Value {
        json!({
            "callId": format!("call-{nonce}"),
            "deviceId": device,
            "expiresAt": (NOW as i64 + expires_in) as u64,
            "input": { "path": "a.txt" },
            "kind": "call",
            "nonce": nonce,
            "taintedBy": [],
            "threadTitle": "Build",
            "tool": "fs_read",
            "v": 1
        })
    }

    fn line(secret: &str, value: &Value) -> String {
        serde_json::to_string(&sign_value(secret, Domain::Call, value)).unwrap()
    }

    fn service(label: &str) -> Service {
        let dir = temp_dir(label);

        std::fs::create_dir_all(&dir).unwrap();

        Service::new("device-1", SECRET, &dir.join("nonces.json"), NOW).unwrap()
    }

    fn answers(service: &mut Service, lines: &[String]) -> Vec<Value> {
        let mut out = Vec::new();

        service
            .run(Cursor::new(lines.join("\n") + "\n"), &mut out, || NOW)
            .unwrap();

        String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|answer| serde_json::from_str(answer).unwrap())
            .collect()
    }

    #[test]
    fn accepts_a_call_signed_for_this_device() {
        let mut service = service("accept");
        let got = answers(
            &mut service,
            &[line(SECRET, &call("device-1", "n1", 60_000))],
        );

        assert_eq!(
            got,
            vec![json!({ "accepted": true, "callId": "call-n1", "tool": "fs_read" })]
        );
    }

    #[test]
    fn refuses_a_call_signed_with_another_secret() {
        let mut service = service("foreign-secret");
        let got = answers(
            &mut service,
            &[line(OTHER, &call("device-1", "n1", 60_000))],
        );

        assert_eq!(got[0]["accepted"], json!(false));
        assert_eq!(
            got[0]["reason"],
            json!("the request is not signed for this device")
        );
    }

    #[test]
    fn refuses_a_call_the_backend_signed_for_another_device() {
        // Same secret (a mistake or a copy), but the payload names a different device.
        let mut service = service("foreign-device");
        let got = answers(
            &mut service,
            &[line(SECRET, &call("device-2", "n1", 60_000))],
        );

        assert_eq!(got[0]["accepted"], json!(false));
        assert_eq!(
            got[0]["reason"],
            json!("the request is not for this device")
        );
    }

    #[test]
    fn refuses_a_result_or_manifest_replayed_as_a_call() {
        let mut service = service("domain");
        let value = call("device-1", "n1", 60_000);
        let result = serde_json::to_string(&sign_value(SECRET, Domain::Result, &value)).unwrap();
        let manifest =
            serde_json::to_string(&sign_value(SECRET, Domain::Manifest, &value)).unwrap();
        let got = answers(&mut service, &[result, manifest]);

        assert!(got.iter().all(|answer| answer["accepted"] == json!(false)));
    }

    #[test]
    fn refuses_a_replay_an_expired_call_and_a_tampered_payload() {
        let mut service = service("replay");
        let first = line(SECRET, &call("device-1", "n1", 60_000));
        let expired = line(SECRET, &call("device-1", "n2", -1));
        let mut tampered = serde_json::from_str::<Value>(&first).unwrap();

        tampered["payload"] = json!(tampered["payload"]
            .as_str()
            .unwrap()
            .replace("fs_read", "shell_run"));

        let got = answers(
            &mut service,
            &[first.clone(), first, expired, tampered.to_string()],
        );

        assert_eq!(got[0]["accepted"], json!(true));
        assert_eq!(got[1]["accepted"], json!(false));
        assert_eq!(got[2]["reason"], json!("the request has expired"));
        assert_eq!(
            got[3]["reason"],
            json!("the request is not signed for this device")
        );
    }

    #[test]
    fn a_used_nonce_stays_used_after_a_restart() {
        let dir = temp_dir("restart");

        std::fs::create_dir_all(&dir).unwrap();

        let file = dir.join("nonces.json");
        let accepted = line(SECRET, &call("device-1", "n1", 60_000));
        let mut first = Service::new("device-1", SECRET, &file, NOW).unwrap();

        assert_eq!(
            answers(&mut first, std::slice::from_ref(&accepted))[0]["accepted"],
            json!(true)
        );

        let mut restarted = Service::new("device-1", SECRET, &file, NOW).unwrap();

        assert_eq!(
            answers(&mut restarted, &[accepted])[0]["accepted"],
            json!(false)
        );
    }

    #[test]
    fn a_damaged_nonce_history_stops_the_run_instead_of_forgetting_it() {
        let dir = temp_dir("damaged");

        std::fs::create_dir_all(&dir).unwrap();

        let file = dir.join("nonces.json");

        std::fs::write(&file, "{ not json").unwrap();

        let error = Service::new("device-1", SECRET, &file, NOW)
            .err()
            .expect("a damaged history must not be taken for an empty one");

        assert!(error.contains("is damaged"), "{error}");

        // A directory where the file should be is unreadable, which is not "no history" either.
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();

        assert!(Service::new("device-1", SECRET, &file, NOW).is_err());
        // Absent is a first start.
        assert!(Service::new("device-1", SECRET, &dir.join("none.json"), NOW).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_lock_taken_before_any_pairing_leaves_a_folder_the_vault_accepts() {
        use std::os::unix::fs::PermissionsExt;

        use super::super::vault::tests::FakeKeychain;
        use super::super::vault::{NewPairing, Storage, Vault};

        let dir = temp_dir("lock-first").join("nested");
        let lock = RunLock::acquire(&dir).unwrap();

        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o077,
            0
        );

        let keychain = FakeKeychain::default();
        let vault = Vault::new(dir, &keychain);

        assert_eq!(vault.load().unwrap(), None);
        vault
            .save(
                &NewPairing {
                    account: "",
                    backend: "https://neore.ai",
                    device_id: "d",
                    name: "n",
                    secret: "s",
                },
                Storage::Keychain,
            )
            .unwrap();

        drop(lock);
    }

    #[test]
    fn a_second_run_on_the_same_pairing_is_refused_until_the_first_ends() {
        let dir = temp_dir("lock");
        let first = RunLock::acquire(&dir).unwrap();

        assert!(RunLock::acquire(&dir)
            .err()
            .unwrap()
            .contains("already holds"));

        drop(first);

        assert!(RunLock::acquire(&dir).is_ok());
    }

    #[test]
    fn malformed_and_oversized_lines_are_refused_without_ending_the_run() {
        let mut service = service("malformed");
        let oversized = "x".repeat(MAX_LINE_BYTES as usize + 10);
        let got = answers(
            &mut service,
            &[
                "not json".into(),
                oversized,
                line(SECRET, &call("device-1", "n9", 60_000)),
            ],
        );

        assert_eq!(got.len(), 3);
        assert_eq!(got[0]["reason"], json!("the request is malformed"));
        assert_eq!(got[1]["reason"], json!("the request is too long"));
        assert_eq!(got[2]["accepted"], json!(true));
    }
}
