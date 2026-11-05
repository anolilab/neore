/**
 * Sending from the signed-out chat sends nothing: the draft stays, it is held
 * for after sign-in, and the sign-in prompt opens.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useLoginPromptStore } from "@/features/auth/stores/login-prompt-store";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

import { SignedOutComposer } from "./signed-out-chat";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/features/chat/thread/composer-base", () => {
    return { ComposerBase: ({ children }: { children: ReactNode }) => children };
});

// The real input row is a tiptap editor; this stands in with the same contract.
vi.mock("@/features/chat/thread/composer-input-area", () => {
    return {
        default: ({
            onChange,
            onSubmit,
            suggestions,
            value,
        }: {
            onChange: (text: string) => void;
            onSubmit: () => void;
            suggestions?: boolean;
            value: string;
        }) => (
            <div>
                <textarea aria-label="Message" data-suggestions={String(suggestions)} onChange={(event) => onChange(event.target.value)} value={value} />
                <button onClick={onSubmit} type="button">
                    Send message
                </button>
            </div>
        ),
    };
});

vi.mock("@/features/chat/core/hooks/use-pending-send", async () => {
    const pending = await import("@/features/chat/core/utils/pending-send");
    const prompt = await import("@/features/auth/stores/login-prompt-store");

    return {
        holdForSignIn: (text: string) => {
            pending.savePendingSend(text);
            prompt.openLoginPrompt();
        },
    };
});

describe("SignedOutComposer", () => {
    afterEach(() => {
        sessionStorage.clear();
        useChatUIStore.getState().setComposerText("");
        useLoginPromptStore.getState().setOpen(false);
    });

    it("opens the sign-in prompt on send, keeps the draft and holds it for after sign-in", () => {
        render(<SignedOutComposer />);

        fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "hello" } });
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));

        expect(useLoginPromptStore.getState().isOpen).toBe(true);
        expect(useChatUIStore.getState().composerText).toBe("hello");
        expect(JSON.parse(sessionStorage.getItem("neore:pending-send") ?? "{}")).toMatchObject({ text: "hello" });
    });

    it("does nothing for an empty draft", () => {
        render(<SignedOutComposer />);

        fireEvent.click(screen.getByRole("button", { name: "Send message" }));

        expect(useLoginPromptStore.getState().isOpen).toBe(false);
        expect(sessionStorage.getItem("neore:pending-send")).toBeNull();
    });

    it("turns off slash commands and @ mentions, which read account data", () => {
        render(<SignedOutComposer />);

        expect(screen.getByRole("textbox", { name: "Message" }).dataset.suggestions).toBe("false");
    });
});
