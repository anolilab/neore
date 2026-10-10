/**
 * Adding documents that are not vault uploads: a batch of files from a folder
 * upload or a Notion export, and a web page by URL.
 *
 * A folder can hold hundreds of files, and the vault path costs two
 * rate-limited calls per file (`vault/upload`), so a batch skips the vault:
 * the content comes in the call, is stored under `knowledge/<userId>/…`
 * (`knowledgeFiles.storageKey`, removed with the file) and ingested like an
 * upload. A batch is charged one `knowledge/addDocument` token per document,
 * and every add is checked against the per-user quota (`quota.ts`).
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalMutation } from "../_generated/server";
import { isSafeUrl } from "../chat/tools/utilities";
import { authAction, authMutation, rateLimit } from "../lib/crpc";
import {
    decodedDocumentBytes,
    MAX_DOCUMENT_BYTES,
    MAX_DOCUMENT_CONTENT_CHARS,
    normalizeRelativePath,
    requireOwnCollectionId,
    validateDocumentBatch,
} from "./documents-shared";
import { rateLimitGuard } from "../lib/rate-limiter";
import { assertKnowledgeQuota, knowledgeTierOf } from "./quota";
import { MAX_URL_LENGTH, normalizeIngestUrl } from "./sources";
import { MAX_LENGTH } from "../lib/validators";
import { withDependency } from "../lib/dependency";

const STORED_CONTENT_TYPE = "application/octet-stream";

const decodeContent = (document: { content: string; encoding: "base64" | "utf8" }): ArrayBuffer => {
    if (document.encoding === "utf8") {
        return new Uint8Array(new TextEncoder().encode(document.content)).buffer;
    }

    try {
        return Uint8Array.from(atob(document.content), (character) => character.codePointAt(0)!).buffer;
    } catch {
        throw new LunoraError("BAD_REQUEST", "A document's base64 content is malformed");
    }
};

/** A page's provisional name until its title is known: host and path. */
const nameFromUrl = (url: string): string => {
    const parsed = new URL(url);

    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`.slice(0, 200);
};

/**
 * Inserts the rows for documents already stored, and schedules each one's
 * ingestion. Refuses a collection that is not the caller's before inserting
 * anything; the action then removes the objects it stored.
 */
export const insertStoredDocuments = internalMutation
    .input({
        collectionId: v.optional(v.id("knowledgeCollections")),
        documents: v.array(
            v.object({
                mimeType: v.string(),
                name: v.string(),
                relativePath: v.optional(v.string()),
                size: v.number(),
                storageKey: v.string(),
            }),
        ),
        tier: v.union(v.literal("free"), v.literal("premium")),
        userId: v.string(),
    })
    .output(v.array(v.id("knowledgeFiles")))
    .mutation(async ({ args, ctx }) => {
        await requireOwnCollectionId(ctx.db, args.collectionId, args.userId);
        await assertKnowledgeQuota(ctx, args.userId, args.tier, {
            bytes: args.documents.reduce((total, document) => total + document.size, 0),
            files: args.documents.length,
        });

        const ids = [];

        for (const document of args.documents) {
            const knowledgeFileId = await ctx.db.insert("knowledgeFiles", {
                collectionId: args.collectionId,
                createdAt: ctx.now,
                mimeType: document.mimeType,
                name: document.name,
                relativePath: document.relativePath,
                size: document.size,
                status: "pending",
                storageKey: document.storageKey,
                userId: args.userId,
            });

            await ctx.scheduler.runAfter(0, internal.knowledge.ingest.ingestFile, { knowledgeFileId, userId: args.userId });
            ids.push(knowledgeFileId);
        }

        return ids;
    });

/**
 * Adds up to 25 documents, each sent as UTF-8 text or base64 bytes, into the
 * caller's knowledge base (and optionally one of their collections), keeping
 * each one's folder-relative path. See the module comment for why this is not
 * the vault path.
 */
export const addDocuments = authAction
    .use(rateLimit("knowledge/addDocument"))
    .input({
        collectionId: v.optional(v.id("knowledgeCollections")),
        documents: v.array(
            v.object({
                content: v.string().max(MAX_DOCUMENT_CONTENT_CHARS),
                encoding: v.union(v.literal("utf8"), v.literal("base64")),
                mimeType: v.string().max(MAX_LENGTH.short),
                name: v.string().max(MAX_LENGTH.short),
                relativePath: v.optional(v.string().max(MAX_LENGTH.key)),
            }),
        ),
    })
    .output(v.array(v.id("knowledgeFiles")))
    .action(async ({ args, ctx }) => {
        const { userId } = ctx.user;

        validateDocumentBatch(args.documents);

        // One token per document: each is its own ingestion (parse, embed,
        // summarise). The middleware took the first; the rest are taken here.
        if (args.documents.length > 1) {
            await rateLimitGuard({ ...ctx, count: args.documents.length - 1, rateLimitKey: "knowledge/addDocument", user: ctx.user } as never);
        }

        const stored: { mimeType: string; name: string; relativePath?: string; size: number; storageKey: string }[] = [];

        try {
            for (const document of args.documents) {
                const bytes = decodeContent(document);
                const storageKey = `knowledge/${userId}/${crypto.randomUUID()}`;
                const mimeType = document.mimeType.split(";", 1)[0]!.trim().toLowerCase();

                // Stored opaque: ingestion reads the row's `mimeType`, and nothing may serve it as HTML.
                await withDependency("file storage", () =>
                    ctx.storage.store(storageKey, bytes, {
                        allowedContentTypes: [STORED_CONTENT_TYPE],
                        contentType: STORED_CONTENT_TYPE,
                        maxSize: MAX_DOCUMENT_BYTES,
                    }),
                );
                stored.push({
                    mimeType,
                    name: document.name.trim(),
                    relativePath: normalizeRelativePath(document.relativePath),
                    size: decodedDocumentBytes(document),
                    storageKey,
                });
            }

            const insertedIds = await ctx.runMutation(internal.knowledge.documents.insertStoredDocuments, {
                collectionId: args.collectionId,
                documents: stored,
                tier: knowledgeTierOf(ctx.user),
                userId,
            });

            ctx.log.event("knowledge.add_documents", { documentCount: args.documents.length, storedCount: insertedIds.length });

            return insertedIds;
        } catch (error) {
            await Promise.allSettled(stored.map(async ({ storageKey }) => await ctx.storage.delete(storageKey)));

            throw error;
        }
    });

/**
 * Adds a web page by URL. Only public http(s) URLs pass (`isSafeUrl`, the
 * tools' SSRF guard); the fetch itself happens in ingestion, where every
 * redirect hop is re-checked (`sources.ts`).
 */
export const addUrl = authMutation
    .use(rateLimit("knowledge/add"))
    .input({
        collectionId: v.optional(v.id("knowledgeCollections")),
        url: v.string().check((value) => value.length <= MAX_URL_LENGTH, { message: "URL is too long", schema: { maxLength: MAX_URL_LENGTH } }),
    })
    .output(v.id("knowledgeFiles"))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const url = normalizeIngestUrl(args.url, isSafeUrl);

        await requireOwnCollectionId(ctx.db, args.collectionId, userId);
        await assertKnowledgeQuota(ctx, userId, knowledgeTierOf(ctx.user), { bytes: 0, files: 1 });

        const knowledgeFileId = await ctx.db.insert("knowledgeFiles", {
            collectionId: args.collectionId,
            createdAt: ctx.now,
            mimeType: "text/html",
            name: nameFromUrl(url),
            size: 0,
            sourceUrl: url,
            status: "pending",
            userId,
        });

        await ctx.scheduler.runAfter(0, internal.knowledge.ingest.ingestFile, { knowledgeFileId, userId });

        ctx.log.event("knowledge.add_url", { collectionAttached: args.collectionId !== undefined });

        return knowledgeFileId;
    });
