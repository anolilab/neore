/**
 * A guest's data follows them into the account they convert to.
 *
 * better-auth converts an anonymous user by creating a NEW user and linking the
 * anonymous one afterwards (`anonymous({ onLinkAccount })`, `auth.ts`). Every
 * row lives on its owner's shard (docs/plans/per-user-sharding.md), so the
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
 * 3. `.global()` rows naming the guest are re-pointed ({@link reassignGlobalRows}).
 *
 * The new account's own seeded `userSettings`/`aiUserPreferences` win over the
 * guest's. Re-running after a partial failure is safe: an id already on the new
 * shard is skipped, and rows already moved are gone from the old one.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { authLogger } from "./logger";
import { callOnShard } from "./cross-shard";
import schema from "../schema";

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
    chatFileAccess: ["userId"],
    // Without this a guest's collection stays the guest's: the files that moved
    // point at it, and `requireOwnCollectionId` refuses the new owner.
    knowledgeCollections: ["userId"],
    pageAccess: ["userId", "ownerId", "grantedBy"],
    pageInvites: ["userId", "ownerId", "acceptedBy"],
    passkey: ["userId"],
    projects: ["userId"],
    promptHistory: ["userId"],
    prompts: ["userId"],
    shardRoutes: ["ownerId"],
    skillRatings: ["userId"],
    skills: ["userId"],
    threadAccess: ["userId", "ownerId", "grantedBy"],
    threadInvites: ["ownerId", "invitedBy", "acceptedBy"],
    userVariableDefaults: ["userId"],
};

/** `.global()` tables with a `userId` the merge deliberately leaves alone, and why. */
export const GLOBAL_USER_TABLES_NOT_REASSIGNED: Readonly<Record<string, string>> = {
    account: "better-auth links the anonymous user itself",
    documentHistory: "an audit trail records who acted; it is not re-attributed",
    member: "a guest joins no organization",
    memberCredits: "a guest joins no organization",
    session: "better-auth's own; the guest's sessions end with the guest",
    teamMember: "a guest joins no team",
    twoFactor: "better-auth's own; a guest has no second factor",
    user: "the guest's user row itself",
};

/** `row` with every top-level field equal to `from` set to `to`. */
export const rewriteOwner = (row: Record<string, unknown>, from: string, to: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === from ? to : value]));

type RawDb = {
    delete: (id: string) => Promise<void>;
    get: (id: string) => Promise<unknown>;
    insert: (table: string, document: Record<string, unknown>, options: { allowExplicitId: boolean }) => Promise<string>;
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

/** On the GUEST's shard: the ids of the first page of `table` — for the delete pass. */
export const listShardRowIds = internalQuery
    .input({ table: v.string() })
    .output(v.array(v.string()))
    .query(async ({ args, ctx }) => {
        const rows = await rawDb(ctx).query(args.table).take(MERGE_PAGE_SIZE);

        return rows.map((row) => row._id as string);
    });

/** On the NEW user's shard: insert `rows` of `table` under their own ids, re-owned. */
export const importShardRows = internalMutation
    .input({ from: v.string(), rows: v.array(v.any()), table: v.string(), to: v.string() })
    .output(v.object({ imported: v.number() }))
    .mutation(async ({ args, ctx }) => {
        if (KEEP_NEW_USERS.has(args.table)) {
            return { imported: 0 };
        }

        const db = rawDb(ctx);
        let imported = 0;

        for (const row of args.rows as Record<string, unknown>[]) {
            if ((await db.get(row._id as string)) !== null) {
                continue;
            }

            await db.insert(args.table, rewriteOwner(row, args.from, args.to), { allowExplicitId: true });
            imported += 1;
        }

        return { imported };
    });

/** On the GUEST's shard: delete the moved rows. */
export const deleteShardRows = internalMutation
    .input({ ids: v.array(v.string()) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const db = rawDb(ctx);

        for (const id of args.ids) {
            if ((await db.get(id)) !== null) {
                await db.delete(id);
            }
        }

        return null;
    });

/** Re-point every `.global()` row naming the guest to the new user, and drop the guest's census row. */
export const reassignGlobalRows = internalMutation
    .input({ from: v.string(), to: v.string() })
    .output(v.object({ reassigned: v.number() }))
    .mutation(async ({ args, ctx }) => {
        const facades = ctx.db as unknown as Record<
            string,
            { findMany: (options: { where: Record<string, string> }) => Promise<{ page: Record<string, unknown>[] }> }
        >;
        let reassigned = 0;

        for (const [table, columns] of Object.entries(GLOBAL_USER_COLUMNS)) {
            for (const column of columns) {
                const { page } = await facades[table]!.findMany({ where: { [column]: args.from } });

                for (const row of page) {
                    await ctx.db.patch(row._id as never, { [column]: args.to } as never);
                    reassigned += 1;
                }
            }
        }

        const { page: census } = await ctx.db.shardActivity.findMany({ where: { shardKey: args.from } });

        for (const row of census) {
            await ctx.db.delete(row._id);
        }

        return { reassigned };
    });

/** A caller into a named shard, as `createShardClient(...).call` is. */
export type ShardCall = <R>(reference: { __lunoraRef: string }, args: Record<string, unknown>, shardKey: string) => Promise<R>;

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
    for (const table of tables) {
        for (let round = 0; round < MAX_ROUNDS_PER_TABLE; round += 1) {
            const ids: string[] = await call(references.listIds, { table }, from);

            if (ids.length === 0) {
                break;
            }

            await call(references.deleteRows, { ids }, from);
        }
    }

    await call(references.reassignGlobal, { from, to }, to);

    return { moved };
};

/** A guard against a page that never drains. A guest has far fewer rows than this. */
const MAX_ROUNDS_PER_TABLE = 1000;

/** The generated references `mergeGuestInto` calls (passed in, so this module does not import `_generated/api`). */
export interface MergeReferences {
    deleteRows: { __lunoraRef: string };
    importRows: { __lunoraRef: string };
    list: { __lunoraRef: string };
    listIds: { __lunoraRef: string };
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
    .action(async ({ args }) => {
        const result = await mergeGuestInto(
            async (reference, callArgs, shardKey) => (await callOnShard(reference as never, callArgs as never, { shardKey })) as never,
            {
                deleteRows: internal.lib.account_merge.deleteShardRows,
                importRows: internal.lib.account_merge.importShardRows,
                list: internal.lib.account_merge.listShardRowsPage,
                listIds: internal.lib.account_merge.listShardRowIds,
                reassignGlobal: internal.lib.account_merge.reassignGlobalRows,
            },
            args.from,
            args.to,
        );

        authLogger.info(`[auth] moved ${String(result.moved)} rows from guest ${args.from} to ${args.to}`);

        return result;
    });
