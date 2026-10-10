import { useLingui } from "@lingui/react/macro";
import { Message, MessageAction, MessageActions, MessageContent as MessageContentWrapper } from "@neore/ui/components/ai-elements/message";
import { Check, Copy, GitBranch, Pin, RefreshCw, Timer } from "lucide-react";
import type { FC } from "react";
import { memo, useState } from "react";

import type { ChatMessage, FilePart, TextPart, ToolPart } from "../types/message";
import cn from "../utils/cn";
import { getPageContextInfo, getVisibleUserText } from "../utils/page-context";
import MessageContent from "./message-content";
import PageContextChip from "./page-context-chip";
import SpeakerChip from "./speaker-chip";

interface MessageItemProps {
    components?: {
        DocumentArtifact?: FC<{ documentId: string; kind: string; title: string; version: number }>;
        McpApp?: FC<{ part: ToolPart; resourceUri: string; serverName: string; toolName: string }>;
        PresentationArtifact?: FC<{ presentationId: string; slideCount: number; styleName?: string; title: string }>;
        toolMeta?: Map<string, { resourceUri: string; serverName: string }>;
    };
    isLast?: boolean;
    isStreaming?: boolean;
    maxWidth?: string;
    message: ChatMessage;
    onBranch?: () => void;
    onCopy?: () => void;
    onPin?: () => void;
    onRegenerate?: () => void;
}

const formatTokenRate = (usage: NonNullable<ChatMessage["usage"]>): string => {
    if (!usage.durationMs || usage.durationMs === 0) {
        return "";
    }

    const tokensPerSecond = Math.round((usage.completionTokens / usage.durationMs) * 1000);

    return `${tokensPerSecond} tok/s`;
};

const formatTtft = (ttftMs: number | undefined): string => {
    if (!ttftMs) {
        return "";
    }

    if (ttftMs < 1000) {
        return `${Math.round(ttftMs)}ms TTFT`;
    }

    return `${(ttftMs / 1000).toFixed(1)}s TTFT`;
};

const formatTokens = (total: number): string => {
    if (total >= 1000) {
        return `${(total / 1000).toFixed(1)}K tokens`;
    }

    return `${total} tokens`;
};

interface CopyButtonProps {
    onCopy: () => void;
}

const CopyButton = ({ onCopy }: CopyButtonProps) => {
    const { t } = useLingui();
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        onCopy();
        setCopied(true);
        setTimeout(setCopied, 2000, false);
    };

    return (
        <MessageAction aria-label={t`Copy message`} onClick={handleCopy} tooltip={t`Copy`}>
            {copied ? <Check aria-hidden="true" className="size-3.5 text-green-500" /> : <Copy aria-hidden="true" className="size-3.5" />}
        </MessageAction>
    );
};

const UserMessage = ({ maxWidth, message, onBranch, onCopy, onPin }: Pick<MessageItemProps, "message" | "maxWidth" | "onCopy" | "onBranch" | "onPin">) => {
    const { t } = useLingui();
    const text = getVisibleUserText(message);
    const pageContexts = message.parts.flatMap((part, index) => {
        const info = getPageContextInfo(part);

        return info ? [{ info, key: `${message.id}:page-context:${index}`, text: (part as TextPart).text }] : [];
    });

    // Gather image attachments from file parts. The parts carry no id of their
    // own, but a persisted message's attachment list never reorders, so its
    // position within that message is a stable identity.
    const imageParts = (message.parts.filter((p): p is FilePart => p.type === "file" && !!(p as FilePart).mediaType?.startsWith("image/")) as FilePart[]).map(
        (part, index) => {
            return { ...part, key: `${message.id}:attachment:${index}` };
        },
    );

    return (
        <div className="flex justify-end">
            <div className={cn("flex flex-col items-end gap-1", maxWidth ?? "max-w-[85%]")}>
                {imageParts.length > 0 && (
                    <div className="flex flex-wrap justify-end gap-2">
                        {imageParts.map((img) => {
                            if (img.nsfwStatus === "blocked" || img.nsfwStatus === "checking") {
                                return (
                                    <div
                                        className="bg-muted flex max-h-40 max-w-[200px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-4"
                                        key={img.key}
                                    >
                                        <span className="text-muted-foreground text-xs">
                                            {img.nsfwStatus === "checking" ? t`Scanning...` : t`Flagged for review`}
                                        </span>
                                    </div>
                                );
                            }

                            return (
                                <img
                                    alt={img.filename || t`Attached image`}
                                    className="max-h-40 max-w-[200px] rounded-lg object-cover"
                                    key={img.key}
                                    src={img.url || img.data}
                                />
                            );
                        })}
                    </div>
                )}
                <Message className="group/message flex flex-col items-end" from="user">
                    {pageContexts.map((pageContext) => (
                        <PageContextChip info={pageContext.info} key={pageContext.key} text={pageContext.text} />
                    ))}
                    {text && (
                        <MessageContentWrapper className="rounded-2xl rounded-tr-sm bg-blue-600 px-4 py-2.5 text-sm text-white">
                            <span className="whitespace-pre-wrap">{text}</span>
                        </MessageContentWrapper>
                    )}
                    <MessageActions>
                        {onCopy && <CopyButton onCopy={onCopy} />}
                        {onPin && (
                            <MessageAction aria-label={t`Pin message`} onClick={onPin} tooltip={t`Pin`}>
                                <Pin aria-hidden="true" className="size-3.5" />
                            </MessageAction>
                        )}
                        {onBranch && (
                            <MessageAction aria-label={t`Branch from here`} onClick={onBranch} tooltip={t`Branch`}>
                                <GitBranch aria-hidden="true" className="size-3.5" />
                            </MessageAction>
                        )}
                    </MessageActions>
                </Message>
            </div>
        </div>
    );
};

const AssistantMessage = ({
    components,
    isLast,
    isStreaming,
    maxWidth,
    message,
    onBranch,
    onCopy,
    onPin,
    onRegenerate,
}: Pick<MessageItemProps, "message" | "isStreaming" | "isLast" | "maxWidth" | "components" | "onCopy" | "onPin" | "onRegenerate" | "onBranch">) => {
    const { t } = useLingui();
    const isCurrentlyStreaming = isStreaming && isLast;
    const hasUsage = !!message.usage && message.status !== "streaming" && message.status !== "pending";
    const tokenRate = hasUsage ? formatTokenRate(message.usage!) : "";
    const ttft = hasUsage ? formatTtft(message.usage!.ttftMs) : "";
    const tokens = hasUsage ? formatTokens(message.usage!.totalTokens) : "";
    /** Group-chat speaker; `name` keeps the message id the web app already translates. */
    const name = message.speakerName;

    return (
        <div className="flex justify-start">
            <div className={cn("flex w-full flex-col gap-1", maxWidth ?? "max-w-[92%]")}>
                <Message className="group/message flex flex-col items-start" from="assistant">
                    {name && <SpeakerChip className="mb-1" name={name} />}
                    <MessageContentWrapper className="prose prose-sm dark:prose-invert max-w-none">
                        <MessageContent components={components} isStreaming={isCurrentlyStreaming} message={message} />
                    </MessageContentWrapper>

                    {/* Action bar */}
                    <MessageActions>
                        {onCopy && <CopyButton onCopy={onCopy} />}
                        {onPin && (
                            <MessageAction aria-label={t`Pin message`} onClick={onPin} tooltip={t`Pin`}>
                                <Pin aria-hidden="true" className="size-3.5" />
                            </MessageAction>
                        )}
                        {onRegenerate && isLast && (
                            <MessageAction aria-label={t`Regenerate response`} onClick={onRegenerate} tooltip={t`Regenerate`}>
                                <RefreshCw aria-hidden="true" className="size-3.5" />
                            </MessageAction>
                        )}
                        {onBranch && (
                            <MessageAction aria-label={t`Branch from here`} onClick={onBranch} tooltip={t`Branch`}>
                                <GitBranch aria-hidden="true" className="size-3.5" />
                            </MessageAction>
                        )}
                    </MessageActions>
                </Message>

                {/* Stats bar */}
                {hasUsage && (
                    <div className="flex flex-wrap items-center gap-3 px-1 text-[11px] text-gray-400 dark:text-gray-500">
                        {tokenRate && (
                            <span className="flex items-center gap-1">
                                <Timer aria-hidden="true" className="size-3" />
                                {tokenRate}
                            </span>
                        )}
                        {tokens && <span>{tokens}</span>}
                        {ttft && (
                            <span className="flex items-center gap-1">
                                <Timer aria-hidden="true" className="size-3" />
                                {ttft}
                            </span>
                        )}
                        {message.model && <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] dark:bg-gray-800">{message.model}</span>}
                    </div>
                )}

                {/* Model badge when no usage */}
                {!hasUsage && message.model && (
                    <div className="px-1">
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-400 dark:bg-gray-800 dark:text-gray-500">
                            {message.model}
                        </span>
                    </div>
                )}
            </div>
            {/* Group chat: announce each participant as their reply starts streaming. */}
            <span aria-live="polite" className="sr-only" role="status">
                {isCurrentlyStreaming && name ? t`${name} is responding` : null}
            </span>
        </div>
    );
};

const MessageItem = memo(({ components, isLast = false, isStreaming = false, maxWidth, message, onBranch, onCopy, onPin, onRegenerate }: MessageItemProps) => {
    if (message.role === "user") {
        return <UserMessage maxWidth={maxWidth} message={message} onBranch={onBranch} onCopy={onCopy} onPin={onPin} />;
    }

    if (message.role === "assistant") {
        return (
            <AssistantMessage
                components={components}
                isLast={isLast}
                isStreaming={isStreaming}
                maxWidth={maxWidth}
                message={message}
                onBranch={onBranch}
                onCopy={onCopy}
                onPin={onPin}
                onRegenerate={onRegenerate}
            />
        );
    }

    // system / tool roles are not rendered
    return null;
});

// Explicit displayName already set via named function expression above

export default MessageItem;
