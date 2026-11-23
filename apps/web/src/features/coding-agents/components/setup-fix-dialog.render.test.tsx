/**
 * "Fix setup" shows the prepared task for editing, and starts a run only on the explicit click, with the text the
 * person left in the field.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SetupFixButton from "./setup-fix-dialog";

const { mutate } = vi.hoisted(() => {
    return { mutate: vi.fn() };
});

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t: text };
        },
    };
});

vi.mock("@neore/ui/components/responsive-dialog", () => {
    const Part = ({ children }: { children?: ReactNode }) => <div>{children}</div>;

    return {
        Dialog: ({ children, open }: { children?: ReactNode; open: boolean }) => (open ? <div role="dialog">{children}</div> : null),
        DialogContent: Part,
        DialogDescription: Part,
        DialogFooter: Part,
        DialogHeader: Part,
        DialogPanel: Part,
        DialogTitle: Part,
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                coding_agents: {
                    functions: {
                        startSetupFix: {
                            mutationOptions: () => {
                                return {};
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            return { isPending: false, mutate };
        },
    };
});

vi.mock("@/lib/toast", () => {
    return { showError: vi.fn(), showSuccess: vi.fn() };
});

const PROMPT = 'The setup failed at "repo-setup".\n> pnpm: not found';

describe("SetupFixButton", () => {
    beforeEach(() => {
        mutate.mockClear();
    });

    it("opens the prepared task for editing without starting anything", () => {
        render(<SetupFixButton finalFocusRef={{ current: null }} prompt={PROMPT} runId={"run-1" as never} step="repo-setup" />);

        expect(screen.queryByRole("dialog")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Fix setup" }));

        expect(screen.getByRole("textbox", { name: "Task for the coding agent" })).toHaveProperty("value", PROMPT);
        expect(mutate).not.toHaveBeenCalled();
    });

    it("starts the fix with the edited task on Start fix", () => {
        render(<SetupFixButton finalFocusRef={{ current: null }} prompt={PROMPT} runId={"run-1" as never} step="repo-setup" />);

        fireEvent.click(screen.getByRole("button", { name: "Fix setup" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Task for the coding agent" }), { target: { value: "Fix the setup script" } });
        fireEvent.click(screen.getByRole("button", { name: "Start fix" }));

        expect(mutate).toHaveBeenCalledWith({ prompt: "Fix the setup script", runId: "run-1" }, expect.any(Object));
    });

    it("cannot start an empty task", () => {
        render(<SetupFixButton finalFocusRef={{ current: null }} prompt={PROMPT} runId={"run-1" as never} step="repo-setup" />);

        fireEvent.click(screen.getByRole("button", { name: "Fix setup" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Task for the coding agent" }), { target: { value: " ".repeat(3) } });

        expect(screen.getByRole("button", { name: "Start fix" })).toHaveProperty("disabled", true);
    });

    it("says why an empty task cannot start, and links the reason to the field", () => {
        render(<SetupFixButton finalFocusRef={{ current: null }} prompt={PROMPT} runId={"run-1" as never} step="repo-setup" />);

        fireEvent.click(screen.getByRole("button", { name: "Fix setup" }));
        const field = screen.getByRole("textbox", { name: "Task for the coding agent" });

        expect(field.getAttribute("aria-describedby")).toBeNull();

        fireEvent.change(field, { target: { value: "" } });

        const reason = screen.getByText("Write the task for the agent before you start the fix.");

        expect(field.getAttribute("aria-describedby")).toBe(reason.id);
        expect(field.hasAttribute("required")).toBe(true);
    });
});
