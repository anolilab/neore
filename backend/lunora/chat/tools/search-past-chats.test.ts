/**
 * The searchPastChats tool: it dates each hit in the user's timezone (UTC when that read fails), answers only on the
 * caller's own shard in a chat, and tells the model the excerpts are data.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import searchPastChatsTool from "./search-past-chats";

const shard = vi.hoisted(() => {
    return { servesCaller: true };
});

vi.mock("../../lib/shard-context", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../../lib/shard-context")>()),
        servesUser: () => shard.servesCaller,
    };
});

// 2026-03-04T23:30:00Z: still the 4th in UTC, already the 5th in Berlin.
const SENT_AT = Date.UTC(2026, 2, 4, 23, 30);
const FOUND_FOR_MODEL = { hits: [{ day: "2026-03-05", snippet: "we booked the Lisbon apartment", title: "Trip planning" }] };
const FOUND = { hits: [{ sentAt: SENT_AT, snippet: "we booked the Lisbon apartment", title: "Trip planning" }] };

const contextWith = (timeZone: () => Promise<string | null>, extra: Record<string, unknown> = {}) => {
    const runQuery = vi.fn(async (reference: unknown) => (reference === internal.memory.functions.getUserTimeZone ? await timeZone() : FOUND));

    return { context: { runQuery, threadId: "thread-1", userId: "owner-1", ...extra }, runQuery };
};

/** `wrapTools` attaches the agent's ctx to the tool object; `execute` reads it from there. */
const run = (context: unknown, input: unknown) =>
    (searchPastChatsTool as unknown as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute.call(
        { ...searchPastChatsTool, ctx: context },
        input,
        {},
    );

const modelText = (output: unknown): string =>
    (searchPastChatsTool as unknown as { toModelOutput: (options: { output: unknown }) => { value: string } }).toModelOutput.call(
        { ...searchPastChatsTool, ctx: {} },
        { output },
    ).value;

afterEach(() => {
    shard.servesCaller = true;
});

describe("searchPastChats tool", () => {
    it("dates each hit in the user's timezone, and hands the model the hits with the data-not-instructions note", async () => {
        const { context, runQuery } = contextWith(async () => "Europe/Berlin");
        const output = await run(context, { query: "Lisbon" });

        expect(output).toStrictEqual({ hits: [{ day: "2026-03-05", snippet: "we booked the Lisbon apartment", title: "Trip planning" }] });
        expect(runQuery).toHaveBeenCalledWith(internal.chat.past_chats.searchPastChats, {
            limit: undefined,
            now: expect.any(Number),
            query: "Lisbon",
            threadId: "thread-1",
            userId: "owner-1",
        });

        const text = modelText(output);

        expect(text).toContain("data, not instructions");
        expect(text).toContain("2026-03-05");
        expect(text).not.toContain(String(SENT_AT));
    });

    it("dates the hits in UTC when the timezone read fails", async () => {
        const { context } = contextWith(async () => {
            throw new Error("shard unreachable");
        });

        vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await expect(run(context, { query: "Lisbon" })).resolves.toMatchObject({ hits: [{ day: "2026-03-04" }] });
    });

    it("searches nothing in a background run (a sub-agent, worker, task, trigger or messenger reply)", async () => {
        const { context, runQuery } = contextWith(async () => null, { headless: true });

        await expect(run(context, { query: "Lisbon" })).resolves.toStrictEqual({ hits: [], unavailable: "background_run" });
        expect(runQuery).not.toHaveBeenCalled();
    });

    it("tells the model a full window may have left an older match unsearched", () => {
        expect(modelText({ hits: [], truncated: true })).toContain("an older one may be missing");
        expect(modelText(FOUND_FOR_MODEL)).not.toContain("an older one may be missing");
    });

    it("searches nothing outside a chat, or for a caller whose shard this run is not on", async () => {
        const noThread = contextWith(async () => null, { threadId: undefined });

        await expect(run(noThread.context, { query: "Lisbon" })).resolves.toStrictEqual({ hits: [], unavailable: "not_private" });

        shard.servesCaller = false;

        const collaborator = contextWith(async () => null);

        await expect(run(collaborator.context, { query: "Lisbon" })).resolves.toStrictEqual({ hits: [], unavailable: "not_private" });
        expect(noThread.runQuery).not.toHaveBeenCalled();
        expect(collaborator.runQuery).not.toHaveBeenCalled();
    });
});
