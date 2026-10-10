"use client";

/**
 * ToolApproval — rendered in place of a tool call the agent paused on because
 * the tool's permission is `ask`. Approve runs it once, Deny tells the model it
 * was refused, Always allow runs it and stores `auto` for that tool.
 *
 * Every answer resumes the agent run server-side (`respondToToolApproval`), which
 * opens a fresh stream the thread's streaming placeholder picks up.
 *
 * Only the thread owner can answer: the tool runs with the owner's MCP servers
 * and keys. Anyone else sees the request read-only.
 */

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import type { ToolPart } from "@neore/chat-ui/types";
import { resolveMcpToolName } from "@neore/chat-ui/utils/mcp-tool-name";
import { Button } from "@neore/ui/components/button";
import { useMutation } from "@tanstack/react-query";
import { Check, ShieldAlert, ShieldCheck, X } from "lucide-react";
import type { FC } from "react";
import { useId, useState } from "react";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { useChatThread } from "@/features/chat/core/context/chat-context";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

type Decision = "always" | "approve" | "deny";

const TOOL_PREFIX_RE = /^tool-/;

const ToolApproval: FC<{ part: ToolPart }> = ({ part }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { thread, threadId } = useChatThread();
    const { hooks } = useAuth();
    const { data: sessionData } = hooks.useSession();
    const headingId = useId();
    const [submitted, setSubmitted] = useState<Decision | null>(null);
    const { isPending, mutate } = useMutation(crpc.chat.tool_permissions.respondToToolApproval.mutationOptions());

    const mcp = resolveMcpToolName(part);
    const server = mcp?.serverName;
    const tool = mcp?.toolName ?? part.type.replace(TOOL_PREFIX_RE, "");
    const approvalId = part.approval?.id;
    // A public viewer's thread copy has no `userId`, so it never matches.
    const isOwner = !!thread?.userId && thread.userId === sessionData?.user?.id;
    const isDisabled = !approvalId || !threadId || isPending || submitted !== null;

    const respond = (decision: Decision) => {
        if (!approvalId || !threadId) {
            return;
        }

        setSubmitted(decision);
        mutate(
            { approvalId, decision, threadId: threadId as Id<"threads"> },
            {
                onError: (error) => {
                    setSubmitted(null);
                    showError(error instanceof Error ? error : t`Could not send your answer. Please try again.`);
                },
            },
        );
    };

    let statusText = isOwner ? t`Waiting for your approval` : t`Waiting for the owner to approve`;

    if (submitted === "deny") {
        statusText = t`Denied — continuing without it`;
    } else if (submitted) {
        statusText = t`Approved — running tool`;
    }

    let inputPreview = "";

    if (typeof part.input === "string") {
        inputPreview = part.input;
    } else if (part.input !== undefined) {
        inputPreview = JSON.stringify(part.input, null, 2);
    }

    return (
        <div
            aria-labelledby={headingId}
            className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/40"
            role="group"
        >
            <div className="flex items-start gap-2">
                <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-amber-900 dark:text-amber-100" id={headingId}>
                        {server ? t`Allow "${tool}" from ${server}?` : t`Allow "${tool}"?`}
                    </p>
                    <p className="text-xs text-amber-800 dark:text-amber-200" role="status">
                        {statusText}
                    </p>
                </div>
            </div>

            {inputPreview && (
                <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-amber-900 dark:text-amber-100">{t`Show what it will send`}</summary>
                    <pre className="mt-1 max-h-48 overflow-auto rounded bg-white/60 p-2 font-mono text-xs whitespace-pre-wrap dark:bg-black/30">
                        {inputPreview}
                    </pre>
                </details>
            )}

            {isOwner && (
                <div className="mt-3 flex flex-wrap gap-2">
                    <Button aria-label={t`Approve ${tool} once`} disabled={isDisabled} onClick={() => respond("approve")} size="sm">
                        <Check aria-hidden="true" />
                        {t`Approve`}
                    </Button>
                    <Button aria-label={t`Deny ${tool}`} disabled={isDisabled} onClick={() => respond("deny")} size="sm" variant="outline">
                        <X aria-hidden="true" />
                        {t`Deny`}
                    </Button>
                    <Button aria-label={t`Always allow ${tool}`} disabled={isDisabled} onClick={() => respond("always")} size="sm" variant="ghost">
                        <ShieldCheck aria-hidden="true" />
                        {t`Always allow`}
                    </Button>
                </div>
            )}
        </div>
    );
};

export default ToolApproval;
