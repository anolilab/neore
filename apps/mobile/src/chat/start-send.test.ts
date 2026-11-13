import { describe, expect, it, vi } from "vitest";

import type { StartedChat } from "./chat-api";
import { ChatError } from "./chat-api";
import {
    clientMessageIdFor,
    replyStreamOf,
    START_IN_PROGRESS_RETRY_MS,
    START_IN_PROGRESS_WAIT_MS,
    START_UNKNOWN_RETRY_DELAYS_MS,
    startWithRetries,
} from "./start-send";

const STARTED: StartedChat = { contentType: "text", messageId: "m1", streamId: "s1", streaming: true, streamToken: "t", threadId: "t1" };
const IN_PROGRESS = new ChatError("This message is still being sent.", { code: "chat_start_in_progress" });

/** A clock that `sleep` moves forward, so a wait takes no real time. */
const fakeClock = () => {
    let time = 0;
    const sleeps: number[] = [];

    return {
        now: () => time,
        sleep: async (ms: number) => {
            sleeps.push(ms);
            time += ms;
        },
        sleeps,
    };
};

describe(clientMessageIdFor, () => {
    const newId = vi.fn(() => "new-id");

    it("reuses the held id when the same prompt is sent again", () => {
        expect(clientMessageIdFor({ clientMessageId: "first-id", prompt: "hello" }, "hello", newId)).toBe("first-id");
    });

    it("gives a new id to a different prompt, and to a send with nothing held", () => {
        expect(clientMessageIdFor({ clientMessageId: "first-id", prompt: "hello" }, "hello again", newId)).toBe("new-id");
        expect(clientMessageIdFor(null, "hello", newId)).toBe("new-id");
    });
});

describe(startWithRetries, () => {
    it("waits out a first try still being saved and opens the chat the resend answers with", async () => {
        const clock = fakeClock();
        const attempt = vi
            .fn<() => Promise<StartedChat>>()
            .mockRejectedValueOnce(IN_PROGRESS)
            .mockRejectedValueOnce(IN_PROGRESS)
            .mockResolvedValueOnce({ ...STARTED, duplicate: true });

        await expect(startWithRetries({ attempt, ...clock })).resolves.toMatchObject({ duplicate: true, messageId: "m1", threadId: "t1" });
        expect(attempt).toHaveBeenCalledTimes(3);
        expect(clock.sleeps).toStrictEqual([START_IN_PROGRESS_RETRY_MS, START_IN_PROGRESS_RETRY_MS]);
    });

    it("stops waiting once the first try outlasts the server's lease", async () => {
        const clock = fakeClock();
        const attempt = vi.fn<() => Promise<StartedChat>>().mockRejectedValue(IN_PROGRESS);

        await expect(startWithRetries({ attempt, ...clock })).rejects.toBe(IN_PROGRESS);
        expect(clock.now()).toBeGreaterThanOrEqual(START_IN_PROGRESS_WAIT_MS);
    });

    it("never retries an id the server says belongs to a different request", async () => {
        const reused = new ChatError("Used for another message.", { code: "client_message_id_reused", isRefusal: true });
        const attempt = vi.fn<() => Promise<StartedChat>>().mockRejectedValue(reused);

        await expect(startWithRetries({ attempt, ...fakeClock() })).rejects.toBe(reused);
        expect(attempt).toHaveBeenCalledOnce();
    });

    it("never retries a refusal", async () => {
        const refused = new ChatError("Daily limit reached.", { isRefusal: true });
        const attempt = vi.fn<() => Promise<StartedChat>>().mockRejectedValue(refused);

        await expect(startWithRetries({ attempt, ...fakeClock() })).rejects.toBe(refused);
        expect(attempt).toHaveBeenCalledOnce();
    });

    it("sends a try with no answer again, a bounded number of times", async () => {
        const clock = fakeClock();
        const timeout = new ChatError("The gateway did not answer in time.");
        const attempt = vi.fn<() => Promise<StartedChat>>().mockRejectedValueOnce(timeout).mockResolvedValueOnce(STARTED);

        await expect(startWithRetries({ attempt, ...clock })).resolves.toBe(STARTED);

        const failing = vi.fn<() => Promise<StartedChat>>().mockRejectedValue(new TypeError("Network request failed"));

        await expect(startWithRetries({ attempt: failing, ...fakeClock() })).rejects.toThrow("Network request failed");
        expect(failing).toHaveBeenCalledTimes(START_UNKNOWN_RETRY_DELAYS_MS.length + 1);
    });

    it("stops at once when the send is stopped", async () => {
        const controller = new AbortController();
        const attempt = vi.fn<() => Promise<StartedChat>>().mockImplementation(async () => {
            controller.abort();

            throw IN_PROGRESS;
        });

        await expect(startWithRetries({ attempt, signal: controller.signal, ...fakeClock() })).rejects.toBe(IN_PROGRESS);
        expect(attempt).toHaveBeenCalledOnce();
    });
});

describe(replyStreamOf, () => {
    it("follows the reply stream of a start that has one", () => {
        expect(replyStreamOf(STARTED)).toStrictEqual({ streamId: "s1", streamToken: "t" });
        expect(replyStreamOf({ ...STARTED, duplicate: true })).toStrictEqual({ streamId: "s1", streamToken: "t" });
    });

    it("follows nothing for a resend answered with no stream, whose reply the chat's saved messages show", () => {
        const delivered: StartedChat = { contentType: "text", duplicate: true, messageId: "m1", streamId: null, streaming: false, threadId: "t1" };

        expect(replyStreamOf(delivered)).toBeUndefined();
    });
});
