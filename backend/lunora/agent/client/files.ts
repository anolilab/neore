import type { AssistantContent, FilePart, ImagePart, ModelMessage, UserContent } from "ai";

import { LunoraError } from "lunorash/server";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import { assert } from "../../lib/error-helpers";
import type { Signer } from "../../lib/storage-sign";
import { signedReadUrl } from "../../lib/storage-read";
import { toStorageRef } from "../../lib/storage-ref";
import type { Message } from "../validators";
import type { ActionCtx as ActionContext, MutationCtx as MutationContext, QueryCtx as QueryContext } from "./types";
import { FETCH_TIMEOUT_LONG_MS, fetchWithDeadline } from "../../lib/fetch-timeout";

export const MAX_FILE_SIZE = 1024 * 64;

/**
 * Storage keys are content-addressed.
 *
 * Storage ids used to be minted opaquely per upload; Lunora's storage is
 * key-addressed, so the key has to be chosen here. Deriving it from the content
 * hash makes deduplication a property of the key rather than something
 * `useExistingFile` has to enforce — storing the same bytes twice is idempotent.
 *
 * The `storageId` columns keep their name and now hold this key.
 */
const storageKeyFor = (hash: string): string => `agent-files/${hash}`;

type File = {
    fileId: string;
    filename: string | undefined;
    hash: string;
    /** An R2 key since the Lunora port — see {@link storageKeyFor}. */
    storageId: string;
    url: string;
};

/**
 * Absolute ceiling on a single stored object, applied when a caller names no
 * tighter `maxSize`.
 *
 * A backstop, not a policy: the untrusted entry point (`finalizeChatUpload` in
 * `lunora/file.ts`, via `lib/chat-upload.ts`) passes the per-kind chat limit. This exists
 * so that a path which forgets to say anything still cannot push an unbounded body
 * into R2. Sized to clear the largest model-generated image comfortably.
 *
 * `ctx.storage.store` enforces it: an `ArrayBuffer`/`Blob` is rejected before the
 * upload starts, and a stream is aborted mid-transfer once the limit is passed.
 */
export const STORE_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Store a file in the file storage and return the URL and fileId.
 * @param ctx A ctx object from an action.
 * @param blob The bytes to store: a `Blob`, or an already-read buffer with its
 * type (`{ bytes, type }`) so a caller holding a large buffer stores it without
 * another copy (`file.ts#finalizeChatUpload`).
 * @param args.filename The filename to store.
 * @param args.sha256 The sha256 hash of the file. If not provided, it will be
 * computed. However, to ensure no corruption during transfer, you can
 * calculate this on the client to enforce integrity.
 * @param args.allowedContentTypes Restrict the accepted `contentType`. Callers
 * handling untrusted input should pass one — an unrestricted store accepts
 * `text/html` and `image/svg+xml`, which is stored XSS if the object is later
 * served from `publicBaseUrl`.
 * @param args.maxSize Per-call byte cap; defaults to {@link STORE_MAX_BYTES}.
 * @param args.userId The user storing the bytes. Gets an access grant, which is
 * what lets them attach the file later (`agent_files.getFileForUser`). Pass it
 * for every user-initiated store.
 * @param args.threadId The thread the stored media is for. Its OWNER is granted
 * access too: a collaborator's run can save its reply under the owner, and the
 * owner's read signs only storage they own (`agent/stored-media.ts`).
 * @returns The file, and parts to persist. `file.url` is a short-lived signed
 * URL for IMMEDIATE use; the parts carry a `storage:` reference, re-signed
 * whenever the message is read (`agent/stored-media.ts`).
 */
export const storeFile = async (
    ctx: ActionContext | MutationContext,
    blob: Blob | { bytes: ArrayBuffer; type: string },
    {
        allowedContentTypes,
        filename,
        maxSize = STORE_MAX_BYTES,
        sha256,
        threadId,
        userId,
    }: {
        allowedContentTypes?: ReadonlyArray<string>;
        filename?: string;
        maxSize?: number;
        sha256?: string;
        threadId?: string;
        userId?: string;
    } = {},
): Promise<{
    file: File;
    filePart: FilePart;
    imagePart: ImagePart | undefined;
}> => {
    if (!("runAction" in ctx) || !("storage" in ctx)) {
        throw new Error(
            "You're trying to save a file that's too large in a mutation / workflow. " +
                "You can store the file in file storage from an action first, then pass a URL instead. " +
                "To have the agent component track the file, you can use `saveFile` from an action then use the fileId with getFile in the mutation. " +
                "Read more in the docs.",
        );
    }

    // ALWAYS hashed from the bytes. This used to trust a caller-supplied
    // `sha256` and look it up BEFORE checking it, so naming another user's hash
    // returned (and, with grants, would have granted) their file without ever
    // sending its bytes. The supplied value is now only an integrity check.
    // Read once, hashed and stored from the same buffer: a second
    // `arrayBuffer()` held another full copy of a large upload at the peak.
    const buffer = blob instanceof Blob ? await blob.arrayBuffer() : blob.bytes;
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))].map((b) => b.toString(16).padStart(2, "0")).join("");

    if (sha256 && sha256 !== hash) {
        throw new Error(`Hash mismatch: ${hash} != ${sha256}`);
    }

    const reused = await ctx.runMutation(internal.agent.files.useExistingFile, {
        filename,
        hash,
        ...(userId && { userId }),
    });

    if (reused) {
        if (threadId) {
            await ctx.runMutation(internal.agent.files.grantThreadOwnerAccess, { fileId: reused.fileId, threadId });
        }

        const url = await signedReadUrl(ctx.storage, reused.storageId);

        return {
            ...getParts(toStorageRef(reused.storageId), blob.type, filename),
            file: {
                fileId: reused.fileId,
                filename,
                hash,
                storageId: reused.storageId,
                url,
            },
        };
    }

    const newStorageId = storageKeyFor(hash);

    await ctx.storage.store(newStorageId, buffer, { allowedContentTypes, contentType: blob.type, maxSize });
    const { fileId, storageId } = await ctx.runMutation(internal.agent.files.addFile, {
        filename,
        hash,
        mediaType: blob.type,
        storageId: newStorageId,
        ...(userId && { userId }),
    });

    if (threadId) {
        await ctx.runMutation(internal.agent.files.grantThreadOwnerAccess, { fileId, threadId });
    }

    const url = await signedReadUrl(ctx.storage, storageId);

    // A fresh storage id per store meant a race could leave an orphan
    // to clean up. Content-addressed keys make that impossible: a racing store
    // writes the same key with the same bytes.
    return {
        ...getParts(toStorageRef(storageId), blob.type, filename),
        file: {
            fileId,
            filename,
            hash,
            storageId,
            url,
        },
    };
};

/**
 * Get file metadata from the component.
 * This also returns filePart (and imagePart if the file is an image),
 * which are useful to construct a ModelMessage like
 * ```ts
 * const { filePart, imagePart } = await getFile(ctx, fileId);
 * const message: UserMessage = {
 *   role: "user",
 *   content: [imagePart ?? filePart],
 * };
 * ```
 * @param ctx A ctx object from an action or query.
 * @param fileId The fileId of the file to get.
 * @returns The file metadata and content parts.
 */
/**
 * A file the caller may attach, with parts ready to PERSIST.
 *
 * Access goes through `agent_files.getFileForUser` — the caller stored the
 * bytes, or the file is already on a message in `threadId` they can read.
 * This replaced a public `get` that returned any file row (extracted text
 * included) to anyone with its id; a file the caller cannot use now throws
 * NOT_FOUND, the same as one that does not exist.
 *
 * The parts carry a `storage:` reference, not a URL: `agent/stored-media.ts`
 * signs it each time the message is read. `file.url` is a signed URL for
 * immediate use only.
 */
export const getFile = async (ctx: (ActionContext | QueryContext) & { storage: Signer }, fileId: string, access: { threadId?: string; userId: string }) => {
    const file = await ctx.runQuery(internal.agent.files.getFileForUser, {
        fileId: fileId as Id<"chatFiles">,
        ...(access.threadId && { threadId: access.threadId as Id<"threads"> }),
        userId: access.userId,
    });

    if (!file) {
        throw new LunoraError("NOT_FOUND", `File not found: ${fileId}`);
    }

    const url = await signedReadUrl(ctx.storage, file.storageId);

    return {
        ...getParts(toStorageRef(file.storageId), file.mediaType, file.filename),
        extractedText: file.extractedText,
        extractionStatus: file.extractionStatus,
        file: {
            fileId,
            filename: file.filename,
            hash: file.hash,
            storageId: file.storageId,
            url,
        },
    };
};

/** Parts naming `location` — a `storage:` reference for persistence, or a URL. */
const getParts = (location: string, mediaType: string, filename: string | undefined): { filePart: FilePart; imagePart: ImagePart | undefined } => {
    const filePart: FilePart = {
        data: new URL(location),
        filename,
        mediaType,
        type: "file",
    };
    const imagePart: ImagePart | undefined = mediaType.startsWith("image/") ? { image: new URL(location), mediaType, type: "image" } : undefined;

    return { filePart, imagePart };
};

/**
 * Check if a URL points to localhost.
 */
const LOCALHOST_HOSTNAMES = new Set(["0.0.0.0", "127.0.0.1", "::1", "localhost"]);

const isLocalhostUrl = (url: URL): boolean => LOCALHOST_HOSTNAMES.has(url.hostname);

/** Whether `origin` (e.g. `PUBLIC_ORIGIN`) is a loopback address — local dev. */
export const isLocalOrigin = (origin: string | undefined): boolean => {
    if (!origin) {
        return false;
    }

    try {
        return isLocalhostUrl(new URL(origin));
    } catch {
        return false;
    }
};

/**
 * Download a file from a URL.
 *
 * Defense-in-depth: this helper is intentionally restricted to http(s)
 * localhost URLs. It is used to inline file content from the local
 * dev server before forwarding to the model — passing any other URL would
 * be an SSRF risk (attacker-controlled `image.url` / `file.url` parts in
 * message content would otherwise become an exfiltration sink for internal
 * services).
 */
const downloadFile = async (url: URL): Promise<ArrayBuffer> => {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`Refusing to download non-HTTP URL: ${url.protocol}`);
    }

    if (!isLocalhostUrl(url)) {
        throw new Error(`Refusing to download non-localhost URL: ${url.hostname}`);
    }

    const response = await fetchWithDeadline(url, { timeoutMs: FETCH_TIMEOUT_LONG_MS });

    if (!response.ok) {
        await response.body?.cancel();

        throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
    }

    return await response.arrayBuffer();
};

/**
 * Process messages to inline file and image URLs that point to localhost
 * by converting them to base64. This solves the problem of LLMs not being
 * able to access localhost URLs.
 */
export const inlineMessagesFiles = async <T extends ModelMessage | Message>(messages: T[]): Promise<T[]> =>
    // Process each message to convert localhost URLs to base64
    Promise.all(
        messages.map(async (message): Promise<T> => {
            if ((message.role !== "user" && message.role !== "assistant") || typeof message.content === "string" || !Array.isArray(message.content)) {
                return message;
            }

            const processedContent = await Promise.all(
                message.content.map(async (part) => {
                    if (part.type === "image" && part.image instanceof URL) {
                        assert(message.role === "user", "Images can only be in user messages");

                        if (isLocalhostUrl(part.image)) {
                            const imageData = await downloadFile(part.image);

                            return { ...part, image: imageData } as ImagePart;
                        }
                    }

                    // Handle file parts
                    if (part.type === "file" && part.data instanceof URL && isLocalhostUrl(part.data)) {
                        const fileData = await downloadFile(part.data);

                        return { ...part, data: fileData } as FilePart;
                    }

                    return part;
                }),
            );

            if (message.role === "user") {
                return { ...message, content: processedContent as UserContent };
            }

            return { ...message, content: processedContent as AssistantContent };
        }),
    );
