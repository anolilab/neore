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

/// The bounds on the poll interval, whatever the server says: a huge one would only stall the person, and `slow_down`
/// growing it must never overflow.
const MIN_INTERVAL: Duration = Duration::from_secs(1);
const MAX_INTERVAL: Duration = Duration::from_secs(60);

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
    /// The code could not be shown, so nobody could approve it.
    Output(String),
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
            PairError::Output(reason) => write!(
                formatter,
                "the pairing code could not be shown ({reason}); nothing was paired"
            ),
            PairError::Unreachable(reason) => write!(formatter, "the backend could not be reached: {reason}"),
        }
    }
}

impl std::error::Error for PairError {}

impl PairError {
    /// The process exit code, documented in `neore-host pair --help`: a script can tell a final answer (do not
    /// retry) from an unreachable backend (retry with a pause) without reading the message.
    pub fn exit_code(&self) -> u8 {
        match self {
            PairError::Denied => 3,
            PairError::Expired => 4,
            PairError::Invalid => 5,
            PairError::Refused(_) => 6,
            PairError::Unreachable(_) => 7,
            PairError::NotStored { .. } | PairError::PossiblyRegistered => 8,
            PairError::Output(_) => 1,
        }
    }
}

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
    let interval = Duration::from_secs(number(&reply.body, "interval").unwrap_or(5))
        .clamp(MIN_INTERVAL, MAX_INTERVAL);
    let complete = text(&reply.body, "verification_uri_complete").unwrap_or(uri);

    // One write, flushed: if the person cannot be shown the code, no approval can come, so do not wait for one.
    let shown = format!(
        "To pair this machine, open:  {uri}\nand enter the code:          {}\n(or open {complete} directly)\n\nSigned in as the owner, check that the machine is \"{}\" and the code matches, then approve.\nThe device secret will be kept in {}.\nWaiting for approval...\n",
        spaced(user_code),
        identity.hostname,
        storage.describe()
    );

    out.write_all(shown.as_bytes())
        .and_then(|()| out.flush())
        .map_err(|error| PairError::Output(error.to_string()))?;

    Ok(Code {
        device_code: device_code.to_owned(),
        expires_at_ms: timer.now_ms().saturating_add(expires_in * 1000),
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
            Some("slow_down") => {
                interval = interval.saturating_add(SLOW_DOWN_STEP).min(MAX_INTERVAL)
            }
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
#[path = "pair_tests.rs"]
mod tests;
