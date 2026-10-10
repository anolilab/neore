/**
 * The usage backfill's pure half: which stored message rows form one reply,
 * whether a reply is the backfill's to count, and what it adds. I/O lives in
 * `backfill.ts`; this file is pinned by `backfill-logic.test.ts`.
 *
 * A reply is what one run saved, and the live path keys it on its first
 * non-user row (`replyUsageArgs`). The backfill has only the rows, in
 * `(order, stepOrder)` order, and cuts them where a run starts:
 *
 * - at a user row (the prompt) — it belongs to no reply;
 * - where `order` changes — a tool-approval continuation takes an `order` of its own;
 * - at a row with an explicit `parentMessageId` — a regenerated sibling (see
 *   `agent/branch-tree.ts`; a run's later rows never carry one);
 * - where the group-chat speaker changes — each speaker is a run of its own.
 */
import type { StepUsage } from "../agent/message-cost";
import type { RollupIncrement } from "./activity-logic";
import { DEFAULT_SKILL_KEY, summariseReply, usageDayOf } from "./activity-logic";

/** The fields of a stored `messages` row the backfill reads. */
export interface BackfillRow {
    _creationTime: number;
    _id: string;
    agentName?: string;
    message?: { role?: string } | null;
    order: number;
    parentMessageId?: string;
    providerMetadata?: unknown;
    speakerSkillId?: string;
    status: string;
    stepOrder: number;
    usage?: StepUsage;
    userId?: string;
}

const isUserRow = (row: BackfillRow): boolean => row.message?.role === "user";

export interface ReplyGroup {
    /** Who sent the prompt the reply answers, when the page holds it. */
    promptUserId?: string;
    rows: BackfillRow[];
}

/** Rows (sorted by `order`, then `stepOrder`) cut into replies; user rows are left out. */
export const groupReplies = (rows: ReadonlyArray<BackfillRow>): ReplyGroup[] => {
    const groups: ReplyGroup[] = [];
    let current: ReplyGroup | undefined;
    let prompt: BackfillRow | undefined;

    for (const row of rows) {
        if (isUserRow(row)) {
            current = undefined;
            prompt = row;
            continue;
        }

        const previous = current?.rows.at(-1);
        const startsRun =
            previous === undefined || previous.order !== row.order || row.parentMessageId !== undefined || previous.speakerSkillId !== row.speakerSkillId;

        if (startsRun) {
            const promptUserId = prompt?.order === row.order ? prompt.userId : undefined;

            current = { rows: [row], ...(promptUserId !== undefined && { promptUserId }) };
            groups.push(current);
        } else {
            current!.rows.push(row);
        }
    }

    return groups;
};

/**
 * The rows of a page read in `(order, stepOrder)` order that can be grouped
 * now, and the last `order` they cover. A full page may have cut its last
 * `order` short, so that `order` is left for the next read — unless it is the
 * only one on the page, which then goes whole (`full` = the caller read it with
 * no limit it could hit).
 */
export const completeOrders = (
    rows: ReadonlyArray<BackfillRow>,
    pageFull: boolean,
): { lastOrder: number | undefined; rows: ReadonlyArray<BackfillRow>; splitOrder: number | undefined } => {
    const last = rows.at(-1);

    if (last === undefined) {
        return { lastOrder: undefined, rows, splitOrder: undefined };
    }

    if (!pageFull) {
        return { lastOrder: last.order, rows, splitOrder: undefined };
    }

    const kept = rows.filter((row) => row.order !== last.order);

    // One `order` filled the page: the caller reads that order on its own.
    if (kept.length === 0) {
        return { lastOrder: undefined, rows: [], splitOrder: last.order };
    }

    return { lastOrder: kept.at(-1)!.order, rows: kept, splitOrder: undefined };
};

export interface BackfillWindow {
    /** Replies started from here on are the live path's. */
    cutoff: number;
    /** The oldest day the rollup keeps (`gdpr/retention.ts`); older replies would be pruned at once. */
    oldestDate: string;
    timeZone?: string;
    userId: string;
}

/**
 * What a reply adds, or undefined when the backfill leaves it alone: still
 * running (the live path records it when it ends), started after the backfill
 * did, someone else's turn in the user's thread (recorded on their own shard),
 * or older than the rollup keeps.
 */
export const backfillIncrement = ({ promptUserId, rows }: ReplyGroup, window: BackfillWindow): RollupIncrement | undefined => {
    const first = rows[0];

    if (first === undefined || rows.some((row) => row.status === "pending") || first._creationTime >= window.cutoff) {
        return undefined;
    }

    const author = promptUserId ?? first.userId;

    if (author !== undefined && author !== window.userId) {
        return undefined;
    }

    const date = usageDayOf(first._creationTime, window.timeZone);

    if (date < window.oldestDate) {
        return undefined;
    }

    const usage = summariseReply(rows);

    if (!usage) {
        return undefined;
    }

    return {
        costMicrodollars: usage.costMicrodollars,
        date,
        replies: 1,
        skillKey: first.speakerSkillId ?? DEFAULT_SKILL_KEY,
        tokens: usage.tokens,
        ...(first.speakerSkillId !== undefined && first.agentName !== undefined && { skillName: first.agentName }),
    };
};
