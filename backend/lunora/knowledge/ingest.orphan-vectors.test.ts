/**
 * The vectors written before the chunk rows are saved belong to no chunk until
 * the save succeeds, and file removal follows chunk rows: a save that is refused
 * or throws has to delete them itself.
 */
import { describe, expect, it, vi } from "vitest";

import { keepVectorsOnlyIfSaved } from "./ingest";

const IDS = ["v1", "v2"];

const fakeContext = (runAction = vi.fn(async (..._arguments: unknown[]) => null)) => {
    return { ctx: { runAction } as never, runAction };
};

describe("keepVectorsOnlyIfSaved", () => {
    it("keeps the vectors when the chunks were saved", async () => {
        const { ctx, runAction } = fakeContext();

        await expect(keepVectorsOnlyIfSaved(ctx, IDS, async () => true)).resolves.toBe(true);
        expect(runAction).not.toHaveBeenCalled();
    });

    it("deletes the vectors when the save is refused", async () => {
        const { ctx, runAction } = fakeContext();

        await expect(keepVectorsOnlyIfSaved(ctx, IDS, async () => false)).resolves.toBe(false);
        expect(runAction).toHaveBeenCalledOnce();
        expect(runAction.mock.calls[0]?.[1]).toEqual({ embeddingIds: IDS });
    });

    it("deletes the vectors and rethrows when the save throws", async () => {
        const { ctx, runAction } = fakeContext();
        const failure = new Error("saveChunks failed");

        await expect(
            keepVectorsOnlyIfSaved(ctx, IDS, async () => {
                throw failure;
            }),
        ).rejects.toBe(failure);
        expect(runAction.mock.calls[0]?.[1]).toEqual({ embeddingIds: IDS });
    });

    it("lets the save's error win over a failing cleanup", async () => {
        const { ctx } = fakeContext(vi.fn(async (..._arguments: unknown[]) => Promise.reject(new Error("cleanup failed"))));
        const failure = new Error("saveChunks failed");
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await expect(
            keepVectorsOnlyIfSaved(ctx, IDS, async () => {
                throw failure;
            }),
        ).rejects.toBe(failure);
        log.mockRestore();
    });

    it("does not call the cleanup when no vector was written", async () => {
        const { ctx, runAction } = fakeContext();

        await expect(keepVectorsOnlyIfSaved(ctx, [], async () => false)).resolves.toBe(false);
        expect(runAction).not.toHaveBeenCalled();
    });
});
