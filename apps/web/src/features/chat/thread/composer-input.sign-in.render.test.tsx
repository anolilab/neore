/**
 * Under invite-only a guest's send is held for sign-in. A plain send is held in `ChatProvider.sendMessage`; a
 * comparison send (`onSubmitOverride`, or comparison mode) never reaches it, so the composer holds it itself:
 * nothing is sent, the draft stays, and the sign-in prompt opens.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import type { ReactNode, Ref } from "react";
import { useEffect, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLoginPromptStore } from "@/features/auth/stores/login-prompt-store";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import type { QueuedChatPrompt } from "@/features/chat/core/stores/prompt-queue-store";
import { usePromptQueueStore } from "@/features/chat/core/stores/prompt-queue-store";
import { requestComposerRestore } from "@/features/chat/core/utils/composer-restore";
import { requestComposerSubmit } from "@/features/chat/core/utils/composer-submit";
import { clearSendStarting, markSendStarting } from "@/features/chat/core/utils/send-in-flight";
import { setDraftBound } from "@/features/chat/split/composer-drafts";
import { prefillComposer } from "@/features/chat/thread/composer-prefill";

import type { ComposerInputAreaRef } from "./composer-input-area";
import type { ComposerTiptapEditorRef } from "./composer-tiptap/composer-tiptap-editor";
import QuoteChip from "./composer-tiptap/extensions/quote-chip";
import { appendPlainText, composerCoreExtensionOptions, pastePlainText } from "./composer-tiptap/paste-plain-text";

const harness = vi.hoisted(() => {
    return {
        isStreaming: false,
        /** Every mutation the composer calls through `useCRPC`, with its arguments. */
        mutate: vi.fn(async (_args: unknown) => undefined),
        mustSignIn: true,
        /** A send held through sign-in, handed back once by `usePendingSend`. */
        pending: undefined as { draftFrom?: string; text: string } | undefined,
        /** The runner's report: `steer` gives the composer its steer control. */
        runner: null as unknown,
        sendComparisonMessage: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => undefined),
        /** The input row's editor; none by default, as a composer before the editor loads. */
        editor: null as ComposerTiptapEditorRef | null,
        showError: vi.fn(),
        showInfo: vi.fn(),
        sseStreamState: null as string | null,
        threadId: undefined as string | undefined,
        view: "online" as "offline" | "online" | "reconnecting",
    };
});

vi.mock("@/features/connection/hooks/use-connection", () => {
    return { useConnectionView: () => harness.view };
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
        useAuthSession: () => {
            return { data: { user: { id: "user-1" } } };
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

    return {
        ...original,
        default: function usePendingSendStub(enabled: boolean, send: (pending: { draftFrom?: string; text: string }) => void) {
            useEffect(() => {
                const { pending } = harness;

                if (enabled && pending !== undefined) {
                    harness.pending = undefined;
                    send(pending);
                }
            });
        },
    };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatActions: () => {
            return { cancelStream: vi.fn(), jwtToken: "", sendMessage: harness.sendMessage };
        },
        useChatIsRunning: () => harness.isStreaming,
        useChatIsStreaming: () => {
            return { isStreaming: harness.isStreaming, sseStreamState: harness.sseStreamState };
        },
        useChatLunora: () => {
            return {};
        },
        useChatMessages: () => {
            return { isStreaming: harness.isStreaming, messages: [], messagesStatus: "loaded" };
        },
        useChatThread: () => {
            return { isNewThread: harness.threadId === undefined, threadId: harness.threadId };
        },
    };
});

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUserSettings: () => {
            return { data: null };
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
    return { default: () => harness.runner };
});

// The upload path reads `VITE_LUNORA_URL` at import time (the env schema and the session-token server function),
// and CI runs without one.
vi.mock("@/lib/auth/server-functions", () => {
    return { default: vi.fn() };
});

vi.mock("@/lib/toast", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("@/lib/toast")>()), showError: harness.showError, showInfo: harness.showInfo };
});

vi.mock("@/lib/env", () => {
    return { default: { VITE_LUNORA_URL: "http://localhost:8788" } };
});

vi.mock("@/lib/lunora/crpc", () => {
    const proxy: unknown = new Proxy(() => undefined, {
        apply: () => {
            return { mutationFn: harness.mutate };
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

const InputArea = ({
    onPaste,
    onSteer,
    onSubmit,
    ref,
    value,
}: {
    onPaste?: (event: unknown) => void;
    onSteer?: () => void;
    onSubmit: () => void;
    ref?: Ref<ComposerInputAreaRef>;
    value: string;
}) => {
    useImperativeHandle(ref, () => {
        return { blur: () => undefined, focus: () => undefined, getEditor: () => harness.editor };
    });

    return (
        <div>
            <output aria-label="Draft" onPaste={onPaste}>
                {value}
            </output>
            <button onClick={onSubmit} type="button">
                Send message
            </button>
            {onSteer && (
                <button onClick={onSteer} type="button">
                    Steer
                </button>
            )}
        </div>
    );
};

// The input row stands in with its contract: the draft, the submit control and the editor.
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

        expect(onSubmitOverride).toHaveBeenCalledWith("compare these", [], undefined);
        expect(useLoginPromptStore.getState().isOpen).toBe(false);
    });
});

describe("ComposerInput paste", () => {
    afterEach(() => {
        harness.threadId = undefined;
        useChatUIStore.getState().clearComposer();
        vi.clearAllMocks();
    });

    it("tells the user, and inserts nothing, when another chat opens while a paste is converted", async () => {
        harness.mustSignIn = false;
        harness.threadId = "chat-a";

        const view = renderComposer();
        const data: Record<string, string> = { "text/html": "<p><b>bold</b> text</p>", "text/plain": "bold text" };

        fireEvent.paste(screen.getByLabelText("Draft"), { clipboardData: { getData: (type: string) => data[type] ?? "", items: [] } });
        harness.threadId = "chat-b";
        view.rerender(
            <QueryClientProvider client={new QueryClient()}>
                <ComposerInput />
            </QueryClientProvider>,
        );

        await waitFor(() => {
            expect(harness.showError).toHaveBeenCalledWith("The chat changed before the paste was ready, so it was not inserted.");
        });
        expect(useChatUIStore.getState().composerText).toBe("");
    });

    it("tells the user, and inserts nothing, when the composer is locked while a paste is converted", async () => {
        harness.mustSignIn = false;

        const view = renderComposer();
        const data: Record<string, string> = { "text/html": "<p><b>bold</b> text</p>", "text/plain": "bold text" };

        fireEvent.paste(screen.getByLabelText("Draft"), { clipboardData: { getData: (type: string) => data[type] ?? "", items: [] } });
        view.rerender(
            <QueryClientProvider client={new QueryClient()}>
                <ComposerInput disabled />
            </QueryClientProvider>,
        );

        await waitFor(() => {
            expect(harness.showInfo).toHaveBeenCalledWith("The composer was locked before the paste was ready, so it was not inserted.");
        });
        expect(useChatUIStore.getState().composerText).toBe("");
    });
});

describe("ComposerInput paste into an editor with a quote chip", () => {
    let editor: Editor | undefined;

    afterEach(() => {
        editor?.destroy();
        editor = undefined;
        harness.editor = null;
        useChatUIStore.getState().clearComposer();
        vi.clearAllMocks();
    });

    /**
     * An editor holding `content`, as plain as the composer's, the store's draft set to its text as the editor's own updates
     * set it. Without `trailingNode` a chip can end the document.
     */
    const editorWith = (content: object[], trailingNode = true): Editor => {
        const plain = { blockquote: false, bold: false, code: false, codeBlock: false, heading: false, italic: false, strike: false } as const;
        const instance = new Editor({
            content: { content, type: "doc" },
            coreExtensionOptions: composerCoreExtensionOptions,
            extensions: [
                StarterKit.configure(trailingNode ? plain : { ...plain, trailingNode: false }),
                QuoteChip.configure({
                    labels: () => {
                        return { goToReply: "Go to reply" };
                    },
                }),
            ],
        });

        editor = instance;
        harness.editor = {
            appendText: (text: string) => appendPlainText(instance, text),
            blur: () => undefined,
            focus: () => undefined,
            getEditor: () => instance,
            isPlainPaste: () => false,
            pasteText: (text: string, at?: Parameters<typeof pastePlainText>[2]) => pastePlainText(instance, text, at),
        };
        useChatUIStore.getState().setComposerText(instance.getText({ blockSeparator: "\n" }));

        return instance;
    };

    const chip = { attrs: { messageId: "m1", text: "quoted" }, type: "quoteChip" };
    const pasteFormatted = (): void => {
        const data: Record<string, string> = { "text/html": "<p><b>bold</b> text</p>", "text/plain": "bold text" };

        fireEvent.paste(screen.getByLabelText("Draft"), { clipboardData: { getData: (type: string) => data[type] ?? "", items: [] } });
    };

    it("keeps the chip when the document changed but its text did not while the paste was converted", async () => {
        harness.mustSignIn = false;

        renderComposer();

        const instance = editorWith([chip, { content: [{ text: "hi", type: "text" }], type: "paragraph" }]);

        pasteFormatted();
        // Typed and deleted meanwhile: the same text in a new document.
        instance.commands.insertContentAt(instance.state.doc.content.size - 1, "x");
        instance.commands.deleteRange({ from: instance.state.doc.content.size - 2, to: instance.state.doc.content.size - 1 });

        await waitFor(() => {
            expect(instance.getText({ blockSeparator: "\n" })).toBe("> quoted\n\nhi\n**bold** text");
        });
        expect(instance.state.doc.firstChild?.type.name).toBe("quoteChip");
    });

    it("keeps a chip that ends the draft when the document changed while the paste was converted", async () => {
        harness.mustSignIn = false;

        renderComposer();

        const instance = editorWith([chip], false);

        pasteFormatted();
        // The chip put back meanwhile: the same text in a new document.
        instance.view.dispatch(instance.state.tr.replaceWith(0, instance.state.doc.content.size, instance.schema.nodeFromJSON(chip)));

        await waitFor(() => {
            expect(instance.state.doc.lastChild?.textContent).toBe("**bold** text");
        });
        expect(instance.state.doc.firstChild?.type.name).toBe("quoteChip");
        expect(instance.state.doc.childCount).toBe(2);
    });
});

describe("ComposerInput while the connection is down", () => {
    beforeEach(() => {
        harness.mustSignIn = false;
        useChatUIStore.getState().setComposerText("a follow-up");
    });

    afterEach(() => {
        harness.isStreaming = false;
        harness.threadId = undefined;
        harness.view = "online";
        usePromptQueueStore.setState({ queues: {} });
        useChatUIStore.getState().clearComposer();
        useChatUIStore.getState().setIsSubmitting(false);
        vi.clearAllMocks();
    });

    it("keeps the draft when the browser is offline", () => {
        harness.view = "offline";
        renderComposer();
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));

        expect(harness.sendMessage).not.toHaveBeenCalled();
        expect(useChatUIStore.getState().composerText).toBe("a follow-up");
    });

    it("sends while only the live socket reconnects: messages go over HTTP", () => {
        harness.view = "reconnecting";
        renderComposer();
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));

        expect(harness.sendMessage).toHaveBeenCalledWith("a follow-up", [], { draftFrom: undefined });
    });

    it("queues a follow-up while another send in the thread has begun, and does not send it beside that one", () => {
        harness.threadId = "thread-1";
        markSendStarting("thread-1");

        try {
            renderComposer();
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));
        } finally {
            clearSendStarting("thread-1");
        }

        expect(harness.sendMessage).not.toHaveBeenCalled();
        expect(usePromptQueueStore.getState().queues["thread-1"]?.items.map((item: QueuedChatPrompt) => item.text)).toStrictEqual(["a follow-up"]);
    });

    it("queues a follow-up offline while a reply streams", () => {
        harness.view = "offline";
        harness.isStreaming = true;
        harness.threadId = "thread-1";
        renderComposer();
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));

        expect(harness.sendMessage).not.toHaveBeenCalled();
        expect(usePromptQueueStore.getState().queues["thread-1"]?.items.map((item: QueuedChatPrompt) => item.text)).toStrictEqual(["a follow-up"]);
    });
});

describe("ComposerInput fix prompts from the pull request chip", () => {
    beforeEach(() => {
        harness.mustSignIn = false;
        harness.threadId = "thread-1";
        // The thread's stored draft is back: the composer takes prompts from then on.
        setDraftBound("thread-1", true);
        useChatUIStore.getState().setComposerText("");
    });

    afterEach(() => {
        useChatUIStore.getState().clearComposer();
        harness.threadId = undefined;
        vi.clearAllMocks();
    });

    it("puts a prompt for its thread into the thread composer, not sent", () => {
        renderComposer();
        act(() => {
            prefillComposer("thread-1", "Fix checks on octo/hello#7");
        });

        expect(useChatUIStore.getState().composerText).toContain("Fix checks on octo/hello#7");
        expect(harness.sendMessage).not.toHaveBeenCalled();
    });

    it("puts a prompt for its thread into a comparison parent's shared composer, not sent", () => {
        const onSubmitOverride = vi.fn(async () => undefined);

        renderComposer({ onSubmitOverride });
        act(() => {
            prefillComposer("thread-1", "Resolve conflicts with main");
        });

        expect(useChatUIStore.getState().composerText).toContain("Resolve conflicts with main");
        expect(onSubmitOverride).not.toHaveBeenCalled();
    });

    it("leaves a prompt for another thread alone", () => {
        renderComposer({ onSubmitOverride: vi.fn(async () => undefined) });
        act(() => {
            prefillComposer("thread-2", "Address review");
        });

        expect(useChatUIStore.getState().composerText).toBe("");
    });

    it("marks a fix prompt as not typed, since it quotes the host", () => {
        renderComposer();
        act(() => {
            prefillComposer("thread-1", "Fix checks on octo/hello#7");
        });

        expect(useChatUIStore.getState().composerDraftFrom).toBe("suggestion");
    });

    it("keeps a fix prompt that arrived while a comparison send ran, and drops only the sent text", async () => {
        let finish: () => void = () => {};
        const onSubmitOverride = vi.fn(
            async () =>
                await new Promise<undefined>((resolve) => {
                    finish = () => resolve(undefined);
                }),
        );

        useChatUIStore.getState().setComposerText("compare these");
        renderComposer({ onSubmitOverride });
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));

        expect(onSubmitOverride).toHaveBeenCalledWith("compare these", [], undefined);

        act(() => {
            prefillComposer("thread-1", "Resolve conflicts with main");
        });
        await act(async () => {
            finish();
        });

        expect(useChatUIStore.getState().composerText).toBe("Resolve conflicts with main");
    });

    it("drops the sent text and files when the sent text ended in a space and a fix prompt arrived", async () => {
        let finish: () => void = () => {};
        const onSubmitOverride = vi.fn(
            async () =>
                await new Promise<undefined>((resolve) => {
                    finish = () => resolve(undefined);
                }),
        );

        useChatUIStore.getState().setComposerText("compare these ");
        useChatUIStore.setState({
            composerAttachments: [{ file: new File(["x"], "notes.txt"), id: "file-1", name: "notes.txt", status: "complete", type: "document" }],
        });
        renderComposer({ onSubmitOverride });
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));

        expect(onSubmitOverride).toHaveBeenCalledWith("compare these ", expect.any(Array), undefined);

        act(() => {
            prefillComposer("thread-1", "Resolve conflicts with main");
        });
        await act(async () => {
            finish();
        });

        expect(useChatUIStore.getState().composerText).toBe("Resolve conflicts with main");
        expect(useChatUIStore.getState().composerAttachments).toStrictEqual([]);
    });

    it("adds a prompt quoting hidden characters once, also on a second click", () => {
        renderComposer();
        act(() => {
            prefillComposer("thread-1", "Fix checks\u{200B} on octo/hello#7");
        });
        act(() => {
            prefillComposer("thread-1", "Fix checks\u{200B} on octo/hello#7");
        });

        expect(useChatUIStore.getState().composerText).toBe("Fix checks on octo/hello#7");
    });

    it("empties a draft edited while its comparison send ran, so the sent message does not stay to go out twice", async () => {
        let finish: () => void = () => {};
        const onSubmitOverride = vi.fn(
            async () =>
                await new Promise<undefined>((resolve) => {
                    finish = () => resolve(undefined);
                }),
        );

        useChatUIStore.getState().setComposerText("compare these");
        renderComposer({ onSubmitOverride });
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));
        act(() => {
            useChatUIStore.getState().setComposerText("compare those");
        });
        await act(async () => {
            finish();
        });

        expect(useChatUIStore.getState().composerText).toBe("");
    });

    it("keeps a fix prompt that arrived after the draft was edited during its comparison send, and drops the edit", async () => {
        let finish: () => void = () => {};
        const onSubmitOverride = vi.fn(
            async () =>
                await new Promise<undefined>((resolve) => {
                    finish = () => resolve(undefined);
                }),
        );

        useChatUIStore.getState().setComposerText("compare these");
        renderComposer({ onSubmitOverride });
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));
        act(() => {
            useChatUIStore.getState().setComposerText("compare those");
        });
        act(() => {
            prefillComposer("thread-1", "Resolve conflicts with main");
        });
        await act(async () => {
            finish();
        });

        expect(useChatUIStore.getState().composerText).toBe("Resolve conflicts with main");
        expect(useChatUIStore.getState().composerDraftFrom).toBe("suggestion");
    });

    it("still empties the draft after a comparison send when nothing joined it", async () => {
        const onSubmitOverride = vi.fn(async () => undefined);

        useChatUIStore.getState().setComposerText("compare these");
        renderComposer({ onSubmitOverride });
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));

        await waitFor(() => {
            expect(useChatUIStore.getState().composerText).toBe("");
        });
    });
});

describe("ComposerInput and the draft's not-typed mark", () => {
    beforeEach(() => {
        harness.mustSignIn = false;
    });

    afterEach(() => {
        harness.isStreaming = false;
        harness.pending = undefined;
        harness.runner = null;
        harness.sseStreamState = null;
        harness.threadId = undefined;
        usePromptQueueStore.setState({ queues: {} });
        useChatUIStore.getState().clearComposer();
        useChatUIStore.getState().setIsSubmitting(false);
        vi.clearAllMocks();
    });

    it("sends a marked draft with its mark, also once edited", () => {
        useChatUIStore.getState().setComposerText("ok");
        useChatUIStore.getState().setComposerDraftFrom("promptLink");
        useChatUIStore.getState().setComposerText("ok, and book it");
        renderComposer();
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));

        expect(harness.sendMessage).toHaveBeenCalledWith("ok, and book it", [], { draftFrom: "promptLink" });
    });

    it("queues a marked draft with its mark", () => {
        harness.isStreaming = true;
        harness.threadId = "thread-1";
        useChatUIStore.getState().setComposerText("a colleague's prompt");
        useChatUIStore.getState().setComposerDraftFrom("sharedPrompt");
        renderComposer();
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));

        expect(usePromptQueueStore.getState().queues["thread-1"]?.items[0]).toMatchObject({ draftFrom: "sharedPrompt", text: "a colleague's prompt" });
    });

    it("steers the running reply with the draft's mark, an admin's recalled prompt too", async () => {
        harness.isStreaming = true;
        harness.runner = { groups: { turns: { followUp: { kind: "steer" } } } };
        harness.sseStreamState = "stream-1";
        harness.threadId = "thread-1";
        useChatUIStore.getState().setComposerText("and pay the bill");
        useChatUIStore.getState().setComposerDraftFrom("impersonated");
        renderComposer();
        fireEvent.click(screen.getByRole("button", { name: "Steer" }));

        await waitFor(() => {
            expect(harness.mutate).toHaveBeenCalledWith(
                expect.objectContaining({ draftFrom: "impersonated", streamId: "stream-1", text: "and pay the bill" }),
                expect.anything(),
            );
        });
    });

    it("sends a message held through sign-in with the mark its draft had", async () => {
        harness.threadId = "thread-1";
        harness.pending = { draftFrom: "sharedPrompt", text: "a colleague's prompt" };
        renderComposer();

        await waitFor(() => {
            expect(harness.sendMessage).toHaveBeenCalledWith("a colleague's prompt", [], { draftFrom: "sharedPrompt" });
        });
    });

    it("sends text the desktop shell hands over (a share, the Quick Composer) as not typed", async () => {
        renderComposer();
        requestComposerSubmit({ text: "typed in the Quick Composer" });

        await waitFor(() => {
            expect(harness.sendMessage).toHaveBeenCalledWith("typed in the Quick Composer", [], { draftFrom: "shellLink" });
        });
    });

    it("marks the draft a marked restore joins, and an unmarked restore that replaces the draft drops the mark", async () => {
        useChatUIStore.getState().setComposerText("my own words");
        renderComposer();
        requestComposerRestore({ append: true, draftFrom: "shellLink", files: [], text: "from a desktop link" });

        await waitFor(() => {
            expect(useChatUIStore.getState()).toMatchObject({ composerDraftFrom: "shellLink", composerText: "my own words\nfrom a desktop link" });
        });

        requestComposerRestore({ files: [], text: "my earlier message" });

        await waitFor(() => {
            expect(useChatUIStore.getState()).toMatchObject({ composerDraftFrom: undefined, composerText: "my earlier message" });
        });
    });
});
