import { describe, expect, it } from "vitest";

import type { Layout } from "./layout";
import { initialLayout, layoutReducer, parseLayout } from "./layout";

const opened = (...ids: string[]): Layout => {
    let layout = initialLayout();

    for (const tabId of ids) {
        layout = layoutReducer(layout, { tabId, type: "open" });
    }

    return layout;
};

describe("layoutReducer", () => {
    it("opens tabs into the active pane and activates the newest", () => {
        const layout = opened("host:a", "host:b");

        expect(layout.panes[0]).toEqual({ active: "host:b", tabs: ["host:a", "host:b"] });
    });

    it("re-opening an existing tab only activates it", () => {
        const layout = layoutReducer(opened("host:a", "host:b"), { tabId: "host:a", type: "open" });

        expect(layout.panes[0]).toEqual({ active: "host:a", tabs: ["host:a", "host:b"] });
    });

    it("activates a tab that lives in the other pane instead of duplicating it", () => {
        let layout = layoutReducer(opened("host:a"), { paneIndex: 0, type: "split" });

        layout = layoutReducer(layout, { tabId: "host:b", type: "open" });
        layout = layoutReducer(layout, { paneIndex: 0, tabId: "host:a", type: "activate" });
        layout = layoutReducer(layout, { tabId: "host:b", type: "open" });

        expect(layout.activePane).toBe(1);
        expect(layout.panes[1]!.tabs).toEqual(["host:a", "host:b"]);
    });

    it("closing the active tab activates its neighbour", () => {
        const layout = layoutReducer(opened("host:a", "host:b", "host:c"), { paneIndex: 0, tabId: "host:c", type: "close" });

        expect(layout.panes[0]).toEqual({ active: "host:b", tabs: ["host:a", "host:b"] });
        expect(layoutReducer(layout, { paneIndex: 0, tabId: "host:b", type: "close" }).panes[0]!.active).toBe("host:a");
    });

    it("closing an inactive tab keeps the active one", () => {
        const layout = layoutReducer(opened("host:a", "host:b"), { paneIndex: 0, tabId: "host:a", type: "close" });

        expect(layout.panes[0]).toEqual({ active: "host:b", tabs: ["host:b"] });
    });

    it("closing the last tab leaves an empty pane", () => {
        const layout = layoutReducer(opened("host:a"), { paneIndex: 0, tabId: "host:a", type: "close" });

        expect(layout.panes[0]).toEqual({ active: undefined, tabs: [] });
    });

    it("splits the active tab into a second pane, at most two", () => {
        const layout = layoutReducer(opened("host:a"), { paneIndex: 0, type: "split" });

        expect(layout.panes).toHaveLength(2);
        expect(layout.panes[1]).toEqual({ active: "host:a", tabs: ["host:a"] });
        expect(layout.activePane).toBe(1);
        expect(layoutReducer(layout, { paneIndex: 1, type: "split" })).toBe(layout);
    });

    it("does not split an empty pane", () => {
        const layout = initialLayout();

        expect(layoutReducer(layout, { paneIndex: 0, type: "split" })).toBe(layout);
    });

    it("closePane removes a pane, and empties the only one", () => {
        const two = layoutReducer(opened("host:a"), { paneIndex: 0, type: "split" });

        expect(layoutReducer(two, { paneIndex: 1, type: "closePane" }).panes).toHaveLength(1);
        expect(layoutReducer(opened("host:a"), { paneIndex: 0, type: "closePane" }).panes[0]).toEqual({ active: undefined, tabs: [] });
    });

    it("focus switches the active pane and ignores unknown panes", () => {
        const two = layoutReducer(opened("host:a"), { paneIndex: 0, type: "split" });

        expect(layoutReducer(two, { paneIndex: 0, type: "focus" }).activePane).toBe(0);
        expect(layoutReducer(two, { paneIndex: 5, type: "focus" })).toBe(two);
    });

    it("clamps the split", () => {
        expect(layoutReducer(initialLayout(), { split: 3, type: "resize" }).split).toBe(20);
        expect(layoutReducer(initialLayout(), { split: 99, type: "resize" }).split).toBe(80);
        expect(layoutReducer(initialLayout(), { split: NaN, type: "resize" }).split).toBe(50);
    });

    it("prunes tabs that no longer exist and repairs the active tab", () => {
        const layout = layoutReducer(opened("host:a", "host:b"), { isValid: (id) => id === "host:a", type: "prune" });

        expect(layout.panes[0]).toEqual({ active: "host:a", tabs: ["host:a"] });

        const same = opened("host:a");

        expect(layoutReducer(same, { isValid: () => true, type: "prune" })).toBe(same);
    });
});

describe("prune and the focused pane", () => {
    it("moves focus to a pane that still has tabs when the focused one is emptied", () => {
        const layout = {
            activePane: 1,
            panes: [
                { active: "run:r-1", tabs: ["run:r-1"] },
                { active: "host:a", tabs: ["host:a"] },
            ],
            split: 50,
        };
        const pruned = layoutReducer(layout, { isValid: (id) => id !== "host:a", type: "prune" });

        expect(pruned.activePane).toBe(0);

        const kept = layoutReducer(layout, { isValid: (id) => id !== "run:r-1", type: "prune" });

        expect(kept.activePane).toBe(1);
    });
});

describe("parseLayout", () => {
    it("round-trips a valid layout", () => {
        const layout = layoutReducer(opened("host:a", "run:r-1"), { paneIndex: 0, type: "split" });

        const stored: unknown = structuredClone(layout);

        expect(parseLayout(stored)).toEqual(layout);
    });

    it("falls back to the empty layout for junk", () => {
        for (const junk of [null, 4, "x", [], {}, { panes: [] }, { panes: "nope" }]) {
            expect(parseLayout(junk)).toEqual(initialLayout());
        }
    });

    it("drops malformed ids, duplicates and extra panes, and repairs the active tab and pane", () => {
        const layout = parseLayout({
            activePane: 7,
            panes: [{ active: "host:gone", tabs: ["host:a", "host:a", "bogus", 3, "host:b"] }, { tabs: [] }, { tabs: ["host:c"] }],
            split: 500,
        });

        expect(layout.panes).toHaveLength(2);
        expect(layout.panes[0]).toEqual({ active: "host:a", tabs: ["host:a", "host:b"] });
        expect(layout.activePane).toBe(0);
        expect(layout.split).toBe(80);
    });
});
