// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePromptQueueStore } from "@/features/chat/core/stores/prompt-queue-store";

import ComposerPromptQueue from "./composer-prompt-queue";

const chat = vi.hoisted(() => {
    return {
        error: undefined as Error | undefined,
        isStreaming: false,
        // A mode save as the query cache sees it now; `saving` is the flag the last render read.
        liveSaving: false,
        saving: false,
        sendMessage: vi.fn(),
        threadId: "thread-1",
    };
});
const withdrawSteer = vi.hoisted(() => vi.fn());
const queryClient = vi.hoisted(() => {
    return { isMutating: () => (chat.saving || chat.liveSaving ? 1 : 0) };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Plural: () => null,
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});
vi.mock("@tanstack/react-query", () => {
    return {
        skipToken: Symbol("skipToken"),
        useIsMutating: () => (chat.saving ? 1 : 0),
        useMutation: () => {
            return { mutateAsync: withdrawSteer };
        },
        useQuery: () => {
            return { data: undefined };
        },
        useQueryClient: () => queryClient,
    };
});
vi.mock("@/lib/lunora/crpc", () => {
    const options = () => {
        return {
            mutationOptions: () => {
                return {};
            },
            queryOptions: () => {
                return {};
            },
        };
    };

    return {
        useCRPC: () => {
            return { chat: { steering: { withdrawSteer: options() }, streaming: { getActiveStreamForThread: options() } } };
        },
    };
});
vi.mock("@/lib/toast", () => {
    return { showError: vi.fn() };
});
vi.mock("@/features/chat/core/context/chat-context", () => {
    return {
        useChatActions: () => {
            return { sendMessage: chat.sendMessage };
        },
        useChatError: () => {
            return { error: chat.error };
        },
        useChatIsStreaming: () => {
            return { isStreaming: chat.isStreaming };
        },
        useChatThread: () => {
            return { threadId: chat.threadId };
        },
    };
});

describe("composer prompt queue", () => {
    beforeEach(() => {
        chat.error = new Error("the reply failed");
        chat.isStreaming = false;
        chat.liveSaving = false;
        chat.saving = false;
        chat.sendMessage.mockReset();
        withdrawSteer.mockReset();
        usePromptQueueStore.setState({ queues: {} });
        // Marks the thread as hydrated, so the (empty) stored queue is not read over ours.
        usePromptQueueStore.getState().hydrate(chat.threadId);
    });

    it("holds a queued prompt while the thread's mode is saving, and sends it once the save has ended", async () => {
        chat.error = undefined;
        chat.saving = true;
        usePromptQueueStore.getState().enqueue(chat.threadId, { attachments: [], text: "queued" });

        const view = render(<ComposerPromptQueue />);

        // A prompt the queue would send now must wait: it would run under the mode being replaced.
        await act(async () => {
            await Promise.resolve();
        });
        expect(chat.sendMessage).not.toHaveBeenCalled();

        chat.saving = false;
        view.rerender(<ComposerPromptQueue />);

        await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    });

    it("holds a prompt when a mode save begins after the last render, while a steer withdrawal settles", async () => {
        chat.error = undefined;

        let finish: (value: { outcome: "withdrawn" }) => void = () => {};

        // The lib target has no `Promise.withResolvers` yet.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        const promise = new Promise<{ outcome: "withdrawn" }>((resolve) => {
            finish = resolve;
        });

        withdrawSteer.mockReturnValue(promise);

        const view = render(<ComposerPromptQueue />);

        // Enqueued after mount, so the queue sends it: the steer's withdrawal is the await the save races.
        await act(async () => {
            usePromptQueueStore.getState().enqueue(chat.threadId, { attachments: [], steer: { id: "steer-1", streamId: "stream-1" }, text: "steered" });
        });
        expect(withdrawSteer).toHaveBeenCalledTimes(1);

        // The save starts, but no render has seen it yet: the rendered flag still reads idle.
        chat.liveSaving = true;

        await act(async () => {
            finish({ outcome: "withdrawn" });
        });

        expect(chat.sendMessage).not.toHaveBeenCalled();

        // The save ends: the held prompt goes out, the steered one first.
        chat.liveSaving = false;
        chat.saving = true;
        view.rerender(<ComposerPromptQueue />);
        chat.saving = false;
        view.rerender(<ComposerPromptQueue />);

        await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith("steered", []));
    });

    it("sends on Send next clicked while a chip removal settles, though the reply ended in an error", async () => {
        let finish: (value: { outcome: "withdrawn" }) => void = () => {};

        // The lib target has no `Promise.withResolvers` yet.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        const promise = new Promise<{ outcome: "withdrawn" }>((resolve) => {
            finish = resolve;
        });

        withdrawSteer.mockReturnValue(promise);

        const { enqueue, setPaused } = usePromptQueueStore.getState();

        enqueue(chat.threadId, { attachments: [], steer: { id: "steer-1", streamId: "stream-1" }, text: "steered" });
        enqueue(chat.threadId, { attachments: [], text: "queued" });
        setPaused(chat.threadId, true);

        render(<ComposerPromptQueue />);

        fireEvent.click(screen.getByLabelText("Remove queued message 1"));
        fireEvent.click(screen.getByRole("button", { name: "Send next" }));
        expect(chat.sendMessage).not.toHaveBeenCalled();

        await act(async () => {
            finish({ outcome: "withdrawn" });
        });

        expect(chat.sendMessage).toHaveBeenCalledTimes(1);
        expect(chat.sendMessage).toHaveBeenCalledWith("queued", []);
    });
});
