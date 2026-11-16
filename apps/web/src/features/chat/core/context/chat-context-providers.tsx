import type { FC, ReactNode } from "react";
import { useMemo } from "react";

import {
    ChatActionsContext,
    ChatIsEmptyContext,
    ChatMessagesContext,
    ChatStreamingContext,
    ChatThreadContext,
    ChatThreadIdentityContext,
} from "./chat-context-hooks";
import type {
    ChatActionsContextValue,
    ChatMessagesContextValue,
    ChatStreamingContextValue,
    ChatThreadContextValue,
    ChatThreadIdentity,
} from "./chat-context-types";

interface ChatContextProvidersProps {
    actions: ChatActionsContextValue;
    children: ReactNode;
    messages: ChatMessagesContextValue;
    streaming: ChatStreamingContextValue;
    thread: ChatThreadContextValue;
}

/**
 * Publishes the split chat contexts. `isEmpty` and the thread identity get contexts of their own: the messages
 * context changes on every streamed batch and the thread context on every write to the thread record, and the
 * composer and every message's action bar need only these narrow slices.
 */
const ChatContextProviders: FC<ChatContextProvidersProps> = ({ actions, children, messages, streaming, thread }) => {
    const { isNewThread, model, threadId } = thread;
    const identity = useMemo((): ChatThreadIdentity => {
        return { isNewThread, model, threadId };
    }, [isNewThread, model, threadId]);

    return (
        <ChatThreadContext value={thread}>
            <ChatThreadIdentityContext value={identity}>
                <ChatMessagesContext value={messages}>
                    <ChatIsEmptyContext value={messages.isEmpty}>
                        <ChatStreamingContext value={streaming}>
                            <ChatActionsContext value={actions}>{children}</ChatActionsContext>
                        </ChatStreamingContext>
                    </ChatIsEmptyContext>
                </ChatMessagesContext>
            </ChatThreadIdentityContext>
        </ChatThreadContext>
    );
};

export default ChatContextProviders;
