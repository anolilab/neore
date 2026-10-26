import type { Id } from "@neore/backend/dataModel";
import type { QueryClient } from "@tanstack/react-query";
import type { HistoryState, useNavigate } from "@tanstack/react-router";
import type { Dispatch, RefObject, SetStateAction } from "react";

import type useLocalModelTurn from "@/features/local-models/hooks/use-local-model-turn";
import type { UIMessage } from "@/lib/agent";
import { trackEvent } from "@/lib/analytics";
import { AppError } from "@/lib/errors";
import { providerLogger } from "@/lib/logger";
import type { useCRPC } from "@/lib/lunora/crpc";
import { withUnlockProofBody } from "@neore/client-runtime";

import { DEFAULT_MESSAGE_OPTS } from "../constants/query-options";
import type { PendingAttachment } from "../stores/chat-ui-store";
import { useChatUIStore } from "../stores/chat-ui-store";
import type { PendingSettings } from "../stores/model-store";
import { useModelStore } from "../stores/model-store";
import { newChatTemporaryFields } from "../utils/new-chat-temporary";
import type { ReadinessGate } from "../utils/readiness-gate";
import type { ChangedSettings, ChatActionBase } from "./chat-action-shared";
import { localModelError, withoutMessage } from "./chat-action-shared";
import type { ThreadData, ThreadRow } from "./chat-context-types";
import type { GatewayErrorBody, GatewayInfo } from "./chat-gateway";
import { CHAT_STREAM_URL, gatewayError, pendingGatewayInfo, validateGatewayUrl } from "./chat-gateway";
import type { KickOffMedia } from "./media-kickoff";

/** How long a send waits for the session before handing the text back. */
const AUTH_READY_TIMEOUT_MS = 10_000;

/** User-facing strings the send body needs, as thunks so the `t` templates stay in the provider where Lingui compiles them. */
export interface SendMessageTexts {
    bannedContent: () => string;
    localTextOnly: () => string;
    sessionNotReady: () => string;
}

export interface SendMessageEnv extends ChatActionBase {
    authGate: ReadinessGate;
    crpc: ReturnType<typeof useCRPC>;
    defaultLanguage: string;
    getChangedSettings: (currentThreadData: ThreadData | ThreadRow | null | undefined) => ChangedSettings | null;
    getPendingSettingsFromStore: () => PendingSettings | null;
    isMountedRef: RefObject<boolean>;
    kickOffMedia: KickOffMedia;
    localTarget: ReturnType<typeof useLocalModelTurn>["target"];
    model: string;
    navigate: ReturnType<typeof useNavigate>;
    newChatsTemporary: boolean;
    queryClient: QueryClient;
    refetchSession: () => unknown;
    sendLocalTurn: ReturnType<typeof useLocalModelTurn>["send"];
    setGatewayInfo: Dispatch<SetStateAction<GatewayInfo>>;
    setOptimisticMessages: Dispatch<SetStateAction<UIMessage[]>>;
    setTransitioningMessage: (message: { text: string; threadId: string }) => void;
    startTurn: () => number;
    texts: SendMessageTexts;
    threadDataRef: RefObject<ThreadRow | null | undefined>;
    turnRef: RefObject<number>;
}

/** The body of the provider's `sendMessage`: one user turn, local or through the gateway. */
export const runSendMessage = async (env: SendMessageEnv, text: string, attachments?: PendingAttachment[]) => {
    const {
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
        texts,
        threadDataRef,
        threadId,
        turnRef,
    } = env;

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
                new AppError(texts.sessionNotReady(), {
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
            restoreComposer(texts.localTextOnly());

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
            systemPrompt: isCreatingNewThread ? pendingSettings?.customSystemPrompt : threadDataRef.current?.customSystemPrompt,
            temporary: isCreatingNewThread ? newChatTemporaryFields(pendingSettings, newChatsTemporary) : undefined,
            threadId,
        });

        return;
    }

    const { attachedReferences } = useChatUIStore.getState();
    // The pending settings are taken out of the store before the request; a send that fails puts them back with the draft.
    let consumedSettings: PendingSettings | null = null;
    // The thread the composer showed when the settings were taken: a late failure must not hand them to another thread,
    // nor to another new-chat composer (which has no thread id either; this provider is gone by then).
    const consumedFromThread = useModelStore.getState().selectedModelThreadId;
    const restoreSettings = () => {
        const consumed = consumedSettings;

        if (!consumed || !isMountedRef.current || useModelStore.getState().selectedModelThreadId !== consumedFromThread) {
            return;
        }

        useModelStore.getState().setPendingSettings((previous) => {
            return { ...consumed, ...previous };
        });
    };

    try {
        // For new threads: send all pending settings
        // For existing threads: only send settings that have changed from cached values
        const pendingSettings = isCreatingNewThread ? getPendingSettingsFromStore() : null;
        const changedSettings = isCreatingNewThread ? null : getChangedSettings(threadDataRef.current);

        consumedSettings = pendingSettings ?? changedSettings;

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

            Object.assign(requestBody, newChatTemporaryFields(pendingSettings, newChatsTemporary));
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
            body: JSON.stringify(withUnlockProofBody(requestBody, threadId)),
            headers: {
                "Content-Type": "application/json",
                ...authHeader(),
            },
            method: "POST",
        });

        if (!response.ok) {
            const errorData = (await response.json().catch(() => {
                return {};
            })) as GatewayErrorBody;

            if (errorData.error === "BANNED_CONTENT") {
                // Restore composer text so the user can edit their message
                setIsRegenerating(false);
                setOptimisticMessages(withoutMessage(optimisticId));
                useChatUIStore.getState().setComposerText(text);
                restoreSettings();
                useChatUIStore.getState().setComposerBannedContent({
                    message: errorData.message ?? texts.bannedContent(),
                    words: errorData.bannedWords ?? [],
                });

                return;
            }

            throw gatewayError(response.status, errorData);
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
                // `threadId` routes the call to the thread owner's shard.
                void kickOffMedia({ messageId: data.messageId, streamingConfig: data.streamingConfig, threadId: data.threadId }, () => {
                    setIsRegenerating(false);
                });
            }
        }
    } catch (error_) {
        // Remove optimistic message on send failure and undo optimistic state
        setIsRegenerating(false);
        setOptimisticMessages(withoutMessage(optimisticId));

        trackEvent("stream_error", {
            error_type: error_ instanceof Error ? error_.message : "unknown",
            model,
        });

        // The composer was cleared before the request; hand the draft back unless a new one is there.
        useChatUIStore.getState().restoreComposer({ attachedReferences, composerAttachments: attachments ?? [], composerText: text });
        restoreSettings();

        handleError(error_);

        if (error_ instanceof Error && (error_.message.includes("401") || error_.message.includes("403"))) {
            refetchSession();
        }
    }
};
