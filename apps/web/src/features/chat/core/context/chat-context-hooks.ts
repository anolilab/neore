import { createContext, use } from "react";

import type { useLunora } from "@/lib/lunora/crpc";

import type {
    ChatActionsContextValue,
    ChatContextValue,
    ChatMessagesContextValue,
    ChatStreamingContextValue,
    ChatThreadContextValue,
} from "./chat-context-types";

// --- Split Contexts ---
export const ChatThreadContext = createContext<ChatThreadContextValue | null>(null);
export const ChatMessagesContext = createContext<ChatMessagesContextValue | null>(null);
export const ChatStreamingContext = createContext<ChatStreamingContextValue | null>(null);
export const ChatActionsContext = createContext<ChatActionsContextValue | null>(null);

/** @deprecated Use specific context hooks instead */
export const ChatContext = createContext<ChatContextValue | null>(null);

// --- Context access helpers ---

const useChatThreadContext = (): ChatThreadContextValue => {
    const context = use(ChatThreadContext);

    if (!context) {
        throw new Error("useChatThread must be used within a ChatProvider");
    }

    return context;
};

const useChatMessagesContext = (): ChatMessagesContextValue => {
    const context = use(ChatMessagesContext);

    if (!context) {
        throw new Error("useChatMessages must be used within a ChatProvider");
    }

    return context;
};

const useChatStreamingContext = (): ChatStreamingContextValue => {
    const context = use(ChatStreamingContext);

    if (!context) {
        throw new Error("useChatIsStreaming must be used within a ChatProvider");
    }

    return context;
};

const useChatActionsContext = (): ChatActionsContextValue => {
    const context = use(ChatActionsContext);

    if (!context) {
        throw new Error("useChatActions must be used within a ChatProvider");
    }

    return context;
};

/**
 * Hook to access the full chat context (backwards compat)
 * Prefer using specific hooks (useChatThread, useChatMessages, etc.) for performance.
 * @throws if used outside of ChatProvider
 */
export const useChat = (): ChatContextValue => {
    const thread = useChatThreadContext();
    const msgs = useChatMessagesContext();
    const streaming = useChatStreamingContext();
    const actions = useChatActionsContext();

    return { ...thread, ...msgs, ...streaming, ...actions };
};

/**
 * Hook to access only messages (subscribes only to messages context).
 */
export const useChatMessages = (): Pick<ChatMessagesContextValue, "messages" | "messagesReady" | "messagesStatus" | "loadMore"> & { isStreaming: boolean } => {
    const { loadMore, messages, messagesReady, messagesStatus } = useChatMessagesContext();
    const { isStreaming } = useChatStreamingContext();

    return { isStreaming, loadMore, messages, messagesReady, messagesStatus };
};

/**
 * Hook to access thread state (subscribes only to thread context).
 */
export const useChatThread = (): ChatThreadContextValue => useChatThreadContext();

/**
 * Hook to access chat actions (subscribes only to actions context).
 */
export const useChatActions = (): Pick<
    ChatActionsContextValue,
    "sendMessage" | "cancelStream" | "reloadMessage" | "editMessage" | "copyMessage" | "clearError" | "regenerate" | "jwtToken"
> => {
    const { cancelStream, clearError, copyMessage, editMessage, jwtToken, regenerate, reloadMessage, sendMessage } = useChatActionsContext();

    return { cancelStream, clearError, copyMessage, editMessage, jwtToken, regenerate, reloadMessage, sendMessage };
};

/**
 * Hook to check if thread is empty (no messages)
 * Uses derived boolean from messages context — only re-renders on empty↔non-empty transitions.
 */
export const useChatIsEmpty = (): boolean => {
    const { isEmpty } = useChatMessagesContext();

    return isEmpty;
};

/**
 * Hook to check streaming state (subscribes only to streaming context)
 * Note: sseStreamState is an alias for activeStreamId for backwards compatibility.
 */
export const useChatIsStreaming = () => {
    const context = useChatStreamingContext();

    return { ...context, sseStreamState: context.activeStreamId };
};

/**
 * Hook to access error state (subscribes only to actions context)
 * Returns the current error, clearError function, and regenerate function for retrying.
 */
export const useChatError = () => {
    const { clearError, error, regenerate } = useChatActionsContext();

    return { clearError, error, regenerate };
};

/**
 * Hook to check if chat is running (subscribes only to streaming context)
 * Alias for isStreaming, returns just the boolean.
 */
export const useChatIsRunning = (): boolean => {
    const { isStreaming } = useChatStreamingContext();

    return isStreaming;
};

/**
 * Hook to access the Lunora client (subscribes only to actions context).
 */
export const useChatLunora = (): ReturnType<typeof useLunora> => {
    const { lunora } = useChatActionsContext();

    return lunora;
};
