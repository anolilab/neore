/**
 * What a failed `addDocuments` batch means for the rest of an import.
 *
 * - `retry`: the per-document rate limit (`knowledge/addDocument`) is spent;
 *   wait `afterMs` and send the SAME batch again — a large folder on the free
 *   tier reaches it after about two batches.
 * - `quota`: the per-user knowledge quota is full; every later batch would fail
 *   the same way, so the import stops.
 * - `failed`: anything else; the batch counts as failed and the import goes on.
 */
export type ImportBatchOutcome = { afterMs: number; kind: "retry" } | { kind: "failed" } | { kind: "quota"; message?: string };

/** Longest wait honoured for one rate-limited batch; a longer one counts the batch as failed. */
export const MAX_BATCH_RETRY_WAIT_MS = 60_000;

const DEFAULT_RETRY_WAIT_MS = 2000;

export const classifyImportBatchError = (error: unknown): ImportBatchOutcome => {
    const data =
        typeof error === "object" && error !== null ? (error as { data?: { code?: unknown; message?: unknown; retryAfter?: unknown } }).data : undefined;

    if (data?.code === "KNOWLEDGE_QUOTA_EXCEEDED") {
        return { kind: "quota", ...(typeof data.message === "string" && { message: data.message }) };
    }

    if (data?.code === "TOO_MANY_REQUESTS") {
        const afterMs = typeof data.retryAfter === "number" && data.retryAfter > 0 ? data.retryAfter : DEFAULT_RETRY_WAIT_MS;

        return afterMs <= MAX_BATCH_RETRY_WAIT_MS ? { afterMs, kind: "retry" } : { kind: "failed" };
    }

    return { kind: "failed" };
};

/**
 * The user-facing reason a single knowledge write (a URL, an uploaded file)
 * failed, from the server's error code — so the caller shows a translated
 * sentence instead of the server's English message.
 */
export const knowledgeErrorKind = (error: unknown): "other" | "quota" | "rate-limited" => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } };
    const codes = new Set([code, data?.code]);

    if (codes.has("KNOWLEDGE_QUOTA_EXCEEDED")) {
        return "quota";
    }

    return codes.has("TOO_MANY_REQUESTS") ? "rate-limited" : "other";
};
