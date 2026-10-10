/**
 * Checks shared by every way a document enters the knowledge base: an upload
 * (`addFile`), a batch of documents from a folder or a Notion export
 * (`addDocuments`), and a URL (`addUrl`). Pure apart from the collection
 * lookup, and tested in `documents.test.ts`.
 */
import { LunoraError } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** Documents one `addDocuments` call takes. */
export const MAX_DOCUMENTS_PER_BATCH = 25;
/** Largest single document, decoded. */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
/** Sum of a batch's content as sent (base64 counted as sent), so one call stays one modest RPC body. */
export const MAX_BATCH_CHARS = 8 * 1024 * 1024;
/**
 * Longest `content` string the argument validator admits: a
 * `MAX_DOCUMENT_BYTES` document in base64, plus padding slack. Deliberately
 * loose — `validateDocumentBatch` measures the DECODED size and names the
 * file, where a validator failure would reject the whole batch unnamed. The
 * content goes to R2, never into a row.
 */
export const MAX_DOCUMENT_CONTENT_CHARS = Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 4;
export const MAX_DOCUMENT_NAME = 255;
export const MAX_RELATIVE_PATH = 1024;

/** What a document may be: text the ingest reads directly, or a format the document parser handles. */
const ACCEPTED_MIME_TYPES = new Set([
    "application/json",
    "application/msword",
    "application/pdf",
    "application/rtf",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/xhtml+xml",
    "application/xml",
    "application/yaml",
]);

export const isAcceptedDocumentType = (mimeType: string): boolean => {
    const base = mimeType.split(";", 1)[0]!.trim().toLowerCase();

    return base.startsWith("text/") || ACCEPTED_MIME_TYPES.has(base);
};

/**
 * A folder-relative path as stored: `/`-separated, no empty, `.` or `..`
 * segments, capped. `undefined` for nothing usable — it is only a label.
 */
export const normalizeRelativePath = (path: string | undefined): string | undefined => {
    if (!path) {
        return undefined;
    }

    const segments = path
        .replaceAll("\\", "/")
        .split("/")
        .map((segment) => segment.trim())
        .filter((segment) => segment !== "" && segment !== "." && segment !== "..");

    const joined = segments.join("/");

    return joined ? joined.slice(0, MAX_RELATIVE_PATH) : undefined;
};

/** Decoded size of a document's content. */
export const decodedDocumentBytes = (document: { content: string; encoding: "base64" | "utf8" }): number => {
    if (document.encoding === "utf8") {
        return new TextEncoder().encode(document.content).length;
    }

    let padding = 0;

    if (document.content.endsWith("==")) {
        padding = 2;
    } else if (document.content.endsWith("=")) {
        padding = 1;
    }

    return Math.floor((document.content.length * 3) / 4) - padding;
};

export interface DocumentInput {
    content: string;
    encoding: "base64" | "utf8";
    mimeType: string;
    name: string;
    relativePath?: string;
}

/** Throws BAD_REQUEST / PAYLOAD_TOO_LARGE for a batch `addDocuments` must refuse. */
export const validateDocumentBatch = (documents: ReadonlyArray<DocumentInput>): void => {
    if (documents.length === 0) {
        throw new LunoraError("BAD_REQUEST", "No documents to add");
    }

    if (documents.length > MAX_DOCUMENTS_PER_BATCH) {
        throw new LunoraError("BAD_REQUEST", `Add at most ${String(MAX_DOCUMENTS_PER_BATCH)} documents at a time`);
    }

    let total = 0;

    for (const document of documents) {
        const name = document.name.trim();

        if (!name || name.length > MAX_DOCUMENT_NAME) {
            throw new LunoraError("BAD_REQUEST", `Document names are 1-${String(MAX_DOCUMENT_NAME)} characters`);
        }

        if (!isAcceptedDocumentType(document.mimeType)) {
            throw new LunoraError("BAD_REQUEST", `${name}: ${document.mimeType || "this file type"} is not supported`);
        }

        if (document.content.length === 0) {
            throw new LunoraError("BAD_REQUEST", `${name} is empty`);
        }

        if (decodedDocumentBytes(document) > MAX_DOCUMENT_BYTES) {
            throw new LunoraError("PAYLOAD_TOO_LARGE", `${name} is larger than ${String(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB`);
        }

        total += document.content.length;
    }

    if (total > MAX_BATCH_CHARS) {
        throw new LunoraError("PAYLOAD_TOO_LARGE", "This batch is too large; send fewer documents at a time");
    }
};

/** A `collectionId` to file into must be the caller's OWN collection (files live on the owner's shard). */
export const requireOwnCollectionId = async (
    db: MutationCtx["db"] | QueryCtx["db"],
    collectionId: Id<"knowledgeCollections"> | undefined,
    userId: string,
): Promise<void> => {
    if (!collectionId) {
        return;
    }

    const collection = await db.knowledgeCollections.findFirst({ where: { _id: collectionId } });

    if (!collection || collection.userId !== userId) {
        throw new LunoraError("NOT_FOUND", "Collection not found");
    }
};
