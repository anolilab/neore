/**
 * Knowledge Base Ingestion Pipeline
 *
 * Orchestrates: file read → text extraction → chunking → embedding → storage.
 * Follows the memory/extract.ts pattern for embeddings.
 */
import { browserAction, createBrowserRendererClient } from "@neore/service-sdk/browser-renderer";
import { generateText, Output } from "ai";
import { LunoraError, v } from "lunorash/server";
import z from "zod/v4";

import { internal } from "../_generated/internal";
import type { Doc } from "../_generated/dataModel";
import { type ActionCtx, internalAction } from "../_generated/server";
import { validateVectorDimension, type VectorDimension } from "../agent/vector/tables";
import { fetchWithTimeout, isSafeUrl } from "../chat/tools/utilities";
import { MARKDOWN_EXTRACTION_MAX_BYTES, MAX_EXTRACTION_DOCUMENT_BYTES, MAX_EXTRACTION_DOCUMENT_MEGABYTES } from "../lib/document-limits";
import { FETCH_TIMEOUT_LONG_MS } from "../lib/fetch-timeout";
import { gatewayFetch, isServiceBound, serviceFetch, type ServicesContext } from "../lib/services";
import { readStoredObject } from "../lib/storage-read";
import {
    type ChunkOptions,
    chunkText,
    EMBEDDING_INPUT_BUDGET,
    embeddingInput,
    estimateTokens,
    markPage,
    stripPageSentinel,
    withoutPageLines,
} from "./chunking";
import { documentToText, fetchUrlDocument, hasMarkdownStructure, isPagedMimeType, type ParseDocument } from "./sources";

("use node");

const EMBEDDING_MODEL_NAME = "text-embedding-004";
/**
 * A knowledge file is a document sent to extraction, so it shares the parser's
 * cap (`lib/document-limits.ts` — which carries the TODO for larger files).
 */
const MAX_FILE_SIZE = MAX_EXTRACTION_DOCUMENT_BYTES;

// ============================================================================
// Services
// ============================================================================

/** The document-parser Worker as a {@link ParseDocument}, or `undefined` when its binding is absent. */
export const documentParser = (ctx: ServicesContext): ParseDocument | undefined => {
    if (!isServiceBound(ctx, "documentParser")) {
        return undefined;
    }

    return async (bytes, mimeType) => {
        const { createDocumentParserClient, extractDocument } = await import("@neore/service-sdk/document-parser");
        const parserClient = createDocumentParserClient({ fetch: serviceFetch(ctx, "documentParser") });
        // Markdown keeps the headings the chunker's section paths come from, and
        // splits PDF and PPTX content into pages. Only knowledge asks for it.
        const extract = async (asMarkdown: boolean) =>
            await extractDocument({
                body: new Blob([bytes], { type: mimeType }),
                client: parserClient,
                headers: { "content-type": mimeType },
                ...(asMarkdown && { query: { format: "markdown" as const } }),
                signal: AbortSignal.timeout(FETCH_TIMEOUT_LONG_MS),
            });
        const wantsMarkdown = bytes.byteLength <= MARKDOWN_EXTRACTION_MAX_BYTES;
        // The Worker running out of memory or time on a Markdown render is a 5xx, or a rejected call, not a verdict on the file.
        // A failed Markdown render falls back to plain text; a rejected plain attempt propagates.
        const rendered = wantsMarkdown ? await extract(true).catch(() => undefined) : undefined;
        const result = rendered && (rendered.response?.status ?? 500) < 500 ? rendered : await extract(false);

        const { data, error, response } = result;

        if (response?.status === 413) {
            throw new LunoraError(
                "PAYLOAD_TOO_LARGE",
                `Documents can be at most ${String(MAX_EXTRACTION_DOCUMENT_MEGABYTES)} MB to have their text extracted.`,
            );
        }

        if (error || !response?.ok || !data) {
            throw new LunoraError("INTERNAL", `Parser returned ${response?.status ?? "no response"}: ${JSON.stringify(error)}`);
        }

        // A paged document comes back page by page: joined here, each page under its page line.
        // Plain text is stripped too: a PDF whose Markdown render failed reaches here with its page-less text.
        let text = data.pages ? data.pages.map((page) => markPage(page.pageNumber, page.content)).join("\n\n") : stripPageSentinel(data.content || "");

        // Markdown already carries the tables in place. Append only the ones it
        // lacks, so a table is never indexed twice.
        // Each keeps the number it has in the document, so "Table 2" is still the second table when the first is in place.
        const missingTables = data.tables
            .map((table, index) => {
                return { number: index + 1, table };
            })
            .filter(({ table }) => table.markdown && !text.includes(table.markdown.trim()));

        if (missingTables.length > 0) {
            const isPaged = isPagedMimeType(mimeType);
            const tableMarkdown = missingTables
                .map(({ number, table }) => {
                    const section = `### Table ${String(number)}\n${table.markdown}`;

                    // A table appended after the last page would inherit that page: mark each with its own.
                    return `\n\n${isPaged ? markPage(table.pageNumber, section) : section}`;
                })
                .join("");

            text += `\n\n---\n## Extracted Tables${tableMarkdown}`;
        }

        return text;
    };
};

/**
 * The Browser Rendering worker: navigate, then extract the rendered text in
 * the same session. `undefined` when its binding is absent — the URL path then
 * fetches the HTML itself.
 */
const pageRenderer = (ctx: ServicesContext): ((url: string) => Promise<{ content: string; title?: string }>) | undefined => {
    if (!isServiceBound(ctx, "browserRenderer")) {
        return undefined;
    }

    return async (url) => {
        const client = createBrowserRendererClient({ fetch: serviceFetch(ctx, "browserRenderer") });
        const navigated = await browserAction({ body: { action: "navigate", url }, client, signal: AbortSignal.timeout(FETCH_TIMEOUT_LONG_MS) });

        if (navigated.error || !navigated.response?.ok || !navigated.data?.success) {
            throw new LunoraError("INTERNAL", `Browser renderer could not open the page (${String(navigated.response?.status ?? "no response")})`);
        }

        const extracted = await browserAction({
            body: { action: "extract", sessionId: navigated.data.sessionId },
            client,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_LONG_MS),
        });

        if (extracted.error || !extracted.response?.ok || !extracted.data?.success) {
            throw new LunoraError("INTERNAL", `Browser renderer could not read the page (${String(extracted.response?.status ?? "no response")})`);
        }

        return { content: extracted.data.content ?? "", title: extracted.data.title ?? navigated.data.title };
    };
};

/** What the chunker may read in this source's text: headings where it is Markdown, page markers where the parser wrote them. */
const chunkingFor = (name: string, mimeType: string): ChunkOptions => {
    return { headings: hasMarkdownStructure(name, mimeType), pages: isPagedMimeType(mimeType) };
};

/**
 * The file's text, from wherever it came: a web page (`sourceUrl`), an object
 * stored for a pasted, folder or archive document (`storageKey`), or an upload
 * in the vault (`vaultFileId`). Read through `ctx.storage`, never over HTTP —
 * see `lib/storage-read.ts`. A URL also reports the page title.
 */
const loadSourceText = async (ctx: ActionCtx, file: Doc<"knowledgeFiles">): Promise<{ chunking: ChunkOptions; text: string; title?: string }> => {
    const parse = documentParser(ctx);

    if (file.sourceUrl) {
        const fetched = await fetchUrlDocument(file.sourceUrl, {
            fetch: async (url, init) => await fetchWithTimeout(url, init),
            isSafeUrl,
            parse,
            render: pageRenderer(ctx),
        });

        return {
            chunking: chunkingFor(new URL(fetched.url).pathname, fetched.mimeType),
            text: fetched.text,
            title: fetched.title,
        };
    }

    let key = file.storageKey;

    if (!key && file.vaultFileId) {
        const vaultFile = await ctx.runQuery(internal.knowledge.functions.getVaultFile, { vaultFileId: file.vaultFileId });

        key = vaultFile?.key;
    }

    if (!key) {
        throw new LunoraError("NOT_FOUND", "The file's stored content was not found");
    }

    const { bytes } = await readStoredObject(ctx.storage, key, { maxBytes: MAX_FILE_SIZE });

    return { chunking: chunkingFor(file.name, file.mimeType), text: await documentToText(bytes, file.mimeType, parse) };
};

// ============================================================================
// Main Ingestion Action
// ============================================================================

export const ingestFile = internalAction
    .input({
        knowledgeFileId: v.id("knowledgeFiles"),
        userId: v.string(),
    })
    .action(async ({ args, ctx }) => {
        try {
            // 1. Update status to processing — unless the file was removed
            // (or marked for removal) before its ingest got to run.
            const started = await ctx.runMutation(internal.knowledge.functions.updateFileStatus, {
                fileId: args.knowledgeFileId,
                status: "processing",
            });

            if (!started) {
                return;
            }

            // 2. Get the file metadata
            const file = await ctx.runQuery(internal.knowledge.functions.getFile, {
                fileId: args.knowledgeFileId,
            });

            if (!file) {
                throw new LunoraError("NOT_FOUND", "Knowledge file not found");
            }

            if (file.size > MAX_FILE_SIZE) {
                throw new LunoraError("PAYLOAD_TOO_LARGE", `File too large: ${file.size} bytes (max ${MAX_FILE_SIZE})`);
            }

            // 3. The text, from an upload, a stored document or a URL.
            const { chunking, text: extractedText, title } = await loadSourceText(ctx, file);

            if (!extractedText.trim()) {
                throw new LunoraError("UNPROCESSABLE", "No text content could be extracted from the file");
            }

            // 4. Chunk the extracted text
            const chunks = chunkText(extractedText, chunking);

            if (chunks.length === 0) {
                throw new LunoraError("UNPROCESSABLE", "No text content could be extracted from the file");
            }

            // 5. Generate embeddings for all chunks via LLM Gateway
            const { createGatewayEmbeddingModel } = await import("../chat/lib/gateway-embedding-model");
            const embeddingModel = createGatewayEmbeddingModel(gatewayFetch(ctx), { userId: args.userId });

            const { embedMany } = await import("../agent/client/search");
            const chunkTexts = chunks.map((c) => embeddingInput(c, EMBEDDING_INPUT_BUDGET));
            const { embeddings } = await embedMany(ctx, {
                embeddingModel,
                threadId: undefined,
                userId: args.userId,
                values: chunkTexts,
            });

            // 6. Store chunks and embeddings
            const dimension = embeddings[0]?.length ?? 768;

            validateVectorDimension(dimension);

            // Insert embeddings in batch
            const validEmbeddings = embeddings.filter(
                (embedding): embedding is number[] => embedding !== null && embedding !== undefined && embedding.length > 0,
            );
            const embeddingIds =
                validEmbeddings.length > 0
                    ? await ctx.runMutation(internal.agent.vector.insertBatch, {
                          vectorDimension: dimension as VectorDimension,
                          // Explicit `undefined`s — a `v.optional()` nested inside
                          // `v.array(v.object({…}))` renders as a REQUIRED key in the
                          // generated reference.
                          vectors: validEmbeddings.map((vector) => {
                              return {
                                  messageId: undefined,
                                  model: EMBEDDING_MODEL_NAME,
                                  table: "knowledgeChunks",
                                  threadId: undefined,
                                  userId: args.userId,
                                  vector,
                              };
                          }),
                      })
                    : [];

            // Insert chunks with their embedding IDs. Refused when the file was
            // removed while it was embedded: nothing else would ever delete
            // the vectors just written, so they go now.
            const saved = await ctx.runMutation(internal.knowledge.functions.saveChunks, {
                chunks: chunks.map((chunk, i) => {
                    return {
                        chunkIndex: chunk.index,
                        content: chunk.content,
                        embeddingId: (embeddingIds[i] as string) ?? undefined,
                        pageNumber: chunk.pageNumber,
                        sectionHeading: chunk.sectionHeading,
                        tokenCount: estimateTokens(chunk.content),
                    };
                }),
                fileId: args.knowledgeFileId,
                userId: args.userId,
            });

            if (!saved) {
                if (embeddingIds.length > 0) {
                    await ctx.runAction(internal.knowledge.delete_embeddings.deleteEmbeddingsBatch, { embeddingIds: embeddingIds as string[] });
                }

                return;
            }

            // 7. Generate auto-summary
            let summary: string | undefined;

            try {
                const { getUtilityModel } = await import("../lib/utility-model");
                // Attributed to the owner, so the gateway meters it on their account.
                const model = await getUtilityModel(gatewayFetch(ctx), { userId: args.userId });

                const summaryResult = await generateText({
                    model,
                    output: Output.object({
                        schema: z.object({ summary: z.string() }),
                    }),
                    prompt: `Summarize the following document in 2-3 sentences. Focus on the key topics and content type.

Document title: ${file.name}
Content (first 3000 chars): ${withoutPageLines(extractedText).slice(0, 3000)}`,
                });

                summary = summaryResult.output?.summary;

                ctx.log.event("knowledge.ingest_summary", {
                    inputTokens: summaryResult.usage.inputTokens,
                    outputTokens: summaryResult.usage.outputTokens,
                    summarized: summary !== undefined,
                });
            } catch {
                // Summary generation is optional
            }

            // 8. Mark as indexed
            await ctx.runMutation(internal.knowledge.functions.updateFileStatus, {
                chunkCount: chunks.length,
                fileId: args.knowledgeFileId,
                // A page is named by its title and sized by its text once fetched.
                ...(file.sourceUrl && { name: title?.slice(0, 200) || file.name, size: extractedText.length }),
                status: "indexed",
                summary,
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            console.error(`[knowledge/ingest] Failed to ingest file ${args.knowledgeFileId}:`, errorMessage);

            await ctx.runMutation(internal.knowledge.functions.updateFileStatus, {
                error: errorMessage,
                fileId: args.knowledgeFileId,
                status: "failed",
            });
        }
    });

export default ingestFile;
