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

import { failureFor, UploadFailedError } from "./upload-error";

/** The HTTP status the TUS client's error carries, or 0 for a transport failure. */
const statusOf = (error: unknown): number =>
    typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 0;

export interface UploadFileOptions {
    /** The type the file is stored, and checked, as — `file.type` is empty for some extensions. */
    contentType: string;
    /** Whole percent, 0–100, as bytes are acknowledged by the server. */
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
}

export const uploadFile = async (file: File, { contentType, onProgress, signal }: UploadFileOptions): Promise<string> => {
    if (signal?.aborted) {
        throw new DOMException("The upload was aborted", "AbortError");
    }

    const token = await getSessionToken();
    const adapter = createTusAdapter({
        endpoint: new URL("/uploads", env.VITE_LUNORA_URL).href,
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
