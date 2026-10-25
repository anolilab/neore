/**
 * The account settings page: the controls that saved a value nothing reads
 * (code font, animations, auto save, advanced mode, external-link warning) are
 * gone, and the ones that remain still render and save.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AccountSettings from "./account-settings";

const HIDE_PERSONAL_INFO = /Hide Personal Information/;
const VIM_KEYS = /Vim keys in the composer/;

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: ReactNode }) => children,
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn(), success: vi.fn() } };
});

const mutate = vi.fn();
const setHidePersonalInfo = vi.fn();
const setLayoutDirection = vi.fn();

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUpdateUserSettings: () => {
            return { mutate };
        },
        useUserSettings: () => {
            return { data: { temporaryChatRetentionHours: 24 } };
        },
    };
});

vi.mock("@/features/auth/hooks/use-is-anonymous", () => {
    return {
        default: () => {
            return { isAnonymous: true };
        },
    };
});

vi.mock("@/features/layout/hooks/use-ui-state", () => {
    return {
        useLayoutState: () => {
            return { direction: "ltr", setDirection: setLayoutDirection };
        },
        useUserPreferences: () => {
            return {
                hidePersonalInfo: false,
                sendBehavior: "enter",
                setHidePersonalInfo,
                setSendBehavior: vi.fn(),
                setShowTimestamps: vi.fn(),
                setSoundEffects: vi.fn(),
                setTemporaryChatRetentionHours: vi.fn(),
                showTimestamps: true,
                soundEffects: false,
            };
        },
    };
});

vi.mock("@/features/appearance/components/appearance-controls", () => {
    return { default: () => null };
});

vi.mock("@/features/notifications/components/notification-settings", () => {
    return { default: () => null };
});

vi.mock("@/features/settings/components/chat/chat-lifecycle-settings", () => {
    return { default: () => null };
});

describe("AccountSettings", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("no longer offers controls whose value nothing reads", () => {
        render(<AccountSettings />);

        for (const label of ["Code Font", "Animations", "Auto Save", "Advanced User Mode", "Disable External Link Warning"]) {
            expect(screen.queryByText(label)).toBeNull();
        }

        expect(screen.queryByText("Advanced")).toBeNull();
    });

    it("keeps the remaining preferences", () => {
        render(<AccountSettings />);

        for (const label of [
            "Hide Personal Information",
            "Text Direction",
            "Send Message Behavior",
            "Show Timestamps",
            "Sound Effects",
            "Vim keys in the composer",
        ]) {
            expect(screen.getByText(label)).toBeTruthy();
        }
    });

    it("still saves a client-side preference", () => {
        render(<AccountSettings />);

        fireEvent.click(screen.getByRole("switch", { name: HIDE_PERSONAL_INFO }));

        expect(setHidePersonalInfo).toHaveBeenCalledWith(true);
    });

    it("still saves a server-side setting", () => {
        render(<AccountSettings />);

        fireEvent.click(screen.getByRole("switch", { name: VIM_KEYS }));

        expect(mutate).toHaveBeenCalledWith({ composerVimMode: true }, expect.objectContaining({ onSuccess: expect.any(Function) }));
    });
});
