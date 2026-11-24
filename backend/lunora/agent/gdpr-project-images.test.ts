/**
 * A project's chat files are released when the account is erased, while the owner still holds their grants. A file counts only
 * while the owner holds a grant for it, so a release after the grants are erased counts nothing and the files stay held. A file
 * with no grant was never counted, so it is left alone. A second release finds nothing left to release.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { storedRow } from "../lib/stored-row";
import { addFile, changeRefcount } from "./files";
import { eraseChatFileAccessForUser, releaseProjectImagesForUser } from "./gdpr";

const A = "user-a";
const B = "user-b";

type Harness = ReturnType<typeof lunoraTest>;
let harness: Harness;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

/** Stores a file for `userId` (its grant is theirs) and returns its id. */
const storeFor = async (userId: string, hash: string): Promise<string> => {
    const { fileId } = (await harness.run(
        async (ctx: any) => await ctx.runMutation(addFile, { filename: `${hash}.png`, hash, mediaType: "image/png", storageId: `agent-files/${hash}`, userId }),
    )) as { fileId: string };

    return fileId;
};

/** A project of `userId` whose workflow has one image node per file id. */
const projectWithImages = async (userId: string, fileIds: string[]): Promise<void> => {
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("projects", {
            createdAt: 0,
            title: "p",
            userId,
            workflowContent: {
                edges: [],
                nodes: fileIds.map((fileId, index) => {
                    return { data: { imageFileId: fileId }, id: `n${String(index)}`, position: { x: 0, y: 0 }, type: "image" };
                }),
            },
        });
    });
};

/**
 * The count a project's workflow retains, as its write does: the files the owner holds a grant for. The retained count is what the
 * release has to give back.
 */
const retainCounted = async (fileIds: string[]): Promise<void> => {
    await harness.run(async (ctx: any) => await changeRefcount(ctx, [], fileIds as never));
};

const refcountOf = async (fileId: string): Promise<number> => {
    const row = (await harness.run(async (ctx: any) => storedRow(await ctx.db.chatFiles.findFirst({ where: { _id: fileId } })))) as { refcount: number } | null;

    return row?.refcount ?? 0;
};

describe("chat files of projects in the account erasure", () => {
    it("releases the files a project holds for the owner, and empties the workflow so a second run releases nothing", async () => {
        const fileId = await storeFor(A, "held");
        const before = await refcountOf(fileId);

        await projectWithImages(A, [fileId]);
        await retainCounted([fileId]);
        expect(await refcountOf(fileId)).toBe(before + 1);

        const first = (await harness.run(async (ctx: any) => await releaseProjectImagesForUser(ctx, A))) as { hasMore: boolean };

        expect(first.hasMore).toBe(false);
        expect(await refcountOf(fileId)).toBe(before);

        const second = (await harness.run(async (ctx: any) => await releaseProjectImagesForUser(ctx, A))) as { hasMore: boolean };

        expect(second.hasMore).toBe(false);
        expect(await refcountOf(fileId)).toBe(before);
    });

    it("leaves alone a file the owner holds no grant for, as it was never counted", async () => {
        const others = await storeFor(B, "others");
        const before = await refcountOf(others);

        await projectWithImages(A, [others]);

        await harness.run(async (ctx: any) => await releaseProjectImagesForUser(ctx, A));

        expect(await refcountOf(others)).toBe(before);
    });

    it("releases nothing once the grants are erased, which is why the release runs first", async () => {
        const fileId = await storeFor(A, "after-grants");
        const before = await refcountOf(fileId);

        await projectWithImages(A, [fileId]);
        await retainCounted([fileId]);

        await harness.run(async (ctx: any) => await eraseChatFileAccessForUser(ctx, A));
        await harness.run(async (ctx: any) => await releaseProjectImagesForUser(ctx, A));

        expect(await refcountOf(fileId)).toBe(before + 1);
    });
});
