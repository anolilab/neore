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
