"use client";

/**
 * The composer of a thread a coding agent runs on the user's own computer (acp-agent-host.md §3, §4.4, §4.6).
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
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { selectThreadQueue, usePromptQueueStore } from "@/features/chat/core/stores/prompt-queue-store";
import interruptAndSend from "@/features/chat/thread/interrupt-and-send";
import { useCRPC } from "@/lib/lunora/crpc";

import DiffCommentsDraft from "./diff-comments-draft";
import { canInterruptAndSend, canSendQueueHead, shouldQueueMessage } from "./host-queue";
import { MAX_HOST_PROMPT_CHARS, sendHostMessage } from "./host-send";
import useHostSendErrorMessages from "./host-send-errors";

/** How the last turn ended when the person should be offered a way on. */
const CONTINUABLE: ReadonlySet<string> = new Set(["interrupted", "timeout"]);

/** How a turn ended when it did not finish: the queue behind it waits for the person rather than starting on its own. */
const ENDED_UNFINISHED: ReadonlySet<string> = new Set(["failed", "interrupted", "revoked", "timeout"]);

/**
 * How long the queue waits, after a send was accepted, for the thread's stream to show that the turn started. Past it the
 * stream is taken as not coming, and the queue goes on, so a stream that never appears cannot hold the queue for good.
 */
const PENDING_START_MS = 5000;

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

    const messages = useHostSendErrorMessages();

    const queue = usePromptQueueStore(selectThreadQueue(threadId));
    const enqueue = usePromptQueueStore((state) => state.enqueue);
    const remove = usePromptQueueStore((state) => state.remove);
    const setPaused = usePromptQueueStore((state) => state.setPaused);
    const [pendingStart, setPendingStart] = useState(false);

    useEffect(() => {
        usePromptQueueStore.getState().hydrate(threadId);
    }, [threadId]);

    // The hold ends after a timeout: the stream normally takes over before it, and a stream that never comes must not
    // hold the queue for good.
    useEffect(() => {
        if (!pendingStart) {
            return undefined;
        }

        const timer = setTimeout(setPendingStart, PENDING_START_MS, false);

        return () => clearTimeout(timer);
    }, [pendingStart]);

    // The hold ends once the stream shows the turn started; the timer above covers a stream that never comes.
    useEffect(() => {
        if (running) {
            setPendingStart(false);
        }
    }, [running]);

    const send = async (prompt: string, queuedId?: string) => {
        // A queued message is sent under its queue id, which is stored with it, so a retry after a lost answer finds the
        // first try, even across a reload, and two queued messages with the same text stay two messages. A direct send
        // keeps the id of its text's previous try: a different text is a different message and gets its own.
        let requestId = queuedId;

        if (requestId === undefined) {
            if (attempt.current?.text !== prompt) {
                attempt.current = { id: crypto.randomUUID(), text: prompt };
            }

            requestId = attempt.current.id;
        }

        setSending(true);

        const result = await sendHostMessage({ requestId, text: prompt, threadId });

        if (result.ok) {
            attempt.current = undefined;

            // Every accepted send holds the next message until its stream shows the turn started: one typed in that gap
            // would be refused as `turn_running`. The hold is taken before the head leaves the queue, so the queue's next
            // message never sees both as clear.
            setPendingStart(true);

            if (queuedId !== undefined) {
                remove(threadId, queuedId);
            }

            setSending(false);

            // Continue sends a fixed prompt: a draft being typed beside it stays.
            if (queuedId === undefined) {
                setText((current) => (current.trim() === prompt ? "" : current));
            }

            return;
        }

        setSending(false);

        // A queued message that was refused waits at the head for the person: the queue pauses, and "Send next" retries it.
        if (queuedId !== undefined) {
            setPaused(threadId, true);
        }

        toast.error(messages[result.error]);
    };

    const trimmed = text.trim();
    const status = session?.status;
    const blocked = status === "ended";
    const lastEnd = session?.lastEndReason;
    // With messages queued, Continue would wait behind them, so the queue's own Send next is the way on.
    const offerContinue = !running && !blocked && lastEnd !== undefined && CONTINUABLE.has(lastEnd) && queue.items.length === 0;
    const canWrite = trimmed !== "" && trimmed.length <= MAX_HOST_PROMPT_CHARS && !blocked;
    const queueing = shouldQueueMessage({ pendingStart, queued: queue.items.length, running });
    const head = queue.items[0];
    // Until both queries answer, "no session" and "no stream" are unknown, not idle: nothing drains before that.
    const loaded = session !== undefined && live !== undefined;

    // A turn that ended in failure leaves what is queued behind it paused, for the person to send next.
    const wasRunning = useRef(running);

    useEffect(() => {
        const justEnded = wasRunning.current && !running;

        wasRunning.current = running;

        if (justEnded && lastEnd !== undefined && ENDED_UNFINISHED.has(lastEnd)) {
            setPaused(threadId, true);
        }
    }, [lastEnd, running, setPaused, threadId]);

    useEffect(() => {
        if (head === undefined || !canSendQueueHead({ blocked, loaded, paused: queue.paused, pendingStart, queued: queue.items.length, running, sending })) {
            return;
        }

        void send(head.text, head.id);
        // `send` closes over the attempt ref and the store actions only; the head and the gates are what decide a send.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [head, queue.paused, queue.items.length, blocked, pendingStart, running, sending]);

    /** A message typed now goes behind the queue while a turn runs, and is sent at once otherwise. */
    const submit = (prompt: string) => {
        if (queueing) {
            enqueue(threadId, { attachments: [], text: prompt });
            setText((current) => (current.trim() === prompt ? "" : current));

            return;
        }

        void send(prompt);
    };

    // A send in flight takes no new message, so one text cannot be queued twice.
    const canSubmit = canWrite && !sending;

    /** Interrupt and send: the text goes to the head of the queue, then the running reply is stopped, so it goes next. */
    const interrupt = () => {
        interruptAndSend(threadId, trimmed, async () => {
            const outcome = await cancel.mutateAsync({ threadId: id }).catch(() => undefined);

            if (outcome?.cancelled !== true) {
                // The reply did not stop, so the text waits at the head of the queue for the person, rather than going out after the reply.
                setPaused(threadId, true);
                toast.error(t`Could not stop the reply. Your message is queued; send it next when you are ready.`);
            }
        });
        setText("");
    };

    /** Stop keeps what is queued behind the reply: the queue pauses first, so nothing starts once the reply is stopped. */
    const stop = () => {
        if (queue.items.length > 0) {
            setPaused(threadId, true);
        }

        cancel.mutate({ threadId: id });
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (!canSubmit || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
            return;
        }

        event.preventDefault();
        submit(trimmed);
    };

    const answerRequest = (request: PendingRequest, optionId: string) => {
        answer.mutate(
            { optionId, requestId: request.requestId, threadId: id },
            {
                onError: () => toast.error(t`Could not send your answer.`),
                onSuccess: (result) => {
                    if (!result.sent) {
                        toast.error(result.reason === "not_waiting" ? t`That request is no longer waiting.` : messages[result.reason ?? "busy"]);
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
            <DiffCommentsDraft threadId={threadId} />
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
                            submit(t`Continue where you left off.`);
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                    >
                        {t`Continue`}
                    </Button>
                </div>
            )}
            {queue.items.length > 0 && (
                <section aria-label={t`Queued messages`} className="flex flex-col gap-2">
                    <ol className="flex flex-col gap-1">
                        {queue.items.map((item, index) => (
                            <li className="bg-muted flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm" key={item.id}>
                                <span className="min-w-0 truncate">{item.text}</span>
                                <span className="flex shrink-0 gap-1">
                                    {index === 0 && queue.paused && (
                                        <Button disabled={blocked || sending} onClick={() => setPaused(threadId, false)} size="sm" type="button">
                                            {t`Send next`}
                                        </Button>
                                    )}
                                    <Button disabled={sending && index === 0} onClick={() => remove(threadId, item.id)} size="sm" type="button" variant="ghost">
                                        {t`Remove`}
                                    </Button>
                                </span>
                            </li>
                        ))}
                    </ol>
                    {queue.paused ? (
                        <p className="text-muted-foreground text-xs" role="status">
                            {t`The queue is paused because a message did not go out. Send next to try again.`}
                        </p>
                    ) : (
                        running && (
                            <p className="text-muted-foreground text-xs" role="status">
                                {t`Queued messages go out in order once the reply ends.`}
                            </p>
                        )
                    )}
                </section>
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
                {running && canInterruptAndSend() && (
                    <Button disabled={cancel.isPending || !canWrite} onClick={interrupt} type="button" variant="outline">
                        {t`Interrupt and send`}
                    </Button>
                )}
                {running && (
                    <Button aria-label={t`Stop`} disabled={cancel.isPending} onClick={stop} type="button" variant="outline">
                        <Square aria-hidden="true" className="size-4" />
                    </Button>
                )}
                <Button disabled={!canSubmit} onClick={() => submit(trimmed)} type="button">
                    {queueing ? t`Queue` : t`Send`}
                </Button>
            </div>
        </div>
    );
};

export default HostComposer;
