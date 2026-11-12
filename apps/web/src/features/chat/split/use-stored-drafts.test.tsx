import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

import { clearComposerDrafts, draftOwnership, dropStoredDrafts, saveComposerDraft, setSplitViewMounted } from "./composer-drafts";
import { leaveSplitView } from "./pane-state";
import { draftKey, flushStoredDrafts, resetStoredDraftsForTests } from "./stored-drafts";
import useStoredDrafts, { keepsStoredDraft } from "./use-stored-drafts";

const storeDrafts = (texts: Record<string, string>): void => {
    for (const [owner, t] of Object.entries(texts)) {
        localStorage.setItem(draftKey("user-1", owner), JSON.stringify({ t: Date.now(), v: { t }, w: "w" }));
    }
};

const storedText = (owner: string): string | undefined => JSON.parse(localStorage.getItem(draftKey("user-1", owner)) ?? "null")?.v.t;

beforeEach(() => {
    localStorage.clear();
    resetStoredDraftsForTests();
    clearComposerDrafts();
    useChatUIStore.getState().clearComposer();
    // A fresh page: the storage module has not loaded, so nothing is bound and no hand-over is installed.
    draftOwnership.first = undefined;
    draftOwnership.handOver = undefined;
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

    it("stores text typed before the storage code loaded under the chat it was typed in, not the one navigated to", async () => {
        const { rerender } = renderHook(
            ({ owner }) => {
                useStoredDrafts(owner, "user-1", false);
            },
            { initialProps: { owner: "thread-a" } },
        );

        useChatUIStore.getState().setComposerText("typed in a");
        rerender({ owner: "thread-b" });
        await vi.dynamicImportSettled();
        flushStoredDrafts();

        expect(storedText("thread-a")).toBe("typed in a");
        expect(storedText("thread-b")).toBeUndefined();
    });

    it("binds nothing when the drafts were dropped before the storage code loaded", async () => {
        useChatUIStore.getState().setComposerText("old account's text");
        renderHook(() => {
            useStoredDrafts("thread-a", "user-1", false);
        });
        dropStoredDrafts();
        await vi.dynamicImportSettled();
        flushStoredDrafts();

        expect(Object.keys(localStorage).filter((key) => key.startsWith("neore-draft:"))).toStrictEqual([]);
    });
});

describe("keepsStoredDraft", () => {
    it("stores nothing under a chat whose composer left when the shared composer is edited elsewhere, and keeps its draft", async () => {
        const { rerender } = renderHook(
            ({ userId }) => {
                useStoredDrafts("thread-a", userId, false);
            },
            { initialProps: { userId: "user-1" as string | undefined } },
        );

        await vi.dynamicImportSettled();
        useChatUIStore.getState().setComposerText("draft a");
        // The chat's composer goes (a host-run chat, say), and a view with no stored draft changes the shared composer.
        rerender({ userId: undefined });
        expect(storedText("thread-a")).toBe("draft a");

        useChatUIStore.getState().setComposerText("typed elsewhere");
        flushStoredDrafts();
        useChatUIStore.getState().clearComposer();
        flushStoredDrafts();

        expect(storedText("thread-a")).toBe("draft a");
    });

    it("keeps each chat's draft its own when split view closes on another chat before the storage code loaded", async () => {
        setSplitViewMounted(true);

        const { rerender } = renderHook(
            ({ owner }) => {
                useStoredDrafts(owner, "user-1", false);
            },
            { initialProps: { owner: "thread-a" } },
        );

        useChatUIStore.getState().setComposerText("pane a");
        saveComposerDraft("thread-b", { composerText: "pane b" });
        // The preference is off and the route shows pane b: its draft comes back to the single chat's composer.
        leaveSplitView("thread-a", "thread-b");
        setSplitViewMounted(false);
        rerender({ owner: "thread-b" });
        await vi.dynamicImportSettled();
        flushStoredDrafts();

        expect(useChatUIStore.getState().composerText).toBe("pane b");
        expect(storedText("thread-a")).toBe("pane a");
        expect(storedText("thread-b")).toBe("pane b");
    });

    it("keeps the routed chat's saved draft when split view closes after the focused pane's composer unmounted", async () => {
        setSplitViewMounted(true);

        const { unmount: unmountPaneA } = renderHook(() => {
            useStoredDrafts("thread-a", "user-1", false);
        });

        await vi.dynamicImportSettled();
        // Pane b's draft, saved on this page earlier.
        saveComposerDraft("thread-b", { composerText: "pane b" });
        useChatUIStore.getState().setComposerText("pane a");
        flushStoredDrafts();

        expect(storedText("thread-b")).toBe("pane b");

        // Split view closes: the focused pane's composer unmounts first, then the view hands the route's chat its draft.
        unmountPaneA();
        leaveSplitView("thread-a", "thread-b");
        setSplitViewMounted(false);
        renderHook(() => {
            useStoredDrafts("thread-b", "user-1", false);
        });
        await vi.dynamicImportSettled();
        flushStoredDrafts();

        expect(useChatUIStore.getState().composerText).toBe("pane b");
        expect(storedText("thread-a")).toBe("pane a");
        expect(storedText("thread-b")).toBe("pane b");
    });

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
