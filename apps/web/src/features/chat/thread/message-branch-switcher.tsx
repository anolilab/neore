"use client";

/**
 * "‹ 2/3 ›" switcher for a message that has alternatives — replies from
 * "Regenerate", prompts from "Edit". Switching moves the thread's active path
 * on the server (`agent_branches.switchBranch`), so it persists, and the
 * reactive message list re-renders the chosen branch.
 */

import { useLingui } from "@lingui/react/macro";
import type { MessageBranch } from "@neore/backend/agent/ui-messages";
import type { Id } from "@neore/backend/dataModel";
import { MessageAction } from "@neore/ui/components/ai-elements/message";
import { useMutation } from "@tanstack/react-query";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { FC } from "react";

import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

interface MessageBranchSwitcherProps {
    branch: MessageBranch;
    threadId: Id<"threads">;
}

const MessageBranchSwitcher: FC<MessageBranchSwitcherProps> = ({ branch, threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { isPending, mutate } = useMutation(crpc.agent.branches.switchBranch.mutationOptions());

    const position = branch.index + 1;
    const total = branch.count;
    const hasPrevious = branch.index > 0;
    const hasNext = branch.index < total - 1;

    const switchTo = (index: number) => {
        const messageId = branch.siblingIds[index];

        if (!messageId || isPending) {
            return;
        }

        mutate({ messageId, threadId }, { onError: (error) => showError(error as Error) });
    };

    return (
        <div aria-busy={isPending} aria-label={t`Message versions`} className="flex items-center" role="group">
            <MessageAction
                disabled={!hasPrevious || isPending}
                label={t`Previous version`}
                onClick={() => switchTo(branch.index - 1)}
                tooltip={t`Previous version`}
            >
                <ChevronLeftIcon aria-hidden="true" className="size-4" />
            </MessageAction>
            <span aria-hidden="true" className="text-muted-foreground min-w-8 text-center text-xs tabular-nums">
                {position}/{total}
            </span>
            <span aria-live="polite" className="sr-only" role="status">
                {t`Version ${position} of ${total}`}
            </span>
            <MessageAction disabled={!hasNext || isPending} label={t`Next version`} onClick={() => switchTo(branch.index + 1)} tooltip={t`Next version`}>
                <ChevronRightIcon aria-hidden="true" className="size-4" />
            </MessageAction>
        </div>
    );
};

export default MessageBranchSwitcher;
