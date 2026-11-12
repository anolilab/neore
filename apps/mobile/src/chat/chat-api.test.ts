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

    it.each([
        [429, true],
        [500, false],
        [502, false],
    ])("an answered %i is a refusal: %s", async (status, isRefusal) => {
        const fetch: Fetch = async () => Response.json({ error: { code: "X", message: "Slow down" } }, { status });

        await expect(startChat({ body: { model: "m", prompt: "p" }, fetch, gatewayUrl: "https://gw", jwt: "j" })).rejects.toMatchObject({
            isRefusal,
            message: "Slow down",
        });
    });

    it("keeps a refusal whose body is JSON null a refusal", async () => {
        const fetch: Fetch = async () => Response.json(null, { status: 403 });

        await expect(startChat({ body: { model: "m", prompt: "p" }, fetch, gatewayUrl: "https://gw", jwt: "j" })).rejects.toMatchObject({
            isRefusal: true,
            message: "Could not send (403).",
        });
    });
});
