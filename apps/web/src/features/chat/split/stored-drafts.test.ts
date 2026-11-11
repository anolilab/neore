import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingAttachment } from "@/features/chat/core/stores/chat-ui-store";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

import { clearComposerDrafts, DRAFTS_STORAGE_KEY, dropStoredDrafts, saveComposerDraft } from "./composer-drafts";
import {
    bindStoredDrafts,
    DRAFT_TTL_MS,
    DRAFT_WRITE_DELAY_MS,
    flushStoredDrafts,
    MAX_STORED_DRAFTS,
    readStoredDrafts,
    resetStoredDraftsForTests,
} from "./stored-drafts";

const stored = (): { d: Record<string, { a?: unknown[]; at: number; r?: unknown[]; t: string }>; u: string } | null => {
    const raw = localStorage.getItem(DRAFTS_STORAGE_KEY);

    return raw === null ? null : JSON.parse(raw);
};

const type = (text: string): void => {
    useChatUIStore.getState().setComposerText(text);
};

const uploaded: PendingAttachment = {
    file: new File(["bytes"], "notes.pdf", { type: "application/pdf" }),
    fileId: "file-1",
    id: "attachment-1",
    name: "notes.pdf",
    status: "complete",
    type: "document",
};

beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetStoredDraftsForTests();
    clearComposerDrafts();
    useChatUIStore.getState().clearComposer();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("writing", () => {
    it("writes once typing stops for the delay, not on every keystroke", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);
        const setItem = vi.spyOn(Storage.prototype, "setItem");

        type("h");
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS - 1);
        type("he");
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS - 1);

        expect(setItem).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);

        expect(setItem).toHaveBeenCalledTimes(1);
        expect(stored()?.d["thread-a"]?.t).toBe("he");
    });

    it("writes a pending draft at once when the page is hidden or left", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("leaving");
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));

        expect(stored()?.d["thread-a"]?.t).toBe("leaving");

        type("leaving now");
        globalThis.dispatchEvent(new Event("pagehide"));

        expect(stored()?.d["thread-a"]?.t).toBe("leaving now");
    });

    it("keeps an uploaded attachment by file id and drops one still uploading", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        useChatUIStore.setState({ composerAttachments: [uploaded, { ...uploaded, fileId: undefined, id: "attachment-2", status: "uploading" }] });
        flushStoredDrafts();

        expect(stored()?.d["thread-a"]?.a).toStrictEqual([{ fileId: "file-1", kind: "document", mediaType: "application/pdf", name: "notes.pdf", size: 5 }]);
    });

    it("keeps no draft of a locked chat, and removes the one it had", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("secret");
        flushStoredDrafts();
        bindStoredDrafts("thread-a", "user-1", true);
        flushStoredDrafts();

        expect(stored()).toBeNull();
    });

    it("keeps a draft parked in split view under its chat", () => {
        bindStoredDrafts("thread-b", "user-1", false);
        saveComposerDraft("thread-a", { composerText: "parked" });
        flushStoredDrafts();

        expect(stored()?.d["thread-a"]?.t).toBe("parked");
    });
});

describe("sending", () => {
    it("removes the chat's draft once the composer is cleared", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("send me");
        flushStoredDrafts();
        useChatUIStore.getState().clearComposer();
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(stored()).toBeNull();
    });

    it("leaves drafts this page never wrote alone", () => {
        localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ d: { "thread-x": { at: Date.now(), t: "other tab" } }, u: "user-1" }));
        bindStoredDrafts("thread-a", "user-1", false);
        type("mine");
        flushStoredDrafts();
        useChatUIStore.getState().clearComposer();
        flushStoredDrafts();

        expect(stored()?.d).toStrictEqual({ "thread-x": { a: [], at: expect.any(Number), r: [], t: "other tab" } });
    });
});

describe("restoring", () => {
    it("fills an empty composer with the chat's draft and its uploaded attachments", () => {
        localStorage.setItem(
            DRAFTS_STORAGE_KEY,
            JSON.stringify({
                d: { "thread-a": { a: [{ fileId: "file-1", kind: "image", mediaType: "image/png", name: "a.png", size: 3 }], at: Date.now(), t: "draft" } },
                u: "user-1",
            }),
        );
        bindStoredDrafts("thread-a", "user-1", false);

        const { composerAttachments, composerText } = useChatUIStore.getState();

        expect(composerText).toBe("draft");
        expect(composerAttachments).toMatchObject([{ fileId: "file-1", name: "a.png", restoredSize: 3, status: "complete" }]);
    });

    it("never replaces text being typed", () => {
        localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ d: { "thread-a": { at: Date.now(), t: "old draft" } }, u: "user-1" }));
        type("typing");
        bindStoredDrafts("thread-a", "user-1", false);

        expect(useChatUIStore.getState().composerText).toBe("typing");
    });

    it("drops drafts older than the TTL", () => {
        localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ d: { "thread-a": { at: Date.now() - DRAFT_TTL_MS - 1, t: "stale" } }, u: "user-1" }));
        bindStoredDrafts("thread-a", "user-1", false);

        expect(useChatUIStore.getState().composerText).toBe("");
    });

    it("keeps only the most recent drafts", () => {
        const now = Date.now();
        const d = Object.fromEntries(Array.from({ length: MAX_STORED_DRAFTS }, (_, index) => [`thread-${String(index)}`, { at: now - 1000 - index, t: "x" }]));

        localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ d, u: "user-1" }));
        bindStoredDrafts("thread-new", "user-1", false);
        type("newest");
        flushStoredDrafts();

        const kept = [...readStoredDrafts("user-1").keys()];

        expect(kept).toHaveLength(MAX_STORED_DRAFTS);
        expect(kept).toContain("thread-new");
        expect(kept).not.toContain(`thread-${String(MAX_STORED_DRAFTS - 1)}`);
    });
});

describe("accounts", () => {
    it("never restores another account's drafts, and replaces them on the next write", () => {
        localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ d: { "thread-a": { at: Date.now(), t: "theirs" } }, u: "user-1" }));
        bindStoredDrafts("thread-a", "user-2", false);

        expect(useChatUIStore.getState().composerText).toBe("");

        type("mine");
        flushStoredDrafts();

        expect(stored()).toStrictEqual({ d: { "thread-a": expect.objectContaining({ t: "mine" }) }, u: "user-2" });
    });

    it("removes the drafts on sign-out, and a write pending from before does not bring them back", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("before sign-out");
        flushStoredDrafts();
        type("still pending");
        dropStoredDrafts();
        globalThis.dispatchEvent(new Event("pagehide"));
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(stored()).toBeNull();
    });

    it("removes them when the session's parked state is cleared (account switch)", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("old account");
        flushStoredDrafts();
        clearComposerDrafts();
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);
        globalThis.dispatchEvent(new Event("pagehide"));

        expect(stored()).toBeNull();
    });

    it("does not store the previous account's text under the next one", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("user one's text");
        flushStoredDrafts();
        clearComposerDrafts();
        bindStoredDrafts("new", "user-2", false);
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(stored()).toBeNull();

        type("user two's text");
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(stored()).toStrictEqual({ d: { new: expect.objectContaining({ t: "user two's text" }) }, u: "user-2" });
    });
});

describe("storage that fails", () => {
    it("keeps typing working when every access throws", () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("SecurityError");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("QuotaExceededError");
        });
        vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
            throw new Error("SecurityError");
        });

        expect(() => {
            bindStoredDrafts("thread-a", "user-1", false);
            type("still typing");
            vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);
            dropStoredDrafts();
        }).not.toThrow();
        expect(useChatUIStore.getState().composerText).toBe("still typing");
    });

    it("when full, does not leave the chat's older draft behind", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("first");
        flushStoredDrafts();

        const { setItem } = Storage.prototype;

        vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string, value: string) => {
            if (value.includes("second")) {
                throw new Error("QuotaExceededError");
            }

            setItem.call(localStorage, key, value);
        });
        type("second");
        flushStoredDrafts();

        expect(readStoredDrafts("user-1").get("thread-a")).toBeUndefined();
    });
});

describe("moving between chats", () => {
    it("does not bring back a draft emptied just before the chat was left", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("gone soon");
        flushStoredDrafts();
        useChatUIStore.getState().clearComposer();
        bindStoredDrafts("thread-b", "user-1", false);
        bindStoredDrafts("thread-a", "user-1", false);

        expect(useChatUIStore.getState().composerText).toBe("");
    });

    it("keeps the draft of a pane that lost focus while the next pane's composer mounts", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("pane a");
        saveComposerDraft("thread-a", { composerText: "pane a" });
        useChatUIStore.getState().clearComposer();
        flushStoredDrafts();

        expect(stored()?.d["thread-a"]?.t).toBe("pane a");
    });

    it("keeps both chats' drafts when the text only came along to the next chat", () => {
        localStorage.setItem(
            DRAFTS_STORAGE_KEY,
            JSON.stringify({ d: { "thread-a": { at: Date.now(), t: "x" }, "thread-b": { at: Date.now(), t: "y" } }, u: "user-1" }),
        );
        bindStoredDrafts("thread-a", "user-1", false);
        bindStoredDrafts("thread-b", "user-1", false);
        bindStoredDrafts("thread-c", "user-1", false);
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(readStoredDrafts("user-1").get("thread-a")?.t).toBe("x");
        expect(readStoredDrafts("user-1").get("thread-b")?.t).toBe("y");
        expect(readStoredDrafts("user-1").has("thread-c")).toBe(false);

        type("x edited in c");
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(readStoredDrafts("user-1").get("thread-c")?.t).toBe("x edited in c");
        expect(readStoredDrafts("user-1").has("thread-a")).toBe(false);
    });

    it("does not store a locked chat's text under the chat it came along to", () => {
        bindStoredDrafts("thread-a", "user-1", true);
        type("locked text");
        bindStoredDrafts("thread-b", "user-1", false);
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(stored()).toBeNull();
    });
});
