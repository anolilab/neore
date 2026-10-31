"use client";

/**
 * The comments drafted on a thread's diffs, with the one action that sends them to the coding agent as a message
 * (plans/acp-agent-host.md §4.9). Shown under the diff and above the composer; renders nothing but its (empty)
 * live region while there is no draft, so the count is announced when the first comment is added.
 */

import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { SendIcon, XIcon } from "lucide-react";
import type { FC } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import type { DiffComment } from "./diff-comments";
import { describeRange } from "./diff-comments";
import { useDiffCommentStore } from "./diff-comments-store";
import useSendDiffComments from "./use-send-diff-comments";

const placeOf = (comment: DiffComment, removed: string): string => (comment.range ? `${comment.path}:${describeRange(comment.range, removed)}` : comment.path);

const DiffCommentsDraft: FC<{ threadId: string }> = ({ threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { comments, composed, send, sending } = useSendDiffComments(threadId);
    const { data: session } = useQuery(crpc.acp.functions.getHostSession.queryOptions({ threadId }));
    const { data: live } = useQuery(crpc.chat.streaming.getActiveStreamForThread.queryOptions({ threadId: threadId as Id<"threads"> }));
    const running = live !== null && live !== undefined;
    const ended = session?.status === "ended";
    const count = comments.length;
    const removed = t`removed`;

    return (
        <section aria-label={t`Comments for the agent`} className={count === 0 ? "sr-only" : "bg-muted flex flex-col gap-2 rounded-lg border p-3 text-sm"}>
            <p className={count === 0 ? undefined : "font-medium"} role="status">
                {count > 0 && <Plural one="# comment ready to send to the agent" other="# comments ready to send to the agent" value={count} />}
            </p>
            {count > 0 && (
                <>
                    <ul className="flex flex-col gap-1">
                        {comments.map((comment) => (
                            <li className="flex items-start justify-between gap-2" key={comment.id}>
                                <span className="min-w-0">
                                    <span className="block truncate font-mono text-xs">{placeOf(comment, removed)}</span>
                                    <span className="line-clamp-2 break-words">{comment.text}</span>
                                </span>
                                <Button
                                    aria-label={t`Remove the comment on ${placeOf(comment, removed)}`}
                                    onClick={() => useDiffCommentStore.getState().remove(threadId, comment.id)}
                                    size="icon-sm"
                                    type="button"
                                    variant="ghost"
                                >
                                    <XIcon aria-hidden="true" className="size-4" />
                                </Button>
                            </li>
                        ))}
                    </ul>
                    {!composed.ok && composed.reason === "too_long" && (
                        <p className="text-xs text-amber-700 dark:text-amber-300" role="alert">
                            <Trans>These comments are too long to send as one message. Remove or shorten some.</Trans>
                        </p>
                    )}
                    {composed.ok && composed.truncated && (
                        <p className="text-muted-foreground text-xs">
                            <Trans>Quoted diff lines will be shortened to fit; your comments are sent in full.</Trans>
                        </p>
                    )}
                    {running && (
                        <p className="text-muted-foreground text-xs">
                            <Trans>The agent is working. You can send these when it is done.</Trans>
                        </p>
                    )}
                    <div className="flex gap-2">
                        <Button
                            disabled={!composed.ok || sending || running || ended}
                            onClick={() => {
                                send();
                            }}
                            size="sm"
                            type="button"
                        >
                            <SendIcon aria-hidden="true" className="size-4" />
                            <Trans>Send to agent</Trans>
                        </Button>
                        <Button disabled={sending} onClick={() => useDiffCommentStore.getState().clear(threadId)} size="sm" type="button" variant="outline">
                            <Trans>Discard comments</Trans>
                        </Button>
                    </div>
                </>
            )}
        </section>
    );
};

export default DiffCommentsDraft;
