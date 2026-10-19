//! The document-parser service: a Rust Worker on the `xberg` crate.
//!
//! `POST /extract` — raw document bytes in the body, the document's MIME type
//! as `Content-Type` → `{ content, mimeType, tables, metadata }`
//! (`packages/service-sdk/openapi/document-parser.json`). `GET /health` and
//! `GET /health/live` answer liveness.
//!
//! PRIVATE: no workers.dev URL and no route, so the backend's
//! `SERVICE_DOCUMENT_PARSER` service binding is the only way in, and there is no
//! auth here. See docs/plans/document-parser.md for the limits and the design.

mod shape;

use futures_util::StreamExt;
use serde::Serialize;
use std::borrow::Cow;
use worker::{Context, Env, Method, Request, Response, Result, console_error, event};

use xberg::{
    ExtractInput, ExtractionConfig, ExtractionErrorItem, OutputFormat, PageConfig, SecurityLimits,
};

use crate::shape::{
    ContentFormat, ErrorBody, ExtractResponse, ExtractedTable, MAX_DOCUMENT_BYTES, body_capacity,
    declared_length, declared_length_exceeds, is_paged, is_slides, normalize_mime, paged_markdown,
    parse_format, prune_nulls, retry_as_plain_text, strip_heading_attributes, too_large,
};

/// Linear memory size in bytes. Wasm memory only grows, so this is the isolate's
/// high-water mark — the number to hold against the 128 MB per-isolate limit.
fn wasm_memory_bytes() -> usize {
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::memory_size(0) * 65_536
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}

fn json<T: Serialize>(status: u16, body: &T) -> Result<Response> {
    let response = Response::from_json(body)?.with_status(status);
    let headers = response.headers();

    headers.set("cache-control", "no-store")?;
    headers.set("x-content-type-options", "nosniff")?;

    Ok(response)
}

fn error(status: u16, error: &str, details: Option<String>) -> Result<Response> {
    json(status, &ErrorBody::new(error, details))
}

/// The extraction config. `Plain` is exactly what the Worker always ran with;
/// `Markdown` changes only the output format, and per-page content for the
/// paged formats (see `shape::paged_markdown`).
fn config(format: ContentFormat, mime_type: &str) -> ExtractionConfig {
    let mut config = ExtractionConfig {
        // The result cache is file-backed; a Worker has no filesystem and no use for it.
        use_cache: false,
        // xberg's defaults (500 MB archives, 100 MB content) are sized for a server,
        // not a 128 MB isolate.
        security_limits: Some(SecurityLimits {
            max_archive_size: 48 * 1024 * 1024,
            max_content_size: 32 * 1024 * 1024,
            ..SecurityLimits::default()
        }),
        ..ExtractionConfig::default()
    };

    if format == ContentFormat::Markdown {
        if !is_slides(mime_type) {
            config.output_format = OutputFormat::Markdown;
        }

        if is_paged(mime_type) {
            config.pages = Some(PageConfig {
                extract_pages: true,
                ..PageConfig::default()
            });
        }
    }

    config
}

/// Why an extraction produced no response body.
#[derive(Debug)]
pub enum ExtractFailure {
    /// xberg returned no document; the item is its first per-input error.
    Empty(Option<ExtractionErrorItem>),
    Xberg(xberg::XbergError),
}

impl ExtractFailure {
    /// What the caller sees; xberg's own wording stays in the log.
    fn message(&self) -> &'static str {
        let unsupported = match self {
            Self::Empty(item) => item
                .as_ref()
                .is_some_and(|item| item.error_type == "unsupported_format"),
            Self::Xberg(error) => matches!(error, xberg::XbergError::UnsupportedFormat(_)),
        };

        if unsupported {
            "Unsupported format"
        } else {
            "Could not parse this document"
        }
    }

    fn details(&self) -> Option<String> {
        match self {
            Self::Empty(item) => item.as_ref().map(|item| format!("{item:?}")),
            Self::Xberg(error) => Some(error.to_string()),
        }
    }
}

async fn run_xberg(
    body: Vec<u8>,
    mime_type: String,
    format: ContentFormat,
) -> xberg::Result<xberg::ExtractionResult> {
    let config = config(format, &mime_type);

    if !retry_as_plain_text(&mime_type) {
        return xberg::extract(ExtractInput::from_bytes(body, mime_type, None), &config).await;
    }

    // Only text is retried, so the clone is of a text file, never a large PDF.
    match xberg::extract(
        ExtractInput::from_bytes(body.clone(), mime_type, None),
        &config,
    )
    .await
    {
        Err(xberg::XbergError::UnsupportedFormat(_)) => {
            xberg::extract(ExtractInput::from_bytes(body, "text/plain", None), &config).await
        }
        other => other,
    }
}

/// Extracts one document and shapes it into the `/extract` response.
pub async fn extract_document(
    body: Vec<u8>,
    mime_type: String,
    format: ContentFormat,
) -> core::result::Result<ExtractResponse, ExtractFailure> {
    let result = run_xberg(body, mime_type.clone(), format)
        .await
        .map_err(ExtractFailure::Xberg)?;
    let first_error = result.errors.into_iter().next();
    let Some(document) = result.results.into_iter().next() else {
        return Err(ExtractFailure::Empty(first_error));
    };

    // xberg fills `pages` for DOCX too (one page, no real pagination), so only
    // the paged formats take their markers from it. Slides keep plain text, so
    // their pages are plain too (see `shape::is_slides`).
    let markdown = format == ContentFormat::Markdown && !is_slides(&mime_type);
    let paged = format == ContentFormat::Markdown && is_paged(&mime_type);
    let content = match document.pages.as_deref() {
        Some(pages) if paged && !pages.is_empty() => paged_markdown(pages.iter().map(|page| {
            let text = if markdown {
                Cow::Borrowed(page.content.as_str())
            } else {
                Cow::Owned(strip_heading_attributes(&page.content))
            };

            (page.page_number, text)
        })),
        _ if markdown => document.content,
        _ => strip_heading_attributes(&document.content),
    };

    Ok(ExtractResponse {
        content,
        mime_type: document.mime_type.into_owned(),
        tables: document
            .tables
            .into_iter()
            .map(|table| ExtractedTable {
                markdown: table.markdown,
                page_number: table.page_number,
            })
            .collect(),
        metadata: serde_json::to_value(&document.metadata)
            .map(prune_nulls)
            .unwrap_or(serde_json::Value::Null),
    })
}

/// The body, or `None` once it passes `max` bytes — counted while streaming, so
/// a body without (or lying about) `Content-Length` is cut off at the cap
/// instead of being buffered whole first.
async fn read_capped(req: &mut Request, max: usize, capacity: usize) -> Result<Option<Vec<u8>>> {
    let mut stream = req.stream()?;
    let mut body = Vec::with_capacity(capacity);

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;

        if body.len() + chunk.len() > max {
            return Ok(None);
        }

        body.extend_from_slice(&chunk);
    }

    Ok(Some(body))
}

async fn handle_extract(mut req: Request) -> Result<Response> {
    let format = req
        .url()?
        .query_pairs()
        .find(|(key, _)| key == "format")
        .map(|(_, value)| value.into_owned());
    let Some(format) = parse_format(format.as_deref()) else {
        return error(
            400,
            "Unknown format",
            Some("Use format=markdown, or omit it for plain text.".to_owned()),
        );
    };

    let headers = req.headers();
    let mime_type = normalize_mime(headers.get("content-type")?.as_deref());

    let content_length = headers.get("content-length")?;

    if declared_length_exceeds(content_length.as_deref(), MAX_DOCUMENT_BYTES) {
        return json(413, &too_large(MAX_DOCUMENT_BYTES));
    }

    let capacity = body_capacity(
        declared_length(content_length.as_deref()),
        MAX_DOCUMENT_BYTES,
    );
    let Some(body) = read_capped(&mut req, MAX_DOCUMENT_BYTES, capacity).await? else {
        return json(413, &too_large(MAX_DOCUMENT_BYTES));
    };

    if body.is_empty() {
        return error(400, "Empty request body", None);
    }

    match extract_document(body, mime_type, format).await {
        Ok(response) => json(200, &response),
        Err(failure) => {
            if let Some(details) = failure.details() {
                console_error!("extraction failed: {details}");
            }

            error(500, "Extraction failed", Some(failure.message().to_owned()))
        }
    }
}

#[event(fetch)]
async fn fetch(req: Request, _env: Env, _ctx: Context) -> Result<Response> {
    let path = req.path();

    match (req.method(), path.as_str()) {
        (Method::Get, "/health") => json(
            200,
            &serde_json::json!({ "healthy": true, "status": "ok", "wasmMemoryBytes": wasm_memory_bytes() }),
        ),
        (Method::Get, "/health/live") => json(200, &serde_json::json!({ "status": "live" })),
        (Method::Post, "/extract") => handle_extract(req).await,
        (_, "/extract" | "/health" | "/health/live") => error(405, "Method not allowed", None),
        _ => error(404, "Not found", None),
    }
}

#[cfg(test)]
mod tests {
    //! Real xberg extraction on the host, over the fixtures the workerd suite
    //! (`test/extract.test.ts`) also sends through the built Worker.

    use std::{
        future::Future,
        pin::pin,
        task::{Context, Poll, Waker},
    };

    use super::*;

    /// xberg runs without a runtime here (`tokio-runtime` is off), so polling
    /// to completion is enough.
    fn block_on<F: Future>(future: F) -> F::Output {
        let mut future = pin!(future);
        let mut context = Context::from_waker(Waker::noop());

        loop {
            if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
                return value;
            }
        }
    }

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/test/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    fn extract(name: &str, mime: &str) -> ExtractResponse {
        extract_as(name, mime, ContentFormat::Plain)
    }

    fn extract_as(name: &str, mime: &str, format: ContentFormat) -> ExtractResponse {
        block_on(extract_document(fixture(name), mime.to_owned(), format)).unwrap()
    }

    const DOCX: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    #[test]
    fn extracts_a_pdf() {
        let response = extract("sample.pdf", "application/pdf");

        assert!(response.content.contains("The capybara sits by the river."));
        assert_eq!(response.mime_type, "application/pdf");
    }

    #[test]
    fn extracts_a_docx_without_heading_attributes() {
        let response = extract(
            "sample.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );

        assert!(
            response.content.starts_with("Quarterly Report\n"),
            "{}",
            response.content
        );
        assert!(response.content.contains("zebrafish"));
        assert!(!response.content.contains("style_name"));
        assert_eq!(
            response.tables,
            vec![ExtractedTable {
                markdown: "| Name | Score |\n| --- | --- |\n| Ada | 42 |\n".to_owned(),
                page_number: 1
            }]
        );
    }

    #[test]
    fn extracts_an_xlsx_table() {
        let response = extract(
            "sample.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );

        assert!(response.content.contains("platypus"));
        assert!(response.tables[0].markdown.contains("| wombat | 3 |"));
    }

    #[test]
    fn extracts_a_pptx() {
        let response = extract(
            "sample.pptx",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        );

        assert!(response.content.contains("narwhal"));
    }

    #[test]
    fn reads_unsupported_text_as_plain_text() {
        let response = block_on(extract_document(
            b"print('hello')\n".to_vec(),
            "text/x-python".to_owned(),
            ContentFormat::Plain,
        ))
        .unwrap();

        assert!(response.content.contains("print('hello')"));
    }

    #[test]
    fn plain_output_has_no_page_markers() {
        let response = extract("sample.pdf", "application/pdf");

        assert!(!response.content.contains("<!-- PAGE"));
    }

    #[test]
    fn plain_config_is_unchanged_by_the_format_option() {
        let plain = config(ContentFormat::Plain, "application/pdf");

        assert_eq!(plain.output_format, OutputFormat::Plain);
        assert!(plain.pages.is_none());
    }

    #[test]
    fn markdown_keeps_docx_headings_and_tables() {
        let response = extract_as("sample.docx", DOCX, ContentFormat::Markdown);

        assert!(
            response.content.starts_with("# Quarterly Report\n\n"),
            "{}",
            response.content
        );
        assert!(response.content.contains("\n## Details\n"));
        assert!(response.content.contains("| Ada | 42 |"));
        assert!(!response.content.contains("style_name"));
        // DOCX has no pagination xberg can see, so it carries no page markers.
        assert!(!response.content.contains("<!-- PAGE"));
        assert_eq!(response.tables.len(), 1);
        // Ingest appends a table only when its Markdown is missing from `content`.
        assert!(
            response
                .content
                .contains(response.tables[0].markdown.trim())
        );
    }

    #[test]
    fn markdown_keeps_xlsx_tables_in_place() {
        let response = extract_as(
            "sample.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ContentFormat::Markdown,
        );

        assert!(
            response.content.contains("## Inventory\n"),
            "{}",
            response.content
        );
        assert_eq!(response.tables.len(), 1);
        assert!(
            response
                .content
                .contains(response.tables[0].markdown.trim())
        );
    }

    #[test]
    fn markdown_marks_the_pdf_page() {
        let response = extract_as("sample.pdf", "application/pdf", ContentFormat::Markdown);

        assert!(
            response.content.starts_with("<!-- PAGE 1 -->\n\n"),
            "{}",
            response.content
        );
        assert!(response.content.contains("The capybara sits by the river."));
    }

    #[test]
    fn markdown_keeps_pdf_headings_under_their_page() {
        let response = extract_as(
            "headed-pages.pdf",
            "application/pdf",
            ContentFormat::Markdown,
        );
        let first = response
            .content
            .find("<!-- PAGE 1 -->")
            .expect("page 1 marker");
        let heading = response.content.find("# Rate limits").expect("heading");
        let second = response
            .content
            .find("<!-- PAGE 2 -->")
            .expect("page 2 marker");

        assert!(first < heading && heading < second, "{}", response.content);
    }

    #[test]
    fn markdown_reads_slides_as_plain_text_page_by_page() {
        let response = extract_as(
            "sample.pptx",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ContentFormat::Markdown,
        );

        assert!(
            response.content.starts_with("<!-- PAGE 1 -->\n\n"),
            "{}",
            response.content
        );
        assert!(response.content.contains("narwhal"));
        // A slide's title and body share one line in xberg's Markdown, which would
        // make the whole slide a heading. Slides are not Markdown.
        assert!(!response.content.contains("## "), "{}", response.content);
    }

    #[test]
    fn markdown_splits_a_two_page_pdf_at_its_pages() {
        let response = extract_as("two-pages.pdf", "application/pdf", ContentFormat::Markdown);
        let first = response
            .content
            .find("<!-- PAGE 1 -->")
            .expect("page 1 marker");
        let second = response
            .content
            .find("<!-- PAGE 2 -->")
            .expect("page 2 marker");

        assert!(first < second);
        assert!(response.content[first..second].contains("The first page mentions the otter."));
        assert!(response.content[second..].contains("The second page mentions the ibex."));
        assert!(!response.content[second..].contains("otter"));
    }

    #[test]
    fn metadata_has_no_nulls() {
        let response = extract(
            "sample.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );

        assert!(
            !serde_json::to_string(&response.metadata)
                .unwrap()
                .contains("null")
        );
    }

    #[test]
    fn refuses_an_unsupported_binary() {
        let failure = block_on(extract_document(
            vec![0, 1, 2, 3],
            "application/x-unknown".to_owned(),
            ContentFormat::Plain,
        ))
        .unwrap_err();

        assert!(failure.details().is_some());
        assert_eq!(failure.message(), "Unsupported format");
    }

    #[test]
    fn caps_xberg_below_the_isolate_budget() {
        let limits = config(ContentFormat::Markdown, "application/pdf")
            .security_limits
            .unwrap();

        assert!(limits.max_archive_size < 64 * 1024 * 1024);
        assert!(limits.max_content_size < 64 * 1024 * 1024);
        assert!(limits.max_archive_size > MAX_DOCUMENT_BYTES);
    }
}
