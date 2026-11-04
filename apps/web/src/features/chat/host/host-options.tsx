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
import { useId, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import useHostSendErrorMessages from "./host-send-errors";

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
                changeable: option.choices.length > 0,
                choices: option.choices,
                current: option.currentValue,
                id: option.id,
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
            changeable: state.modes.available.length > 0,
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
    const [change, setChange] = useState<{ callId?: string; rowId: string; valueId: string } | undefined>(undefined);
    const [failure, setFailure] = useState<string | undefined>(undefined);
    const set = useMutation(crpc.acp.remote.setHostOption.mutationOptions());
    const rows = rowsOf(state, { mode: t`Mode`, model: t`Model` });

    if (rows.length === 0) {
        return null;
    }

    const answered = change?.callId !== undefined && optionResult?.callId === change.callId ? optionResult : undefined;
    const waiting = change !== undefined && answered === undefined && failure === undefined;
    const changed = change === undefined ? undefined : rows.find((row) => row.id === change.rowId);

    const failureText = (reason: "busy" | "ended" | "offline" | "outdated" | "unpaired" | undefined): string => {
        if (reason === "ended") {
            return t`This session has ended.`;
        }

        if (reason === "unpaired") {
            return t`This computer is no longer paired.`;
        }

        return messages[reason ?? "busy"];
    };

    const choose = (row: Row, valueId: string) => {
        if (valueId === row.current || waiting) {
            return;
        }

        setFailure(undefined);
        setChange({ rowId: row.id, valueId });
        set.mutate(
            { threadId: threadId as Id<"threads">, valueId, ...(row.optionId !== undefined && { optionId: row.optionId }) },
            {
                onError: () => {
                    setFailure(t`Could not send the change.`);
                },
                onSuccess: (result) => {
                    if (result.sent) {
                        setChange({ callId: result.callId, rowId: row.id, valueId });

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
    } else if (answered !== undefined) {
        refused = answered.outcome === "refused";
        status = refused
            ? t`The agent did not change ${changed?.name ?? ""}: ${answered.reason ?? ""}`
            : t`The agent confirmed: ${changed?.name ?? ""} is now ${nameOfValue(changed, answered.valueId)}.`;
    } else if (waiting) {
        status = t`Waiting for the agent to change ${changed?.name ?? ""} to ${nameOfValue(changed, change.valueId)}.`;
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
