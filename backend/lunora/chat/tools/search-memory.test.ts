/**
 * The search_memory tool: what it hands the model for the memories the search found.
 */
import { describe, expect, it, vi } from "vitest";

import { internal } from "../../_generated/internal";
import searchMemoryTool from "./search-memory";

// 23:30 UTC on the 20th is already the 21st in Auckland.
const FOUND = [{ category: "preference", confidence: 90, lastConfirmedAt: Date.UTC(2026, 10, 20, 23, 30), memory: "Likes tea", memoryId: "m1", score: 0.9 }];

/** `wrapTools` attaches the agent's ctx to the tool object; `execute` reads it from there. */
const run = (context: unknown) =>
    (searchMemoryTool as unknown as { execute: (input: unknown, options: unknown) => unknown }).execute.call(
        { ...searchMemoryTool, ctx: context },
        { query: "what does the user drink" },
        {},
    );

const contextWith = (timeZone: () => Promise<string | null>) => {
    return {
        runAction: vi.fn(async () => FOUND),
        runQuery: vi.fn(async (reference: unknown) => {
            if (reference === internal.memory.functions.getUserTimeZone) {
                return await timeZone();
            }

            throw new Error("unexpected query");
        }),
        userId: "user-1",
    };
};

describe("search_memory", () => {
    it("dates each found memory in the user's timezone", async () => {
        await expect(run(contextWith(async () => "Pacific/Auckland"))).resolves.toMatchObject({
            memories: [{ confirmedOn: "2026-11-21", memory: "Likes tea" }],
        });
    });

    it("still returns the found memories, dated in UTC, when the timezone read fails", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        try {
            await expect(
                run(
                    contextWith(async () => {
                        throw new Error("shard unavailable");
                    }),
                ),
            ).resolves.toMatchObject({ memories: [{ confirmedOn: "2026-11-20", memory: "Likes tea" }] });
        } finally {
            warn.mockRestore();
        }
    });
});
