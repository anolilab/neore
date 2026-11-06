"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Shrink } from "lucide-react";
import type { FC } from "react";
import { useEffect, useState } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useChatIsStreaming, useChatThread } from "@/features/chat/core/context/chat-context";
import { getValidThreadId } from "@/features/chat/core/utils/thread-id";
import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { useCRPC } from "@/lib/lunora/crpc";

import { shouldOfferCompaction } from "./compaction-logic";
import useCompactThread from "./use-compact-thread";

/**
 * Offered when the person comes back to a thread whose provider prompt cache has expired: the next reply would
 * re-read the whole context as fresh input, so condensing it first is cheaper. Clicking it runs the same compaction
 * as `/compact`. It is a suggestion made when the thread opens, so it goes once a reply starts in this view.
 */
const CompactionChip: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { thread, threadId } = useChatThread();
    const { hooks } = useAuth();
    const { data: sessionData } = hooks.useSession();
    const validThreadId = getValidThreadId(threadId);
    // Only the owner can compact, and a visitor who is not signed in has no status to read: the request would be refused.
    const isOwner = !!thread?.userId && thread.userId === sessionData?.user?.id;
    // Only a reply in this thread: a local reply still running in another chat says nothing about this one.
    const { isThreadStreaming } = useChatIsStreaming();
    const afterFirstPaint = useAfterFirstPaint();
    const { compact, isCompacting } = useCompactThread(validThreadId);
    // The idle time is judged when the thread opens; a reply in this view makes it stale.
    const [replied, setReplied] = useState(false);
    const [openedAt] = useState(() => Date.now());
    // Not kept between visits: a status from before the last reply would offer a compaction nobody needs.
    const { data: status } = useQuery({
        ...crpc.chat.compaction.getCompactionStatus.queryOptions(
            validThreadId && afterFirstPaint && isOwner ? { threadId: validThreadId as Id<"threads"> } : skipToken,
        ),
        gcTime: 0,
    });

    useEffect(() => {
        if (isThreadStreaming) {
            setReplied(true);
        }
    }, [isThreadStreaming]);

    if (replied || !shouldOfferCompaction(status, openedAt)) {
        return null;
    }

    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <Button
                        aria-label={t`Compact the conversation before the next prompt`}
                        className="h-7 gap-1.5 rounded-full px-2.5 text-xs"
                        disabled={isCompacting}
                        onClick={compact}
                        size="sm"
                        type="button"
                        variant="outline"
                    >
                        <Shrink aria-hidden="true" className="size-3.5" />
                        {t`Compact`}
                    </Button>
                }
            />
            <TooltipContent side="top">{t`This chat has been idle, so the model's cache has expired. Condense the older messages to make the next reply cheaper. Your chat is unchanged.`}</TooltipContent>
        </Tooltip>
    );
};

export default CompactionChip;
