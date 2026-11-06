/**
 * Under invite-only a guest's send is held for sign-in. A plain send is held in `ChatProvider.sendMessage`; a
 * comparison send (`onSubmitOverride`, or comparison mode) never reaches it, so the composer holds it itself:
 * nothing is sent, the draft stays, and the sign-in prompt opens.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLoginPromptStore } from "@/features/auth/stores/login-prompt-store";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

const harness = vi.hoisted(() => {
    return {
        mustSignIn: true,
        sendComparisonMessage: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => undefined),
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: ReactNode }) => children,
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/features/auth/hooks/use-invite-only", () => {
    return {
        default: () => {
            return { canSignUp: false, inviteOnly: true, mustSignIn: harness.mustSignIn, signUpHref: "/auth/sign-in" };
        },
    };
});

vi.mock("@/features/chat/core/hooks/use-pending-send", async (importOriginal) => {
    const original = await importOriginal<typeof import("@/features/chat/core/hooks/use-pending-send")>();

    return { ...original, default: () => undefined };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatActions: () => {
            return { cancelStream: vi.fn(), jwtToken: "", sendMessage: harness.sendMessage };
        },
        useChatIsStreaming: () => {
            return { isStreaming: false, sseStreamState: null };
        },
        useChatLunora: () => {
            return {};
        },
        useChatThread: () => {
            return { isNewThread: true, threadId: undefined };
        },
    };
});

vi.mock("@/features/layout/hooks/use-ui-state", () => {
    return {
        useUserPreferences: () => {
            return { sendBehavior: "enter" };
        },
    };
});

vi.mock("@/features/chat/core/hooks/use-comparison-chat", () => {
    return {
        default: () => {
            return { isLoading: false, sendComparisonMessage: harness.sendComparisonMessage };
        },
    };
});

vi.mock("@/features/chat/core/hooks/use-runner-capabilities", () => {
    return { default: () => null };
});

// The upload path reads `VITE_LUNORA_URL` at import time (the env schema and the session-token server function),
// and CI runs without one.
vi.mock("@/lib/auth/server-functions", () => {
    return { default: vi.fn() };
});

vi.mock("@/lib/env", () => {
    return { default: { VITE_LUNORA_URL: "http://localhost:8788" } };
});

vi.mock("@/lib/lunora/crpc", () => {
    const proxy: unknown = new Proxy(() => undefined, {
        apply: () => {
            return { mutationFn: async () => undefined };
        },
        get: () => proxy,
    });

    return {
        useCRPC: () => proxy,
        useLunoraActionOptions: () => {
            return { mutationFn: async () => undefined };
        },
    };
});

vi.mock("./composer-tiptap/use-composer-autocomplete", () => {
    return { default: () => undefined };
});

// The input row stands in with its contract: the draft and the submit control.
vi.mock("./composer-input-area", () => {
    return {
        default: ({ onSubmit, value }: { onSubmit: () => void; value: string }) => (
            <div>
                <output aria-label="Draft">{value}</output>
                <button onClick={onSubmit} type="button">
                    Send message
                </button>
            </div>
        ),
    };
});

for (const path of [
    "@/features/chat/voice-mode/auto-read-replies",
    "@/features/chat/voice-mode/voice-mode-button",
    "@/features/chat/prompt-improvement/components/composer-prompt-improvement-button",
    "@/features/chat/components/reference-picker/reference-strip",
    "./completion-sound",
    "./composer-prompt-queue",
    "./reply-complete-announcement",
    "./composer-long-text-prompt",
]) {
    vi.doMock(path, () => {
        return { default: () => null };
    });
}

const { default: ComposerInput } = await import("./composer-input");

const renderComposer = (props: Record<string, unknown> = {}) =>
    render(
        <QueryClientProvider client={new QueryClient()}>
            <ComposerInput {...props} />
        </QueryClientProvider>,
    );

describe("ComposerInput under invite-only", () => {
    beforeEach(() => {
        harness.mustSignIn = true;
        useChatUIStore.getState().setComposerText("compare these");
    });

    afterEach(() => {
        sessionStorage.clear();
        useChatUIStore.getState().clearComposer();
        useChatUIStore.getState().setIsSubmitting(false);
        useLoginPromptStore.getState().setOpen(false);
        vi.clearAllMocks();
    });

    it("holds a guest's comparison fan-out for sign-in instead of sending it", () => {
        const onSubmitOverride = vi.fn(async () => undefined);

        renderComposer({ onSubmitOverride });
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));

        expect(onSubmitOverride).not.toHaveBeenCalled();
        expect(useLoginPromptStore.getState().isOpen).toBe(true);
        expect(useChatUIStore.getState().composerText).toBe("compare these");
        expect(JSON.parse(sessionStorage.getItem("neore:pending-send") ?? "{}")).toMatchObject({ text: "compare these" });
    });

    it("sends a comparison fan-out for an account", () => {
        harness.mustSignIn = false;

        const onSubmitOverride = vi.fn(async () => undefined);

        renderComposer({ onSubmitOverride });
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));

        expect(onSubmitOverride).toHaveBeenCalledWith("compare these", []);
        expect(useLoginPromptStore.getState().isOpen).toBe(false);
    });
});
