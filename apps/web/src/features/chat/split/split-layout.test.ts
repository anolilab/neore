import { describe, expect, it } from "vitest";

import type { ReferenceSelection } from "@/features/chat/components/reference-picker/types";
import type { PendingAttachment } from "@/features/chat/core/stores/chat-ui-store";

import { clearComposerDrafts, saveComposerDraft, takeComposerDraftState, useParkedDraftStore } from "./composer-drafts";
import type { SplitLayout } from "./split-layout";
import { initialSplitLayout, MAX_PANES, MIN_PANE_PX, parseSplitLayout, splitLayoutReducer } from "./split-layout";

const opened = (...ids: string[]): SplitLayout => {
    let layout = initialSplitLayout();

    for (const threadId of ids) {
        layout = splitLayoutReducer(layout, { threadId, type: "open" });
    }

    return layout;
};

describe("split layout limits", () => {
    it("allows three panes of at least 360px", () => {
        expect(MAX_PANES).toBe(3);
        expect(MIN_PANE_PX).toBe(360);
    });
});

describe("open", () => {
    it("adds a pane and focuses it", () => {
        const layout = opened("a", "b");

        expect(layout.panes).toEqual(["a", "b"]);
        expect(layout.focus).toBe(1);
    });

    it("focuses the pane of a chat that is already open instead of adding another", () => {
        const layout = splitLayoutReducer(opened("a", "b"), { threadId: "a", type: "open" });

        expect(layout.panes).toEqual(["a", "b"]);
        expect(layout.focus).toBe(0);
    });

    it("refuses a fourth pane and returns the same layout", () => {
        const full = opened("a", "b", "c");

        expect(splitLayoutReducer(full, { threadId: "d", type: "open" })).toBe(full);
        expect(full.panes).toHaveLength(MAX_PANES);
    });

    it("returns the same layout when the chat is already the focused pane", () => {
        const layout = opened("a", "b");

        expect(splitLayoutReducer(layout, { threadId: "b", type: "open" })).toBe(layout);
    });
});

describe("show", () => {
    it("starts the layout with the chat when there are no panes", () => {
        expect(splitLayoutReducer(initialSplitLayout(), { threadId: "a", type: "show" })).toEqual({ focus: 0, panes: ["a"], sizes: {} });
    });

    it("focuses an open chat", () => {
        expect(splitLayoutReducer(opened("a", "b"), { threadId: "a", type: "show" }).focus).toBe(0);
    });

    it("replaces the focused pane with a chat that is not open, even when every pane is taken", () => {
        const layout = splitLayoutReducer({ ...opened("a", "b", "c"), focus: 1 }, { threadId: "d", type: "show" });

        expect(layout.panes).toEqual(["a", "d", "c"]);
        expect(layout.focus).toBe(1);
    });

    it("hands the replaced pane's width to the chat that takes its place", () => {
        const sized = splitLayoutReducer(opened("a", "b"), { sizes: { a: 40, b: 60 }, type: "resize" });
        const layout = splitLayoutReducer(sized, { threadId: "c", type: "show" });

        expect(layout.sizes).toEqual({ a: 40, c: 60 });
    });
});

describe("focus", () => {
    it("moves focus to the pane", () => {
        expect(splitLayoutReducer({ ...opened("a", "b"), focus: 1 }, { index: 0, type: "focus" }).focus).toBe(0);
    });

    it("ignores an index that is not a pane", () => {
        const layout = opened("a", "b");

        expect(splitLayoutReducer(layout, { index: 5, type: "focus" })).toBe(layout);
        expect(splitLayoutReducer(layout, { index: -1, type: "focus" })).toBe(layout);
    });

    it("returns the same layout when the pane already has focus", () => {
        const layout = opened("a", "b");

        expect(splitLayoutReducer(layout, { index: 1, type: "focus" })).toBe(layout);
    });
});

describe("close", () => {
    it("removes the pane and keeps focus on the same chat when a pane before it closes", () => {
        const layout = splitLayoutReducer(opened("a", "b"), { index: 0, type: "close" });

        expect(layout.panes).toEqual(["b"]);
        expect(layout.panes[layout.focus]).toBe("b");
    });

    it("moves focus to the neighbour when the focused pane closes", () => {
        const layout = splitLayoutReducer({ ...opened("a", "b"), focus: 1 }, { index: 1, type: "close" });

        expect(layout.panes).toEqual(["a"]);
        expect(layout.panes[layout.focus]).toBe("a");
    });

    it("focuses the new last pane when the last focused pane closes", () => {
        const layout = splitLayoutReducer(opened("a", "b"), { index: 1, type: "close" });

        expect(layout.panes).toEqual(["a"]);
        expect(layout.focus).toBe(0);
    });

    it("keeps the focused chat when another pane closes", () => {
        const layout = splitLayoutReducer({ ...opened("a", "b"), focus: 0 }, { index: 1, type: "close" });

        expect(layout.panes[layout.focus]).toBe("a");
    });

    it("never closes the last pane", () => {
        const single = opened("a");

        expect(splitLayoutReducer(single, { index: 0, type: "close" })).toBe(single);
    });

    it("drops the closed pane's width", () => {
        const sized = splitLayoutReducer(opened("a", "b"), { sizes: { a: 50, b: 50 }, type: "resize" });

        expect(splitLayoutReducer(sized, { index: 1, type: "close" }).sizes).toEqual({ a: 50 });
    });

    it("ignores an index that is not a pane", () => {
        const layout = opened("a", "b");

        expect(splitLayoutReducer(layout, { index: 4, type: "close" })).toBe(layout);
    });
});

describe("resize", () => {
    it("stores the width of each open pane", () => {
        const layout = splitLayoutReducer(opened("a", "b"), { sizes: { a: 30, b: 70 }, type: "resize" });

        expect(layout.sizes).toEqual({ a: 30, b: 70 });
    });

    it("drops widths of chats that are not panes and values that are not sizes", () => {
        const layout = splitLayoutReducer(opened("a", "b"), { sizes: { a: NaN, b: 70, z: 10 }, type: "resize" });

        expect(layout.sizes).toEqual({ b: 70 });
    });

    it("returns the same layout when nothing changed", () => {
        const sized = splitLayoutReducer(opened("a", "b"), { sizes: { a: 30, b: 70 }, type: "resize" });

        expect(splitLayoutReducer(sized, { sizes: { a: 30, b: 70 }, type: "resize" })).toBe(sized);
    });
});

describe("prune", () => {
    it("drops panes that are not valid and keeps focus on the same chat", () => {
        const layout = splitLayoutReducer({ ...opened("a", "b"), focus: 1 }, { isValid: (id) => id !== "a", type: "prune" });

        expect(layout.panes).toEqual(["b"]);
        expect(layout.panes[layout.focus]).toBe("b");
    });

    it("moves focus to the first pane when the focused chat is dropped", () => {
        const layout = splitLayoutReducer({ ...opened("a", "b"), focus: 1 }, { isValid: (id) => id !== "b", type: "prune" });

        expect(layout.panes).toEqual(["a"]);
        expect(layout.focus).toBe(0);
    });

    it("returns the same layout when every pane is valid", () => {
        const layout = opened("a", "b");

        expect(splitLayoutReducer(layout, { isValid: () => true, type: "prune" })).toBe(layout);
    });
});

describe("parseSplitLayout", () => {
    it("falls back to the empty layout for anything malformed", () => {
        expect(parseSplitLayout(null)).toEqual(initialSplitLayout());
        expect(parseSplitLayout("x")).toEqual(initialSplitLayout());
        expect(parseSplitLayout({ panes: "a" })).toEqual(initialSplitLayout());
    });

    it("keeps at most three unique, well-formed ids and a focus that points at one of them", () => {
        const layout = parseSplitLayout({ focus: 9, panes: ["a", "a", "b", 7, "c", "d", "bad id"], sizes: { a: 50, b: -1 } });

        expect(layout.panes).toEqual(["a", "b", "c"]);
        expect(layout.focus).toBe(0);
        expect(layout.sizes).toEqual({ a: 50 });
    });
});

describe("composer drafts", () => {
    it("takes back what was saved, once", () => {
        clearComposerDrafts();
        saveComposerDraft("a", { composerText: "hello" });

        expect(takeComposerDraftState("a").composerText).toBe("hello");
        expect(takeComposerDraftState("a").composerText).toBe("");
    });

    it("keeps a draft per chat", () => {
        clearComposerDrafts();
        saveComposerDraft("a", { composerText: "one" });
        saveComposerDraft("b", { composerText: "two" });

        expect(takeComposerDraftState("b").composerText).toBe("two");
        expect(takeComposerDraftState("a").composerText).toBe("one");
    });

    it("forgets a draft that was saved empty", () => {
        clearComposerDrafts();
        saveComposerDraft("a", { composerText: "text" });
        saveComposerDraft("a", { composerText: "" });

        expect(takeComposerDraftState("a").composerText).toBe("");
    });

    it("keeps attachments and references per chat", () => {
        clearComposerDrafts();

        const attachment = { file: new File([], "a.png"), id: "att-1", name: "a.png", status: "complete", type: "image" } as PendingAttachment;
        const reference = { id: "ref-1" } as ReferenceSelection;

        saveComposerDraft("a", { attachedReferences: [reference], composerAttachments: [attachment], composerText: "" });
        saveComposerDraft("b", { composerText: "just text" });

        expect(takeComposerDraftState("b")).toEqual({ attachedReferences: [], composerAttachments: [], composerText: "just text" });
        expect(takeComposerDraftState("a")).toEqual({ attachedReferences: [reference], composerAttachments: [attachment], composerText: "" });
        expect(takeComposerDraftState("a").composerAttachments).toEqual([]);
    });

    it("forgets a draft with no text, attachments or references", () => {
        clearComposerDrafts();
        saveComposerDraft("a", { attachedReferences: [], composerAttachments: [], composerText: "" });

        expect(takeComposerDraftState("a")).toEqual({ attachedReferences: [], composerAttachments: [], composerText: "" });
    });

    it("keeps the set of parked thread ids in step with save, take and clear", () => {
        const parked = () => [...useParkedDraftStore.getState().threadIds].toSorted((a, b) => a.localeCompare(b));

        clearComposerDrafts();
        saveComposerDraft("a", { composerText: "one" });
        saveComposerDraft("b", { composerText: "two" });

        expect(parked()).toEqual(["a", "b"]);

        saveComposerDraft("a", { composerText: "" });

        expect(parked()).toEqual(["b"]);

        takeComposerDraftState("b");

        expect(parked()).toEqual([]);

        saveComposerDraft("c", { composerText: "three" });
        clearComposerDrafts();

        expect(parked()).toEqual([]);
    });
});
