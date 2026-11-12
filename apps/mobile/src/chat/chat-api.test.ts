import { afterEach, describe, expect, it, vi } from "vitest";

import type { Fetch } from "../auth/grant";
import { CHAT_START_TIMEOUT_MS, startChat } from "./chat-api";

describe("startChat", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("fails with a ChatError when the gateway never answers", async () => {
        vi.useFakeTimers();

        const fetch: Fetch = (_url, init) =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            });

        const started = startChat({ body: { model: "m", prompt: "p" }, fetch, gatewayUrl: "https://gw", jwt: "j" });
        // The request may have reached the gateway: a timeout is not a refusal.
        const assertion = expect(started).rejects.toMatchObject({ isRefusal: false, name: "ChatError" });

        await vi.advanceTimersByTimeAsync(CHAT_START_TIMEOUT_MS);
        await assertion;
    });

    it("marks an answered non-2xx as a refusal", async () => {
        const fetch: Fetch = async () => Response.json({ error: { code: "RATE_LIMITED", message: "Slow down" } }, { status: 429 });

        await expect(startChat({ body: { model: "m", prompt: "p" }, fetch, gatewayUrl: "https://gw", jwt: "j" })).rejects.toMatchObject({
            isRefusal: true,
            message: "Slow down",
        });
    });
});
