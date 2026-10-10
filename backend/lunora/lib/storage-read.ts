/**
 * Server-side reads of stored objects — through `ctx.storage`, never over HTTP.
 *
 * Ingestion, extraction, NSFW checks and chat import all used to fetch the
 * object back from `R2_PUBLIC_URL_BASE/<key>`, which required every user file
 * to be publicly readable by anyone who learned its key, and failed outright
 * wherever that variable was unset. The R2 binding is right here; reading
 * through it needs no public bucket, no network hop and no URL.
 *
 * When bytes must leave for a third party that fetches by URL (a model provider
 * resolving an attachment), use `signedReadUrl`: a short-lived signed GET that
 * `lib/signed-storage.ts` serves.
 */
import { LunoraError } from "lunorash/server";

import type { Signer } from "./storage-sign";

/** The slice of `ctx.storage` a reader needs. */
export interface StorageReader {
    download: (key: string) => Promise<{
        body: ReadableStream | null;
        httpMetadata?: { contentType?: string };
        size: number;
    } | null>;
}

/**
 * How long an attachment URL handed to a model provider stays valid. Long
 * enough for a slow multi-step run (Deep Work caps at 25 steps); short enough
 * that a URL persisted in a message is useless to anyone who later reads it.
 */
export const ATTACHMENT_URL_TTL_SECONDS = 60 * 60;

/** Default ceiling for a server-side read: the largest upload any path accepts, with room. */
export const MAX_STORED_READ_BYTES = 50 * 1024 * 1024;

export interface StoredObject {
    bytes: ArrayBuffer;
    contentType: string | undefined;
}

/**
 * The object's bytes, or `NOT_FOUND`. Refuses — before reading the body — an
 * object larger than `maxBytes`, so an oversized file costs no memory.
 */
export const readStoredObject = async (storage: StorageReader | undefined, key: string, options: { maxBytes: number }): Promise<StoredObject> => {
    if (!storage) {
        throw new LunoraError("INTERNAL", "Storage is not configured");
    }

    const object = await storage.download(key);

    if (!object) {
        throw new LunoraError("NOT_FOUND", `Stored object not found: ${key}`);
    }

    if (object.size > options.maxBytes) {
        await object.body?.cancel();

        throw new LunoraError("PAYLOAD_TOO_LARGE", `Stored object is ${String(object.size)} bytes (max ${String(options.maxBytes)})`);
    }

    const bytes = object.body ? await new Response(object.body).arrayBuffer() : new ArrayBuffer(0);

    return { bytes, contentType: object.httpMetadata?.contentType };
};

export const readStoredText = async (storage: StorageReader | undefined, key: string, options: { maxBytes: number }): Promise<string> => {
    const { bytes } = await readStoredObject(storage, key, options);

    return new TextDecoder().decode(bytes);
};

/** A short-lived signed GET URL for a third party that must fetch the object itself. */
export const signedReadUrl = async (storage: Signer | undefined, key: string, expiresInSeconds: number = ATTACHMENT_URL_TTL_SECONDS): Promise<string> => {
    if (!storage) {
        throw new LunoraError("INTERNAL", "Storage is not configured");
    }

    return await storage.getSignedUrl(key, { expiresInSeconds });
};
