/**
 * Reads what an agent reports about itself outside its turns (`session/update` kinds that are not a turn's own
 * output). Pure: each reader returns `undefined` for anything malformed, so a bad update is dropped, never sent.
 * Every text value is scrubbed by the caller's `scrub` (the agent's environment values are removed there).
 */
import type { AgentUsage } from "./host-events";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The currency code is cut to what the backend takes; a cost without a usable amount and currency is dropped. */
const MAX_CURRENCY_CHARS = 8;

const costOf = (value: unknown, scrub: (text: string) => string): AgentUsage["cost"] | undefined => {
    if (!isRecord(value) || typeof value.amount !== "number" || !Number.isFinite(value.amount) || value.amount < 0) {
        return undefined;
    }

    if (typeof value.currency !== "string" || value.currency === "") {
        return undefined;
    }

    return { amount: value.amount, currency: scrub(value.currency).slice(0, MAX_CURRENCY_CHARS) };
};

/** `usage_update`: `used` and `size` are token counts; `cost` is the session's cumulative cost, when the agent sends one. */
export const usageOf = (update: Record<string, unknown>, scrub: (text: string) => string): AgentUsage | undefined => {
    if (!isCount(update.used) || !isCount(update.size)) {
        return undefined;
    }

    const cost = costOf(update.cost, scrub);

    return { ...cost !== undefined && { cost }, size: update.size, used: update.used };
};
