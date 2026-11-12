import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

const harness = vi.hoisted(() => {
    return { composerRenders: 0 };
});

vi.mock("@/features/chat/thread/composer", () => {
    return {
        default: ({ compact }: { compact?: boolean }) => {
            harness.composerRenders += 1;

            return <input aria-label="Message" data-compact={String(Boolean(compact))} />;
        },
    };
});

vi.mock("./landing-chat-provider", () => {
    return { default: ({ children }: { children: ReactNode }) => children };
});

const { default: LandingStickyBar } = await import("./landing-sticky-bar");

describe("the landing page's sticky composer", () => {
    afterEach(() => {
        useChatUIStore.getState().clearComposer();
    });

    it("does not re-render the composer on each keystroke", () => {
        render(<LandingStickyBar visible />);
        harness.composerRenders = 0;

        for (const draft of ["h", "he", "hel", "hell", "hello"]) {
            act(() => useChatUIStore.getState().setComposerText(draft));
        }

        expect(harness.composerRenders).toBe(0);
    });

    it("stays expanded on a click outside while there is a draft, and collapses once it is empty", () => {
        render(<LandingStickyBar visible />);
        fireEvent.focus(screen.getByRole("textbox", { name: "Message" }));
        act(() => useChatUIStore.getState().setComposerText("hello"));

        fireEvent.mouseDown(document.body);

        expect(screen.getByRole("textbox", { name: "Message" }).dataset.compact).toBe("false");

        act(() => useChatUIStore.getState().clearComposer());
        fireEvent.mouseDown(document.body);

        expect(screen.getByRole("textbox", { name: "Message" }).dataset.compact).toBe("true");
    });
});
