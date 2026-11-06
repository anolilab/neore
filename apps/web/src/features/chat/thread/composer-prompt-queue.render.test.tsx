// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePromptQueueStore } from "@/features/chat/core/stores/prompt-queue-store";

import ComposerPromptQueue from "./composer-prompt-queue";

const chat = vi.hoisted(() => {
    return { error: undefined as Error | undefined, isStreaming: false, sendMessage: vi.fn(), threadId: "thread-1" };
});
const withdrawSteer = vi.hoisted(() => vi.fn());

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
        useMutation: () => {
            return { mutateAsync: withdrawSteer };
        },
        useQuery: () => {
            return { data: undefined };
        },
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
        // jsdom has none, and the drag-and-drop context observes sizes with it.
        vi.stubGlobal(
            "ResizeObserver",
            // A constructor mock must be a `function`, not an arrow.
            // eslint-disable-next-line prefer-arrow-callback
            vi.fn(function ResizeObserverStub() {
                return { disconnect: vi.fn(), observe: vi.fn(), unobserve: vi.fn() };
            }),
        );
        chat.error = new Error("the reply failed");
        chat.isStreaming = false;
        chat.sendMessage.mockReset();
        withdrawSteer.mockReset();
        usePromptQueueStore.setState({ queues: {} });
        // Marks the thread as hydrated, so the (empty) stored queue is not read over ours.
        usePromptQueueStore.getState().hydrate(chat.threadId);
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

    it("moves a queued message up and down with its buttons, and sends the moved one first", async () => {
        const { enqueue, setPaused } = usePromptQueueStore.getState();

        for (const text of ["one", "two", "three"]) {
            enqueue(chat.threadId, { attachments: [], text });
        }

        setPaused(chat.threadId, true);
        render(<ComposerPromptQueue />);

        expect((screen.getByLabelText("Move queued message 1 up") as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByLabelText("Move queued message 3 down") as HTMLButtonElement).disabled).toBe(true);

        fireEvent.click(screen.getByLabelText("Move queued message 3 up"));
        fireEvent.click(screen.getByLabelText("Move queued message 2 up"));

        const order = () => usePromptQueueStore.getState().queues[chat.threadId]?.items.map((item) => item.text);

        expect(order()).toEqual(["three", "one", "two"]);

        fireEvent.click(screen.getByRole("button", { name: "Send next" }));
        await vi.waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith("three", []));
    });
});
