import { afterEach, describe, expect, it, vi } from "vitest";

import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import { hydrateSplitLayout, survivingPaneAfterDelete, useSplitLayoutStore } from "./split-layout-store";

const layoutOf = (panes: string[]) => {
    return { focus: 0, panes, sizes: {} };
};

describe("hydrateSplitLayout", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("reads the saved layout once for callers that arrive while the read is pending", async () => {
        vi.spyOn(useSplitLayoutStore.persist, "hasHydrated").mockReturnValue(false);

        // Both calls below run before the read settles, so the timer is what ends the read.
        const rehydrate = vi.spyOn(useSplitLayoutStore.persist, "rehydrate").mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    setTimeout(resolve, 0);
                }),
        );

        const first = hydrateSplitLayout();
        const second = hydrateSplitLayout();

        expect(rehydrate).toHaveBeenCalledTimes(1);

        await Promise.all([first, second]);
    });

    it("retries a read that failed", async () => {
        const rehydrate = vi.spyOn(useSplitLayoutStore.persist, "rehydrate").mockRejectedValueOnce(new Error("storage unavailable")).mockResolvedValueOnce();

        vi.spyOn(useSplitLayoutStore.persist, "hasHydrated").mockReturnValue(false);

        await expect(hydrateSplitLayout()).rejects.toThrow("storage unavailable");
        await expect(hydrateSplitLayout()).resolves.toBeUndefined();

        expect(rehydrate).toHaveBeenCalledTimes(2);
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
        vi.spyOn(useSplitLayoutStore.persist, "hasHydrated").mockReturnValue(false);
        vi.spyOn(useSplitLayoutStore.persist, "rehydrate").mockImplementation(async () => {
            useSplitLayoutStore.setState({ layout: layoutOf(["A", "B", "C"]) });
        });

        await expect(survivingPaneAfterDelete(["A"], readable())).resolves.toBe("B");
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
