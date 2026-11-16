/**
 * The composer and every message's action bar read narrow slices of the chat contexts. A streamed batch (a new
 * messages array) and a write to the thread record must not re-render them.
 */
import { render } from "@testing-library/react";
import type { FC } from "react";
import { describe, expect, it } from "vitest";

import type { UIMessage } from "@/lib/agent";

import { useChatIsEmpty, useChatThreadIdentity } from "./chat-context-hooks";
import ChatContextProviders from "./chat-context-providers";
import type { ChatActionsContextValue, ChatMessagesContextValue, ChatStreamingContextValue, ChatThreadContextValue } from "./chat-context-types";

const noop = () => {};

const ACTIONS = {} as ChatActionsContextValue;
const STREAMING = { activeStreamId: "s1", isStreaming: true } as ChatStreamingContextValue;

const messagesValue = (messages: UIMessage[]): ChatMessagesContextValue => {
    return { isEmpty: messages.length === 0, loadMore: noop, messages, messagesReady: true, messagesStatus: "Exhausted" };
};

const threadValue = (title: string, model = "model-a"): ChatThreadContextValue => {
    return { isNewThread: false, model, thread: { _id: "t1", model, title }, threadId: "t1" };
};

const reply = (text: string): UIMessage[] => [{ id: "m2", parts: [{ text, type: "text" }], role: "assistant" } as unknown as UIMessage];

const renders = new Map<string, number>();

const countRender = (id: string): void => {
    renders.set(id, (renders.get(id) ?? 0) + 1);
};

const EmptyProbe: FC = () => {
    countRender("empty");
    useChatIsEmpty();

    return null;
};

const IdentityProbe: FC = () => {
    countRender("identity");
    useChatThreadIdentity();

    return null;
};

// Module-level, so a provider re-render reaches the probes only through their context subscriptions.
const PROBES = (
    <>
        <EmptyProbe />
        <IdentityProbe />
    </>
);

const tree = (messages: ChatMessagesContextValue, thread: ChatThreadContextValue) => (
    <ChatContextProviders actions={ACTIONS} messages={messages} streaming={STREAMING} thread={thread}>
        {PROBES}
    </ChatContextProviders>
);

describe(ChatContextProviders, () => {
    it("a streamed batch re-renders no isEmpty reader until emptiness changes", () => {
        renders.clear();
        const thread = threadValue("Chat");
        const first = messagesValue(reply("He"));
        const second = messagesValue(reply("Hello"));
        const third = messagesValue(reply("Hello there"));
        const view = render(tree(first, thread));

        view.rerender(tree(second, thread));
        view.rerender(tree(third, thread));

        expect(renders.get("empty")).toBe(1);

        const cleared = messagesValue([]);

        view.rerender(tree(cleared, thread));

        expect(renders.get("empty")).toBe(2);
    });

    it("a thread-record write that keeps id and model re-renders no identity reader", () => {
        renders.clear();
        const messages = messagesValue(reply("Hi"));
        const view = render(tree(messages, threadValue("Chat")));

        view.rerender(tree(messages, threadValue("Renamed chat")));

        expect(renders.get("identity")).toBe(1);

        view.rerender(tree(messages, threadValue("Renamed chat", "model-b")));

        expect(renders.get("identity")).toBe(2);
    });
});
