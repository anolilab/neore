// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePromptQueueStore } from "@/features/chat/core/stores/prompt-queue-store";

import ComposerPromptQueue from "./composer-prompt-queue";

// The pointer sensor needs layout to pick a drop target, which jsdom has none of. The drop itself is the component's
// `onDragEnd`, so the mock keeps the real `DndContext` and records the handler it is given, to call with a drop.
const drag = vi.hoisted(() => {
    return { onDragEnd: undefined as undefined | ((event: { active: { id: string }; over: { id: string } | null }) => void) };
});

vi.mock("@dnd-kit/core", async (importOriginal) => {
    const original = await importOriginal<typeof import("@dnd-kit/core")>();

    return {
        ...original,
        DndContext: (props: Parameters<typeof original.DndContext>[0]) => {
            const { onDragEnd } = props;

            drag.onDragEnd = onDragEnd as typeof drag.onDragEnd;

            return <original.DndContext {...props} />;
        },
    };
});

const chat = vi.hoisted(() => {
    return {
        error: undefined as Error | undefined,
        isStreaming: false,
        // A mode save as the query cache sees it now; `saving` is the flag the last render read.
        liveSaving: false,
        saving: false,
        sendMessage: vi.fn(),
        threadId: "thread-1",
        view: "online" as "offline" | "online" | "reconnecting",
    };
});
const withdrawSteer = vi.hoisted(() => vi.fn());
const MOVED_TO = /Moved to position/u;
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
vi.mock("@/features/connection/hooks/use-connection", () => {
    return { useConnectionView: () => chat.view };
});
const toast = vi.hoisted(() => {
    return { showError: vi.fn(), showInfo: vi.fn() };
});

vi.mock("@/lib/toast", () => toast);
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

const nextFrame = async () => {
    await act(async () => {
        await new Promise<void>((resolve) => {
            globalThis.requestAnimationFrame(() => {
                resolve();
            });
        });
    });
};

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
        chat.liveSaving = false;
        chat.saving = false;
        chat.sendMessage.mockReset();
        chat.view = "online";
        withdrawSteer.mockReset();
        toast.showInfo.mockReset();
        usePromptQueueStore.setState({ offlineHolds: {}, queues: {} });
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

    it("holds a queued prompt while the browser is offline, and sends it once the network is back", async () => {
        chat.error = undefined;
        chat.isStreaming = true;
        chat.view = "offline";
        usePromptQueueStore.getState().enqueue(chat.threadId, { attachments: [], text: "queued" });

        const view = render(<ComposerPromptQueue />);

        chat.isStreaming = false;
        view.rerender(<ComposerPromptQueue />);
        await act(async () => {
            await Promise.resolve();
        });
        expect(chat.sendMessage).not.toHaveBeenCalled();

        // Only the live socket is down: messages go over HTTP, so the held prompt goes.
        chat.view = "reconnecting";
        view.rerender(<ComposerPromptQueue />);

        await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith("queued", []));
    });

    it("sends a Send next clicked offline once the network is back, though a steer withdrawal still held the queue then", async () => {
        chat.error = undefined;

        let finish: (value: { outcome: "withdrawn" }) => void = () => {};

        // The lib target has no `Promise.withResolvers` yet.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        const promise = new Promise<{ outcome: "withdrawn" }>((resolve) => {
            finish = resolve;
        });

        withdrawSteer.mockReturnValue(promise);

        const view = render(<ComposerPromptQueue />);

        await act(async () => {
            const { enqueue } = usePromptQueueStore.getState();

            enqueue(chat.threadId, { attachments: [], steer: { id: "steer-1", streamId: "stream-1" }, text: "steered" });
            enqueue(chat.threadId, { attachments: [], text: "queued" });
        });
        expect(withdrawSteer).toHaveBeenCalledTimes(1);

        chat.view = "offline";
        view.rerender(<ComposerPromptQueue />);
        fireEvent.click(screen.getByRole("button", { name: "Send next" }));
        expect(toast.showInfo).toHaveBeenCalledWith(expect.stringContaining("You are offline"), { id: "composer-offline-send" });

        // Back online while the withdrawal still holds the queue: the held send waits for it, it is not dropped.
        chat.view = "online";
        view.rerender(<ComposerPromptQueue />);

        await act(async () => {
            finish({ outcome: "withdrawn" });
        });

        // The withdrawn steer goes; the held Send next waits for its reply, so two turns never run at once.
        await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
        expect(chat.sendMessage).toHaveBeenLastCalledWith("steered", []);

        chat.isStreaming = true;
        view.rerender(<ComposerPromptQueue />);
        expect(chat.sendMessage).toHaveBeenCalledTimes(1);

        chat.isStreaming = false;
        view.rerender(<ComposerPromptQueue />);

        await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(2));
        expect(chat.sendMessage).toHaveBeenLastCalledWith("queued", []);
    });

    it("keeps a prompt when the network goes during its steer withdrawal, and sends it once it is back", async () => {
        chat.error = undefined;

        let finish: (value: { outcome: "withdrawn" }) => void = () => {};

        // The lib target has no `Promise.withResolvers` yet.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        const promise = new Promise<{ outcome: "withdrawn" }>((resolve) => {
            finish = resolve;
        });

        withdrawSteer.mockReturnValue(promise);

        const view = render(<ComposerPromptQueue />);

        await act(async () => {
            usePromptQueueStore.getState().enqueue(chat.threadId, { attachments: [], steer: { id: "steer-1", streamId: "stream-1" }, text: "steered" });
        });

        chat.view = "offline";
        view.rerender(<ComposerPromptQueue />);

        await act(async () => {
            finish({ outcome: "withdrawn" });
        });

        expect(chat.sendMessage).not.toHaveBeenCalled();
        expect(usePromptQueueStore.getState().queues[chat.threadId]?.items.map((item) => item.text)).toStrictEqual(["steered"]);

        chat.view = "online";
        view.rerender(<ComposerPromptQueue />);

        await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith("steered", []));
    });

    it("keeps a Send next asked for offline while a reply streams on reconnect, and sends it when that reply ends, even in an error", async () => {
        chat.error = undefined;
        chat.view = "offline";
        usePromptQueueStore.getState().enqueue(chat.threadId, { attachments: [], text: "queued" });

        const view = render(<ComposerPromptQueue />);

        fireEvent.click(screen.getByRole("button", { name: "Send next" }));

        // A reply is streaming when the network comes back: the request is kept for its end, not dropped.
        chat.isStreaming = true;
        view.rerender(<ComposerPromptQueue />);
        chat.view = "online";
        view.rerender(<ComposerPromptQueue />);
        await act(async () => {
            await Promise.resolve();
        });
        expect(chat.sendMessage).not.toHaveBeenCalled();

        chat.error = new Error("the reply failed");
        chat.isStreaming = false;
        view.rerender(<ComposerPromptQueue />);

        await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith("queued", []));
    });

    it("sends a prompt held offline when its thread's composer mounts again online", async () => {
        chat.error = undefined;
        chat.view = "offline";
        usePromptQueueStore.getState().enqueue(chat.threadId, { attachments: [], text: "queued" });

        const view = render(<ComposerPromptQueue />);

        fireEvent.click(screen.getByRole("button", { name: "Send next" }));
        view.unmount();
        expect(chat.sendMessage).not.toHaveBeenCalled();

        chat.view = "online";
        render(<ComposerPromptQueue />);

        await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith("queued", []));
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

    it("does not repeat a move's announcement in a later queue of the same thread", async () => {
        const { enqueue, remove, setPaused } = usePromptQueueStore.getState();

        for (const text of ["one", "two"]) {
            enqueue(chat.threadId, { attachments: [], text });
        }

        setPaused(chat.threadId, true);
        render(<ComposerPromptQueue />);
        fireEvent.click(screen.getByLabelText("Move queued message 2 up"));
        await nextFrame();
        expect(screen.getByText("Moved to position 1")).toBeTruthy();

        // The queue empties, then a new message arrives in the same thread: the old move is not read out again.
        const queued = usePromptQueueStore.getState().queues[chat.threadId]?.items ?? [];

        for (const item of queued) {
            remove(chat.threadId, item.id);
        }

        await nextFrame();
        enqueue(chat.threadId, { attachments: [], text: "three" });

        expect(screen.queryByText("Moved to position 1")).toBeNull();
    });

    it("does not read a move's announcement again when the person returns to its thread", async () => {
        const { enqueue, setPaused } = usePromptQueueStore.getState();

        for (const threadId of ["thread-1", "thread-2"]) {
            for (const text of ["one", "two"]) {
                enqueue(threadId, { attachments: [], text });
            }

            setPaused(threadId, true);
        }

        const { rerender } = render(<ComposerPromptQueue />);

        fireEvent.click(screen.getByLabelText("Move queued message 2 up"));
        await nextFrame();
        expect(screen.getByText("Moved to position 1")).toBeTruthy();

        // Another thread with its own queue is shown, then the first thread again: the old move is not read out again.
        chat.threadId = "thread-2";
        rerender(<ComposerPromptQueue />);
        chat.threadId = "thread-1";
        rerender(<ComposerPromptQueue />);

        expect(screen.queryByText("Moved to position 1")).toBeNull();
    });

    it("keeps keyboard focus on the moved message's button, so the next move needs no mouse", () => {
        const { enqueue, setPaused } = usePromptQueueStore.getState();

        for (const text of ["one", "two", "three"]) {
            enqueue(chat.threadId, { attachments: [], text });
        }

        setPaused(chat.threadId, true);
        render(<ComposerPromptQueue />);

        // Focus, then activate it as a keyboard user would: the chip moves in the DOM, and focus must follow it.
        const up = screen.getByLabelText("Move queued message 3 up");

        act(() => up.focus());
        fireEvent.click(up);

        // Focus has no Testing Library query: the active element is the only way to read where focus landed.
        // eslint-disable-next-line testing-library/no-node-access
        expect(document.activeElement).toBe(screen.getByLabelText("Move queued message 2 up"));
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

    it("moves a dropped message to where it lands in the queue", async () => {
        const { enqueue, setPaused } = usePromptQueueStore.getState();

        for (const text of ["one", "two", "three"]) {
            enqueue(chat.threadId, { attachments: [], text });
        }

        setPaused(chat.threadId, true);
        render(<ComposerPromptQueue />);
        const [one, , three] = usePromptQueueStore.getState().queues[chat.threadId]?.items ?? [];

        act(() => {
            drag.onDragEnd?.({ active: { id: three!.id }, over: { id: one!.id } });
        });

        await nextFrame();

        expect((usePromptQueueStore.getState().queues[chat.threadId]?.items ?? []).map((item) => item.text)).toStrictEqual(["three", "one", "two"]);
        expect(screen.getByText("Moved to position 1")).toBeTruthy();
    });

    it("refuses a drop across a pending steer, and announces no move for it", () => {
        const { enqueue, setPaused } = usePromptQueueStore.getState();

        enqueue(chat.threadId, { attachments: [], text: "one" });
        enqueue(chat.threadId, { attachments: [], steer: { id: "steer-1", streamId: "stream-1" }, text: "steered" });
        enqueue(chat.threadId, { attachments: [], text: "two" });
        setPaused(chat.threadId, true);
        render(<ComposerPromptQueue />);
        const [one, , two] = usePromptQueueStore.getState().queues[chat.threadId]?.items ?? [];

        act(() => {
            drag.onDragEnd?.({ active: { id: two!.id }, over: { id: one!.id } });
        });

        expect((usePromptQueueStore.getState().queues[chat.threadId]?.items ?? []).map((item) => item.text)).toStrictEqual(["one", "steered", "two"]);
        expect(screen.queryByText(MOVED_TO)).toBeNull();
    });

    it("says why Send next is unavailable while the mode saves, and sends the queue once it has", async () => {
        chat.error = undefined;
        usePromptQueueStore.getState().enqueue(chat.threadId, { attachments: [], text: "queued" });

        const view = render(<ComposerPromptQueue />);
        const status = () => screen.getAllByRole("status")[0]!;
        const sendNext = () => screen.getByRole("button", { name: "Send next" }) as HTMLButtonElement;

        expect(status().textContent).toBe("1 queued");
        expect(sendNext().disabled).toBe(false);

        chat.saving = true;
        view.rerender(<ComposerPromptQueue />);

        expect(status().textContent).toBe("1 queued — waiting for the permission mode to save");
        expect(sendNext().disabled).toBe(true);

        chat.saving = false;
        view.rerender(<ComposerPromptQueue />);

        // The queue moves on once the save has ended, which is what the waiting text promised.
        await vi.waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith("queued", []));
    });

    it("does not promise a send after the save when the queue is held", () => {
        usePromptQueueStore.getState().enqueue(chat.threadId, { attachments: [], text: "queued" });
        usePromptQueueStore.getState().setPaused(chat.threadId, true);
        chat.saving = true;

        render(<ComposerPromptQueue />);

        expect(screen.getAllByRole("status")[0]?.textContent).toBe("1 queued");
    });
});
