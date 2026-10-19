/**
 * A bot's memories are its own. A plain chat reads only the user's memories;
 * a bot chat reads its own plus the user's; a bot's extraction writes and dedupes
 * in its own scope only, so it can never edit a user memory.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { getActiveMemoriesForUser } from "./functions";
import { loadReflectionInputs } from "./reflection";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const insertMemory = async (memory: string, botId?: string): Promise<void> => {
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("memories", {
                ...(botId && { botId }),
                lastConfirmedAt: Date.now(),
                memory,
                source: "auto",
                type: "identity",
                updatedAt: Date.now(),
                userId: "user-1",
            }),
    );
};

const readTexts = async (args: { botId?: string; includeUserWide?: boolean }): Promise<string[]> => {
    const rows = await harness.run(async (ctx: any) => await ctx.runQuery(getActiveMemoriesForUser, { userId: "user-1", ...args }));

    return rows.map((row: { memory: string }) => row.memory).toSorted((a: string, b: string) => a.localeCompare(b));
};

describe("getActiveMemoriesForUser scope", () => {
    it("gives a plain chat only the user's own memories", async () => {
        await insertMemory("likes tea");
        await insertMemory("bot secret", "bot-a");

        expect(await readTexts({})).toEqual(["likes tea"]);
    });

    it("gives a bot its own memories plus the user's when includeUserWide is set", async () => {
        await insertMemory("likes tea");
        await insertMemory("bot secret", "bot-a");
        await insertMemory("other bot", "bot-b");

        expect(await readTexts({ botId: "bot-a", includeUserWide: true })).toEqual(["bot secret", "likes tea"]);
    });

    it("keeps a bot's extraction to its own scope, never the user's", async () => {
        await insertMemory("likes tea");
        await insertMemory("bot secret", "bot-a");

        expect(await readTexts({ botId: "bot-a" })).toEqual(["bot secret"]);
    });
});

describe("nightly reflection scope", () => {
    it("reflects only the user's own memories, never a bot's", async () => {
        await insertMemory("likes tea");
        await insertMemory("bot secret", "bot-a");

        const { memories } = await harness.run(async (ctx: any) => await ctx.runQuery(loadReflectionInputs, { now: Date.now(), userId: "user-1" }));

        expect(memories.map((m: { text: string }) => m.text)).toEqual(["likes tea"]);
    });
});

describe("scope reads are not crowded out", () => {
    it("keeps an older preference in the window against newer activity rows", async () => {
        // A preference written first, then more newer activity rows than the window holds.
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("memories", {
                    lastConfirmedAt: Date.now(),
                    memory: "prefers short answers",
                    source: "auto",
                    type: "preference",
                    updatedAt: Date.now(),
                    userId: "user-1",
                }),
        );

        for (let index = 0; index < 160; index += 1) {
            await harness.run(
                async (ctx: any) =>
                    await ctx.db.insert("memories", {
                        lastConfirmedAt: Date.now(),
                        memory: `activity ${index}`,
                        source: "auto",
                        type: "activity",
                        updatedAt: Date.now(),
                        userId: "user-1",
                    }),
            );
        }

        expect(await readTexts({})).toContain("prefers short answers");
    });

    it("still returns the user's memory when a bot holds more rows than the old window", async () => {
        // Written first: the old type-ordered window kept the newest rows and dropped it.
        await insertMemory("likes tea");

        for (let index = 0; index < 160; index += 1) {
            await insertMemory(`bot fact ${index}`, "bot-a");
        }

        expect(await readTexts({})).toEqual(["likes tea"]);
        const merged = await harness.run(
            async (ctx: any) => await ctx.runQuery(getActiveMemoriesForUser, { botId: "bot-a", includeUserWide: true, limit: 200, userId: "user-1" }),
        );

        expect(merged.map((row: { memory: string }) => row.memory)).toContain("likes tea");
    });

    it("reflects one bot's memories as their own scope", async () => {
        await insertMemory("likes tea");
        await insertMemory("bot secret", "bot-a");

        const { memories } = await harness.run(
            async (ctx: any) => await ctx.runQuery(loadReflectionInputs, { botId: "bot-a", now: Date.now(), userId: "user-1" }),
        );

        expect(memories.map((m: { text: string }) => m.text)).toEqual(["bot secret"]);
    });
});
