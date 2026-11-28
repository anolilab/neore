"use client";

/**
 * ToolApproval — rendered in place of a tool call the agent paused on because
 * the tool's permission is `ask`. Approve runs it once, Deny tells the model it
 * was refused, Always allow runs it and stores `auto` for that tool, and Allow for
 * 1 hour / today runs it and lets that tool run unasked until the time is up (the
 * allow is the backend's, `chat/lib/tool-permission-grants.ts`). A device tool is
 * approved again on the device, so it offers neither.
 *
 * Every answer resumes the agent run server-side (`respondToToolApproval`), which
 * opens a fresh stream the thread's streaming placeholder picks up.
 *
 * Only the thread owner can answer: the tool runs with the owner's MCP servers
 * and keys. Anyone else sees the request read-only.
 */

import { Plural, useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import type { ToolPart } from "@neore/chat-ui/types";
import { resolveDeviceToolName } from "@neore/chat-ui/utils/device-tool-name";
import { resolveMcpToolName } from "@neore/chat-ui/utils/mcp-tool-name";
import { Button } from "@neore/ui/components/button";
import { useMutation } from "@tanstack/react-query";
import { Check, Clock, ShieldAlert, ShieldCheck, X } from "lucide-react";
import type { FC, ReactNode } from "react";
import { useId, useState } from "react";

import { useAuthSession } from "@/features/auth/hooks/use-auth-session";
import { useChatThread } from "@/features/chat/core/context/chat-context";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

type Decision = "always" | "approve" | "deny" | "hour" | "today";

const TOOL_PREFIX_RE = /^tool-/;

export interface ToolApprovalCardProps {
    approvalId: string | undefined;
    /** "Allow for 1 hour" / "for today": not for a device tool (approved again on the device), nor a sub-agent's request (refused). */
    canAllowForAPeriod: boolean;
    /** Shown in place of the raw input, when the request is better read as a list (the memories `forget` deletes). */
    details?: ReactNode;
    heading: string;
    input: unknown;
    isOwner: boolean;
    /** Approve and Deny only: no "Always allow" or period, for a request that is about this one call's own items. */
    onceOnly?: boolean;
    /** The MCP server the tool comes from, when the heading does not name it. */
    server?: string | null;
    /** The thread the request is recorded on: the answer is checked on that thread's latest turn. */
    threadId: string | undefined;
    tool: string;
}

/** The request and its answers, for a tool call in this thread or a sub-agent's. */
export const ToolApprovalCard: FC<ToolApprovalCardProps> = ({
    approvalId,
    canAllowForAPeriod,
    details,
    heading,
    input,
    isOwner,
    onceOnly = false,
    server,
    threadId,
    tool,
}) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const [submitted, setSubmitted] = useState<Decision | null>(null);
    const { isPending, mutate } = useMutation(crpc.chat.tool_permissions.respondToToolApproval.mutationOptions());
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

    if (typeof input === "string") {
        inputPreview = input;
    } else if (input !== undefined) {
        inputPreview = JSON.stringify(input, null, 2);
    }

    return (
        <div aria-labelledby={headingId} className="surface-raised mb-4 rounded-xl p-3" role="group">
            <div className="flex items-start gap-2">
                <ShieldAlert aria-hidden="true" className="text-attention mt-0.5 size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium" id={headingId}>
                        {heading}
                    </p>
                    {server && <p className="text-muted-foreground text-xs">{server}</p>}
                    <p className="text-muted-foreground text-xs" role="status">
                        {statusText}
                    </p>
                </div>
            </div>

            {details}

            {details === undefined && inputPreview && (
                <details className="mt-2">
                    <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">{t`Show what it will send`}</summary>
                    <pre className="surface-well mt-1 max-h-48 overflow-auto rounded-lg p-2 font-mono text-xs whitespace-pre-wrap">{inputPreview}</pre>
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
                    {!onceOnly && (
                        <Button aria-label={t`Always allow ${tool}`} disabled={isDisabled} onClick={() => respond("always")} size="sm" variant="ghost">
                            <ShieldCheck aria-hidden="true" />
                            {t`Always allow`}
                        </Button>
                    )}
                    {canAllowForAPeriod && !onceOnly && (
                        <>
                            <Button disabled={isDisabled} onClick={() => respond("hour")} size="sm" variant="ghost">
                                <Clock aria-hidden="true" />
                                {t`Allow for 1 hour`}
                                {/* The name starts with the visible text and ends with the tool, which the card names above. */}
                                <span className="sr-only">, {tool}</span>
                            </Button>
                            <Button disabled={isDisabled} onClick={() => respond("today")} size="sm" variant="ghost">
                                <Clock aria-hidden="true" />
                                {t`Allow for today`}
                                {/* The name starts with the visible text and ends with the tool, which the card names above. */}
                                <span className="sr-only">, {tool}</span>
                            </Button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
};

/**
 * The memories a confirmed `forget` call deletes: the texts the user is shown are the texts the delete checks. An id named
 * twice with the same text shows once; each row keeps its id as its key, with its place as the tiebreak only when one id
 * comes with different texts (the delete then refuses that id and offers it again).
 */
const forgetEntries = (input: unknown): { key: string; text: string }[] => {
    const memories = (input as { memories?: unknown } | undefined)?.memories;
    const entries = Array.isArray(memories)
        ? memories.flatMap((memory: { id?: unknown; text?: unknown }) =>
              typeof memory?.id === "string" && typeof memory.text === "string" ? [{ id: memory.id, text: memory.text }] : [],
          )
        : [];
    const shown = entries.filter((entry, index) => entries.findIndex((other) => other.id === entry.id && other.text === entry.text) === index);

    return shown.map((entry, index) => {
        const sharesId = shown.some((other) => other !== entry && other.id === entry.id);

        return { key: sharesId ? `${entry.id}:${String(index)}` : entry.id, text: entry.text };
    });
};

const ToolApproval: FC<{ part: ToolPart }> = ({ part }) => {
    const { t } = useLingui();
    const { thread, threadId } = useChatThread();
    const { data: sessionData } = useAuthSession();

    const mcp = resolveMcpToolName(part);
    const server = mcp?.serverName;
    const tool = mcp?.toolName ?? part.type.replace(TOOL_PREFIX_RE, "");
    // A public viewer's thread copy has no `userId`, so it never matches.
    const isOwner = !!thread?.userId && thread.userId === sessionData?.user?.id;

    // A confirmed `forget` names its memories; a lookup that asks (the tool set to Ask) is shown as any other call.
    const forgotten = !mcp && tool === "forget" ? forgetEntries(part.input) : [];

    if (forgotten.length > 0) {
        return (
            <ToolApprovalCard
                approvalId={part.approval?.id}
                canAllowForAPeriod={false}
                details={
                    // The memories are the owner's: anyone else viewing the chat sees how many, never what they say.
                    isOwner ? (
                        <ul aria-label={t`Memories to forget`} className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900 dark:text-amber-100">
                            {forgotten.map((entry: { key: string; text: string }) => (
                                <li key={entry.key}>{entry.text}</li>
                            ))}
                        </ul>
                    ) : (
                        <p className="mt-2 text-sm text-amber-900 dark:text-amber-100">
                            <Plural
                                one="# memory is waiting for the chat owner to confirm."
                                other="# memories are waiting for the chat owner to confirm."
                                value={forgotten.length}
                            />
                        </p>
                    )
                }
                heading={t`Forget these memories?`}
                input={part.input}
                isOwner={isOwner}
                onceOnly
                threadId={threadId}
                tool={tool}
            />
        );
    }

    return (
        <ToolApprovalCard
            approvalId={part.approval?.id}
            canAllowForAPeriod={resolveDeviceToolName(part) === null}
            heading={server ? t`Allow "${tool}" from ${server}?` : t`Allow "${tool}"?`}
            input={part.input}
            isOwner={isOwner}
            threadId={threadId}
            tool={tool}
        />
    );
};

export default ToolApproval;
