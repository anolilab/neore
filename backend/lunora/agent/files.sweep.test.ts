/**
 * The unused-file sweep must not delete a file the moment its last reference goes: an undo that restores the
 * workflow or message would point at a file that no longer exists.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { countedWorkflowFileIds } from "../workflow/images";
import { addFile, changeRefcount, isUnusedFileDue, UNREFERENCED_FILE_GRACE_MS, UNTOUCHED_FILE_RETENTION_MS } from "./files";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const store = async () =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.runMutation(addFile, { filename: "a.png", hash: "h1", mediaType: "image/png", storageId: "agent-files/h1", userId: "user-owner" }),
    )) as { fileId: string };

const reference = async (previous: string[], next: string[]) => {
    await harness.run(async (ctx: any) => {
        await changeRefcount(ctx, previous as never, next as never);
    });
};

const row = async (fileId: string) => await harness.run(async (ctx: any) => await ctx.db.chatFiles.findFirst({ where: { _id: fileId } }));

const NOW = 1_000_000_000_000;
const LONG_UNTOUCHED = NOW - UNTOUCHED_FILE_RETENTION_MS - 1;

describe("isUnusedFileDue", () => {
    it("keeps a released file within the grace window even when it was last touched long ago", () => {
        expect(isUnusedFileDue({ lastTouchedAt: LONG_UNTOUCHED, refcount: 0, unreferencedSince: NOW - UNREFERENCED_FILE_GRACE_MS + 1 }, NOW)).toBe(false);
    });

    it("deletes a released file once the grace window has passed", () => {
        expect(isUnusedFileDue({ lastTouchedAt: LONG_UNTOUCHED, refcount: 0, unreferencedSince: NOW - UNREFERENCED_FILE_GRACE_MS - 1 }, NOW)).toBe(true);
    });

    it("never deletes sooner than the untouched retention", () => {
        expect(isUnusedFileDue({ lastTouchedAt: NOW - 1, refcount: 0, unreferencedSince: NOW - UNREFERENCED_FILE_GRACE_MS - 1 }, NOW)).toBe(false);
    });

    it("keeps a referenced file", () => {
        expect(isUnusedFileDue({ lastTouchedAt: LONG_UNTOUCHED, refcount: 1 }, NOW)).toBe(false);
    });

    it("still deletes an upload that was never referenced after the untouched retention", () => {
        expect(isUnusedFileDue({ lastTouchedAt: LONG_UNTOUCHED, refcount: 0 }, NOW)).toBe(true);
    });
});

describe("changeRefcount", () => {
    it("leaves a fresh upload unstamped", async () => {
        const { fileId } = await store();

        expect(await row(fileId)).not.toHaveProperty("unreferencedSince");
    });

    it("stamps unreferencedSince when the last reference goes and clears it when referenced again", async () => {
        const { fileId } = await store();

        await reference([], [fileId]);
        expect(await row(fileId)).not.toHaveProperty("unreferencedSince");

        await reference([fileId], []);
        const released = await row(fileId);

        expect(released.refcount).toBe(0);
        expect(released.unreferencedSince).toEqual(expect.any(Number));

        await reference([], [fileId]);
        const restored = await row(fileId);

        expect(restored.refcount).toBe(1);
        expect(restored).not.toHaveProperty("unreferencedSince");
        expect(isUnusedFileDue(restored, Date.now() + UNTOUCHED_FILE_RETENTION_MS + UNREFERENCED_FILE_GRACE_MS)).toBe(false);
    });

    it("never takes a refcount below zero, and leaves a never-referenced upload unstamped", async () => {
        const { fileId } = await store();

        await reference([fileId], []);

        const released = await row(fileId);

        expect(released.refcount).toBe(0);
        expect(released).not.toHaveProperty("unreferencedSince");
    });
});

const storeAs = async (filename: string, mediaType: string, userId = "user-owner") =>
    (await harness.run(
        async (ctx: any) => await ctx.runMutation(addFile, { filename, hash: filename, mediaType, storageId: `agent-files/${filename}`, userId }),
    )) as { fileId: string };

const refcountOf = async (fileId: string): Promise<number> => {
    const file = await row(fileId);

    return file.refcount;
};

/** What a workflow write does to the refcount: the same pair `recountWorkflowImages` feeds `changeRefcount`. */
const workflowWrite = async (previousContent: unknown, nextContent: unknown) => {
    await harness.run(async (ctx: any) => {
        const { next, previous } = await countedWorkflowFileIds(ctx.db, "user-owner", previousContent, nextContent);

        await changeRefcount(ctx, previous, next);
    });
};

const fileNode = (fileId: string) => {
    return { nodes: [{ data: { fileId } }] };
};

describe("a workflow's file nodes against the refcount", () => {
    it("a legacy document file node does not release the reference a chat message holds", async () => {
        const { fileId } = await storeAs("notes.pdf", "application/pdf");

        await reference([], [fileId]);
        await workflowWrite(fileNode(fileId), undefined);

        expect(await refcountOf(fileId)).toBe(1);
    });

    it("counts a reference video when a node adds it, and releases it once when the node is removed", async () => {
        const { fileId } = await storeAs("clip.mp4", "video/mp4");

        await workflowWrite(undefined, fileNode(fileId));
        expect(await refcountOf(fileId)).toBe(1);

        await workflowWrite(fileNode(fileId), undefined);
        expect(await refcountOf(fileId)).toBe(0);
        expect(await row(fileId)).toHaveProperty("unreferencedSince");

        await workflowWrite(fileNode(fileId), undefined);
        expect(await refcountOf(fileId)).toBe(0);
    });

    it("releases the old video and counts the new one when a node swaps its file", async () => {
        const video = await storeAs("a.mp4", "video/mp4");
        const audio = await storeAs("b.mp3", "audio/mpeg");

        await workflowWrite(undefined, fileNode(video.fileId));
        await workflowWrite(fileNode(video.fileId), fileNode(audio.fileId));

        expect(await refcountOf(video.fileId)).toBe(0);
        expect(await refcountOf(audio.fileId)).toBe(1);
    });

    it("a foreign video keeps nothing alive and is not decremented", async () => {
        const { fileId } = await storeAs("theirs.mp4", "video/mp4", "user-other");

        await workflowWrite(undefined, fileNode(fileId));
        await workflowWrite(fileNode(fileId), undefined);

        expect(await refcountOf(fileId)).toBe(0);
    });
});
