import { afterEach, describe, expect, it, vi } from "vitest";

import { hydrateSplitLayout, useSplitLayoutStore } from "./split-layout-store";

describe("hydrateSplitLayout", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("reads the saved layout once for callers that arrive while the read is pending", async () => {
        let finish: () => void = () => undefined;
        vi.spyOn(useSplitLayoutStore.persist, "hasHydrated").mockReturnValue(false);
        const rehydrate = vi.spyOn(useSplitLayoutStore.persist, "rehydrate").mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );

        const first = hydrateSplitLayout();
        const second = hydrateSplitLayout();

        expect(rehydrate).toHaveBeenCalledTimes(1);

        finish();
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
