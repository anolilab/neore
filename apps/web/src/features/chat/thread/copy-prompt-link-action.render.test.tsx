import { MODEL_REGISTRY } from "@neore/ai/models";
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

/** The thread the action sits in: its model, and whether it is a group chat. */
const chat = vi.hoisted(() => {
    return { group: null as unknown, model: "not-a-model" };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatThread: () => {
            return { model: chat.model, thread: undefined, threadId: "thread-1" };
        },
    };
});

vi.mock("@/features/chat/group/use-group-chat", () => {
    return { useGroupChat: () => chat.group };
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

const textModel = MODEL_REGISTRY.find((model) => (model.mode ?? "text") === "text" && model.enabled !== false && model.provider !== "external");

const message = { id: "m1", parts: [{ text: "Draft me", type: "text" }], role: "user", text: "Draft me" } as unknown as UIMessage;

const clipboardWith = (clipboard: Partial<Clipboard> | undefined): void => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
};

afterEach(() => {
    chat.group = null;
    chat.model = "not-a-model";
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

    it.each([
        ["names the composer's model", null, true],
        ["names no model in a group chat, where each participant can answer on its own", { participants: [] }, false],
    ])("copies a link to the message that %s", async (_label, group, named) => {
        const writeText = vi.fn(async () => {});

        chat.model = textModel!.id;
        chat.group = group;
        clipboardWith({ writeText });
        render(<CopyPromptLinkAction message={message} />);

        fireEvent.click(screen.getByRole("button", { name: "Copy prompt link" }));

        await waitFor(() => expect(showSuccess).toHaveBeenCalledOnce());

        const link = new URL(String((writeText.mock.calls[0] as unknown[])[0]));

        expect(link.origin).toBe(globalThis.location.origin);
        expect(link.searchParams.get("prompt")).toBe("Draft me");
        expect(link.searchParams.get("model")).toBe(named ? textModel!.id : null);
    });
});
