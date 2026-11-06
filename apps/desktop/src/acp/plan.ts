/**
 * The agent's plan for a turn (ACP `plan` update), as the backend takes it: a whole list each time, which replaces the one
 * before. Pure, so the bounds are pinned without an agent. Every field is cut to the backend's limits here
 * (`backend/lunora/acp/validators.ts`), since one entry past them would refuse the whole post and end the turn's posting.
 */
import { isRecord } from "./child-updates";

export type PlanPriority = "high" | "low" | "medium";
export type PlanStatus = "completed" | "in_progress" | "pending";

export interface PlanEntry {
    content: string;
    priority: PlanPriority;
    status: PlanStatus;
}

/** The most entries one plan event carries, and the most characters of each entry's text. */
export const MAX_PLAN_ENTRIES = 50;
export const MAX_PLAN_ENTRY_CHARS = 500;

/** A lone high surrogate at the end: the first half of a character the cut split (as `tool-output.ts` checks). */
const HIGH_SURROGATE_AT_END = /[\uD800-\uDBFF]$/u;

const PRIORITIES = new Set<string>(["high", "low", "medium"]);
const STATUSES = new Set<string>(["completed", "in_progress", "pending"]);

/**
 * The entries of a `plan` update, scrubbed and cut, or undefined when the update carries no list. An entry with a priority
 * or status outside the protocol's, or with no text, is left out rather than sent: the backend would refuse it.
 */
export const planOf = (update: Record<string, unknown>, scrub: (text: string) => string): PlanEntry[] | undefined => {
    if (!Array.isArray(update.entries)) {
        return undefined;
    }

    const entries: PlanEntry[] = [];

    for (const entry of update.entries as unknown[]) {
        if (entries.length >= MAX_PLAN_ENTRIES) {
            break;
        }

        if (!isRecord(entry) || typeof entry.content !== "string" || !PRIORITIES.has(entry.priority as string) || !STATUSES.has(entry.status as string)) {
            continue;
        }

        // Masked before it is cut, so a value straddling the cut cannot leave its first half readable. The cut counts UTF-16 units,
        // so it can split a character outside the basic plane: its first half is dropped, as the output tail drops its own.
        const content = scrub(entry.content).slice(0, MAX_PLAN_ENTRY_CHARS).replace(HIGH_SURROGATE_AT_END, "");

        if (content.trim() === "") {
            continue;
        }

        entries.push({ content, priority: entry.priority as PlanPriority, status: entry.status as PlanStatus });
    }

    return entries;
};
