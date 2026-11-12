import { TransportError } from "@lunora/client";
import { describe, expect, it } from "vitest";

import type { CheckResult, PossiblySent } from "./possibly-sent";
import { checkPossiblySent, createPossiblySentStore, entriesFor, hasPrompt, POSSIBLY_SENT_WINDOW_MS } from "./possibly-sent";

const SENT_AT = 1_000_000;

const entry = (extra: Partial<PossiblySent> = {}): PossiblySent => {
    return {
        accountId: "a",
        failedAt: SENT_AT + 15_000,
        id: "user-1",
        knownMessageIds: new Set(["old"]),
        prompt: "hello",
        sentAt: SENT_AT,
        threadId: undefined,
        ...extra,
    };
};

describe(hasPrompt, () => {
    it.each([
        ["the prompt sent by this send", { createdAt: SENT_AT + 500, id: "m1", role: "user", text: "hello\n" }, true],
        ["a message created a little before it, by the server's clock", { createdAt: SENT_AT - 60_000, id: "m1", role: "user", text: "hello" }, true],
        ["the same words sent long before", { createdAt: SENT_AT - 600_000, id: "m1", role: "user", text: "hello" }, false],
        ["a message that was on screen before the send", { createdAt: SENT_AT + 500, id: "old", role: "user", text: "hello" }, false],
        ["the reply", { createdAt: SENT_AT + 500, id: "m2", role: "assistant", text: "hello" }, false],
        ["other words", { createdAt: SENT_AT + 500, id: "m1", role: "user", text: "hello there" }, false],
    ])("%s: %s", (_name, message, expected) => {
        expect(hasPrompt([message], entry())).toBe(expected);
    });
});

describe(checkPossiblySent, () => {
    it("finds a new chat by its first message, reading only chats created since the send", async () => {
        const read: string[] = [];
        const result = await checkPossiblySent(entry(), {
            newestMessages: async (threadId) => {
                read.push(threadId);

                return threadId === "t-new" ? [{ createdAt: SENT_AT + 1000, id: "m1", role: "user", text: "hello" }] : [];
            },
            newestThreads: async () => [
                { createdAt: SENT_AT + 2000, id: "t-other" },
                { createdAt: SENT_AT + 1000, id: "t-new" },
                { createdAt: SENT_AT - 600_000, id: "t-old" },
            ],
        });

        expect(result).toStrictEqual({ kind: "found", threadId: "t-new" });
        expect(read).toStrictEqual(["t-other", "t-new"]);
    });

    it("reads the chat itself for a send to an existing chat", async () => {
        const result = await checkPossiblySent(entry({ threadId: "t1" }), {
            newestMessages: async () => [{ createdAt: SENT_AT + 1000, id: "m1", role: "user", text: "hello" }],
            newestThreads: async () => {
                throw new Error("not read");
            },
        });

        expect(result).toStrictEqual({ kind: "found", threadId: "t1" });
    });

    it("counts only a network failure as no answer; a refusal answers that the prompt is not there", async () => {
        const failing = (error: Error) => {
            return {
                newestMessages: async () => [],
                newestThreads: async () => {
                    throw error;
                },
            };
        };

        const offline = failing(new TransportError("offline"));
        const refused = failing(new Error("FORBIDDEN"));

        await expect(checkPossiblySent(entry(), offline)).resolves.toStrictEqual({ kind: "unreachable" });
        await expect(checkPossiblySent(entry(), refused)).resolves.toStrictEqual({ kind: "absent" });
    });
});

/** A store whose checks answer from `answers` in turn, each one moving the clock by `step`. */
const storeAnswering = (answers: CheckResult[], step: number) => {
    let clock = SENT_AT + 15_000;
    let checks = 0;
    const store = createPossiblySentStore({
        check: async () => {
            const answer = answers[Math.min(checks, answers.length - 1)] ?? { kind: "absent" };

            checks += 1;
            clock += step;

            return answer;
        },
        now: () => clock,
        wait: async () => {},
    });

    return { checks: () => checks, store };
};

describe(createPossiblySentStore, () => {
    it("drops a prompt the server shows and tells the screen which chat holds it", async () => {
        const { store } = storeAnswering([{ kind: "absent" }, { kind: "found", threadId: "t-new" }], 5000);
        const found: string[] = [];

        store.onFound((held, threadId) => {
            found.push(`${held.id}:${threadId}`);
        });
        const tracking = store.track(entry());

        expect(entriesFor(store.snapshot(), "a", undefined).map((held) => held.state)).toStrictEqual(["pending"]);
        await tracking;

        expect(found).toStrictEqual(["user-1:t-new"]);
        expect(store.snapshot()).toStrictEqual([]);
    });

    it("gives the prompt back only after a check that answered past the window", async () => {
        const { checks, store } = storeAnswering([{ kind: "absent" }], 20_000);

        await store.track(entry());

        expect(checks()).toBe(POSSIBLY_SENT_WINDOW_MS / 20_000);
        expect(entriesFor(store.snapshot(), "a", undefined).map((held) => held.state)).toStrictEqual(["unsent"]);
        expect(entriesFor(store.snapshot(), "b", undefined)).toStrictEqual([]);
        expect(entriesFor(store.snapshot(), "a", "t1")).toStrictEqual([]);

        const handed: string[][] = [];

        store.watchUnsent("a", "t1", (prompts) => {
            handed.push(prompts);
        });
        store.watchUnsent("a", undefined, (prompts) => {
            handed.push(prompts);
        });

        expect(handed).toStrictEqual([["hello"]]);
        expect(store.snapshot()).toStrictEqual([]);
    });

    it("keeps checking while the server does not answer, even past the window", async () => {
        const { checks, store } = storeAnswering(
            [{ kind: "unreachable" }, { kind: "unreachable" }, { kind: "unreachable" }, { kind: "unreachable" }, { kind: "absent" }],
            60_000,
        );

        await store.track(entry());

        expect(checks()).toBe(5);
        expect(store.snapshot().map((held) => held.state)).toStrictEqual(["unsent"]);
    });

    it("stops checking at sign-out", async () => {
        const { checks, store } = storeAnswering([{ kind: "absent" }], 1000);
        const tracking = store.track(entry());

        store.clear();
        await tracking;

        expect(checks()).toBe(0);
        expect(store.snapshot()).toStrictEqual([]);
    });
});
