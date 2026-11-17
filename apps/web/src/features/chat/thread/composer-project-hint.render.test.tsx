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

const billing = { _id: "p-billing", title: "Billing" };

beforeEach(() => {
    state.isNewThread = true;
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

        const picked = screen.getByRole("button", { name: "Will file in Billing" });

        expect(picked.getAttribute("aria-pressed")).toBe("true");

        fireEvent.click(picked);

        expect(useModelStore.getState().pendingSettings?.projectId).toBeUndefined();
        expect(screen.getByRole("button", { name: "File in Billing" }).getAttribute("aria-pressed")).toBe("false");
    });
});
