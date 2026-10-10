//! Sign-in through the SYSTEM browser, for providers that refuse embedded
//! webviews (Google answers `disallowed_useragent`).
//!
//! It reuses the backend's one-time-code PKCE grant (RFC 7636) built for the
//! Firefox extension — `backend/lunora/auth/extension-grant.ts` — with the
//! redirect URI `neore://auth/callback`:
//!
//! 1. The shell makes a verifier, a challenge and a `state`, and opens
//!    `<site>/auth/extension?client=native&…` in the default browser.
//! 2. The user signs in there (Google works: it is a real browser) and
//!    approves; the page redirects to `neore://auth/callback?code=…&state=…`.
//! 3. The OS hands that URL back to this app (`on_open_url`). The `state` must
//!    match the ONE flow this process started, or the callback is dropped.
//! 4. The shell gives `{ code, codeVerifier, redirectUri }` to the page in the
//!    main window (`take_pending_sign_in`), which posts it to the app's own
//!    `/api/auth/client-grant/cookie`; that exchanges the code and sets the
//!    session cookie on the app origin — the same cookie a browser sign-in sets.
//!
//! A custom scheme is not exclusive: another app can register `neore://` too.
//! That is exactly the interception PKCE exists for (RFC 8252 §8.1) — a stolen
//! code is useless without the verifier, which never leaves this process until
//! the callback it belongs to arrives.

use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};
use url::Url;

pub const REDIRECT_URI: &str = "neore://auth/callback";

/// How long the shell waits for the browser to come back. The backend's code
/// itself lives one minute; this covers the user signing in first.
pub const SIGN_IN_TTL: Duration = Duration::from_secs(15 * 60);

pub struct PendingSignIn {
    state: String,
    verifier: String,
    started: Instant,
}

/// What the page needs to finish the exchange; field names match the backend body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInHandoff {
    pub code: String,
    pub code_verifier: String,
    pub redirect_uri: String,
}

fn random_token(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).expect("the OS random source is unavailable");

    URL_SAFE_NO_PAD.encode(buffer)
}

/// RFC 7636 S256: BASE64URL(SHA-256(ASCII(code_verifier))).
pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Starts a flow, replacing any earlier one: only the latest browser tab can finish.
pub fn begin(origin: &Url) -> (PendingSignIn, Url) {
    // 32 bytes → 43 base64url characters, the RFC 7636 minimum length.
    let pending = PendingSignIn {
        state: random_token(16),
        verifier: random_token(32),
        started: Instant::now(),
    };

    let mut url = origin.join("auth/extension").expect("static path joins");
    url.query_pairs_mut()
        .append_pair("client", "native")
        .append_pair("code_challenge", &pkce_challenge(&pending.verifier))
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("state", &pending.state);

    (pending, url)
}

/// Base64url of the shape the backend and `begin` produce; anything else is refused.
fn is_token(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `neore://auth/callback?code=…&state=…` → `(code, state)`.
pub fn parse_callback(link: &Url) -> Option<(String, String)> {
    if link.scheme() != "neore" || link.host_str() != Some("auth") || link.path() != "/callback" {
        return None;
    }

    let value = |key: &str| {
        link.query_pairs()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
    };
    let (code, state) = (value("code")?, value("state")?);

    (is_token(&code) && is_token(&state)).then_some((code, state))
}

/// Matches a callback against the pending flow. Consumes the flow either way,
/// so a wrong or replayed `state` cannot be retried against it.
pub fn complete(
    pending: Option<PendingSignIn>,
    code: String,
    state: &str,
    now: Instant,
) -> Result<SignInHandoff, &'static str> {
    let pending = pending.ok_or("no sign-in in progress")?;

    if now.duration_since(pending.started) > SIGN_IN_TTL {
        return Err("the sign-in took too long; start it again");
    }

    // Both sides are ours and random; no timing concern, but no early exit either.
    let matches = pending.state.len() == state.len()
        && pending
            .state
            .bytes()
            .zip(state.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0;

    if !matches {
        return Err("the sign-in callback does not belong to this app's request");
    }

    Ok(SignInHandoff {
        code,
        code_verifier: pending.verifier,
        redirect_uri: REDIRECT_URI.to_owned(),
    })
}

/// Hosts whose sign-in page refuses embedded webviews. A navigation to one is
/// cancelled and the flow above starts instead.
pub fn is_blocked_oauth_host(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("accounts.google.com")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin() -> Url {
        Url::parse("https://app.example.com").unwrap()
    }

    fn query(url: &Url, key: &str) -> String {
        url.query_pairs()
            .find(|(k, _)| k == key)
            .unwrap()
            .1
            .into_owned()
    }

    #[test]
    fn challenge_matches_rfc_7636_appendix_b() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn begin_opens_the_grant_page_with_a_matching_challenge() {
        let (pending, url) = begin(&origin());

        assert_eq!(url.path(), "/auth/extension");
        assert_eq!(query(&url, "client"), "native");
        assert_eq!(query(&url, "redirect_uri"), REDIRECT_URI);
        assert_eq!(query(&url, "state"), pending.state);
        assert_eq!(
            query(&url, "code_challenge"),
            pkce_challenge(&pending.verifier)
        );
        assert_eq!(pending.verifier.len(), 43);
        // The verifier itself never goes into the URL.
        assert!(!url.as_str().contains(&pending.verifier));
    }

    #[test]
    fn every_flow_is_fresh() {
        let (a, _) = begin(&origin());
        let (b, _) = begin(&origin());

        assert_ne!(a.state, b.state);
        assert_ne!(a.verifier, b.verifier);
    }

    #[test]
    fn parses_only_well_formed_callbacks() {
        let code = "c".repeat(43);
        let state = "s".repeat(22);
        let link = |raw: &str| Url::parse(raw).unwrap();

        assert_eq!(
            parse_callback(&link(&format!(
                "neore://auth/callback?code={code}&state={state}"
            ))),
            Some((code.clone(), state.clone()))
        );
        assert_eq!(
            parse_callback(&link(&format!("neore://auth/callback?code={code}"))),
            None
        );
        assert_eq!(
            parse_callback(&link(&format!(
                "neore://auth/other?code={code}&state={state}"
            ))),
            None
        );
        assert_eq!(
            parse_callback(&link(&format!(
                "neore://auth/callback?code=a%20b&state={state}"
            ))),
            None
        );
        assert_eq!(
            parse_callback(&link(&format!(
                "https://auth/callback?code={code}&state={state}"
            ))),
            None
        );
    }

    #[test]
    fn completes_with_the_verifier_only_for_the_matching_state() {
        let (pending, _) = begin(&origin());
        let state = pending.state.clone();
        let verifier = pending.verifier.clone();

        let handoff = complete(Some(pending), "code".into(), &state, Instant::now()).unwrap();

        assert_eq!(
            handoff,
            SignInHandoff {
                code: "code".into(),
                code_verifier: verifier,
                redirect_uri: REDIRECT_URI.into()
            }
        );
    }

    #[test]
    fn refuses_a_foreign_state_a_missing_flow_and_an_expired_one() {
        let (pending, _) = begin(&origin());

        assert!(complete(
            Some(pending),
            "code".into(),
            "someone-elses-state",
            Instant::now()
        )
        .is_err());
        assert!(complete(None, "code".into(), "state", Instant::now()).is_err());

        let (pending, _) = begin(&origin());
        let state = pending.state.clone();
        let later = pending.started + SIGN_IN_TTL + Duration::from_secs(1);

        assert!(complete(Some(pending), "code".into(), &state, later).is_err());
    }

    #[test]
    fn handoff_serialises_as_the_backend_body() {
        let handoff = SignInHandoff {
            code: "c".into(),
            code_verifier: "v".into(),
            redirect_uri: REDIRECT_URI.into(),
        };

        assert_eq!(
            serde_json::to_string(&handoff).unwrap(),
            r#"{"code":"c","codeVerifier":"v","redirectUri":"neore://auth/callback"}"#
        );
    }

    #[test]
    fn intercepts_only_google_sign_in() {
        assert!(is_blocked_oauth_host(
            &Url::parse("https://accounts.google.com/o/oauth2/v2/auth?x=1").unwrap()
        ));
        assert!(!is_blocked_oauth_host(
            &Url::parse("https://github.com/login/oauth/authorize").unwrap()
        ));
    }
}
