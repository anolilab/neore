// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ProjectFormDialog from "./project-form-dialog";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { _: (value: string) => value, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            return { mutateAsync: vi.fn() };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    const procedure = {
        mutationOptions: () => {
            return {};
        },
    };

    return {
        useCRPC: () => {
            return { projects: { functions: { createProject: procedure, updateProject: procedure } } };
        },
    };
});

vi.mock("@/hooks/use-feature-flagged-models", () => {
    return { default: () => [] };
});

const { toastInfo } = vi.hoisted(() => {
    return { toastInfo: vi.fn() };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn(), info: toastInfo } };
});

// The rule files section stands in as controls that open unsaved changes, as an edit there does, and start a save of them.
vi.mock("@/features/projects/components/project-rule-files", () => {
    return {
        default: ({ onDirtyChange, onSavingChange }: { onDirtyChange: (dirty: boolean) => void; onSavingChange: (saving: boolean) => void }) => (
            <>
                <button onClick={() => onDirtyChange(true)} type="button">
                    Edit a rule file
                </button>
                <button
                    onClick={() => {
                        onDirtyChange(true);
                        onSavingChange(true);
                    }}
                    type="button"
                >
                    Save a rule file
                </button>
            </>
        ),
    };
});

vi.mock("@/features/knowledge/components/project-knowledge-collections", () => {
    return { default: () => null };
});

vi.mock("@/features/projects/components/project-usage-summary", () => {
    return { default: () => null };
});

vi.mock("@/features/projects/components/project-repositories", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/model-settings/reasoning-effort-selector", () => {
    return { ReasoningEffortSelector: () => null };
});

vi.mock("@/features/prompts/components/prompt-model-selector", () => {
    return { default: () => null };
});

const project = { _id: "p1", title: "Project" };

beforeEach(() => {
    // Base UI waits for a closing dialog's animations; jsdom has none.
    Element.prototype.getAnimations = () => [];
    // The dialog's scroll area needs a constructible observer; the setup's mock is an arrow function.
    vi.stubGlobal(
        "ResizeObserver",
        class {
            disconnect = vi.fn();

            observe = vi.fn();

            unobserve = vi.fn();
        },
    );
});

describe("project form dialog", () => {
    it("asks before a close drops unsaved rule file changes, and closes only once they are discarded", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();

        render(<ProjectFormDialog editingProject={project} onClose={onClose} open />);

        await user.click(screen.getByRole("button", { name: "Edit a rule file" }));
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(await screen.findByRole("alertdialog", { name: "Discard rule file changes?" })).toBeTruthy();
        await user.click(screen.getByRole("button", { name: "Keep editing" }));
        expect(onClose).not.toHaveBeenCalled();

        await user.keyboard("{Escape}");
        await user.click(await screen.findByRole("button", { name: "Discard changes" }));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("does not ask again on the next open after it was closed from outside while asking", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        const { rerender } = render(<ProjectFormDialog editingProject={project} onClose={onClose} open />);

        await user.click(screen.getByRole("button", { name: "Edit a rule file" }));
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(await screen.findByRole("alertdialog")).toBeTruthy();
        rerender(<ProjectFormDialog editingProject={project} onClose={onClose} open={false} />);
        rerender(<ProjectFormDialog editingProject={project} onClose={onClose} open />);

        await waitFor(() => {
            expect(screen.queryByRole("alertdialog")).toBeNull();
        });
    });

    it("neither closes nor offers to discard while a rule file save is on its way", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();

        render(<ProjectFormDialog editingProject={project} onClose={onClose} open />);

        await user.click(screen.getByRole("button", { name: "Save a rule file" }));
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        expect(toastInfo).toHaveBeenCalledWith("Your rule files are still saving.");
        expect(screen.queryByRole("alertdialog")).toBeNull();

        toastInfo.mockClear();
        await user.click(screen.getByRole("button", { name: "Update Project" }));

        await waitFor(() => {
            expect(toastInfo).toHaveBeenCalledWith("Your rule files are still saving.");
        });
        expect(onClose).not.toHaveBeenCalled();
    });

    it("closes at once with no unsaved rule file changes", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();

        render(<ProjectFormDialog editingProject={project} onClose={onClose} open />);

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onClose).toHaveBeenCalledOnce();
        expect(screen.queryByRole("alertdialog")).toBeNull();
    });
});
