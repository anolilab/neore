import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import { CHAT_TEXT_SIZE_ATTRIBUTE } from "../lib/chat-text-size";
import AppearanceSync from "./appearance-sync";

/** The account's `userSettings` row the mocked query returns. */
const server = vi.hoisted(() => {
    return { settings: undefined as Record<string, unknown> | undefined };
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
                return { data: undefined };
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
        useUIStateStore.getState().resetAppearance();
        delete document.documentElement.dataset.accent;
        delete document.documentElement.dataset.font;
    });

    it("adopts a synced preset and font, and marks them explicit", () => {
        server.settings = { accentColor: "teal", density: "compact", mainFont: "serif" };
        render(<AppearanceSync />);

        expect(useUIStateStore.getState().appearance).toMatchObject({
            accentColor: "teal",
            density: "compact",
            explicit: { accentColor: true, mainFont: true },
            mainFont: "serif",
        });
    });

    it("keeps this device's `system` accent over a synced preset", () => {
        act(() => useUIStateStore.getState().setAppearance({ accentColor: "system", explicit: { accentColor: true } }));
        server.settings = { accentColor: "teal", mainFont: "mono" };
        render(<AppearanceSync />);

        expect(useUIStateStore.getState().appearance).toMatchObject({
            accentColor: "system",
            explicit: { accentColor: true, mainFont: true },
            mainFont: "mono",
        });
    });

    it("marks nothing when the account has no stored accent or font", () => {
        server.settings = { density: "spacious" };
        render(<AppearanceSync />);

        expect(useUIStateStore.getState().appearance.density).toBe("spacious");
        expect(useUIStateStore.getState().appearance.explicit ?? {}).toStrictEqual({});
    });
});
