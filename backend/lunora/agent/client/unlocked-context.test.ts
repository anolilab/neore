/**
 * The chat's own reads for a chat the owner UNLOCKED. Each positive case here
 * has a negative twin: without the proof the read is refused or empty.
 */
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import { fetchContextMessages } from "./search";
import { listMessages } from "./messages";

const row = {
    _id: "m1",
    message: { content: "secret question", role: "user" },
    order: 0,
    status: "success",
    stepOrder: 0,
    text: "secret question",
    threadId: "t1",
    tool: false,
    userId: "owner",
};

const fakeContext = () => {
    return {
        runQuery: vi.fn(async (..._args: [unknown, Record<string, unknown>?]) => {
            return { continueCursor: "", isDone: true, page: [row] };
        }),
    };
};

describe("generation context for an admitted background run", () => {
    it("reads the recent turns through the admitted query, with no proof needed", async () => {
        const ctx = fakeContext();
        const messages = await fetchContextMessages(ctx as never, {} as never, {
            admittedRun: true,
            contextOptions: {},
            threadId: "t1",
            userId: "owner",
        });

        expect(ctx.runQuery.mock.calls[0]?.[0]).toBe(internal.agent.messages.listMessagesByThreadIdAdmitted);
        expect(JSON.stringify(messages)).toContain("secret question");
    });

    it("an ordinary context read goes through the guarded query with the caller's proof", async () => {
        const ctx = fakeContext();

        await fetchContextMessages(ctx as never, {} as never, {
            contextOptions: {},
            threadId: "t1",
            unlockProof: "proof-1",
            userId: "owner",
        });

        expect(ctx.runQuery.mock.calls[0]?.[0]).toBe(internal.agent.messages.listMessagesByThreadIdInternal);
        expect(ctx.runQuery.mock.calls[0]?.[1]).toMatchObject({ unlockProof: "proof-1" });
    });

    it("an ordinary context read without a proof does not invent one", async () => {
        const ctx = fakeContext();

        await fetchContextMessages(ctx as never, {} as never, { contextOptions: {}, threadId: "t1", userId: "owner" });

        expect(ctx.runQuery.mock.calls[0]?.[1]).toMatchObject({ unlockProof: undefined });
    });
});

describe("the message list helper forwards the proof it was given", () => {
    it("passes the validated proof to the guarded query", async () => {
        const ctx = fakeContext();

        await listMessages(ctx as never, {} as never, { paginationOpts: { cursor: null, numItems: 10 }, threadId: "t1", unlockProof: "proof-1" });

        expect(ctx.runQuery.mock.calls[0]?.[0]).toBe(internal.agent.messages.listMessagesByThreadIdInternal);
        expect(ctx.runQuery.mock.calls[0]?.[1]).toMatchObject({ threadId: "t1", unlockProof: "proof-1" });
    });

    it("without a proof it passes none", async () => {
        const ctx = fakeContext();

        await listMessages(ctx as never, {} as never, { paginationOpts: { cursor: null, numItems: 10 }, threadId: "t1" });

        expect(ctx.runQuery.mock.calls[0]?.[1]).toMatchObject({ unlockProof: undefined });
    });
});
