/**
 * What a handoff is built from: the thread's active path read upward from the leaf, a page at a time, as
 * turns. Bounded on purpose — a switch on a 5,000-row thread reads what the tail and the summary can use, not
 * the thread (plans/harness-switch.md, S2).
 */
import { CHARACTERS_PER_TOKEN, estimateTokensFromCharacters } from "@neore/ai/models";
import type { ModelMessage } from "ai";

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { agentKeyOf, agentSwitchOf } from "./agent-switch-logic";
import type { AgentSwitchPart } from "./agent-switch-validators";
import { walkPath } from "./branch-rows";
import { HANDOFF_BUDGET_TOKENS, HANDOFF_SUMMARY_INPUT_TOKENS, type HandoffTurn } from "./handoff";
import { extractText } from "./shared";

type Row = Doc<"messages">;
type Reader = Pick<QueryCtx, "db">;

/** Rows read per step of a path walk. */
const PAGE_ROWS = 100;

/** Pages a search for an earlier divider reads before giving up: 3,000 rows. */
const MAX_SEARCH_PAGES = 30;

/**
 * A turn is kept this long at most. Nothing past the budget can be shown verbatim anyway, and the one extra
 * character keeps a turn that is too long for the handoff looking too long to `planHandoff`.
 */
const MAX_TURN_CHARACTERS = HANDOFF_BUDGET_TOKENS * CHARACTERS_PER_TOKEN + 1;

/** The user or assistant text of a row, or `null` for a divider, a tool row and a row with no text. */
export const turnOfRow = (row: Pick<Row, "message" | "providerMetadata">): HandoffTurn | null => {
    if (agentSwitchOf(row)) {
        return null;
    }

    const message = row.message as ModelMessage | undefined;

    if (message?.role !== "user" && message?.role !== "assistant") {
        return null;
    }

    const text = extractText(message)?.trim();

    return text ? { role: message.role, text: text.slice(0, MAX_TURN_CHARACTERS) } : null;
};

/** `turns` (newest first) with neighbours of one role joined: an assistant reply saved in steps reads as one turn. */
const joinSameRole = (turns: HandoffTurn[]): HandoffTurn[] => {
    const joined: HandoffTurn[] = [];

    for (const turn of turns) {
        const last = joined.at(-1);

        if (last?.role === turn.role) {
            joined[joined.length - 1] = { role: turn.role, text: `${turn.text}\n\n${last.text}`.slice(0, MAX_TURN_CHARACTERS) };
        } else {
            joined.push(turn);
        }
    }

    return joined;
};

export interface HandoffSource {
    /** Who wrote the rows the turns came from: a computer is never handed text someone else wrote. */
    authorIds: string[];
    /** Rows older than the ones read exist, so the summary does not cover the whole thread. */
    omittedEarlier: boolean;
    /** Newest first. */
    turns: HandoffTurn[];
}

/**
 * The turns from the path ending at `leaf` upward, newest first, until `stopAtId` (exclusive), the top of the
 * path, or as much as the tail and the summary's input can use.
 */
export const collectHandoffSource = async (
    context: Reader,
    threadId: Id<"threads">,
    leaf: Row,
    options: { stopAtId?: string } = {},
): Promise<HandoffSource> => {
    const limit = (HANDOFF_BUDGET_TOKENS + HANDOFF_SUMMARY_INPUT_TOKENS) * CHARACTERS_PER_TOKEN;
    const turns: HandoffTurn[] = [];
    const authorIds = new Set<string>();
    let characters = 0;
    let cursor: Row | null = leaf;
    let cutShort = false;

    while (cursor && cursor._id !== options.stopAtId && characters < limit) {
        const { next, rows } = await walkPath(context, threadId, cursor, { limit: PAGE_ROWS, stopAtId: options.stopAtId });

        for (const [index, row] of rows.entries()) {
            const turn = turnOfRow(row);

            if (turn) {
                turns.push(turn);
                characters += turn.text.length;

                if (typeof row.userId === "string") {
                    authorIds.add(row.userId);
                }
            }

            // The limit is checked per row, not per page, so one page of large messages cannot overshoot it.
            if (characters >= limit) {
                cutShort = index < rows.length - 1;
                break;
            }
        }

        cursor = next;
    }

    // The walk stops AT `stopAtId`, leaving it as `cursor`: not a row that was left unread.
    return {
        authorIds: [...authorIds],
        omittedEarlier: cutShort || (cursor !== null && cursor._id !== options.stopAtId),
        turns: joinSameRole(turns),
    };
};

/**
 * Estimated tokens of the stored text of the path ending at `from` (inclusive), counting up toward `cap` and
 * stopping the walk once past it. `stopAtId` ends the count at that row (exclusive). `maxPages` bounds the read:
 * a path longer than that many pages counts as past the cap whatever its rows say. `maxRows` counts only that many
 * rows from `from`: the window a reply actually reads.
 */
export const pathTokens = async (
    context: Reader,
    threadId: Id<"threads">,
    from: Row | null,
    options: { cap: number; maxPages?: number; maxRows?: number; stopAtId?: string },
): Promise<number> => {
    let characters = 0;
    let cursor = from;
    let pages = 0;
    let rowsLeft = options.maxRows ?? Infinity;

    while (cursor && cursor._id !== options.stopAtId) {
        pages += 1;

        if (options.maxPages !== undefined && pages > options.maxPages) {
            return options.cap + 1;
        }

        const { next, rows } = await walkPath(context, threadId, cursor, { limit: Math.min(PAGE_ROWS, rowsLeft), stopAtId: options.stopAtId });

        for (const row of rows) {
            characters += row.text?.length ?? 0;
        }

        rowsLeft -= rows.length;

        if (rowsLeft <= 0 || estimateTokensFromCharacters(characters) > options.cap) {
            break;
        }

        cursor = next;
    }

    return estimateTokensFromCharacters(characters);
};

/** Rows from `from` (inclusive) up to `stopAtId` (exclusive), counted up to `cap`. */
export const rowsSince = async (context: Reader, threadId: Id<"threads">, from: Row, stopAtId: string, cap: number): Promise<number> => {
    let count = 0;
    let cursor: Row | null = from;

    while (cursor && cursor._id !== stopAtId && count < cap) {
        const { next, rows } = await walkPath(context, threadId, cursor, { limit: PAGE_ROWS, stopAtId });

        count += rows.length;
        cursor = next;
    }

    return count;
};

/** A divider with the row that holds it. */
export interface DividerRow {
    part: AgentSwitchPart;
    row: Row;
}

/**
 * The newest divider on the path ending at `from` (inclusive) that satisfies `accept`, a page at a time.
 * Gives up after {@link MAX_SEARCH_PAGES} pages.
 */
const findDivider = async (
    context: Reader,
    threadId: Id<"threads">,
    from: Row | null,
    accept: (part: AgentSwitchPart) => boolean,
): Promise<DividerRow | undefined> => {
    let cursor = from;

    for (let page = 0; cursor && page < MAX_SEARCH_PAGES; page += 1) {
        const { next, rows } = await walkPath(context, threadId, cursor, { limit: PAGE_ROWS });

        for (const row of rows) {
            const part = agentSwitchOf(row);

            if (part && accept(part)) {
                return { part, row };
            }
        }

        cursor = next;
    }

    return undefined;
};

/** The newest divider on the path ending at `from` that moved on FROM `model`: the agent had seen the thread through its `startMessageId`. */
export const findDividerLeaving = async (context: Reader, threadId: Id<"threads">, from: Row | null, model: string): Promise<DividerRow | undefined> =>
    await findDivider(context, threadId, from, (part) => agentKeyOf(part.from) === model);

/** The newest divider on the path ending at `from` that moved on TO `model`: where the agent came into the thread. */
export const findDividerEntering = async (context: Reader, threadId: Id<"threads">, from: Row | null, model: string): Promise<DividerRow | undefined> =>
    await findDivider(context, threadId, from, (part) => agentKeyOf(part.to) === model);

/** The newest divider on the path ending at `from` that carries a handoff: what stands in for the thread up to it. */
export const findPathHandoff = async (context: Reader, threadId: Id<"threads">, from: Row | null): Promise<DividerRow | undefined> =>
    await findDivider(context, threadId, from, (part) => Boolean(part.handoff) && (part.mode === "portable" || part.mode === "delta"));
