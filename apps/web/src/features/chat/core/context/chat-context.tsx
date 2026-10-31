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
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import type { Id } from "@neore/backend/dataModel";
import { markdownToPlainText } from "@neore/chat-ui/utils/markdown-text";
import { getVisibleUserText } from "@neore/chat-ui/utils/page-context";
import { registerStreamOfThread } from "@neore/client-runtime";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import useLocalModelTurn from "@/features/local-models/hooks/use-local-model-turn";
import type { UIMessage } from "@/lib/agent";
import { trackEvent } from "@/lib/analytics";
import type { AppError } from "@/lib/errors";
import { providerLogger } from "@/lib/logger";
import { useCRPC, useLunora } from "@/lib/lunora/crpc";
import { notifyNative, shouldNotifyReplyFinished } from "@/lib/native/bridge";

import useHydratedMessages from "../hooks/use-hydrated-messages";
import type { PendingAttachment } from "../stores/chat-ui-store";
import { useChatUIStore } from "../stores/chat-ui-store";
import type { ModelId } from "../stores/model-store";
import { useModelStore } from "../stores/model-store";
import { mapNavigatorLanguage } from "../utils/language-utilities";
import { createReadinessGate } from "../utils/readiness-gate";
import { runEditMessage, runReloadMessage } from "./branch-actions";
import type { ChangedSettings, StreamingMessage } from "./chat-action-shared";
import { stopTarget, toAppError } from "./chat-action-shared";
import { ChatActionsContext, ChatMessagesContext, ChatStreamingContext, ChatThreadContext } from "./chat-context-hooks";
import type {
    ChatActionsContextValue,
    ChatMessagesContextValue,
    ChatStreamingContextValue,
    ChatThreadContextValue,
    ThreadCapabilities,
    ThreadData,
    ThreadRow,
} from "./chat-context-types";
import type { GatewayInfo } from "./chat-gateway";
import { NO_GATEWAY_INFO, pendingGatewayInfo } from "./chat-gateway";
import { kickOffMediaGeneration } from "./media-kickoff";
import { runSendMessage } from "./send-message";
import { registerThreadErrorSink, takeUndeliveredThreadError } from "./thread-error-sinks";

// The context objects, hooks and value types live in sibling files; importers keep this path.
export {
    ChatActionsContext,
    ChatContext,
    ChatMessagesContext,
    ChatStreamingContext,
    ChatThreadContext,
    useChat,
    useChatActions,
    useChatError,
    useChatIsEmpty,
    useChatIsRunning,
    useChatIsStreaming,
    useChatLunora,
    useChatMessages,
    useChatThread,
} from "./chat-context-hooks";
export type {
    ChatActionsContextValue,
    ChatContextValue,
    ChatMessagesContextValue,
    ChatStreamingContextValue,
    ChatThreadContextValue,
} from "./chat-context-types";

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
    // The temporary default for new composer chats (`features/chat/header/temporary-chat-dropdown.tsx` shows it too).
    const newChatsTemporary = userSettings?.newChatsTemporary === true;

    // Memoize default language - only recomputes when userLanguage changes
    const defaultLanguage = useMemo(() => userLanguage || navigatorLanguage, [userLanguage]);

    // Error state
    const [error, setError] = useState<AppError | null>(null);

    const clearError = useCallback(() => {
        setError(null);
    }, []);

    const handleError = useCallback(
        (error_: unknown) => {
            const appError = toAppError(error_);

            setError(appError);
            onError?.(appError);
            providerLogger.error("[ChatProvider] Error occurred", { error: appError });
        },
        [onError],
    );

    useEffect(() => {
        if (!threadId) {
            return undefined;
        }

        const undelivered = takeUndeliveredThreadError(threadId);

        if (undelivered) {
            handleError(undelivered.error);
        }

        return registerThreadErrorSink(threadId, handleError);
    }, [threadId, handleError]);

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

    // Read at send time: the route's token is captured at load and never renewed; the client's is.
    const authHeader = useCallback((): Record<string, string> => {
        const bearer = lunora.getAuthToken() ?? jwtTokenRef.current;

        return bearer ? { Authorization: `Bearer ${bearer}` } : {};
    }, [lunora]);

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

        const changed: ChangedSettings = {};
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
    // The new-chat route and the thread route mount separate providers, so this tells a late failed send whether its composer is still on screen.
    const isMountedRef = useRef(true);
    const previousThreadIdRef = useRef<string | undefined>(undefined);

    // Reset model and language when mounting a new thread view
    // This handles the case when navigating from /chat/$threadId to /chat
    // Read off the store object first: the effect depends on these two members, not
    // on the store snapshot's identity.
    const { resetForNewThread, selectedModelThreadId } = modelStore;

    useEffect(() => {
        isMountedRef.current = true;

        return () => {
            isMountedRef.current = false;
        };
    }, []);

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

    // Read by the send/reload/edit callbacks, so a live push of the thread row does not
    // recreate them (and re-render every message row through the actions context).
    const threadDataRef = useRef(threadData);

    useLayoutEffect(() => {
        threadDataRef.current = threadData;
    }, [threadData]);

    // CRITICAL: Validate that initialThread matches current threadId before using it.
    // During navigation, the component can re-render with NEW threadId but OLD initialThread (from previous route).
    // Only use initialThread if its _id matches the current threadId, otherwise fall back to query data.
    // The live row wins once there is one: it is seeded from `initialThread`, so it equals it until a switch or an
    // edit moves the thread, and the loader's snapshot would otherwise keep showing the creation model after one.
    const thread: ThreadData | null = (threadData as ThreadData | null) ?? (initialThread && initialThread._id === threadId ? initialThread : null) ?? null;

    // Backup sync: when Lunora query resolves with fresh data, update store
    // Only if user hasn't explicitly changed model/mode for this thread
    // Same reasoning as above: depend on the fields the effect reads, not on the
    // identity of the store snapshot or of the thread row.
    const { loadThreadData } = modelStore;
    const hasThread = Boolean(thread);
    // The agent a switched thread's path runs on, else the thread's model.
    const threadModel = thread?.activeAgent?.model ?? thread?.model;
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
            if (threadModel) {
                return threadModel;
            }
        }

        // New thread or fallback: use store's selected model (user's last choice or default)
        return modelStore.selectedModel || DEFAULT_CHAT_MODEL;
    }, [modelProp, modelStore.selectedModel, modelStore.selectedModelThreadId, modelStore.userChangedModel, threadId, threadModel]);

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
    const pause = activeStream?.pause ?? null;

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
    const { mutateAsync: abortThreadStreamMutation } = useMutation(crpc.chat.functions.abortThreadStream.mutationOptions());
    const streamingMessageRef = useRef<StreamingMessage | null>(null);

    // Posts the media kick-off for a reply `/v1/chat` created. A refusal (the daily limit, a 401, a 404) or a
    // dead connection goes to the chat error UI of the thread; `onRefused` clears the caller's sending state.
    const kickOffMedia = useCallback(
        (media: { messageId: string; streamingConfig: { contentType: string; imageSize?: string; model: string }; threadId: string }, onRefused?: () => void) =>
            kickOffMediaGeneration(
                media,
                authHeader(),
                () => t`Could not reach the server to start generating. Check your connection and try again.`,
                onRefused,
            ),
        [authHeader, t],
    );

    const sendMessage = useCallback(
        (text: string, attachments?: PendingAttachment[]) =>
            runSendMessage(
                {
                    authGate,
                    authHeader,
                    crpc,
                    defaultLanguage,
                    getChangedSettings,
                    getPendingSettingsFromStore,
                    handleError,
                    isMountedRef,
                    kickOffMedia,
                    localTarget,
                    messagesRef,
                    model,
                    navigate,
                    newChatsTemporary,
                    queryClient,
                    refetchSession,
                    sendLocalTurn,
                    setError,
                    setGatewayInfo,
                    setIsRegenerating,
                    setOptimisticMessages,
                    setTransitioningMessage,
                    startTurn,
                    streamingMessageRef,
                    texts: {
                        bannedContent: () => t`Your message contains inappropriate content that cannot be sent.`,
                        localTextOnly: () => t`Local models are text only. Remove the attachments to send.`,
                        sessionNotReady: () =>
                            t`We could not confirm your session in time. Your message is still in the composer. Please try sending it again.`,
                    },
                    threadDataRef,
                    threadId,
                    turnRef,
                },
                text,
                attachments,
            ),
        [
            authGate,
            threadId,
            model,
            authHeader,
            navigate,
            queryClient,
            refetchSession,
            handleError,
            getPendingSettingsFromStore,
            getChangedSettings,
            defaultLanguage,
            newChatsTemporary,
            setTransitioningMessage,
            crpc,
            localTarget,
            sendLocalTurn,
            startTurn,
            kickOffMedia,
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

        // The ref is set only by the provider that started the stream; the first reply of a
        // new thread was started on `/chat`, so this thread's provider finds it from the messages.
        if (streamingMessageRef.current?.threadId !== threadId) {
            const streamingId = messagesRef.current.find((m) => m.status === "streaming")?.id;

            streamingMessageRef.current = threadId && streamingId ? { messageId: streamingId, threadId } : null;
        }

        const target = stopTarget({ activeStreamId, streamingMessage: streamingMessageRef.current });

        if (target === "message" && streamingMessageRef.current) {
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
        } else if (target === "thread" && threadId) {
            trackEvent("stream_cancelled", { model });

            try {
                await abortThreadStreamMutation({ threadId: threadId as Id<"threads"> });
            } catch (abortError) {
                providerLogger.error("[ChatProvider] Failed to abort", { error: abortError });
            }
        }
    }, [abortStreamMutation, abortThreadStreamMutation, activeStreamId, setIsRegenerating, model, cancelLocalTurn, threadId]);

    const reloadMessage = useCallback(
        (messageId: string) =>
            runReloadMessage(
                {
                    authHeader,
                    defaultLanguage,
                    getChangedSettings,
                    handleError,
                    isAuthenticated,
                    kickOffMedia,
                    localTarget,
                    messagesRef,
                    model,
                    sendLocalTurn,
                    setError,
                    setGatewayInfo,
                    setHiddenMessageIds,
                    setIsRegenerating,
                    startTurn,
                    streamingMessageRef,
                    threadDataRef,
                    threadId,
                    turnRef,
                },
                messageId,
            ),
        [threadId, isAuthenticated, authHeader, model, handleError, getChangedSettings, defaultLanguage, localTarget, sendLocalTurn, startTurn, kickOffMedia],
    );

    const editMessage = useCallback(
        (messageId: string, newText: string) =>
            runEditMessage(
                {
                    authHeader,
                    handleError,
                    isAuthenticated,
                    localTarget,
                    messagesRef,
                    sendLocalTurn,
                    setError,
                    setHiddenMessageIds,
                    setIsRegenerating,
                    setOptimisticMessages,
                    startTurn,
                    streamingMessageRef,
                    threadDataRef,
                    threadId,
                },
                messageId,
                newText,
            ),
        [threadId, isAuthenticated, authHeader, handleError, localTarget, sendLocalTurn, startTurn],
    );

    const copyMessage = useCallback((messageId: string, format: "markdown" | "plain" = "markdown") => {
        const message = messagesRef.current.find((m) => m.id === messageId);

        if (!message) {
            return;
        }

        // Without an attached page's wrapped text (see `getVisibleUserText`).
        const markdown = getVisibleUserText(message);
        const textContent = format === "plain" ? markdownToPlainText(markdown) : markdown;

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
            isLocalModel: localTarget !== undefined,
            isLocalStreaming,
            isStreaming,
            pause,
            pendingStreamId: gatewayInfo.streamId,
            streamingMessageId,
            streamToken: gatewayInfo.streamToken,
        };
    }, [isStreaming, isLocalStreaming, localTarget, streamingMessageId, activeStreamId, gatewayInfo, pause]);

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
