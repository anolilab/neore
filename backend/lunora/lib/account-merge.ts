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
 *    Before that, the guest's organization contributor entries are handed to the new account
 *    ({@link handOverOrganizationContributors}), so its organization ledger rows land in the cohort they
 *    were counted in; an older row that cannot still moves, held out of the organization view (`heldFrom`);
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
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { mergeSkippedSteps } from "../auth/lib/setup-step-limits";
import { authLogger } from "./logger";
import { callOnShard } from "./cross-shard";
import { enqueueJob } from "./job-queue";
import { noteRetentionDueAt, noteShardDue } from "./shard-housekeeping";
import schema from "../schema";
import { dropPushDevicesOf } from "../notifications/push-device-writes";
import { mergeThreadFollowsPage } from "../chat/follows/follow-writes";
import { copyMergedRunWebhooks } from "../run-webhooks/table-writes";
import { copyMergedMcpEvents } from "../public-api/events-log";
import { ORGANIZATION_RECORD_LATE_MS } from "../usage/activity-logic";
import { patchRow } from "./patch";

/** Rows moved per round trip. */
export const MERGE_PAGE_SIZE = 100;

/** The guest's own copy of these is dropped: the new account already has its seeded row. */
const KEEP_NEW_USERS = new Set(["aiUserPreferences", "userSettings"]);

/**
 * Tables whose rows are copied for the guest alone: another user's row on the guest's shard stays where it is, so the
 * clear pass takes only the guest's rows of these, even when the two shards are separate stores.
 */
const COPIED_FOR_GUEST_ONLY = new Set([...KEEP_NEW_USERS, "runWebhooks"]);

/** The claim scope of the store probe: a marker written on the new account's shard and looked for on the guest's. */
export const MERGE_PROBE_SCOPE = "guest-merge-probe";

/** How long the probe marker is kept: far past the write-then-read of one attempt, which releases it; the purge cron drops a lost one. */
const MERGE_PROBE_TTL_MS = 60 * 60 * 1000;

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
    // The organizations a guest's projects were filed under: the list follows the guest's ledger rows (which move with their shard).
    usageOrganizationContributors: ["userId"],
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

/**
 * A top-level field that can name a user: `userId`, or an id or `By` reference (`ownerId`, `grantedBy`, `resolvedBy`). Only these
 * are re-pointed, so a content field whose text happens to equal the guest's id (a thread titled with it) is left as it is.
 */
const USER_REFERENCE_SUFFIX = /(?:Id|By)$/;

export const isUserReferenceField = (key: string): boolean => key === "userId" || USER_REFERENCE_SUFFIX.test(key);

/** `row` with every user-reference field equal to `from` set to `to` (see {@link isUserReferenceField}). */
export const rewriteOwner = (row: Record<string, unknown>, from: string, to: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === from && isUserReferenceField(key) ? to : value]));

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

/** The column a user-sharded table is sharded on, which names the row's owner. Undefined for a table that is not user-sharded. */
export const shardOwnerField = (table: string): string | undefined => {
    const shardMode = (schema as unknown as { tables: Record<string, { shardMode?: { field?: string; kind?: string } }> }).tables[table]?.shardMode;

    return shardMode?.kind === "shardBy" ? shardMode.field : undefined;
};

/**
 * On the GUEST's shard: the ids of the first page of `table` — for the delete pass. With `ownedBy`, only that user's rows,
 * so a shard that also holds the new account's rows (one shard serving both, as local routing can) keeps them. A table that
 * is not user-sharded has no owner to filter on: asked for one user's rows of it, this lists none, never the whole table,
 * which on a shared store holds everyone's rows. Without `ownedBy`, the first page of any table.
 */
export const listShardRowIds = internalQuery
    .input({ ownedBy: v.optional(v.string()), table: v.string() })
    .output(v.array(v.string()))
    .query(async ({ args, ctx }) => {
        const ownerField = shardOwnerField(args.table);

        if (args.ownedBy !== undefined && ownerField === undefined) {
            return [];
        }

        if (args.ownedBy !== undefined && ownerField !== undefined) {
            const facades = ctx.db as unknown as Record<
                string,
                { findMany: (options: { limit: number; where: Record<string, string> }) => Promise<{ page: Record<string, unknown>[] }> }
            >;
            const { page } = await facades[args.table]!.findMany({ limit: MERGE_PAGE_SIZE, where: { [ownerField]: args.ownedBy } });

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
    .output(v.object({ held: v.number(), imported: v.number() }))
    .mutation(async ({ args, ctx }) => {
        const db = rawDb(ctx);

        if (args.table === "userSettings") {
            await carrySetupSteps(ctx, args.rows as Record<string, unknown>[], args.from, args.to);

            return { held: 0, imported: 0 };
        }

        if (args.table === "runWebhooks") {
            const guestRows = (args.rows as Record<string, unknown>[]).filter((row) => row.userId === args.from);

            return {
                held: 0,
                imported: await copyMergedRunWebhooks(
                    ctx,
                    guestRows.map((row) => rewriteOwner(row, args.from, args.to)),
                    args.from,
                    args.to,
                ),
            };
        }

        // A guest's event log is renumbered after the new account's own (its `seq` means nothing there). The guest's watermark is not
        // copied: the new account's is rebuilt from the events appended.
        if (args.table === "mcpEvents") {
            const guestRows = (args.rows as Record<string, unknown>[]).filter((row) => row.userId === args.from);

            return { held: 0, imported: await copyMergedMcpEvents(ctx, guestRows, args.to) };
        }

        if (KEEP_NEW_USERS.has(args.table) || args.table === "mcpEventWatermarks") {
            return { held: 0, imported: 0 };
        }

        let imported = 0;
        let held = 0;
        // Per organization: whether the new account's entry there is the guest's, handed over with its cohort.
        const handedOver = new Map<string, boolean>();

        // A user-sharded table's rows are copied for the guest, and also for another user whose row sits on the guest's shard.
        const ownerField = shardOwnerField(args.table);

        for (const row of args.rows as Record<string, unknown>[]) {
            const id = row._id as string;
            const existing = (await db.get(args.table, id)) as Record<string, unknown> | null;

            if (existing === null) {
                // The guest's own row is re-owned. Another user's row (a collaborator's comment on the guest's page) moves as it
                // is: its owner stays and nothing in it is rewritten, so it still belongs to the page once the page moves.
                const guestOwned = ownerField === undefined || row[ownerField] === args.from;
                let moved: Record<string, unknown> = guestOwned ? rewriteOwner(row, args.from, args.to) : row;

                // An organization ledger row older than `ORGANIZATION_RECORD_LATE_MS` is in a week the organization view may already show. It
                // counts only in the cohort it was counted in: where the guest's entry became the new account's
                // (`handOverOrganizationContributors`), every cell stays as it was. Elsewhere (the account has its own entry, or the guest had
                // none yet) it would change a released week by the guest's spend: it still moves, held (`heldFrom`), so the account keeps it
                // in its export until retention prunes it, and the view never counts it. Nothing of the guest's is left behind to be deleted.
                if (args.table === "usageOrganizationReplies" && typeof row["at"] === "number" && ctx.now - row["at"] > ORGANIZATION_RECORD_LATE_MS) {
                    const organizationId = String(row["organizationId"]);
                    let same = handedOver.get(organizationId);

                    if (same === undefined) {
                        const entry = await ctx.db.usageOrganizationContributors.findFirst({
                            consistency: "primary",
                            where: { organizationId, userId: args.to },
                        });

                        same = entry?.mergedFrom === args.from;
                        handedOver.set(organizationId, same);
                    }

                    if (!same) {
                        moved = { ...moved, heldFrom: typeof row["heldFrom"] === "string" ? row["heldFrom"] : args.from };
                    }
                }

                await db.insert(args.table, moved, { allowExplicitId: true });
                imported += 1;

                if (typeof moved["heldFrom"] === "string") {
                    held += 1;
                }

                continue;
            }

            // A row here under the same id is this row: the shard is shared, or an earlier pass copied it (re-owned to the new
            // account, or a collaborator's row kept as it is). One owned by anyone else is a different row; skipping it would
            // let the clear pass delete the guest's copy, so the merge stops before anything is cleared.
            if (ownerField !== undefined) {
                const existingOwner = existing[ownerField];
                const incomingOwner = row[ownerField];
                // Only the guest's own row may find itself under either account; a collaborator's row must find the same owner.
                const reowned = incomingOwner === args.from && (existingOwner === args.from || existingOwner === args.to);

                if (!reowned && existingOwner !== incomingOwner) {
                    throw new Error(`${args.table} row ${id} already exists on the new account's shard as another user's row; the merge into ${args.to} stops`);
                }
            }

            // The guest's own row, already on this shard under its id (a shared shard): re-own it in place, so the same id is
            // never written twice. A row already re-owned has no guest field left, and is skipped. Only a row whose owner field
            // names the guest is re-owned: another field naming the guest says nothing about who owns the row.
            if (ownerField === undefined || existing[ownerField] !== args.from) {
                continue;
            }

            const guestFields = Object.fromEntries(
                Object.entries(existing)
                    .filter(([key, value]) => key !== "_id" && value === args.from && isUserReferenceField(key))
                    .map(([key]) => [key, args.to]),
            );

            if (Object.keys(guestFields).length > 0) {
                await db.patch(args.table, id, guestFields);
                imported += 1;
            }
        }

        if (held > 0) {
            authLogger.info(`[auth] held ${String(held)} organization ledger rows of guest ${args.from} out of the organization view`, { to: args.to });
        }

        // Moved usage rows have no retention time on this shard (its census row was the guest's): wake it now, so the tick prunes them and
        // sets the exact time.
        if (imported > 0 && (args.table === "usageOrganizationReplies" || args.table === "usageDaily")) {
            await noteRetentionDueAt(ctx, ctx.now);
            await noteShardDue(ctx, ctx.now);
        }

        return { held, imported };
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

/** Organization contributor entries one {@link handOverOrganizationContributors} call decides. */
const HAND_OVER_BATCH = 50;

/**
 * On the NEW user's shard, before any row is copied: each of the guest's organization contributor entries becomes the new account's, in the
 * guest's cohort and marked with the guest (`mergedFrom`), so the copy moves the guest's ledger rows into the cohort that counted them and
 * no closed week changes. Where the new account already has an entry under the organization, or ledger rows there of its own, the guest's
 * entry stays the guest's, marked, and goes once the guest's shard is empty ({@link reassignGlobalRows}): the cohort that held the guest then
 * shows without them, as one that lost a member does, and the guest's closed-week rows stay out of the view. A marked entry keeps its cohort
 * withheld, and keeps the guest from being booked again while rows of theirs are still on their shard (`usage/cohorts.ts#insertContributor`).
 * Handing over first also means a reply the new account records during the merge finds an entry, and books no cohort of its own that the
 * guest's rows would then land in.
 */
export const handOverOrganizationContributors = internalMutation
    .input({ from: v.string(), to: v.string() })
    .output(v.object({ done: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        // Primary reads: a decided entry is marked, and leaves the filter, so the next call starts where this one stopped.
        const { page } = await ctx.db.usageOrganizationContributors.findMany({
            consistency: "primary",
            limit: HAND_OVER_BATCH + 1,
            where: { mergedFrom: { isNull: true }, userId: args.from },
        });

        for (const entry of page.slice(0, HAND_OVER_BATCH)) {
            const { organizationId } = entry;
            const kept = await ctx.db.usageOrganizationContributors.findFirst({ consistency: "primary", where: { organizationId, userId: args.to } });
            // Rows with no entry yet (a reconcile still to run): they would join the guest's cohort and change its closed weeks.
            const ownRows = kept
                ? undefined
                : await ctx.db.usageOrganizationReplies.findFirst({
                      consistency: "primary",
                      where: { heldFrom: { isNull: true }, organizationId, userId: args.to },
                  });

            if (kept || ownRows) {
                await ctx.db.patch("usageOrganizationContributors", entry._id, { mergedFrom: args.from });
            } else {
                await ctx.db.patch("usageOrganizationContributors", entry._id, { mergedFrom: args.from, userId: args.to });
            }
        }

        return { done: page.length <= HAND_OVER_BATCH };
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
    // `guestDrained: false` when rows are still on the guest's shard: the organization contributor entries are left as the hand-over
    // marked them (their cohorts withheld), so the guest's leftover ledger rows are never booked into a cohort of their own.
    .input({ from: v.string(), guestDrained: v.optional(v.boolean()), to: v.string() })
    .output(v.object({ done: v.boolean(), reassigned: v.number() }))
    .mutation(async ({ args, ctx }) => {
        const facades = ctx.db as unknown as Record<
            string,
            {
                findMany: (options: { consistency: "primary"; limit: number; where: Record<string, string> }) => Promise<{ page: Record<string, unknown>[] }>;
            }
        >;
        let reassigned = 0;

        const settleContributors = args.guestDrained !== false;

        for (const [table, columns] of Object.entries(GLOBAL_USER_COLUMNS)) {
            if (table === "usageOrganizationContributors" && !settleContributors) {
                continue;
            }

            for (const column of columns) {
                const room = Math.min(REASSIGN_BATCH - reassigned, REASSIGN_BATCH_BY_TABLE[table] ?? REASSIGN_BATCH);

                if (room <= 0) {
                    // Primary reads: a patch moves its row out of the filter, so the next call starts where this one stopped.
                    return { done: false, reassigned };
                }

                const { page } = await facades[table]!.findMany({ consistency: "primary", limit: room + 1, where: { [column]: args.from } });

                for (const row of page.slice(0, room)) {
                    // The new account may already be a contributor under the organization: its one entry is kept, and the guest's copy goes,
                    // so the member's ledger is never summed twice. So does an entry the hand-over marked to go, whatever the new account
                    // now has: moved, it would bring the new account's own closed weeks into the guest's cohort.
                    if (table === "usageOrganizationContributors") {
                        const kept = await ctx.db.usageOrganizationContributors.findFirst({
                            consistency: "primary",
                            where: { organizationId: String(row.organizationId), userId: args.to },
                        });

                        if (kept || typeof row.mergedFrom === "string") {
                            await ctx.db.delete(table as never, row._id as never);
                            reassigned += 1;

                            continue;
                        }
                    }

                    await ctx.db.patch(table as never, row._id as never, { [column]: args.to } as never);
                    reassigned += 1;
                }

                if (page.length > room) {
                    return { done: false, reassigned };
                }
            }
        }

        // The guest's rows are copied and deleted: each entry a hand-over marked (`handOverOrganizationContributors`) is settled against the
        // ledger rows the new account now has, as the reconcile would: unmarked where it has some, gone where it has none (a stale entry, or
        // rows the prune took). The view withholds the entry's cohort until then.
        if (settleContributors) {
            const markRoom = Math.min(REASSIGN_BATCH - reassigned, HAND_OVER_BATCH);

            if (markRoom <= 0) {
                return { done: false, reassigned };
            }

            const { page: marked } = await ctx.db.usageOrganizationContributors.findMany({
                consistency: "primary",
                limit: markRoom + 1,
                where: { mergedFrom: args.from, userId: args.to },
            });

            for (const entry of marked.slice(0, markRoom)) {
                const row = await ctx.db.usageOrganizationReplies.findFirst({
                    consistency: "primary",
                    where: { heldFrom: { isNull: true }, organizationId: entry.organizationId, userId: args.to },
                });

                if (row) {
                    await patchRow(ctx.db as never, "usageOrganizationContributors", entry, { mergedFrom: undefined });
                } else {
                    await ctx.db.delete("usageOrganizationContributors", entry._id);
                }

                reassigned += 1;
            }

            if (marked.length > markRoom) {
                return { done: false, reassigned };
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
 * Whether the guest's and the new account's shard keys serve one store: a marker written under `to` and looked for under
 * `from`. Each attempt writes a key of its own, so a marker a crashed earlier attempt left (and which may lapse at any
 * moment) is never what this attempt reads. A write that did not take a fresh claim, or a read that fails, throws: only a
 * marker this attempt wrote and then missed may answer "separate", the answer that clears other users' rows.
 */
const probeSharedStore = async (call: ShardCall, references: MergeReferences, from: string, to: string): Promise<boolean> => {
    const key = `${from}:${to}:${crypto.randomUUID()}`;
    const written: unknown = await call(references.markProbe, { key, scope: MERGE_PROBE_SCOPE, ttlMs: MERGE_PROBE_TTL_MS }, to);

    if (written !== true) {
        throw new Error(`the store probe for the merge of guest ${from} into ${to} was not written; the merge runs again`);
    }

    const held: unknown = await call(references.probeHeld, { key, scope: MERGE_PROBE_SCOPE }, from);

    if (typeof held !== "boolean") {
        throw new TypeError(`the store probe for the merge of guest ${from} into ${to} gave no answer; the merge runs again`);
    }

    // The marker has done its job; the purge cron drops it if this release is lost.
    try {
        await call(references.releaseProbe, { key, scope: MERGE_PROBE_SCOPE }, to);
    } catch (error) {
        authLogger.warn(`[auth] the store probe marker for the merge of guest ${from} into ${to} was not released:`, error);
    }

    return held;
};

/**
 * Move everything of guest `from` to user `to`. Runs where a shard client is
 * available (the better-auth link hook in `auth.ts`).
 */
export const mergeGuestInto = async (call: ShardCall, references: MergeReferences, from: string, to: string): Promise<{ moved: number }> => {
    // The guest's organization contributor entries first, so the copy knows which ledger rows keep their cohort.
    let handedOver = false;

    for (let round = 0; round < MAX_ROUNDS_PER_TABLE && !handedOver; round += 1) {
        ({ done: handedOver } = await call<{ done: boolean }>(references.handOverContributors, { from, to }, to));
    }

    // Stopped by the round cap with entries left: copying now would hold rows of a cohort still to be handed over. Fail the job, so its
    // redelivery hands over the rest first; nothing has been copied or deleted yet.
    if (!handedOver) {
        throw new Error(`guest ${from} still has organization contributor entries past the merge's round cap; the merge into ${to} runs again`);
    }

    let moved = 0;
    const tables = shardLocalTables();

    // Copy everything first. A table whose copy the round cap stops is not copied through, and the deletion below must not run for it.
    let copied = true;

    for (const table of tables) {
        let cursor: string | null = null;
        let tableCopied = false;

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
                tableCopied = true;

                break;
            }

            cursor = page.continueCursor;
        }

        copied &&= tableCopied;
    }

    // Stopped by the round cap with rows not yet copied: fail before anything is deleted, so the guest keeps them. The queue redelivers
    // the merge, and a repeated copy is harmless (rows are skipped by id, events by event id).
    if (!copied) {
        throw new Error(`guest ${from} still has rows past the merge's round cap; the merge into ${to} runs again`);
    }

    // Then clear the guest's shard. Whether both shard keys serve one store (as local routing can) decides what goes: on one
    // store, another user's row there is the same row the new account's shard holds, so only the guest's rows are cleared,
    // and a table with no owner column (not user-sharded) is not cleared at all: its rows are the new account's rows too, and
    // every other user's. On separate stores, the guest's store holds only rows written under the guest's key, and the copy
    // pass put every one of them on the new shard, a collaborator's row included, so the guest's copy of each goes as well;
    // that holds for a table with no owner column too. Probed on every run, so a redelivered merge decides the same way.
    const sharedStore = await probeSharedStore(call, references, from, to);
    const clearPlan = tables.flatMap((table): { ownedBy?: string; table: string }[] => {
        if (!sharedStore && !COPIED_FOR_GUEST_ONLY.has(table)) {
            return [{ table }];
        }

        if (shardOwnerField(table) !== undefined) {
            return [{ ownedBy: from, table }];
        }

        if (sharedStore) {
            return [];
        }

        // A table copied for the guest alone must name its owner, or its clear would take another user's row too.
        throw new Error(`${table} is cleared for the guest alone but has no owner column; the merge of guest ${from} into ${to} stops before clearing`);
    });
    let drained = true;

    for (const listArgs of clearPlan) {
        const { table } = listArgs;
        let emptied = false;

        for (let round = 0; round < MAX_ROUNDS_PER_TABLE; round += 1) {
            const ids: string[] = await call(references.listIds, listArgs, from);

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
        const { done } = await call<{ done: boolean }>(references.reassignGlobal, { from, guestDrained: drained, to }, to);

        if (done) {
            break;
        }
    }

    const follows = await moveThreadFollows(call, references, from, to);

    moved += follows.moved;

    // Rows left on the guest's shard past the round cap: the marked contributor entries stay unsettled (their cohorts withheld). Fail the
    // job, so its redelivery copies and clears the rest, settles them and deletes the guest, instead of ending with them marked for good.
    if (!drained) {
        throw new Error(`guest ${from} still has rows on its shard past the merge's round cap; the merge into ${to} runs again`);
    }

    // Stopped by the round cap with follow rows left: fail the job, so its redelivery moves the rest and deletes the guest.
    if (!follows.drained) {
        throw new Error(`guest ${from} still has thread follows past the merge's round cap; the merge into ${to} runs again`);
    }

    // Only now that nothing of the guest's is left to move: a later run still needs to find it otherwise.
    const result: { deleted: boolean; followsRemain?: boolean } = await call(references.deleteGuest, { userId: from }, from);

    // A follow written under the guest's id after the last page: fail the job, so its redelivery moves it.
    if (result.followsRemain === true) {
        throw new Error(`guest ${from} still has thread follows; the merge into ${to} runs again`);
    }

    return { moved };
};

/** A guard against a page that never drains. A guest has far fewer rows than this. */
const MAX_ROUNDS_PER_TABLE = 1000;

/** The generated references `mergeGuestInto` calls (passed in, so this module does not import `_generated/api`). */
export interface MergeReferences {
    deleteGuest: { __lunoraRef: string };
    deleteRows: { __lunoraRef: string };
    handOverContributors: { __lunoraRef: string };
    importRows: { __lunoraRef: string };
    list: { __lunoraRef: string };
    listIds: { __lunoraRef: string };
    /** `claimKey`, run on the new account's shard to leave the store probe's marker. */
    markProbe: { __lunoraRef: string };
    /** `claimHeld`, run on the guest's shard: `true` when it sees the marker, so both keys serve one store. */
    probeHeld: { __lunoraRef: string };
    reassignFollows: { __lunoraRef: string };
    reassignGlobal: { __lunoraRef: string };
    /** `releaseKey`, run on the new account's shard to drop the probe's marker once read. */
    releaseProbe: { __lunoraRef: string };
}

/** The route reads and the batch move that the guest's pin moves need. Injected, so the order of the passes can be tested. */
export type GuestPinMoves = {
    listRoutes: (
        routeUserId: string,
        cursor: string | null,
    ) => Promise<{ continueCursor: string | null; isDone: boolean; page: { ownerId: string; threadId: string }[] }>;
    mergeRows: () => Promise<{ moved: number }>;
    moveBatch: (route: { ownerId: string; threadId: string }) => Promise<{ hasMore: boolean }>;
};

/** Moves the pins of every route `routeUserId` holds, one batch per call on each route's owner shard. Each move is idempotent. */
export const movePinsOnRoutesOf = async (moves: GuestPinMoves, routeUserId: string): Promise<void> => {
    let cursor: string | null = null;
    let isDone = false;

    while (!isDone) {
        const routes = await moves.listRoutes(routeUserId, cursor);

        for (const route of routes.page) {
            let more = true;

            while (more) {
                const batch = await moves.moveBatch(route);

                more = batch.hasMore;
            }
        }

        isDone = routes.isDone;
        cursor = routes.continueCursor;
    }
};

/**
 * The guest's pins move before and after the rows. Before: the guest's pins on other owners' threads move while their routes still name the
 * guest. After: a parallel merge of the owner can move a thread's shard, and so the guest's pins, between the first pass reading a route and
 * the rows re-pointing it; the routes the surviving account holds now name the shard that holds the pins, and the second pass reaches them.
 */
export const moveGuestPins = async (moves: GuestPinMoves, from: string, to: string): Promise<{ moved: number }> => {
    await movePinsOnRoutesOf(moves, from);

    const result = await moves.mergeRows();

    await movePinsOnRoutesOf(moves, to);

    return result;
};

/** The claim a guest merge holds while one of its deliveries moves the guest's pins. Long enough for a merge run and its deferrals. */
export const GUEST_MERGE_SCOPE = "guest-merge";
export const GUEST_MERGE_CLAIM_TTL_MS = 30 * 60 * 1000;
/** How long a duplicate delivery waits before it looks again, while another delivery of the same merge holds the claim. */
export const GUEST_MERGE_RECHECK_MS = 30 * 1000;

/**
 * The move, as a queue job on the NEW user's shard (`auth.ts` enqueues it).
 * Off the sign-up request: a guest's rows are one round trip per table and
 * page, far too long to hold the request that creates the account. Redelivery
 * is safe — see the module comment.
 *
 * A move that is still in flight is deferred, not failed: the job runs again once the last pin write the guest's lease covers has run
 * out. The merging marker stays meanwhile, so no new write gets in.
 */
export const runGuestMerge = internalAction
    .input({ from: v.string(), to: v.string() })
    .output(v.object({ moved: v.number() }))
    .action(async ({ args, ctx: context }) => {
        // One delivery of this merge moves the guest's pins at a time. A duplicate delivery (a queue redelivery that overlaps a running
        // merge) waits for the running one, so the first to finish cannot remove a marker the other is still moving pins under.
        const claimedAt = await context.runMutation(internal.lib.claim_once.claimKeyFenced, {
            key: args.from,
            scope: GUEST_MERGE_SCOPE,
            ttlMs: GUEST_MERGE_CLAIM_TTL_MS,
        });

        if (claimedAt === null) {
            await enqueueJob(internal.lib.account_merge.runGuestMerge, args, { delayMs: GUEST_MERGE_RECHECK_MS, shardKey: args.to });

            return { moved: 0 };
        }

        try {
            // The guest is marked as merging before its pins move, so a pin it writes meanwhile is refused (`lib/account-moves.ts`).
            await context.runMutation(internal.lib.account_moves.beginAccountMoveFor, { kind: "merging", userId: args.from });

            // The destination is marked as receiving rows before any lands on it. Its erasure waits for that marker, and this check stops the
            // merge if the erasure has begun: each side writes its marker before it reads the other's, so one of them always sees the other.
            await context.runMutation(internal.lib.account_moves.beginAccountMoveFor, { kind: "importing", userId: args.to });
            const { erasing: destinationErasing } = await context.runMutation(internal.lib.account_moves.isErasingFor, { userId: args.to });

            if (destinationErasing) {
                await context.runMutation(internal.lib.account_moves.endAccountMoveFor, { kind: "importing", userId: args.to });
                await context.runMutation(internal.lib.account_moves.endAccountMoveFor, { kind: "merging", userId: args.from });

                return { moved: 0 };
            }

            // An erasure of the guest has priority: it removes the guest's pins, so a merge that moved one now would leave it under the new
            // account. The merge stops, and its own markers go.
            const { erasing } = await context.runMutation(internal.lib.account_moves.isErasingFor, { userId: args.from });

            if (erasing) {
                await context.runMutation(internal.lib.account_moves.endAccountMoveFor, { kind: "importing", userId: args.to });
                await context.runMutation(internal.lib.account_moves.endAccountMoveFor, { kind: "merging", userId: args.from });

                return { moved: 0 };
            }

            const { until } = await context.runMutation(internal.lib.account_moves.pinWritesInFlightFor, { userId: args.from });

            if (until !== null) {
                // One extra second for clock skew between the writer and this job, so the lease has run out when the job runs.
                await enqueueJob(internal.lib.account_merge.runGuestMerge, args, { delayMs: Math.max(0, until - Date.now()) + 1000, shardKey: args.to });

                return { moved: 0 };
            }

            const moves: GuestPinMoves = {
                listRoutes: async (routeUserId, cursor) =>
                    await context.runQuery(internal.chat.pins.functions.listSharedPinRoutesForExport, { cursor, userId: routeUserId }),
                mergeRows: async () =>
                    await mergeGuestInto(
                        async (reference, callArgs, shardKey) => (await callOnShard(reference as never, callArgs as never, { shardKey })) as never,
                        {
                            deleteGuest: internal.auth.hooks.deleteMergedGuest,
                            deleteRows: internal.lib.account_merge.deleteShardRows,
                            handOverContributors: internal.lib.account_merge.handOverOrganizationContributors,
                            importRows: internal.lib.account_merge.importShardRows,
                            list: internal.lib.account_merge.listShardRowsPage,
                            listIds: internal.lib.account_merge.listShardRowIds,
                            markProbe: internal.lib.claim_once.claimKey,
                            probeHeld: internal.lib.claim_once.claimHeld,
                            reassignFollows: internal.lib.account_merge.reassignThreadFollowsPage,
                            reassignGlobal: internal.lib.account_merge.reassignGlobalRows,
                            releaseProbe: internal.lib.claim_once.releaseKey,
                        },
                        args.from,
                        args.to,
                    ),
                moveBatch: async (route) =>
                    await callOnShard(
                        internal.chat.pins.functions.reassignUserPinsOnThread,
                        { from: args.from, threadId: route.threadId as never, to: args.to },
                        { shardKey: route.ownerId },
                    ),
            };

            const result = await moveGuestPins(moves, args.from, args.to);

            await context.runMutation(internal.lib.account_moves.endAccountMoveFor, { kind: "importing", userId: args.to });
            await context.runMutation(internal.lib.account_moves.endAccountMoveFor, { kind: "merging", userId: args.from });

            authLogger.info(`[auth] moved ${String(result.moved)} rows from guest ${args.from} to ${args.to}`);

            return result;
        } finally {
            await context.runMutation(internal.lib.claim_once.releaseKey, { claimedAt, key: args.from, scope: GUEST_MERGE_SCOPE });
        }
    });
