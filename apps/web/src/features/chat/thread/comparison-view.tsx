"use client";

/**
 * ComparisonView - Side-by-side model response columns
 *
 * Layout mirrors the design from the reference screenshots:
 * - Flat split-pane: columns separated by vertical border lines, no card chrome
 * - Per-column sticky header: model icon + name + "open thread" button
 * - User prompts shown as floating centered cards at the top of each round
 * - Assistant responses in full markdown below
 * - Each column scrolls independently
 *
 * The shared composer lives in the parent (thread.tsx) and fans messages
 * to all child threads via onSubmitOverride.
 */

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { ProviderIcon } from "@neore/ui/components/ai-elements/provider-icon";
import { Button } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, Sparkles } from "lucide-react";
import type { FC } from "react";
import { useMemo } from "react";

import useFeatureFlaggedModels from "@/hooks/use-feature-flagged-models";
import type { UIMessage } from "@/lib/agent";
import { useUIMessages } from "@/lib/agent";
import { useCRPC } from "@/lib/lunora/crpc";

import MessageContent from "./message-content";
import { StreamingPlaceholder } from "./streaming-placeholder";

export interface ComparisonBranch {
    activeStreamId: string | null;
    isLoading: boolean;
    messages: UIMessage[];
    model: string;
    threadId: string;
}

interface ComparisonViewProps {
    branches: ComparisonBranch[];
    className?: string;
    maxColumns?: number;
}

// ─── Empty state per column ───────────────────────────────────────────────────

const ColumnEmptyState: FC = () => {
    const { t } = useLingui();

    return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12">
            <div className="bg-muted flex size-14 items-center justify-center rounded-xl">
                <Sparkles className="text-muted-foreground size-7" />
            </div>
            <div className="text-center">
                <p className="text-sm font-medium">{t`No response yet`}</p>
                <p className="text-muted-foreground mt-0.5 text-xs">{t`Send a message below to start`}</p>
            </div>
        </div>
    );
};

// ─── Single column ────────────────────────────────────────────────────────────

const ModelColumn: FC<{
    branch: ComparisonBranch;
    isLast: boolean;
    onOpenThread: (threadId: string) => void;
}> = ({ branch, isLast, onOpenThread }) => {
    const { t } = useLingui();

    const models = useFeatureFlaggedModels();
    const modelDefinition = useMemo(() => models.find((m) => m.id === branch.model), [models, branch.model]);
    const modelName = modelDefinition?.name || branch.model;
    const providerId = modelDefinition?.displayProvider;

    // Real-time paginated messages for this child thread.
    // useUIMessages (backed by usePaginatedQuery) returns messages in ascending
    // chronological order (oldest first) so user→assistant turns pair correctly.
    // `ComparisonBranch.threadId` is the id returned by `createThread` for this column.
    const branchThreadId = branch.threadId as Id<"threads">;

    const { results: messages } = useUIMessages(api.chat.functions.getThreadUIMessages, branchThreadId ? { threadId: branchThreadId } : "skip", {
        initialNumItems: 200,
    }) as unknown as { results: UIMessage[] };

    const crpc = useCRPC();
    const { data: activeStream } = useQuery(crpc.chat.streaming.getActiveStreamForThread.queryOptions({ threadId: branchThreadId }));
    const activeStreamId = activeStream?.streamId ?? null;
    const isStreaming = !!activeStreamId;

    // Group messages into turns: [user, assistant, user, assistant, …]
    // Each turn object carries the user prompt and the assistant reply (if any)
    const turns = useMemo(() => {
        const result: { assistant: UIMessage | null; user: UIMessage }[] = [];
        let pendingUser: UIMessage | null = null;

        for (const message of messages) {
            if (message.role === "user") {
                pendingUser = message as UIMessage;
            } else if (message.role === "assistant" && pendingUser) {
                result.push({ assistant: message as UIMessage, user: pendingUser as UIMessage });
                pendingUser = null;
            }
        }

        // Unanswered user message (streaming in progress or error)
        if (pendingUser) {
            result.push({ assistant: null, user: pendingUser });
        }

        return result;
    }, [messages]);

    const isEmpty = turns.length === 0 && !isStreaming;

    return (
        <div className={cn("flex min-w-0 flex-1 flex-col", !isLast && "border-border border-r")}>
            {/* ── Column header ─────────────────────────────────────────── */}
            <div className="border-border flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
                {providerId ? (
                    <ProviderIcon className="size-4 shrink-0" provider={modelDefinition?.provider || providerId} providerIcon={providerId} />
                ) : (
                    <Sparkles className="size-4 shrink-0" />
                )}
                <span className="truncate text-sm font-medium">{modelName}</span>

                <Button
                    className="text-muted-foreground hover:text-foreground ml-auto size-7 shrink-0"
                    onClick={() => onOpenThread(branch.threadId)}
                    size="icon"
                    title={t`Open ${modelName} in full thread`}
                    variant="ghost"
                >
                    <ArrowUpRight className="size-3.5" />
                </Button>
            </div>

            {/* ── Scrollable message area ────────────────────────────────── */}
            <div className="flex flex-1 flex-col overflow-y-auto">
                {isEmpty && <ColumnEmptyState />}

                {turns.map(({ assistant, user }) => (
                    <div className="flex flex-col" key={user.id}>
                        {/* User prompt — centered floating card */}
                        <div className="flex justify-center px-6 pt-5 pb-2">
                            <div className="bg-muted text-muted-foreground max-w-[85%] rounded-xl px-4 py-2 text-sm">{user.text}</div>
                        </div>

                        {/* Assistant response — full markdown */}
                        {assistant && (
                            <div className="prose prose-sm dark:prose-invert max-w-none px-6 py-4">
                                <MessageContent message={assistant} />
                            </div>
                        )}
                    </div>
                ))}

                {/* Live streaming placeholder */}
                {isStreaming && activeStreamId && (
                    <div className="px-6 py-4">
                        <StreamingPlaceholder compact streamId={activeStreamId} />
                    </div>
                )}
            </div>
        </div>
    );
};

// ─── Main ComparisonView ──────────────────────────────────────────────────────

const ComparisonView: FC<ComparisonViewProps> = ({ branches, className, maxColumns = 6 }) => {
    const navigate = useNavigate();

    const handleOpenThread = (threadId: string) => {
        void navigate({ params: { threadId }, to: "/chat/$threadId" });
    };

    const visible = branches.slice(0, maxColumns);

    return (
        <div className={cn("flex min-h-0 overflow-x-auto", className)}>
            {visible.map((branch, i) => (
                <ModelColumn branch={branch} isLast={i === visible.length - 1} key={branch.threadId} onOpenThread={handleOpenThread} />
            ))}
        </div>
    );
};

ComparisonView.displayName = "ComparisonView";

export default ComparisonView;
