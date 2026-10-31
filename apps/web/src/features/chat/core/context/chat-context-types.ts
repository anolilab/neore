import type { ReturnOf } from "@lunora/react";
import type { api } from "@neore/backend/api";

import type { UIMessage } from "@/lib/agent";
import type { AppError } from "@/lib/errors";
import type { useLunora } from "@/lib/lunora/crpc";

import type { RateLimitPause } from "../../thread/rate-limit-pause-notice";
import type { PendingAttachment } from "../stores/chat-ui-store";

/**
 * Thread capabilities - what actions are available
 */
export interface ThreadCapabilities {
    attachments: boolean;
    cancel: boolean;
    copy: boolean;
    dictation: boolean;
    edit: boolean;
    reload: boolean;
    speak: boolean;
}

/**
 * Thread data from Lunora
 */
/** The exact row shape `chat_functions.getThread` returns (superset of {@link ThreadData}). */
export type ThreadRow = NonNullable<ReturnOf<typeof api.chat.functions.getThread>>;

export interface ThreadData {
    _id: string;
    /** Set on a bot thread: the bot's model is the one that runs. */
    botId?: string | null;
    branchName?: string;
    branchPoint?: number;
    customSystemPrompt?: string;
    enabledFeatures?: string[];
    language?: string;
    mode?: "text" | "image" | "video";
    model: string;
    multiChat?: boolean;
    parentThreadId?: string;
    reasoningEffort?: number;
    /** `host`: a coding agent on a paired computer runs the turns (`backend/lunora/acp/`). Unset: the cloud. */
    runner?: "host";
    statelessMode?: boolean;
    status?: string;
    title?: string;
    /** The owner. Absent on a public viewer's redacted copy. */
    userId?: string;
}

// --- Split Context Types ---

export interface ChatThreadContextValue {
    isNewThread: boolean;
    model: string;
    thread: ThreadData | null | undefined;
    threadId: string | undefined;
}

export interface ChatMessagesContextValue {
    isEmpty: boolean;
    loadMore: (numberItems: number) => void;
    messages: UIMessage[];
    messagesReady: boolean;
    messagesStatus: "LoadingFirstPage" | "LoadingMore" | "Exhausted" | "CanLoadMore";
}

export interface ChatStreamingContextValue {
    activeStreamId: string | null;
    /** Gateway URL for edge streaming */
    gatewayUrl: string | null;
    isStreaming: boolean;
    /** The run is waiting out a provider's rate limit and resumes by itself (`getActiveStreamForThread`). */
    pause?: RateLimitPause | null;

    /**
     * The stream this client just started, from the `/v1/chat` response. The
     * placeholder opens the gateway stream with it instead of waiting for the
     * live `activeStreamId` — for a new thread that wait was a whole
     * subscription seed after the navigation, all of it added to the time to
     * first token. `activeStreamId` stays authoritative once it reports.
     */
    pendingStreamId?: string | null;
    streamingMessageId: string | null;
    /** HMAC stream token for gateway auth */
    streamToken: string | null;
}

export interface ChatActionsContextValue {
    cancelStream: () => Promise<void>;
    capabilities: ThreadCapabilities;
    clearError: () => void;
    copyMessage: (messageId: string, format?: "markdown" | "plain") => void;
    editMessage: (messageId: string, text: string) => Promise<void>;
    error: AppError | null;
    jwtToken: string;
    lunora: ReturnType<typeof useLunora>;
    regenerate: () => Promise<void>;
    reloadMessage: (messageId: string) => Promise<void>;
    sendMessage: (text: string, attachments?: PendingAttachment[]) => Promise<void>;
}

/**
 * Chat context value (legacy combined type for backwards compat)
 */
export type ChatContextValue = ChatActionsContextValue & ChatMessagesContextValue & ChatStreamingContextValue & ChatThreadContextValue;
