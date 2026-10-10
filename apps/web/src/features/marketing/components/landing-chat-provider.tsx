"use client";

/**
 * LandingChatProvider - Minimal chat context for landing page
 *
 * Provides the same context interface as ChatProvider but for landing page use.
 * Simulates a "new thread" state so chat components can be reused.
 * Provides all 4 split contexts so slice hooks work correctly.
 */

import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import type { ReactNode } from "react";
import { useMemo } from "react";

import type {
    ChatActionsContextValue,
    ChatMessagesContextValue,
    ChatStreamingContextValue,
    ChatThreadContextValue,
} from "@/features/chat/core/context/chat-context";
import { ChatActionsContext, ChatMessagesContext, ChatStreamingContext, ChatThreadContext } from "@/features/chat/core/context/chat-context";
import type { ModelId } from "@/features/chat/core/stores/model-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import { useLunora } from "@/lib/lunora/crpc";

const EMPTY_MESSAGES: [] = [];

// Module-level so their identity never changes: they are inlined into context values.
const noop = async () => {};
const noopSync = () => {};

// Neither depends on props or state, so they live outside the component: a
// `useMemo` with an empty dependency array is not a stability guarantee.
const MESSAGES_VALUE: ChatMessagesContextValue = {
    isEmpty: true,
    loadMore: noopSync,
    messages: EMPTY_MESSAGES,
    messagesReady: true,
    messagesStatus: "Exhausted",
};

const STREAMING_VALUE: ChatStreamingContextValue = {
    activeStreamId: null,
    // The landing page never streams, so there is no gateway session to point at.
    gatewayUrl: null,
    isStreaming: false,
    streamingMessageId: null,
    streamToken: null,
};

interface LandingChatProviderProps {
    children: ReactNode;
}

/**
 * Provides a minimal chat context for landing page components.
 * Allows reusing chat components like model selector without a real thread.
 */
const LandingChatProvider = ({ children }: LandingChatProviderProps) => {
    const lunora = useLunora();
    const selectedModel = useModelStore((state) => state.selectedModel);

    // Model - use selected model from store or default
    const model: ModelId = selectedModel ?? DEFAULT_CHAT_MODEL;

    const threadValue = useMemo((): ChatThreadContextValue => {
        return {
            isNewThread: true,
            model,
            thread: null,
            threadId: undefined,
        };
    }, [model]);

    const actionsValue = useMemo((): ChatActionsContextValue => {
        return {
            cancelStream: noop,
            capabilities: {
                attachments: true,
                cancel: false,
                copy: false,
                dictation: false,
                edit: false,
                reload: false,
                speak: false,
            },
            clearError: noopSync,
            copyMessage: noopSync,
            editMessage: noop,
            error: null,
            jwtToken: "",
            lunora,
            regenerate: noop,
            reloadMessage: noop,
            sendMessage: noop,
        };
    }, [lunora]);

    return (
        <ChatThreadContext value={threadValue}>
            <ChatMessagesContext value={MESSAGES_VALUE}>
                <ChatStreamingContext value={STREAMING_VALUE}>
                    <ChatActionsContext value={actionsValue}>{children}</ChatActionsContext>
                </ChatStreamingContext>
            </ChatMessagesContext>
        </ChatThreadContext>
    );
};

export default LandingChatProvider;
