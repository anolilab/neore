/**
 * A send pressed while an upload runs waits for it. It goes out once every upload completes, with the finished files.
 * A failed upload stops it with a message, and a file removed while waiting cancels it, so an unfinished attachment is
 * never sent.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode, Ref } from "react";
import { useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";

import type { ComposerInputAreaRef } from "./composer-input-area";

const harness = vi.hoisted(() => {
    return {
        sendMessage: vi.fn(async () => undefined),
        isStreaming: false,
        showError: vi.fn(),
        session: { data: { user: { id: "user-1" } } as { user: { id: string } } | null, isPending: false },
        showInfo: vi.fn(),
        upload: vi.fn<(state: { file: File }) => Promise<unknown>>(),
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
            return { isLoading: false, sendComparisonMessage: vi.fn(async () => undefined) };
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

// The input row stands in with its contract: a send control, and whether a send is waiting on uploads.
const InputArea = ({
    isSendWaiting,
    onCancel,
    onSubmit,
    ref,
}: {
    isSendWaiting?: boolean;
    onCancel?: () => void;
    onSubmit: () => void;
    ref?: Ref<ComposerInputAreaRef>;
}) => {
    useImperativeHandle(ref, () => {
        return { blur: () => undefined, focus: () => undefined, getEditor: () => null };
    });

    return (
        <div>
            <output aria-label="Send state">{isSendWaiting ? "waiting" : "ready"}</output>
            <button onClick={onSubmit} type="button">
                Send
            </button>
            <button onClick={onCancel} type="button">
                Stop
            </button>
        </div>
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

// The long-text prompt stands in with its contract: a button that converts the draft to a file.
vi.doMock("./composer-long-text-prompt", () => {
    return {
        default: ({ onConvert }: { onConvert: () => void }) => (
            <button onClick={onConvert} type="button">
                Convert
            </button>
        ),
    };
});

const { default: ComposerInput } = await import("./composer-input");

const renderComposer = (props: { disabled?: boolean } = {}) =>
    render(
        <QueryClientProvider client={new QueryClient()}>
            <ComposerInput {...props} />
        </QueryClientProvider>,
    );

/** A file in the draft at the given upload status, as the composer's upload handler leaves it. */
const addUpload = (status: "error" | "uploading"): string => {
    const { addAttachment, updateAttachment } = useChatUIStore.getState();
    const id = addAttachment(new File(["notes"], "notes.txt", { type: "text/plain" }));

    updateAttachment(id, { error: status === "error" ? "boom" : undefined, status });

    return id;
};

const pressSend = () => {
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
};

const sendState = () => screen.getByLabelText("Send state").textContent;

const editedMessage = "Your message changed while the uploads ran, so it was not sent. Press send to send it.";

describe("ComposerInput send during an upload", () => {
    beforeEach(() => {
        harness.session = { data: { user: { id: "user-1" } }, isPending: false };
        useChatUIStore.getState().setComposerText("see notes");
    });

    afterEach(() => {
        harness.isStreaming = false;
        useChatUIStore.getState().clearComposer();
        useChatUIStore.getState().setIsSubmitting(false);
        vi.clearAllMocks();
    });

    it("waits for the upload instead of sending, and shows the send as pending", () => {
        addUpload("uploading");
        renderComposer();
        pressSend();

        expect(harness.sendMessage).not.toHaveBeenCalled();
        expect(sendState()).toBe("waiting");
        expect(useChatUIStore.getState().composerText).toBe("see notes");
    });

    it("sends once the upload completes, with the finished file", async () => {
        const id = addUpload("uploading");

        renderComposer();
        pressSend();

        useChatUIStore.getState().updateAttachment(id, { fileId: "file-1", progress: 100, status: "complete" });

        await waitFor(() => {
            expect(harness.sendMessage).toHaveBeenCalledWith("see notes", [expect.objectContaining({ fileId: "file-1", id, status: "complete" })]);
        });
        expect(sendState()).toBe("ready");
    });

    it("ends the wait when the finished draft is sent by hand, so no unsent notice follows it", async () => {
        const id = addUpload("uploading");

        renderComposer();
        pressSend();

        act(() => {
            useChatUIStore.getState().updateAttachment(id, { fileId: "file-1", status: "complete" });
            pressSend();
        });

        await waitFor(() => {
            expect(harness.sendMessage).toHaveBeenCalledTimes(1);
        });
        expect(harness.showInfo).not.toHaveBeenCalled();
    });

    it("sends once with the finished file when a placeholder is swapped for the real file while the send waits", async () => {
        const id = addUpload("uploading");

        renderComposer();
        pressSend();

        // A vault file, a restored file or a chat reference starts as an empty placeholder and gets its real file mid-upload.
        useChatUIStore.getState().updateAttachment(id, { file: new File(["real"], "notes.txt") });
        useChatUIStore.getState().updateAttachment(id, { fileId: "file-1", status: "complete" });

        await waitFor(() => {
            expect(harness.sendMessage).toHaveBeenCalledTimes(1);
        });
        expect(harness.sendMessage).toHaveBeenCalledWith("see notes", [expect.objectContaining({ fileId: "file-1", id, status: "complete" })]);
        expect(harness.showInfo).not.toHaveBeenCalled();
    });

    it("says why when the draft grows too large to send while the uploads run, and sends nothing", async () => {
        const id = addUpload("uploading");

        renderComposer();
        pressSend();

        useChatUIStore.getState().updateAttachment(id, { file: new File(["x".repeat(400_001)], "notes.txt", { type: "text/plain" }) });
        useChatUIStore.getState().updateAttachment(id, { fileId: "file-1", status: "complete" });

        await waitFor(() => {
            expect(harness.showError).toHaveBeenCalledWith(expect.stringContaining("too large"));
        });
        expect(harness.sendMessage).not.toHaveBeenCalled();
        expect(sendState()).toBe("ready");
    });

    it("sends nothing once Stop is pressed while the send waits for the uploads", async () => {
        harness.isStreaming = true;

        const id = addUpload("uploading");

        renderComposer();
        pressSend();
        fireEvent.click(screen.getByRole("button", { name: "Stop" }));

        expect(sendState()).toBe("ready");

        harness.isStreaming = false;
        useChatUIStore.getState().updateAttachment(id, { fileId: "file-1", status: "complete" });

        await waitFor(() => {
            expect(useChatUIStore.getState().composerAttachments[0]?.status).toBe("complete");
        });
        expect(harness.sendMessage).not.toHaveBeenCalled();
    });

    it("does not send a guest's waiting draft as the account the guest signs into", async () => {
        harness.session = { data: null, isPending: false };

        const id = addUpload("uploading");
        const view = renderComposer();

        pressSend();

        harness.session = { data: { user: { id: "user-2" } }, isPending: false };
        view.rerender(
            <QueryClientProvider client={new QueryClient()}>
                <ComposerInput />
            </QueryClientProvider>,
        );
        useChatUIStore.getState().updateAttachment(id, { fileId: "file-1", status: "complete" });

        await waitFor(() => {
            expect(sendState()).toBe("ready");
        });
        expect(harness.sendMessage).not.toHaveBeenCalled();
    });

    it("sends a converted text once as its file, without the text, when send is pressed while it uploads", async () => {
        let finish = (): void => {};

        harness.upload.mockImplementation(
            async ({ file }) =>
                await new Promise((resolve) => {
                    finish = () => resolve({ file, metadata: { fileId: "file-text" }, name: file.name });
                }),
        );

        renderComposer();
        fireEvent.click(screen.getByRole("button", { name: "Convert" }));
        pressSend();

        act(() => {
            finish();
        });

        await waitFor(() => {
            expect(harness.sendMessage).toHaveBeenCalledTimes(1);
        });
        expect(harness.sendMessage).toHaveBeenCalledWith("", [expect.objectContaining({ fileId: "file-text", status: "complete" })]);
        expect(harness.showInfo).not.toHaveBeenCalled();
    });

    it("sends only once, however often send is pressed while waiting", async () => {
        const id = addUpload("uploading");

        renderComposer();
        pressSend();
        pressSend();

        useChatUIStore.getState().updateAttachment(id, { fileId: "file-1", status: "complete" });

        await waitFor(() => {
            expect(harness.sendMessage).toHaveBeenCalledTimes(1);
        });
    });

    it("does not send when an upload fails, and says so", async () => {
        const id = addUpload("uploading");

        renderComposer();
        pressSend();

        useChatUIStore.getState().updateAttachment(id, { error: "boom", status: "error" });

        await waitFor(() => {
            expect(harness.showError).toHaveBeenCalledWith('"notes.txt" could not be uploaded, so the message was not sent.');
        });
        expect(harness.sendMessage).not.toHaveBeenCalled();
        expect(sendState()).toBe("ready");
    });

    it("sends the text once the failed file is removed and send is pressed again", () => {
        const id = addUpload("error");

        renderComposer();
        pressSend();

        expect(harness.showError).toHaveBeenCalledWith('"notes.txt" could not be uploaded, so the message was not sent.');
        expect(harness.sendMessage).not.toHaveBeenCalled();

        useChatUIStore.getState().removeAttachment(id);
        pressSend();

        expect(harness.sendMessage).toHaveBeenCalledWith("see notes", []);
    });

    it("ends the wait, sends nothing and says so when a file still uploading is removed", async () => {
        const id = addUpload("uploading");

        renderComposer();
        pressSend();

        useChatUIStore.getState().removeAttachment(id);

        await waitFor(() => {
            expect(sendState()).toBe("ready");
        });
        expect(harness.showInfo).toHaveBeenCalledWith(editedMessage);
        expect(harness.sendMessage).not.toHaveBeenCalled();
        expect(useChatUIStore.getState().composerText).toBe("see notes");
    });

    it("sends nothing when the text is edited while the uploads run, and says so", async () => {
        const id = addUpload("uploading");

        renderComposer();
        pressSend();

        useChatUIStore.getState().setComposerText("see notes, and the other one");
        useChatUIStore.getState().updateAttachment(id, { fileId: "file-1", status: "complete" });

        await waitFor(() => {
            expect(harness.showInfo).toHaveBeenCalledWith(editedMessage);
        });
        expect(harness.sendMessage).not.toHaveBeenCalled();
        expect(sendState()).toBe("ready");
        expect(useChatUIStore.getState().composerText).toBe("see notes, and the other one");
    });

    it("says so and keeps the draft when the uploads finish while a reply streams and there is no queue", async () => {
        harness.isStreaming = true;

        const id = addUpload("uploading");

        renderComposer();
        pressSend();

        useChatUIStore.getState().updateAttachment(id, { fileId: "file-1", status: "complete" });

        await waitFor(() => {
            expect(harness.showInfo).toHaveBeenCalledWith("The uploads finished, but the message was not sent. Press send to send it.");
        });
        expect(harness.sendMessage).not.toHaveBeenCalled();
        expect(useChatUIStore.getState().composerText).toBe("see notes");
    });

    it("says so and keeps the draft when the uploads finish while the composer is locked", async () => {
        const id = addUpload("uploading");
        const view = renderComposer();

        pressSend();

        view.rerender(
            <QueryClientProvider client={new QueryClient()}>
                <ComposerInput disabled />
            </QueryClientProvider>,
        );
        useChatUIStore.getState().updateAttachment(id, { fileId: "file-1", status: "complete" });

        await waitFor(() => {
            expect(harness.showInfo).toHaveBeenCalledWith("The uploads finished, but the message was not sent. Press send to send it.");
        });
        expect(harness.sendMessage).not.toHaveBeenCalled();
        expect(sendState()).toBe("ready");
        expect(useChatUIStore.getState().composerText).toBe("see notes");
    });
});
