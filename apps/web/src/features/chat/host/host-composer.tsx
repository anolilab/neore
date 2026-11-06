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
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import ContextUsageMeter from "@/features/chat/thread/context-usage-meter";
import { useCRPC } from "@/lib/lunora/crpc";

import DiffCommentsDraft from "./diff-comments-draft";
import HostOptions from "./host-options";
import { MAX_HOST_PROMPT_CHARS, sendHostMessage } from "./host-send";
import useHostSendErrorMessages from "./host-send-errors";
import type { AgentCommand } from "./host-slash";
import { insertCommand, matchingCommands, slashAtCursor } from "./host-slash";
import { formatReportedCost } from "./reported-cost";

/** The keys the open `/` menu takes for itself. */
const SLASH_KEYS: ReadonlySet<string> = new Set(["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"]);

/** The caret of the textarea: the end a selection moves from. A forward selection leaves it at the end, a backward one at the start. */
const caretOf = (element: HTMLTextAreaElement): number => (element.selectionDirection === "backward" ? element.selectionStart : element.selectionEnd);

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
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const id = threadId as Id<"threads">;
    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);
    const [cursor, setCursor] = useState(0);
    const [activeIndex, setActiveIndex] = useState(0);
    // The text an Escape closed the menu for: any edit reopens it.
    const [closedFor, setClosedFor] = useState<{ start: number; text: string } | undefined>(undefined);
    // The menu belongs to the draft being typed in: leaving the box closes it, as Escape does.
    const [focused, setFocused] = useState(false);
    const box = useRef<HTMLTextAreaElement>(null);
    const pendingCursor = useRef<number | undefined>(undefined);
    const list = useRef<HTMLUListElement>(null);
    const listId = useId();
    const attempt = useRef<{ id: string; text: string } | undefined>(undefined);
    const { data: session } = useQuery(crpc.acp.functions.getHostSession.queryOptions({ threadId }));
    const { data: live } = useQuery(crpc.chat.streaming.getActiveStreamForThread.queryOptions({ threadId: id }));
    const running = live !== null && live !== undefined;
    const { data: waiting } = useQuery(crpc.acp.remote.getHostPendingPermissions.queryOptions(running ? { threadId: id } : skipToken));
    const cancel = useMutation(crpc.acp.remote.cancelHostTurn.mutationOptions());
    const answer = useMutation(crpc.acp.remote.answerHostPermission.mutationOptions());

    const messages = useHostSendErrorMessages();

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
    const usage = session?.agentState?.usage;
    const lastEnd = session?.lastEndReason;
    const offerContinue = !running && !blocked && lastEnd !== undefined && CONTINUABLE.has(lastEnd);

    const slash = slashAtCursor(text, cursor);
    const commands = session?.agentState?.availableCommands;
    const choices: AgentCommand[] =
        slash === null || commands === undefined || (closedFor?.text === text && closedFor.start === slash.start)
            ? []
            : matchingCommands(commands, slash.query);
    // A session that has ended disables the input, so its menu must not stay open over a control nobody can use.
    const menuOpen = !blocked && focused && slash !== null && choices.length > 0;
    const active = Math.min(activeIndex, Math.max(choices.length - 1, 0));
    const agentLabel = session?.agentLabel ?? t`Agent`;

    // After a pick the text is replaced; the cursor can only be placed once the textarea shows it.
    useEffect(() => {
        if (pendingCursor.current === undefined || box.current === null) {
            return;
        }

        box.current.setSelectionRange(pendingCursor.current, pendingCursor.current);
        pendingCursor.current = undefined;
    }, [text]);

    // The popup scrolls, so the active command is brought into view as the arrows move it.
    useEffect(() => {
        if (menuOpen) {
            list.current?.children.item(active)?.scrollIntoView({ block: "nearest" });
        }
    }, [active, menuOpen]);

    const pick = (command: AgentCommand) => {
        if (slash === null) {
            return;
        }

        const next = insertCommand(text, slash, command);

        // A pick that would make the draft too long to send is refused, so the draft stays one the person can send.
        if (next.text.length > MAX_HOST_PROMPT_CHARS) {
            toast.error(t`That command would make the message too long to send.`);

            return;
        }

        setCursor(next.cursor);
        setActiveIndex(0);
        box.current?.focus();

        if (next.text === text) {
            // The text does not change, so the effect above would not run: the caret is placed now, or it would wait for a later edit.
            pendingCursor.current = undefined;
            box.current?.setSelectionRange(next.cursor, next.cursor);

            return;
        }

        pendingCursor.current = next.cursor;
        setText(next.text);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        const chosen = choices[active];

        // Shift+Enter and Shift+Tab keep their usual meaning (a newline, the previous control), Ctrl/Cmd+Enter still sends, and an
        // arrow with a modifier (Shift extends the selection) is the textarea's, even while the menu is open.
        const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
        const menuKey =
            SLASH_KEYS.has(event.key) &&
            !(event.shiftKey && (event.key === "Enter" || event.key === "Tab")) &&
            !((event.ctrlKey || event.metaKey) && event.key === "Enter") &&
            !(arrow && (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey));

        if (menuOpen && !event.nativeEvent.isComposing && menuKey) {
            event.preventDefault();

            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                setActiveIndex((active + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length);
            } else if (event.key === "Escape") {
                setClosedFor(slash === null ? undefined : { start: slash.start, text });
            } else if (chosen !== undefined && !event.shiftKey) {
                pick(chosen);
            }

            return;
        }

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
            {usage !== undefined && usage.size > 0 && (
                <div className="flex justify-end">
                    <ContextUsageMeter
                        contextWindow={usage.size}
                        detail={usage.cost === undefined ? undefined : t`Cost reported by the agent: ${formatReportedCost(usage.cost, i18n.locale)}`}
                        usedTokens={usage.used}
                    />
                </div>
            )}
            {/* Keyed by the session too: a new session in the thread starts with no change of its own waiting. */}
            <HostOptions
                ended={blocked}
                key={`${threadId}:${session?._id ?? ""}`}
                optionResult={session?.optionResult}
                state={session?.agentState}
                threadId={threadId}
            />
            <div className="flex items-end gap-2">
                <div className="relative min-w-0 flex-1">
                    {menuOpen && (
                        <ul
                            aria-label={t`Commands from ${agentLabel}`}
                            className="bg-popover absolute bottom-full left-0 z-10 mb-1 max-h-64 w-full max-w-md overflow-auto rounded-lg border p-1 text-sm shadow-md"
                            id={listId}
                            ref={list}
                            role="listbox"
                        >
                            {choices.map((command, index) => (
                                <li
                                    aria-selected={index === active}
                                    className={cn("flex cursor-pointer flex-col gap-0.5 rounded px-2 py-1.5", index === active && "bg-accent")}
                                    id={`${listId}-${index}`}
                                    key={command.name}
                                    onMouseDown={(event) => {
                                        event.preventDefault();
                                        pick(command);
                                    }}
                                    role="option"
                                >
                                    <span className="flex items-baseline gap-2">
                                        <span className="font-mono font-medium">{`/${command.name}`}</span>
                                        {command.hint !== undefined && command.hint !== "" && (
                                            <span className="text-muted-foreground font-mono text-xs">{command.hint}</span>
                                        )}
                                        <span className="text-muted-foreground ml-auto shrink-0 rounded border px-1 text-xs">{agentLabel}</span>
                                    </span>
                                    {command.description !== undefined && command.description !== "" && (
                                        <span className="text-muted-foreground text-xs">{command.description}</span>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                    <textarea
                        aria-activedescendant={menuOpen ? `${listId}-${active}` : undefined}
                        aria-autocomplete="list"
                        aria-controls={menuOpen ? listId : undefined}
                        aria-expanded={menuOpen}
                        aria-label={t`Message to the coding agent`}
                        className="bg-background min-h-11 w-full resize-none rounded-lg border px-3 py-2 text-sm disabled:opacity-60"
                        disabled={blocked}
                        maxLength={MAX_HOST_PROMPT_CHARS}
                        onBlur={() => setFocused(false)}
                        onChange={(event) => {
                            setText(event.target.value);
                            // Any edit reopens the menu: a dismissal holds for the text it was made on, and only until the next edit.
                            setClosedFor(undefined);
                            setCursor(caretOf(event.target));
                            setActiveIndex(0);
                        }}
                        onClick={(event) => setCursor(caretOf(event.currentTarget))}
                        onFocus={() => setFocused(true)}
                        onKeyDown={onKeyDown}
                        onKeyUp={(event) => setCursor(caretOf(event.currentTarget))}
                        placeholder={t`Message the agent on your computer`}
                        ref={box}
                        role="combobox"
                        rows={2}
                        value={text}
                    />
                </div>
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
