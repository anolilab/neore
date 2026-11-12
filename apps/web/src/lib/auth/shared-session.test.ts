import { afterEach, describe, expect, it, vi } from "vitest";

/** A fresh module per test: the count and the shared read are module state. */
const loadSharedSession = async () => {
    vi.resetModules();

    return await import("./shared-session");
};

const setVisibility = (state: DocumentVisibilityState): void => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
    document.dispatchEvent(new Event("visibilitychange"));
};

describe("sessionChangeCount", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("counts a session-changing request and another tab's better-auth broadcast", async () => {
        const { getSharedSessionRead, sessionChangeCount } = await loadSharedSession();

        getSharedSessionRead()?.invalidate();
        globalThis.dispatchEvent(new StorageEvent("storage", { key: "better-auth.message" }));

        expect(sessionChangeCount()).toBe(2);
    });

    it("counts a return to the tab, where a sign-in made in another tab would come from, and not leaving it", async () => {
        const { getSharedSessionRead, sessionChangeCount } = await loadSharedSession();

        getSharedSessionRead();
        setVisibility("hidden");

        expect(sessionChangeCount()).toBe(0);

        setVisibility("visible");

        expect(sessionChangeCount()).toBe(1);
    });
});
