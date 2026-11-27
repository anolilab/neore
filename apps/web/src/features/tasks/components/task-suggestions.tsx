"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClockIcon } from "lucide-react";
import type { FC, RefObject } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { useAuthSession } from "@/features/auth/hooks/use-auth-session";
import { useCRPC } from "@/lib/lunora/crpc";

import { useScheduleLabel } from "../hooks/use-schedule-label";

interface TaskSuggestionsProps {
    /** The element that takes focus when the last suggestion leaves the list, so focus is not lost with it. */
    fallbackFocus?: RefObject<HTMLElement | null>;
}

/** Runs a call and answers whether it worked. A module-level helper: the compiler bails on `try` in a component. */
const attempt = async (run: () => Promise<unknown>): Promise<boolean> => {
    try {
        await run();

        return true;
    } catch {
        return false;
    }
};

/** Instructions longer than this are clamped to two lines and get a toggle; shorter ones are shown whole, wrapped. */
const CLAMP_THRESHOLD = 70;

/** Whether focus has fallen to the page itself, as it does when the focused element is removed. Anywhere else, the person put it there. */
const focusIsLost = (): boolean => document.activeElement === null || document.activeElement === document.body;

/**
 * The row to hand focus to when `held` (the row that last held focus) is gone from `ids`: the next row of the list as it
 * was, else the previous one, as a removal made here does. Nothing when that row is still listed or none held focus.
 */
const neighbourOfRemoved = (
    held: string | null,
    before: ReadonlyArray<string>,
    ids: ReadonlyArray<string>,
): { decided: string; next: string | null } | null => {
    if (held === null || ids.includes(held)) {
        return null;
    }

    const index = before.indexOf(held);
    const after = index === -1 ? [] : before.slice(index + 1);
    const earlier = index === -1 ? [] : before.slice(0, index).toReversed();

    return { decided: held, next: [...after, ...earlier].find((id) => ids.includes(id)) ?? null };
};

/**
 * The tasks the daily job suggests from the person's own messages: each can be accepted (which creates the task, and the
 * board shows it) or dismissed. Nothing is shown while there are none, which is also the case while the feature is off.
 * A decided row leaves the list at once, without waiting for the live list to say so. Its status region stays mounted
 * with the list empty, so the outcome of the last decision is announced.
 */
const TaskSuggestionsList: FC<TaskSuggestionsProps> = ({ fallbackFocus }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const scheduleLabel = useScheduleLabel();
    const headingId = useId();
    const items = useRef(new Map<string, HTMLLIElement>());
    // Where focus goes once the decided row has left the list: the neighbouring row (focusable, so it is read out), or the fallback.
    const focusAfter = useRef<{ decided: string; next: string | null } | null>(null);
    // The row that holds focus, and the rows as the last render listed them: a row the live list drops while it holds focus
    // takes the focus with it (the browser sends no event for that), so its neighbour has to be found from the old order.
    const heldRow = useRef<string | null>(null);
    const knownIds = useRef<ReadonlyArray<string>>([]);
    const [busyId, setBusyId] = useState<string | null>(null);
    // Rows decided in this view: hidden at once, and kept hidden if the live list answers once more from before the decision.
    const [decidedIds, setDecidedIds] = useState<ReadonlyArray<string>>([]);
    const [outcome, setOutcome] = useState<{ kind: "done" | "failed"; text: string } | null>(null);
    // Rows whose instructions are shown in full. They can run to thousands of characters, and a person must be able to read them before accepting.
    const [expandedIds, setExpandedIds] = useState<ReadonlyArray<string>>([]);

    const listQuery = crpc.tasks.suggestions.listTaskSuggestions.queryOptions({});
    const boardQuery = crpc.tasks.functions.getTaskBoard.queryOptions({});
    const { data, isError, refetch } = useQuery(listQuery);
    const suggestions = useMemo(() => (data ?? []).filter((suggestion) => !decidedIds.includes(suggestion._id)), [data, decidedIds]);
    const loadFailed = isError && data === undefined;
    const refresh = {
        onSettled: async () => {
            await queryClient.invalidateQueries({ queryKey: listQuery.queryKey });
        },
    };
    const accept = useMutation(
        crpc.tasks.suggestions.acceptTaskSuggestion.mutationOptions({
            onSettled: async () => {
                // The accepted task joins the board the page shows.
                await Promise.all([
                    queryClient.invalidateQueries({ queryKey: listQuery.queryKey }),
                    queryClient.invalidateQueries({ queryKey: boardQuery.queryKey }),
                ]);
            },
        }),
    );
    const dismiss = useMutation(crpc.tasks.suggestions.dismissTaskSuggestion.mutationOptions(refresh));

    useEffect(() => {
        const ids: ReadonlyArray<string> = suggestions.map((suggestion) => suggestion._id);
        const before = knownIds.current;

        knownIds.current = ids;

        // A row leaves for one of two reasons: this view decided it (`focusAfter`), or the live list dropped it, for example
        // after a decision in another tab. In the second case only a row that held focus has anything to hand over.
        const pending = focusAfter.current ?? neighbourOfRemoved(heldRow.current, before, ids);

        if (!pending || ids.includes(pending.decided)) {
            return;
        }

        focusAfter.current = null;
        heldRow.current = null;

        // Focus moves only when the removed row still held it. A person who went on to another control meanwhile keeps theirs.
        if (!focusIsLost()) {
            return;
        }

        const next = pending.next ? items.current.get(pending.next) : null;

        (next ?? fallbackFocus?.current)?.focus();
    }, [suggestions, fallbackFocus]);

    // One decision at a time, until it has been answered. The buttons are `aria-disabled`, not `disabled`, so the one the
    // person used keeps focus.
    const busy = busyId !== null;

    const decide = async (id: string, run: () => Promise<unknown>, done: string, failed: string) => {
        if (busy) {
            return;
        }

        const index = suggestions.findIndex((suggestion) => suggestion._id === id);
        const neighbour = suggestions[index + 1] ?? suggestions[index - 1];

        setBusyId(id);
        setOutcome(null);
        focusAfter.current = { decided: id, next: neighbour ? neighbour._id : null };

        const worked = await attempt(run);

        if (worked) {
            setDecidedIds((current) => [...current, id]);
        } else {
            focusAfter.current = null;
        }

        setBusyId(null);

        setOutcome({ kind: worked ? "done" : "failed", text: worked ? done : failed });
    };

    // With nothing to show, the section takes no space of its own (`contents`) but stays mounted for its status region.
    const showsContent = suggestions.length > 0 || loadFailed || outcome?.kind === "failed";

    return (
        <section aria-labelledby={suggestions.length > 0 ? headingId : undefined} className={showsContent ? "space-y-3" : "contents"}>
            {suggestions.length > 0 && (
                <div className="space-y-1">
                    <h2 className="text-sm font-medium" id={headingId}>
                        {t`Suggested tasks`}
                    </h2>
                    <p className="text-muted-foreground text-xs">{t`Ideas from your own recent messages. Nothing is created until you accept one.`}</p>
                </div>
            )}
            {/* The status and the alert stay mounted while a decision is announced, even when it removes the last row. */}
            <p aria-label={t`Suggestion updates`} className="sr-only" role="status">
                {outcome?.kind === "done" ? outcome.text : ""}
            </p>
            {outcome?.kind === "failed" && (
                <p className="text-destructive text-xs" role="alert">
                    {outcome.text}
                </p>
            )}
            {loadFailed && (
                <div className="flex flex-wrap items-center gap-3" role="alert">
                    <p className="text-destructive text-xs">{t`Failed to load the suggested tasks`}</p>
                    <Button
                        onClick={() => {
                            void refetch();
                        }}
                        size="sm"
                        variant="outline"
                    >
                        {t`Retry`}
                    </Button>
                </div>
            )}
            {suggestions.length > 0 && (
                <ul className="space-y-2">
                    {suggestions.map((suggestion) => {
                        const { _id: id, cronExpression, instructions, title } = suggestion;
                        const expanded = expandedIds.includes(id);
                        // Only text with a toggle is clamped, so no clamped text is left without a way to read it all.
                        const clampable = instructions.length > CLAMP_THRESHOLD;
                        const instructionsId = `${headingId}-instructions-${id}`;

                        return (
                            <li
                                className="bg-card flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3 outline-offset-2"
                                key={id}
                                onBlur={(event) => {
                                    // Focus left this row when it went to another element, or to the page by a click. A row that was removed
                                    // while holding it, or a window that lost focus, still counts as holding it.
                                    const target = event.relatedTarget;
                                    const left =
                                        target instanceof Node
                                            ? !event.currentTarget.contains(target)
                                            : event.currentTarget.isConnected && !event.currentTarget.contains(document.activeElement);

                                    if (left && heldRow.current === id) {
                                        heldRow.current = null;
                                    }
                                }}
                                onFocus={() => {
                                    heldRow.current = id;
                                }}
                                ref={(element) => {
                                    if (element) {
                                        items.current.set(id, element);
                                    } else {
                                        items.current.delete(id);
                                    }
                                }}
                                tabIndex={-1}
                            >
                                <div className="min-w-0 flex-1 space-y-1">
                                    <p className="flex items-center gap-2 text-sm font-medium">
                                        <CalendarClockIcon aria-hidden="true" className="text-muted-foreground h-4 w-4 shrink-0" />
                                        <span className="truncate">{title}</span>
                                    </p>
                                    <p
                                        className={
                                            clampable && !expanded
                                                ? "text-muted-foreground line-clamp-2 text-xs"
                                                : "text-muted-foreground text-xs break-words whitespace-pre-wrap"
                                        }
                                        id={instructionsId}
                                    >
                                        {instructions}
                                    </p>
                                    {clampable && (
                                        <Button
                                            aria-controls={instructionsId}
                                            aria-expanded={expanded}
                                            aria-label={expanded ? t`Show less of the instructions for "${title}"` : t`Show all instructions for "${title}"`}
                                            className="h-auto px-0 py-0.5"
                                            onClick={() => {
                                                setExpandedIds((current) =>
                                                    current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
                                                );
                                            }}
                                            size="sm"
                                            variant="link"
                                        >
                                            {expanded ? t`Show less` : t`Show all`}
                                        </Button>
                                    )}
                                    <p className="text-muted-foreground text-xs">{scheduleLabel(cronExpression)}</p>
                                </div>
                                <div className="flex shrink-0 gap-2">
                                    <Button
                                        aria-disabled={busy}
                                        aria-label={t`Dismiss "${title}"`}
                                        className="aria-disabled:opacity-50"
                                        onClick={() =>
                                            decide(
                                                id,
                                                () => dismiss.mutateAsync({ suggestionId: id }),
                                                t`Suggestion dismissed: ${title}`,
                                                t`Failed to dismiss the suggestion`,
                                            )
                                        }
                                        size="sm"
                                        variant="outline"
                                    >
                                        {t`Dismiss`}
                                    </Button>
                                    <Button
                                        aria-disabled={busy}
                                        aria-label={t`Accept "${title}"`}
                                        className="aria-disabled:opacity-50"
                                        onClick={() =>
                                            decide(id, () => accept.mutateAsync({ suggestionId: id }), t`Task created: ${title}`, t`Failed to create the task`)
                                        }
                                        size="sm"
                                    >
                                        {t`Accept`}
                                    </Button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
};

/**
 * The list, mounted once per account (`key` follows the last known user id). An account switch from the sidebar keeps
 * the tasks page mounted, so what one account's decision left behind (the announced title, the busy row, the queued
 * focus, the decided and expanded rows) is dropped with the list instead of showing on the next account's page.
 * The key moves only when a different, non-empty id arrives: a failed switch clears the session query cache, so the
 * session is briefly unavailable for the same account, and a pending decision must survive that.
 */
const TaskSuggestions: FC<TaskSuggestionsProps> = ({ fallbackFocus }) => {
    const { data: session } = useAuthSession();
    const userId = session?.user.id;
    const [known, setKnown] = useState<{ epoch: number; userId: string | null }>({ epoch: 0, userId: null });

    // Adjusted while rendering, so the list never paints once under the old account. The first id to arrive is not a switch.
    if (userId && userId !== known.userId) {
        setKnown({ epoch: known.userId === null ? known.epoch : known.epoch + 1, userId });
    }

    return <TaskSuggestionsList fallbackFocus={fallbackFocus} key={known.epoch} />;
};

export default TaskSuggestions;
