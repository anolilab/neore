"use client";

/**
 * The composer of a thread a coding agent runs on the user's own computer (plans/acp-agent-host.md §3, §4.4, §4.6).
 * Everything here is a request to that computer, not a cloud run: the message goes to `POST /hosts/send`, Stop and
 * the permission answers are procedures that queue signed commands, and what the agent is doing is read from the
 * thread's stream like any other viewer's. Chat text never answers a permission request: only the buttons do, and
 * only with an option the agent itself offered, allow once or decline.
 */

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, ShieldQuestion, Square } from "lucide-react";
import type { FC, KeyboardEvent } from "react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

import type { HostSendError } from "./host-send";
import { MAX_HOST_PROMPT_CHARS, sendHostMessage } from "./host-send";

/** How the last turn ended when the person should be offered a way on. */
const CONTINUABLE: ReadonlySet<string> = new Set(["interrupted", "timeout"]);

interface PendingRequest {
    command?: string;
    folder?: string;
    incomplete?: boolean;
    options: { kind: string; name: string; optionId: string }[];
    requestId: string;
    target?: string;
    tool: string;
}

const PermissionRequestCard: FC<{ busy: boolean; onAnswer: (optionId: string) => void; request: PendingRequest }> = ({ busy, onAnswer, request }) => {
    const { t } = useLingui();
    const allow = request.options.find((option) => option.kind === "allow_once");
    const reject = request.options.find((option) => option.kind === "reject_once");

    return (
        <li className="bg-muted rounded-lg border p-3 text-sm">
            <p className="flex items-center gap-2 font-medium">
                <ShieldQuestion aria-hidden="true" className="size-4 shrink-0" />
                <span>{request.tool}</span>
            </p>
            {request.target !== undefined && <p className="text-muted-foreground mt-1 font-mono text-xs break-all">{request.target}</p>}
            {request.command !== undefined && (
                <pre className="mt-1 max-h-32 overflow-auto rounded border p-2 font-mono text-xs whitespace-pre-wrap">{request.command}</pre>
            )}
            {request.folder !== undefined && <p className="text-muted-foreground mt-1 text-xs">{t`In ${request.folder}`}</p>}
            {request.incomplete === true && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-300" role="note">
                    {t`This request was too long to show whole. You can decline it here; to allow it, answer on your computer.`}
                </p>
            )}
            <div className="mt-2 flex gap-2">
                {allow !== undefined && (
                    <Button disabled={busy} onClick={() => onAnswer(allow.optionId)} size="sm" type="button">
                        {t`Allow once`}
                    </Button>
                )}
                {reject !== undefined && (
                    <Button disabled={busy} onClick={() => onAnswer(reject.optionId)} size="sm" type="button" variant="outline">
                        {t`Decline`}
                    </Button>
                )}
            </div>
        </li>
    );
};

const HostComposer: FC<{ className?: string; threadId: string }> = ({ className, threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const id = threadId as Id<"threads">;
    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);
    const attempt = useRef<{ id: string; text: string } | undefined>(undefined);
    const { data: session } = useQuery(crpc.acp.functions.getHostSession.queryOptions({ threadId }));
    const { data: live } = useQuery(crpc.chat.streaming.getActiveStreamForThread.queryOptions({ threadId: id }));
    const running = live !== null && live !== undefined;
    const { data: waiting } = useQuery(crpc.acp.remote.getHostPendingPermissions.queryOptions(running ? { threadId: id } : skipToken));
    const cancel = useMutation(crpc.acp.remote.cancelHostTurn.mutationOptions());
    const answer = useMutation(crpc.acp.remote.answerHostPermission.mutationOptions());

    const messages: Record<HostSendError, string> = {
        busy: t`Your computer is busy. Try again in a moment.`,
        not_authenticated: t`Sign in again to send.`,
        not_found: t`This chat could not be found.`,
        offline: t`Your computer is offline. Open Neore on it and try again.`,
        rate_limited: t`You are sending too fast. Wait a moment.`,
        session_ended: t`This session has ended. Start a new one from the desktop app.`,
        session_starting: t`The agent is still opening its session. Try again in a moment.`,
        too_large: t`That message is too long to send from here.`,
        turn_running: t`The agent is still working on the last message.`,
        unreachable: t`Could not reach the server. Try again.`,
    };

    const send = async (prompt: string) => {
        // One request id per message: a retry of a lost answer finds the first try, not a second turn. A different
        // text (an edit after a failure, or Continue) is a different message and gets its own, or the backend would
        // call it a repeat of the first and drop it.
        if (attempt.current?.text !== prompt) {
            attempt.current = { id: crypto.randomUUID(), text: prompt };
        }

        setSending(true);

        const result = await sendHostMessage({ requestId: attempt.current.id, text: prompt, threadId });

        setSending(false);

        if (result.ok) {
            attempt.current = undefined;
            // Continue sends a fixed prompt: a draft being typed beside it stays.
            setText((current) => (current.trim() === prompt ? "" : current));

            return;
        }

        toast.error(messages[result.error]);
    };

    const trimmed = text.trim();
    const status = session?.status;
    const blocked = status === "ended";
    const canSend = trimmed !== "" && trimmed.length <= MAX_HOST_PROMPT_CHARS && !sending && !running && !blocked;
    const lastEnd = session?.lastEndReason;
    const offerContinue = !running && !blocked && lastEnd !== undefined && CONTINUABLE.has(lastEnd);

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (!(event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && canSend)) {
            return;
        }

        event.preventDefault();
        void send(trimmed);
    };

    const answerRequest = (request: PendingRequest, optionId: string) => {
        answer.mutate(
            { optionId, requestId: request.requestId, threadId: id },
            {
                onError: () => toast.error(t`Could not send your answer.`),
                onSuccess: (result) => {
                    if (!result.sent) {
                        toast.error(result.reason === "busy" ? t`Your computer is busy. Try again in a moment.` : t`That request is no longer waiting.`);
                    }
                },
            },
        );
    };

    return (
        <div className={cn("relative flex w-full flex-col gap-2", className)}>
            {waiting !== undefined && waiting.length > 0 && (
                <ul aria-label={t`Permission requests from the agent`} className="flex flex-col gap-2">
                    {waiting.map((request) => (
                        <PermissionRequestCard
                            busy={answer.isPending}
                            key={request.requestId}
                            onAnswer={(optionId) => answerRequest(request, optionId)}
                            request={request}
                        />
                    ))}
                </ul>
            )}
            {status === "starting" && (
                <p aria-live="polite" className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
                    <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                    {t`Starting the agent on your computer. A message you send now goes out once it is up.`}
                </p>
            )}
            {status === "ended" && (
                <p className="text-muted-foreground text-sm" role="status">
                    {t`This session has ended. Start a new one from the desktop app.`}
                </p>
            )}
            {offerContinue && (
                <div className="bg-muted flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm" role="status">
                    <span>{t`The last turn stopped before it finished.`}</span>
                    <Button
                        disabled={sending}
                        onClick={() => {
                            send(t`Continue where you left off.`);
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                    >
                        {t`Continue`}
                    </Button>
                </div>
            )}
            <div className="flex items-end gap-2">
                <textarea
                    aria-label={t`Message to the coding agent`}
                    className="bg-background min-h-11 flex-1 resize-none rounded-lg border px-3 py-2 text-sm disabled:opacity-60"
                    disabled={blocked}
                    maxLength={MAX_HOST_PROMPT_CHARS}
                    onChange={(event) => setText(event.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder={t`Message the agent on your computer`}
                    rows={2}
                    value={text}
                />
                {running ? (
                    <Button aria-label={t`Stop`} disabled={cancel.isPending} onClick={() => cancel.mutate({ threadId: id })} type="button" variant="outline">
                        <Square aria-hidden="true" className="size-4" />
                    </Button>
                ) : (
                    <Button
                        disabled={!canSend}
                        onClick={() => {
                            send(trimmed);
                        }}
                        type="button"
                    >
                        {t`Send`}
                    </Button>
                )}
            </div>
        </div>
    );
};

export default HostComposer;
