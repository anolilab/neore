import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx as QueryContext } from "../_generated/server";
import type { BranchTree } from "./branch-tree";
import { BRANCH_ROOT, buildBranchTree, compareBranchRows, resolveActivePath } from "./branch-tree";

/**
 * In-thread branching over the DB: the tree of `branch-tree.ts`, read
 * incrementally. Plain read helpers — the procedures are in `branches.ts`.
 *
 * Everything walks through two indexes — the storage order (implicit parents,
 * one batched range read per straight run) and `by_threadId_parentMessageId`
 * (explicit children) — so its cost scales with what it returns, not with the
 * thread. `loadBranchTree` reads every row instead, and is only for a fork and
 * for a stored leaf that no longer exists.
 */

type Row = Doc<"messages">;
type Reader = Pick<QueryContext, "db">;

const MAX_BATCH = 100;

/*
 * The walk reads through the ORM facade, not the legacy `query().withIndex()`
 * builder. Under row-level security the legacy builder used to drop the SQL
 * LIMIT, so each `.first()` below read the rest of the thread (fixed in
 * `@lunora/server@alpha.145`, anolilab/lunora#822).
 * The orderings are the `by_threadId_order_stepOrder` walk spelled out
 * (`chat/read-cost.test.ts` covers the same trap for the thread list).
 */
const STORAGE_ORDER_DESC = [{ order: "desc" }, { stepOrder: "desc" }, { _creationTime: "desc" }] as const;
const STORAGE_ORDER_ASC = [{ order: "asc" }, { stepOrder: "asc" }, { _creationTime: "asc" }] as const;

export const loadBranchTree = async (context: Reader, threadId: Id<"threads">): Promise<{ rows: Row[]; tree: BranchTree }> => {
    const rows = await context.db
        .query("messages")
        .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId))
        .collect();

    return { rows, tree: buildBranchTree(rows) };
};

const isBefore = (a: Row, b: Row): boolean => compareBranchRows(a, b) < 0;

/** Up to `limit` rows strictly before `row` in storage order, newest first. */
const rowsBefore = async (context: Reader, threadId: Id<"threads">, row: Row, limit: number): Promise<Row[]> => {
    const { page: sameOrder } = await context.db.messages.findMany({
        limit,
        orderBy: [...STORAGE_ORDER_DESC],
        where: { order: row.order, stepOrder: { lt: row.stepOrder }, threadId },
    });

    if (sameOrder.length >= limit) {
        return sameOrder as Row[];
    }

    const { page: earlier } = await context.db.messages.findMany({
        limit: limit - sameOrder.length,
        orderBy: [...STORAGE_ORDER_DESC],
        where: { order: { lt: row.order }, threadId },
    });

    return [...sameOrder, ...earlier] as Row[];
};

/** The row right after `row` in storage order; the thread's first row for `null`. */
const rowAfter = async (context: Reader, threadId: Id<"threads">, row: Row | null): Promise<Row | null> => {
    if (!row) {
        return (await context.db.messages.findFirst({ orderBy: [...STORAGE_ORDER_ASC], where: { threadId } })) as Row | null;
    }

    const sameOrder = await context.db.messages.findFirst({
        orderBy: [...STORAGE_ORDER_ASC],
        where: { order: row.order, stepOrder: { gt: row.stepOrder }, threadId },
    });

    return (sameOrder ??
        (await context.db.messages.findFirst({ orderBy: [...STORAGE_ORDER_ASC], where: { order: { gt: row.order }, threadId } }))) as Row | null;
};

/** `id` as a row of this thread, or `null` — also for an id of another table. */
export const getThreadRow = async (context: Reader, threadId: Id<"threads">, id: string): Promise<Row | null> => {
    try {
        // Read off `messages` alone: an un-hinted `db.get` probes every table.
        return ((await context.db.messages.findFirst({ where: { _id: id as Id<"messages">, threadId } })) as Row | null) ?? null;
    } catch {
        // Not an id of this table at all.
        return null;
    }
};

/**
 * `row`'s explicit parent: a row, `null` for `BRANCH_ROOT`, or `undefined` when
 * the parent is implicit — including a dangling or forward id, which
 * `buildBranchTree` ignores the same way.
 */
const explicitParentOf = async (context: Reader, threadId: Id<"threads">, row: Row): Promise<Row | null | undefined> => {
    const id = row.parentMessageId;

    if (!id) {
        return undefined;
    }

    if (id === BRANCH_ROOT) {
        return null;
    }

    const parent = await getThreadRow(context, threadId, id);

    return parent && isBefore(parent, row) ? parent : undefined;
};

/** `row`'s parent row, `null` at the top level. */
export const parentOf = async (context: Reader, threadId: Id<"threads">, row: Row): Promise<Row | null> => {
    const explicit = await explicitParentOf(context, threadId, row);

    if (explicit !== undefined) {
        return explicit;
    }

    const [previous] = await rowsBefore(context, threadId, row, 1);

    return previous ?? null;
};

/** Children of `parent` (top level for `null`) in storage order, latest last. */
export const childrenOf = async (context: Reader, threadId: Id<"threads">, parent: Row | null): Promise<Row[]> => {
    // `by_threadId_parentMessageId`, unbounded as before: every sibling counts.
    const { page: explicit } = (await context.db.messages.findMany({
        orderBy: [{ _creationTime: "asc" }],
        where: { parentMessageId: parent?._id ?? BRANCH_ROOT, threadId },
    })) as { page: Row[] };
    const children = parent ? explicit.filter((row) => isBefore(parent, row)) : explicit;
    const next = await rowAfter(context, threadId, parent);

    if (next && children.every((row) => row._id !== next._id) && (await explicitParentOf(context, threadId, next)) === undefined) {
        children.push(next);
    }

    return children.toSorted(compareBranchRows);
};

/** Follows the latest child down from `row` to a leaf. */
export const descendFrom = async (context: Reader, threadId: Id<"threads">, row: Row): Promise<Row> => {
    let current = row;

    for (;;) {
        const children = await childrenOf(context, threadId, current);
        const latest = children.at(-1);

        if (!latest) {
            return current;
        }

        current = latest;
    }
};

/**
 * The displayed leaf: the stored one, descended by latest child. The stored
 * leaf advances as replies land on it (`addMessagesHandler`), so the descent
 * is normally zero steps. A deleted leaf falls back to the whole tree.
 */
export const resolveLeafRow = async (context: Reader, threadId: Id<"threads">, storedLeafId: string): Promise<Row | null> => {
    const stored = await getThreadRow(context, threadId, storedLeafId);

    if (stored) {
        return await descendFrom(context, threadId, stored);
    }

    const { tree } = await loadBranchTree(context, threadId);
    const leafId = resolveActivePath(tree, storedLeafId).at(-1);

    return leafId ? await getThreadRow(context, threadId, leafId) : null;
};

/**
 * Walks up from `from` (inclusive), newest first, for at most `limit` rows,
 * stopping before `stopAtId`. `next` is where a further walk would resume —
 * the parent of the last row returned — or `null` past the top.
 */
export const walkPath = async (
    context: Reader,
    threadId: Id<"threads">,
    from: Row,
    options: { limit: number; stopAtId?: string },
): Promise<{ next: Row | null; rows: Row[] }> => {
    const rows: Row[] = [];
    // Rows before `current` in storage order, newest first: its implicit
    // ancestors, as long as no explicit parent jumps elsewhere.
    let before: Row[] = [];
    let current: Row | null = from;

    while (current && rows.length < options.limit && current._id !== options.stopAtId) {
        rows.push(current);

        const explicit = await explicitParentOf(context, threadId, current);

        if (explicit !== undefined) {
            current = explicit;
            before = [];
            continue;
        }

        if (before.length === 0) {
            before = await rowsBefore(context, threadId, current, Math.min(Math.max(options.limit - rows.length, 1), MAX_BATCH));
        }

        current = before.shift() ?? null;
    }

    return { next: current, rows };
};

/** The last `limit` rows of the thread's active path, newest first. */
export const loadActivePathTail = async (context: Reader, threadId: Id<"threads">, storedLeafId: string, limit: number): Promise<Row[]> => {
    const leaf = await resolveLeafRow(context, threadId, storedLeafId);

    if (!leaf) {
        return [];
    }

    const { rows } = await walkPath(context, threadId, leaf, { limit });

    return rows;
};

/**
 * The ids an agent may read as history when generating for `prompt`, top first.
 *
 * Always the prompt's ancestors. A USER prompt stops there: anything already
 * hanging off it is a sibling reply the user asked to replace. Any other
 * prompt (a tool result resumed after approval) also keeps the reply it is
 * continuing — the latest chain below it.
 */
export const contextPathIds = async (context: Reader, threadId: Id<"threads">, prompt: Row): Promise<string[]> => {
    const { rows: ancestors } = await walkPath(context, threadId, prompt, { limit: Infinity });
    const ids = ancestors.toReversed().map((row) => row._id as string);

    if ((prompt.message as { role?: string } | undefined)?.role === "user") {
        return ids;
    }

    const leaf = await descendFrom(context, threadId, prompt);
    const { rows: continuation } = await walkPath(context, threadId, leaf, { limit: Infinity, stopAtId: prompt._id });

    return [...ids, ...continuation.toReversed().map((row) => row._id as string)];
};

/** The whole displayed path, top first: every row for a thread that never branched. */
export const loadActivePath = async (context: Reader, threadId: Id<"threads">, storedLeafId: string | null | undefined): Promise<Row[]> => {
    if (storedLeafId) {
        const tail = await loadActivePathTail(context, threadId, storedLeafId, Infinity);

        return tail.toReversed();
    }

    return await context.db
        .query("messages")
        .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId))
        .collect();
};
