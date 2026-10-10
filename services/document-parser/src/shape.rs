//! Pure request/response shaping — everything here runs (and is tested) on the
//! host with `cargo test`; nothing touches the Workers runtime.

use serde::Serialize;

/// The largest document the parser accepts, in bytes (25 MiB).
///
/// TODO: To support documents above 25 MB, move extraction to a Cloudflare
/// Container (xberg native server / Docker image) — a Worker isolate has 128 MB
/// and PDF parsing needs ~3× the file size. See docs/plans/document-parser.md.
///
/// Measured on the xberg 1.3.2 spike: a PDF peaks at ~3.1× its size in linear
/// memory plus ~6 MB, so a 40 MB PDF hit the 128 MB isolate limit and 25 MB
/// (~84 MB) leaves headroom for the request buffer. The backend
/// (`backend/lunora/lib/document-limits.ts`) and the web upload UI enforce the
/// same number before a byte is sent; this is the backstop.
pub const MAX_DOCUMENT_BYTES: usize = 25 * 1024 * 1024;

/// The MIME type xberg should parse a document as: the `Content-Type` without
/// parameters, lower-cased, `application/octet-stream` when absent.
pub fn normalize_mime(header: Option<&str>) -> String {
    header
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "application/octet-stream".to_owned())
}

/// Whether an unsupported `mime` should be retried as `text/plain`.
///
/// Source code (`text/x-python`, `text/javascript`, …) needs xberg's
/// tree-sitter feature, which this build leaves out (as Kreuzberg 4.10 did),
/// and the backend sends every `text/*` here — so read those as plain text.
pub fn retry_as_plain_text(mime: &str) -> bool {
    mime.starts_with("text/") && mime != "text/plain"
}

/// Whether a declared `Content-Length` is already over the cap. A missing or
/// malformed header is not — the streamed byte count decides then.
pub fn declared_length_exceeds(header: Option<&str>, max: usize) -> bool {
    declared_length(header).is_some_and(|length| length > max as u64)
}

/// The `Content-Length`, when it parses.
pub fn declared_length(header: Option<&str>) -> Option<u64> {
    header.and_then(|value| value.trim().parse::<u64>().ok())
}

/// How much to reserve for the body up front: the declared length (never more
/// than the cap). Exact, so the buffer never doubles — a doubling `Vec` peaks at
/// ~1.5× a 25 MB body while it copies, memory the parse needs (128 MB isolate).
pub fn body_capacity(declared: Option<u64>, max: usize) -> usize {
    declared.map_or(0, |length| usize::try_from(length).unwrap_or(max).min(max))
}

/// The 413 body, worded for a person: the backend surfaces `details` as the
/// file's extraction error.
pub fn too_large(max: usize) -> ErrorBody {
    let megabytes = max / (1024 * 1024);

    ErrorBody {
        error: "File too large".to_owned(),
        details: Some(format!("Documents can be at most {megabytes} MB.")),
        max_bytes: Some(max),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<usize>,
}

impl ErrorBody {
    pub fn new(error: &str, details: Option<String>) -> Self {
        Self {
            error: error.to_owned(),
            details,
            max_bytes: None,
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedTable {
    pub markdown: String,
    pub page_number: u32,
}

/// `POST /extract`'s 200 body — the contract `@neore/service-sdk`'s
/// `ExtractResponse` describes (`packages/service-sdk/openapi/document-parser.json`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractResponse {
    pub content: String,
    pub mime_type: String,
    pub tables: Vec<ExtractedTable>,
    pub metadata: serde_json::Value,
}

/// xberg's plain-text renderer appends a heading's attributes to its line —
/// `Quarterly Report (style_name: heading 1)` for every DOCX heading. They are
/// layout noise to a model, so a trailing `(key: value, …)` group that carries
/// `style_name` is dropped. Anything else in parentheses is left alone.
pub fn strip_heading_attributes(content: &str) -> String {
    let mut out = String::with_capacity(content.len());

    for (index, line) in content.split('\n').enumerate() {
        if index > 0 {
            out.push('\n');
        }

        out.push_str(strip_line(line));
    }

    out
}

fn strip_line(line: &str) -> &str {
    let Some(body) = line.strip_suffix(')') else {
        return line;
    };
    let Some(open) = body.rfind(" (") else {
        return line;
    };
    let group = &body[open + 2..];
    let mut saw_style = false;

    for pair in group.split(", ") {
        let Some((key, value)) = pair.split_once(": ") else {
            return line;
        };

        if key.is_empty()
            || value.is_empty()
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
        {
            return line;
        }

        saw_style |= key == "style_name";
    }

    if saw_style { &body[..open] } else { line }
}

/// Drops `null` members from objects, recursively. xberg's metadata spells out
/// every absent document property (`"creator": null`, …) — about half of it.
pub fn prune_nulls(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.into_iter()
                .filter(|(_, member)| !member.is_null())
                .map(|(key, member)| (key, prune_nulls(member)))
                .collect(),
        ),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(prune_nulls).collect())
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_the_content_type() {
        assert_eq!(
            normalize_mime(Some("Application/PDF; charset=binary")),
            "application/pdf"
        );
        assert_eq!(normalize_mime(Some("  ")), "application/octet-stream");
        assert_eq!(normalize_mime(None), "application/octet-stream");
    }

    #[test]
    fn retries_only_non_plain_text() {
        assert!(retry_as_plain_text("text/x-python"));
        assert!(retry_as_plain_text("text/javascript"));
        assert!(!retry_as_plain_text("text/plain"));
        assert!(!retry_as_plain_text("application/pdf"));
    }

    #[test]
    fn checks_the_declared_length() {
        assert!(declared_length_exceeds(
            Some("26214401"),
            MAX_DOCUMENT_BYTES
        ));
        assert!(!declared_length_exceeds(
            Some("26214400"),
            MAX_DOCUMENT_BYTES
        ));
        assert!(!declared_length_exceeds(Some("nope"), MAX_DOCUMENT_BYTES));
        assert!(!declared_length_exceeds(None, MAX_DOCUMENT_BYTES));
    }

    #[test]
    fn reserves_the_declared_length_up_to_the_cap() {
        assert_eq!(body_capacity(Some(1234), MAX_DOCUMENT_BYTES), 1234);
        assert_eq!(
            body_capacity(Some(u64::MAX), MAX_DOCUMENT_BYTES),
            MAX_DOCUMENT_BYTES
        );
        assert_eq!(body_capacity(None, MAX_DOCUMENT_BYTES), 0);
    }

    #[test]
    fn words_the_413() {
        let body = serde_json::to_value(too_large(MAX_DOCUMENT_BYTES)).unwrap();

        assert_eq!(
            body,
            serde_json::json!({ "error": "File too large", "details": "Documents can be at most 25 MB.", "maxBytes": 26_214_400 })
        );
    }

    #[test]
    fn strips_docx_heading_attributes() {
        let content = "Quarterly Report (style_name: heading 1)\nBody text.\n\n  Details (style_name: heading 2, level: 2)\nName Score";

        assert_eq!(
            strip_heading_attributes(content),
            "Quarterly Report\nBody text.\n\n  Details\nName Score"
        );
    }

    #[test]
    fn keeps_ordinary_parentheses() {
        for line in [
            "Revenue (EUR)",
            "Note (see: appendix)",
            "Call me (maybe)",
            "Weird (Style_Name: x)",
            "(style_name: heading 1)",
        ] {
            assert_eq!(strip_heading_attributes(line), line);
        }
    }

    #[test]
    fn prunes_null_members() {
        let pruned = prune_nulls(
            serde_json::json!({ "a": null, "b": { "c": null, "d": 1 }, "e": [null, { "f": null }] }),
        );

        assert_eq!(
            pruned,
            serde_json::json!({ "b": { "d": 1 }, "e": [null, {}] })
        );
    }
}
