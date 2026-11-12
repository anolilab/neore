import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingAttachment } from "@/features/chat/core/stores/chat-ui-store";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

import { clearComposerDrafts, draftOwnership, dropStoredDrafts, saveComposerDraft, setSplitViewMounted } from "./composer-drafts";
import { leaveSplitView, restoreLiveComposerFor, watchPaneFocus } from "./pane-state";
import { initialSplitLayout, splitLayoutReducer } from "./split-layout";
import { useSplitLayoutStore } from "./split-layout-store";
import {
    bindStoredDrafts,
    DRAFT_TTL_MS,
    DRAFT_WRITE_DELAY_MS,
    draftKey,
    flushStoredDrafts,
    LEGACY_DRAFTS_KEY,
    lockStoredDraft,
    MAX_STORED_DRAFTS,
    NEW_CHAT_DRAFT_KEY,
    releaseStoredDrafts,
    resetStoredDraftsForTests,
} from "./stored-drafts";

const entry = (owner: string, userId = "user-1"): { t: number; v: { a?: unknown[]; r?: unknown[]; t: string }; w: string } | undefined => {
    const raw = localStorage.getItem(draftKey(userId, owner));

    return raw === null ? undefined : JSON.parse(raw);
};

const text = (owner: string, userId = "user-1"): string | undefined => entry(owner, userId)?.v.t;

/** Another tab's (or a previous page load's) entry. */
const put = (owner: string, t: string, { at = Date.now(), userId = "user-1", w = "other" }: { at?: number; userId?: string; w?: string } = {}): void => {
    localStorage.setItem(draftKey(userId, owner), JSON.stringify({ t: at, v: { t }, w }));
};

/** A day in ms, spelled out so the test does not lean on the module's own window. */
const DAY_MS = 24 * 60 * 60 * 1000;

const draftKeys = (): string[] => Object.keys(localStorage).filter((key) => key.startsWith("neore-draft:"));

const type = (value: string): void => {
    useChatUIStore.getState().setComposerText(value);
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
    // Just before a day boundary (and a DST change in Europe), so the TTL and the delay never depend on when the run starts.
    vi.setSystemTime(new Date("2026-03-29T00:59:59.800Z"));
    localStorage.clear();
    resetStoredDraftsForTests();
    clearComposerDrafts();
    draftOwnership.prefill = undefined;
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
        expect(text("thread-a")).toBe("he");
    });

    it("writes only the entries of drafts that changed here", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("mine");
        saveComposerDraft("thread-b", { composerText: "parked" });
        flushStoredDrafts();
        const setItem = vi.spyOn(Storage.prototype, "setItem");

        type("mine, edited");
        flushStoredDrafts();

        expect(setItem.mock.calls.map(([key]) => key)).toStrictEqual([draftKey("user-1", "thread-a")]);
    });

    it("writes a pending draft at once when the page is hidden or left", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("leaving");
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));

        expect(text("thread-a")).toBe("leaving");

        type("leaving now");
        globalThis.dispatchEvent(new Event("pagehide"));

        expect(text("thread-a")).toBe("leaving now");
    });

    it("keeps an uploaded attachment by file id and drops one still uploading", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        useChatUIStore.setState({ composerAttachments: [uploaded, { ...uploaded, fileId: undefined, id: "attachment-2", status: "uploading" }] });
        flushStoredDrafts();

        expect(entry("thread-a")?.v.a).toStrictEqual([{ fileId: "file-1", kind: "document", mediaType: "application/pdf", name: "notes.pdf", size: 5 }]);
    });

    it("removes the draft of a chat seen locked at once, and keeps none for it", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("secret");
        flushStoredDrafts();
        bindStoredDrafts("thread-a", "user-1", true);

        expect(draftKeys()).toStrictEqual([]);

        flushStoredDrafts();

        expect(draftKeys()).toStrictEqual([]);
    });

    it("removes the draft of a chat the lock gate keeps closed, from any account, and stores none for it", () => {
        put("thread-a", "secret");
        put("thread-a", "secret too", { userId: "user-2" });
        put("thread-b", "other");
        lockStoredDraft("thread-a");

        expect(draftKeys()).toStrictEqual([draftKey("user-1", "thread-b")]);

        bindStoredDrafts("thread-b", "user-1", false);
        saveComposerDraft("thread-a", { composerText: "parked secret" });
        flushStoredDrafts();

        expect(text("thread-a")).toBeUndefined();
    });

    it("stores a chat's draft again once it binds unlocked", () => {
        lockStoredDraft("thread-a");
        bindStoredDrafts("thread-a", "user-1", false);
        type("unlocked now");
        flushStoredDrafts();

        expect(text("thread-a")).toBe("unlocked now");
    });

    it("writes a parked draft again when its upload finishes", () => {
        bindStoredDrafts("thread-b", "user-1", false);
        saveComposerDraft("thread-a", { composerAttachments: [{ ...uploaded, fileId: undefined, status: "uploading" }] });
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(text("thread-a")).toBeUndefined();

        useChatUIStore.getState().updateAttachment("attachment-1", { fileId: "file-1", status: "complete" });
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(entry("thread-a")?.v.a).toHaveLength(1);
    });
});

describe("sending", () => {
    it("removes the chat's draft once the composer is cleared", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("send me");
        flushStoredDrafts();
        useChatUIStore.getState().clearComposer();
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(draftKeys()).toStrictEqual([]);
    });

    it("leaves drafts this page never wrote alone", () => {
        put("thread-x", "other tab");
        bindStoredDrafts("thread-a", "user-1", false);
        type("mine");
        flushStoredDrafts();
        useChatUIStore.getState().clearComposer();
        flushStoredDrafts();

        expect(draftKeys()).toStrictEqual([draftKey("user-1", "thread-x")]);
    });
});

describe("other tabs", () => {
    it("never rewrites another tab's entry of a different chat (no read-modify-write of a shared record)", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("tab one");
        flushStoredDrafts();
        // The other tab wrote thread-b after this tab last read anything: a shared record rewritten from that read would lose it.
        put("thread-b", "tab two");
        type("tab one, edited");
        flushStoredDrafts();

        expect(text("thread-a")).toBe("tab one, edited");
        expect(text("thread-b")).toBe("tab two");
    });

    it("does not overwrite another tab's newer draft of the same chat with an unchanged copy", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("tab one");
        flushStoredDrafts();
        put("thread-a", "tab two");
        saveComposerDraft("thread-b", { composerText: "another chat" });
        flushStoredDrafts();

        expect(text("thread-a")).toBe("tab two");
        expect(text("thread-b")).toBe("another chat");

        type("tab one, edited");
        flushStoredDrafts();

        expect(text("thread-a")).toBe("tab one, edited");
    });

    it("writes a draft edited away and back again when another tab wrote the chat's entry meanwhile", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("mine");
        flushStoredDrafts();
        type("mine, changed");
        put("thread-a", "the other tab's");
        type("mine");
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(text("thread-a")).toBe("mine");
    });

    it("does not remove another tab's draft of the same chat written in the same millisecond", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("tab one");
        flushStoredDrafts();
        put("thread-a", "tab two", { at: entry("thread-a")?.t });
        useChatUIStore.getState().clearComposer();
        flushStoredDrafts();

        expect(text("thread-a")).toBe("tab two");
    });
});

describe("restoring", () => {
    it("removes a restored draft that is sent before the first write", () => {
        put("thread-a", "restored");
        bindStoredDrafts("thread-a", "user-1", false);

        expect(useChatUIStore.getState().composerText).toBe("restored");

        useChatUIStore.getState().clearComposer();
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(draftKeys()).toStrictEqual([]);
    });

    it("fills an empty composer with the chat's draft and its uploaded attachments", () => {
        localStorage.setItem(
            draftKey("user-1", "thread-a"),
            JSON.stringify({
                t: Date.now(),
                v: { a: [{ fileId: "file-1", kind: "image", mediaType: "image/png", name: "a.png", size: 3 }], t: "draft" },
                w: "x",
            }),
        );
        bindStoredDrafts("thread-a", "user-1", false);

        const { composerAttachments, composerText } = useChatUIStore.getState();

        expect(composerText).toBe("draft");
        expect(composerAttachments).toMatchObject([{ fileId: "file-1", name: "a.png", restoredSize: 3, status: "complete" }]);
    });

    it("never replaces text being typed", () => {
        put("thread-a", "old draft");
        type("typing");
        bindStoredDrafts("thread-a", "user-1", false);

        expect(useChatUIStore.getState().composerText).toBe("typing");
    });

    it("drops a reference whose signed URL has expired, and brings the rest of the draft back", () => {
        const expired = { id: "file:old", mimeType: "image/png", url: `https://files.example/a.png?exp=${String(Math.floor(Date.now() / 1000) - 60)}&sig=x` };
        const valid = { id: "file:new", mimeType: "image/png", url: `https://files.example/b.png?exp=${String(Math.floor(Date.now() / 1000) + 3600)}&sig=y` };

        localStorage.setItem(draftKey("user-1", "thread-a"), JSON.stringify({ t: Date.now(), v: { r: [expired, valid], t: "with images" }, w: "other" }));
        bindStoredDrafts("thread-a", "user-1", false);

        expect(useChatUIStore.getState().composerText).toBe("with images");
        expect(useChatUIStore.getState().attachedReferences).toStrictEqual([valid]);
    });

    it("treats a draft saved too far in the future as unreadable, so a clock set back cannot keep it past the TTL", () => {
        put("thread-a", "from the future", { at: Date.now() + 2 * DAY_MS });
        bindStoredDrafts("thread-a", "user-1", false);

        expect(useChatUIStore.getState().composerText).toBe("");

        saveComposerDraft("thread-b", { composerText: "fresh" });
        flushStoredDrafts();

        expect(draftKeys()).toStrictEqual([draftKey("user-1", "thread-b")]);
    });

    it("deletes drafts older than the TTL from storage on the next write, not only ignores them", () => {
        put("thread-a", "stale", { at: Date.now() - DRAFT_TTL_MS - 1 });
        bindStoredDrafts("thread-a", "user-1", false);

        expect(useChatUIStore.getState().composerText).toBe("");

        saveComposerDraft("thread-b", { composerText: "fresh" });
        flushStoredDrafts();

        expect(draftKeys()).toStrictEqual([draftKey("user-1", "thread-b")]);
    });

    it("keeps only each account's most recent drafts", () => {
        const now = Date.now();

        for (let index = 0; index < MAX_STORED_DRAFTS; index += 1) {
            put(`thread-${String(index)}`, "x", { at: now - 1000 - index });
        }

        put("thread-0", "y", { userId: "user-2" });
        bindStoredDrafts("thread-new", "user-1", false);
        type("newest");
        flushStoredDrafts();

        const kept = draftKeys();

        expect(kept.filter((key) => key.startsWith("neore-draft:user-1:"))).toHaveLength(MAX_STORED_DRAFTS);
        expect(kept).toContain(draftKey("user-1", "thread-new"));
        expect(kept).toContain(draftKey("user-2", "thread-0"));
        expect(kept).not.toContain(draftKey("user-1", `thread-${String(MAX_STORED_DRAFTS - 1)}`));
    });

    it("does not remove a draft over the cap that another tab saved again while the cleanup ran", () => {
        const now = Date.now();
        const oldest = `thread-${String(MAX_STORED_DRAFTS - 1)}`;

        for (let index = 0; index < MAX_STORED_DRAFTS; index += 1) {
            put(`thread-${String(index)}`, "x", { at: now - 1000 - index });
        }

        bindStoredDrafts("thread-new", "user-1", false);
        type("newest");

        const getItem = localStorage.getItem.bind(localStorage);
        let armed = true;

        // The cleanup has read every entry (the newest last) when another tab saves the oldest one again.
        vi.spyOn(Storage.prototype, "getItem").mockImplementation((key: string) => {
            const value = getItem(key);

            if (armed && value !== null && key === draftKey("user-1", "thread-new")) {
                armed = false;
                put(oldest, "saved again in another tab", { w: "tab-2" });
            }

            return value;
        });
        flushStoredDrafts();

        expect(text(oldest)).toBe("saved again in another tab");
        expect(armed).toBe(false);
    });
});

describe("loading", () => {
    it("removes clear markers older than the drafts' TTL on its first use, and keeps newer ones", () => {
        localStorage.setItem("neore-draft-cleared:old-user", String(Date.now() - DRAFT_TTL_MS - 1));
        localStorage.setItem("neore-draft-cleared:recent-user", String(Date.now()));
        bindStoredDrafts("thread-a", "user-1", false);

        expect(localStorage.getItem("neore-draft-cleared:old-user")).toBeNull();
        expect(localStorage.getItem("neore-draft-cleared:recent-user")).not.toBeNull();
    });

    it("removes expired entries and the old single record on its first use after a load, with no write", () => {
        put("thread-a", "stale", { at: Date.now() - DRAFT_TTL_MS - 1, userId: "user-2" });
        put("thread-b", "fresh");
        localStorage.setItem(LEGACY_DRAFTS_KEY, JSON.stringify({ d: { "thread-c": { at: Date.now(), t: "old" } }, u: "user-1" }));
        bindStoredDrafts("thread-z", "user-1", false);

        expect(draftKeys()).toStrictEqual([draftKey("user-1", "thread-b")]);
        expect(localStorage.getItem(LEGACY_DRAFTS_KEY)).toBeNull();
    });
});

describe("accounts", () => {
    it("never restores another account's drafts, nor touches them on a write", () => {
        put("thread-a", "theirs");
        bindStoredDrafts("thread-a", "user-2", false);

        expect(useChatUIStore.getState().composerText).toBe("");

        type("mine");
        flushStoredDrafts();

        expect(text("thread-a", "user-2")).toBe("mine");
        expect(text("thread-a")).toBe("theirs");
    });

    it("removes only the departing account's drafts on sign-out, and a write pending from before does not bring them back", () => {
        put("thread-z", "other account", { userId: "user-2" });
        bindStoredDrafts("thread-a", "user-1", false);
        type("before sign-out");
        flushStoredDrafts();
        type("still pending");
        dropStoredDrafts("user-1");
        globalThis.dispatchEvent(new Event("pagehide"));
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(draftKeys()).toStrictEqual([draftKey("user-2", "thread-z")]);
    });

    it("does not store the previous account's text under the next one", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("user one's text");
        flushStoredDrafts();
        clearComposerDrafts("user-1");
        bindStoredDrafts("new", "user-2", false);
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(draftKeys()).toStrictEqual([]);

        type("user two's text");
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(draftKeys()).toStrictEqual([draftKey("user-2", "new")]);
    });

    it("keeps saving the next account's drafts when its composer bound before the departing account's were dropped", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("user one's text");
        flushStoredDrafts();
        bindStoredDrafts("new", "user-2", false);
        clearComposerDrafts("user-1");
        type("user two's text");
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(draftKeys()).toStrictEqual([draftKey("user-2", "new")]);
        expect(text("new", "user-2")).toBe("user two's text");
    });
});

describe("a released composer", () => {
    it("stores nothing under the chat it left when its text came from another account", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("first account's text");
        // An account switch without a reload: the text stays in the composer and is no chat's.
        bindStoredDrafts("thread-a", "user-2", false);
        releaseStoredDrafts("thread-a");
        type("typed with no chat's composer on the page");
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);
        flushStoredDrafts();

        expect(text("thread-a", "user-2")).toBeUndefined();
    });
});

describe("after a clear", () => {
    it("keeps saving after a sign-out when the clock is set back, until another clear comes", () => {
        dropStoredDrafts("user-1");
        vi.setSystemTime(Date.now() - DAY_MS);
        bindStoredDrafts("thread-a", "user-1", false);
        type("after the clock went back");
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(text("thread-a")).toBe("after the clock went back");
    });

    it("does not write an account's drafts back after another tab signed it out", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("before sign-out");
        flushStoredDrafts();
        vi.advanceTimersByTime(1);
        // Another tab signs out: its clear removes the entries and marks the time.
        localStorage.removeItem(draftKey("user-1", "thread-a"));
        localStorage.setItem("neore-draft-cleared:user-1", String(Date.now()));
        type("typed after it");
        globalThis.dispatchEvent(new Event("pagehide"));

        expect(draftKeys()).toStrictEqual([]);
    });

    it("does not store text from before a sign-out under a chat bound again after it", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("before");
        flushStoredDrafts();
        dropStoredDrafts("user-1");
        bindStoredDrafts("thread-a", "user-1", false);
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(draftKeys()).toStrictEqual([]);

        type("after");
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(text("thread-a")).toBe("after");
    });

    it("does not store the previous account's text when its upload finishes under the next one", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("user one's text");
        useChatUIStore.setState({ composerAttachments: [{ ...uploaded, fileId: undefined, status: "uploading" }] });
        flushStoredDrafts();
        clearComposerDrafts("user-1");
        bindStoredDrafts("new", "user-2", false);
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);
        useChatUIStore.getState().updateAttachment("attachment-1", { fileId: "file-1", status: "complete" });
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(draftKeys()).toStrictEqual([]);
    });
});

describe("a prefilled message", () => {
    const prefill = (value: string): void => {
        draftOwnership.prefill = value;
        type(value);
    };

    it("is not stored over the chat's saved draft, which comes back once the prefill is sent", () => {
        put("thread-a", "saved draft");
        prefill("from the link");
        bindStoredDrafts("thread-a", "user-1", false);
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(useChatUIStore.getState().composerText).toBe("from the link");
        expect(text("thread-a")).toBe("saved draft");

        useChatUIStore.getState().clearComposer();

        expect(useChatUIStore.getState().composerText).toBe("saved draft");

        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(text("thread-a")).toBe("saved draft");
    });

    it("keeps the chat's saved draft when sending the prefill fails and its text comes back", () => {
        put("thread-a", "saved draft");
        prefill("from the link");
        bindStoredDrafts("thread-a", "user-1", false);

        // The send: submitting first, then the composer empties.
        useChatUIStore.getState().setIsSubmitting(true);
        useChatUIStore.getState().clearComposer();

        expect(useChatUIStore.getState().composerText).toBe("");

        // It fails: the text comes back, then submitting ends.
        useChatUIStore.getState().setComposerText("from the link");
        useChatUIStore.getState().setIsSubmitting(false);
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(useChatUIStore.getState().composerText).toBe("from the link");
        expect(text("thread-a")).toBe("saved draft");
    });

    it("brings the chat's saved draft back once the prefill's send ends", () => {
        put("thread-a", "saved draft");
        prefill("from the link");
        bindStoredDrafts("thread-a", "user-1", false);
        useChatUIStore.getState().setIsSubmitting(true);
        useChatUIStore.getState().clearComposer();
        useChatUIStore.getState().setIsSubmitting(false);

        expect(useChatUIStore.getState().composerText).toBe("saved draft");
    });

    it("keeps the draft of the chat whose text it replaced when it came along to another chat", () => {
        put("thread-a", "draft of a");
        bindStoredDrafts("thread-a", "user-1", false);
        // Single view keeps the text when you move on: it is still thread-a's.
        bindStoredDrafts("thread-b", "user-1", false);
        prefill("from the link");
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(useChatUIStore.getState().composerText).toBe("from the link");
        expect(text("thread-a")).toBe("draft of a");
        expect(text("thread-b")).toBeUndefined();
    });

    it("is stored once edited", () => {
        put("thread-a", "saved draft");
        bindStoredDrafts("thread-a", "user-1", false);
        useChatUIStore.getState().clearComposer();
        prefill("from the link");
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(text("thread-a")).toBe("saved draft");

        type("from the link, edited");
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(text("thread-a")).toBe("from the link, edited");
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
            dropStoredDrafts("user-1");
        }).not.toThrow();
        expect(useChatUIStore.getState().composerText).toBe("still typing");
    });

    it("removes the departing account's drafts on sign-out even when storage is too full for the clear marker", () => {
        put("thread-a", "on a shared device");

        const { setItem } = Storage.prototype;

        vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string, value: string) => {
            if (key.startsWith("neore-draft-cleared:")) {
                throw new Error("QuotaExceededError");
            }

            setItem.call(localStorage, key, value);
        });
        dropStoredDrafts("user-1");

        expect(draftKeys()).toStrictEqual([]);
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

        expect(text("thread-a")).toBeUndefined();
    });

    it("writes a draft again once storage that was out of reach is back", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("first");
        flushStoredDrafts();

        const blocked = vi.spyOn(globalThis, "localStorage", "get").mockImplementation(() => {
            throw new Error("SecurityError");
        });

        type("second");
        flushStoredDrafts();
        blocked.mockRestore();
        // Any later write (here another chat's parked draft) brings the unchanged text along.
        saveComposerDraft("thread-b", { composerText: "other" });
        flushStoredDrafts();

        expect(text("thread-a")).toBe("second");
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

    it("keeps both chats' drafts when the text only came along to the next chat", () => {
        put("thread-a", "x");
        put("thread-b", "y");
        bindStoredDrafts("thread-a", "user-1", false);
        bindStoredDrafts("thread-b", "user-1", false);
        bindStoredDrafts("thread-c", "user-1", false);
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(text("thread-a")).toBe("x");
        expect(text("thread-b")).toBe("y");
        expect(text("thread-c")).toBeUndefined();

        type("x edited in c");
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(text("thread-c")).toBe("x edited in c");
        expect(text("thread-a")).toBeUndefined();
    });

    it("does not store a locked chat's text under the chat it came along to", () => {
        bindStoredDrafts("thread-a", "user-1", true);
        type("locked text");
        bindStoredDrafts("thread-b", "user-1", false);
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(draftKeys()).toStrictEqual([]);
    });
});

describe("switching split panes", () => {
    const watcher: { stop?: () => void } = {};

    beforeEach(() => {
        let layout = initialSplitLayout();

        layout = splitLayoutReducer(layout, { threadId: "thread-a", type: "open" });
        layout = splitLayoutReducer(layout, { threadId: "thread-b", type: "open" });
        layout = splitLayoutReducer(layout, { index: 0, type: "focus" });
        useSplitLayoutStore.setState({ layout });
        setSplitViewMounted(true);
        watcher.stop = watchPaneFocus();
    });

    afterEach(() => {
        watcher.stop?.();
        setSplitViewMounted(false);
        useSplitLayoutStore.setState({ layout: initialSplitLayout() });
    });

    it("stores each pane's text under its own chat right after the switch, before any timer runs", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("pane a");
        saveComposerDraft("thread-b", { composerText: "pane b" });
        flushStoredDrafts();

        useSplitLayoutStore.getState().dispatch({ index: 1, type: "focus" });
        // The split view's parent effect brings the incoming pane's draft back, then its composer binds.
        restoreLiveComposerFor("thread-b");
        bindStoredDrafts("thread-b", "user-1", false);

        expect(text("thread-a")).toBe("pane a");
        expect(text("thread-b")).toBe("pane b");
    });

    it("does not write a pane's untouched prefill over its chat's saved draft when focus moves, and holds it again on return", () => {
        put("thread-a", "saved draft");
        bindStoredDrafts("thread-a", "user-1", false);
        draftOwnership.prefill = "from the link";
        type("from the link");
        saveComposerDraft("thread-b", { composerText: "pane b" });
        flushStoredDrafts();

        useSplitLayoutStore.getState().dispatch({ index: 1, type: "focus" });
        restoreLiveComposerFor("thread-b");
        bindStoredDrafts("thread-b", "user-1", false);
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(text("thread-a")).toBe("saved draft");

        useSplitLayoutStore.getState().dispatch({ index: 0, type: "focus" });
        restoreLiveComposerFor("thread-a");
        bindStoredDrafts("thread-a", "user-1", false);
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(useChatUIStore.getState().composerText).toBe("from the link");
        expect(text("thread-a")).toBe("saved draft");
        expect(text("thread-b")).toBe("pane b");
    });

    it("keeps the new chat's text its own when split view opens on a chat with a saved draft", () => {
        setSplitViewMounted(false);
        put("thread-a", "draft of a");
        bindStoredDrafts(NEW_CHAT_DRAFT_KEY, "user-1", false);
        type("typed on /chat");
        flushStoredDrafts();

        setSplitViewMounted(true);
        // The composer is not empty: the pane's draft does not come back over the text.
        restoreLiveComposerFor("thread-a");
        bindStoredDrafts("thread-a", "user-1", false);
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(text(NEW_CHAT_DRAFT_KEY)).toBe("typed on /chat");
        expect(text("thread-a")).toBe("draft of a");
    });

    it("stores a pane's parked draft under its own chat when split view opens from an empty new-chat composer", () => {
        setSplitViewMounted(false);
        bindStoredDrafts(NEW_CHAT_DRAFT_KEY, "user-1", false);

        setSplitViewMounted(true);
        saveComposerDraft("thread-a", { composerText: "pane a" });
        restoreLiveComposerFor("thread-a");
        bindStoredDrafts("thread-a", "user-1", false);
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(text("thread-a")).toBe("pane a");
        expect(text(NEW_CHAT_DRAFT_KEY)).toBeUndefined();
    });

    it("keeps each chat's draft its own when split view closes on another chat than the focused pane's", () => {
        bindStoredDrafts("thread-a", "user-1", false);
        type("pane a");
        saveComposerDraft("thread-b", { composerText: "pane b" });
        flushStoredDrafts();

        // The preference is off and the route shows pane b: its draft comes back to the single chat's composer.
        leaveSplitView("thread-a", "thread-b");
        setSplitViewMounted(false);
        bindStoredDrafts("thread-b", "user-1", false);
        vi.advanceTimersByTime(DRAFT_WRITE_DELAY_MS);

        expect(useChatUIStore.getState().composerText).toBe("pane b");
        expect(text("thread-a")).toBe("pane a");
        expect(text("thread-b")).toBe("pane b");
    });
});
