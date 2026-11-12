import { TransportError } from "@lunora/client";
import { describe, expect, it } from "vitest";

import type { CheckResult, PossiblySent, ReadPage, SentMessage } from "./possibly-sent";
import { checkPossiblySent, createPossiblySentStore, entriesFor, foundAction, hasPrompt, POSSIBLY_SENT_WINDOW_MS } from "./possibly-sent";

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

/** One page of a read: `next` names the following page's cursor, none means the last page. */
const pageOf = <T>(page: T[], next?: string): ReadPage<T> => {
    return { continueCursor: next ?? null, isDone: next === undefined, page };
};

const prompt = (createdAt: number, id = "m1"): SentMessage => {
    return { createdAt, id, role: "user", text: "hello" };
};

describe(checkPossiblySent, () => {
    it("finds a new chat by its first message on a later page, reading only chats created since the send", async () => {
        const read: string[] = [];
        const result = await checkPossiblySent(entry(), {
            messages: async (threadId) => {
                read.push(threadId);

                return pageOf(threadId === "t-new" ? [prompt(SENT_AT + 1000)] : []);
            },
            threads: async (cursor) => {
                if (cursor === null) {
                    return pageOf([{ createdAt: SENT_AT + 2000, id: "t-other" }, { createdAt: SENT_AT - 600_000, id: "t-old" }], "2");
                }

                return pageOf([{ createdAt: SENT_AT + 1000, id: "t-new" }]);
            },
        });

        expect(result).toStrictEqual({ kind: "found", threadId: "t-new" });
        expect(read).toStrictEqual(["t-other", "t-new"]);
    });

    it("reads a chat's messages back to the send, and no further", async () => {
        const cursors: (string | null)[] = [];
        const result = await checkPossiblySent(entry({ threadId: "t1" }), {
            messages: async (_threadId, cursor) => {
                cursors.push(cursor);

                return cursor === null ? pageOf([{ ...prompt(SENT_AT + 9000, "m9"), text: "later" }], "2") : pageOf([prompt(SENT_AT - 600_000, "m0")], "3");
            },
            threads: async () => {
                throw new Error("not read");
            },
        });

        expect(result).toStrictEqual({ kind: "absent" });
        expect(cursors).toStrictEqual([null, "2"]);
    });

    it("proves nothing from an error or from more pages than a check reads", async () => {
        const failing = (error: Error) => {
            return {
                messages: async () => pageOf<SentMessage>([]),
                threads: async () => {
                    throw error;
                },
            };
        };
        const endless = {
            messages: async () => pageOf<SentMessage>([]),
            threads: async () => pageOf([{ createdAt: SENT_AT - 600_000, id: "t-old" }], "more"),
        };

        const offline = failing(new TransportError("offline"));
        const refused = failing(new Error("UNAUTHORIZED"));

        await expect(checkPossiblySent(entry(), offline)).resolves.toStrictEqual({ kind: "inconclusive" });
        await expect(checkPossiblySent(entry(), refused)).resolves.toStrictEqual({ kind: "inconclusive" });
        await expect(checkPossiblySent(entry(), endless)).resolves.toStrictEqual({ kind: "inconclusive" });
    });

    it("proves the prompt absent when every page answered", async () => {
        const result = await checkPossiblySent(entry(), {
            messages: async () => pageOf([prompt(SENT_AT + 1000, "old")]),
            threads: async () => pageOf([{ createdAt: SENT_AT + 1000, id: "t-other" }]),
        });

        expect(result).toStrictEqual({ kind: "absent" });
    });
});

describe(foundAction, () => {
    it.each([
        ["another account's prompt", entry({ accountId: "b" }), true, undefined, "ignore"],
        ["another chat's prompt", entry({ threadId: "t2" }), true, "t1", "ignore"],
        ["an existing chat's prompt", entry({ threadId: "t1" }), false, "t1", "reload"],
        ["a new chat's prompt on screen", entry(), true, undefined, "open"],
        ["a new chat's prompt on a screen left behind", entry(), false, undefined, "leave-to-list"],
    ] as const)("%s: %s", (_name, held, isFocused, threadId, expected) => {
        expect(foundAction(held, { accountId: "a", isFocused, threadId })).toBe(expected);
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
        const tracking = store.track(entry(), 0);

        expect(entriesFor(store.snapshot(), "a", undefined).map((held) => held.state)).toStrictEqual(["pending"]);
        await tracking;

        expect(found).toStrictEqual(["user-1:t-new"]);
        expect(store.snapshot()).toStrictEqual([]);
    });

    it("gives the prompt back only after a check that answered past the window", async () => {
        const { checks, store } = storeAnswering([{ kind: "absent" }], 20_000);

        await store.track(entry(), 0);

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

    it("keeps checking while no check proves anything, even past the window", async () => {
        const { checks, store } = storeAnswering(
            [{ kind: "inconclusive" }, { kind: "inconclusive" }, { kind: "inconclusive" }, { kind: "inconclusive" }, { kind: "absent" }],
            60_000,
        );

        await store.track(entry(), 0);

        expect(checks()).toBe(5);
        expect(store.snapshot().map((held) => held.state)).toStrictEqual(["unsent"]);
    });

    it("holds nothing for a send that settles after a sign-out", async () => {
        const { checks, store } = storeAnswering([{ kind: "absent" }], 1000);
        const session = store.session();

        store.clear();
        await store.track(entry(), session);

        expect(checks()).toBe(0);
        expect(store.snapshot()).toStrictEqual([]);
    });

    it("stops checking at sign-out", async () => {
        const { checks, store } = storeAnswering([{ kind: "absent" }], 1000);
        const tracking = store.track(entry(), 0);

        store.clear();
        await tracking;

        expect(checks()).toBe(0);
        expect(store.snapshot()).toStrictEqual([]);
    });
});
