import { describe, expect, it, vi } from "vitest";

import type { PendingAttachment } from "./chat-ui-store";

const uploaded = (fileId: string, name: string): PendingAttachment => {
    return { file: new File(["secret bytes"], name, { type: "image/png" }), fileId, id: `local-${fileId}`, name, status: "complete", type: "image" };
};

/** A fresh module is what a reload gives: nothing in memory, only what sessionStorage kept. */
const reload = async () => {
    vi.resetModules();

    const { usePromptQueueStore } = await import("./prompt-queue-store");

    return usePromptQueueStore;
};

describe("prompt queue across a reload", () => {
    it("keeps the queue and its attachments by file id, never their bytes, and restores it paused", async () => {
        const before = await reload();
        const uploading: PendingAttachment = { ...uploaded("", "late.png"), fileId: undefined, status: "uploading" };

        before.getState().enqueue("thread-1", { attachments: [uploaded("file-1", "cat.png"), uploading], id: "q1", text: "look at this" });
        before.getState().enqueue("thread-1", { attachments: [uploaded("file-2", "dog.png"), uploaded("file-2", "dog.png")], id: "q2", text: "" });

        expect(sessionStorage.getItem("neore:prompt-queue:thread-1")).not.toContain("secret bytes");

        const after = await reload();

        after.getState().hydrate("thread-1");

        const queue = after.getState().queues["thread-1"];

        expect(queue?.paused).toBe(true);
        expect(
            queue?.items.map((item) => [item.id, item.text, item.attachments.map((attachment) => attachment.fileId), item.droppedAttachments]),
        ).toStrictEqual([
            ["q1", "look at this", ["file-1"], 1],
            ["q2", "", ["file-2", "file-2"], undefined],
        ]);
        // The same file attached twice comes back as two chips, removed one at a time.
        expect(new Set(queue?.items[1]?.attachments.map((attachment) => attachment.id)).size).toBe(2);
        // The uploaded size comes back as a number, so the composer still counts it toward the context.
        expect(queue?.items[0]?.attachments[0]).toMatchObject({ name: "cat.png", restoredSize: 12, status: "complete", type: "image" });

        // A second reload stores the restored attachment again: its size comes from the marker, not its empty stand-in.
        after.getState().enqueue("thread-1", { attachments: [], id: "q3", text: "later" });

        const again = await reload();

        again.getState().hydrate("thread-1");

        expect(again.getState().queues["thread-1"]?.items[0]?.attachments[0]).toMatchObject({ fileId: "file-1", restoredSize: 12 });
    });

    it("drops the stored copy when a write fails, so a reload cannot bring back messages already sent", async () => {
        const store = await reload();

        store.getState().enqueue("thread-2", { attachments: [], id: "old", text: "already sent" });
        expect(sessionStorage.getItem("neore:prompt-queue:thread-2")).toContain("already sent");

        const full = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new DOMException("full", "QuotaExceededError");
        });

        store.getState().enqueue("thread-2", { attachments: [], id: "new", text: "newer" });
        full.mockRestore();

        expect(sessionStorage.getItem("neore:prompt-queue:thread-2")).toBeNull();
    });
});
