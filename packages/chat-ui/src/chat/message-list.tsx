import { useLingui } from "@lingui/react/macro";
import { Bot } from "lucide-react";
import type { FC } from "react";
import { memo, useEffect, useRef } from "react";

import type { ChatMessage, ToolPart } from "../types/message";
import cn from "../utils/cn";
import MessageItem from "./message-item";

interface MessageListProps {
    components?: {
        DocumentArtifact?: FC<{ documentId: string; kind: string; title: string; version: number }>;
        McpApp?: FC<{ part: ToolPart; resourceUri: string; serverName: string; toolName: string }>;
        PresentationArtifact?: FC<{ presentationId: string; slideCount: number; styleName?: string; title: string }>;
        toolMeta?: Map<string, { resourceUri: string; serverName: string }>;
    };
    hasMore?: boolean;
    isStreaming?: boolean;
    messages: ChatMessage[];
    onBranchMessage?: (id: string) => void;
    onCopyMessage?: (id: string) => void;
    onLoadMore?: () => void;
    onPinMessage?: (id: string) => void;
    onRegenerateMessage?: (id: string) => void;
}

const MessageList = memo(
    ({
        components,
        hasMore = false,
        isStreaming = false,
        messages,
        onBranchMessage,
        onCopyMessage,
        onLoadMore,
        onPinMessage,
        onRegenerateMessage,
    }: MessageListProps) => {
        const { t } = useLingui();
        const bottomRef = useRef<HTMLDivElement>(null);
        const containerRef = useRef<HTMLDivElement>(null);
        const lastMessageCount = useRef(messages.length);

        // Auto-scroll to bottom when streaming or new messages arrive
        useEffect(() => {
            const shouldScroll = isStreaming || messages.length !== lastMessageCount.current;

            if (shouldScroll && bottomRef.current) {
                bottomRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
            }

            lastMessageCount.current = messages.length;
        }, [isStreaming, messages.length]);

        if (messages.length === 0) {
            return (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                    <div className="flex size-12 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
                        <Bot aria-hidden="true" className="size-6 text-gray-400 dark:text-gray-500" />
                    </div>
                    <div className="flex flex-col gap-1">
                        <p className="text-sm font-medium text-gray-600 dark:text-gray-400">{t`Start a conversation`}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">{t`Send a message to begin`}</p>
                    </div>
                </div>
            );
        }

        return (
            <div className={cn("flex h-full flex-col overflow-y-auto")} ref={containerRef}>
                <div className="flex flex-col gap-4 px-4 py-4">
                    {/* Load earlier messages */}
                    {hasMore && (
                        <div className="flex justify-center">
                            <button
                                className={cn(
                                    "rounded-lg px-3 py-1.5 text-xs font-medium",
                                    "text-gray-500 hover:bg-gray-100 hover:text-gray-700",
                                    "dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200",
                                    "focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:outline-none",
                                    "transition-colors",
                                )}
                                onClick={onLoadMore}
                                type="button"
                            >
                                {t`Load earlier messages`}
                            </button>
                        </div>
                    )}

                    {/* Messages */}
                    {messages.map((message, index) => {
                        const isLast = index === messages.length - 1;

                        return (
                            <MessageItem
                                components={components}
                                isLast={isLast}
                                isStreaming={isStreaming}
                                key={message.id}
                                message={message}
                                onBranch={onBranchMessage ? () => onBranchMessage(message.id) : undefined}
                                onCopy={onCopyMessage ? () => onCopyMessage(message.id) : undefined}
                                onPin={onPinMessage ? () => onPinMessage(message.id) : undefined}
                                onRegenerate={onRegenerateMessage ? () => onRegenerateMessage(message.id) : undefined}
                            />
                        );
                    })}

                    {/* Bottom anchor for auto-scroll */}
                    <div aria-hidden="true" ref={bottomRef} />
                </div>
            </div>
        );
    },
);

export default MessageList;
