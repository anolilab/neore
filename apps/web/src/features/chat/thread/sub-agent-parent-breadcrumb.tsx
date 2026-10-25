"use client";

/**
 * A link back to the parent chat, shown above a sub-agent's own thread.
 *
 * The relation is the `threadRelationships` row (`branchType: "subagent"`). That
 * read is owner-only, so a viewer who was merely granted the child never learns
 * the parent's id; the parent's title then comes through `getThread`, which
 * applies the parent's own access rules (and answers a locked chat without a
 * title). A missing title at any step hides the breadcrumb.
 */

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import type { FC } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

interface SubAgentParentBreadcrumbProps {
    className?: string;
    threadId: string | undefined;
}

const SubAgentParentBreadcrumb: FC<SubAgentParentBreadcrumbProps> = ({ className, threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();

    // Live reads: a one-shot read keeps a relation that arrived after the child opened hidden,
    // and a renamed parent's old title. The parent read stays a skipToken (no subscription)
    // until the relation names a sub-agent parent, so only sub-agent children pay for it.
    const { data: relationship } = useQuery(
        crpc.agent.threads.getThreadRelationship.queryOptions(threadId ? { threadId: threadId as Id<"threads"> } : skipToken),
    );
    const parentThreadId = relationship?.branchType === "subagent" ? relationship.parentThreadId : undefined;
    const { data: parent } = useQuery(crpc.chat.functions.getThread.queryOptions(parentThreadId ? { threadId: parentThreadId } : skipToken));
    const title = parentThreadId ? parent?.title : undefined;

    if (!parentThreadId || !title) {
        return null;
    }

    return (
        <nav aria-label={t`Parent chat`} className={className}>
            <Tooltip>
                <TooltipTrigger
                    render={
                        <Link
                            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex max-w-full items-center gap-1 rounded text-xs focus-visible:ring-2 focus-visible:outline-none"
                            params={{ threadId: parentThreadId }}
                            to="/chat/$threadId"
                        />
                    }
                >
                    <ChevronLeftIcon aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="max-w-[28ch] truncate">{title}</span>
                </TooltipTrigger>
                <TooltipContent>{title}</TooltipContent>
            </Tooltip>
        </nav>
    );
};

export default SubAgentParentBreadcrumb;
