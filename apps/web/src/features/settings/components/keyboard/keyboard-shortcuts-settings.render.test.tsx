/**
 * The keyboard settings form and the reasoning-effort commands: a chord shared by two commands (both
 * effort commands, or an effort command and another one) is refused with a field error, and a free chord saves.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultKeyboardShortcuts, useUIStateStore } from "@/features/layout/stores/ui-state-store";

import KeyboardShortcutsSettings from "./keyboard-shortcuts-settings";

const { updateUserSettings } = vi.hoisted(() => {
    return { updateUserSettings: vi.fn(async (_variables: unknown) => null) };
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

const { platform } = vi.hoisted(() => {
    return { platform: { modifier: "ctrl" as "cmd" | "ctrl" } };
});

// Only the registration side reads the platform here; the recorder inside the module keeps its own.
vi.mock("@neore/ui/utils/keyboard-shortcuts", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("@neore/ui/utils/keyboard-shortcuts")>()), getPlatformModifierForEvents: () => platform.modifier };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                auth: {
                    functions: {
                        updateUserSettings: {
                            mutationOptions: () => {
                                return { mutationFn: updateUserSettings };
                            },
                        },
                    },
                },
            };
        },
    };
});

const renderForm = () =>
    render(
        <QueryClientProvider client={new QueryClient()}>
            <KeyboardShortcutsSettings />
        </QueryClientProvider>,
    );

/** Records `chord` for the row labelled `label`: Record, press the keys, release them. */
const record = (label: string, chord: Partial<Pick<KeyboardEventInit, "altKey" | "ctrlKey" | "shiftKey">> & { key: string }) => {
    fireEvent.click(screen.getByRole("button", { name: `Record ${label}` }));
    fireEvent.keyDown(document, chord);
    fireEvent.keyUp(document, chord);
};

const DUPLICATE_MESSAGE = "Another action already uses this key combination. Change or clear one of them to save.";

describe("KeyboardShortcutsSettings effort commands", () => {
    beforeEach(() => {
        updateUserSettings.mockClear();
        act(() => {
            useUIStateStore.setState({ keyboardShortcuts: { ...defaultKeyboardShortcuts } });
        });
    });

    it("refuses one chord for both effort commands", async () => {
        renderForm();
        record("Decrease Reasoning Effort", { altKey: true, key: "e" });
        record("Increase Reasoning Effort", { altKey: true, key: "e" });

        await waitFor(() => {
            expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toStrictEqual([DUPLICATE_MESSAGE, DUPLICATE_MESSAGE]);
        });
    });

    it("refuses a chord another command already has", async () => {
        renderForm();
        record("Increase Reasoning Effort", { ctrlKey: true, key: "n" });

        await waitFor(() => {
            expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toStrictEqual([DUPLICATE_MESSAGE, DUPLICATE_MESSAGE]);
        });
    });

    it("refuses a Control chord that a Command binding of another command overlaps on a Mac", async () => {
        platform.modifier = "cmd";
        act(() => {
            useUIStateStore.setState({ keyboardShortcuts: { ...defaultKeyboardShortcuts, newChat: "cmd+j" } });
        });

        try {
            renderForm();
            record("Increase Reasoning Effort", { ctrlKey: true, key: "j" });

            await waitFor(() => {
                expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toStrictEqual([DUPLICATE_MESSAGE]);
            });
        } finally {
            platform.modifier = "ctrl";
        }
    });

    it("saves a free chord", async () => {
        renderForm();
        record("Increase Reasoning Effort", { altKey: true, key: "ArrowUp" });
        const save = screen.getByRole("button", { name: "Save Shortcuts" });

        await waitFor(() => {
            expect((save as HTMLButtonElement).disabled).toBe(false);
        });
        fireEvent.click(save);

        await waitFor(() => {
            expect(updateUserSettings).toHaveBeenCalledTimes(1);
        });
        expect(screen.queryByRole("alert")).toBeNull();
        expect(updateUserSettings.mock.calls[0]?.[0]).toMatchObject({ keyboardShortcuts: { increaseEffort: "alt+arrowup" } });
    });
});
