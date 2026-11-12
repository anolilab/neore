import { describe, expect, it, vi } from "vitest";

import type { PendingAttachment } from "./chat-ui-store";

const uploaded = (fileId: string, name: string): PendingAttachment => {
    return { file: new File(["secret bytes"], name, { type: "image/png" }), fileId, id: `local-${fileId}`, name, status: "complete", type: "image" };
};

/** A fresh module is what a reload gives: nothing in memory, only what sessionStorage kept. */
const reload = async ({ confirmed = true }: { confirmed?: boolean } = {}) => {
    vi.resetModules();

    const { allowPromptQueueRestore, usePromptQueueStore } = await import("./prompt-queue-store");

    if (confirmed) {
        allowPromptQueueRestore();
    }

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

describe("prompt queues after the session ends", () => {
    it("drops every thread's queue, in memory and in sessionStorage, so the next account cannot restore one", async () => {
        const before = await reload();

        before.getState().enqueue("thread-1", { attachments: [], id: "q1", text: "the old account's prompt" });
        before.getState().enqueue("thread-2", { attachments: [], id: "q2", text: "another" });
        sessionStorage.setItem("unrelated", "kept");

        const { clearPromptQueues } = await import("./prompt-queue-store");

        clearPromptQueues();

        expect(before.getState().queues).toEqual({});
        expect(sessionStorage.getItem("neore:prompt-queue:thread-1")).toBeNull();
        expect(sessionStorage.getItem("neore:prompt-queue:thread-2")).toBeNull();
        expect(sessionStorage.getItem("unrelated")).toBe("kept");

        before.getState().hydrate("thread-1");

        expect(before.getState().queues["thread-1"]).toBeUndefined();
    });
});

describe("prompt queues before the session is confirmed", () => {
    it("restores no stored queue, not through a write either, until the session is confirmed", async () => {
        const before = await reload();

        before.getState().enqueue("thread-3", { attachments: [], id: "old", text: "the ended session's prompt" });

        const visitor = await reload({ confirmed: false });

        visitor.getState().hydrate("thread-3");
        expect(visitor.getState().queues["thread-3"]).toBeUndefined();

        visitor.getState().enqueue("thread-3", { attachments: [], id: "new", text: "typed now" });
        expect(visitor.getState().queues["thread-3"]?.items.map((item) => item.id)).toStrictEqual(["new"]);
    });

    it("restores the stored queue once the session is confirmed", async () => {
        const before = await reload();

        before.getState().enqueue("thread-4", { attachments: [], id: "mine", text: "still mine" });

        const after = await reload({ confirmed: false });

        after.getState().hydrate("thread-4");
        expect(after.getState().queues["thread-4"]).toBeUndefined();

        const { allowPromptQueueRestore } = await import("./prompt-queue-store");

        allowPromptQueueRestore();
        after.getState().hydrate("thread-4");
        expect(after.getState().queues["thread-4"]?.items.map((item) => item.id)).toStrictEqual(["mine"]);
    });
});

describe("prompt queues across an account switch", () => {
    it("restores what the next account queues, without the session being confirmed again", async () => {
        const store = await reload();
        const { clearPromptQueues } = await import("./prompt-queue-store");

        store.getState().enqueue("thread-5", { attachments: [], id: "old", text: "the departing account's prompt" });
        clearPromptQueues();

        store.getState().enqueue("thread-5", { attachments: [], id: "new", text: "the next account's prompt" });
        expect(sessionStorage.getItem("neore:prompt-queue:thread-5")).toContain("the next account's prompt");

        const after = await reload();

        after.getState().hydrate("thread-5");
        expect(after.getState().queues["thread-5"]?.items.map((item) => item.id)).toStrictEqual(["new"]);
    });
});

describe("prompt queues written before the session is confirmed", () => {
    it("keeps the queue stored before the reload and what was queued since, the stored one first", async () => {
        const before = await reload();

        before.getState().enqueue("thread-6", { attachments: [], id: "stored", text: "queued before the reload" });

        const after = await reload({ confirmed: false });

        after.getState().enqueue("thread-6", { attachments: [], id: "early", text: "queued before the session was confirmed" });
        expect(sessionStorage.getItem("neore:prompt-queue:thread-6")).not.toContain("queued before the session was confirmed");

        const { allowPromptQueueRestore } = await import("./prompt-queue-store");

        allowPromptQueueRestore();
        after.getState().hydrate("thread-6");

        const queue = after.getState().queues["thread-6"];

        expect(queue?.items.map((item) => item.id)).toStrictEqual(["stored", "early"]);
        expect(queue?.paused).toBe(true);
        expect(sessionStorage.getItem("neore:prompt-queue:thread-6")).toContain("queued before the session was confirmed");
    });
});

describe("offline send requests after the session ends", () => {
    it("drops every held send with the queues, so a later queue under the same thread asks again", async () => {
        const store = await reload();
        const { clearPromptQueues } = await import("./prompt-queue-store");

        store.getState().holdOffline("thread-7", true);
        clearPromptQueues();

        expect(store.getState().takeOfflineHold("thread-7")).toBeUndefined();
    });
});
