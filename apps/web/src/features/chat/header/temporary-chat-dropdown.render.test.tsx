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

vi.mock("@tanstack/react-query", () => {
    return {
        skipToken: Symbol("skip"),
        useMutation: () => {
            return { mutateAsync: async () => {} };
        },
        useQuery: () => {
            return { data: undefined };
        },
    };
});

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUserSettings: () => {
            return { data: undefined };
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

describe("TemporaryChatDropdown", () => {
    it("names the trigger for a chat that has not started", () => {
        render(<TemporaryChatDropdown />);

        expect(screen.getByRole("button", { name: "Temporary chat mode" })).toBeTruthy();
    });

    it("names the trigger for an existing thread", () => {
        render(<TemporaryChatDropdown threadId="t1" />);

        expect(screen.getByRole("button", { name: "Enable auto-delete" })).toBeTruthy();
    });
});
