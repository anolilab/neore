// @vitest-environment jsdom

/** The hourglass trigger has no visible text; its tooltip does not name it, so it needs its own label. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
                    typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values),
            };
        },
    };
});

const status = vi.hoisted(() => {
    return { current: undefined as undefined | { expiresAt: number; isTemporary: boolean; retentionHours: number } };
});

const settings = vi.hoisted(() => {
    return { current: undefined as undefined | { newChatsTemporary: boolean } };
});

vi.mock("@tanstack/react-query", () => {
    return {
        skipToken: Symbol("skip"),
        useMutation: () => {
            return { mutateAsync: async () => {} };
        },
        useQuery: () => {
            return { data: status.current };
        },
    };
});

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUserSettings: () => {
            return { data: settings.current };
        },
    };
});

vi.mock("@/features/chat/core/stores/model-store", () => {
    return { useModelStore: () => undefined };
});

vi.mock("@/lib/lunora/crpc", () => {
    const entry = {
        mutationOptions: () => {
            return {};
        },
        queryOptions: () => {
            return {};
        },
    };

    return {
        useCRPC: () => {
            return { chat: { functions: { convertTemporaryToPermanent: entry, getThreadTemporaryStatus: entry, makeThreadTemporary: entry } } };
        },
    };
});

const { default: TemporaryChatDropdown } = await import("./temporary-chat-dropdown");

const TEMPORARY_SETTINGS = /^Temporary chat settings, 2h \d+m remaining$/;

describe("TemporaryChatDropdown", () => {
    it("names the trigger for a chat that has not started", () => {
        render(<TemporaryChatDropdown />);

        expect(screen.getByRole("button", { name: "Temporary chat mode" })).toBeTruthy();
    });

    it("says so in the name when the next chat is temporary", () => {
        settings.current = { newChatsTemporary: true };

        try {
            render(<TemporaryChatDropdown />);

            expect(screen.getByRole("button", { name: "Temporary chat mode, on for your next chat" })).toBeTruthy();
        } finally {
            settings.current = undefined;
        }
    });

    it("names the trigger for an existing thread", () => {
        render(<TemporaryChatDropdown threadId="t1" />);

        expect(screen.getByRole("button", { name: "Enable auto-delete" })).toBeTruthy();
    });

    it("keeps the purpose in the name of a temporary chat's trigger, not just the countdown", () => {
        status.current = { expiresAt: Date.now() + 2 * 60 * 60 * 1000 + 30 * 60 * 1000, isTemporary: true, retentionHours: 24 };

        try {
            render(<TemporaryChatDropdown threadId="t1" />);

            expect(screen.getByRole("button", { name: TEMPORARY_SETTINGS })).toBeTruthy();
        } finally {
            status.current = undefined;
        }
    });
});
