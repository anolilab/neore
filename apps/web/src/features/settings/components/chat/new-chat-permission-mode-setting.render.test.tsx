import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import NewChatPermissionModeSetting from "./new-chat-permission-mode-setting";

const state = vi.hoisted(() => {
    return {
        impersonating: false,
        mutate: vi.fn((_variables: unknown, _options: unknown) => undefined),
        settings: undefined as undefined | { defaultPermissionMode?: "auto" | "full" | "supervised" },
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
        useUpdateUserSettings: () => {
            return { isPending: false, mutate: state.mutate };
        },
        useUserSettings: () => {
            return { data: state.settings };
        },
    };
});

vi.mock("@/features/admin/hooks/use-admin", () => {
    return {
        useIsImpersonating: () => {
            return { data: { isImpersonating: state.impersonating } };
        },
    };
});

vi.mock("@/lib/toast", () => {
    return { showError: vi.fn() };
});

beforeEach(() => {
    state.impersonating = false;
    state.settings = undefined;
    state.mutate.mockClear();
});

describe("NewChatPermissionModeSetting", () => {
    it("shows the default the owner saved as pressed", () => {
        state.settings = { defaultPermissionMode: "supervised" };

        render(<NewChatPermissionModeSetting />);

        expect(screen.getByRole("button", { name: "Supervised" }).getAttribute("aria-pressed")).toBe("true");
        expect(screen.getByRole("button", { name: "Auto" }).getAttribute("aria-pressed")).toBe("false");
    });

    it("shows Auto when no default is saved, which is what a new chat starts with", () => {
        state.settings = {};

        render(<NewChatPermissionModeSetting />);

        expect(screen.getByRole("button", { name: "Auto" }).getAttribute("aria-pressed")).toBe("true");
    });

    it("saves the mode the owner picks as the default", async () => {
        state.settings = { defaultPermissionMode: "auto" };

        render(<NewChatPermissionModeSetting />);

        await userEvent.click(screen.getByRole("button", { name: "Full access" }));

        expect(state.mutate).toHaveBeenCalledTimes(1);
        expect(state.mutate.mock.calls[0]?.[0]).toEqual({ defaultPermissionMode: "full" });
    });

    it("does not save again the mode already chosen", async () => {
        state.settings = { defaultPermissionMode: "auto" };

        render(<NewChatPermissionModeSetting />);

        await userEvent.click(screen.getByRole("button", { name: "Auto" }));

        expect(state.mutate).not.toHaveBeenCalled();
    });

    it("cannot be changed while an admin is acting as the owner", () => {
        state.settings = { defaultPermissionMode: "auto" };
        state.impersonating = true;

        render(<NewChatPermissionModeSetting />);

        expect((screen.getByRole("button", { name: "Full access" }) as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText("An admin acting as you cannot change this default.").textContent).toBe("An admin acting as you cannot change this default.");
    });
});
