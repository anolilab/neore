"use client";

/**
 * A waiting sub-agent's requests, shown on its card in the parent conversation: the owner allows once, always allows or
 * denies from here. The answer is `respondToToolApproval` on the CHILD's thread, the same claim its own chat uses, so a
 * sub-agent's request offers no allow for a period (the claim refuses one). A locked child's requests are not listed;
 * its owner unlocks the child to answer.
 */

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { useUnlockProof } from "@neore/client-runtime";
import { useQuery } from "@tanstack/react-query";
import type { FC } from "react";

import { ToolApprovalCard } from "@/features/chat/thread/tool-approval";
import { useCRPC } from "@/lib/lunora/crpc";

/**
 * One live query per parent conversation, shared by its cards, each showing its own run's requests. The query answers
 * the parent's owner alone, so whoever sees a request may answer it.
 */
const SubAgentApprovals: FC<{ parentThreadId: string; runId: string }> = ({ parentThreadId, runId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    // A locked parent answers the list only with its unlock proof, as every read of the chat does.
    const unlockProof = useUnlockProof(parentThreadId);
    const { data, isError } = useQuery(
        crpc.sub_agents.functions.listSubAgentApprovals.queryOptions({
            parentThreadId: parentThreadId as Id<"threads">,
            ...(unlockProof !== undefined && { unlockProof }),
        }),
    );

    if (isError) {
        return (
            <p className="text-destructive mt-2 text-xs" role="alert">
                {t`Could not load the sub-agent's requests.`}
            </p>
        );
    }

    const requests = (data ?? []).filter((request) => request.runId === runId);

    return requests.map((request) => {
        const name = request.skillSlug ? `/${request.skillSlug}` : t`The sub-agent`;
        const tool = request.toolName ?? t`a tool`;
        const omitted = request.omittedCharacters;
        // A cut preview says so: approving runs the whole call, so the owner must see that more is not shown.
        const input = omitted > 0 ? `${request.input}\n${t`… (${omitted} more characters not shown; approving runs the whole call)`}` : request.input;

        return (
            <div className="mt-2" key={request.approvalId}>
                {request.server !== null && <p className="text-muted-foreground mb-1 text-xs">{request.server}</p>}
                <ToolApprovalCard
                    approvalId={request.approvalId}
                    canAllowForAPeriod={false}
                    heading={t`${name} wants to run "${tool}"`}
                    input={input}
                    isOwner
                    threadId={request.childThreadId}
                    tool={tool}
                />
            </div>
        );
    });
};

export default SubAgentApprovals;
