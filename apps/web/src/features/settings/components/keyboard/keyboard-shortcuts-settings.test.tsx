import { isValidShortcut } from "@neore/backend/auth/shortcut";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultKeyboardShortcuts, useUIStateStore } from "@/features/layout/stores/ui-state-store";

import KeyboardShortcutsSettings from "./keyboard-shortcuts-settings";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
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
    return { toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } };
});

const updateUserSettings = vi.fn(async (_args: { keyboardShortcuts: Record<string, string> }) => {});

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

const renderSettings = () =>
    render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
            <KeyboardShortcutsSettings />
        </QueryClientProvider>,
    );

const recordShortcut = (rowLabel: string, key: string) => {
    fireEvent.click(screen.getByRole("button", { name: `Record ${rowLabel}` }));
    fireEvent.keyDown(document, { ctrlKey: true, key });
    fireEvent.keyUp(document, { ctrlKey: true, key });
};

describe("KeyboardShortcutsSettings", () => {
    beforeEach(() => {
        updateUserSettings.mockClear();
        act(() => {
            useUIStateStore.setState({ keyboardShortcuts: { ...defaultKeyboardShortcuts } });
        });
    });

    it("saves a single edited shortcut", async () => {
        renderSettings();

        recordShortcut("New Chat", "j");

        const save = screen.getByRole("button", { name: "Save Shortcuts" });

        await waitFor(() => {
            expect((save as HTMLButtonElement).disabled).toBe(false);
        });
        fireEvent.click(save);

        await waitFor(() => {
            expect(updateUserSettings).toHaveBeenCalledTimes(1);
        });

        const keyboardShortcuts = updateUserSettings.mock.lastCall?.[0].keyboardShortcuts ?? {};

        expect(keyboardShortcuts.newChat).toBe("ctrl+j");
        // Only what the page edits is sent, and the backend accepts every value, defaults included.
        expect(Object.keys(keyboardShortcuts).toSorted((a, b) => a.localeCompare(b))).toEqual([
            "commandPalette",
            "copyLastCodeBlock",
            "escape",
            "focusSearch",
            "help",
            "newChat",
            "newTemporaryChat",
            "openModelPicker",
            "sidebarLeft",
            "sidebarRight",
        ]);
        expect(Object.values(keyboardShortcuts).every((value) => isValidShortcut(value))).toBe(true);
        await waitFor(() => {
            expect(useUIStateStore.getState().keyboardShortcuts.newChat).toBe("ctrl+j");
        });
    });

    it("does not offer Save while a binding is invalid", async () => {
        act(() => {
            useUIStateStore.setState({ keyboardShortcuts: { ...defaultKeyboardShortcuts, help: "not a shortcut" } });
        });
        renderSettings();

        recordShortcut("New Chat", "j");

        await waitFor(() => {
            expect((screen.getByRole("button", { name: "Save Shortcuts" }) as HTMLButtonElement).disabled).toBe(true);
        });
    });

    it("refuses Save while two actions share a key combination", async () => {
        act(() => {
            useUIStateStore.setState({ keyboardShortcuts: { ...defaultKeyboardShortcuts, newChat: "ctrl+j", commandPalette: "meta+j" } });
        });
        renderSettings();

        recordShortcut("Help", "h");

        await waitFor(() => {
            expect((screen.getByRole("button", { name: "Save Shortcuts" }) as HTMLButtonElement).disabled).toBe(false);
        });

        recordShortcut("Command Palette", "j");

        await waitFor(() => {
            expect((screen.getByRole("button", { name: "Save Shortcuts" }) as HTMLButtonElement).disabled).toBe(true);
        });
        expect(screen.getAllByRole("alert")).toHaveLength(2);
    });

    it("saves the defaults to the server on reset", async () => {
        act(() => {
            useUIStateStore.setState({ keyboardShortcuts: { ...defaultKeyboardShortcuts, newChat: "ctrl+j" } });
        });
        renderSettings();

        fireEvent.click(screen.getByRole("button", { name: "Reset to Defaults" }));

        await waitFor(() => {
            expect(updateUserSettings).toHaveBeenCalledTimes(1);
        });
        expect((updateUserSettings.mock.lastCall?.[0].keyboardShortcuts ?? {}).newChat).toBe(defaultKeyboardShortcuts.newChat);
        // The server merges, so the bindings the page does not edit (audio, list navigation) must be sent too.
        expect(updateUserSettings.mock.lastCall?.[0].keyboardShortcuts ?? {}).toEqual(defaultKeyboardShortcuts);
        expect(useUIStateStore.getState().keyboardShortcuts).toEqual(defaultKeyboardShortcuts);
    });

    it("keeps the previous bindings when the reset cannot be saved", async () => {
        act(() => {
            useUIStateStore.setState({ keyboardShortcuts: { ...defaultKeyboardShortcuts, newChat: "ctrl+j" } });
        });
        updateUserSettings.mockRejectedValueOnce(new Error("offline"));
        renderSettings();

        fireEvent.click(screen.getByRole("button", { name: "Reset to Defaults" }));

        await waitFor(() => {
            expect(updateUserSettings).toHaveBeenCalledTimes(1);
        });
        await waitFor(() => {
            expect((screen.getByRole("button", { name: "Reset to Defaults" }) as HTMLButtonElement).disabled).toBe(false);
        });
        expect(useUIStateStore.getState().keyboardShortcuts.newChat).toBe("ctrl+j");
    });

    it("refuses to record a combination the backend would reject", () => {
        renderSettings();

        const before = (screen.getByLabelText("New Chat") as HTMLInputElement).value;

        recordShortcut("New Chat", ",");

        expect((screen.getByLabelText("New Chat") as HTMLInputElement).value).toBe(before);
    });

    it("ends a recording in progress when Reset starts, so a later key cannot change the form", async () => {
        renderSettings();

        const before = (screen.getByLabelText("New Chat") as HTMLInputElement).value;

        fireEvent.click(screen.getByRole("button", { name: "Record New Chat" }));
        fireEvent.keyDown(document, { ctrlKey: true, key: "j" });
        fireEvent.click(screen.getByRole("button", { name: "Reset to Defaults" }));

        await waitFor(() => {
            expect(updateUserSettings).toHaveBeenCalledTimes(1);
        });
        await waitFor(() => {
            expect((screen.getByRole("button", { name: "Reset to Defaults" }) as HTMLButtonElement).disabled).toBe(false);
        });
        fireEvent.keyUp(document, { ctrlKey: true, key: "j" });

        expect((screen.getByLabelText("New Chat") as HTMLInputElement).value).toBe(before);
    });
});
