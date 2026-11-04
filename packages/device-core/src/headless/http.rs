//! The one outbound request shape pairing needs: a JSON POST with a deadline. A trait, so the handshake is tested
//! against a fake backend and no test touches a network.

use std::time::Duration;

use serde_json::Value;

/// Every request has a deadline: pairing runs on a person's terminal and must not hang on a dead connection.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Answers larger than this are not a pairing answer.
const MAX_BODY_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub status: u16,
    /// `Value::Null` when the body was empty or not JSON.
    pub body: Value,
}

pub trait Http {
    /// A transport failure (no connection, timeout) is `Err`; any answer, an error status included, is `Ok`.
    fn post_json(&self, url: &str, body: &Value) -> Result<Reply, String>;
}

/// Set to `1` to pair against a plain-http loopback backend. Honoured by debug builds only: a release build never
/// reads it, so a packaged `neore-host` cannot be told to send the secret unencrypted.
pub const DEV_INSECURE_LOOPBACK_VAR: &str = "NEORE_HOST_DEV_INSECURE_LOOPBACK";

fn dev_insecure_loopback() -> bool {
    cfg!(debug_assertions) && std::env::var(DEV_INSECURE_LOOPBACK_VAR).as_deref() == Ok("1")
}

/// Where the backend may be reached. The secret crosses this connection, so it is `https`, always. The one
/// exception is a loopback address over plain http for local development, refused unless the debug-build-only
/// flag above is set. Returns the origin without a trailing slash.
pub fn validate_backend(raw: &str) -> Result<String, String> {
    validate_backend_with(raw, dev_insecure_loopback())
}

fn validate_backend_with(raw: &str, dev_loopback: bool) -> Result<String, String> {
    let url = raw.trim().trim_end_matches('/');
    let (scheme, rest) = url
        .split_once("://")
        .ok_or("the backend address must start with https://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();

    // Callers append `/api/auth/...`, so a path (or query) would build a wrong endpoint and be saved as the backend.
    if authority.is_empty() || authority.contains('@') || rest != authority {
        return Err("the backend address must be an origin, such as https://neore.ai".into());
    }

    let host = if let Some(bracketed) = authority.strip_prefix('[') {
        bracketed.split(']').next().unwrap_or_default()
    } else {
        authority.split(':').next().unwrap_or_default()
    };
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1");

    // A loopback address is a development backend: refused whatever the scheme, unless the debug-only flag is set.
    if loopback && !dev_loopback {
        return Err(
            "the backend address is this machine itself; that is only for development builds"
                .into(),
        );
    }

    match scheme {
        "https" => Ok(url.to_owned()),
        "http" if loopback => Ok(url.to_owned()),
        _ => Err("the device secret is sent over this connection, so the backend address must be https://".into()),
    }
}

pub struct UreqHttp {
    agent: ureq::Agent,
}

impl UreqHttp {
    pub fn new() -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(REQUEST_TIMEOUT))
            // A redirect could carry the poll (and so the secret's answer) to another host.
            .max_redirects(0)
            .http_status_as_error(false)
            .build();

        UreqHttp {
            agent: config.into(),
        }
    }
}

impl Default for UreqHttp {
    fn default() -> Self {
        Self::new()
    }
}

impl Http for UreqHttp {
    fn post_json(&self, url: &str, body: &Value) -> Result<Reply, String> {
        let mut response = self
            .agent
            .post(url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .send(body.to_string())
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .with_config()
            .limit(MAX_BODY_BYTES)
            .read_to_string()
            .unwrap_or_default();

        Ok(Reply {
            status,
            body: serde_json::from_str(&text).unwrap_or(Value::Null),
        })
    }
}

#[cfg(test)]
#[path = "http_tests.rs"]
mod tests;
