/**
 * `agent_files.getFileForUser` is the check every client-supplied chat file id
 * goes through. Rows are content-addressed and shared between users, so access
 * comes from a grant (you stored the bytes) or from the file already being on a
 * message in a thread you can read — never from knowing the id.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { addFile, deleteFiles, getFileForUser, useExistingFile } from "./files";

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "user-owner";
const STRANGER = "user-stranger";

let harness: Harness;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const store = async (userId: string) =>
    (await harness.run(
        async (ctx: any) => await ctx.runMutation(addFile, { filename: "a.png", hash: "h1", mediaType: "image/png", storageId: "agent-files/h1", userId }),
    )) as { fileId: string };

const lookup = async (args: { fileId: string; threadId?: string; userId: string }) =>
    await harness.run(async (ctx: any) => await ctx.runQuery(getFileForUser, args));

describe("getFileForUser", () => {
    it("lets the uploader attach their file and refuses everyone else", async () => {
        const { fileId } = await store(OWNER);

        expect(await lookup({ fileId, userId: OWNER })).toMatchObject({ storageId: "agent-files/h1" });
        expect(await lookup({ fileId, userId: STRANGER })).toBeNull();
    });

    it("grants a second uploader of the same bytes, but only by storing them", async () => {
        const { fileId } = await store(OWNER);

        expect(await lookup({ fileId, userId: STRANGER })).toBeNull();

        await harness.run(async (ctx: any) => await ctx.runMutation(useExistingFile, { filename: "a.png", hash: "h1", userId: STRANGER }));

        expect(await lookup({ fileId, userId: STRANGER })).not.toBeNull();
    });

    it("allows a file already attached in a thread the caller can read, not in one they cannot", async () => {
        const { fileId } = await store(OWNER);
        const threadId = await harness.run(async (ctx: any) => {
            const id = await ctx.db.insert("threads", { title: "T", userId: STRANGER });

            await ctx.db.insert("messages", { fileIds: [fileId], order: 0, status: "success", stepOrder: 0, threadId: id, tool: false, userId: STRANGER });

            return id;
        });
        const othersThread = await harness.run(async (ctx: any) => {
            const id = await ctx.db.insert("threads", { title: "T", userId: OWNER });

            await ctx.db.insert("messages", { fileIds: [fileId], order: 0, status: "success", stepOrder: 0, threadId: id, tool: false, userId: OWNER });

            return id;
        });

        expect(await lookup({ fileId, threadId, userId: STRANGER })).not.toBeNull();
        // The owner's thread is not STRANGER's to read, so it grants nothing.
        expect(await lookup({ fileId, threadId: othersThread, userId: STRANGER })).toBeNull();
    });

    it("drops grants with the file", async () => {
        const { fileId } = await store(OWNER);

        await harness.run(async (ctx: any) => await ctx.runMutation(deleteFiles, { fileIds: [fileId], force: true }));

        const grants = await harness.run(async (ctx: any) => await ctx.db.query("chatFileAccess").collect());

        expect(grants).toEqual([]);
    });
});
