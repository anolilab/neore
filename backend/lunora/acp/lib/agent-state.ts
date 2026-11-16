/**
 * What the agent reported about itself (`session_state`), merged into the stored state and compared field by field.
 * A field present replaces the stored one; an absent field keeps it. The comparison reads values, never a serialised
 * form, so the order of keys in a post decides nothing.
 */
import type { Infer } from "lunorash/server";

import type { vAcpAgentState } from "../validators";

export type AgentState = Infer<typeof vAcpAgentState>;

type Named = { id: string; name: string };
type Listed = { available: Named[]; current: string };
type Option = NonNullable<AgentState["configOptions"]>[number];

const sameList = <Item>(first: ReadonlyArray<Item>, second: ReadonlyArray<Item>, same: (a: Item, b: Item) => boolean): boolean =>
    first.length === second.length && first.every((item, index) => same(item, second[index] as Item));

const sameNamed = (first: Named, second: Named): boolean => first.id === second.id && first.name === second.name;

const sameListed = (first: Listed | undefined, second: Listed | undefined): boolean =>
    first === undefined || second === undefined ? first === second : first.current === second.current && sameList(first.available, second.available, sameNamed);

const sameOption = (first: Option, second: Option): boolean =>
    first.id === second.id &&
    first.name === second.name &&
    first.category === second.category &&
    first.currentValue === second.currentValue &&
    sameList(first.choices, second.choices, (a, b) => a.value === b.value && a.name === b.name);

const sameOptions = (first: AgentState["configOptions"], second: AgentState["configOptions"]): boolean =>
    first === undefined || second === undefined ? first === second : sameList(first, second, sameOption);

/** Whether every option field the report carries is already stored as it is (usage is compared by the caller). */
export const sameOptionFields = (stored: AgentState | undefined, report: AgentState): boolean =>
    (report.configOptions === undefined || sameOptions(stored?.configOptions, report.configOptions)) &&
    (report.modes === undefined || sameListed(stored?.modes, report.modes)) &&
    (report.models === undefined || sameListed(stored?.models, report.models));

/** The stored state with a report applied: each field the report carries replaces the stored one, the others stay. */
export const mergeAgentState = (stored: AgentState | undefined, report: AgentState): AgentState => {
    return {
        ...stored,
        ...(report.configOptions !== undefined && { configOptions: report.configOptions }),
        ...(report.modes !== undefined && { modes: report.modes }),
        ...(report.models !== undefined && { models: report.models }),
        ...(report.usage !== undefined && { usage: report.usage }),
    };
};

/** A stored option result, as far as settling it needs. */
interface StoredOptionResult {
    at: number;
    callId: string;
    optionId?: string;
    outcome: "confirmed" | "refused";
    reason?: string;
    valueId: string;
}

/**
 * The refusals whose outcome is not known: the agent may still have applied the change (its answer came after the desktop
 * gave up on it, the window closed first, or the desktop restarted before the answer was recorded).
 */
export const UNSETTLED_OPTION_REASONS: ReadonlySet<string> = new Set([
    "the agent did not answer",
    "the app restarted before the agent answered, so the change may or may not have been made",
    "The host did not answer.",
]);

/** Whether a report settles a stored option result: the result is an unsettled refusal and the agent now reports its value. */
export const settledBy = (result: StoredOptionResult, report: AgentState): boolean =>
    result.outcome === "refused" &&
    result.reason !== undefined &&
    UNSETTLED_OPTION_REASONS.has(result.reason) &&
    (result.optionId === undefined
        ? report.modes?.current === result.valueId
        : report.configOptions?.some((option) => option.id === result.optionId && option.currentValue === result.valueId) === true);

/** The option result of a change the agent's report settled: confirmed, with no reason. */
export const confirmedOf = (result: StoredOptionResult): StoredOptionResult => {
    return {
        at: result.at,
        callId: result.callId,
        ...(result.optionId !== undefined && { optionId: result.optionId }),
        outcome: "confirmed",
        valueId: result.valueId,
    };
};

/** A repeat of the stored values moves the ordering watermark only once the stored one is this old. */
export const WATERMARK_STALE_MS = 60_000;
