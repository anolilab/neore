/**
 * Dismissing the sign-in prompt without signing in drops the held message, so
 * it is not sent by surprise on a later sign-in; a successful sign-in keeps it.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openLoginPrompt, useLoginPromptStore } from "@/features/auth/stores/login-prompt-store";
import { savePendingSend } from "@/features/chat/core/utils/pending-send";

import LoginPromptHost from "./login-prompt-host";

const harness = vi.hoisted(() => {
    return { user: undefined as { isAnonymous?: boolean } | undefined };
});

vi.mock("@/features/auth/hooks/use-is-anonymous", () => {
    return {
        default: () => {
            return { isAnonymous: harness.user?.isAnonymous ?? false, user: harness.user };
        },
    };
});

vi.mock("./login-modal", () => {
    return {
        default: ({ onOpenChange, open, redirectTo }: { onOpenChange: (open: boolean) => void; open: boolean; redirectTo?: string }) =>
            open ? (
                <div data-redirect-to={redirectTo} role="dialog">
                    <button onClick={() => onOpenChange(false)} type="button">
                        Close
                    </button>
                </div>
            ) : null,
    };
});

describe("LoginPromptHost", () => {
    beforeEach(() => {
        harness.user = undefined;
        savePendingSend("hello");
        globalThis.history.replaceState(null, "", "/chat/abc?x=1");
    });

    afterEach(() => {
        sessionStorage.clear();
        useLoginPromptStore.getState().setOpen(false);
    });

    it("comes back to the page it was opened on", async () => {
        render(<LoginPromptHost />);
        act(() => {
            openLoginPrompt();
        });

        const dialog = await screen.findByRole("dialog");

        expect(dialog.dataset.redirectTo).toBe("/chat/abc?x=1");
    });

    it("drops the held message when dismissed without signing in", async () => {
        render(<LoginPromptHost />);
        act(() => {
            openLoginPrompt();
        });
        fireEvent.click(await screen.findByRole("button", { name: "Close" }));

        expect(useLoginPromptStore.getState().isOpen).toBe(false);
        expect(sessionStorage.getItem("neore:pending-send")).toBeNull();
    });

    it("keeps the held message when it closes because an account signed in", async () => {
        const view = render(<LoginPromptHost />);

        act(() => {
            openLoginPrompt();
        });
        await screen.findByRole("dialog");
        harness.user = { isAnonymous: false };
        // Re-render with the signed-in session, as the session hook would.
        view.rerender(<LoginPromptHost />);
        fireEvent.click(screen.getByRole("button", { name: "Close" }));

        expect(sessionStorage.getItem("neore:pending-send")).not.toBeNull();
    });
});
