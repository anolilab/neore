//! The device wire format — the Rust half of `backend/lunora/devices/lib/signing.ts`.
//!
//! Everything that crosses the page is a JSON `payload` STRING plus
//! `hex(HMAC-SHA256(secret, "neore-device:<domain>:v1\n" + payload))`. The
//! verifier checks the exact bytes it received and only then parses them, so
//! neither side needs canonical JSON. The page relays envelopes but cannot
//! invent, alter or replay one: the signature, the device id, the expiry and a
//! one-time nonce are all checked here.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::hmac::{constant_time_eq, hmac_sha256, to_hex};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Domain {
    Call,
    Result,
    Manifest,
    /// Where a call is on this device (`prompting` / `running`), for the chat.
    Progress,
}

impl Domain {
    fn prefix(self) -> &'static str {
        match self {
            Domain::Call => "neore-device:call:v1\n",
            Domain::Result => "neore-device:result:v1\n",
            Domain::Manifest => "neore-device:manifest:v1\n",
            Domain::Progress => "neore-device:progress:v1\n",
        }
    }
}

pub fn sign(secret: &str, domain: Domain, payload: &str) -> String {
    let mut message = String::with_capacity(domain.prefix().len() + payload.len());

    message.push_str(domain.prefix());
    message.push_str(payload);

    to_hex(&hmac_sha256(secret.as_bytes(), message.as_bytes()))
}

pub fn verify(secret: &str, domain: Domain, payload: &str, signature: &str) -> bool {
    constant_time_eq(
        sign(secret, domain, payload).as_bytes(),
        signature.as_bytes(),
    )
}

/// A payload and its signature, as the page relays them.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Signed {
    pub payload: String,
    pub signature: String,
}

/// A call the backend signed for this device.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallEnvelope {
    pub call_id: String,
    pub device_id: String,
    pub expires_at: u64,
    #[serde(default)]
    pub input: Value,
    pub kind: String,
    pub nonce: String,
    #[serde(default)]
    pub tainted_by: Vec<String>,
    #[serde(default)]
    pub thread_title: String,
    pub tool: String,
    pub v: u8,
}

/// Envelopes further ahead than this are refused — the backend never issues
/// one past its 5-minute deadline; the rest is clock skew.
pub const MAX_ENVELOPE_AHEAD_MS: u64 = 15 * 60 * 1000;

/// Nonces seen, kept until their envelope would have expired anyway.
#[derive(Default)]
pub struct NonceSet(HashMap<String, u64>);

impl NonceSet {
    /// `false` when the nonce was already used (a replay).
    pub fn insert(&mut self, nonce: &str, expires_at: u64, now: u64) -> bool {
        self.0.retain(|_, expiry| *expiry > now);

        if self.0.contains_key(nonce) {
            return false;
        }

        self.0.insert(nonce.to_owned(), expires_at);

        true
    }
}

pub fn verify_call(
    secret: &str,
    device_id: &str,
    signed: &Signed,
    now: u64,
    nonces: &mut NonceSet,
) -> Result<CallEnvelope, String> {
    if !verify(secret, Domain::Call, &signed.payload, &signed.signature) {
        return Err("the request is not signed for this device".into());
    }

    let call: CallEnvelope =
        serde_json::from_str(&signed.payload).map_err(|_| "the request is malformed")?;

    if call.v != 1 || call.kind != "call" || call.device_id != device_id {
        return Err("the request is not for this device".into());
    }

    if call.expires_at <= now {
        return Err("the request has expired".into());
    }

    if call.expires_at > now + MAX_ENVELOPE_AHEAD_MS {
        return Err("the request expires too far ahead".into());
    }

    if call.nonce.is_empty() || !nonces.insert(&call.nonce, call.expires_at, now) {
        return Err("the request was already used".into());
    }

    Ok(call)
}

pub fn sign_value(secret: &str, domain: Domain, value: &Value) -> Signed {
    let payload = value.to_string();
    let signature = sign(secret, domain, &payload);

    Signed { payload, signature }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// Shared with `backend/lunora/devices/lib/signing.test.ts`.
    #[test]
    fn matches_the_backend_vectors() {
        assert_eq!(
            sign(SECRET, Domain::Call, r#"{"v":1,"kind":"call"}"#),
            "1b5fba44e5ec8d6a71b4b7d5b471382b89ca9b147ab0cf28976e9e7756a73ef6"
        );
        assert_eq!(
            sign(SECRET, Domain::Result, r#"{"v":1,"kind":"result"}"#),
            "daa229ed46e84f7169dea3c844bd5e85f69954c9c8dbf8e602d2e6bdee544925"
        );
        assert_eq!(
            sign(SECRET, Domain::Manifest, r#"{"v":1,"kind":"manifest"}"#),
            "594692da0c9e03e5b885fcecd59e21c8f9cc61c2bf6ca11f75da1ace7da8687f"
        );
        assert_eq!(
            sign(SECRET, Domain::Progress, r#"{"v":1,"kind":"progress"}"#),
            "11754e18ca1e841537e220af075d8908a42cb8bca86d8f0f133068e3a5d479c0"
        );
    }

    fn envelope(overrides: Value) -> Signed {
        let mut base = json!({
            "v": 1, "kind": "call", "callId": "c1", "deviceId": "dev1", "tool": "fs_read",
            "input": { "path": "a.txt" }, "threadId": "t1", "threadTitle": "T",
            "taintedBy": [], "issuedAt": 1_000, "expiresAt": 10_000, "nonce": "n1"
        });

        for (key, value) in overrides.as_object().unwrap() {
            base[key] = value.clone();
        }

        sign_value(SECRET, Domain::Call, &base)
    }

    #[test]
    fn accepts_a_fresh_envelope_once() {
        let mut nonces = NonceSet::default();
        let signed = envelope(json!({}));

        let call = verify_call(SECRET, "dev1", &signed, 2_000, &mut nonces).unwrap();
        assert_eq!(call.tool, "fs_read");
        assert!(verify_call(SECRET, "dev1", &signed, 2_000, &mut nonces).is_err());
    }

    #[test]
    fn refuses_a_forged_or_altered_envelope() {
        let mut nonces = NonceSet::default();
        let mut signed = envelope(json!({}));

        signed.payload = signed.payload.replace("a.txt", "b.txt");
        assert!(verify_call(SECRET, "dev1", &signed, 2_000, &mut nonces).is_err());

        let other = sign_value(
            &"f".repeat(64),
            Domain::Call,
            &serde_json::from_str(&envelope(json!({})).payload).unwrap(),
        );
        assert!(verify_call(SECRET, "dev1", &other, 2_000, &mut nonces).is_err());
    }

    #[test]
    fn refuses_a_result_signature_replayed_as_a_call() {
        let mut nonces = NonceSet::default();
        let call = envelope(json!({}));
        let as_result = Signed {
            signature: sign(SECRET, Domain::Result, &call.payload),
            payload: call.payload,
        };

        assert!(verify_call(SECRET, "dev1", &as_result, 2_000, &mut nonces).is_err());
    }

    #[test]
    fn refuses_another_device_expired_and_far_future_envelopes() {
        let mut nonces = NonceSet::default();

        assert!(verify_call(SECRET, "dev2", &envelope(json!({})), 2_000, &mut nonces).is_err());
        assert!(verify_call(
            SECRET,
            "dev1",
            &envelope(json!({ "nonce": "n2" })),
            10_000,
            &mut nonces
        )
        .is_err());
        assert!(verify_call(
            SECRET,
            "dev1",
            &envelope(json!({ "nonce": "n3", "expiresAt": 2_000 + MAX_ENVELOPE_AHEAD_MS + 1 })),
            2_000,
            &mut nonces
        )
        .is_err());
    }
}
