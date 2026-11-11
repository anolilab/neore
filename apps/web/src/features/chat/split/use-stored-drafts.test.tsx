import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

import { clearComposerDrafts, DRAFTS_STORAGE_KEY, dropStoredDrafts } from "./composer-drafts";
import { flushStoredDrafts, resetStoredDraftsForTests } from "./stored-drafts";
import useStoredDrafts, { keepsStoredDraft } from "./use-stored-drafts";

const storeDrafts = (texts: Record<string, string>): void => {
    const at = Date.now();
    const d = Object.fromEntries(Object.entries(texts).map(([key, t]) => [key, { at, t }]));

    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify({ d, u: "user-1" }));
};

beforeEach(() => {
    localStorage.clear();
    resetStoredDraftsForTests();
    clearComposerDrafts();
    useChatUIStore.getState().clearComposer();
});

describe("useStoredDrafts", () => {
    it("restores the chat it is on when the chat changed before the storage code loaded", async () => {
        storeDrafts({ "thread-a": "draft a", "thread-b": "draft b" });

        const { rerender } = renderHook(
            ({ owner }) => {
                useStoredDrafts(owner, "user-1", false);
            },
            { initialProps: { owner: "thread-a" } },
        );

        rerender({ owner: "thread-b" });
        await vi.dynamicImportSettled();

        expect(useChatUIStore.getState().composerText).toBe("draft b");
    });

    it("binds nothing when the drafts were dropped before the storage code loaded", async () => {
        useChatUIStore.getState().setComposerText("old account's text");
        renderHook(() => {
            useStoredDrafts("thread-a", "user-1", false);
        });
        dropStoredDrafts();
        await vi.dynamicImportSettled();
        flushStoredDrafts();

        expect(localStorage.getItem(DRAFTS_STORAGE_KEY)).toBeNull();
    });
});

describe("keepsStoredDraft", () => {
    it("keeps the draft of a known cloud chat and of a new one", () => {
        expect(keepsStoredDraft(true, false, {}, false)).toBe(true);
        expect(keepsStoredDraft(true, true, undefined, false)).toBe(true);
    });

    it("keeps none for a host-run chat, whose composer holds its own text", () => {
        expect(keepsStoredDraft(true, false, { runner: "host" }, false)).toBe(false);
    });

    it("keeps none before the chat is known, for an inactive composer or for a worker", () => {
        expect(keepsStoredDraft(true, false, undefined, false)).toBe(false);
        expect(keepsStoredDraft(false, false, {}, false)).toBe(false);
        expect(keepsStoredDraft(true, false, {}, true)).toBe(false);
    });
});
