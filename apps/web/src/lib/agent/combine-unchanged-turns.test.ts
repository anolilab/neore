import { sorted } from "@neore/backend/agent/shared";
import type { UIMessage } from "@neore/backend/agent/ui-messages";
import { combineUIMessages } from "@neore/backend/agent/ui-messages";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { CombineCache } from "./combine-unchanged-turns";
import { combineUnchangedTurns } from "./combine-unchanged-turns";

const replaceEqualDeepCalls = vi.hoisted(() => {
    return { count: 0 };
});

vi.mock("@tanstack/react-query", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@tanstack/react-query")>();

    return {
        ...actual,
        replaceEqualDeep: (a: unknown, b: unknown) => {
            replaceEqualDeepCalls.count += 1;

            return actual.replaceEqualDeep(a, b);
        },
    };
});

// Imported after the mock, so its deep compares are counted (the query cache's own are not: it binds the original).
const { shareUnchangedMessages } = await import("./share-unchanged-messages");

const TURNS = 100;
const STEPS_PER_REPLY = 3;

const step = (order: number, stepOrder: number, text: string): UIMessage => {
    const role = stepOrder === 0 ? "user" : "assistant";
    const id = `t${order}-s${stepOrder}`;
    const parts =
        role === "assistant" && stepOrder < STEPS_PER_REPLY
            ? [{ input: { query: text }, output: { hits: 3 }, state: "output-available", toolCallId: `call-${id}`, type: "tool-search" }]
            : [{ text, type: "text" }];

    return { _creationTime: order * 10 + stepOrder, id, key: id, order, parts, role, status: "success", stepOrder, text } as unknown as UIMessage;
};

/** A thread of user prompts each answered by a reply in several steps (tool calls, then text). */
const makeThread = (): UIMessage[] =>
    Array.from({ length: TURNS }, (_, order) =>
        Array.from({ length: STEPS_PER_REPLY + 1 }, (__, stepOrder) => step(order, stepOrder, `turn ${order} step ${stepOrder}`)),
    ).flat();

const pageKey = ["lunora", "listThreadMessages", { threadId: "t" }];

/** Runs the page through what `useUIMessages` does with it; returns what it made and how much work that took. */
const merge = (page: UIMessage[], previous: UIMessage[], cache: CombineCache) => {
    const combine = vi.fn(combineUIMessages);

    replaceEqualDeepCalls.count = 0;

    const combined = combineUnchangedTurns(sorted(page), cache, combine);
    const results = shareUnchangedMessages(previous, combined);

    // Steps handed to `combineUIMessages`: the whole page when every turn is recombined.
    const combinedSteps = combine.mock.calls.reduce((total, [steps]) => total + steps.length, 0);

    return { combinedSteps, deepCompares: replaceEqualDeepCalls.count, results };
};

describe(combineUnchangedTurns, () => {
    it("combines like combineUIMessages", () => {
        const thread = makeThread();

        expect(combineUnchangedTurns(thread, new Map())).toStrictEqual(combineUIMessages(thread));
    });

    it("on a live push into one reply, recombines and compares that reply alone and keeps every other message", () => {
        const queryClient = new QueryClient();
        const cache: CombineCache = new Map();

        // The first page, then a push: a freshly decoded copy of the whole page in which one step's text grew.
        queryClient.setQueryData(pageKey, makeThread());

        const first = merge(queryClient.getQueryData<UIMessage[]>(pageKey)!, [], cache);

        expect(first.results).toHaveLength(TURNS * 2);

        const pushed = structuredClone(queryClient.getQueryData<UIMessage[]>(pageKey)!);
        const changed = pushed.findIndex((message) => message.id === "t42-s3");

        pushed[changed] = step(42, 3, "turn 42 step 3, more text");
        queryClient.setQueryData(pageKey, pushed);

        const second = merge(queryClient.getQueryData<UIMessage[]>(pageKey)!, first.results, cache);

        expect(second.combinedSteps).toBe(STEPS_PER_REPLY);
        expect(second.deepCompares).toBe(1);

        const changedReply = second.results.findIndex((message) => message.id === "t42-s1");

        for (const [index, message] of second.results.entries()) {
            if (index === changedReply) {
                expect(message).not.toBe(first.results[index]);
                expect(message.text).toContain("more text");
            } else {
                expect(message).toBe(first.results[index]);
            }
        }
    });

    it("does no work for a push that changed nothing", () => {
        const queryClient = new QueryClient();
        const cache: CombineCache = new Map();

        queryClient.setQueryData(pageKey, makeThread());

        const first = merge(queryClient.getQueryData<UIMessage[]>(pageKey)!, [], cache);

        queryClient.setQueryData(pageKey, structuredClone(queryClient.getQueryData<UIMessage[]>(pageKey)!));

        const second = merge(queryClient.getQueryData<UIMessage[]>(pageKey)!, first.results, cache);

        expect(second.combinedSteps).toBe(0);
        expect(second.deepCompares).toBe(0);
        expect(second.results).toBe(first.results);
    });

    it("recombines a reply that gained a step", () => {
        const cache: CombineCache = new Map();
        const thread = makeThread();
        const first = combineUnchangedTurns(thread, cache);
        const extra = step(99, STEPS_PER_REPLY + 1, "a late step");
        const second = combineUnchangedTurns([...thread, extra], cache);

        expect(second.at(-1)).not.toBe(first.at(-1));
        expect(second.at(-1)?.text).toContain("a late step");
        expect(second.at(-2)).toBe(first.at(-2));
    });

    it("forgets the turns that left the page", () => {
        const cache: CombineCache = new Map();
        const thread = makeThread();

        combineUnchangedTurns(thread, cache);
        combineUnchangedTurns(thread.slice(-STEPS_PER_REPLY - 1), cache);

        expect([...cache.keys()]).toStrictEqual([`t${TURNS - 1}-s1`]);
    });
});
