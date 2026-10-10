import { describe, expect, it } from "vitest";

import { classifyImportBatchError, knowledgeErrorKind, MAX_BATCH_RETRY_WAIT_MS } from "./import-batch-error";

describe(classifyImportBatchError, () => {
    it("retries a rate-limited batch after the server's wait", () => {
        expect(classifyImportBatchError({ data: { code: "TOO_MANY_REQUESTS", retryAfter: 1500 } })).toStrictEqual({ afterMs: 1500, kind: "retry" });
    });

    it("waits a default when the server names no wait", () => {
        expect(classifyImportBatchError({ data: { code: "TOO_MANY_REQUESTS" } })).toMatchObject({ kind: "retry" });
    });

    it("gives up on a wait longer than the cap", () => {
        expect(classifyImportBatchError({ data: { code: "TOO_MANY_REQUESTS", retryAfter: MAX_BATCH_RETRY_WAIT_MS + 1 } })).toStrictEqual({ kind: "failed" });
    });

    it("stops the import at the knowledge quota, keeping the server's message", () => {
        expect(classifyImportBatchError({ data: { code: "KNOWLEDGE_QUOTA_EXCEEDED", message: "300 files" } })).toStrictEqual({
            kind: "quota",
            message: "300 files",
        });
    });

    it("counts anything else as a failed batch", () => {
        expect(classifyImportBatchError(new Error("boom"))).toStrictEqual({ kind: "failed" });
        expect(classifyImportBatchError(undefined)).toStrictEqual({ kind: "failed" });
    });
});

describe(knowledgeErrorKind, () => {
    it("names the quota and the rate limit by their codes", () => {
        expect(knowledgeErrorKind({ data: { code: "KNOWLEDGE_QUOTA_EXCEEDED", message: "300 files" } })).toBe("quota");
        expect(knowledgeErrorKind({ data: { code: "TOO_MANY_REQUESTS", retryAfter: 1000 } })).toBe("rate-limited");
        expect(knowledgeErrorKind({ code: "TOO_MANY_REQUESTS" })).toBe("rate-limited");
    });

    it("leaves anything else to the caller's own message", () => {
        expect(knowledgeErrorKind(new Error("Invalid URL"))).toBe("other");
        expect(knowledgeErrorKind(null)).toBe("other");
    });
});
