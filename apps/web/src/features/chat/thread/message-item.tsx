"use client";

/**
 * MessageItem - Single message container with hover/copy state
 *
 * Receives UIMessage as prop and renders the appropriate layout
 * based on message role (user, assistant, system).
 */

import { Trans, useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { getVisibleUserText } from "@neore/chat-ui/utils/page-context";
import { Message, MessageAction, MessageActions, MessageContent as MessageContentWrapper } from "@neore/ui/components/ai-elements/message";
import cn from "@neore/ui/utils/cn";
import { formatNumber } from "@neore/ui/utils/locale-format";
import { useMutation } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, Gauge, GitBranch, Hash, ImageIcon, MicIcon, PencilIcon, PinIcon, RefreshCwIcon, Timer, VideoIcon } from "lucide-react";
import type { FC, ReactNode } from "react";
import { memo, useCallback, useState } from "react";

import { useChatActions, useChatThread } from "@/features/chat/core/context/chat-context";
import { useThreadManager } from "@/features/chat/core/hooks/use-thread-manager";
import { isValidThreadId } from "@/features/chat/core/hooks/use-validated-thread";
import { useChatUIStore, useMessageInteractionState } from "@/features/chat/core/stores/chat-ui-store";
import MessageSelectCheckbox from "@/features/chat/forward/message-select-checkbox";
import SelectMessagesAction from "@/features/chat/forward/select-messages-action";
import { MessageSpeakerLabel } from "@/features/chat/group/speaker-label";
import MessageTranslation from "@/features/chat/translation/message-translation";
import TranslateAction from "@/features/chat/translation/translate-action";
import SaveEvalCaseAction from "@/features/evals/components/save-eval-case-action";
import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";
import type { UIMessage } from "@/lib/agent";
import { trackEvent } from "@/lib/analytics";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

import ForkBranchDialog from "./fork-branch-dialog";
import GenerationModelMenu from "./generation-model-menu";
import MemoryUsageAction from "./memory-usage-action";
import MessageBranchSwitcher from "./message-branch-switcher";
import MessageContent from "./message-content";
import MessageCostBadge from "./message-cost-badge";
import MessageModelBadge from "./message-model-badge";
import ReadAloudAction from "./read-aloud-action";
import RestoreToInputAction from "./restore-to-input-action";

/** Format tokens/sec as "220.65 tok/s". */
const formatTokPerSec = (tokPerSec: number): string => `${tokPerSec.toFixed(1)} tok/s`;

/** Format a duration in milliseconds to a compact string like "0.41s". */
const formatDuration = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;

/** Renders tok/s, total tokens, first-token latency and cost for a completed assistant message. */
const MessageStatsBar: FC<{ cost: UIMessage["cost"]; usage: UIMessage["usage"] }> = ({ cost, usage }) => {
    const { i18n } = useLingui();

    if (!usage && !cost) {
        return null;
    }

    const completionTokens = usage?.completionTokens ?? 0;
    const durationMs = usage?.durationMs;
    const ttftMs = usage?.ttftMs;
    const tokPerSec = durationMs && durationMs > 0 && completionTokens > 0 ? (completionTokens / durationMs) * 1000 : null;

    if (tokPerSec === null && completionTokens === 0 && ttftMs === undefined && !cost) {
        return null;
    }

    return (
        <div className="text-muted-foreground flex items-center gap-3 text-xs">
            {tokPerSec !== null && (
                <span className="flex items-center gap-1">
                    <Gauge aria-hidden="true" className="size-3 shrink-0" />
                    {formatTokPerSec(tokPerSec)}
                </span>
            )}
            {completionTokens > 0 && (
                <span className="flex items-center gap-1">
                    <Hash aria-hidden="true" className="size-3 shrink-0" />
                    {formatNumber(completionTokens, i18n.locale)} tok
                </span>
            )}
            {ttftMs !== undefined && (
                <span className="flex items-center gap-1">
                    <Timer aria-hidden="true" className="size-3 shrink-0" />
                    {formatDuration(ttftMs)}
                </span>
            )}
            {cost && <MessageCostBadge cost={cost} usage={usage} />}
        </div>
    );
};

interface MessageItemProps {
    className?: string;
    components?: {
        ActionBar?: FC<ActionBarProps>;
        AssistantMessage?: FC<AssistantMessageRendererProps>;
        SystemMessage?: FC<SystemMessageRendererProps>;
        UserMessage?: FC<UserMessageRendererProps>;
    };
    index: number;
    isLast?: boolean;
    isStreaming?: boolean;
    maxWidth?: string;
    message: UIMessage;
}

interface UserMessageRendererProps {
    actionBar?: ReactNode;
    children: ReactNode;
    isLast?: boolean;
    isPending?: boolean;
}

interface AssistantMessageRendererProps {
    actionBar?: ReactNode;
    children: ReactNode;
    isLast?: boolean;
    message: UIMessage;
}

interface SystemMessageRendererProps {
    children: ReactNode;
}

interface ActionBarProps {
    isCopied: boolean;
    isHovered: boolean;
    isStreaming: boolean;
    message: UIMessage;
    messageIndex: number;
    onCopy: () => void;
    onEdit?: () => void;
    onReload?: () => void;
}

/**
 * Default User Message renderer
 * Uses Message and MessageContentWrapper from AI elements.
 */
const DefaultUserMessage: FC<UserMessageRendererProps> = ({ actionBar, children, isLast, isPending }) => (
    <Message
        className={cn(
            "relative grid w-full max-w-(--thread-max-width) auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] gap-y-2 [&:where(>*)]:col-start-2",
            isLast ? "pb-0" : "pb-6",
            isPending && "opacity-70",
        )}
        from="user"
    >
        <span className="sr-only">
            <Trans>Your message:</Trans>{" "}
        </span>
        {/* Attachments would go here */}
        <MessageContentWrapper className="col-start-2 row-start-2 rounded-3xl px-5 py-2.5 wrap-break-word">{children}</MessageContentWrapper>
        {!isPending && actionBar}
    </Message>
);

/**
 * Default Assistant Message renderer
 * Uses Message and MessageContentWrapper from AI elements.
 */
const DefaultAssistantMessage: FC<AssistantMessageRendererProps> = ({ actionBar, children, isLast, message }) => {
    // `UIMessage["metadata"]` is generic and resolves to `unknown` here; the agent tags rate-limit
    // failures with `errorType`.
    const hasRateLimitError = (message.metadata as { errorType?: string } | undefined)?.errorType === "rate_limit";

    return (
        <Message
            className={cn("relative grid w-full max-w-(--thread-max-width) grid-cols-[auto_auto_1fr] grid-rows-[auto_1fr] gap-y-2", isLast ? "pb-0" : "pb-6")}
            from="assistant"
        >
            <span className="sr-only">
                <Trans>Assistant Reply:</Trans>{" "}
            </span>
            <MessageContentWrapper
                className={cn(
                    "col-span-2 col-start-2 row-start-1 leading-7 wrap-break-word",
                    hasRateLimitError ? "text-destructive dark:text-red-400" : "text-foreground dark:text-white",
                )}
            >
                <MessageSpeakerLabel message={message} />
                {children}
                <MessageTranslation message={message} />
            </MessageContentWrapper>
            {actionBar}
        </Message>
    );
};

/**
 * Default System Message renderer
 * Uses Message and MessageContentWrapper from AI elements.
 */
const DefaultSystemMessage: FC<SystemMessageRendererProps> = ({ children }) => (
    <Message
        className="mx-auto mb-4 max-w-(--thread-max-width) rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400"
        from="system"
    >
        <span className="sr-only">
            <Trans>System message:</Trans>{" "}
        </span>
        <MessageContentWrapper>{children}</MessageContentWrapper>
    </Message>
);

/**
 * Default Action Bar - Full featured with image/video/voice generation
 * Uses MessageActions and MessageAction from AI elements
 */
const DefaultActionBar: FC<ActionBarProps> = memo(({ isCopied, isHovered, isStreaming, message, messageIndex, onCopy, onEdit, onReload }) => {
    const { model: currentModel, threadId } = useChatThread();
    const models = useFeatureFlaggedModels();
    const crpc = useCRPC();
    const setActiveRightSidebarTab = useChatUIStore((state) => state.setActiveRightSidebarTab);
    const { createBranch } = useThreadManager(true);
    const [isForkDialogOpen, setIsForkDialogOpen] = useState(false);
    const { mutate: createPin } = useMutation(crpc.chat.pins.functions.createPin.mutationOptions());
    const { t } = useLingui();

    // Hide action bar while streaming
    if (isStreaming) {
        return null;
    }

    const isTextModel = (models.find((m) => m.id === currentModel)?.mode ?? "text") === "text";

    // Compute mode-specific models from hook data
    const imageModel = models.find((m) => m.enabled && m.mode === "image");
    const videoModel = models.find((m) => m.enabled && m.mode === "video");
    const voiceModel = models.find((m) => m.enabled && m.mode === "speech-to-text");

    // Check if message has copyable content
    const hasCopyableContent = message.parts.some((p) => p.type === "text" && p.text.length > 0);

    // Compute the text content from message parts once
    // Excludes an attached web page's wrapped text (see `getVisibleUserText`).
    const messageText = getVisibleUserText(message);

    const handleForkBranch = () => {
        if (!isValidThreadId(threadId)) {
            return;
        }

        setIsForkDialogOpen(true);
    };

    const handleCreateBranch = async (branchTitle: string) => {
        if (!isValidThreadId(threadId)) {
            setIsForkDialogOpen(false);

            return;
        }

        try {
            await createBranch(threadId, messageIndex, branchTitle, message.id);
            setIsForkDialogOpen(false);
        } catch (error) {
            console.error("Failed to create branch:", error);
            throw error;
        }
    };

    const handlePin = () => {
        if (!threadId) {
            return;
        }

        createPin(
            // `threadId` comes from the chat context, which is seeded from the
            // `/chat/$threadId` route param, so it is a plain string naming a real thread.
            { messageId: message.id, messageRole: message.role, selectedText: messageText || undefined, threadId: threadId as Id<"threads"> },
            {
                onError: (error) => showError(error as Error),
                onSuccess: () => {
                    trackEvent("message_pinned", { has_note: false });
                    setActiveRightSidebarTab("pins");
                },
            },
        );
    };

    const isAssistant = message.role === "assistant";
    const isUser = message.role === "user";

    return (
        <>
            <MessageActions
                className={cn(
                    "transition-opacity",
                    isUser ? "col-start-2 row-start-3 -ml-1 justify-end" : "col-start-3 row-start-2 -ml-1",
                    // A message with alternatives keeps its bar visible so the
                    // version switcher is discoverable; focus reveals it for keyboards.
                    isHovered || message.branch ? "opacity-100" : "opacity-0 focus-within:opacity-100",
                )}
            >
                {message.branch && isValidThreadId(threadId) && <MessageBranchSwitcher branch={message.branch} threadId={threadId} />}

                <MessageAction onClick={onCopy} tooltip={isCopied ? t`Copied!` : t`Copy`}>
                    {isCopied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
                </MessageAction>

                {(isAssistant || isUser) && isTextModel && (
                    <MessageAction onClick={handlePin} tooltip={t`Pin message`}>
                        <PinIcon className="size-4" />
                    </MessageAction>
                )}

                {isAssistant && onReload && (
                    <MessageAction onClick={onReload} tooltip={t`Regenerate`}>
                        <RefreshCwIcon className="size-4" />
                    </MessageAction>
                )}

                {isUser && onEdit && (
                    <MessageAction onClick={onEdit} tooltip={t`Edit`}>
                        <PencilIcon className="size-4" />
                    </MessageAction>
                )}

                {isUser && <RestoreToInputAction message={message} />}

                {(isAssistant || isUser) && isTextModel && <SelectMessagesAction messageId={message.id} />}

                {isAssistant && isValidThreadId(threadId) && (
                    <MessageAction onClick={handleForkBranch} tooltip={t`Fork conversation`}>
                        <GitBranch className="size-4" />
                    </MessageAction>
                )}

                {isAssistant && hasCopyableContent && <ReadAloudAction messageId={message.id} text={messageText} />}

                {isAssistant && hasCopyableContent && <TranslateAction messageId={message.id} />}

                {isAssistant && message.memoryUsage && <MemoryUsageAction usage={message.memoryUsage} />}

                {isAssistant && hasCopyableContent && isTextModel && <SaveEvalCaseAction message={message} />}

                {isAssistant && hasCopyableContent && imageModel && (
                    <GenerationModelMenu
                        icon={<ImageIcon className="size-4" />}
                        messageText={messageText}
                        mode="image"
                        threadId={threadId}
                        tooltip={t`Generate image`}
                    />
                )}

                {isAssistant && hasCopyableContent && videoModel && (
                    <GenerationModelMenu
                        icon={<VideoIcon className="size-4" />}
                        messageText={messageText}
                        mode="video"
                        threadId={threadId}
                        tooltip={t`Generate video`}
                    />
                )}

                {isAssistant && hasCopyableContent && voiceModel && (
                    <GenerationModelMenu
                        icon={<MicIcon className="size-4" />}
                        messageText={messageText}
                        mode="speech-to-text"
                        threadId={threadId}
                        tooltip={t`Generate voice`}
                    />
                )}

                {isAssistant && (
                    <>
                        <div className="grow" />
                        <MessageStatsBar cost={message.cost} usage={message.usage} />
                        <div className="grow" />
                        <MessageModelBadge model={message.model} />
                    </>
                )}
            </MessageActions>

            {isAssistant && <ForkBranchDialog onCancel={() => setIsForkDialogOpen(false)} onCreate={handleCreateBranch} open={isForkDialogOpen} />}
        </>
    );
});

DefaultActionBar.displayName = "DefaultActionBar";

/**
 * Main MessageItem component
 */
const EMPTY_COMPONENTS: NonNullable<MessageItemProps["components"]> = {};

const MessageItem: FC<MessageItemProps> = memo(
    ({ className, components = EMPTY_COMPONENTS, index, isLast = false, isStreaming = false, maxWidth = "var(--thread-max-width)", message }) => {
        const {
            ActionBar = DefaultActionBar,
            AssistantMessage = DefaultAssistantMessage,
            SystemMessage = DefaultSystemMessage,
            UserMessage = DefaultUserMessage,
        } = components;

        // Interaction state
        const { isCopied, isHovered, setHovered } = useMessageInteractionState(message.id);

        // Actions
        const { copyMessage, reloadMessage } = useChatActions();

        // Edit state - use separate selectors to avoid creating new objects
        const startEditing = useChatUIStore((state) => state.startEditing);

        const messageIsStreaming = isStreaming || message.status === "streaming";

        // Handlers
        const handleMouseEnter = useCallback(() => {
            if (!messageIsStreaming) {
                setHovered(true);
            }
        }, [messageIsStreaming, setHovered]);

        const handleMouseLeave = useCallback(() => {
            setHovered(false);
        }, [setHovered]);

        const handleCopy = useCallback(() => {
            copyMessage(message.id);
        }, [copyMessage, message.id]);

        const handleReload = useCallback(() => {
            reloadMessage(message.id);
        }, [reloadMessage, message.id]);

        const handleEdit = useCallback(() => {
            startEditing(message.id, getVisibleUserText(message));
        }, [startEditing, message]);

        // Render content
        const content = (
            <>
                {message.role !== "system" && <MessageSelectCheckbox disabled={messageIsStreaming || message.status === "pending"} message={message} />}
                <MessageContent isStreaming={messageIsStreaming} message={message} />
            </>
        );

        // Render action bar
        const actionBar = (
            <ActionBar
                isCopied={isCopied}
                isHovered={isHovered}
                isStreaming={messageIsStreaming}
                message={message}
                messageIndex={index}
                onCopy={handleCopy}
                onEdit={message.role === "user" ? handleEdit : undefined}
                onReload={message.role === "assistant" ? handleReload : undefined}
            />
        );

        // Container props
        const containerProps = {
            className: cn("message-item", className),
            "data-message-id": message.id,
            "data-message-index": index,
            "data-message-role": message.role,
            onMouseEnter: handleMouseEnter,
            onMouseLeave: handleMouseLeave,
            style: { "--thread-max-width": maxWidth } as React.CSSProperties,
        };

        // Render based on role
        if (message.role === "user") {
            return (
                <div {...containerProps}>
                    <UserMessage actionBar={actionBar} isLast={isLast} isPending={message.status === "pending"}>
                        {content}
                    </UserMessage>
                </div>
            );
        }

        if (message.role === "assistant") {
            return (
                <div {...containerProps}>
                    <AssistantMessage actionBar={actionBar} isLast={isLast} message={message}>
                        {content}
                    </AssistantMessage>
                </div>
            );
        }

        if (message.role === "system") {
            return (
                <div {...containerProps}>
                    <SystemMessage>{content}</SystemMessage>
                </div>
            );
        }

        // Unknown role - render as assistant style
        return (
            <div {...containerProps}>
                <AssistantMessage actionBar={actionBar} isLast={isLast} message={message}>
                    {content}
                </AssistantMessage>
            </div>
        );
    },
);

MessageItem.displayName = "MessageItem";

export default MessageItem;
