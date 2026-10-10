/**
 * Document text extraction — calls the document-parser Cloudflare Worker
 * to extract text, tables, and metadata from uploaded files.
 *
 * Flow:
 *   1. `file.finalizeChatUpload` stores the uploaded file in R2 (`lib/chat-upload.ts`)
 *   2. Scheduler triggers `extractDocumentText` action
 *   3. This action fetches file bytes, sends them to the parser Worker
 *   4. Extracted text is saved back to the `chatFiles` table
 *   5. Chat HTTP action checks `extractedText` when building AI context
 */
import { createDocumentParserClient, extractDocument, type ExtractResponse } from "@neore/service-sdk/document-parser";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction } from "../_generated/server";
import { MAX_EXTRACTION_DOCUMENT_BYTES, MAX_EXTRACTION_DOCUMENT_MEGABYTES } from "../lib/document-limits";
import { FETCH_TIMEOUT_LONG_MS } from "../lib/fetch-timeout";
import { isServiceBound, serviceFetch } from "../lib/services";
import { readStoredObject } from "../lib/storage-read";

/**
 * MIME types that are worth extracting text from.
 * Images are handled natively by vision models, so we skip them.
 * Audio/video don't have extractable text.
 */
const EXTRACTABLE_MIME_TYPES = new Set([
    // E-books
    "application/epub+zip",
    // Data formats
    "application/json",
    "application/msword",
    // Documents
    "application/pdf",
    "application/rtf",
    // Spreadsheets
    "application/vnd.ms-excel",
    // Presentations
    "application/vnd.ms-powerpoint",
    "application/vnd.oasis.opendocument.presentation",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/xml",
    "application/yaml",
    // Archives (xberg extracts the contained documents)
    "application/zip",
    "text/csv",
    "text/html",
    "text/javascript",
    "text/markdown",
    // Text
    "text/plain",
    "text/tab-separated-values",
    "text/x-c",
    "text/x-java",
    "text/x-python",
    "text/x-typescript",
    "text/xml",
    "text/yaml",
]);

/** What a too-large document's `extractionError` says. Over the cap, nothing is read. */
const TOO_LARGE_MESSAGE = `Documents can be at most ${String(MAX_EXTRACTION_DOCUMENT_MEGABYTES)} MB to have their text extracted.`;

/** Whether `error` is the storage read's or the parser's size refusal. */
const isTooLarge = (error: unknown): boolean => error instanceof LunoraError && error.code === "PAYLOAD_TOO_LARGE";

/**
 * Check if a MIME type is extractable.
 * Also matches any `text/*` type.
 */
const isExtractable = (mimeType: string): boolean => {
    if (mimeType.startsWith("text/")) {
        return true;
    }

    return EXTRACTABLE_MIME_TYPES.has(mimeType);
};

export const extractDocumentText = internalAction
    .input({
        fileId: v.id("chatFiles"),
        mediaType: v.string(),
        storageId: v.string(),
    })
    .action(async ({ args, ctx }) => {
        if (!isServiceBound(ctx, "documentParser")) {
            console.warn("document-parser service binding (SERVICE_DOCUMENT_PARSER) not bound — skipping text extraction");

            return;
        }

        // Check if this file type is extractable
        if (!isExtractable(args.mediaType)) {
            await ctx.runMutation(internal.agent.files.markExtractionUnsupported, {
                fileId: args.fileId,
            });

            return;
        }

        // Mark as processing
        await ctx.runMutation(internal.agent.files.markExtractionProcessing, {
            fileId: args.fileId,
        });

        try {
            // Fetch file bytes from storage
            // Through the binding, not over HTTP: `getUrl` is an unsigned URL that
            // nothing serves, and user files are not public (`lib/storage-read.ts`).
            // Capped at the parser's own limit: a larger document is refused here,
            // before its body is read, rather than sent only to come back a 413.
            const { bytes: fileBytes } = await readStoredObject(ctx.storage, args.storageId as string, { maxBytes: MAX_EXTRACTION_DOCUMENT_BYTES });

            // Call the document-parser Worker via typed SDK, over its service binding
            const client = createDocumentParserClient({ fetch: serviceFetch(ctx, "documentParser") });

            const { data, error, response } = await extractDocument({
                body: new Blob([fileBytes], { type: args.mediaType }),
                client,
                headers: { "content-type": args.mediaType },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_LONG_MS),
            });

            // The parser's own 25 MB backstop (by Content-Length or byte count).
            if (response?.status === 413) {
                throw new LunoraError("PAYLOAD_TOO_LARGE", TOO_LARGE_MESSAGE);
            }

            // `response` is absent when the request never completed (DNS, connect,
            // abort) — the generated client models that now, where the old one
            // asserted a response always existed.
            if (error || !response?.ok || !data) {
                throw new LunoraError("INTERNAL", `Parser returned ${response?.status ?? "no response"}: ${JSON.stringify(error)}`);
            }

            const result: ExtractResponse = data;

            // Build extracted text: main content + tables as markdown
            let extractedText = result.content || "";

            if (result.tables && result.tables.length > 0) {
                const tableMarkdown = result.tables
                    .map((table, index) => (table.markdown ? `\n\n### Table ${String(index + 1)}\n${table.markdown}` : ""))
                    .filter(Boolean)
                    .join("");

                if (tableMarkdown) {
                    extractedText += `\n\n---\n## Extracted Tables${tableMarkdown}`;
                }
            }

            if (!extractedText.trim()) {
                await ctx.runMutation(internal.agent.files.markExtractionFailed, {
                    error: "No text content could be extracted from this file",
                    fileId: args.fileId,
                });

                return;
            }

            // Save extracted text
            await ctx.runMutation(internal.agent.files.saveExtractedText, {
                extractedText: extractedText.trim(),
                fileId: args.fileId,
            });
        } catch (error) {
            let message = error instanceof Error ? error.message : "Unknown extraction error";

            if (isTooLarge(error)) {
                message = TOO_LARGE_MESSAGE;
            }

            console.error(`Text extraction failed for file ${args.fileId}:`, message);

            await ctx.runMutation(internal.agent.files.markExtractionFailed, {
                error: message,
                fileId: args.fileId,
            });
        }
    });

export default extractDocumentText;
