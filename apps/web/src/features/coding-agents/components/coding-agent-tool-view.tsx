"use client";

/**
 * The chat rendering of a `delegateToCodingAgent` tool call.
 *
 * The run outlives the tool call's own output — it streams its log for up to
 * 20 minutes while the call is still `input-available` — so the view finds the
 * run by the call's id and subscribes to it, rather than waiting for output.
 */

import { useLingui } from "@lingui/react/macro";
import type { ToolPart } from "@neore/chat-ui/types";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Loader2, SquareTerminal } from "lucide-react";
import type { FC } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import CodingAgentRunView from "./coding-agent-run-view";

const CodingAgentToolView: FC<{ part: ToolPart }> = ({ part }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const isDenied = part.state === "output-denied";
    const { data: run, isPending } = useQuery(
        crpc.coding_agents.functions.getRunByToolCall.queryOptions(isDenied ? skipToken : { toolCallId: part.toolCallId }),
    );

    if (run) {
        return <CodingAgentRunView run={run} />;
    }

    const output = part.state === "output-available" ? (part.output as { error?: string } | undefined) : undefined;
    let message = t`Starting the coding agent…`;

    if (isDenied) {
        message = t`Coding agent run was not approved.`;
    } else if (output?.error) {
        message = output.error;
    } else if (part.state === "output-error") {
        message = part.errorText ?? t`The coding agent could not start.`;
    } else if (!isPending && part.state === "output-available") {
        message = t`This run is no longer available.`;
    }

    const isWaiting = !isDenied && !output?.error && part.state !== "output-error" && part.state !== "output-available";

    return (
        <div className="text-muted-foreground my-2 flex items-center gap-2 rounded-lg border p-3 text-sm">
            {isWaiting ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
            ) : (
                <SquareTerminal aria-hidden="true" className="size-4" />
            )}
            <span role="status">{message}</span>
        </div>
    );
};

export default CodingAgentToolView;
