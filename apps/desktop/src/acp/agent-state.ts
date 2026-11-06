/**
 * Reads what an agent reports about itself outside its turns (`session/update` kinds that are not a turn's own
 * output). Pure: each reader returns `undefined` for anything malformed, so a bad update is dropped, never sent.
 * Every text value is scrubbed by the caller's `scrub` (the agent's environment values are removed there).
 */
import { isRecord } from "./child-updates";
import type { AgentCommand, AgentUsage } from "./host-events";

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

// The bounds of `vAgentCommands` in backend/lunora/acp/validators.ts: keep them in step.
/** A whitespace character: a command name holding one is not a single token. */
const WHITESPACE = /\s/u;

const MAX_COMMANDS = 100;
const MAX_COMMAND_NAME_CHARS = 64;
const MAX_COMMAND_DESCRIPTION_CHARS = 300;
const MAX_COMMAND_HINT_CHARS = 200;
/** A raw text longer than this is not read: scrubbing a near-limit string on every update costs more than the entry is worth. */
const MAX_RAW_TEXT_CHARS = 4096;
/** Entries looked at per list, valid or not, so a long list of malformed entries cannot make a parse unbounded. */
const MAX_ENTRIES_INSPECTED = 1000;

const commandOf = (value: unknown, scrub: (text: string) => string): AgentCommand | undefined => {
    if (!isRecord(value) || typeof value.name !== "string") {
        return undefined;
    }

    // A name is an identifier the agent reads back, so it is kept whole or not at all: cut, or changed by the scrub, it would name a
    // command the agent never advertised. A name with a space or a line break would also insert more than the command.
    if (value.name.length > MAX_RAW_TEXT_CHARS) {
        return undefined;
    }

    const name = scrub(value.name);

    if (name === "" || name !== value.name || name.length > MAX_COMMAND_NAME_CHARS || WHITESPACE.test(name)) {
        return undefined;
    }

    // A description or hint too long to read is left out, not scrubbed, and the command itself stays in the menu.
    const hintField = isRecord(value.input) ? value.input.hint : undefined;
    const description = typeof value.description === "string" && value.description.length <= MAX_RAW_TEXT_CHARS ? scrub(value.description).slice(0, MAX_COMMAND_DESCRIPTION_CHARS) : "";
    const hint = typeof hintField === "string" && hintField.length <= MAX_RAW_TEXT_CHARS ? scrub(hintField).slice(0, MAX_COMMAND_HINT_CHARS) : "";

    return { description, ...hint !== "" && { hint }, name };
};

/**
 * `available_commands_update`: the agent's whole list of slash commands. Undefined when `availableCommands` is not an array;
 * an entry without a usable name is skipped, and the list is cut at 100.
 */
export const availableCommandsOf = (update: Record<string, unknown>, scrub: (text: string) => string): AgentCommand[] | undefined => {
    if (!Array.isArray(update.availableCommands)) {
        return undefined;
    }

    const commands: AgentCommand[] = [];

    for (const entry of update.availableCommands.slice(0, MAX_ENTRIES_INSPECTED)) {
        const command = commandOf(entry, scrub);

        if (command !== undefined) {
            commands.push(command);
        }

        if (commands.length === MAX_COMMANDS) {
            break;
        }
    }

    return commands;
};
