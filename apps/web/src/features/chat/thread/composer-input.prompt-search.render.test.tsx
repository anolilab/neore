/**
 * The Ctrl+R prompt search as the composer runs it: it opens only while the composer can take a draft, it closes when the
 * composer locks or another chat opens, and a picked prompt saved as not typed goes into the draft with its mark.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode, Ref } from "react";
import { useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { markComposerDraft } from "@/features/chat/core/utils/draft-origin";

import type { ComposerInputAreaRef } from "./composer-input-area";

const harness = vi.hoisted(() => {
    return {
        sendMessage: vi.fn(async () => undefined),
        isStreaming: false,
        showError: vi.fn(),
        session: { data: { user: { id: "user-1" } } as { user: { id: string } } | null, isPending: false },
        showInfo: vi.fn(),
        upload: vi.fn<(state: { file: File }) => Promise<unknown>>(),
        comparisonLoading: false,
        pickedMark: "suggestion" as string | undefined,
        threadId: "thread-1" as string | undefined,
    };
});

vi.mock("@/features/connection/hooks/use-connection", () => {
    return { useConnectionView: () => "online" };
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

vi.mock("@/features/auth/hooks/use-auth-session", () => {
    return {
        useAuthSession: () => harness.session,
    };
});
vi.mock("@/features/auth/hooks/use-invite-only", () => {
    return {
        default: () => {
            return { canSignUp: false, inviteOnly: false, mustSignIn: false, signUpHref: "/auth/sign-in" };
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
        useChatIsRunning: () => false,
        useChatIsStreaming: () => {
            return { isStreaming: harness.isStreaming, sseStreamState: null };
        },
        useChatLunora: () => {
            return {};
        },
        useChatMessages: () => {
            return { isStreaming: false, messages: [], messagesStatus: "loaded" };
        },
        useChatThread: () => {
            return { isNewThread: false, threadId: harness.threadId };
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
            return { isLoading: harness.comparisonLoading, sendComparisonMessage: vi.fn(async () => undefined) };
        },
    };
});

vi.mock("@/features/chat/core/hooks/use-runner-capabilities", () => {
    return { default: () => null };
});

// The upload path reads `VITE_LUNORA_URL` at import time, and CI runs without one.
vi.mock("@/lib/auth/server-functions", () => {
    return { default: vi.fn() };
});

vi.mock("@/lib/toast", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("@/lib/toast")>()), showError: harness.showError, showInfo: harness.showInfo };
});

// Uploads the composer starts itself (a converted text) finish when a test says so.
vi.mock("@/features/chat/core/adapters/lunora-attachment-adapter", async (importOriginal) => {
    const original = await importOriginal<typeof import("@/features/chat/core/adapters/lunora-attachment-adapter")>();

    return {
        ...original,
        createLunoraAttachmentAdapter: () => {
            return { accept: "", add: vi.fn(), remove: vi.fn(), send: vi.fn(), upload: harness.upload };
        },
    };
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

// The input row stands in with its contract: Ctrl+R reaches the composer through `onPromptSearch`, absent when it is not offered.
const InputArea = ({ onPromptSearch, ref }: { onPromptSearch?: () => boolean; ref?: Ref<ComposerInputAreaRef> }) => {
    useImperativeHandle(ref, () => {
        return { blur: () => undefined, focus: () => undefined, getEditor: () => null };
    });

    return (
        <button disabled={onPromptSearch === undefined} onClick={() => onPromptSearch?.()} type="button">
            Search prompts
        </button>
    );
};

vi.mock("./composer-input-area", () => {
    return { default: InputArea };
});

for (const path of [
    "@/features/chat/voice-mode/auto-read-replies",
    "@/features/chat/voice-mode/voice-mode-button",
    "@/features/chat/prompt-improvement/components/composer-prompt-improvement-button",
    "@/features/chat/components/reference-picker/reference-strip",
    "./completion-sound",
    "./composer-prompt-queue",
    "./reply-complete-announcement",
    "./turn-step-announcement",
]) {
    vi.doMock(path, () => {
        return { default: () => null };
    });
}

// The search stands in with its contract: a pick hands back the prompt and its not-typed mark.
vi.doMock("./composer-prompt-search", () => {
    return {
        default: ({ onPick }: { onPick: (prompt: { draftFrom?: string; text: string }) => void }) => (
            <button onClick={() => onPick({ draftFrom: harness.pickedMark, text: "deploy a preview" })} type="button">
                Pick
            </button>
        ),
    };
});

const { default: ComposerInput } = await import("./composer-input");

const renderComposer = () =>
    render(
        <QueryClientProvider client={new QueryClient()}>
            <ComposerInput />
        </QueryClientProvider>,
    );

const openSearch = () => {
    fireEvent.click(screen.getByRole("button", { name: "Search prompts" }));
};

describe("ComposerInput prompt search", () => {
    afterEach(() => {
        harness.comparisonLoading = false;
        harness.pickedMark = "suggestion";
        harness.threadId = "thread-1";
        useChatUIStore.getState().clearComposer();
        vi.clearAllMocks();
    });

    it("puts a picked prompt in the draft with the mark it was saved with", () => {
        renderComposer();
        openSearch();
        fireEvent.click(screen.getByRole("button", { name: "Pick" }));

        expect(useChatUIStore.getState().composerText).toBe("deploy a preview");
        expect(useChatUIStore.getState().composerDraftFrom).toBe("suggestion");
        expect(screen.queryByRole("button", { name: "Pick" })).toBeNull();
    });

    it("lets a prompt an admin wrote as the person replace the weaker mark a draft already has", () => {
        useChatUIStore.getState().setComposerText("check this");
        markComposerDraft("suggestion");
        harness.pickedMark = "impersonated";
        renderComposer();
        openSearch();
        fireEvent.click(screen.getByRole("button", { name: "Pick" }));

        expect(useChatUIStore.getState().composerDraftFrom).toBe("impersonated");
    });

    it("drops a blank draft's mark when the person's own prompt replaces it, and keeps a typed draft's", () => {
        useChatUIStore.getState().setComposerText(" ".repeat(3));
        markComposerDraft("suggestion");
        harness.pickedMark = undefined;
        renderComposer();
        openSearch();
        fireEvent.click(screen.getByRole("button", { name: "Pick" }));

        expect(useChatUIStore.getState().composerText).toBe("deploy a preview");
        expect(useChatUIStore.getState().composerDraftFrom).toBeUndefined();

        // Added below words that came from a suggestion, the person's prompt leaves those words marked.
        useChatUIStore.getState().setComposerText("check this");
        markComposerDraft("suggestion");
        openSearch();
        fireEvent.click(screen.getByRole("button", { name: "Pick" }));

        expect(useChatUIStore.getState().composerText).toBe("check this\ndeploy a preview");
        expect(useChatUIStore.getState().composerDraftFrom).toBe("suggestion");
    });

    it("does not offer the search while a comparison send locks the composer", () => {
        harness.comparisonLoading = true;
        renderComposer();

        expect(screen.getByRole("button", { name: "Search prompts" })).toHaveProperty("disabled", true);
    });

    it("closes the search when another chat opens in the same composer", () => {
        const view = renderComposer();

        openSearch();
        expect(screen.getByRole("button", { name: "Pick" })).toBeTruthy();

        harness.threadId = "thread-2";
        view.rerender(
            <QueryClientProvider client={new QueryClient()}>
                <ComposerInput />
            </QueryClientProvider>,
        );

        expect(screen.queryByRole("button", { name: "Pick" })).toBeNull();
    });
});
