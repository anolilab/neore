import { describe, expect, it, vi } from "vitest";

import { isTransportFailure, withTransportRetry } from "./job-dispatch";

const codedError = (code: string): Error => Object.assign(new Error(code), { code });

describe("withTransportRetry", () => {
    it("retries a transport failure once, at once", async () => {
        const dispatch = vi.fn().mockRejectedValueOnce(new Error("Network connection lost.")).mockResolvedValueOnce(undefined);

        await expect(withTransportRetry(dispatch, "chat_execute:runStreamingAgent", 0)).resolves.toBeUndefined();
        expect(dispatch).toHaveBeenCalledTimes(2);
    });

    it("hands a second transport failure back to the queue", async () => {
        const dispatch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

        await expect(withTransportRetry(dispatch, "chat_execute:runStreamingAgent", 0)).rejects.toThrow("fetch failed");
        expect(dispatch).toHaveBeenCalledTimes(2);
    });

    it("does not retry the function's own error", async () => {
        const dispatch = vi.fn().mockRejectedValue(codedError("FORBIDDEN"));

        await expect(withTransportRetry(dispatch, "chat_execute:runStreamingAgent", 0)).rejects.toThrow("FORBIDDEN");
        expect(dispatch).toHaveBeenCalledTimes(1);
    });
});

describe("isTransportFailure", () => {
    it("tells a transport error from a coded one", () => {
        expect(isTransportFailure(new Error("Network connection lost."))).toBe(true);
        expect(isTransportFailure(codedError("INTERNAL"))).toBe(false);
        // What local dev's proxy answers for a dropped connection: a bare 500.
        const bare500 = Object.assign(new Error("@lunora/queue: function dispatch failed (500): Error: Network connection lost."), { code: "INTERNAL" });

        expect(isTransportFailure(bare500)).toBe(true);
        // A function's own error arrives in its envelope, with its own message.
        expect(isTransportFailure(Object.assign(new Error("Thread not found"), { code: "NOT_FOUND" }))).toBe(false);
    });
});
