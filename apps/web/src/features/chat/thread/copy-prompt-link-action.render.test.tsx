import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UIMessage } from "@/lib/agent";
import { showError, showSuccess } from "@/lib/toast";

import CopyPromptLinkAction from "./copy-prompt-link-action";

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray) => strings.join("");

    return {
        useLingui: () => {
            return { t };
        },
    };
});

vi.mock("@/lib/toast", () => {
    return { showError: vi.fn(), showSuccess: vi.fn(), showWarning: vi.fn() };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatThread: () => {
            return { model: "not-a-model", thread: undefined, threadId: undefined };
        },
    };
});

// The action bar's button is not under test: a plain button with the action's name and click.
vi.mock("@neore/ui/components/ai-elements/message", () => {
    return {
        MessageAction: ({ children, label, onClick }: { children: ReactNode; label: string; onClick: () => void }) => (
            <button aria-label={label} onClick={onClick} type="button">
                {children}
            </button>
        ),
    };
});

const message = { id: "m1", parts: [{ text: "Draft me", type: "text" }], role: "user", text: "Draft me" } as unknown as UIMessage;

const clipboardWith = (clipboard: Partial<Clipboard> | undefined): void => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
};

afterEach(() => {
    vi.mocked(showError).mockClear();
    vi.mocked(showSuccess).mockClear();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});

describe(CopyPromptLinkAction, () => {
    it.each([
        [
            "refuses the write",
            {
                writeText: async () => {
                    throw new DOMException("denied", "NotAllowedError");
                },
            },
        ],
        ["has no Clipboard API", undefined],
    ])("says the copy failed, and not that it worked, when the browser %s", async (_label, clipboard) => {
        clipboardWith(clipboard as Partial<Clipboard> | undefined);
        render(<CopyPromptLinkAction message={message} />);

        fireEvent.click(screen.getByRole("button", { name: "Copy prompt link" }));

        await waitFor(() => expect(showError).toHaveBeenCalledOnce());
        expect(showSuccess).not.toHaveBeenCalled();
    });
});
