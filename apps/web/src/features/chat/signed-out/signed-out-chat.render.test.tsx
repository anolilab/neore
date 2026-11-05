/**
 * Sending from the signed-out chat sends nothing: the draft stays, it is held
 * for after sign-in, and the sign-in prompt opens.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useLoginPromptStore } from "@/features/auth/stores/login-prompt-store";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

import { askToSignIn, SignedOutComposer } from "./signed-out-chat";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

// The chrome around the input is static and covered by the render check; these tests are about sending.
vi.mock("@/features/chat/thread/composer", () => {
    return { ComposerModeSwitcher: () => null };
});

vi.mock("@/features/chat/thread/composer-search-mode", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/thread/thread-welcome-suggestions", () => {
    return { default: () => null };
});

vi.mock("@/features/layout/components/sidebar-shortcut", () => {
    return { NAV_LINK_DEFS: [] };
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

describe("askToSignIn", () => {
    afterEach(() => {
        useLoginPromptStore.getState().setOpen(false);
    });

    it("leaves focus on the control that opened the prompt, so closing it returns there", () => {
        render(
            <button onClick={askToSignIn} type="button">
                New Thread
            </button>,
        );

        const trigger = screen.getByRole("button", { name: "New Thread" });

        trigger.focus();
        fireEvent.click(trigger);

        expect(useLoginPromptStore.getState().isOpen).toBe(true);
        // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this asserts
        expect(document.activeElement).toBe(trigger);
    });
});
