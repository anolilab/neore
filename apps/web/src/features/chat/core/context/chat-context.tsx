"use client";

/**
 * Chat Context - Direct Lunora integration without assistant-ui abstractions
 *
 * Provides:
 * - Messages directly from useUIMessages (no conversion)
 * - Thread data and metadata
 * - Streaming state
 * - Actions: sendMessage, cancelStream, reload
 */

import { useLingui } from "@lingui/react/macro";
import type { ReturnOf } from "@lunora/react";
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import type { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { getVisibleUserText } from "@neore/chat-ui/utils/page-context";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HistoryState } from "@tanstack/react-router";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { createContext, use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import useLocalModelTurn from "@/features/local-models/hooks/use-local-model-turn";
import type { UIMessage } from "@/lib/agent";
import { trackEvent } from "@/lib/analytics";
import env from "@/lib/env";
import { AppError, ErrorFactory } from "@/lib/errors";
import { providerLogger } from "@/lib/logger";
import { useCRPC, useLunora } from "@/lib/lunora/crpc";
import { registerStreamOfThread } from "@/lib/lunora/shard-routing";
import { notifyNative, shouldNotifyReplyFinished } from "@/lib/native/bridge";

import { DEFAULT_MESSAGE_OPTS } from "../constants/query-options";
import useHydratedMessages from "../hooks/use-hydrated-messages";
import type { PendingAttachment } from "../stores/chat-ui-store";
import { useChatUIStore } from "../stores/chat-ui-store";
import type { ModelId, PendingSettings } from "../stores/model-store";
import { useModelStore } from "../stores/model-store";
import { mapNavigatorLanguage } from "../utils/language-utilities";
import { createReadinessGate } from "../utils/readiness-gate";

const HTTP_STATUS_RE = /HTTP (\d+)/;

/** State updater dropping one message by id. */
const withoutMessage =
    (id: string) =>
    (previous: UIMessage[]): UIMessage[] =>
        previous.filter((m) => m.id !== id);

/** State updater un-hiding optimistically hidden message ids. */
const unhiding =
    (ids: ReadonlyArray<string>) =>
    (previous: Set<string>): Set<string> =>
        new Set([...previous].filter((id) => !ids.includes(id)));

/** How long a send waits for the session before handing the text back. */
const AUTH_READY_TIMEOUT_MS = 10_000;

/** An `AppError` passes through `handleError` untouched: a local message may name the LOCAL server's HTTP status. */
const localModelError = (message: string): AppError => new AppError(message, { code: "LOCAL_MODEL_ERROR", statusCode: 502 });

/** Chat stream endpoint — all requests go through the LLM Gateway */
const CHAT_STREAM_URL = `${env.VITE_LLM_GATEWAY_URL}/v1/chat`;

/** Chat edit endpoint — message edits go through the LLM Gateway */
const CHAT_EDIT_URL = `${env.VITE_LLM_GATEWAY_URL}/v1/chat/edit`;

/**
 * Trusted gateway origin used to validate any server-supplied `gatewayUrl`
 *  before opening an SSE/NDJSON stream. Prevents a compromised upstream from
 *  redirecting clients (and the bearer-equivalent stream token) to an
 *  attacker-controlled host.
 */
interface GatewayInfo {
    gatewayUrl: string | null;
    /** The stream `/v1/chat` just started — known before the live `getActiveStreamForThread` reports it. */
    streamId: string | null;
    streamToken: string | null;
}

const NO_GATEWAY_INFO: GatewayInfo = { gatewayUrl: null, streamId: null, streamToken: null };

/**
 * Hands a new thread's stream credentials across the `/chat` → `/chat/$threadId`
 * navigation. Those are two routes, so the provider that started the stream
 * unmounts and the one that must render it mounts with empty state; without
 * this the new thread never opened `/v1/stream` and sat on "stop generating"
 * with no reply. Module scope, not history state, so the bearer-equivalent
 * token is never persisted; the receiving provider drops its entry on mount.
 */
const pendingGatewayInfo = new Map<string, GatewayInfo>();

const TRUSTED_GATEWAY_ORIGIN = (() => {
    try {
        return new URL(env.VITE_LLM_GATEWAY_URL).origin;
    } catch {
        return null;
    }
})();

/**
 * The fallback is the configured gateway BASE URL, not its bare origin: in dev
 * the gateway sits behind the app's `/llm-gateway` proxy, so the origin alone
 * points `/v1/stream` at the app itself and the stream never opens.
 */
const withoutTrailingSlashes = (value: string): string => {
    let end = value.length;

    while (end > 0 && value[end - 1] === "/") {
        end -= 1;
    }

    return value.slice(0, end);
};

const TRUSTED_GATEWAY_BASE = TRUSTED_GATEWAY_ORIGIN ? withoutTrailingSlashes(env.VITE_LLM_GATEWAY_URL) : null;

const validateGatewayUrl = (candidate: string | null | undefined): string | null => {
    if (!candidate || !TRUSTED_GATEWAY_ORIGIN) return TRUSTED_GATEWAY_BASE;

    try {
        return new URL(candidate).origin === TRUSTED_GATEWAY_ORIGIN ? candidate : TRUSTED_GATEWAY_BASE;
    } catch {
        return TRUSTED_GATEWAY_BASE;
    }
};

/**
 * Thread capabilities - what actions are available
 */
interface ThreadCapabilities {
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
type ThreadRow = NonNullable<ReturnOf<typeof api.chat.functions.getThread>>;

interface ThreadData {
    _id: string;
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
    copyMessage: (messageId: string) => void;
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

// --- Split Contexts ---
export const ChatThreadContext = createContext<ChatThreadContextValue | null>(null);
export const ChatMessagesContext = createContext<ChatMessagesContextValue | null>(null);
export const ChatStreamingContext = createContext<ChatStreamingContextValue | null>(null);
export const ChatActionsContext = createContext<ChatActionsContextValue | null>(null);

/** @deprecated Use specific context hooks instead */
export const ChatContext = createContext<ChatContextValue | null>(null);

interface ChatProviderProps {
    children: ReactNode;
    /** Initial thread data from route loader for instant display */
    initialThread?: ThreadData | null;
    jwtToken: string;
    model?: ModelId;
    /** Optional callback when an error occurs */
    onError?: (error: AppError) => void;
    threadId?: string;
}

// Resolved once per runtime rather than per mount: neither the navigator language
// nor the speech APIs change during a session, and an empty-dependency `useMemo`
// is not a stability guarantee.
const navigatorLanguage = typeof navigator === "undefined" || !navigator.language ? "en-US" : mapNavigatorLanguage(navigator.language);

const capabilities: ThreadCapabilities = {
    attachments: true,
    cancel: true,
    copy: true,
    dictation: globalThis.window !== undefined && ("SpeechRecognition" in globalThis || "webkitSpeechRecognition" in globalThis),
    edit: true,
    reload: true,
    speak: globalThis.window !== undefined && "speechSynthesis" in globalThis,
};

export const ChatProvider = ({ children, initialThread, jwtToken, model: modelProp, onError, threadId }: ChatProviderProps) => {
    const lunora = useLunora();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const navigate = useNavigate();

    // Get user settings for default language
    const { data: userSettings } = useUserSettings();
    const userLanguage = userSettings?.language as string | undefined;

    // Memoize default language - only recomputes when userLanguage changes
    const defaultLanguage = useMemo(() => userLanguage || navigatorLanguage, [userLanguage]);

    // Error state
    const [error, setError] = useState<AppError | null>(null);

    const clearError = useCallback(() => {
        setError(null);
    }, []);

    const handleError = useCallback(
        (error_: unknown) => {
            let appError: AppError;

            if (error_ instanceof Response) {
                appError = ErrorFactory.fromResponse(error_);
            } else if (error_ instanceof Error) {
                // Check if it's already an AppError
                if ("code" in error_ && "statusCode" in error_) {
                    appError = error_ as AppError;
                } else {
                    // Convert HTTP error messages
                    const statusMatch = error_.message.match(HTTP_STATUS_RE);

                    if (statusMatch?.[1]) {
                        const status = Number(statusMatch[1]);

                        appError = ErrorFactory.fromResponse(new Response(null, { status }));
                    } else {
                        appError = ErrorFactory.fromBackendError(error_);
                    }
                }
            } else {
                appError = ErrorFactory.fromBackendError(error_);
            }

            setError(appError);
            onError?.(appError);
            providerLogger.error("[ChatProvider] Error occurred", { error: appError });
        },
        [onError],
    );

    const { hooks } = useAuth();
    const { data: sessionData, refetch: refetchSession } = hooks.useSession();
    const isAuthenticated = !!sessionData?.user;

    // A send that lands before the session query resolves WAITS on this rather
    // than being dropped; see `utils/readiness-gate.ts`. The token is read
    // through a ref for the same reason: after the wait, the callback's own
    // closure still holds the value from before the session landed.
    const [authGate] = useState(() => createReadinessGate(isAuthenticated));
    const jwtTokenRef = useRef(jwtToken);

    useEffect(() => {
        jwtTokenRef.current = jwtToken;
        authGate.set(isAuthenticated);
    }, [authGate, isAuthenticated, jwtToken]);

    // Only subscribe to model store values needed in render output
    // setPendingSettings, getComposerMode, setComposerMode are only used in callbacks
    // and are accessed via useModelStore.getState() there
    const modelStore = useModelStore(
        useShallow((state) => {
            return {
                loadThreadData: state.loadThreadData,
                resetForNewThread: state.resetForNewThread,
                selectedModel: state.selectedModel,
                selectedModelThreadId: state.selectedModelThreadId,
                userChangedModel: state.userChangedModel,
            };
        }),
    );

    // Access pending settings directly from store for reliability (avoids useShallow closure issues)
    const getPendingSettingsFromStore = useCallback(() => {
        const settings = useModelStore.getState().pendingSettings;

        useModelStore.getState().setPendingSettings(undefined);

        return settings ?? null;
    }, []);

    // Get only the settings that have changed from the thread's cached values
    // Returns undefined for unchanged values to avoid sending them
    const getChangedSettings = useCallback((currentThreadData: ThreadData | ThreadRow | null | undefined) => {
        const pending = useModelStore.getState().pendingSettings;

        if (!pending) {
            return null;
        }

        const changed: Pick<PendingSettings, "customSystemPrompt" | "enabledFeatures" | "language" | "reasoningEffort" | "statelessMode"> = {};
        let hasChanges = false;

        if (pending.customSystemPrompt !== undefined && pending.customSystemPrompt !== currentThreadData?.customSystemPrompt) {
            changed.customSystemPrompt = pending.customSystemPrompt;
            hasChanges = true;
        }

        if (pending.enabledFeatures !== undefined && JSON.stringify(pending.enabledFeatures) !== JSON.stringify(currentThreadData?.enabledFeatures)) {
            changed.enabledFeatures = pending.enabledFeatures;
            hasChanges = true;
        }

        if (pending.language !== undefined && pending.language !== currentThreadData?.language) {
            changed.language = pending.language;
            hasChanges = true;
        }

        if (pending.reasoningEffort !== undefined && pending.reasoningEffort !== currentThreadData?.reasoningEffort) {
            changed.reasoningEffort = pending.reasoningEffort;
            hasChanges = true;
        }

        if (pending.statelessMode !== undefined && pending.statelessMode !== currentThreadData?.statelessMode) {
            changed.statelessMode = pending.statelessMode;
            hasChanges = true;
        }

        // Clear pending settings after checking
        if (hasChanges) {
            useModelStore.getState().setPendingSettings(undefined);
        }

        return hasChanges ? changed : null;
    }, []);

    // Only subscribe to values needed in render/effects — setCopiedMessageId and clearComposer
    // are only used in callbacks and accessed via useChatUIStore.getState() there
    const { clearTransitioningMessage, setTransitioningMessage, transitioningMessage } = useChatUIStore(
        useShallow((state) => {
            return {
                clearTransitioningMessage: state.clearTransitioningMessage,
                setTransitioningMessage: state.setTransitioningMessage,
                transitioningMessage: state.transitioningMessage,
            };
        }),
    );

    const isNewThread = !threadId;
    const hasResetRef = useRef(false);
    const previousThreadIdRef = useRef<string | undefined>(undefined);

    // Reset model and language when mounting a new thread view
    // This handles the case when navigating from /chat/$threadId to /chat
    // Read off the store object first: the effect depends on these two members, not
    // on the store snapshot's identity.
    const { resetForNewThread, selectedModelThreadId } = modelStore;

    useEffect(() => {
        // Only reset once on mount, and only if this is a new thread with stale store data
        if (!(!hasResetRef.current && !threadId && selectedModelThreadId)) {
            return;
        }

        hasResetRef.current = true;
        // Reset model to default
        resetForNewThread(undefined);
        // Clear pending settings (includes language, custom system prompt, etc.)
        useModelStore.getState().setPendingSettings(undefined);
    }, [threadId, selectedModelThreadId, resetForNewThread]);

    // Load thread data into store when threadId changes.
    // Assistant has key={threadId}, so ChatProvider remounts on every thread switch.
    // Use useLayoutEffect to run synchronously after render but before browser paint.
    // ALWAYS load data (even if empty) to reset stale state from previous threads.
    useLayoutEffect(() => {
        if (!threadId || threadId === previousThreadIdRef.current) {
            return;
        }

        // Extract only model and mode from thread data for the store (it doesn't need other fields)
        // CRITICAL: Only use initialThread if it matches the current threadId to prevent loading stale data
        const validInitialThread = initialThread && initialThread._id === threadId ? initialThread : null;
        const threadDataForStore = validInitialThread ? { mode: validInitialThread.mode, model: validInitialThread.model } : {};

        modelStore.loadThreadData(threadDataForStore, threadId);
        previousThreadIdRef.current = threadId;
    }, [threadId, initialThread, modelStore]);

    const { data: threadData } = useQuery({
        // `threadId` is the `/chat/$threadId` route param handed to `ChatProvider`, so
        // it is a plain string that always names an existing thread.
        ...crpc.chat.functions.getThread.queryOptions(threadId ? { threadId: threadId as Id<"threads"> } : skipToken),
        // Use initialThread from route loader for instant display (no loading flash)
        // CRITICAL: Only use initialThread if it matches the current threadId to prevent stale data during navigation
        //
        // `initialThread` arrives from the `/chat/$threadId` loader, which hands back an untyped
        // snapshot of the same row this query returns. `ThreadData` is this file's narrower view
        // of that row (no `_creationTime`, `model` non-optional), so seeding the cache needs an
        // assertion back to the query's own row type.
        initialData: initialThread && initialThread._id === threadId ? (initialThread as unknown as ThreadRow) : undefined,
    });

    // CRITICAL: Validate that initialThread matches current threadId before using it.
    // During navigation, the component can re-render with NEW threadId but OLD initialThread (from previous route).
    // Only use initialThread if its _id matches the current threadId, otherwise fall back to query data.
    const thread: ThreadData | null = (initialThread && initialThread._id === threadId ? initialThread : null) ?? (threadData as ThreadData | null) ?? null;

    // Backup sync: when Lunora query resolves with fresh data, update store
    // Only if user hasn't explicitly changed model/mode for this thread
    // Same reasoning as above: depend on the fields the effect reads, not on the
    // identity of the store snapshot or of the thread row.
    const { loadThreadData } = modelStore;
    const hasThread = Boolean(thread);
    const threadModel = thread?.model;
    const threadMode = thread?.mode;

    useEffect(() => {
        if (!(threadId && hasThread)) {
            return;
        }

        const state = useModelStore.getState();
        // Skip if store already points to this thread and user made changes
        const userChangedSomething =
            (state.userChangedModel && state.selectedModelThreadId === threadId) || (state.userChangedMode && state.currentModeThreadId === threadId);

        if (!userChangedSomething) {
            const threadDataForStore = { mode: threadMode, model: threadModel };

            loadThreadData(threadDataForStore, threadId);
        }
    }, [threadId, hasThread, threadModel, threadMode, loadThreadData]);

    // Model: use thread data or user selection from store
    const model = useMemo((): string => {
        // Explicit prop always wins
        if (modelProp) {
            return modelProp;
        }

        // For existing threads: use thread's persisted model unless user explicitly changed it
        if (threadId) {
            const userChanged = modelStore.userChangedModel && modelStore.selectedModelThreadId === threadId;

            if (userChanged) {
                // User picked a different model for this thread → use store value
                return modelStore.selectedModel || DEFAULT_CHAT_MODEL;
            }

            // Use thread's saved model (from initialThread or threadData)
            if (thread?.model) {
                return thread.model;
            }
        }

        // New thread or fallback: use store's selected model (user's last choice or default)
        return modelStore.selectedModel || DEFAULT_CHAT_MODEL;
    }, [modelProp, modelStore.selectedModel, modelStore.selectedModelThreadId, modelStore.userChangedModel, threadId, thread?.model]);

    const {
        loadMore,
        messages: uiMessages,
        status: messagesStatus,
    } = useHydratedMessages({
        initialNumItems: 20,
        threadId,
    });

    const isMessagesReady = !isNewThread && (messagesStatus !== "LoadingFirstPage" || uiMessages.length > 0);

    // `local-browser` models stream from the user's own machine, not the gateway
    // (`features/local-models`). Inert for every other model.
    const savedMessageIds = useMemo(() => new Set(uiMessages.map((m) => m.id)), [uiMessages]);
    const {
        cancel: cancelLocalTurn,
        isStreaming: isLocalStreaming,
        send: sendLocalTurn,
        streamingMessage: localStreamingMessage,
        target: localTarget,
    } = useLocalModelTurn(model, savedMessageIds);

    // Optimistic messages - shown immediately before server confirms
    const [optimisticMessages, setOptimisticMessages] = useState<UIMessage[]>([]);
    // Optimistic removals - messages to hide immediately before server confirms deletion
    const [hiddenMessageIds, setHiddenMessageIds] = useState<Set<string>>(new Set());
    // Optimistic regenerating state - shows "Thinking..." immediately before stream starts
    const [isRegenerating, setIsRegenerating] = useState(false);
    const previousUserMessageCountRef = useRef<number | null>(null);

    // Clear optimistic messages when new user messages arrive from Lunora
    useEffect(() => {
        const currentUserMessageCount = uiMessages?.filter((m) => m.role === "user").length ?? 0;

        // Initialize counter on first load or after thread change
        if (previousUserMessageCountRef.current === null) {
            previousUserMessageCountRef.current = currentUserMessageCount;

            return;
        }

        // Clear optimistic messages and transitioning message when we detect new user messages from Lunora
        if (optimisticMessages.length > 0 && currentUserMessageCount > previousUserMessageCountRef.current) {
            setOptimisticMessages([]);

            // Clear transitioning message for this thread (real message arrived)
            if (threadId) {
                clearTransitioningMessage(threadId);
            }
        }

        previousUserMessageCountRef.current = currentUserMessageCount;
    }, [uiMessages, optimisticMessages, threadId, clearTransitioningMessage]);

    // Reset counter and clear optimistic state when thread changes
    // Also pick up transitioning message if this is the target thread
    useEffect(() => {
        previousUserMessageCountRef.current = null; // Will be re-initialized from uiMessages
        setHiddenMessageIds(new Set());
        setIsRegenerating(false);

        // Check if there's a transitioning message for this thread
        if (threadId && transitioningMessage?.threadId === threadId) {
            // Create optimistic message from transitioning message
            const optimisticId = `transitioning-${Date.now()}`;
            const optimisticMessage: UIMessage = {
                _creationTime: Date.now(),
                id: optimisticId,
                key: optimisticId,
                order: Number.MAX_SAFE_INTEGER,
                parts: [{ text: transitioningMessage.text, type: "text" }],
                role: "user",
                status: "pending" as const,
                stepOrder: 0,
                text: transitioningMessage.text,
            };

            setOptimisticMessages([optimisticMessage]);
        } else {
            setOptimisticMessages([]);
        }
    }, [threadId, transitioningMessage]);

    // Clear hidden message IDs when the real messages change (server confirmed deletions)
    useEffect(() => {
        if (hiddenMessageIds.size === 0) {
            return;
        }

        // Check if any hidden messages are no longer in uiMessages (they were deleted server-side)
        const currentMessageIds = new Set(uiMessages?.map((m) => m.id));
        const stillHidden = new Set<string>();

        for (const id of hiddenMessageIds) {
            if (currentMessageIds.has(id)) {
                // Message still exists - keep it hidden until server deletes it
                stillHidden.add(id);
            }
        }

        // Only update if there's a change
        if (stillHidden.size !== hiddenMessageIds.size) {
            setHiddenMessageIds(stillHidden);
        }
    }, [uiMessages, hiddenMessageIds]);

    // Use ref for hiddenMessageIds to avoid triggering expensive re-computations
    // on every deletion (hiddenMessageIds changes frequently during optimistic deletions)

    // Memoize the Set creation separately to avoid recreating on every render
    const realUserMessageTexts = useMemo(() => {
        if (isNewThread || !uiMessages || uiMessages.length === 0) {
            return new Set<string>();
        }

        const visibleMessages = hiddenMessageIds.size > 0 ? uiMessages.filter((m) => !hiddenMessageIds.has(m.id)) : uiMessages;

        const texts = new Set<string>();

        for (const m of visibleMessages) {
            if (m.role === "user") texts.add(m.text);
        }

        return texts;
    }, [hiddenMessageIds, isNewThread, uiMessages]);

    const baseMessages = useMemo((): UIMessage[] => {
        if (isNewThread) {
            return optimisticMessages;
        }

        if (!uiMessages || uiMessages.length === 0) {
            return optimisticMessages;
        }

        // Filter out hidden messages (optimistic deletions).
        const visibleMessages = hiddenMessageIds.size > 0 ? uiMessages.filter((m) => !hiddenMessageIds.has(m.id)) : uiMessages;

        // Early return if no optimistic messages to append
        if (optimisticMessages.length === 0) {
            return visibleMessages;
        }

        // Filter out optimistic messages that have a matching real message (by text content)
        const pendingOptimistic = optimisticMessages.filter((m) => !realUserMessageTexts.has(m.text));

        // Early return if no pending optimistic messages
        if (pendingOptimistic.length === 0) {
            return visibleMessages;
        }

        // Append only pending optimistic messages (those without a matching real message)
        return [...visibleMessages, ...pendingOptimistic];
    }, [hiddenMessageIds, isNewThread, uiMessages, optimisticMessages, realUserMessageTexts]);

    const messages = useMemo(
        (): UIMessage[] => (localStreamingMessage ? [...baseMessages, localStreamingMessage] : baseMessages),
        [baseMessages, localStreamingMessage],
    );
    // The local path's history reads this at send time without re-creating `sendMessage` per token.
    const messagesRef = useRef(messages);

    useLayoutEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    const { data: activeStream } = useQuery(
        // `threadId` is the `/chat/$threadId` route param; the "default" sentinel is filtered out above.
        crpc.chat.streaming.getActiveStreamForThread.queryOptions(threadId && threadId !== "default" ? { threadId: threadId as Id<"threads"> } : skipToken),
    );
    const activeStreamId = activeStream?.streamId ?? null;

    // In a shared thread the stream is on the owner's shard; `getStreamBody`
    // names only the stream, so it inherits the thread's route.
    if (activeStreamId && threadId) {
        registerStreamOfThread(activeStreamId, threadId);
    }

    // Gateway streaming state — stored as state (not ref) so changes trigger context re-render
    // Read in the initializer, dropped in an effect: StrictMode runs initializers twice.
    const [gatewayInfo, setGatewayInfo] = useState<GatewayInfo>(() => (threadId ? pendingGatewayInfo.get(threadId) : undefined) ?? NO_GATEWAY_INFO);
    // Bumped by every turn this client starts (send, regenerate, edit, local), so a
    // `/v1/chat` response only publishes its stream for the turn that asked for it.
    // Without the reset, a regenerate after a short reply the live query never saw
    // fell back to the PREVIOUS send's stream id and replayed that reply.
    const turnRef = useRef(0);
    const startTurn = useCallback((): number => {
        turnRef.current += 1;
        setGatewayInfo(NO_GATEWAY_INFO);

        return turnRef.current;
    }, []);

    useEffect(() => {
        if (threadId) {
            pendingGatewayInfo.delete(threadId);
        }
    }, [threadId]);

    // Clear isRegenerating when activeStreamId becomes available (stream started).
    // Adjusted during render rather than in an effect: the guard is self-clearing,
    // so this runs at most once per stream and saves a commit.
    if (activeStreamId && isRegenerating) {
        setIsRegenerating(false);
    }

    // Track stream completion when activeStreamId transitions from non-null to null
    const { t } = useLingui();
    const previousStreamIdRef = useRef<string | null>(null);
    const streamStartedAtRef = useRef<number | null>(null);

    useEffect(() => {
        if (!previousStreamIdRef.current && activeStreamId) {
            streamStartedAtRef.current = Date.now();
        }

        if (previousStreamIdRef.current && !activeStreamId) {
            trackEvent("stream_completed", { model });
            // Clear gateway info when stream completes
            setGatewayInfo(NO_GATEWAY_INFO);

            // Desktop/mobile shell only (no-op in a browser): tell the user a long reply landed.
            const durationMs = streamStartedAtRef.current === null ? 0 : Date.now() - streamStartedAtRef.current;

            if (shouldNotifyReplyFinished(durationMs, document.hidden)) {
                void notifyNative({ body: t`Your answer in Neore has finished.`, title: t`Reply ready` });
            }

            streamStartedAtRef.current = null;
        }

        previousStreamIdRef.current = activeStreamId;
    }, [activeStreamId, model, t]);

    // Consider streaming active if:
    // 1. Any message has status "streaming" (legacy/fallback), OR
    // 2. There's an active stream mapping in Lunora (new architecture), OR
    // 3. We're in optimistic regenerating state (waiting for stream to start)
    // Combine streaming checks into single pass for efficiency
    // Scan for the streaming message once per `messages` change and keep only its id.
    // Everything downstream then depends on a string, not on the message array, so a
    // new array with the same streaming state does not invalidate anything.
    const streamingMessageId = useMemo(() => messages.find((m) => m.status === "streaming")?.id ?? null, [messages]);

    // A local reply streams on `/chat` too, before its thread exists.
    const isStreaming = (Boolean(threadId) && (streamingMessageId !== null || Boolean(activeStreamId) || isRegenerating)) || isLocalStreaming;

    const { mutateAsync: abortStreamMutation } = useMutation(crpc.chat.functions.abortStreamByMessageId.mutationOptions());
    const streamingMessageRef = useRef<{ gatewayUrl?: string; messageId: string; streamId?: string; streamToken?: string; threadId: string } | null>(null);

    const sendMessage = useCallback(
        async (text: string, attachments?: PendingAttachment[]) => {
            // Clear any previous error when starting a new send
            setError(null);

            // Never drop the input: wait for the session (the composer stays in
            // its submitting state meanwhile) and, if it never comes, hand the
            // text back with an error instead of returning silently.
            if (!authGate.isReady()) {
                void refetchSession();

                if (!(await authGate.wait(AUTH_READY_TIMEOUT_MS))) {
                    providerLogger.error("[ChatProvider] Session not ready after waiting; send not delivered");
                    useChatUIStore.getState().setComposerText(text);
                    useChatUIStore.getState().setIsSubmitting(false);
                    handleError(
                        new AppError(t`We could not confirm your session in time. Your message is still in the composer. Please try sending it again.`, {
                            code: "AUTH_NOT_READY",
                            statusCode: 401,
                        }),
                    );

                    return;
                }
            }

            // Create optimistic user message immediately for instant feedback
            const optimisticId = `optimistic-${Date.now()}`;
            const optimisticMessage: UIMessage = {
                _creationTime: Date.now(),
                id: optimisticId,
                key: optimisticId,
                order: Number.MAX_SAFE_INTEGER,
                parts: [{ text, type: "text" }],
                role: "user",
                status: "pending" as const,
                stepOrder: 0,
                text,
            };

            setOptimisticMessages((previous) => [...previous, optimisticMessage]);

            const turn = startTurn();
            const isCreatingNewThread = !threadId;

            if (localTarget) {
                const restoreComposer = (message: string | undefined) => {
                    setOptimisticMessages(withoutMessage(optimisticId));
                    useChatUIStore.getState().setComposerText(text);

                    if (message) {
                        handleError(localModelError(message));
                    }
                };

                if (attachments && attachments.length > 0) {
                    restoreComposer(t`Local models are text only. Remove the attachments to send.`);

                    return;
                }

                const pendingSettings = isCreatingNewThread ? getPendingSettingsFromStore() : null;

                useChatUIStore.getState().clearComposer();
                useChatUIStore.getState().setIsSubmitting(false);
                trackEvent("message_sent", { attachment_count: 0, has_attachments: false, model, thread_mode: "text" });

                await sendLocalTurn({
                    history: messagesRef.current.filter((m) => m.id !== optimisticId),
                    language: isCreatingNewThread ? pendingSettings?.language || defaultLanguage : undefined,
                    onNotSaved: restoreComposer,
                    onSaved: ({ isNewThread: createdThread, message, threadId: savedThreadId }) => {
                        if (message) {
                            handleError(localModelError(message));
                        }

                        if (createdThread) {
                            trackEvent("thread_created", { mode: "text", model });
                            setTransitioningMessage({ text, threadId: savedThreadId });
                            navigate({ params: { threadId: savedThreadId }, state: { isNewThread: true } as HistoryState, to: "/chat/$threadId" });
                        }
                    },
                    prompt: text,
                    systemPrompt: isCreatingNewThread ? pendingSettings?.customSystemPrompt : threadData?.customSystemPrompt,
                    threadId,
                });

                return;
            }

            try {
                // For new threads: send all pending settings
                // For existing threads: only send settings that have changed from cached values
                const pendingSettings = isCreatingNewThread ? getPendingSettingsFromStore() : null;
                const changedSettings = isCreatingNewThread ? null : getChangedSettings(threadData);

                let fileIds: string[] | undefined;

                if (attachments) {
                    fileIds = [];

                    for (const a of attachments) {
                        if (a.status === "complete" && typeof a.fileId === "string" && a.fileId) fileIds.push(a.fileId);
                    }
                }

                // Build request body — always include model, mode, and language
                // so the backend can persist them on the thread
                const currentMode = useModelStore.getState().getComposerMode(threadId || undefined);

                // Get generation settings from model store
                const imageSettings = currentMode === "image" ? useModelStore.getState().imageSettings : undefined;
                const videoSettings = currentMode === "video" ? useModelStore.getState().videoSettings : undefined;

                // Get selected MCP server names (empty array = all enabled)
                const { mcpServerNames } = useModelStore.getState();

                // Get search mode and research depth from model store
                const { researchDepth, searchMode } = useModelStore.getState();

                const requestBody: Record<string, unknown> = {
                    fileIds,
                    language: pendingSettings?.language || defaultLanguage,
                    mcpServerNames: mcpServerNames.length > 0 ? mcpServerNames : undefined,
                    mode: currentMode,
                    model,
                    prompt: text,
                    researchDepth: searchMode === "chat" ? undefined : researchDepth,
                    searchMode,
                    threadId: threadId || undefined, // undefined triggers thread creation
                };

                // Add image generation settings
                if (imageSettings) {
                    requestBody.quality = imageSettings.quality;
                    requestBody.style = imageSettings.style;
                    requestBody.cinemaSettings = imageSettings.cinema;
                    requestBody.numImages = imageSettings.numImages ?? 1;
                    requestBody.seed = imageSettings.seed;
                    requestBody.negativePrompt = imageSettings.negativePrompt;
                    // The composer's aspect-ratio picker was never sent, so the
                    // backend's "1:1" fallback won every time and choosing any
                    // other ratio did nothing at all.
                    requestBody.imageSize = imageSettings.aspectRatio;

                    // Multi-reference image picker payload. Order matters — the index
                    // is the "1, 2, 3..." badge the user sees in the composer strip,
                    // and downstream tools forward this order to providers that
                    // support multi-ref (FAL Nano-Banana et al.).
                    const { attachedReferences } = useChatUIStore.getState();

                    if (attachedReferences.length > 0) {
                        requestBody.referenceImages = attachedReferences.map((ref) => ref.url);
                    }
                }

                // Add video generation settings
                if (videoSettings) {
                    requestBody.duration = videoSettings.duration;
                    requestBody.cinemaSettings = videoSettings.cinema;
                    // Same field, same omission: the backend forwards `imageSize`
                    // to the video path as `aspectRatio` (see chat/http.ts).
                    requestBody.imageSize = videoSettings.aspectRatio;
                }

                if (isCreatingNewThread) {
                    // New thread: send all pending settings
                    if (pendingSettings) {
                        requestBody.customSystemPrompt = pendingSettings.customSystemPrompt;
                        requestBody.enabledFeatures = pendingSettings.enabledFeatures;
                        requestBody.reasoningEffort = pendingSettings.reasoningEffort;
                        requestBody.statelessMode = pendingSettings.statelessMode;
                    }
                } else if (changedSettings) {
                    // Existing thread: also send changed settings
                    Object.assign(requestBody, changedSettings);
                }

                // Clear composer and show thinking state immediately — before the network round-trip
                // so the UI feels instant and non-frozen while the server processes the request
                useChatUIStore.getState().clearComposer();
                useChatUIStore.getState().setIsSubmitting(false);
                setIsRegenerating(true);

                // Call gateway /v1/chat — creates thread + message, schedules agent, returns metadata
                const response = await fetch(CHAT_STREAM_URL, {
                    body: JSON.stringify(requestBody),
                    headers: {
                        "Content-Type": "application/json",
                        ...(jwtTokenRef.current && { Authorization: `Bearer ${jwtTokenRef.current}` }),
                    },
                    method: "POST",
                });

                if (!response.ok) {
                    const errorData = (await response.json()) as { bannedWords?: string[]; error?: string; message?: string };

                    if (errorData.error === "BANNED_CONTENT") {
                        // Restore composer text so the user can edit their message
                        setIsRegenerating(false);
                        setOptimisticMessages((previous) => previous.filter((m) => m.id !== optimisticId));
                        useChatUIStore.getState().setComposerText(text);
                        useChatUIStore.getState().setComposerBannedContent({
                            message: errorData.message ?? t`Your message contains inappropriate content that cannot be sent.`,
                            words: errorData.bannedWords ?? [],
                        });

                        return;
                    }

                    throw new Error(errorData.message || errorData.error || `HTTP ${response.status}`);
                }

                const data = (await response.json()) as {
                    contentType?: "text" | "image" | "audio" | "video";
                    gatewayUrl: string;
                    messageId?: string;
                    streamId?: string;
                    streaming?: boolean;
                    streamingConfig?: {
                        contentType: string;
                        imageSize?: string;
                        model: string;
                    };
                    streamToken?: string;
                    threadId?: string;
                };

                if (data.messageId && data.threadId) {
                    const safeGatewayUrl = validateGatewayUrl(data.gatewayUrl);

                    streamingMessageRef.current = {
                        gatewayUrl: safeGatewayUrl ?? undefined,
                        messageId: data.messageId,
                        streamId: data.streamId,
                        streamToken: data.streamToken,
                        threadId: data.threadId,
                    };

                    // Update gateway info state so it propagates through context — unless
                    // another turn started while this request was in flight.
                    if (turn === turnRef.current) {
                        setGatewayInfo({ gatewayUrl: safeGatewayUrl, streamId: data.streamId ?? null, streamToken: data.streamToken ?? null });
                    }

                    const composerMode = useModelStore.getState().getComposerMode(threadId || undefined);

                    trackEvent("stream_started", { model });
                    trackEvent("message_sent", {
                        attachment_count: attachments?.length ?? 0,
                        has_attachments: (attachments?.length ?? 0) > 0,
                        model,
                        thread_mode: composerMode,
                    });

                    if (isCreatingNewThread) {
                        trackEvent("thread_created", { mode: composerMode, model });
                    }

                    // Navigate to new thread if we just created one
                    if (isCreatingNewThread && data.threadId) {
                        // Prime caches for both individual thread query AND composite query
                        // This prevents expensive re-fetches during route loading
                        const optimisticThread = {
                            _id: data.threadId,
                            language: requestBody.language,
                            mode: composerMode,
                            model,
                            status: "running",
                        };

                        // Prime getThread cache (used by ChatProvider)
                        // Keys derived from the references. The hand-written literals
                        // matched nothing under Lunora, so neither optimistic write was
                        // ever read back — the new thread still round-tripped.
                        queryClient.setQueryData(crpc.chat.functions.getThread.queryKey({ threadId: data.threadId as Id<"threads"> }), optimisticThread);

                        // Prime composite query cache (used by route loader)
                        queryClient.setQueryData(
                            crpc.chat.composite.getThreadWithData.queryKey({ messageOpts: DEFAULT_MESSAGE_OPTS, threadId: data.threadId as Id<"threads"> }),
                            {
                                messages: { continueCursor: "", isDone: true, page: [] },
                                permission: "admin",
                                suggestions: { suggestions: [] },
                                thread: optimisticThread,
                                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                            },
                        );

                        // Set transitioning message for smooth visual transition
                        setTransitioningMessage({ text, threadId: data.threadId });

                        pendingGatewayInfo.set(data.threadId, {
                            gatewayUrl: safeGatewayUrl,
                            streamId: data.streamId ?? null,
                            streamToken: data.streamToken ?? null,
                        });

                        // Navigate immediately with isNewThread flag - stream is already started server-side
                        // IMPORTANT: Don't cast state to undefined - we need it for route loader skip logic
                        // TanStack's `HistoryState` is an empty interface meant to be augmented from
                        // `@tanstack/history`, which is not a direct dependency of this app — so custom
                        // keys can only reach it through an assertion. `/chat/$threadId`'s loader reads
                        // this back with the mirrored `{ isNewThread?: boolean }` shape.
                        navigate({ params: { threadId: data.threadId }, state: { isNewThread: true } as HistoryState, to: "/chat/$threadId" });
                    }

                    // Handle non-text content types (image/audio/video)
                    // Fire-and-forget to avoid waterfall - we don't need to wait for this
                    if (data.contentType && data.contentType !== "text" && data.streamingConfig) {
                        fetch(`${env.VITE_LLM_GATEWAY_URL}/v1/chat/media`, {
                            // `threadId` routes the call to the thread owner's shard.
                            body: JSON.stringify({
                                messageId: data.messageId,
                                streamingConfig: data.streamingConfig,
                                threadId: data.threadId,
                            }),
                            headers: {
                                "Content-Type": "application/json",
                                ...(jwtTokenRef.current && { Authorization: `Bearer ${jwtTokenRef.current}` }),
                            },
                            method: "POST",
                        }).catch((error_) => {
                            // Log media upload errors but don't block the UI
                            console.error("Media upload failed:", error_);
                        });
                    }
                }
            } catch (error_) {
                // Remove optimistic message on send failure and undo optimistic state
                setIsRegenerating(false);
                setOptimisticMessages((previous) => previous.filter((m) => m.id !== optimisticId));

                trackEvent("stream_error", {
                    error_type: error_ instanceof Error ? error_.message : "unknown",
                    model,
                });

                handleError(error_);

                if (error_ instanceof Error && (error_.message.includes("401") || error_.message.includes("403"))) {
                    refetchSession();
                }
            }
        },
        [
            authGate,
            threadId,
            model,
            threadData,
            navigate,
            queryClient,
            refetchSession,
            handleError,
            getPendingSettingsFromStore,
            getChangedSettings,
            defaultLanguage,
            setTransitioningMessage,
            crpc,
            localTarget,
            sendLocalTurn,
            startTurn,
            t,
        ],
    );

    const cancelStream = useCallback(async () => {
        // Clear optimistic streaming state immediately so the placeholder disappears
        setIsRegenerating(false);

        // A local reply is stopped in the browser; what arrived so far is still saved.
        if (cancelLocalTurn()) {
            trackEvent("stream_cancelled", { model });

            return;
        }

        if (streamingMessageRef.current) {
            trackEvent("stream_cancelled", { model });

            try {
                await abortStreamMutation({
                    messageId: streamingMessageRef.current.messageId,
                    threadId: streamingMessageRef.current.threadId as Id<"threads">,
                });
            } catch (abortError) {
                providerLogger.error("[ChatProvider] Failed to abort", { error: abortError });
            }

            streamingMessageRef.current = null;
        }
    }, [abortStreamMutation, setIsRegenerating, model, cancelLocalTurn]);

    const reloadMessage = useCallback(
        async (messageId: string) => {
            // Clear any previous error when retrying
            setError(null);

            if (!threadId || !isAuthenticated) {
                return;
            }

            // Through the ref, so the actions context (every message row reads it)
            // does not change on every message update.
            const currentMessages = messagesRef.current;
            const messageIndex = currentMessages.findIndex((m) => m.id === messageId);

            if (messageIndex === -1) {
                return;
            }

            let userMessageIndex = -1;

            for (let i = messageIndex - 1; i >= 0; i -= 1) {
                if (currentMessages[i]?.role === "user") {
                    userMessageIndex = i;
                    break;
                }
            }

            if (userMessageIndex === -1) {
                return;
            }

            const userMessage = currentMessages[userMessageIndex];

            if (!userMessage) {
                return;
            }

            const turn = startTurn();

            // Optimistically hide all messages after the user message
            const messagesToHide = currentMessages.slice(userMessageIndex + 1).map((m) => m.id);

            if (messagesToHide.length > 0) {
                setHiddenMessageIds((previous) => {
                    const next = new Set(previous);

                    for (const id of messagesToHide) {
                        next.add(id);
                    }

                    return next;
                });
            }

            // A local model regenerates in the browser; the reply is saved as a sibling.
            if (localTarget) {
                await sendLocalTurn({
                    branch: { kind: "regenerate", messageId: userMessage.id },
                    history: currentMessages.slice(0, userMessageIndex),
                    onNotSaved: (message) => {
                        setHiddenMessageIds(unhiding(messagesToHide));

                        if (message) {
                            handleError(localModelError(message));
                        }
                    },
                    onSaved: ({ message }) => {
                        trackEvent("message_regenerated", { model });

                        if (message) {
                            handleError(localModelError(message));
                        }
                    },
                    prompt: userMessage.text,
                    systemPrompt: threadData?.customSystemPrompt,
                    threadId,
                });

                return;
            }

            // Set optimistic regenerating state to show "Thinking..." immediately
            setIsRegenerating(true);

            try {
                // Only send settings that have changed from cached values
                const changedSettings = getChangedSettings(threadData);

                const reloadMode = useModelStore.getState().getComposerMode(threadId || undefined);
                const requestBody: Record<string, unknown> = {
                    language: defaultLanguage,
                    mode: reloadMode,
                    model,
                    parentId: userMessage.id,
                    prompt: userMessage.text,
                    regenerate: true,
                    threadId,
                };

                if (changedSettings) {
                    Object.assign(requestBody, changedSettings);
                }

                const response = await fetch(CHAT_STREAM_URL, {
                    body: JSON.stringify(requestBody),
                    headers: {
                        "Content-Type": "application/json",
                        ...(jwtToken && { Authorization: `Bearer ${jwtToken}` }),
                    },
                    method: "POST",
                });

                if (!response.ok) {
                    const errorData = (await response.json()) as { error?: string; message?: string };

                    throw new Error(errorData.message || errorData.error || `HTTP ${response.status}`);
                }

                const data = (await response.json()) as {
                    contentType?: "text" | "image" | "audio" | "video";
                    gatewayUrl?: string;
                    messageId?: string;
                    streamId?: string | null;
                    streamingConfig?: { contentType: string; imageSize?: string; model: string };
                    streamToken?: string;
                    threadId?: string;
                };

                if (data.messageId && data.threadId) {
                    streamingMessageRef.current = { messageId: data.messageId, threadId: data.threadId };
                    trackEvent("message_regenerated", { model });

                    // The regenerated reply's own stream, as after a send — never the previous one.
                    if (turn === turnRef.current && data.streamId && data.streamToken) {
                        setGatewayInfo({ gatewayUrl: validateGatewayUrl(data.gatewayUrl), streamId: data.streamId, streamToken: data.streamToken });
                    }

                    // Media has no text stream: the reply is generated by `/chat/media`,
                    // as after a send, and shows its own pending placeholder.
                    if (data.contentType && data.contentType !== "text" && data.streamingConfig) {
                        setIsRegenerating(false);

                        fetch(`${env.VITE_LLM_GATEWAY_URL}/v1/chat/media`, {
                            body: JSON.stringify({ messageId: data.messageId, streamingConfig: data.streamingConfig, threadId: data.threadId }),
                            headers: {
                                "Content-Type": "application/json",
                                ...(jwtToken && { Authorization: `Bearer ${jwtToken}` }),
                            },
                            method: "POST",
                        }).catch((error_) => {
                            providerLogger.error("[ChatProvider] Media regenerate failed", { error: error_ });
                        });
                    }
                }
            } catch (error_) {
                // Restore hidden messages and clear regenerating state on error
                setIsRegenerating(false);

                if (messagesToHide.length > 0) {
                    setHiddenMessageIds((previous) => {
                        const next = new Set(previous);

                        for (const id of messagesToHide) {
                            next.delete(id);
                        }

                        return next;
                    });
                }

                handleError(error_);
            }
        },
        [threadId, isAuthenticated, threadData, jwtToken, model, handleError, getChangedSettings, defaultLanguage, localTarget, sendLocalTurn, startTurn],
    );

    const editMessage = useCallback(
        async (messageId: string, newText: string) => {
            // Clear any previous error when editing
            setError(null);

            if (!threadId || !isAuthenticated) {
                return;
            }

            const currentMessages = messagesRef.current;
            const messageIndex = currentMessages.findIndex((m) => m.id === messageId);

            if (messageIndex === -1) {
                return;
            }

            const message = currentMessages[messageIndex];

            if (!message || message.role !== "user") {
                return;
            }

            startTurn();

            // Optimistically hide all messages after the edited message and show "Thinking..."
            const messagesToHide = currentMessages.slice(messageIndex + 1).map((m) => m.id);

            if (messagesToHide.length > 0) {
                setHiddenMessageIds((previous) => {
                    const next = new Set(previous);

                    for (const id of messagesToHide) {
                        next.add(id);
                    }

                    return next;
                });
            }

            // A local model answers the edit in the browser; prompt and reply are saved as a sibling branch.
            if (localTarget) {
                const optimisticId = `optimistic-edit-${Date.now()}`;

                const optimisticEdit: UIMessage = {
                    _creationTime: Date.now(),
                    id: optimisticId,
                    key: optimisticId,
                    order: Number.MAX_SAFE_INTEGER,
                    parts: [{ text: newText, type: "text" }],
                    role: "user",
                    status: "pending",
                    stepOrder: 0,
                    text: newText,
                };

                setOptimisticMessages((previous) => [...previous, optimisticEdit]);

                await sendLocalTurn({
                    branch: { kind: "edit", messageId },
                    history: currentMessages.slice(0, messageIndex),
                    onNotSaved: (notSaved) => {
                        setOptimisticMessages(withoutMessage(optimisticId));
                        setHiddenMessageIds(unhiding(messagesToHide));

                        if (notSaved) {
                            handleError(localModelError(notSaved));
                        }
                    },
                    onSaved: ({ message: saveWarning }) => {
                        trackEvent("message_edited", {});

                        if (saveWarning) {
                            handleError(localModelError(saveWarning));
                        }
                    },
                    prompt: newText,
                    systemPrompt: threadData?.customSystemPrompt,
                    threadId,
                });

                return;
            }

            setIsRegenerating(true);

            try {
                const requestBody = {
                    content: [{ text: newText, type: "text" as const }],
                    messageId,
                    // Routes the edit to the thread owner's shard (a shared thread lives there).
                    threadId,
                };

                const response = await fetch(CHAT_EDIT_URL, {
                    body: JSON.stringify(requestBody),
                    headers: {
                        "Content-Type": "application/json",
                        ...(jwtToken && { Authorization: `Bearer ${jwtToken}` }),
                    },
                    method: "POST",
                });

                if (!response.ok) {
                    const errorData = (await response.json()) as { error?: string; message?: string };

                    throw new Error(errorData.message || errorData.error || `HTTP ${response.status}`);
                }

                const data = (await response.json()) as { messageId?: string; threadId?: string };

                if (data.messageId && data.threadId) {
                    streamingMessageRef.current = { messageId: data.messageId, threadId: data.threadId };
                    trackEvent("message_edited", {});
                }
            } catch (error_) {
                // Restore hidden messages and clear regenerating state on error
                setIsRegenerating(false);

                if (messagesToHide.length > 0) {
                    setHiddenMessageIds((previous) => {
                        const next = new Set(previous);

                        for (const id of messagesToHide) {
                            next.delete(id);
                        }

                        return next;
                    });
                }

                handleError(error_);
            }
        },
        [threadId, isAuthenticated, jwtToken, handleError, localTarget, sendLocalTurn, threadData, startTurn],
    );

    const copyMessage = useCallback((messageId: string) => {
        const message = messagesRef.current.find((m) => m.id === messageId);

        if (!message) {
            return;
        }

        // Without an attached page's wrapped text (see `getVisibleUserText`).
        const textContent = getVisibleUserText(message);

        if (textContent) {
            navigator.clipboard
                .writeText(textContent)
                .then(() => {
                    useChatUIStore.getState().setCopiedMessageId(messageId);
                    trackEvent("message_copied", { role: message.role });

                    return undefined;
                })
                .catch((copyError: unknown) => {
                    // Clipboard access can be denied (permissions, insecure origin).
                    providerLogger.error("Failed to copy message to clipboard", copyError);
                });
        }
    }, []);

    /**
     * Regenerate the last assistant message
     * Similar to AI SDK's regenerate() function
     */
    const regenerate = useCallback(async () => {
        // Find the last assistant message
        const lastAssistantMessage = messagesRef.current.findLast((m) => m.role === "assistant");

        if (lastAssistantMessage) {
            await reloadMessage(lastAssistantMessage.id);
        }
    }, [reloadMessage]);

    // Derived isEmpty boolean — only changes when empty↔non-empty transitions,
    // not on every message update during streaming
    const isEmpty = isNewThread || (isMessagesReady ? messages.length === 0 : false);

    // --- Split context values with individual useMemo ---

    const threadContextValue = useMemo((): ChatThreadContextValue => {
        return {
            isNewThread,
            model,
            thread,
            threadId,
        };
    }, [threadId, thread, isNewThread, model]);

    const messagesContextValue = useMemo((): ChatMessagesContextValue => {
        return {
            isEmpty,
            loadMore,
            messages,
            messagesReady: isMessagesReady,
            messagesStatus,
        };
    }, [messages, messagesStatus, isMessagesReady, isEmpty, loadMore]);

    const streamingContextValue = useMemo((): ChatStreamingContextValue => {
        return {
            activeStreamId,
            gatewayUrl: gatewayInfo.gatewayUrl,
            isStreaming,
            pendingStreamId: gatewayInfo.streamId,
            streamingMessageId,
            streamToken: gatewayInfo.streamToken,
        };
    }, [isStreaming, streamingMessageId, activeStreamId, gatewayInfo]);

    const actionsContextValue = useMemo((): ChatActionsContextValue => {
        return {
            cancelStream,
            capabilities,
            clearError,
            copyMessage,
            editMessage,
            error,
            jwtToken,
            lunora,
            regenerate,
            reloadMessage,
            sendMessage,
        };
    }, [sendMessage, cancelStream, reloadMessage, editMessage, copyMessage, clearError, regenerate, error, lunora, jwtToken]);

    return (
        <ChatThreadContext value={threadContextValue}>
            <ChatMessagesContext value={messagesContextValue}>
                <ChatStreamingContext value={streamingContextValue}>
                    <ChatActionsContext value={actionsContextValue}>{children}</ChatActionsContext>
                </ChatStreamingContext>
            </ChatMessagesContext>
        </ChatThreadContext>
    );
};

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
