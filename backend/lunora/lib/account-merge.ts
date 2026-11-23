/**
 * A guest's data follows them into the account they convert to.
 *
 * better-auth converts an anonymous user by creating a NEW user and linking the
 * anonymous one afterwards (`anonymous({ onLinkAccount })`, `auth.ts`). Every
 * row lives on its owner's shard, so the
 * guest's threads, messages, files, memories… sit on the GUEST's shard, keyed
 * by the guest's id — where the new account never looks. This moves them:
 *
 * 1. every non-`.global()` table is read from the guest's shard a page at a
 *    time ({@link listShardRowsPage}) and inserted on the new user's shard
 *    under the SAME ids ({@link importShardRows}, so every reference between
 *    rows stays valid) with the guest's id rewritten to the new one;
 * 2. only once EVERYTHING is copied are the guest's rows deleted
 *    ({@link deleteShardRows}) — a relation's `onDelete` cascade could
 *    otherwise remove a row before it was copied;
 * 3. `.global()` rows naming the guest are re-pointed ({@link reassignGlobalRows}),
 *    and its thread follows a page per mutation ({@link reassignThreadFollowsPage});
 * 4. once the guest's shard is empty, the guest itself is deleted
 *    (`auth/hooks.ts#deleteMergedGuest`), as the anonymous plugin does when a
 *    conversion completes in the guest's own browser. A cross-browser
 *    conversion (`auth/guest-conversion.ts`) would otherwise leave it alive.
 *
 * The new account's own seeded `userSettings`/`aiUserPreferences` win over the
 * guest's. Re-running after a partial failure is safe: an id already on the new
 * shard is skipped, and rows already moved are gone from the old one.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { mergeSkippedSteps } from "../auth/lib/setup-step-limits";
import { authLogger } from "./logger";
import { callOnShard } from "./cross-shard";
import schema from "../schema";
import { dropPushDevicesOf } from "../notifications/push-device-writes";
import { mergeThreadFollowsPage } from "../chat/follows/follow-writes";

/** Rows moved per round trip. */
export const MERGE_PAGE_SIZE = 100;

/** The guest's own copy of these is dropped: the new account already has its seeded row. */
const KEEP_NEW_USERS = new Set(["aiUserPreferences", "userSettings"]);

/** Ephemeral bookkeeping that is not the guest's content. */
const NOT_MOVED = new Set(["cronRuns", "idempotencyClaims", "rateLimits"]);

/** The tables whose rows live on a user's shard — everything but `.global()`. */
export const shardLocalTables = (source: unknown = schema): string[] =>
    Object.entries((source as { tables: Record<string, { shardMode?: { kind?: string } }> }).tables)
        .filter(([name, table]) => table.shardMode?.kind !== "global" && !NOT_MOVED.has(name))
        .map(([name]) => name)
        .toSorted((a, b) => a.localeCompare(b));

/**
 * `.global()` columns that name a user, by table. `shardActivity` is not here:
 * the guest's census row is deleted, the new user has their own. Every
 * `.global()` table with a `userId` column is either here or in
 * {@link GLOBAL_USER_TABLES_NOT_REASSIGNED} (`account-merge.test.ts` pins it).
 */
export const GLOBAL_USER_COLUMNS: Readonly<Record<string, ReadonlyArray<string>>> = {
    botOwners: ["ownerId"],
    chatFileAccess: ["userId"],
    feedback: ["userId"],
    // Without this a guest's collection stays the guest's: the files that moved
    // point at it, and `requireOwnCollectionId` refuses the new owner.
    knowledgeCollections: ["userId"],
    pageAccess: ["userId", "ownerId", "grantedBy"],
    pageInvites: ["userId", "ownerId", "acceptedBy"],
    passkey: ["userId"],
    projectRepositories: ["userId"],
    projectRuleFiles: ["userId"],
    projects: ["userId"],
    promptHistory: ["userId", "contentBy"],
    prompts: ["userId", "contentBy"],
    shardRoutes: ["ownerId"],
    // A guest's pins on a shared thread stay findable by the guest's new account, and the owner-side route follows an owner who moved.
    sharedPinRoutes: ["userId", "ownerId"],
    skillRatings: ["userId"],
    skills: ["userId"],
    threadAccess: ["userId", "ownerId", "grantedBy"],
    threadInvites: ["ownerId", "invitedBy", "acceptedBy"],
    userVariableDefaults: ["userId"],
};

/** `.global()` tables with a `userId` the generic re-pointing loop deliberately leaves alone, and why. */
export const GLOBAL_USER_TABLES_NOT_REASSIGNED: Readonly<Record<string, string>> = {
    account: "better-auth links the anonymous user itself",
    accountMoves:
        "the move marker of the account being merged or erased: it refuses pin writes from that account and names no content, and that account ends with the move, so nothing re-points it",
    deviceCode: "a guest cannot approve a code, and a pending one lapses in 30 minutes",
    documentHistory: "an audit trail records who acted; it is not re-attributed",
    member: "a guest joins no organization",
    memberCredits: "a guest joins no organization",
    pinWriteLeases:
        "the in-flight pin-write lease of the account being merged or erased: it names no content, and the move removes it when it ends, so nothing re-points it",
    pushDevices:
        "tied to the guest's session, which ends with the guest: the notifications module drops them, and the phone registers again under the new sign-in",
    session: "better-auth's own; the guest's sessions end with the guest",
    teamMember: "a guest joins no team",
    threadFollows:
        "moved by the follows module's own step (`reassignThreadFollowsPage`, a page per mutation): a row per person and thread is unique, so where the new account already follows a thread, its row wins and the guest's is dropped",
    twoFactor: "better-auth's own; a guest has no second factor",
    user: "the guest's user row itself",
};

/** `row` with every top-level field equal to `from` set to `to`. */
export const rewriteOwner = (row: Record<string, unknown>, from: string, to: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === from ? to : value]));

type RawDb = {
    delete: (table: string, id: string) => Promise<void>;
    get: (table: string, id: string) => Promise<unknown>;
    insert: (table: string, document: Record<string, unknown>, options: { allowExplicitId: boolean }) => Promise<string>;
    patch: (table: string, id: string, fields: Record<string, unknown>) => Promise<void>;
    query: (table: string) => {
        paginate: (options: {
            cursor: string | null;
            numItems: number;
        }) => Promise<{ continueCursor: string | null; isDone: boolean; page: Record<string, unknown>[] }>;
        take: (count: number) => Promise<Record<string, unknown>[]>;
    };
};

const rawDb = (ctx: { db: unknown }): RawDb => ctx.db as RawDb;

/** On the GUEST's shard: one page of `table`, from `cursor`. */
export const listShardRowsPage = internalQuery
    .input({ cursor: v.union(v.string(), v.null()), table: v.string() })
    .output(v.object({ continueCursor: v.union(v.string(), v.null()), isDone: v.boolean(), page: v.array(v.any()) }))
    .query(async ({ args, ctx }) => {
        const { continueCursor, isDone, page } = await rawDb(ctx).query(args.table).paginate({ cursor: args.cursor, numItems: MERGE_PAGE_SIZE });

        return { continueCursor, isDone, page };
    });

/**
 * On the GUEST's shard: the ids of the first page of `table` — for the delete pass. With `ownedBy`, only that user's
 * rows: `userSettings` and `aiUserPreferences` (the tables the new account keeps its own row of) are cleared of the
 * guest's row alone, so a shard that also holds the new account's row (one shard serving both, as local routing can)
 * keeps it. Every other table is listed whole, as before.
 */
export const listShardRowIds = internalQuery
    .input({ ownedBy: v.optional(v.string()), table: v.string() })
    .output(v.array(v.string()))
    .query(async ({ args, ctx }) => {
        if (args.ownedBy !== undefined) {
            const facades = ctx.db as unknown as Record<
                string,
                { findMany: (options: { limit: number; where: { userId: string } }) => Promise<{ page: Record<string, unknown>[] }> }
            >;
            const { page } = await facades[args.table]!.findMany({ limit: MERGE_PAGE_SIZE, where: { userId: args.ownedBy } });

            return page.map((row) => row._id as string);
        }

        const rows = await rawDb(ctx).query(args.table).take(MERGE_PAGE_SIZE);

        return rows.map((row) => row._id as string);
    });

/**
 * The new account keeps its own `userSettings` row, but the guest's skipped first-run steps are a choice the guest made
 * and would otherwise vanish on sign-up: they are added to the new row's list and nothing else of it changes.
 */
const carrySetupSteps = async (ctx: { db: unknown }, guestRows: Record<string, unknown>[], from: string, to: string): Promise<void> => {
    // Only the converting guest's own row: a page may hold other rows, and their choices are not this account's.
    const skipped = guestRows.flatMap((row) => (row.userId === from && Array.isArray(row.setupStepsSkipped) ? (row.setupStepsSkipped as string[]) : []));

    if (skipped.length === 0) {
        return;
    }

    // By userId, through the table's index: the new account's row is found wherever it sits, never by scanning a page of rows.
    const settings = (ctx.db as { userSettings: { findFirst: (options: { where: { userId: string } }) => Promise<Record<string, unknown> | null> } })
        .userSettings;
    const existing = await settings.findFirst({ where: { userId: to } });
    const db = rawDb(ctx);

    if (existing) {
        await db.patch("userSettings", existing._id as string, {
            setupStepsSkipped: mergeSkippedSteps(skipped, existing.setupStepsSkipped as string[] | undefined),
        });
    } else {
        await db.insert("userSettings", { setupStepsSkipped: mergeSkippedSteps(skipped, undefined), userId: to }, { allowExplicitId: false });
    }
};

/** On the NEW user's shard: insert `rows` of `table` under their own ids, re-owned. */
export const importShardRows = internalMutation
    .input({ from: v.string(), rows: v.array(v.any()), table: v.string(), to: v.string() })
    .output(v.object({ imported: v.number() }))
    .mutation(async ({ args, ctx }) => {
        const db = rawDb(ctx);

        if (args.table === "userSettings") {
            await carrySetupSteps(ctx, args.rows as Record<string, unknown>[], args.from, args.to);

            return { imported: 0 };
        }

        if (KEEP_NEW_USERS.has(args.table)) {
            return { imported: 0 };
        }

        let imported = 0;

        for (const row of args.rows as Record<string, unknown>[]) {
            if ((await db.get(args.table, row._id as string)) !== null) {
                continue;
            }

            await db.insert(args.table, rewriteOwner(row, args.from, args.to), { allowExplicitId: true });
            imported += 1;
        }

        return { imported };
    });

/** On the GUEST's shard: delete the moved rows. */
export const deleteShardRows = internalMutation
    .input({ ids: v.array(v.string()), table: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const db = rawDb(ctx);

        for (const id of args.ids) {
            if ((await db.get(args.table, id)) !== null) {
                await db.delete(args.table, id);
            }
        }

        return null;
    });

/** Re-point every `.global()` row naming the guest to the new user, and drop the guest's census row. */
/**
 * Global rows one `reassignGlobalRows` call moves: each is one D1 statement, and an invocation may run only so many, so a
 * guest with more is moved over several calls (`mergeGuestInto` repeats it until `done`).
 */
const REASSIGN_BATCH = 200;

/**
 * Fewer rows per call for a table whose rows are large: each read row is charged whole against the call's read limit,
 * and a rule-file row may hold up to `MAX_RULE_FILES_BYTES`.
 */
const REASSIGN_BATCH_BY_TABLE: Readonly<Record<string, number>> = { projectRuleFiles: 8 };

export const reassignGlobalRows = internalMutation
    .input({ from: v.string(), to: v.string() })
    .output(v.object({ done: v.boolean(), reassigned: v.number() }))
    .mutation(async ({ args, ctx }) => {
        const facades = ctx.db as unknown as Record<
            string,
            {
                findMany: (options: { consistency: "primary"; limit: number; where: Record<string, string> }) => Promise<{ page: Record<string, unknown>[] }>;
            }
        >;
        let reassigned = 0;

        for (const [table, columns] of Object.entries(GLOBAL_USER_COLUMNS)) {
            for (const column of columns) {
                const room = Math.min(REASSIGN_BATCH - reassigned, REASSIGN_BATCH_BY_TABLE[table] ?? REASSIGN_BATCH);

                if (room <= 0) {
                    // Primary reads: a patch moves its row out of the filter, so the next call starts where this one stopped.
                    return { done: false, reassigned };
                }

                const { page } = await facades[table]!.findMany({ consistency: "primary", limit: room + 1, where: { [column]: args.from } });

                for (const row of page.slice(0, room)) {
                    await ctx.db.patch(table as never, row._id as never, { [column]: args.to } as never);
                    reassigned += 1;
                }

                if (page.length > room) {
                    return { done: false, reassigned };
                }
            }
        }

        // Through each module's own write surface, never the generic loop above.
        await dropPushDevicesOf(ctx.db, args.from);

        const { page: census } = await ctx.db.shardActivity.findMany({ where: { shardKey: args.from } });

        for (const row of census) {
            await ctx.db.delete("shardActivity", row._id);
        }

        return { done: true, reassigned };
    });

/**
 * One page of the guest's thread follows, moved through the follows module's own write surface. A page per mutation:
 * a D1 read and write per row would otherwise pass the Worker's subrequest ceiling at a few hundred follows.
 */
export const reassignThreadFollowsPage = internalMutation
    .input({ from: v.string(), to: v.string() })
    .output(v.object({ hasMore: v.boolean(), moved: v.number() }))
    .mutation(async ({ args, ctx }) => await mergeThreadFollowsPage(ctx.db, args.from, args.to));

/** A caller into a named shard, as `createShardClient(...).call` is. */
export type ShardCall = <R>(reference: { __lunoraRef: string }, args: Record<string, unknown>, shardKey: string) => Promise<R>;

/** The guest's thread follows, a page per call; `drained` is false when the round cap stopped it with rows left. */
const moveThreadFollows = async (call: ShardCall, references: MergeReferences, from: string, to: string): Promise<{ drained: boolean; moved: number }> => {
    let moved = 0;

    for (let round = 0; round < MAX_ROUNDS_PER_TABLE; round += 1) {
        const page: { hasMore: boolean; moved: number } = await call(references.reassignFollows, { from, to }, to);

        moved += page.moved;

        if (!page.hasMore) {
            return { drained: true, moved };
        }
    }

    return { drained: false, moved };
};

/**
 * Move everything of guest `from` to user `to`. Runs where a shard client is
 * available (the better-auth link hook in `auth.ts`).
 */
export const mergeGuestInto = async (call: ShardCall, references: MergeReferences, from: string, to: string): Promise<{ moved: number }> => {
    let moved = 0;
    const tables = shardLocalTables();

    // Copy everything first.
    for (const table of tables) {
        let cursor: string | null = null;

        for (let round = 0; round < MAX_ROUNDS_PER_TABLE; round += 1) {
            const page: { continueCursor: string | null; isDone: boolean; page: Record<string, unknown>[] } = await call(
                references.list,
                { cursor, table },
                from,
            );

            if (page.page.length > 0) {
                await call(references.importRows, { from, rows: page.page, table, to }, to);
                moved += page.page.length;
            }

            if (page.isDone || page.continueCursor === null) {
                break;
            }

            cursor = page.continueCursor;
        }
    }

    // Then clear the guest's shard.
    let drained = true;

    for (const table of tables) {
        let emptied = false;

        for (let round = 0; round < MAX_ROUNDS_PER_TABLE; round += 1) {
            const ids: string[] = await call(references.listIds, KEEP_NEW_USERS.has(table) ? { ownedBy: from, table } : { table }, from);

            if (ids.length === 0) {
                emptied = true;

                break;
            }

            await call(references.deleteRows, { ids, table }, from);
        }

        drained &&= emptied;
    }

    // In batches: each call moves at most `REASSIGN_BATCH` rows, so a guest with many never hits the statement cap.
    for (;;) {
        const { done } = await call<{ done: boolean }>(references.reassignGlobal, { from, to }, to);

        if (done) {
            break;
        }
    }

    const follows = await moveThreadFollows(call, references, from, to);

    moved += follows.moved;

    // Stopped by the round cap with follow rows left: fail the job, so its redelivery moves the rest and deletes the guest.
    if (!follows.drained) {
        throw new Error(`guest ${from} still has thread follows past the merge's round cap; the merge into ${to} runs again`);
    }

    // Only once nothing of the guest's is left to move: a later run still needs to find it otherwise.
    if (drained) {
        const result: { deleted: boolean; followsRemain?: boolean } = await call(references.deleteGuest, { userId: from }, from);

        // A follow written under the guest's id after the last page: fail the job, so its redelivery moves it.
        if (result.followsRemain === true) {
            throw new Error(`guest ${from} still has thread follows; the merge into ${to} runs again`);
        }
    }

    return { moved };
};

/** A guard against a page that never drains. A guest has far fewer rows than this. */
const MAX_ROUNDS_PER_TABLE = 1000;

/** The generated references `mergeGuestInto` calls (passed in, so this module does not import `_generated/api`). */
export interface MergeReferences {
    deleteGuest: { __lunoraRef: string };
    deleteRows: { __lunoraRef: string };
    importRows: { __lunoraRef: string };
    list: { __lunoraRef: string };
    listIds: { __lunoraRef: string };
    reassignFollows: { __lunoraRef: string };
    reassignGlobal: { __lunoraRef: string };
}

/**
 * The move, as a queue job on the NEW user's shard (`auth.ts` enqueues it).
 * Off the sign-up request: a guest's rows are one round trip per table and
 * page, far too long to hold the request that creates the account. Redelivery
 * is safe — see the module comment.
 */
export const runGuestMerge = internalAction
    .input({ from: v.string(), to: v.string() })
    .output(v.object({ moved: v.number() }))
    .action(async ({ args, ctx: context }) => {
        // The guest is marked as merging before its pins move, so a pin it writes meanwhile is refused (`lib/account-moves.ts`).
        await context.runMutation(internal.lib.account_moves.beginAccountMoveFor, { kind: "merging", userId: args.from });
        // A pin write that renewed the guest's lease before the marker may still be in flight. The merge fails until none is, and the job
        // is retried; the marker stays, so no new write gets in meanwhile (`lib/account-moves.ts`).
        const { inFlight } = await context.runMutation(internal.lib.account_moves.pinWritesInFlightFor, { userId: args.from });

        if (inFlight) {
            throw new LunoraError("CONFLICT", "The guest's pin writes are still in flight; the merge is retried");
        }

        // Moves the pins of every route held by `routeUserId` to the new account, on each route's owner shard, one batch per call. Each
        // move is idempotent, so a redelivery repeats it safely.
        const reassignPinsOnRoutesOf = async (routeUserId: string): Promise<void> => {
            let cursor: string | null = null;
            let isDone = false;

            while (!isDone) {
                const routes: { continueCursor: string | null; isDone: boolean; page: { ownerId: string; threadId: string }[] } = await context.runQuery(
                    internal.chat.pins.functions.listSharedPinRoutesForExport,
                    { cursor, userId: routeUserId },
                );

                for (const route of routes.page) {
                    let more = true;

                    while (more) {
                        const result = await callOnShard(
                            internal.chat.pins.functions.reassignUserPinsOnThread,
                            { from: args.from, threadId: route.threadId as never, to: args.to },
                            { shardKey: route.ownerId },
                        );

                        more = result.hasMore;
                    }
                }

                isDone = routes.isDone;
                cursor = routes.continueCursor;
            }
        };

        // The guest's pins on other owners' threads move while their routes still name the guest; the routes move with the guest's
        // global rows in the merge below.
        await reassignPinsOnRoutesOf(args.from);

        const result = await mergeGuestInto(
            async (reference, callArgs, shardKey) => (await callOnShard(reference as never, callArgs as never, { shardKey })) as never,
            {
                deleteGuest: internal.auth.hooks.deleteMergedGuest,
                deleteRows: internal.lib.account_merge.deleteShardRows,
                importRows: internal.lib.account_merge.importShardRows,
                list: internal.lib.account_merge.listShardRowsPage,
                listIds: internal.lib.account_merge.listShardRowIds,
                reassignFollows: internal.lib.account_merge.reassignThreadFollowsPage,
                reassignGlobal: internal.lib.account_merge.reassignGlobalRows,
            },
            args.from,
            args.to,
        );

        // A parallel merge of the owner can move a thread's shard, and so the guest's pins, between the pass above reading a route and
        // the merge re-pointing it. The routes now held by `to` name the shard that holds the pins: a second pass reaches them.
        await reassignPinsOnRoutesOf(args.to);
        await context.runMutation(internal.lib.account_moves.endAccountMoveFor, { userId: args.from });

        authLogger.info(`[auth] moved ${String(result.moved)} rows from guest ${args.from} to ${args.to}`);

        return result;
    });
