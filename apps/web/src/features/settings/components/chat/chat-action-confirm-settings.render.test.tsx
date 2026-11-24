// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const userSettings = vi.hoisted(() => {
    return { value: undefined as Record<string, boolean> | undefined };
});
const mutate = vi.hoisted(() => vi.fn());

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

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUpdateUserSettings: () => {
            return { mutate };
        },
        useUserSettings: () => {
            return { data: userSettings.value };
        },
    };
});

const { default: ChatActionConfirmControls } = await import("./chat-action-confirm-settings");

const UNPIN = "Confirm before unpinning a chat";
const ARCHIVE = "Confirm before archiving a chat";
const DELETE = "Confirm before deleting a chat";

const isOn = (name: string): boolean => screen.getByRole("switch", { name }).getAttribute("aria-checked") === "true";

describe("ChatActionConfirmControls", () => {
    beforeEach(() => {
        mutate.mockClear();
        userSettings.value = undefined;
    });

    it("starts unpinning and archiving asking nothing, and deleting asking", () => {
        render(<ChatActionConfirmControls />);

        expect(isOn(UNPIN)).toBe(false);
        expect(isOn(ARCHIVE)).toBe(false);
        expect(isOn(DELETE)).toBe(true);
    });

    it("shows each setting as saved, including one saved as off", () => {
        userSettings.value = { confirmBeforeArchiveChat: true, confirmBeforeDeleteChat: false, confirmBeforeUnpinChat: true };
        render(<ChatActionConfirmControls />);

        expect(isOn(UNPIN)).toBe(true);
        expect(isOn(ARCHIVE)).toBe(true);
        expect(isOn(DELETE)).toBe(false);
    });

    it("saves unpinning under its own key when it is turned on", () => {
        render(<ChatActionConfirmControls />);

        fireEvent.click(screen.getByRole("switch", { name: UNPIN }));

        expect(mutate).toHaveBeenCalledWith({ confirmBeforeUnpinChat: true }, expect.any(Object));
    });

    it("saves archiving under its own key when it is turned on", () => {
        render(<ChatActionConfirmControls />);

        fireEvent.click(screen.getByRole("switch", { name: ARCHIVE }));

        expect(mutate).toHaveBeenCalledWith({ confirmBeforeArchiveChat: true }, expect.any(Object));
    });

    it("saves deleting as off, not as undefined, when it is turned off", () => {
        render(<ChatActionConfirmControls />);

        fireEvent.click(screen.getByRole("switch", { name: DELETE }));

        expect(mutate).toHaveBeenCalledWith({ confirmBeforeDeleteChat: false }, expect.any(Object));
    });
});
