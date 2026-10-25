/**
 * The keyboard settings form: the whole stored shortcut set is the form value, a chord shared by two
 * commands is refused with a field error, and a valid set still saves.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

// Every command of the stored set, not only the ones this form edits.
vi.mock("@/features/layout/hooks/use-ui-state", () => {
    return {
        useKeyboardShortcuts: () => {
            return {
                keyboardShortcuts: {
                    archiveThread: "ctrl+a",
                    audioRecord: "ctrl+shift+r",
                    commandPalette: "ctrl+k",
                    copyLastCodeBlock: "ctrl+shift+x",
                    createBranch: "ctrl+shift+c",
                    deleteThread: "ctrl+d",
                    escape: "escape",
                    firstItem: "home",
                    focusSearch: "ctrl+f",
                    help: "ctrl+/",
                    lastItem: "end",
                    newChat: "ctrl+n",
                    newTemporaryChat: "ctrl+shift+n",
                    nextItem: "arrowdown",
                    openModelPicker: "ctrl+shift+m",
                    pinThread: "ctrl+p",
                    prevItem: "arrowup",
                    search: "ctrl+k",
                    sidebarLeft: "ctrl+b",
                    sidebarRight: "ctrl+shift+b",
                },
                resetKeyboardShortcuts: vi.fn(),
                setKeyboardShortcuts: vi.fn(),
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
    // The rows are in one order: the nth field has the nth Record button.
    const button = screen.getAllByRole("button", { name: "Record" }).at(screen.getAllByRole("textbox").indexOf(screen.getByLabelText(label)));

    if (!button) {
        throw new TypeError(`No Record button for ${label}`);
    }

    fireEvent.click(button);
    fireEvent.keyDown(document, chord);
    fireEvent.keyUp(document, chord);
};

describe("KeyboardShortcutsSettings effort commands", () => {
    beforeEach(() => {
        updateUserSettings.mockClear();
    });

    it("refuses one chord for both effort commands", async () => {
        renderForm();
        record("Decrease Reasoning Effort", { altKey: true, key: "e" });
        record("Increase Reasoning Effort", { altKey: true, key: "e" });

        await waitFor(() => {
            const message = "Increase and decrease reasoning effort need different shortcuts.";

            expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toStrictEqual([message, message]);
        });
    });

    it("refuses a chord another command already has", async () => {
        renderForm();
        record("Increase Reasoning Effort", { ctrlKey: true, key: "n" });

        await waitFor(() => {
            expect(screen.getByRole("alert").textContent).toBe("Another command already uses this shortcut.");
        });
    });

    it("saves a free chord", async () => {
        renderForm();
        record("Increase Reasoning Effort", { altKey: true, key: "ArrowUp" });
        fireEvent.click(screen.getByRole("button", { name: "Save Shortcuts" }));

        await waitFor(() => {
            expect(updateUserSettings).toHaveBeenCalledTimes(1);
        });
        expect(screen.queryByRole("alert")).toBeNull();
        expect(updateUserSettings.mock.calls[0]?.[0]).toMatchObject({ keyboardShortcuts: { increaseEffort: "alt+arrowup" } });
    });
});
