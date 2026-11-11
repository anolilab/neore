import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import { CHAT_TEXT_SIZE_ATTRIBUTE } from "../lib/chat-text-size";
import type { ExplicitAppearance } from "../lib/native-appearance";
import { systemAccentTokens } from "../lib/system-accent-tokens";
import AppearanceSync from "./appearance-sync";

/** The signed-in user, and the `userSettings` row the mocked query returns. */
const server = vi.hoisted(() => {
    return { pending: false, settings: undefined as Record<string, unknown> | undefined, userId: undefined as string | undefined };
});

vi.mock("@tanstack/react-query", () => {
    return {
        skipToken: Symbol("skipToken"),
        useQuery: () => {
            return { data: server.settings };
        },
    };
});
vi.mock("@/hooks/use-after-first-paint", () => {
    return { default: () => false };
});
vi.mock("@/lib/auth/client", () => {
    return {
        authClient: {
            useSession: () => {
                return {
                    data: server.userId === undefined ? null : { user: { id: server.userId } },
                    error: null,
                    isPending: server.pending,
                };
            },
        },
    };
});
vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                auth: {
                    functions: {
                        getUserSettings: {
                            queryOptions: () => {
                                return {};
                            },
                        },
                    },
                },
            };
        },
    };
});

/** The OS accent's lazy chunk: the first `failures` loads reject, as a dropped connection would make them. */
const accentChunk = vi.hoisted(() => {
    return { failures: 0, loads: 0, stop: () => {}, tokens: undefined as Record<string, string> | undefined };
});

vi.mock("../lib/system-accent-sync", () => {
    accentChunk.loads += 1;

    if (accentChunk.loads <= accentChunk.failures) {
        throw new Error("Failed to fetch dynamically imported module");
    }

    return {
        followSystemAccent: (paint: (tokens: unknown) => void) => {
            paint(accentChunk.tokens);

            return accentChunk.stop;
        },
    };
});

const attribute = (): string | null => document.documentElement.getAttribute(CHAT_TEXT_SIZE_ATTRIBUTE);

describe("AppearanceSync chat text size", () => {
    afterEach(() => {
        useUIStateStore.getState().resetLayout();
        document.documentElement.removeAttribute(CHAT_TEXT_SIZE_ATTRIBUTE);
    });

    it("leaves <html> untouched at the default size", () => {
        render(<AppearanceSync />);

        expect(attribute()).toBeNull();
    });

    it("follows the stored size as it changes", () => {
        render(<AppearanceSync />);

        act(() => useUIStateStore.getState().setLayoutState({ fontSize: "large" }));
        expect(attribute()).toBe("large");

        act(() => useUIStateStore.getState().setLayoutState({ fontSize: "small" }));
        expect(attribute()).toBe("small");

        act(() => useUIStateStore.getState().setLayoutState({ fontSize: "medium" }));
        expect(attribute()).toBeNull();
    });
});

describe("AppearanceSync adopting the account's settings", () => {
    afterEach(() => {
        server.pending = false;
        server.settings = undefined;
        server.userId = undefined;
        useUIStateStore.getState().resetAppearance();
        delete document.documentElement.dataset.accent;
        delete document.documentElement.dataset.font;
    });

    const signIn = (userId: string, settings?: Partial<Record<"accentColor" | "density" | "mainFont", string>>): void => {
        server.userId = userId;
        server.settings = settings && { ...settings, userId };
    };

    /** The marks that still count, `undefined` (a dropped mark) left out. */
    const marks = (): ExplicitAppearance =>
        Object.fromEntries(Object.entries(useUIStateStore.getState().appearance.explicit ?? {}).filter(([, mark]) => mark !== undefined));

    it("adopts a synced preset and font, and marks them synced for the account", () => {
        signIn("user-a", { accentColor: "teal", density: "compact", mainFont: "serif" });
        render(<AppearanceSync />);

        expect(useUIStateStore.getState().appearance).toMatchObject({
            accentColor: "teal",
            density: "compact",
            explicit: { accentColor: "synced", mainFont: "synced" },
            mainFont: "serif",
            syncedUserId: "user-a",
        });
    });

    it("keeps this device's `system` accent over a synced preset", () => {
        act(() => useUIStateStore.getState().setAppearance({ accentColor: "system", explicit: { accentColor: true } }));
        signIn("user-a", { accentColor: "teal", mainFont: "mono" });
        render(<AppearanceSync />);

        expect(useUIStateStore.getState().appearance).toMatchObject({
            accentColor: "system",
            explicit: { accentColor: true, mainFont: "synced" },
            mainFont: "mono",
        });
    });

    it("marks nothing when the account has no stored accent or font", () => {
        signIn("user-a", { density: "spacious" });
        render(<AppearanceSync />);

        expect(useUIStateStore.getState().appearance.density).toBe("spacious");
        expect(marks()).toStrictEqual({});
    });

    it("drops the last account's synced accent and font when another account signs in", () => {
        signIn("user-a", { accentColor: "default", mainFont: "serif" });
        const { rerender } = render(<AppearanceSync />);

        expect(marks()).toStrictEqual({ accentColor: "synced", mainFont: "synced" });

        signIn("user-b");
        rerender(<AppearanceSync />);

        expect(useUIStateStore.getState().appearance).toMatchObject({ accentColor: "default", mainFont: "inter", syncedUserId: "user-b" });
        expect(marks()).toStrictEqual({});
    });

    it("keeps the choices made on this device across an account switch", () => {
        act(() => useUIStateStore.getState().setAppearance({ accentColor: "system", explicit: { accentColor: true } }));
        signIn("user-a", { mainFont: "serif" });
        const { rerender } = render(<AppearanceSync />);

        signIn("user-b");
        rerender(<AppearanceSync />);

        expect(useUIStateStore.getState().appearance).toMatchObject({ accentColor: "system", mainFont: "inter" });
        expect(marks()).toStrictEqual({ accentColor: true });
    });

    it("keeps a value picked here this device's choice when the account echoes it back, across an account switch", () => {
        signIn("user-a");
        const { rerender } = render(<AppearanceSync />);

        act(() => useUIStateStore.getState().setAppearance({ accentColor: "teal", explicit: { accentColor: true, mainFont: true }, mainFont: "mono" }));
        // The save comes back through the settings query.
        signIn("user-a", { accentColor: "teal", mainFont: "mono" });
        rerender(<AppearanceSync />);

        expect(marks()).toStrictEqual({ accentColor: true, mainFont: true });

        signIn("user-b");
        rerender(<AppearanceSync />);

        expect(useUIStateStore.getState().appearance).toMatchObject({ accentColor: "teal", mainFont: "mono", syncedUserId: "user-b" });
        expect(marks()).toStrictEqual({ accentColor: true, mainFont: true });
    });

    it("marks a different account value synced even over a choice made here", () => {
        act(() => useUIStateStore.getState().setAppearance({ accentColor: "teal", explicit: { accentColor: true } }));
        signIn("user-a", { accentColor: "default" });
        render(<AppearanceSync />);

        expect(useUIStateStore.getState().appearance.accentColor).toBe("default");
        expect(marks()).toStrictEqual({ accentColor: "synced" });
    });

    it("keeps a choice stored before synced marks existed (`true`) when another account signs in", () => {
        act(() => useUIStateStore.getState().setAppearance({ accentColor: "teal", explicit: { accentColor: true, mainFont: true }, mainFont: "mono" }));
        signIn("user-b");
        render(<AppearanceSync />);

        expect(useUIStateStore.getState().appearance).toMatchObject({ accentColor: "teal", mainFont: "mono", syncedUserId: "user-b" });
        expect(marks()).toStrictEqual({ accentColor: true, mainFont: true });
    });

    it("drops the marks of an account that signed in before this load", () => {
        act(() => useUIStateStore.getState().setAppearance({ accentColor: "blue", explicit: { accentColor: "synced" }, syncedUserId: "user-a" }));
        signIn("user-b");
        render(<AppearanceSync />);

        expect(useUIStateStore.getState().appearance.accentColor).toBe("default");
        expect(marks()).toStrictEqual({});
    });

    it("re-adopts the new account's settings even where they match the last account's", () => {
        signIn("user-a", { accentColor: "teal" });
        const { rerender } = render(<AppearanceSync />);

        signIn("user-b", { accentColor: "teal" });
        rerender(<AppearanceSync />);

        expect(useUIStateStore.getState().appearance).toMatchObject({ accentColor: "teal", syncedUserId: "user-b" });
        expect(marks()).toStrictEqual({ accentColor: "synced" });
    });

    it("drops the synced choices on sign-out and keeps the ones made here", () => {
        signIn("user-a", { accentColor: "teal", mainFont: "serif" });
        const { rerender } = render(<AppearanceSync />);

        act(() => useUIStateStore.getState().setAppearance({ explicit: { mainFont: true } }));
        server.userId = undefined;
        server.settings = undefined;
        rerender(<AppearanceSync />);

        expect(useUIStateStore.getState().appearance).toMatchObject({ accentColor: "default", mainFont: "serif", syncedUserId: undefined });
        expect(marks()).toStrictEqual({ mainFont: true });
    });

    it("keeps the synced choices while the session read is still pending", () => {
        signIn("user-a", { accentColor: "teal" });
        const { rerender } = render(<AppearanceSync />);

        server.userId = undefined;
        server.settings = undefined;
        server.pending = true;
        rerender(<AppearanceSync />);

        expect(useUIStateStore.getState().appearance).toMatchObject({ accentColor: "teal", syncedUserId: "user-a" });
        expect(marks()).toStrictEqual({ accentColor: "synced" });
    });

    it("ignores a cached row that belongs to the last account", () => {
        signIn("user-a", { accentColor: "teal" });
        const { rerender } = render(<AppearanceSync />);

        server.userId = "user-b";
        rerender(<AppearanceSync />);

        expect(useUIStateStore.getState().appearance.accentColor).toBe("default");
        expect(marks()).toStrictEqual({});
    });
});

describe("AppearanceSync loading the OS accent's chunk", () => {
    afterEach(() => {
        accentChunk.failures = 0;
        accentChunk.loads = 0;
        vi.useRealTimers();
        vi.unstubAllGlobals();
        delete document.documentElement.dataset.accent;
        document.documentElement.removeAttribute("style");
    });

    const shellWithSystemAccent = (failures: number): void => {
        accentChunk.failures = failures;
        accentChunk.tokens = systemAccentTokens("#007aff");
        vi.useFakeTimers();
        vi.stubGlobal("neoreNative", {
            capabilities: ["system-accent"],
            notify: () => {},
            onCompose: () => () => {},
            takePendingCompose: async () => undefined,
        });
        // What the boot script painted from its cache.
        document.documentElement.dataset.accent = "system";
    };

    const settle = async (milliseconds: number): Promise<void> => {
        await act(async () => {
            await vi.advanceTimersByTimeAsync(milliseconds);
        });
    };

    it("gives up after three retries", async () => {
        shellWithSystemAccent(10);
        render(<AppearanceSync />);

        await settle(60_000);
        expect(accentChunk.loads).toBe(4);
        expect(document.documentElement.dataset.accent).toBe("system");
    });

    it("stops retrying once unmounted", async () => {
        shellWithSystemAccent(10);
        const { unmount } = render(<AppearanceSync />);

        await settle(0);
        unmount();
        await settle(60_000);
        expect(accentChunk.loads).toBe(1);
    });

    // Last: once a load succeeds the mocked module is cached, and later loads no longer reach the factory.
    it("keeps the painted accent through failed loads and follows the OS accent once one succeeds", async () => {
        shellWithSystemAccent(2);
        render(<AppearanceSync />);

        await settle(0);
        expect(accentChunk.loads).toBe(1);
        expect(document.documentElement.dataset.accent).toBe("system");

        await settle(1000);
        expect(accentChunk.loads).toBe(2);

        await settle(2000);
        expect(accentChunk.loads).toBe(3);
        expect(document.documentElement.style.getPropertyValue("--system-accent-light")).toBe(accentChunk.tokens?.light);
    });
});
