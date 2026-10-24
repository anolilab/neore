import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useUIStateStore } from "@/features/layout/stores/ui-state-store";

import { CHAT_TEXT_SIZE_ATTRIBUTE } from "../lib/chat-text-size";
import AppearanceSync from "./appearance-sync";

vi.mock("@tanstack/react-query", () => {
    return {
        skipToken: Symbol("skipToken"),
        useQuery: () => {
            return { data: undefined };
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
