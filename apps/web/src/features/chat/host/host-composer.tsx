"use client";

/**
 * The composer of a thread a coding agent runs on the user's own computer (acp-agent-host.md §3, §4.4, §4.6).
 * Everything here is a request to that computer, not a cloud run: the message goes to `POST /hosts/send`, Stop and
 * the permission answers are procedures that queue signed commands, and what the agent is doing is read from the
 * thread's stream like any other viewer's. Chat text never answers a permission request: only the buttons do, and
 * only with an option the agent itself offered, allow once or decline.
 */

import { useLingui } from "@lingui/react/macro";
import { findHiddenText, stripHiddenText } from "@neore/ai/utils";
import type { Id } from "@neore/backend/dataModel";
import { useUnlockProof } from "@neore/client-runtime";
import { Button } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, ShieldQuestion, Square } from "lucide-react";
import type { FC, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { selectThreadQueue, usePromptQueueStore } from "@/features/chat/core/stores/prompt-queue-store";
import { cleanPromptText } from "@/features/chat/core/utils/prompt-queue";
import { useCRPC } from "@/lib/lunora/crpc";

import DiffCommentsDraft from "./diff-comments-draft";
import { caretAfterRemoval } from "./host-caret";
import { exceedsRawInputLimit } from "./host-input";
import type { HostQueueEffect, HostQueueEvent, HostQueueState } from "./host-queue";
import { canInterruptAndSend, canSendQueueHead, holdsDrainLock, INITIAL_HOST_QUEUE, shouldQueueMessage, stepHostQueue, waitDeadline } from "./host-queue";
import { MAX_HOST_PROMPT_CHARS, sendHostMessage } from "./host-send";
import useHostSendErrorMessages from "./host-send-errors";

/** How the last turn ended when the person should be offered a way on. */
const CONTINUABLE: ReadonlySet<string> = new Set(["interrupted", "timeout"]);

/**
 * How long the queue waits for an event that may never come: an accepted send's turn showing on the session, or the end of
 * a turn whose stop was confirmed. Past it the queue pauses for the person (or, for a confirmed stop, goes on), so a missing
 * event cannot hold the queue for good.
 */
const WAIT_DEADLINE_MS = 5000;

/** Whether a queued message is still waiting in its thread's queue, read from the store rather than from the render that sent it. */
const stillQueued = (threadId: string, id: string): boolean => usePromptQueueStore.getState().queues[threadId]?.items.some((item) => item.id === id) ?? false;

/**
 * Tabs that show one thread share a drain lock, so only one of them sends the head of the queue at a time. The lock is held
 * until the send's turn has started (or the hold ends), so a tab that gets the lock next finds the turn running and waits,
 * instead of being refused as `turn_running` and pausing its queue. Where the browser has no Web Locks, each tab sends alone.
 */
const drainLockName = (threadId: string): string => `neore-host-queue:${threadId}`;

/**
 * The hold a granted drain keeps on the lock, by the composer that took it (its scope's signal): resolved once its send's
 * turn has started, or its send failed. Only that composer releases it.
 */
const drainHolds = new Map<AbortSignal, () => void>();

const releaseDrainHold = (owner: AbortSignal | undefined): void => {
    if (owner === undefined) {
        return;
    }

    const release = drainHolds.get(owner);

    drainHolds.delete(owner);
    release?.();
};

/** Sends the queue's head once this tab holds the thread's drain lock, and only if it may still send then. */
const sendUnderDrainLock = (threadId: string, signal: AbortSignal, mayStart: () => Promise<boolean>, start: () => Promise<void>): void => {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;

    if (locks === undefined) {
        void start();

        return;
    }

    // A request still waiting when its composer goes away is dropped: the state it would send from is no longer shown.
    void locks
        .request(drainLockName(threadId), { signal }, async () => {
            // The gates may have moved while this tab waited for the lock: the other tab's turn may already be running.
            if (!(await mayStart())) {
                return;
            }

            await new Promise<void>((resolve) => {
                drainHolds.set(signal, resolve);
                void start();
            });
        })
        .catch(async (error: unknown) => {
            // An aborted request is a composer that went away. A refused one (the browser exposes locks but will not grant this
            // one) falls back to sending alone, as without Web Locks, rather than leaving the queue waiting in silence.
            if (!(error instanceof DOMException && error.name === "AbortError") && !signal.aborted && (await mayStart())) {
                void start();
            }
        });
};

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

const HostComposerForThread: FC<{ className?: string; threadId: string }> = ({ className, threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const id = threadId as Id<"threads">;
    const [text, setText] = useState("");
    // Set when a paste was refused, so the field keeps saying why until the next accepted edit (the toast fades).
    const [refusedPaste, setRefusedPaste] = useState(false);
    // Counts the refusals, so a send clears only those that came before it, not one made while it was in flight.
    const refusals = useRef(0);
    // The box's text as the last change left it, read by a send that finishes after the person has typed.
    const boxText = useRef("");
    const attempt = useRef<{ id: string; text: string } | undefined>(undefined);
    const {
        data: session,
        dataUpdatedAt: sessionAt,
        isError: sessionFailed,
        isFetchedAfterMount: sessionFetched,
        refetch: refetchSession,
    } = useQuery(crpc.acp.functions.getHostSession.queryOptions({ threadId }));
    // A locked chat answers its stream query only with the passcode proof, so the proof goes with it; otherwise a turn that
    // is running reads as idle and the queue retries against it.
    const unlockProof = useUnlockProof(threadId);
    const {
        data: live,
        dataUpdatedAt: liveAt,
        isError: liveFailed,
        isFetchedAfterMount: liveFetched,
        refetch: refetchLive,
    } = useQuery(crpc.chat.streaming.getActiveStreamForThread.queryOptions({ threadId: id, unlockProof }));
    // A result from before this mount is not what this composer observed. Lunora's queries never go stale, so a remount takes
    // a cached result and nothing refetches it: only an answer after the mount counts.
    const [mountedAt] = useState(() => Date.now());
    const sessionFresh = sessionFetched || sessionAt > mountedAt;
    const liveFresh = liveFetched || liveAt > mountedAt;

    // A cached result from before the mount is asked again, once: a live query may not deliver a new value on its own.
    useEffect(() => {
        if (session !== undefined && !sessionFresh) {
            void refetchSession();
        }
    }, [session, sessionFresh, refetchSession]);
    useEffect(() => {
        if (live !== undefined && !liveFresh) {
            void refetchLive();
        }
    }, [live, liveFresh, refetchLive]);

    const running = live !== null && live !== undefined;
    const { data: waiting } = useQuery(crpc.acp.remote.getHostPendingPermissions.queryOptions(running ? { threadId: id } : skipToken));
    const cancel = useMutation(crpc.acp.remote.cancelHostTurn.mutationOptions());
    const answer = useMutation(crpc.acp.remote.answerHostPermission.mutationOptions());

    const messages = useHostSendErrorMessages();

    const queue = usePromptQueueStore(selectThreadQueue(threadId));
    const enqueue = usePromptQueueStore((state) => state.enqueue);
    const remove = usePromptQueueStore((state) => state.remove);
    const setPaused = usePromptQueueStore((state) => state.setPaused);
    const edit = usePromptQueueStore((state) => state.edit);
    const enqueueNext = usePromptQueueStore((state) => state.enqueueNext);
    const [editing, setEditing] = useState<{ id: string; text: string } | undefined>(undefined);
    const boxRef = useRef<HTMLTextAreaElement>(null);
    const editorRef = useRef<HTMLTextAreaElement>(null);

    // Opening an editor moves focus into it; closing one returns focus to the composer (Save and Cancel do that).
    useEffect(() => {
        editorRef.current?.focus();
    }, [editing?.id]);
    // Absent means queue: a message sent during a turn waits behind it, unless the person chose to interrupt.
    const userSettings = useUserSettings();
    const steerOnSend = userSettings.data?.hostFollowUpSteer === true;
    // The reason the head was refused, kept beside the paused queue after the toast has gone.
    const [queueError, setQueueError] = useState<string | undefined>(undefined);

    useEffect(() => {
        usePromptQueueStore.getState().hydrate(threadId);
    }, [threadId]);

    // The queue's state machine (`host-queue.ts`). The ref is the truth, written synchronously on every event, so a decision
    // made between two renders (a lock granted, an answer arriving) reads the current phase; the state re-renders from it.
    const machineRef = useRef<HostQueueState>(INITIAL_HOST_QUEUE);
    const [machine, setMachine] = useState<HostQueueState>(INITIAL_HOST_QUEUE);

    const applyEffect = (effect: HostQueueEffect) => {
        const queued = usePromptQueueStore.getState().queues[threadId]?.items.length ?? 0;

        switch (effect.type) {
            case "pause": {
                // With nothing queued there is nothing to hold, and a pause would hold the next message the person queues.
                if (queued > 0) {
                    setPaused(threadId, true);
                }

                break;
            }
            case "resume": {
                setPaused(threadId, false);
                break;
            }
            case "send-refused": {
                const message = messages[effect.error as keyof typeof messages] ?? messages.unreachable;

                // A refusal of a message that is no longer queued (another composer delivered it, or the person removed it) is not
                // this queue's to report.
                if (effect.itemId !== undefined) {
                    if (!stillQueued(threadId, effect.itemId)) {
                        return;
                    }

                    setPaused(threadId, true);
                    setQueueError(message);
                }

                toast.error(message);
                break;
            }
            default: {
                // A stop that failed for a message the person removed while it was in flight is not this queue's to report.
                if (!stillQueued(threadId, effect.itemId)) {
                    return;
                }

                // The reply did not stop, so the text stays paused at the head for the person to send next. The reason stays
                // beside the queue after the toast has gone.
                const message =
                    effect.type === "stop-undelivered"
                        ? t`The reply stopped, but the stop did not reach the computer, so the agent may still be running. Send next once it has stopped.`
                        : t`Could not stop the reply. Your message is queued; send it next when you are ready.`;

                setQueueError(message);
                toast.error(message);
            }
        }
    };

    const dispatch = (event: HostQueueEvent) => {
        const { effects, state } = stepHostQueue(machineRef.current, event);

        machineRef.current = state;
        setMachine(state);

        for (const effect of effects) {
            applyEffect(effect);
        }
    };

    const { phase } = machine;
    const sending = phase.kind === "sending";
    const interrupting = phase.kind === "awaiting-stop";

    const trimmed = cleanPromptText(text);
    const status = session?.status;
    const blocked = status === "ended";
    const starting = status === "starting";
    const overLimit = trimmed.length > MAX_HOST_PROMPT_CHARS;
    const limitNote = overLimit || refusedPaste;
    const lastEnd = session?.lastEndReason;
    // With messages queued, Continue would wait behind them, so the queue's own Send next is the way on.
    const offerContinue = !running && !blocked && lastEnd !== undefined && CONTINUABLE.has(lastEnd) && queue.items.length === 0;
    // A refused paste keeps the draft it replaced, so the field shows the error and nothing may send that draft.
    const canWrite = trimmed !== "" && !overLimit && !refusedPaste && !blocked;
    const queuedLabel = t`Queued messages`;
    const queuedTotal = queue.items.length;
    // One whole message, so a translation can place the number where its language needs it.
    const queuedCount = t`Queued messages: ${queuedTotal}`;
    const queueing = shouldQueueMessage({ phase, queued: queue.items.length, running, starting });
    const head = queue.items[0];
    // Until both queries answer, "no session" and "no stream" are unknown, not idle: nothing drains before that.
    // Cached results are not current: both queries must have answered since this composer mounted, or a remounted composer
    // would act on a turn's state from before it was away.
    const loaded = sessionFresh && liveFresh && session !== undefined && live !== undefined;
    // A read that failed never loads, so the queue would wait without a word: the person is told, and can retry the reads.
    // A failed refetch after a read that succeeded keeps its data, so the queue still drains: only a read never answered is shown.
    const readFailed = (sessionFailed && session === undefined) || (liveFailed && live === undefined);
    const retryReads = () => {
        void refetchSession();
        void refetchLive();
    };

    // The turn running now: the session names the live host turn, and the stream query can show it first.
    const sessionLiveStreamId = session?.liveStreamId;
    const liveStreamId = sessionLiveStreamId ?? live?.streamId;
    const endStreamId = session?.lastEndStreamId;
    const endedReason = session?.lastEndedReason;

    // Every change of what the reads say is one observation; the machine tells a new turn end from a repeat by its stream.
    useEffect(() => {
        if (!loaded) {
            return;
        }

        dispatch({
            end: endStreamId === undefined ? undefined : { reason: endedReason, streamId: endStreamId },
            live: liveStreamId,
            sessionLive: sessionLiveStreamId,
            starting,
            type: "observed",
        });
        // `dispatch` writes the machine and the store only; the observation is what decides.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loaded, liveStreamId, sessionLiveStreamId, endStreamId, endedReason, starting]);

    // A wait for an event that may never come ends after a deadline.
    useEffect(() => {
        if (!waitDeadline(phase)) {
            return undefined;
        }

        const timer = setTimeout(dispatch, WAIT_DEADLINE_MS, { type: "timed-out" });

        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase]);

    // Lock requests made for this composer are aborted when it unmounts or moves to another thread; the signal also names the
    // hold this composer takes on the lock.
    const drainScope = useRef<AbortController | undefined>(undefined);

    // The drain lock is held from a send until its turn shows; once that is over, another tab may drain.
    useEffect(() => {
        if (!holdsDrainLock(phase)) {
            releaseDrainHold(drainScope.current?.signal);
        }
    }, [phase]);

    // `draft` is the editable text a direct send came from, as it was when the send began: a success clears the box only if
    // the person has not typed since.
    const send = async (prompt: string, queuedId?: string, draft?: string) => {
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

        const before = machineRef.current;

        dispatch({ itemId: queuedId, type: "send" });

        // The machine refused it (another send is in flight, or the queue moved on since this send was decided): nothing is posted.
        if (machineRef.current === before) {
            return;
        }

        const refusalsBefore = refusals.current;
        const result = await sendHostMessage({ requestId, text: prompt, threadId });

        if (result.ok) {
            // A direct send's retry id is spent when it lands; a queued message never used it, so the draft's id is kept.
            if (queuedId === undefined) {
                attempt.current = undefined;
            } else {
                remove(threadId, queuedId);
            }

            setQueueError(undefined);
            dispatch({ itemId: queuedId, type: "accepted" });

            // Only a textarea send has a draft; Continue sends a fixed prompt and leaves the box alone. A draft typed while the
            // send was pending is not the one sent: the box and any refusal stay as they are.
            if (queuedId === undefined && draft !== undefined && boxText.current === draft) {
                boxText.current = "";
                setText("");

                if (refusals.current === refusalsBefore) {
                    setRefusedPaste(false);
                }
            }

            return;
        }

        // Another tab's turn can start before this composer's reads show it, so a refusal as a running turn reads again first,
        // with the send still in flight: nothing posts the head again meanwhile.
        let liveNow: string | undefined;

        if (result.error === "turn_running") {
            const [freshSession, freshLive] = await Promise.all([refetchSession(), refetchLive()]);

            liveNow = freshSession.data?.liveStreamId ?? freshLive.data?.streamId ?? undefined;
        }

        dispatch({ error: result.error, itemId: queuedId, live: liveNow, type: "refused" });
    };

    // Whether the queue's head, if it is still `id`, may be sent now: read from the machine and the store, which are current
    // even when this render is not, and from the reads of the last render. The drain lock asks again once it is granted.
    const gates = { blocked, editing: editing?.id, running, starting };
    const gatesRef = useRef(gates);

    useEffect(() => {
        gatesRef.current = gates;
    });

    const mayDrain = (candidate: string): boolean => {
        const current = usePromptQueueStore.getState().queues[threadId];
        const now = gatesRef.current;

        return (
            current?.items[0]?.id === candidate &&
            canSendQueueHead(machineRef.current, {
                blocked: now.blocked,
                editing: now.editing === candidate,
                headId: candidate,
                paused: current.paused,
                running: now.running,
                starting: now.starting,
            })
        );
    };

    useEffect(() => {
        const scope = new AbortController();

        drainScope.current = scope;

        return () => {
            scope.abort();
            // A hold this composer took on the lock is released with it: nothing else would end it once the composer is gone.
            releaseDrainHold(scope.signal);
        };
    }, [threadId]);

    useEffect(() => {
        const scope = drainScope.current;

        if (head === undefined || scope === undefined || !mayDrain(head.id)) {
            return;
        }

        const { id: headId, text: headText } = head;

        sendUnderDrainLock(
            threadId,
            scope.signal,
            async () => {
                if (scope.signal.aborted || !mayDrain(headId)) {
                    return false;
                }

                // What this composer last rendered can trail another tab's turn: the reads are asked again, and a turn running
                // now leaves the head for its end.
                const [freshSession, freshLive] = await Promise.all([refetchSession(), refetchLive()]);

                // An end the machine has not taken in yet (a turn that started and stopped meanwhile) is decided first, by the
                // observation it is about to get.
                const unseenEnd = freshSession.data?.lastEndStreamId !== machineRef.current.lastEnd;

                return !scope.signal.aborted && !unseenEnd && (freshSession.data?.liveStreamId ?? freshLive.data?.streamId) === undefined && mayDrain(headId);
            },
            () => send(headText, headId),
        );
        // `send` and `mayDrain` read the machine and the store when they run; the head and the gates decide when to look.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [head, queue.paused, machine, blocked, running, starting, editing]);

    /** A message typed now goes behind the queue while a turn runs, and is sent at once otherwise. */
    const submit = (prompt: string, draft?: string) => {
        if (queueing) {
            // A draft whose direct send failed is retried, not new: the first queued retry keeps that send's id, so a send the
            // backend already took is recognised as the same message. The id is handed over once; a later submission is new.
            const retryId = attempt.current?.text === prompt ? attempt.current.id : undefined;

            if (retryId !== undefined) {
                attempt.current = undefined;
            }

            enqueue(threadId, { attachments: [], id: retryId, text: prompt });

            if (draft !== undefined && boxText.current === draft) {
                boxText.current = "";
                setText("");
            }

            return;
        }

        void send(prompt, undefined, draft);
    };

    // While a turn runs, a send depends on the interrupt setting: nothing is sent until the setting has loaded. A failed read
    // is not a pending one; the setting then reads as its default, which queues.
    const canSubmit = canWrite && !sending && (!running || !userSettings.isPending);
    // Send is off only for that wait, so the person is told what it waits for.
    const waitsForSetting = canWrite && !sending && running && userSettings.isPending;

    /** Interrupt and send: the text goes to the head of the queue, then the running reply is stopped, so it goes next. */
    const interrupt = () => {
        const wasPaused = usePromptQueueStore.getState().queues[threadId]?.paused === true;

        // Not the id of a direct send whose answer was lost: the reply stopped here may be that very send, and a resend under
        // its id would come back as a duplicate of the stopped turn, so the text would never run. The text gets a new id, and
        // the lost send's id is spent, so a later send of the same text is not taken for it either.
        if (attempt.current?.text === trimmed) {
            attempt.current = undefined;
        }

        enqueueNext(threadId, { attachments: [], text: trimmed });
        const interruptId = usePromptQueueStore.getState().queues[threadId]?.items[0]?.id;

        boxText.current = "";
        setText("");

        if (interruptId === undefined) {
            return;
        }

        // The text waits at the head, paused, until the stop is answered AND the stopped turn's end is seen.
        const streamId = liveStreamId as Id<"persistentStreams"> | undefined;

        dispatch({ itemId: interruptId, streamId, type: "interrupt", wasPaused });
        void cancel
            .mutateAsync({ streamId, threadId: id })
            .catch(() => undefined)
            .then((outcome) => dispatch({ outcome, type: "stop-answered" }));
    };

    /** Stop keeps what is queued behind the reply: the queue pauses first, so nothing starts once the reply is stopped. */
    const stop = () => {
        dispatch({ type: "stopped" });
        cancel.mutate({ threadId: id });
    };

    // With the setting on, a message during a turn interrupts it, unless a stop is already pending: a second stop would
    // put a second message ahead of the first one typed.
    const steering = running && steerOnSend && !cancel.isPending && !interrupting && canInterruptAndSend();
    let sendLabel = t`Send`;

    if (steering) {
        sendLabel = t`Interrupt and send`;
    } else if (queueing) {
        sendLabel = t`Queue`;
    }

    /** Enter and the primary button do the same: interrupt while steering, otherwise queue or send. */
    const sendOrInterrupt = () => {
        if (steering) {
            interrupt();

            return;
        }

        submit(trimmed, text);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (!canSubmit || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
            return;
        }

        event.preventDefault();
        sendOrInterrupt();
    };

    /** Saves an edit of a queued message. An empty or over-long text leaves the message as it was. */
    const saveEdit = () => {
        if (editing === undefined) {
            return;
        }

        const next = cleanPromptText(editing.text);
        const position = queue.items.findIndex((item) => item.id === editing.id);
        const original = queue.items[position]?.text;

        if (next !== "" && next.length <= MAX_HOST_PROMPT_CHARS && next !== original && position !== -1) {
            edit(threadId, editing.id, next);

            // A changed refused head is a new message: the reason its old send was refused no longer describes it.
            if (position === 0) {
                setQueueError(undefined);
            }

            // The edited message took a new id: whatever the machine held it by follows it.
            const renamed = usePromptQueueStore.getState().queues[threadId]?.items[position]?.id;

            if (renamed !== undefined && renamed !== editing.id) {
                dispatch({ from: editing.id, to: renamed, type: "edited" });
            }
        }

        setEditing(undefined);
        boxRef.current?.focus();
    };

    // An edit that looks filled but is only hidden characters cleans to nothing: Save is off, and the note says why.
    const onlyHidden = editing !== undefined && editing.text.trim() !== "" && cleanPromptText(editing.text) === "";

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
            <p aria-live="polite" className="sr-only" role="status">
                {queue.items.length > 0 ? queuedCount : ""}
            </p>
            {queue.items.length > 0 && (
                <section aria-label={queuedLabel} className="flex flex-col gap-2">
                    <ol className="flex flex-col gap-1">
                        {queue.items.map((item, index) => (
                            <li className="bg-muted flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm" key={item.id}>
                                {editing?.id === item.id ? (
                                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                                        <textarea
                                            aria-label={t`Edit queued message`}
                                            className="bg-background w-full resize-none rounded-md border px-2 py-1 text-sm"
                                            maxLength={MAX_HOST_PROMPT_CHARS}
                                            onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
                                            ref={editorRef}
                                            rows={2}
                                            value={editing.text}
                                        />
                                        {onlyHidden && (
                                            <p className="text-muted-foreground text-xs" id="host-queue-edit-note" role="status">
                                                {t`This text is only hidden characters, so there is nothing to save.`}
                                            </p>
                                        )}
                                        <span className="flex gap-1">
                                            <Button
                                                aria-describedby={onlyHidden ? "host-queue-edit-note" : undefined}
                                                disabled={cleanPromptText(editing.text) === "" || cleanPromptText(editing.text).length > MAX_HOST_PROMPT_CHARS}
                                                onClick={saveEdit}
                                                size="sm"
                                                type="button"
                                            >
                                                {t`Save`}
                                            </Button>
                                            <Button
                                                onClick={() => {
                                                    setEditing(undefined);
                                                    boxRef.current?.focus();
                                                }}
                                                size="sm"
                                                type="button"
                                                variant="ghost"
                                            >
                                                {t`Cancel`}
                                            </Button>
                                        </span>
                                    </div>
                                ) : (
                                    <span className="min-w-0 truncate">{item.text}</span>
                                )}
                                <span className="flex shrink-0 gap-1">
                                    {index === 0 && queue.paused && (
                                        <Button
                                            disabled={blocked || sending}
                                            onClick={() => {
                                                setQueueError(undefined);
                                                setPaused(threadId, false);
                                            }}
                                            size="sm"
                                            type="button"
                                        >
                                            {t`Send next`}
                                        </Button>
                                    )}
                                    {editing?.id !== item.id && (
                                        <Button
                                            aria-label={t`Edit queued message ${index + 1}`}
                                            disabled={phase.kind === "sending" && phase.itemId === item.id}
                                            onClick={() => setEditing({ id: item.id, text: item.text })}
                                            size="sm"
                                            type="button"
                                            variant="ghost"
                                        >
                                            {t`Edit`}
                                        </Button>
                                    )}
                                    <Button
                                        aria-label={t`Remove queued message ${index + 1}`}
                                        disabled={phase.kind === "sending" && phase.itemId === item.id}
                                        onClick={() => {
                                            // The refusal reason belongs to the head only: removing a later message leaves it.
                                            if (index === 0) {
                                                setQueueError(undefined);
                                            }

                                            remove(threadId, item.id);
                                        }}
                                        size="sm"
                                        type="button"
                                        variant="ghost"
                                    >
                                        {t`Remove`}
                                    </Button>
                                </span>
                            </li>
                        ))}
                    </ol>
                    {queueError !== undefined && (
                        <p className="text-destructive text-xs" role="alert">
                            {queueError}
                        </p>
                    )}
                    {readFailed && (
                        <div className="text-destructive flex items-center gap-2 text-xs" role="alert">
                            <span>{t`The chat's state could not be read, so queued messages wait.`}</span>
                            <Button onClick={retryReads} size="sm" type="button" variant="outline">
                                {t`Retry`}
                            </Button>
                        </div>
                    )}
                    {queue.paused ? (
                        <p className="text-muted-foreground text-xs" role="status">
                            {t`The queue is paused. Send next to go on with the queued messages.`}
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
                    aria-describedby={limitNote ? "host-composer-limit" : undefined}
                    aria-invalid={limitNote || undefined}
                    aria-label={t`Message to the coding agent`}
                    className="bg-background min-h-11 flex-1 resize-none rounded-lg border px-3 py-2 text-sm disabled:opacity-60"
                    disabled={blocked}
                    onChange={(event) => {
                        // Typed and pasted text both come through here, whole: a length limit on the element would cut a paste
                        // before its hidden characters are removed. A joiner at the end waits for the next letter.
                        const element = event.currentTarget;
                        const { selectionStart, selectionEnd, value } = element;

                        // Refused before any scan: the controlled value stays as it was.
                        if (exceedsRawInputLimit(value, MAX_HOST_PROMPT_CHARS)) {
                            refusals.current += 1;
                            setRefusedPaste(true);
                            toast.error(messages.too_large);

                            return;
                        }

                        setRefusedPaste(false);

                        const { removed, text: clean } = stripHiddenText(value, { keepTrailingJoiner: true });

                        if (removed > 0) {
                            // A stable id: repeated removals update one notification instead of stacking.
                            toast.info(t`Hidden characters were removed from your message.`, { id: "host-composer-hidden-text" });

                            // The controlled value is set back to the clean text after this handler, which moves the caret to the end.
                            // Put it where the person left it, once that has happened.
                            const hidden = findHiddenText(value, { keepTrailingJoiner: true });
                            const start = caretAfterRemoval(selectionStart, hidden);
                            const end = caretAfterRemoval(selectionEnd, hidden);

                            queueMicrotask(() => element.setSelectionRange(start, end));
                        }

                        boxText.current = clean;
                        setText(clean);
                    }}
                    onKeyDown={onKeyDown}
                    placeholder={t`Message the agent on your computer`}
                    ref={boxRef}
                    rows={2}
                    value={text}
                />
                {running && !steerOnSend && !interrupting && canInterruptAndSend() && (
                    <Button disabled={cancel.isPending || !canSubmit} onClick={interrupt} type="button" variant="outline">
                        {t`Interrupt and send`}
                    </Button>
                )}
                {running && (
                    <Button aria-label={t`Stop`} disabled={cancel.isPending} onClick={stop} type="button" variant="outline">
                        <Square aria-hidden="true" className="size-4" />
                    </Button>
                )}
                <Button disabled={!canSubmit} onClick={sendOrInterrupt} type="button">
                    {sendLabel}
                </Button>
            </div>
            {waitsForSetting && (
                <p className="text-muted-foreground text-xs" role="status">
                    {t`Checking whether a message sent now interrupts the reply or waits behind it.`}
                </p>
            )}
            {limitNote && (
                <p className="text-destructive text-xs" id="host-composer-limit" role="status">
                    {messages.too_large}
                </p>
            )}
        </div>
    );
};

/**
 * One composer per thread: its queue hold, the send in flight and the turn being tracked belong to that thread, so a
 * switch to another thread starts them fresh instead of carrying them over.
 */
const HostComposer: FC<{ className?: string; threadId: string }> = ({ className, threadId }) => (
    <HostComposerForThread className={className} key={threadId} threadId={threadId} />
);

export default HostComposer;
