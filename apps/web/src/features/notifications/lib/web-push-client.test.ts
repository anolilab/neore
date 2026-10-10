import { afterEach, describe, expect, it, vi } from "vitest";

import { releaseBrowserPush } from "./web-push-client";

const installPush = (subscription: { endpoint: string; unsubscribe: () => Promise<boolean> } | null): void => {
    vi.stubGlobal("Notification", { permission: "granted" });
    vi.stubGlobal("PushManager", vi.fn());
    Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
            getRegistration: async () => {
                return { active: {}, pushManager: { getSubscription: async () => subscription } };
            },
        },
    });
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});

describe(releaseBrowserPush, () => {
    it("drops the subscription on the server and in the browser", async () => {
        const unsubscribe = vi.fn(async () => true);
        const dropOnServer = vi.fn(async () => null);

        installPush({ endpoint: "https://push.example/abc", unsubscribe });

        await releaseBrowserPush(dropOnServer);

        expect(dropOnServer).toHaveBeenCalledWith("https://push.example/abc");
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it("does nothing without a subscription", async () => {
        const dropOnServer = vi.fn(async () => null);

        installPush(null);

        await releaseBrowserPush(dropOnServer);

        expect(dropOnServer).not.toHaveBeenCalled();
    });

    it("never throws when the server refuses", async () => {
        const unsubscribe = vi.fn(async () => true);

        installPush({ endpoint: "https://push.example/abc", unsubscribe });

        await expect(
            releaseBrowserPush(async () => {
                throw new Error("signed out");
            }),
        ).resolves.toBeUndefined();
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it("does not hold the sign-out past its deadline", async () => {
        vi.useFakeTimers();
        installPush({ endpoint: "https://push.example/abc", unsubscribe: async () => true });

        const release = releaseBrowserPush(async () => await new Promise(() => {}), 50);

        await vi.advanceTimersByTimeAsync(60);

        await expect(release).resolves.toBeUndefined();
    });
});
