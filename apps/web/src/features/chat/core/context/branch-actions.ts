import type { Dispatch, RefObject, SetStateAction } from "react";

import type useLocalModelTurn from "@/features/local-models/hooks/use-local-model-turn";
import type { UIMessage } from "@/lib/agent";
import { trackEvent } from "@/lib/analytics";
import { withUnlockProofBody } from "@neore/client-runtime";

import { useModelStore } from "../stores/model-store";
import type { ChangedSettings, ChatActionBase } from "./chat-action-shared";
import { localModelError, unhiding, withoutMessage } from "./chat-action-shared";
import type { ThreadData, ThreadRow } from "./chat-context-types";
import type { GatewayErrorBody, GatewayInfo } from "./chat-gateway";
import { CHAT_EDIT_URL, CHAT_STREAM_URL, gatewayError, validateGatewayUrl } from "./chat-gateway";
import type { KickOffMedia } from "./media-kickoff";

interface BranchActionEnv extends ChatActionBase {
    isAuthenticated: boolean;
    localTarget: ReturnType<typeof useLocalModelTurn>["target"];
    sendLocalTurn: ReturnType<typeof useLocalModelTurn>["send"];
    setHiddenMessageIds: Dispatch<SetStateAction<Set<string>>>;
    startTurn: () => number;
    threadDataRef: RefObject<ThreadRow | null | undefined>;
}

export interface ReloadMessageEnv extends BranchActionEnv {
    defaultLanguage: string;
    getChangedSettings: (currentThreadData: ThreadData | ThreadRow | null | undefined) => ChangedSettings | null;
    kickOffMedia: KickOffMedia;
    model: string;
    setGatewayInfo: Dispatch<SetStateAction<GatewayInfo>>;
    turnRef: RefObject<number>;
}

export interface EditMessageEnv extends BranchActionEnv {
    setOptimisticMessages: Dispatch<SetStateAction<UIMessage[]>>;
}

/** The body of the provider's `reloadMessage`: regenerates the reply after `messageId` as a sibling. */
export const runReloadMessage = async (env: ReloadMessageEnv, messageId: string) => {
    const {
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
    } = env;

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
            systemPrompt: threadDataRef.current?.customSystemPrompt,
            threadId,
        });

        return;
    }

    // Set optimistic regenerating state to show "Thinking..." immediately
    setIsRegenerating(true);

    try {
        // Only send settings that have changed from cached values
        const changedSettings = getChangedSettings(threadDataRef.current);

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

            throw gatewayError(response.status, errorData);
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

                void kickOffMedia({ messageId: data.messageId, streamingConfig: data.streamingConfig, threadId: data.threadId });
            }
        }
    } catch (error_) {
        // Restore hidden messages and clear regenerating state on error
        setIsRegenerating(false);

        if (messagesToHide.length > 0) {
            setHiddenMessageIds(unhiding(messagesToHide));
        }

        handleError(error_);
    }
};

/** The body of the provider's `editMessage`: replaces the user message `messageId` and answers the new text as a sibling branch. */
export const runEditMessage = async (env: EditMessageEnv, messageId: string, newText: string) => {
    const {
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
    } = env;

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
            systemPrompt: threadDataRef.current?.customSystemPrompt,
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

            throw gatewayError(response.status, errorData);
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
            setHiddenMessageIds(unhiding(messagesToHide));
        }

        handleError(error_);
    }
};
