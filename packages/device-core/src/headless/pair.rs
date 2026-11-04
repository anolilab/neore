//! Pairing by code: the machine asks the backend for a short code, shows it, and polls until the signed-in owner
//! approves it in the web app. The poll that follows approval answers with the device id and secret, once. The
//! flow is the OAuth device grant's (RFC 8628), which the `neore login --device` command line uses too.
//!
//! The handshake takes its backend, its clock and its vault as parameters, so it is tested end to end against a
//! fake backend with no network, no sleeping and no keychain.

use std::fmt;
use std::io::Write;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use super::http::{validate_backend, Http, Reply};
use super::vault::{NewPairing, Storage, Vault};

/// The client id the backend accepts for a headless machine (`backend/lunora/auth/cli-device-auth.ts`).
pub const CLIENT_ID: &str = "neore-host";

const CODE_PATH: &str = "/api/auth/device/code";
const HOST_PATH: &str = "/api/auth/device/host";

/// RFC 8628 3.5: on `slow_down`, wait this much longer from then on.
const SLOW_DOWN_STEP: Duration = Duration::from_secs(5);

/// The lower bound on the poll interval, whatever the server says.
const MIN_INTERVAL: Duration = Duration::from_secs(1);

/// Consecutive transport, 429 and 5xx answers tolerated while polling before giving up.
const MAX_CONSECUTIVE_FAILURES: u32 = 5;

/// What `pair` needs from the clock, so a test does not wait.
pub trait Timer {
    fn now_ms(&self) -> u64;
    fn sleep(&self, duration: Duration);
}

pub struct SystemTimer;

impl Timer for SystemTimer {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|age| age.as_millis() as u64)
            .unwrap_or_default()
    }

    fn sleep(&self, duration: Duration) {
        thread::sleep(duration);
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PairError {
    /// The owner said no.
    Denied,
    /// The code ran out before it was approved.
    Expired,
    /// The backend does not recognise the code, or it was already used.
    Invalid,
    /// The backend refused (a rate limit, a full account, no pairing offered), with its reason.
    Refused(String),
    /// The answer to a request was lost and the code was refused as used right after: the backend may have registered
    /// this machine, but its secret never arrived.
    PossiblyRegistered,
    /// The pairing succeeded on the backend but this machine could not keep the secret.
    NotStored { device_id: String, reason: String },
    /// The backend could not be reached, or kept failing.
    Unreachable(String),
}

impl fmt::Display for PairError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PairError::Denied => formatter.write_str("the pairing was denied"),
            PairError::Expired => formatter.write_str("the code expired before it was approved; run the command again"),
            PairError::Invalid => formatter.write_str("the code is not valid, or it was already used; run the command again"),
            PairError::Refused(reason) => write!(formatter, "the backend refused the pairing: {reason}"),
            PairError::PossiblyRegistered => formatter.write_str(
                "the backend's answer was lost and the code is used up. It may have registered this machine without its secret reaching it: look for it in the web app (Settings, Devices), remove it, and run the command again",
            ),
            PairError::NotStored { device_id, reason } => write!(
                formatter,
                "the machine was registered (device {device_id}) but its secret could not be stored: {reason}. Remove that device in the web app (Settings, Devices) and pair again."
            ),
            PairError::Unreachable(reason) => write!(formatter, "the backend could not be reached: {reason}"),
        }
    }
}

impl std::error::Error for PairError {}

#[derive(Debug, PartialEq, Eq)]
pub struct Paired {
    /// The approving account as the backend displayed it (a masked address); empty when it sent none.
    pub account: String,
    pub device_id: String,
    pub name: String,
    pub storage: Storage,
}

/// What this machine says about itself. Display only: the approval page shows it as text.
pub struct Identity<'a> {
    pub hostname: &'a str,
    /// `linux`, `macos` or `windows`.
    pub platform: &'a str,
}

/// The platform word the backend takes, for the system this binary runs on.
pub fn this_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

fn text<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

fn number(body: &Value, key: &str) -> Option<u64> {
    body.get(key).and_then(Value::as_u64)
}

fn describe(reply: &Reply) -> String {
    text(&reply.body, "error_description")
        .or_else(|| text(&reply.body, "message"))
        .map_or_else(
            || format!("the backend answered {}", reply.status),
            str::to_owned,
        )
}

/// "ABCD-EFGH" for an eight character code, as the web page shows it.
fn spaced(code: &str) -> String {
    if code.len() == 8 && code.is_ascii() {
        format!("{}-{}", &code[..4], &code[4..])
    } else {
        code.to_owned()
    }
}

fn is_device_secret(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

struct Code {
    device_code: String,
    expires_at_ms: u64,
    interval: Duration,
}

fn request_code(
    http: &dyn Http,
    timer: &dyn Timer,
    backend: &str,
    identity: &Identity<'_>,
    storage: Storage,
    out: &mut dyn Write,
) -> Result<Code, PairError> {
    let reply = http
        .post_json(
            &format!("{backend}{CODE_PATH}"),
            &json!({
                "client_id": CLIENT_ID,
                "hostname": identity.hostname,
                "platform": identity.platform,
                "storage": storage.as_str(),
            }),
        )
        .map_err(PairError::Unreachable)?;

    match reply.status {
        200 => {}
        404 => {
            return Err(PairError::Refused(
                "this server does not offer pairing by code".into(),
            ))
        }
        429 => {
            return Err(PairError::Refused(
                "too many attempts; wait a minute and try again".into(),
            ))
        }
        status if status >= 500 => return Err(PairError::Unreachable(describe(&reply))),
        _ => return Err(PairError::Refused(describe(&reply))),
    }

    let (Some(device_code), Some(user_code), Some(uri)) = (
        text(&reply.body, "device_code"),
        text(&reply.body, "user_code"),
        text(&reply.body, "verification_uri"),
    ) else {
        return Err(PairError::Refused(
            "the backend's answer was not a code".into(),
        ));
    };
    let expires_in = number(&reply.body, "expires_in").unwrap_or(600).min(3600);
    let interval =
        Duration::from_secs(number(&reply.body, "interval").unwrap_or(5)).max(MIN_INTERVAL);
    let complete = text(&reply.body, "verification_uri_complete").unwrap_or(uri);

    let _ = writeln!(out, "To pair this machine, open:  {uri}");
    let _ = writeln!(out, "and enter the code:          {}", spaced(user_code));
    let _ = writeln!(out, "(or open {complete} directly)");
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "Signed in as the owner, check that the machine is \"{}\" and the code matches, then approve.",
        identity.hostname
    );
    let _ = writeln!(
        out,
        "The device secret will be kept in {}.",
        storage.describe()
    );
    let _ = writeln!(out, "Waiting for approval...");

    Ok(Code {
        device_code: device_code.to_owned(),
        expires_at_ms: timer.now_ms() + expires_in * 1000,
        interval,
    })
}

/// Pairs this machine. Prints the code and the storage it will use to `out`; stores the secret in `vault` and
/// returns where it went.
pub fn pair(
    http: &dyn Http,
    timer: &dyn Timer,
    vault: &Vault<'_>,
    backend: &str,
    identity: &Identity<'_>,
    out: &mut dyn Write,
) -> Result<Paired, PairError> {
    let backend = validate_backend(backend).map_err(PairError::Refused)?;
    // Announced with the code, so the owner sees where the secret will live before approving.
    let storage = vault.probe();

    // Without Unix permissions a file cannot be kept private, so a machine with no keychain does not pair at all.
    if storage == Storage::File && !cfg!(unix) {
        return Err(PairError::Refused(
            "this system has no keychain it can use and cannot keep a secret file private".into(),
        ));
    }

    let code = request_code(http, timer, &backend, identity, storage, out)?;
    let mut interval = code.interval;
    let mut failures = 0;
    // The last poll got no answer. The backend may still have acted on it.
    let mut lost_answer = false;

    loop {
        // Never wait past the code's life: a long interval (grown by `slow_down`) must not outlast it.
        let remaining = code.expires_at_ms.saturating_sub(timer.now_ms());

        if remaining == 0 {
            return Err(PairError::Expired);
        }

        timer.sleep(interval.min(Duration::from_millis(remaining)));

        if timer.now_ms() >= code.expires_at_ms {
            return Err(PairError::Expired);
        }

        let answered = http.post_json(
            &format!("{backend}{HOST_PATH}"),
            &json!({ "client_id": CLIENT_ID, "device_code": code.device_code }),
        );
        let reply = match answered {
            Ok(reply) if reply.status != 429 && reply.status < 500 => {
                failures = 0;

                reply
            }
            Ok(reply) => {
                failures += 1;
                lost_answer = true;

                if failures > MAX_CONSECUTIVE_FAILURES {
                    return Err(PairError::Unreachable(describe(&reply)));
                }

                continue;
            }
            Err(reason) => {
                failures += 1;
                lost_answer = true;

                if failures > MAX_CONSECUTIVE_FAILURES {
                    return Err(PairError::Unreachable(reason));
                }

                continue;
            }
        };

        let after_lost_answer = std::mem::take(&mut lost_answer);

        if reply.status == 200 {
            return store(vault, &backend, storage, &reply);
        }

        match text(&reply.body, "error") {
            Some("authorization_pending") => {}
            Some("slow_down") => interval += SLOW_DOWN_STEP,
            Some("expired_token") => return Err(PairError::Expired),
            Some("invalid_grant") if after_lost_answer => {
                return Err(PairError::PossiblyRegistered)
            }
            Some("invalid_grant") => return Err(PairError::Invalid),
            // The owner's "deny" is a 400; a refusal of the account itself (no room for another device) is a 403.
            Some("access_denied") if reply.status == 403 => {
                return Err(PairError::Refused(describe(&reply)))
            }
            Some("access_denied") => return Err(PairError::Denied),
            _ => return Err(PairError::Refused(describe(&reply))),
        }
    }
}

fn store(
    vault: &Vault<'_>,
    backend: &str,
    storage: Storage,
    reply: &Reply,
) -> Result<Paired, PairError> {
    let (Some(device_id), Some(secret)) =
        (text(&reply.body, "device_id"), text(&reply.body, "secret"))
    else {
        return Err(PairError::Refused(
            "the backend's answer carried no device".into(),
        ));
    };

    if device_id.is_empty() || device_id.len() > 128 || !is_device_secret(secret) {
        return Err(PairError::Refused(
            "the backend's answer was not a device".into(),
        ));
    }

    let name = text(&reply.body, "name").unwrap_or("this machine");
    let account = text(&reply.body, "account").unwrap_or_default();

    // Where the owner was told it would go, not wherever works now: a different place needs a new code, which
    // shows its own choice.
    vault
        .save(
            &NewPairing {
                account,
                backend,
                device_id,
                name,
                secret,
            },
            storage,
        )
        .map_err(|reason| PairError::NotStored {
            device_id: device_id.to_owned(),
            reason,
        })?;

    Ok(Paired {
        account: account.to_owned(),
        device_id: device_id.to_owned(),
        name: name.to_owned(),
        storage,
    })
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;

    use super::super::vault::tests::{temp_dir, FakeKeychain};
    use super::*;

    const SECRET: &str = concat!(
        "fedcba9876543210",
        "fedcba9876543210",
        "fedcba9876543210",
        "fedcba9876543210"
    );

    /// Plays a backend: the code answer first, then one scripted answer per poll.
    struct FakeBackend {
        code: Reply,
        polls: RefCell<VecDeque<Result<Reply, String>>>,
        requests: RefCell<Vec<(String, Value)>>,
    }

    impl FakeBackend {
        fn new(polls: Vec<Result<Reply, String>>) -> Self {
            FakeBackend {
                code: reply(
                    200,
                    json!({
                        "device_code": "dc-1",
                        "expires_in": 1800,
                        "interval": 5,
                        "user_code": "ABCD2345",
                        "verification_uri": "https://neore.ai/auth/device",
                        "verification_uri_complete": "https://neore.ai/auth/device?user_code=ABCD2345",
                    }),
                ),
                polls: RefCell::new(polls.into()),
                requests: RefCell::default(),
            }
        }
    }

    impl Http for FakeBackend {
        fn post_json(&self, url: &str, body: &Value) -> Result<Reply, String> {
            self.requests
                .borrow_mut()
                .push((url.to_owned(), body.clone()));

            if url.ends_with(CODE_PATH) {
                return Ok(self.code.clone());
            }

            self.polls
                .borrow_mut()
                .pop_front()
                .expect("polled more often than scripted")
        }
    }

    fn reply(status: u16, body: Value) -> Reply {
        Reply { status, body }
    }

    fn pending() -> Result<Reply, String> {
        Ok(reply(400, json!({ "error": "authorization_pending" })))
    }

    fn approved() -> Result<Reply, String> {
        Ok(reply(
            200,
            json!({ "account": "o***@example.com", "device_id": "device-9", "name": "build-box", "secret": SECRET, "token_type": "device_secret" }),
        ))
    }

    /// A clock that only moves when the flow sleeps.
    #[derive(Default)]
    struct FakeTimer {
        now: Cell<u64>,
        slept: RefCell<Vec<Duration>>,
    }

    impl Timer for FakeTimer {
        fn now_ms(&self) -> u64 {
            self.now.get()
        }

        fn sleep(&self, duration: Duration) {
            self.now.set(self.now.get() + duration.as_millis() as u64);
            self.slept.borrow_mut().push(duration);
        }
    }

    fn run(
        backend: &FakeBackend,
        keychain: &FakeKeychain,
        label: &str,
    ) -> (Result<Paired, PairError>, String, FakeTimer) {
        let timer = FakeTimer::default();
        let vault = Vault::new(temp_dir(label), keychain);
        let mut out = Vec::new();
        let outcome = pair(
            backend,
            &timer,
            &vault,
            "https://neore.ai/",
            &Identity {
                hostname: "build-box",
                platform: "linux",
            },
            &mut out,
        );

        (outcome, String::from_utf8(out).unwrap(), timer)
    }

    #[test]
    fn shows_the_code_and_the_storage_then_stores_what_the_approved_poll_returns() {
        let backend = FakeBackend::new(vec![pending(), pending(), approved()]);
        let keychain = FakeKeychain::default();
        let (outcome, shown, timer) = run(&backend, &keychain, "happy");
        let paired = outcome.unwrap();

        assert_eq!(paired.device_id, "device-9");
        assert_eq!(paired.storage, Storage::Keychain);
        assert_eq!(paired.account, "o***@example.com");
        assert_eq!(
            keychain
                .entries
                .borrow()
                .get("https://neore.ai|device-9")
                .map(String::as_str),
            Some(SECRET)
        );

        // What the person is told, before and after approval.
        assert!(shown.contains("ABCD-2345"), "{shown}");
        assert!(shown.contains("https://neore.ai/auth/device"));
        assert!(shown.contains("operating system keychain"));
        assert!(!shown.contains(SECRET));

        // The code request announces where the secret will live; each poll names the code and the client.
        let requests = backend.requests.borrow();

        assert_eq!(requests[0].0, "https://neore.ai/api/auth/device/code");
        assert_eq!(
            requests[0].1,
            json!({ "client_id": "neore-host", "hostname": "build-box", "platform": "linux", "storage": "keychain" })
        );
        assert_eq!(requests[1].0, "https://neore.ai/api/auth/device/host");
        assert_eq!(
            requests[1].1,
            json!({ "client_id": "neore-host", "device_code": "dc-1" })
        );
        assert_eq!(timer.slept.borrow().len(), 3);
    }

    #[cfg(unix)]
    #[test]
    fn announces_the_file_when_the_keychain_cannot_be_used() {
        let backend = FakeBackend::new(vec![approved()]);
        let keychain = FakeKeychain {
            broken: true,
            ..FakeKeychain::default()
        };
        let (outcome, shown, _) = run(&backend, &keychain, "file");
        let paired = outcome.unwrap();

        assert_eq!(paired.storage, Storage::File);
        assert_eq!(backend.requests.borrow()[0].1["storage"], json!("file"));
        assert!(shown.contains("a file only you can read"));
    }

    #[test]
    fn slow_down_widens_the_interval_for_every_later_poll() {
        let backend = FakeBackend::new(vec![
            Ok(reply(400, json!({ "error": "slow_down" }))),
            pending(),
            approved(),
        ]);
        let (outcome, _, timer) = run(&backend, &FakeKeychain::default(), "slow");

        assert!(outcome.is_ok());
        assert_eq!(
            *timer.slept.borrow(),
            vec![
                Duration::from_secs(5),
                Duration::from_secs(10),
                Duration::from_secs(10)
            ]
        );
    }

    #[test]
    fn a_denied_code_stores_nothing() {
        let backend = FakeBackend::new(vec![Ok(reply(400, json!({ "error": "access_denied" })))]);
        let keychain = FakeKeychain::default();
        let (outcome, _, _) = run(&backend, &keychain, "denied");

        assert_eq!(outcome, Err(PairError::Denied));
        assert!(keychain.entries.borrow().is_empty());
    }

    #[test]
    fn an_account_refusal_is_reported_with_its_reason() {
        let backend = FakeBackend::new(vec![Ok(reply(
            403,
            json!({ "error": "access_denied", "error_description": "At most 10 devices can be paired. Remove one first." }),
        ))]);
        let (outcome, _, _) = run(&backend, &FakeKeychain::default(), "full");

        assert_eq!(
            outcome,
            Err(PairError::Refused(
                "At most 10 devices can be paired. Remove one first.".into()
            ))
        );
    }

    #[test]
    fn expiry_and_a_used_code_end_the_flow() {
        let expired = FakeBackend::new(vec![Ok(reply(400, json!({ "error": "expired_token" })))]);
        let used = FakeBackend::new(vec![Ok(reply(400, json!({ "error": "invalid_grant" })))]);

        assert_eq!(
            run(&expired, &FakeKeychain::default(), "expired").0,
            Err(PairError::Expired)
        );
        assert_eq!(
            run(&used, &FakeKeychain::default(), "used").0,
            Err(PairError::Invalid)
        );
    }

    #[test]
    fn gives_up_when_the_code_lapses_without_an_answer() {
        // 1800 s at a 5 s interval is 360 polls; none ever approves.
        let backend = FakeBackend::new((0..400).map(|_| pending()).collect());
        let (outcome, _, _) = run(&backend, &FakeKeychain::default(), "lapse");

        assert_eq!(outcome, Err(PairError::Expired));
    }

    #[test]
    fn a_few_transport_failures_are_ridden_out_but_not_forever() {
        let flaky = FakeBackend::new(vec![
            Err("timed out".into()),
            Ok(reply(429, Value::Null)),
            approved(),
        ]);

        assert!(run(&flaky, &FakeKeychain::default(), "flaky").0.is_ok());

        let dead = FakeBackend::new(
            (0..10)
                .map(|_| Err("connection refused".to_owned()))
                .collect(),
        );

        assert_eq!(
            run(&dead, &FakeKeychain::default(), "dead").0,
            Err(PairError::Unreachable("connection refused".into()))
        );
    }

    #[test]
    fn a_used_code_after_a_lost_answer_says_the_machine_may_be_registered() {
        let backend = FakeBackend::new(vec![
            Err("timed out".into()),
            Ok(reply(400, json!({ "error": "invalid_grant" }))),
        ]);
        let (outcome, _, _) = run(&backend, &FakeKeychain::default(), "lost-answer");

        assert_eq!(outcome, Err(PairError::PossiblyRegistered));
        assert!(PairError::PossiblyRegistered
            .to_string()
            .contains("Settings, Devices"));
    }

    #[test]
    fn never_sleeps_past_the_codes_life() {
        // Every poll says slow_down, so the interval keeps growing; the code lives 1800 s.
        let backend = FakeBackend::new(
            (0..400)
                .map(|_| Ok(reply(400, json!({ "error": "slow_down" }))))
                .collect(),
        );
        let (outcome, _, timer) = run(&backend, &FakeKeychain::default(), "bound");
        let total: Duration = timer.slept.borrow().iter().sum();

        assert_eq!(outcome, Err(PairError::Expired));
        assert_eq!(total, Duration::from_secs(1800));
    }

    #[test]
    fn refuses_an_insecure_backend_before_sending_anything() {
        for address in [
            "http://neore.example",
            "http://localhost:8788",
            "http://127.0.0.1:8788",
        ] {
            let backend = FakeBackend::new(vec![]);
            let timer = FakeTimer::default();
            let keychain = FakeKeychain::default();
            let vault = Vault::new(temp_dir("insecure"), &keychain);
            let outcome = pair(
                &backend,
                &timer,
                &vault,
                address,
                &Identity {
                    hostname: "x",
                    platform: "linux",
                },
                &mut Vec::new(),
            );

            assert!(matches!(outcome, Err(PairError::Refused(_))), "{address}");
            assert!(backend.requests.borrow().is_empty(), "{address}");
        }
    }

    #[test]
    fn an_answer_that_is_not_a_device_is_not_stored() {
        for body in [
            json!({ "device_id": "d", "secret": "short" }),
            json!({ "device_id": "d", "secret": SECRET.to_uppercase() }),
            json!({ "secret": SECRET }),
            json!({ "device_id": "", "secret": SECRET }),
        ] {
            let backend = FakeBackend::new(vec![Ok(reply(200, body))]);
            let keychain = FakeKeychain::default();
            let (outcome, _, _) = run(&backend, &keychain, "bad-device");

            assert!(matches!(outcome, Err(PairError::Refused(_))));
            assert!(keychain.entries.borrow().is_empty());
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_unstorable_secret_names_the_device_to_remove() {
        // The vault dir is a file, so neither the keychain (broken) nor the fallback can hold the secret.
        let blocker = temp_dir("blocker");
        std::fs::write(&blocker, "x").unwrap();

        let backend = FakeBackend::new(vec![approved()]);
        let keychain = FakeKeychain {
            broken: true,
            ..FakeKeychain::default()
        };
        let vault = Vault::new(blocker.join("inside"), &keychain);
        let outcome = pair(
            &backend,
            &FakeTimer::default(),
            &vault,
            "https://neore.ai",
            &Identity {
                hostname: "x",
                platform: "linux",
            },
            &mut Vec::new(),
        );
        let message = outcome.unwrap_err().to_string();

        assert!(message.contains("device-9"), "{message}");
        assert!(message.contains("Remove that device"));
        assert!(!message.contains(SECRET));
    }
}
