import { afterEach, describe, expect, it, vi } from "vitest";

import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import { hydrateSplitLayout, readSavedLayoutOrEmpty, survivingPaneAfterDelete, useSplitLayoutStore } from "./split-layout-store";

const layoutOf = (panes: string[]) => {
    return { focus: 0, panes, sizes: {} };
};

describe("readSavedLayoutOrEmpty", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("keeps the saved panes when the read fails, so a later change does not overwrite them", async () => {
        localStorage.setItem("chat-split-layout", JSON.stringify({ state: { layout: layoutOf(["a"]) }, version: 1 }));
        // zustand swallows a failed read: the store just stays un-hydrated, with an empty layout.
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("storage unavailable");
        });

        await expect(readSavedLayoutOrEmpty()).resolves.toBeUndefined();
        useSplitLayoutStore.getState().dispatch({ threadId: "b", type: "open" });

        vi.restoreAllMocks();
        expect(localStorage.getItem("chat-split-layout")).toContain('"a"');
        expect(localStorage.getItem("chat-split-layout")).not.toContain('"b"');
    });
});

describe("a corrupt saved layout", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        localStorage.removeItem("chat-split-layout");
    });

    it("reads as no saved layout, so the layout saves again", async () => {
        // A fresh store: the module's own store has already been hydrated by the tests above.
        vi.resetModules();
        localStorage.setItem("chat-split-layout", "{not json");
        const store = await import("./split-layout-store");

        await expect(store.hydrateSplitLayout()).resolves.toBeUndefined();
        store.useSplitLayoutStore.getState().dispatch({ threadId: "a", type: "open" });

        expect(localStorage.getItem("chat-split-layout")).toContain('"a"');
    });
});

describe("hydrateSplitLayout", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("reads the saved layout once for callers that arrive while the read is pending", async () => {
        let hydrated = false;

        vi.spyOn(useSplitLayoutStore.persist, "hasHydrated").mockImplementation(() => hydrated);

        // Both calls below run before the read settles, so the timer is what ends the read.
        const rehydrate = vi.spyOn(useSplitLayoutStore.persist, "rehydrate").mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    setTimeout(() => {
                        hydrated = true;
                        resolve();
                    }, 0);
                }),
        );

        const first = hydrateSplitLayout();
        const second = hydrateSplitLayout();

        expect(rehydrate).toHaveBeenCalledTimes(1);

        await Promise.all([first, second]);
    });

    it("retries a read that failed", async () => {
        let hydrated = false;

        vi.spyOn(useSplitLayoutStore.persist, "hasHydrated").mockImplementation(() => hydrated);
        const rehydrate = vi
            .spyOn(useSplitLayoutStore.persist, "rehydrate")
            .mockRejectedValueOnce(new Error("storage unavailable"))
            .mockImplementationOnce(async () => {
                hydrated = true;
            });

        await expect(hydrateSplitLayout()).rejects.toThrow("storage unavailable");
        await expect(hydrateSplitLayout()).resolves.toBeUndefined();

        expect(rehydrate).toHaveBeenCalledTimes(2);
    });

    it("rejects when the saved layout could not be read, even though zustand resolves the read", async () => {
        // zustand swallows a failed read: the read resolves, and the store has not hydrated.
        vi.spyOn(useSplitLayoutStore.persist, "hasHydrated").mockReturnValue(false);
        vi.spyOn(useSplitLayoutStore.persist, "rehydrate").mockResolvedValueOnce();

        await expect(hydrateSplitLayout()).rejects.toThrow("could not be read");
    });
});

describe("survivingPaneAfterDelete", () => {
    const readable =
        (...missing: string[]) =>
        async (threadId: string) => {
            if (missing.includes(threadId)) {
                throw new Error("NOT_FOUND");
            }

            return { _id: threadId };
        };

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("picks the first open pane that survives, once the saved layout has loaded", async () => {
        useUIStateStore.setState({ preferences: { ...useUIStateStore.getState().preferences, splitViewEnabled: true } });
        let hydrated = false;

        vi.spyOn(useSplitLayoutStore.persist, "hasHydrated").mockImplementation(() => hydrated);
        vi.spyOn(useSplitLayoutStore.persist, "rehydrate").mockImplementation(async () => {
            useSplitLayoutStore.setState({ layout: layoutOf(["A", "B", "C"]) });
            hydrated = true;
        });

        await expect(survivingPaneAfterDelete(["A"], readable())).resolves.toBe("B");
    });

    it("has no survivor when the saved layout cannot be read, so the delete still completes", async () => {
        useUIStateStore.setState({ preferences: { ...useUIStateStore.getState().preferences, splitViewEnabled: true } });
        vi.spyOn(useSplitLayoutStore.persist, "hasHydrated").mockReturnValue(false);
        vi.spyOn(useSplitLayoutStore.persist, "rehydrate").mockResolvedValueOnce();

        await expect(survivingPaneAfterDelete(["A"], readable())).resolves.toBeUndefined();
    });

    it("passes over a pane whose chat was deleted elsewhere, and falls back to none", async () => {
        useUIStateStore.setState({ preferences: { ...useUIStateStore.getState().preferences, splitViewEnabled: true } });
        vi.spyOn(useSplitLayoutStore.persist, "hasHydrated").mockReturnValue(true);
        useSplitLayoutStore.setState({ layout: layoutOf(["A", "B", "C"]) });

        await expect(survivingPaneAfterDelete(["A"], readable("B"))).resolves.toBe("C");
        await expect(survivingPaneAfterDelete(["A"], readable("B", "C"))).resolves.toBeUndefined();
    });

    it("has no survivor when the preference is off", async () => {
        useUIStateStore.setState({ preferences: { ...useUIStateStore.getState().preferences, splitViewEnabled: false } });

        await expect(survivingPaneAfterDelete(["A"], readable())).resolves.toBeUndefined();
    });
});
