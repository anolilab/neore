/**
 * What sits under the composer panel in a chat: a new chat offers its project choice, an existing chat shows the project it is filed in,
 * and a chat in no project shows nothing.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ComposerContext from "./composer-context";

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
        project: undefined as { title: string } | undefined,
        thread: undefined as { projectId?: string } | undefined,
    };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatThread: () => {
            return { isNewThread: state.isNewThread, thread: state.thread };
        },
    };
});

vi.mock("@/features/projects/hooks/use-projects", () => {
    return { useProject: () => state.project };
});

vi.mock("./composer-project-hint", () => {
    return { default: () => <button type="button">File in Billing</button> };
});

beforeEach(() => {
    state.isNewThread = true;
    state.project = undefined;
    state.thread = undefined;
});

describe("composer context", () => {
    it("offers the project choice on a new chat", () => {
        render(<ComposerContext busy={false} textMode />);

        expect(screen.getByRole("button", { name: "File in Billing" })).toBeTruthy();
    });

    it("holds the choice back while the first message goes out", () => {
        const { container } = render(<ComposerContext busy textMode />);

        expect(container.textContent).toBe("");
    });

    it("shows the project an existing chat is filed in, with its kind for a screen reader", () => {
        state.isNewThread = false;
        state.thread = { projectId: "p-billing" };
        state.project = { title: "Billing" };

        render(<ComposerContext busy={false} textMode />);

        expect(screen.getByRole("group", { name: "Context" }).textContent).toContain("Billing");
        expect(screen.getByText("Project").className).toContain("sr-only");
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("shows nothing for an existing chat in no project", () => {
        state.isNewThread = false;
        state.thread = {};

        const { container } = render(<ComposerContext busy={false} textMode />);

        expect(container.textContent).toBe("");
    });

    it("shows the project of an image, video or audio chat too", () => {
        state.isNewThread = false;
        state.thread = { projectId: "p-billing" };
        state.project = { title: "Billing" };

        render(<ComposerContext busy={false} textMode={false} />);

        expect(screen.getByRole("group", { name: "Context" }).textContent).toContain("Billing");
    });

    it("offers no project choice on a new image, video or audio chat, as before this row", () => {
        const { container } = render(<ComposerContext busy={false} textMode={false} />);

        expect(container.textContent).toBe("");
    });

    it("shows nothing while the project has not loaded", () => {
        state.isNewThread = false;
        state.thread = { projectId: "p-billing" };

        const { container } = render(<ComposerContext busy={false} textMode />);

        expect(container.textContent).toBe("");
    });
});
