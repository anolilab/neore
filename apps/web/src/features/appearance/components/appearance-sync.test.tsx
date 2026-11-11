import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import { CHAT_TEXT_SIZE_ATTRIBUTE } from "../lib/chat-text-size";
import type { ExplicitAppearance } from "../lib/native-appearance";
import AppearanceSync from "./appearance-sync";

/** The signed-in user, and the `userSettings` row the mocked query returns. */
const server = vi.hoisted(() => {
    return { settings: undefined as Record<string, unknown> | undefined, userId: undefined as string | undefined };
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
                return { data: server.userId === undefined ? undefined : { user: { id: server.userId } } };
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

    it("ignores a cached row that belongs to the last account", () => {
        signIn("user-a", { accentColor: "teal" });
        const { rerender } = render(<AppearanceSync />);

        server.userId = "user-b";
        rerender(<AppearanceSync />);

        expect(useUIStateStore.getState().appearance.accentColor).toBe("default");
        expect(marks()).toStrictEqual({});
    });
});
