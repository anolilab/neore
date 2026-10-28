//! What a coding agent's reply may attach: the files it wrote in the folder it was approved for
//! (plans/acp-agent-host.md §4.8). Pure rules; the confined read is `fs::read_media`.
//!
//! **The caps and the types below are PROVISIONAL, not measured.** The plan asks for them to be set from a sample
//! of real agent output before S8 starts, and none could be taken here. They are chosen to sit well inside what
//! the backend accepts for a chat attachment (images and audio 20 MB, `lib/document-limits.ts`) and to be what
//! an agent plausibly writes in a turn (a chart, a screenshot, a report). Re-set them from a measured sample;
//! `backend/lunora/acp/lib/constants.ts` carries the same numbers and a test pins that they agree.
//!
//! A file's type is decided by its leading bytes AND its extension, and both must agree. An extension alone
//! would let a page of script pass as `chart.png`; bytes alone would let `page.html` carrying a PNG header
//! through. SVG, HTML, scripts, stylesheets and XML are not on the list at all: they run in a browser.

/// An image up to this size is shown inline; a larger one is offered as a file with its size.
pub const MAX_INLINE_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
/// A file above this is not uploaded: the reply names it and says how large it is.
pub const MAX_UPLOAD_BYTES: u64 = 20 * 1024 * 1024;
/// How many leading bytes are looked at to decide a type.
pub const SNIFF_BYTES: usize = 1024;
/// The longest reference (a Markdown target) that is looked at.
pub const MAX_REFERENCE_CHARS: usize = 1024;

/// Whether a file is shown in the message or offered for download.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Image,
    File,
}

/// One allowed type: its MIME type, the extensions it may carry, and whether it is an image.
struct Allowed {
    extensions: &'static [&'static str],
    image: bool,
    mime: &'static str,
}

const ALLOWED: &[Allowed] = &[
    Allowed {
        extensions: &["png"],
        image: true,
        mime: "image/png",
    },
    Allowed {
        extensions: &["jpg", "jpeg"],
        image: true,
        mime: "image/jpeg",
    },
    Allowed {
        extensions: &["gif"],
        image: true,
        mime: "image/gif",
    },
    Allowed {
        extensions: &["webp"],
        image: true,
        mime: "image/webp",
    },
    Allowed {
        extensions: &["pdf"],
        image: false,
        mime: "application/pdf",
    },
    Allowed {
        extensions: &["txt", "log"],
        image: false,
        mime: "text/plain",
    },
    Allowed {
        extensions: &["md", "markdown"],
        image: false,
        mime: "text/markdown",
    },
    Allowed {
        extensions: &["json"],
        image: false,
        mime: "application/json",
    },
];

/// The type `head` looks like, from its bytes alone. Text has no signature: it is "text" when it holds no NUL.
fn sniff(head: &[u8]) -> Option<&'static str> {
    const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

    if head.starts_with(PNG) {
        Some("image/png")
    } else if head.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some("image/webp")
    } else if head.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else if !head.contains(&0) {
        Some("text")
    } else {
        None
    }
}

/// The allowed type of a file called `name` whose first bytes are `head`, or `None`: not on the list, or the name
/// and the bytes disagree.
pub fn classify(name: &str, head: &[u8]) -> Option<(&'static str, Kind)> {
    let extension = name.rsplit_once('.')?.1.to_ascii_lowercase();
    let allowed = ALLOWED
        .iter()
        .find(|allowed| allowed.extensions.contains(&extension.as_str()))?;
    let sniffed = sniff(head)?;
    let agrees = if allowed.mime.starts_with("text/") || allowed.mime == "application/json" {
        sniffed == "text"
    } else {
        sniffed == allowed.mime
    };

    agrees.then_some((
        allowed.mime,
        if allowed.image {
            Kind::Image
        } else {
            Kind::File
        },
    ))
}

/// Whether a reference is a plain path. A URL or a data URI names no file in the folder, and is never opened.
/// Neither is a Windows form that can name another machine or drive (`\\host\share`, `C:`, a backslash anywhere):
/// resolving one would make a connection on the agent's say-so.
pub fn is_plain_path(reference: &str) -> bool {
    let reference = reference.trim();
    let drive =
        reference.as_bytes().get(1) == Some(&b':') && reference.as_bytes()[0].is_ascii_alphabetic();

    !reference.is_empty()
        && !drive
        && !reference.contains('\\')
        && reference.chars().count() <= MAX_REFERENCE_CHARS
        && !reference.contains('\0')
        && !reference.contains("://")
        && !reference.starts_with("data:")
        && !reference.starts_with("file:")
        && !reference.starts_with("//")
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];

    #[test]
    fn an_image_needs_its_bytes_and_its_extension_to_agree() {
        assert_eq!(classify("chart.png", PNG), Some(("image/png", Kind::Image)));
        assert_eq!(classify("CHART.PNG", PNG), Some(("image/png", Kind::Image)));
        assert_eq!(classify("chart.jpg", PNG), None);
        assert_eq!(classify("page.html", PNG), None);
        assert_eq!(classify("chart.png", b"<html></html>"), None);
    }

    #[test]
    fn a_page_or_a_script_is_never_a_file_the_reply_can_carry() {
        for name in [
            "a.html",
            "a.htm",
            "a.svg",
            "a.js",
            "a.mjs",
            "a.ts",
            "a.css",
            "a.xml",
            "a.sh",
            "a.py",
            "a.exe",
            "noext",
            "a.png.html",
        ] {
            assert_eq!(classify(name, b"<script>alert(1)</script>"), None, "{name}");
            assert_eq!(classify(name, PNG), None, "{name}");
        }
    }

    #[test]
    fn text_files_are_files_and_binary_pretending_to_be_text_is_not() {
        assert_eq!(
            classify("notes.md", b"# hi"),
            Some(("text/markdown", Kind::File))
        );
        assert_eq!(
            classify("data.json", b"{}"),
            Some(("application/json", Kind::File))
        );
        assert_eq!(classify("data.json", &[1, 0, 2]), None);
        assert_eq!(
            classify("report.pdf", b"%PDF-1.7\n"),
            Some(("application/pdf", Kind::File))
        );
        assert_eq!(classify("report.pdf", b"not a pdf"), None);
    }

    #[test]
    fn webp_needs_both_riff_markers() {
        assert_eq!(
            classify("a.webp", b"RIFF\0\0\0\0WEBPVP8 "),
            Some(("image/webp", Kind::Image))
        );
        assert_eq!(classify("a.webp", b"RIFF\0\0\0\0WAVEfmt "), None);
    }

    #[test]
    fn only_a_plain_path_is_looked_at() {
        assert!(is_plain_path("out/chart.png"));
        assert!(is_plain_path("../secret.png"));
        assert!(is_plain_path("/etc/hosts"));
        assert!(!is_plain_path(""));
        assert!(!is_plain_path("https://example.com/a.png"));
        assert!(!is_plain_path("file:///etc/passwd"));
        assert!(!is_plain_path("data:image/png;base64,AAAA"));
        assert!(!is_plain_path("//host/share/a.png"));
        assert!(!is_plain_path(r"\\host\share\a.png"));
        assert!(!is_plain_path(r"C:\Users\a.png"));
        assert!(!is_plain_path("C:a.png"));
        assert!(!is_plain_path(r"out\a.png"));
        assert!(!is_plain_path("a\0b.png"));
        assert!(!is_plain_path(&"a".repeat(MAX_REFERENCE_CHARS + 1)));
    }
}
