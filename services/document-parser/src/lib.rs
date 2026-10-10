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
use worker::{Context, Env, Method, Request, Response, Result, event};
use xberg::{ExtractInput, ExtractionConfig};

use crate::shape::{
    ErrorBody, ExtractResponse, ExtractedTable, MAX_DOCUMENT_BYTES, body_capacity, declared_length,
    declared_length_exceeds, normalize_mime, prune_nulls, retry_as_plain_text,
    strip_heading_attributes, too_large,
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

fn config() -> ExtractionConfig {
    ExtractionConfig {
        // The result cache is file-backed; a Worker has no filesystem and no use for it.
        use_cache: false,
        ..ExtractionConfig::default()
    }
}

/// Why an extraction produced no response body.
#[derive(Debug)]
pub enum ExtractFailure {
    /// xberg returned no document; the details are its per-input errors.
    Empty(Option<String>),
    Xberg(xberg::XbergError),
}

impl ExtractFailure {
    fn details(self) -> Option<String> {
        match self {
            Self::Empty(details) => details,
            Self::Xberg(error) => Some(error.to_string()),
        }
    }
}

async fn run_xberg(body: Vec<u8>, mime_type: String) -> xberg::Result<xberg::ExtractionResult> {
    if !retry_as_plain_text(&mime_type) {
        return xberg::extract(ExtractInput::from_bytes(body, mime_type, None), &config()).await;
    }

    // Only text is retried, so the clone is of a text file, never a large PDF.
    match xberg::extract(
        ExtractInput::from_bytes(body.clone(), mime_type, None),
        &config(),
    )
    .await
    {
        Err(xberg::XbergError::UnsupportedFormat(_)) => {
            xberg::extract(
                ExtractInput::from_bytes(body, "text/plain", None),
                &config(),
            )
            .await
        }
        other => other,
    }
}

/// Extracts one document and shapes it into the `/extract` response.
pub async fn extract_document(
    body: Vec<u8>,
    mime_type: String,
) -> core::result::Result<ExtractResponse, ExtractFailure> {
    let result = run_xberg(body, mime_type)
        .await
        .map_err(ExtractFailure::Xberg)?;
    let first_error = result.errors.first().map(|item| format!("{item:?}"));
    let Some(document) = result.results.into_iter().next() else {
        return Err(ExtractFailure::Empty(first_error));
    };

    Ok(ExtractResponse {
        content: strip_heading_attributes(&document.content),
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

    match extract_document(body, mime_type).await {
        Ok(response) => json(200, &response),
        Err(failure) => error(500, "Extraction failed", failure.details()),
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
        block_on(extract_document(fixture(name), mime.to_owned())).unwrap()
    }

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
        ))
        .unwrap();

        assert!(response.content.contains("print('hello')"));
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
        ))
        .unwrap_err();

        assert!(failure.details().is_some());
    }
}
