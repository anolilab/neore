import { afterEach, describe, expect, it, vi } from "vitest";

import type { Fetch } from "../auth/grant";
import { CHAT_START_TIMEOUT_MS, isClientMessageIdReused, isStartInProgress, startChat } from "./chat-api";

/** What `started` rejects with. */
const failureOf = async (started: Promise<unknown>): Promise<unknown> => {
    try {
        await started;
    } catch (error) {
        return error;
    }

    throw new Error("expected the start to fail");
};

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

    it("sends the message's clientMessageId in the start's body", async () => {
        let sent: unknown;
        const fetch: Fetch = async (_url, init) => {
            sent = JSON.parse(String(init?.body));

            return Response.json({ contentType: "text", messageId: "m1", streamId: "s1", streaming: true, streamToken: "t", threadId: "t1" });
        };

        await startChat({ body: { clientMessageId: "send-1", model: "m", prompt: "p" }, fetch, gatewayUrl: "https://gw", jwt: "j" });

        expect(sent).toMatchObject({ clientMessageId: "send-1", prompt: "p" });
    });

    it("answers a resend the server already took with that send's ids and duplicate: true", async () => {
        const fetch: Fetch = async () =>
            Response.json({ contentType: "text", duplicate: true, messageId: "m1", streamId: "s1", streaming: true, streamToken: "t", threadId: "t1" });

        await expect(startChat({ body: { clientMessageId: "send-1", model: "m", prompt: "p" }, fetch, gatewayUrl: "https://gw", jwt: "j" })).resolves.toMatchObject({
            duplicate: true,
            messageId: "m1",
            threadId: "t1",
        });
    });

    // The gateway passes `/chat/start`'s SCREAMING_CASE code through; the public API spells it in snake_case.
    it.each([
        ["CHAT_START_IN_PROGRESS", { error: "CHAT_START_IN_PROGRESS", message: "This message is still being sent." }],
        ["chat_start_in_progress", { error: { code: "chat_start_in_progress", message: "This message is still being sent." } }],
    ])("reads a 409 %s as the first try still saving: no refusal, and not a failure to report", async (_code, body) => {
        const fetch: Fetch = async () => Response.json(body, { status: 409 });
        const failure = await failureOf(startChat({ body: { clientMessageId: "send-1", model: "m", prompt: "p" }, fetch, gatewayUrl: "https://gw", jwt: "j" }));

        expect(failure).toMatchObject({ code: "chat_start_in_progress", isRefusal: false, message: "This message is still being sent." });
        expect(isStartInProgress(failure)).toBe(true);
    });

    it.each([
        ["CLIENT_MESSAGE_ID_REUSED", { error: "CLIENT_MESSAGE_ID_REUSED", message: "This message id was already used for a different message." }],
        ["client_message_id_reused", { error: { code: "client_message_id_reused", message: "This message id was already used for a different message." } }],
    ])("reads a 422 %s as an id used for a different request: a refusal", async (_code, body) => {
        const fetch: Fetch = async () => Response.json(body, { status: 422 });
        const failure = await failureOf(startChat({ body: { clientMessageId: "send-1", model: "m", prompt: "p" }, fetch, gatewayUrl: "https://gw", jwt: "j" }));

        expect(failure).toMatchObject({ code: "client_message_id_reused", isRefusal: true, message: "This message id was already used for a different message." });
        expect(isClientMessageIdReused(failure)).toBe(true);
    });
});
