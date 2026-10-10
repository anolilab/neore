//! The deployment this shell wraps, and every URL derived from it.
//!
//! The origin is fixed at COMPILE time (`NEORE_SITE_URL`). It is also the only
//! origin granted IPC (see `lib.rs`), so a runtime override would let whoever
//! controls the environment point an IPC-capable window at another site.

use url::Url;

/// `native:dev` compiles against the local Vite server. `build.rs` refuses a
/// release build without an explicit origin, so this fallback never ships.
const DEFAULT_SITE_URL: &str = "http://localhost:5173";

pub fn site_origin() -> Url {
    let raw = option_env!("NEORE_SITE_URL").unwrap_or(DEFAULT_SITE_URL);
    let url = Url::parse(raw).expect("NEORE_SITE_URL must be an absolute URL");

    origin_of(&url).expect("NEORE_SITE_URL must be an http(s) origin")
}

/// Strips path, query and fragment. `None` for anything but http(s).
fn origin_of(url: &Url) -> Option<Url> {
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }

    let mut origin = url.clone();
    origin.set_path("/");
    origin.set_query(None);
    origin.set_fragment(None);

    Some(origin)
}

/// The URLPattern a remote capability matches: every path on the origin.
pub fn remote_pattern(origin: &Url) -> String {
    format!("{}*", origin.as_str())
}

pub fn is_same_origin(origin: &Url, url: &Url) -> bool {
    url.origin() == origin.origin()
}

pub fn new_chat_url(origin: &Url) -> Url {
    origin.join("chat").expect("static path joins")
}

/// Thread ids are Lunora document ids. Anything else in a deep link is refused
/// rather than escaped, so a link can never smuggle a path, query or `..`.
fn is_valid_thread_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn thread_url(origin: &Url, id: &str) -> Option<Url> {
    if !is_valid_thread_id(id) || id == "default" {
        return None;
    }

    origin.join(&format!("chat/{id}")).ok()
}

/// Hard cap on text arriving from outside the app (deep links, share sheet).
pub const MAX_COMPOSE_CHARS: usize = 32_000;

pub fn clamp_text(text: &str, max_chars: usize) -> String {
    text.trim().chars().take(max_chars).collect()
}

#[derive(Debug, PartialEq, Eq)]
pub enum DeepLink {
    /// `neore://thread/<id>` — open that thread in the main window.
    Open(Url),
    /// `neore://new?text=…` — prefill a new chat (also what a share lands as).
    Compose(String),
    /// `neore://` or `neore://new` — just bring the app forward.
    Focus,
}

pub const SCHEME: &str = "neore";

/// Maps an incoming `neore://` URL onto an action. Anything unrecognised is
/// `None` and ignored — a deep link is untrusted input from any other app.
pub fn parse_deep_link(origin: &Url, link: &Url) -> Option<DeepLink> {
    if link.scheme() != SCHEME {
        return None;
    }

    let segments: Vec<&str> = link
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();

    match (link.host_str(), segments.as_slice()) {
        (Some("thread"), [id]) => thread_url(origin, id).map(DeepLink::Open),
        (Some("new"), []) => {
            let text = link
                .query_pairs()
                .find(|(key, _)| key == "text")
                .map(|(_, value)| clamp_text(&value, MAX_COMPOSE_CHARS));

            Some(match text {
                Some(text) if !text.is_empty() => DeepLink::Compose(text),
                _ => DeepLink::Focus,
            })
        }
        (None | Some(""), []) => Some(DeepLink::Focus),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin() -> Url {
        Url::parse("https://app.example.com").unwrap()
    }

    fn parse(link: &str) -> Option<DeepLink> {
        parse_deep_link(&origin(), &Url::parse(link).unwrap())
    }

    #[test]
    fn origin_drops_path_query_and_fragment() {
        let url = Url::parse("https://app.example.com:8443/chat?x=1#y").unwrap();

        assert_eq!(
            origin_of(&url).unwrap().as_str(),
            "https://app.example.com:8443/"
        );
        assert!(origin_of(&Url::parse("file:///etc/passwd").unwrap()).is_none());
    }

    #[test]
    fn remote_pattern_covers_the_whole_origin() {
        assert_eq!(remote_pattern(&origin()), "https://app.example.com/*");
        assert_eq!(
            remote_pattern(&Url::parse("http://localhost:5173").unwrap()),
            "http://localhost:5173/*"
        );
    }

    #[test]
    fn opens_a_thread() {
        assert_eq!(
            parse("neore://thread/abc_123-X"),
            Some(DeepLink::Open(
                Url::parse("https://app.example.com/chat/abc_123-X").unwrap()
            ))
        );
        assert_eq!(
            parse("neore://thread/abc/"),
            Some(DeepLink::Open(
                Url::parse("https://app.example.com/chat/abc").unwrap()
            ))
        );
    }

    #[test]
    fn refuses_thread_ids_that_are_not_ids() {
        assert_eq!(parse("neore://thread/..%2F..%2Fadmin"), None);
        assert_eq!(parse("neore://thread/a/b"), None);
        assert_eq!(parse("neore://thread/default"), None);
        assert_eq!(parse("neore://thread/"), None);
        assert_eq!(parse(&format!("neore://thread/{}", "a".repeat(129))), None);
    }

    #[test]
    fn composes_from_text() {
        assert_eq!(
            parse("neore://new?text=hello%20world"),
            Some(DeepLink::Compose("hello world".into()))
        );
        assert_eq!(parse("neore://new?text=%20%20"), Some(DeepLink::Focus));
        assert_eq!(parse("neore://new"), Some(DeepLink::Focus));
        assert_eq!(parse("neore://"), Some(DeepLink::Focus));
    }

    #[test]
    fn ignores_other_schemes_and_hosts() {
        assert_eq!(parse("https://app.example.com/chat/abc"), None);
        assert_eq!(parse("neore://settings/billing"), None);
    }

    #[test]
    fn same_origin_compares_scheme_host_and_port() {
        assert!(is_same_origin(
            &origin(),
            &Url::parse("https://app.example.com/chat/x").unwrap()
        ));
        assert!(!is_same_origin(
            &origin(),
            &Url::parse("http://app.example.com/").unwrap()
        ));
        assert!(!is_same_origin(
            &origin(),
            &Url::parse("https://app.example.com.evil.test/").unwrap()
        ));
    }

    #[test]
    fn clamps_by_characters_not_bytes() {
        assert_eq!(clamp_text("  äöü  ", 2), "äö");
    }
}
