/**
 * Deleting several messages that share one file releases one reference each.
 * `changeRefcount` is read-modify-write on `chatFiles`, so deleting them in
 * parallel read the same count N times and wrote one decrement: the file was
 * never reaped.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { addFile, changeRefcount } from "./files";
import { deleteByIds } from "./messages";

const OWNER = "user-owner";
const MESSAGES = 3;

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const refcountOf = async (fileId: string): Promise<number> =>
    await harness.run(async (ctx: any) => (await ctx.db.chatFiles.findFirst({ where: { _id: fileId } })).refcount);

describe("deleteByIds", () => {
    it("releases one file reference per deleted message", async () => {
        const { fileId } = (await harness.run(
            async (ctx: any) => await ctx.runMutation(addFile, { filename: "a.png", hash: "h1", mediaType: "image/png", storageId: "agent-files/h1", userId: OWNER }),
        )) as { fileId: string };

        const messageIds = await harness.run(async (ctx: any) => {
            const threadId = await ctx.db.insert("threads", { model: "m", status: "active", title: "t", userId: OWNER });
            const ids: string[] = [];

            for (let index = 0; index < MESSAGES; index += 1) {
                await changeRefcount(ctx, [], [fileId] as never);
                ids.push(
                    await ctx.db.insert("messages", {
                        fileIds: [fileId],
                        message: { content: "see file", role: "user" },
                        order: index,
                        status: "success",
                        stepOrder: 0,
                        text: "see file",
                        threadId,
                        tool: false,
                        userId: OWNER,
                    }),
                );
            }

            return ids;
        });
        const before = await refcountOf(fileId);

        expect(before).toBeGreaterThanOrEqual(MESSAGES);

        await harness.run(async (ctx: any) => await ctx.runMutation(deleteByIds, { messageIds }));

        expect(await refcountOf(fileId)).toBe(before - MESSAGES);
    });
});
