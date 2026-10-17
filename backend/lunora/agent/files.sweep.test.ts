/**
 * The unused-file sweep must not delete a file the moment its last reference goes: an undo that restores the
 * workflow or message would point at a file that no longer exists.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
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
});
