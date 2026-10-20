import { afterEach, describe, expect, it, vi } from "vitest";

import type { Fetch } from "../auth/grant";
import { CHAT_START_TIMEOUT_MS, ChatError, startChat } from "./chat-api";

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
        const assertion = expect(started).rejects.toBeInstanceOf(ChatError);

        await vi.advanceTimersByTimeAsync(CHAT_START_TIMEOUT_MS);
        await assertion;
    });
});
