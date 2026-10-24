/**
 * Send a file to the backend's upload route (`backend/lunora/lib/upload-route.ts`)
 * over TUS — chunked and resumable, with progress — and answer its upload id,
 * which the finalize procedures take: `file.finalizeChatUpload`,
 * `vault_functions.saveVaultFile`, `chat_import_functions.startImportJob`.
 *
 * The session's bearer token rides the `Authorization` header of every request,
 * never the URL. It is read once per upload: a 25 MB file finishes well inside
 * the token's lifetime.
 */
import { createTusAdapter } from "@lunora/client/upload";

import getSessionToken from "@/lib/auth/server-functions";
import env from "@/lib/env";
import { acquireUnloadGuard } from "@/lib/unload-guard";

import { failureFor, UploadFailedError } from "./upload-error";

/** The HTTP status the TUS client's error carries, or 0 for a transport failure. */
const statusOf = (error: unknown): number =>
    typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 0;

export interface UploadFileOptions {
    /** The type the file is stored, and checked, as — `file.type` is empty for some extensions. */
    contentType: string;

    /** Whole percent, 0–100, as bytes are acknowledged by the server. */
    onProgress?: (percent: number) => void;

    /**
     * What the file is for, declared on the create. `reference-media` takes a
     * workflow's video and audio (`document-limits.ts`); absent is a chat
     * attachment, which refuses those types.
     */
    purpose?: "reference-media";
    signal?: AbortSignal;
}

const sendFile = async (file: File, { contentType, onProgress, purpose, signal }: UploadFileOptions): Promise<string> => {
    const token = await getSessionToken();
    const endpoint = new URL("/uploads", env.VITE_LUNORA_URL);

    if (purpose) {
        endpoint.searchParams.set("purpose", purpose);
    }

    const adapter = createTusAdapter({
        endpoint: endpoint.href,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        // `mimeType` wins over the client's own `filetype` (= `file.type`) on the server.
        metadata: { mimeType: contentType },
    });

    if (onProgress) {
        adapter.setOnProgress((percent) => onProgress(Math.min(100, percent)));
    }

    signal?.addEventListener("abort", () => adapter.abort(), { once: true });

    try {
        const { id } = await adapter.upload(file);

        return id;
    } catch (error) {
        if (signal?.aborted) {
            throw new DOMException("The upload was aborted", "AbortError");
        }

        const status = statusOf(error);

        throw new UploadFailedError(failureFor(status), status, error);
    }
};

export const uploadFile = async (file: File, options: UploadFileOptions): Promise<string> => {
    if (options.signal?.aborted) {
        throw new DOMException("The upload was aborted", "AbortError");
    }

    // The bytes leave from this tab, so closing it ends the upload.
    const releaseUnloadGuard = acquireUnloadGuard();

    try {
        return await sendFile(file, options);
    } finally {
        releaseUnloadGuard();
    }
};
