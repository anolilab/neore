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
const RESUME_AFTER_LIMIT = /Resume after a usage limit/;
const SNOOZE_UNTIL_RESET = /Snooze chats until the limit resets/;

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
const updateLatest = vi.fn((_build: () => Record<string, unknown>, _options?: { failFast: boolean }) => Promise.resolve());
const setHidePersonalInfo = vi.fn();
const setLayoutDirection = vi.fn();
/** The saved settings the account page reads; each test sets the ones it needs. */
const savedSettings: Record<string, unknown> = { temporaryChatRetentionHours: 24 };

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUpdateUserSettings: () => {
            return { mutate, updateLatest };
        },
        useUserSettings: () => {
            return { data: savedSettings };
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

    describe("usage-limit settings", () => {
        beforeEach(() => {
            for (const key of Object.keys(savedSettings)) {
                delete savedSettings[key];
            }

            savedSettings.temporaryChatRetentionHours = 24;
        });

        it("resumes after a usage limit by default, and saving the switch off turns it off", () => {
            render(<AccountSettings />);

            const resume = screen.getByRole("switch", { name: RESUME_AFTER_LIMIT });

            expect(resume.getAttribute("aria-checked")).toBe("true");

            fireEvent.click(resume);

            // The write goes through the ordered queue (`updateLatest`), so a quick second toggle cannot be overtaken by this one.
            expect(updateLatest).toHaveBeenLastCalledWith(expect.any(Function), { failFast: true });
            expect(updateLatest.mock.lastCall?.[0]()).toEqual({ resumeAfterUsageLimit: false });
        });

        it("does not snooze chats by default, and saving the switch on turns it on", () => {
            render(<AccountSettings />);

            const snooze = screen.getByRole("switch", { name: SNOOZE_UNTIL_RESET });

            expect(snooze.getAttribute("aria-checked")).toBe("false");

            fireEvent.click(snooze);

            expect(updateLatest).toHaveBeenLastCalledWith(expect.any(Function), { failFast: true });
            expect(updateLatest.mock.lastCall?.[0]()).toEqual({ snoozeUntilUsageLimitReset: true });
        });

        it("shows the saved values of both switches", () => {
            savedSettings.resumeAfterUsageLimit = false;
            savedSettings.snoozeUntilUsageLimitReset = true;

            render(<AccountSettings />);

            expect(screen.getByRole("switch", { name: RESUME_AFTER_LIMIT }).getAttribute("aria-checked")).toBe("false");
            expect(screen.getByRole("switch", { name: SNOOZE_UNTIL_RESET }).getAttribute("aria-checked")).toBe("true");
        });
    });
});
