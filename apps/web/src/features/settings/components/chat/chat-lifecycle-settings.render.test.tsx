import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatLifecycleControls from "./chat-lifecycle-settings";

const state = vi.hoisted(() => {
    return {
        settings: {} as Record<string, unknown>,
        update: vi.fn((_variables: unknown, _options?: unknown) => undefined),
    };
});

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUserSettings: () => {
            return { data: state.settings };
        },
        useUpdateUserSettings: () => {
            return { isPending: false, mutate: state.update };
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn(), success: vi.fn() } };
});

const KEEP_PULL_REQUESTS = /Keep chats with an open pull request/u;

describe("the open pull request toggle", () => {
    beforeEach(() => {
        state.settings = {};
        state.update.mockClear();
    });

    it("is on when the setting was never set, since keeping such chats is the default", () => {
        render(<ChatLifecycleControls />);

        expect(screen.getByRole("switch", { name: KEEP_PULL_REQUESTS }).getAttribute("aria-checked")).toBe("true");
    });

    it("shows off when the person turned it off", () => {
        state.settings = { keepOpenPullRequestChats: false };

        render(<ChatLifecycleControls />);

        expect(screen.getByRole("switch", { name: KEEP_PULL_REQUESTS }).getAttribute("aria-checked")).toBe("false");
    });

    it("saves off when the person switches it off", async () => {
        render(<ChatLifecycleControls />);

        await userEvent.click(screen.getByRole("switch", { name: KEEP_PULL_REQUESTS }));

        expect(state.update).toHaveBeenCalledWith({ keepOpenPullRequestChats: false }, expect.anything());
    });
});
