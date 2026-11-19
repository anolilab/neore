/**
 * The project hint: a quiet button on a new thread's first message names a project the draft matches, and a click picks it
 * for the send. Matching is local, over the project list and the thread rows the client already has.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";

import ComposerProjectHint from "./composer-project-hint";

// Unit tests do not compile the Lingui macros.
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

const state = vi.hoisted(() => {
    return {
        isNewThread: true,
        projects: [] as { _id: string; projectType?: string; title: string }[],
        newChatsTemporary: false,
        threads: [] as { projectId?: string; status?: string; title?: string }[],
    };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatThread: () => {
            return { isNewThread: state.isNewThread };
        },
    };
});

vi.mock("@/features/projects/hooks/use-projects", () => {
    return { useProjects: () => state.projects };
});

vi.mock("@/features/chat/core/hooks/use-threads", () => {
    return { useThreads: () => state.threads };
});

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUserSettings: () => {
            return { data: { newChatsTemporary: state.newChatsTemporary } };
        },
    };
});

const billing = { _id: "p-billing", title: "Billing" };
const fileInBilling = /File in Billing/;

beforeEach(() => {
    state.isNewThread = true;
    state.newChatsTemporary = false;
    state.projects = [billing];
    state.threads = [{ projectId: "p-billing", status: "active", title: "Invoice export as CSV" }];
    useChatUIStore.getState().setComposerText("");
    useModelStore.getState().setPendingSettings(undefined);
});

describe("composer project hint", () => {
    it("shows a chip for a new thread whose draft matches a project through one of its threads", () => {
        useChatUIStore.getState().setComposerText("invoice export");

        render(<ComposerProjectHint />);

        const chip = screen.getByRole("button", { name: "File in Billing" });

        expect(chip.getAttribute("aria-pressed")).toBe("false");
    });

    it("shows nothing when the draft matches no project", () => {
        useChatUIStore.getState().setComposerText("weather tomorrow");

        render(<ComposerProjectHint />);

        expect(screen.queryByRole("button")).toBeNull();
    });

    it("shows nothing on an existing thread, even when the draft matches", () => {
        state.isNewThread = false;
        useChatUIStore.getState().setComposerText("invoice export");

        render(<ComposerProjectHint />);

        expect(screen.queryByRole("button")).toBeNull();
    });

    it("picks the project on click and drops the pick on a second click", () => {
        useChatUIStore.getState().setComposerText("invoice export");

        render(<ComposerProjectHint />);

        fireEvent.click(screen.getByRole("button", { name: "File in Billing" }));

        expect(useModelStore.getState().pendingSettings?.projectId).toBe("p-billing");

        const picked = screen.getByRole("button", { name: "File in Billing" });

        expect(picked.getAttribute("aria-pressed")).toBe("true");

        fireEvent.click(picked);

        expect(useModelStore.getState().pendingSettings?.projectId).toBeUndefined();
        expect(screen.getByRole("button", { name: "File in Billing" }).getAttribute("aria-pressed")).toBe("false");
    });

    it("offers no project for a temporary chat, and offers it again once the chat is lasting", () => {
        useChatUIStore.getState().setComposerText("invoice export");
        useModelStore.getState().setPendingSettings({ isTempChat: true, projectId: "p-billing" } as never);

        const { container, rerender } = render(<ComposerProjectHint />);

        expect(container.textContent).toBe("");

        useModelStore.getState().setPendingSettings({ isTempChat: false, projectId: "p-billing" } as never);
        rerender(<ComposerProjectHint />);

        expect(screen.getByRole("button", { name: fileInBilling })).toBeTruthy();
    });

    it("keeps a stored pick visible, pressed, even when its project is not in the list, and clears it on click", () => {
        state.projects = [];
        useChatUIStore.getState().setComposerText("weather tomorrow");
        useModelStore.getState().setPendingSettings({ projectId: "p-gone" } as never);

        render(<ComposerProjectHint />);

        const chip = screen.getByRole("button", { name: "File in another project" });

        expect(chip.getAttribute("aria-pressed")).toBe("true");

        fireEvent.click(chip);

        expect(useModelStore.getState().pendingSettings?.projectId).toBeUndefined();
    });

    it("offers no project for a temporary chat that comes from the user's default", () => {
        state.newChatsTemporary = true;
        useChatUIStore.getState().setComposerText("invoice export");

        const { container } = render(<ComposerProjectHint />);

        expect(container.textContent).toBe("");
    });
});
