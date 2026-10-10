/**
 * Render-count harness for the message list: how many rows re-render when a
 * live update touches one message of a long thread. Rows are counted through a
 * stub `MessageContent`, which every `MessageItem` render renders once.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import type { Context, ReactNode } from "react";
import { createElement, useLayoutEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UIMessage } from "@/lib/agent";
import { shareUnchangedMessages } from "@/lib/agent/share-unchanged-messages";

const harness = vi.hoisted(() => {
    return {
        actions: {} as Record<string, unknown>,
        ActionsContext: undefined as Context<Record<string, unknown>> | undefined,
        contentRenders: new Map<string, number>(),
        messages: [] as unknown[],
        MessagesContext: undefined as Context<unknown[]> | undefined,
        publish: undefined as (() => void) | undefined,
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: unknown }) => children,
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/features/chat/core/context/chat-context", async () => {
    const { createContext, use } = await import("react");

    // Two separate contexts, like ChatProvider's split messages/actions contexts.
    harness.MessagesContext = createContext<unknown[]>([]);
    harness.ActionsContext = createContext<Record<string, unknown>>({});

    return {
        useChatActions: () => use(harness.ActionsContext!),
        useChatIsStreaming: () => {
            return { activeStreamId: null, gatewayUrl: null, isStreaming: false, streamToken: null };
        },
        useChatMessages: () => {
            return { isStreaming: false, loadMore: () => {}, messages: use(harness.MessagesContext!), messagesReady: true, messagesStatus: "Exhausted" };
        },
        useChatThread: () => {
            return { isNewThread: false, model: "test-model", thread: undefined, threadId: "thread-1" };
        },
    };
});

vi.mock("./message-content", () => {
    return {
        default: ({ message }: { message: UIMessage }) => {
            harness.contentRenders.set(message.id, (harness.contentRenders.get(message.id) ?? 0) + 1);

            return createElement("div", null, message.text);
        },
    };
});

vi.mock("./streaming-placeholder", () => {
    return { StreamingPlaceholder: () => null, ThinkingPlaceholder: () => null };
});

vi.mock("@/features/chat/core/hooks/use-thread-manager", () => {
    return {
        useThreadManager: () => {
            return { createBranch: async () => undefined };
        },
    };
});

vi.mock("@/hooks/use-feature-flagged-models", () => {
    return { default: () => [] };
});

vi.mock("@/lib/lunora/crpc", () => {
    const leaf = {
        mutationOptions: () => {
            return { mutationFn: async () => undefined };
        },
    };
    // Any depth of namespace (`crpc.a.b.fn`) ends at `leaf`.
    const namespace: object = new Proxy({}, { get: (_target, key) => (Object.hasOwn(leaf, key) ? leaf[key as keyof typeof leaf] : namespace) });

    return { useCRPC: () => namespace };
});

vi.mock("@/features/evals/components/save-eval-case-action", () => {
    return { default: () => null };
});

vi.mock("./generation-model-menu", () => {
    return { default: () => null };
});

vi.mock("./read-aloud-action", () => {
    return { default: () => null };
});

vi.mock("./restore-to-input-action", () => {
    return { default: () => null };
});

vi.mock("./memory-usage-action", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/translation/message-translation", () => {
    return { default: () => null };
});

vi.mock("@/features/chat/translation/translate-action", () => {
    return { default: () => null };
});

vi.mock("./fork-branch-dialog", () => {
    return { default: () => null };
});

// Imported after the mocks.
const { default: MessageList } = await import("./message-list");

const THREAD_LENGTH = 200;

const makeMessage = (index: number, text = `message ${index}`): UIMessage => {
    const role = index % 2 === 0 ? "user" : "assistant";

    return {
        _creationTime: 1_700_000_000_000 + index,
        id: `m${index}`,
        key: `m${index}`,
        order: Math.floor(index / 2),
        parts: [{ text, type: "text" }],
        role,
        status: "success",
        stepOrder: role === "user" ? 0 : 1,
        text,
    } as UIMessage;
};

/** What a live query push looks like: a freshly decoded copy of the whole page. */
const decodeFresh = (messages: UIMessage[]): UIMessage[] => structuredClone(messages);

const Host = (): ReactNode => {
    const [value, setValue] = useState({ actions: harness.actions, messages: harness.messages });
    const ActionsContext = harness.ActionsContext!;
    const MessagesContext = harness.MessagesContext!;

    useLayoutEffect(() => {
        harness.publish = () => setValue({ actions: harness.actions, messages: harness.messages });
    }, []);

    return (
        <MessagesContext value={value.messages}>
            <ActionsContext value={value.actions}>
                <MessageList />
            </ActionsContext>
        </MessagesContext>
    );
};

const mount = () => {
    const queryClient = new QueryClient();

    render(
        <QueryClientProvider client={queryClient}>
            <Host />
        </QueryClientProvider>,
    );
};

/** Pushes a live update whose only change is the last message's text; returns the rows it re-rendered. */
const pushLastMessageEdit = (share: boolean, freshActions: boolean): number => {
    const previous = harness.messages as UIMessage[];
    const decoded = decodeFresh(previous);
    const lastIndex = decoded.length - 1;

    decoded[lastIndex] = makeMessage(lastIndex, `${previous[lastIndex]!.text} more`);

    harness.messages = share ? shareUnchangedMessages(previous, decoded) : decoded;

    if (freshActions) {
        harness.actions = { ...harness.actions };
    }

    harness.contentRenders.clear();
    act(() => harness.publish?.());

    let renders = 0;

    for (const count of harness.contentRenders.values()) {
        renders += count;
    }

    return renders;
};

describe("message list render cost", () => {
    beforeEach(() => {
        harness.messages = Array.from({ length: THREAD_LENGTH }, (_, index) => makeMessage(index));
        harness.actions = { copyMessage: () => {}, reloadMessage: () => {} };
        harness.contentRenders.clear();
    });

    it("re-renders every row when a push decodes fresh objects and the actions context changes (the old behaviour)", () => {
        mount();

        expect(pushLastMessageEdit(false, true)).toBeGreaterThanOrEqual(THREAD_LENGTH);
    });

    it("re-renders only the changed row once unchanged messages keep their identity and the actions context is stable", () => {
        mount();

        expect(pushLastMessageEdit(true, false)).toBe(1);
        expect(harness.contentRenders.get(`m${THREAD_LENGTH - 1}`)).toBe(1);
    });

    it("still re-renders every row when only the actions context changes", () => {
        mount();

        // Why chat-context reads `messages` through a ref in its action callbacks:
        // a new actions object alone re-renders all rows.
        expect(pushLastMessageEdit(true, true)).toBeGreaterThanOrEqual(THREAD_LENGTH);
    });
});
