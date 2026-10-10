/**
 * A media generation whose queue delivery died mid-run must not spin forever:
 * the lapse handler fails the pending row stamped with that job's key — and
 * only that row — so the user can retry. It never re-runs the paid call.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { addMessages } from "../agent/messages";
import { ABANDONED_MEDIA_TEXT, failAbandonedMediaJob, mediaJobStamp } from "./media-abandon";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const insert = async (table: string, row: Record<string, unknown>): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.insert(table, row));

const pendingRow = async (threadId: string, jobId: string | undefined, text = "__IMAGE_GENERATING__") =>
    await insert("messages", {
        message: { content: [{ text, type: "text" }], role: "assistant" },
        order: 1,
        status: "pending",
        stepOrder: 1,
        text,
        threadId,
        tool: false,
        userId: "u1",
        ...(jobId !== undefined && { providerMetadata: mediaJobStamp(jobId) }),
    });

const fail = async (claimKey: string, threadId: string): Promise<boolean> =>
    await harness.run(async (ctx: any) => await ctx.runMutation(failAbandonedMediaJob, { claimKey, threadId }));

const read = async (id: string): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.get(id));

describe("mediaJobStamp", () => {
    it("stamps queue jobs only", () => {
        expect(mediaJobStamp("job-1")).toStrictEqual({ neoreJob: { jobId: "job-1" } });
        expect(mediaJobStamp(undefined)).toBeUndefined();
    });
});

describe("failAbandonedMediaJob", () => {
    it("fails exactly the row stamped with the dead job's key, never a live generation's", async () => {
        const threadId = await insert("threads", { status: "active", title: "t", userId: "u1" });
        const dead = await pendingRow(threadId, "job-dead");
        const alive = await pendingRow(threadId, "job-alive");
        const direct = await pendingRow(threadId, undefined);

        await expect(fail("job-dead", threadId)).resolves.toBe(true);

        expect(await read(dead)).toMatchObject({ status: "failed", text: ABANDONED_MEDIA_TEXT });
        expect(await read(alive)).toMatchObject({ status: "pending" });
        expect(await read(direct)).toMatchObject({ status: "pending" });
    });

    it("finds a pending row saved through the agent's own writer, stamp included", async () => {
        const threadId = await insert("threads", { status: "active", title: "t", userId: "u1" });

        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(addMessages, {
                    messages: [
                        {
                            message: { content: [{ text: "__VIDEO_GENERATING__", type: "text" }], role: "assistant" },
                            model: "m",
                            providerMetadata: mediaJobStamp("job-1"),
                            status: "pending",
                        },
                    ],
                    threadId,
                    userId: "u1",
                }),
        );

        await expect(fail("job-1", threadId)).resolves.toBe(true);
    });

    it("does nothing when the delivery died before creating its row", async () => {
        const threadId = await insert("threads", { status: "active", title: "t", userId: "u1" });
        const other = await pendingRow(threadId, "job-other");

        await expect(fail("job-dead", threadId)).resolves.toBe(false);
        expect(await read(other)).toMatchObject({ status: "pending" });
    });
});
