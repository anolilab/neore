// @vitest-environment jsdom

/** A welcome-screen suggestion goes into the composer marked: the person picked it, they did not type it. */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t };
        },
    };
});

const { default: ThreadWelcomeSuggestions } = await import("./thread-welcome-suggestions");

// The tab list measures itself; jsdom has no ResizeObserver to construct.
/* eslint-disable class-methods-use-this -- an inert stand-in: its methods do nothing */
class InertResizeObserver {
    public disconnect(): void {}

    public observe(): void {}

    public unobserve(): void {}
}
/* eslint-enable class-methods-use-this */

beforeEach(() => {
    useChatUIStore.getState().reset();
    vi.stubGlobal("ResizeObserver", InertResizeObserver);
});

describe("ThreadWelcomeSuggestions", () => {
    it("marks the composer's draft when a suggestion is picked", () => {
        render(<ThreadWelcomeSuggestions />);

        fireEvent.click(screen.getByRole("tab", { name: "Ideas" }));
        fireEvent.click(screen.getByText("Brainstorm ways to improve team productivity"));

        expect(useChatUIStore.getState().composerText).toBe("Brainstorm ways to improve team productivity");
        expect(useChatUIStore.getState().composerDraftFrom).toBe("suggestion");
    });
});
