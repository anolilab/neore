/**
 * `archiveIfStillIdle` must see a live run however many finished streams the
 * thread has: the live one is inserted last, past any sample of the first 50.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { MAX_LENGTH } from "../lib/validators";
import { archiveIfStillIdle, autoArchiveContinue } from "./auto-archive";

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "user-owner";
const CUTOFF = 10_000;
const FINISHED_STREAMS = 60;

let harness: Harness;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const finishedStreams = (count: number): string[] => {
    const statuses: string[] = [];

    for (let index = 0; index < count; index += 1) {
        statuses.push("done");
    }

    return statuses;
};

const archiveAfter = (statuses: string[]) =>
    harness.run(async (ctx: any) => {
        const threadId = await ctx.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "Old", updatedAt: 1, userId: OWNER });

        for (const status of statuses) {
            await ctx.db.insert("persistentStreams", {
                expiresAt: CUTOFF * 10,
                messageId: "m-1",
                status,
                streamingConfig: { contentType: "text", model: "gpt-4o" },
                threadId,
                userId: OWNER,
            });
        }

        return await ctx.runMutation(archiveIfStillIdle, { cutoff: CUTOFF, threadId });
    });

describe("archiveIfStillIdle and live streams", () => {
    it("archives a thread whose streams all finished", async () => {
        expect(await archiveAfter(finishedStreams(FINISHED_STREAMS))).toBe(true);
    });

    it("keeps a thread whose one live stream sits behind more than 50 finished ones", async () => {
        const statuses = [...finishedStreams(FINISHED_STREAMS), "streaming"];

        expect(await archiveAfter(statuses)).toBe(false);
    });

    it("keeps a thread with a pending stream behind finished ones", async () => {
        const statuses = [...finishedStreams(FINISHED_STREAMS), "pending"];

        expect(await archiveAfter(statuses)).toBe(false);
    });
});

describe("autoArchiveContinue cursor", () => {
    it("refuses a cursor longer than the cursor bound", async () => {
        await expect(
            harness.run(async (ctx: any) => await ctx.runMutation(autoArchiveContinue, { cursor: "c".repeat(MAX_LENGTH.cursor + 1) })),
        ).rejects.toThrow();
    });

    it("issues pagination cursors well under the bound", async () => {
        const cursor = await harness.run(async (ctx: any) => {
            for (let index = 0; index < 2; index += 1) {
                await ctx.db.insert("threads", { mode: "text", model: "gpt-4o", status: "active", title: "Old", updatedAt: index + 1, userId: OWNER });
            }

            const { continueCursor } = await ctx.db
                .query("threads")
                .withIndex("by_user_and_updatedAt", (q: any) => q.eq("userId", OWNER).lt("updatedAt", CUTOFF))
                .order("desc")
                .paginate({ cursor: null, numItems: 1 });

            return continueCursor as string;
        });

        expect(cursor.length).toBeLessThan(MAX_LENGTH.cursor);
    });
});
