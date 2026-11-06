"use client";

/**
 * The options a coding agent offers for its session (its model, reasoning effort, mode ...), above the composer
 * (coding-workbench.md §14.4). What each one is now comes from the agent's own report; a choice is queued as a signed
 * `acp_set_config` and is made only when the agent accepts it. The control stays off while a change is on its way, and the
 * agent's answer, or the reason it was refused, is spoken in a status region. The legacy model state is shown only: there
 * is no stable call that sets it.
 */

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import type { FC } from "react";
import { useEffect, useId, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import useHostSendErrorMessages from "./host-send-errors";

/** How long the row waits for a confirmed value to show in the options before it stops waiting. */
const CATCH_UP_MS = 15_000;

/**
 * How long a change waits for its own answer. The call ends at its deadline (five minutes on the backend) and that ending is
 * recorded, so a result that never reaches this page was replaced by another client's. The wait ends a little after.
 */
const ANSWER_WAIT_MS = 5 * 60_000 + 15_000;

const SELECT_CLASS = "border-input bg-background h-9 max-w-full min-w-0 rounded-md border px-2 py-1 text-sm disabled:opacity-60";

interface Option {
    category?: string;
    choices: { name: string; value: string }[];
    currentValue: string;
    id: string;
    name: string;
}

interface Listed {
    available: { id: string; name: string }[];
    current: string;
}

export interface HostAgentState {
    configOptions?: Option[];
    models?: Listed;
    modes?: Listed;
}

interface OptionResult {
    callId: string;
    outcome: "confirmed" | "refused";
    reason?: string;
    valueId: string;
}

/** What one row shows: a name, the value it has, and the choices when it can be changed. */
interface Row {
    changeable: boolean;
    choices: { name: string; value: string }[];
    current: string;
    id: string;
    name: string;
    /** Absent for the legacy mode state, which is changed without an option id. */
    optionId?: string;
}

const MODE_ROW_ID = "legacy-mode";

/** The rows to show: the agent's options, or its legacy states when it sent no options. */
const rowsOf = (state: HostAgentState | undefined, labels: { mode: string; model: string }): Row[] => {
    if (state === undefined) {
        return [];
    }

    if (state.configOptions !== undefined && state.configOptions.length > 0) {
        return state.configOptions.map((option) => {
            return {
                // A mode is changed on the computer, where the person sees what it grants: its value shows, read-only. The computer
                // matches the category without regard to case, so this does too.
                changeable: option.choices.length > 0 && option.category?.toLowerCase() !== "mode",
                choices: option.choices,
                current: option.currentValue,
                // Tagged, so an option the agent names like a legacy row cannot be mistaken for it; the option id itself goes to the backend.
                id: `option:${option.id}`,
                name: option.name,
                optionId: option.id,
            };
        });
    }

    const rows: Row[] = [];

    if (state.models !== undefined) {
        rows.push({
            changeable: false,
            choices: state.models.available.map((entry) => {
                return { name: entry.name, value: entry.id };
            }),
            current: state.models.current,
            id: "legacy-model",
            name: labels.model,
        });
    }

    if (state.modes !== undefined) {
        rows.push({
            // Read-only for the same reason as a mode option: the computer changes it.
            changeable: false,
            choices: state.modes.available.map((entry) => {
                return { name: entry.name, value: entry.id };
            }),
            current: state.modes.current,
            id: MODE_ROW_ID,
            name: labels.mode,
        });
    }

    return rows;
};

const nameOfValue = (row: Row | undefined, value: string): string => row?.choices.find((choice) => choice.value === value)?.name ?? value;

const HostOptions: FC<{ ended: boolean; optionResult?: OptionResult; state?: HostAgentState; threadId: string }> = ({
    ended,
    optionResult,
    state,
    threadId,
}) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const messages = useHostSendErrorMessages();
    const groupId = useId();
    // The change this view made last: its answer is shown, and the controls stay off until the agent has given it.
    // Names are kept with the change: the option may be gone from the agent's list by the time its answer comes.
    const [change, setChange] = useState<{ callId?: string; name: string; rowId: string; valueId: string; valueName: string } | undefined>(undefined);
    const [failure, setFailure] = useState<string | undefined>(undefined);
    // Offline, the default network mode would pause the call before the Lunora client sees it, and the client is what queues a write.
    const set = useMutation({ ...crpc.acp.remote.setHostOption.mutationOptions(), networkMode: "always" });
    // The call whose confirmed value never showed in the options, so the wait for it ended.
    const [gaveUp, setGaveUp] = useState<string | undefined>(undefined);
    const rows = rowsOf(state, { mode: t`Mode`, model: t`Model` });
    // The answer to this page's change, kept once it has been seen: the session keeps only its latest result, which another client's
    // change can replace. Without this, the page would wait for the answer again.
    const [ownAnswer, setOwnAnswer] = useState<OptionResult | undefined>(undefined);
    const changeCallId = change?.callId;

    useEffect(() => {
        if (changeCallId !== undefined && optionResult !== undefined && optionResult.callId === changeCallId) {
            setOwnAnswer(optionResult);
        }
    }, [changeCallId, optionResult]);

    const answered = changeCallId === undefined ? undefined : [optionResult, ownAnswer].find((result) => result?.callId === changeCallId);
    const changed = change === undefined ? undefined : rows.find((row) => row.id === change.rowId);
    // The names the change was made with, for the messages that can outlive its row: the agent may have removed the option since.
    const changeName = changed?.name ?? change?.name ?? "";
    const changeValueName = changed === undefined ? (change?.valueName ?? "") : nameOfValue(changed, change?.valueId ?? "");
    // The agent's answer reaches the page before the options it changed (the state is posted a moment later): the controls stay
    // off until the option shows the new value, so the row never says "confirmed" over the old one. A bounded wait.
    // A confirmed change waits, once, for its value to show; a call whose value has shown is settled for good, so a later change by the
    // agent itself does not re-enter the wait.
    const [settled, setSettled] = useState<string | undefined>(undefined);
    const catchingUp =
        answered?.outcome === "confirmed" &&
        changed !== undefined &&
        changed.current !== answered.valueId &&
        gaveUp !== answered.callId &&
        settled !== answered.callId;
    const catchingUpCall = catchingUp ? answered?.callId : undefined;

    const shownValue = changed?.current;

    useEffect(() => {
        if (answered?.outcome === "confirmed" && shownValue === answered.valueId) {
            setSettled(answered.callId);
        }
    }, [answered, shownValue]);

    useEffect(() => {
        if (catchingUpCall === undefined) {
            return undefined;
        }

        const timer = setTimeout(setGaveUp, CATCH_UP_MS, catchingUpCall);

        return () => clearTimeout(timer);
    }, [catchingUpCall]);

    // A change still waiting for its answer. Another client's completed change can replace the session's one result before this
    // page sees its own, so the wait is bounded: past it the row says the outcome is unknown and the controls come back.
    const awaitingAnswer = change !== undefined && answered === undefined && failure === undefined ? change : undefined;
    const [unknownChange, setUnknownChange] = useState<typeof change>(undefined);

    useEffect(() => {
        if (awaitingAnswer === undefined) {
            return undefined;
        }

        const timer = setTimeout(setUnknownChange, ANSWER_WAIT_MS, awaitingAnswer);

        return () => clearTimeout(timer);
    }, [awaitingAnswer]);

    const unknownOutcome = awaitingAnswer !== undefined && unknownChange === awaitingAnswer;

    const waiting = (awaitingAnswer !== undefined && !unknownOutcome) || catchingUp;

    const failureText = (reason: "busy" | "ended" | "offline" | "outdated" | "unpaired" | undefined): string => {
        if (reason === "ended") {
            return t`This session has ended.`;
        }

        if (reason === "unpaired") {
            return t`This computer is no longer paired.`;
        }

        return messages[reason ?? "busy"];
    };

    // The backend sends one of a fixed set of English phrases (`acp/lib/calls.ts`). Each is shown in the person's language.
    const refusalTexts = new Map<string, string>([
        ["a mode is changed on the computer, not from here", t`a mode is changed on the computer, not from here`],
        ["that session no longer exists", t`that session no longer exists`],
        ["the agent did not accept the change", t`the agent did not accept the change`],
        ["the agent did not answer", t`the agent did not answer`],
        ["the agent did not apply the change", t`the agent did not apply the change`],
        ["the agent does not offer that choice", t`the agent does not offer that choice`],
        ["the app restarted before the agent answered", t`the app restarted before the agent answered`],
        ["the device was removed", t`the device was removed`],
        ["The host did not answer.", t`the host did not answer`],
        ["The host did not change the option.", t`the host did not change the option`],
        ["this session is not open", t`this session is not open`],
    ]);
    const refusalText = (reason: string | undefined): string => refusalTexts.get(reason ?? "") ?? t`the change was refused`;

    const choose = (row: Row, valueId: string) => {
        if (valueId === row.current || waiting) {
            return;
        }

        setFailure(undefined);
        setChange({ name: row.name, rowId: row.id, valueId, valueName: nameOfValue(row, valueId) });
        set.mutate(
            { threadId: threadId as Id<"threads">, valueId, ...(row.optionId !== undefined && { optionId: row.optionId }) },
            {
                onError: () => {
                    setFailure(t`Could not send the change.`);
                },
                onSuccess: (result) => {
                    if (result.sent) {
                        setChange({ callId: result.callId, name: row.name, rowId: row.id, valueId, valueName: nameOfValue(row, valueId) });

                        return;
                    }

                    setFailure(failureText(result.reason));
                },
            },
        );
    };

    let status: string | undefined;
    let refused = false;

    if (failure !== undefined) {
        status = failure;
        refused = true;
    } else if (catchingUp) {
        status = t`The agent confirmed. Waiting for ${changed?.name ?? ""} to show ${nameOfValue(changed, answered?.valueId ?? "")}.`;
    } else if (
        answered !== undefined &&
        changed !== undefined &&
        answered.outcome === "refused" &&
        // A call the backend expired reads "The host did not answer."; the agent may still have applied the change after that.
        // A call the backend expired reads "The host did not answer."; the agent may still have applied the change after that.
        (answered.reason === "the agent did not answer" || answered.reason === "The host did not answer.") &&
        changed.current === answered.valueId
    ) {
        // The agent answered after the wait for it ended, and the option now shows the value it confirmed.
        status = t`The agent answered late: ${changed.name} is now ${nameOfValue(changed, answered.valueId)}.`;
    } else if (
        answered !== undefined &&
        changed !== undefined &&
        answered.outcome === "confirmed" &&
        changed.current !== answered.valueId &&
        gaveUp === answered.callId
    ) {
        // The agent confirmed the change, but the option has not shown it in the time the page waited: say so, not that it changed.
        status = t`The agent confirmed ${nameOfValue(changed, answered.valueId)}, but ${changed.name} still shows ${nameOfValue(changed, changed.current)}. Check the agent before changing it again.`;
    } else if (answered?.outcome === "confirmed" && changed === undefined && change !== undefined) {
        // The option the change named is no longer offered: the confirmation still says what was changed, and that it is gone.
        status = t`The agent confirmed: ${change.name} is now ${change.valueName}, but no longer lists ${change.name}.`;
    } else if (answered !== undefined && (answered.outcome === "refused" || changed?.current === answered.valueId)) {
        refused = answered.outcome === "refused";
        status = refused
            ? t`The agent did not change ${changeName}: ${refusalText(answered.reason)}`
            : t`The agent confirmed: ${changed?.name ?? ""} is now ${nameOfValue(changed, answered.valueId)}.`;
    } else if (unknownOutcome) {
        status = t`No answer came for the change to ${changeName}. Check the agent before changing it again.`;
    } else if (waiting) {
        status = t`Waiting for the agent to change ${changeName} to ${changeValueName}.`;
    }

    // Without an option left, a pending change or its answer is still shown; nothing is shown when neither is left.
    if (rows.length === 0 && status === undefined) {
        return null;
    }

    return (
        <div className="flex flex-col gap-1">
            <ul aria-label={t`Agent options`} className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                {rows.map((row) => {
                    const controlId = `${groupId}-${row.id}`;

                    return (
                        <li className="flex items-center gap-2" key={row.id}>
                            {row.changeable ? (
                                <label className="text-muted-foreground" htmlFor={controlId}>
                                    {row.name}
                                </label>
                            ) : (
                                <span className="text-muted-foreground">{row.name}</span>
                            )}
                            {row.changeable ? (
                                <select
                                    aria-describedby={`${groupId}-status`}
                                    className={SELECT_CLASS}
                                    disabled={ended || waiting}
                                    id={controlId}
                                    onChange={(event) => choose(row, event.target.value)}
                                    value={row.current}
                                >
                                    {row.choices.some((choice) => choice.value === row.current) ? null : <option value={row.current}>{row.current}</option>}
                                    {row.choices.map((choice) => (
                                        <option key={choice.value} value={choice.value}>
                                            {choice.name}
                                        </option>
                                    ))}
                                </select>
                            ) : (
                                <span className="font-medium">{nameOfValue(row, row.current)}</span>
                            )}
                        </li>
                    );
                })}
            </ul>
            <p aria-live="polite" className="text-muted-foreground flex min-h-4 items-center gap-1 text-xs" id={`${groupId}-status`} role="status">
                {status !== undefined && (
                    <>
                        {waiting && <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />}
                        {!waiting && refused && <AlertTriangle aria-hidden="true" className="size-3" />}
                        {!waiting && !refused && <Check aria-hidden="true" className="size-3" />}
                        <span>{status}</span>
                    </>
                )}
            </p>
        </div>
    );
};

export default HostOptions;
