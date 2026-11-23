/**
 * The `archived` flag on a thread's title and summary vectors (`thread-search.ts`): a Vectorize metadata
 * field on `embeddings_1024`, so a meaning search can filter archived threads BEFORE its top-K cut. It is
 * a column of the vector row, and Lunora's vector sync writes the row's columns to the index after the
 * row's mutation commits, so keeping it current is a row patch — no call of ours leaves the Worker.
 *
 * Three writers keep it current:
 * - the insert: the sync writes the flag it read, and its commit corrects it (`commitThreadSearch`);
 * - an archive or restore: the threads trigger (`thread-search-triggers.ts`) schedules
 *   {@link syncThreadVectorArchived}, whatever wrote `status` (one thread, a bulk change, an undo, the
 *   auto-archive sweep, a task);
 * - vectors written before the flag existed: {@link sweepThreadVectorArchived}, from the shard
 *   housekeeping sweep, walks the shard's thread vectors once in {@link BACKFILL_PAGE}-row steps.
 *
 * Every writer reads the thread's CURRENT status and patches only a row that differs, so each is
 * idempotent and a retry or a late run converges. A vector is patched only when it is the thread's own
 * (`threadId`) and has the thread's owner (`userId`); a thread that is gone or being deleted is left to
 * its cleanup (`deleteThreadVectors`), so nothing here brings a deleted thread's vector back.
 */
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { claimFence, holdClaim, recordClaimResult } from "../lib/claim-once";
import { currentUserShard } from "../lib/shard-context";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { MAX_LENGTH } from "../lib/validators";
import { SEARCH_KINDS, SEARCH_MODEL, SEARCH_TABLE, SEARCH_VECTOR_FIELD, type SearchKind } from "./thread-search-plan";
import { SYNC_RETRY } from "./thread-search-triggers";

/** Vector rows one backfill step reads: each costs one thread read and at most one patch. */
export const BACKFILL_PAGE = 32;

/** How long a backfill step chain is trusted to be alive; past it, the next sweep resumes it from its saved place. */
export const BACKFILL_LEASE_MS = 60 * 60 * 1000;

/** A finished backfill's claim: effectively forever, as `AI_DISCLOSURE_CLAIM_TTL_MS`. Every later vector is written with its flag. */
const BACKFILL_DONE_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** Claim scope of the per-shard backfill; the key is the shard's user id. */
export const BACKFILL_SCOPE = "thread-vector-archived";

const DONE = "done";

type ThreadRow = Pick<Doc<"threads">, "_id" | "status" | "userId">;
type VectorDb = Pick<MutationCtx, "db">["db"];

/** Pure: whether a thread row counts as archived for the vector flag. */
export const isThreadArchived = (thread: { status?: string }): boolean => thread.status === "archived";

/**
 * Sets the thread's current `archived` on one of its vector rows. Does nothing for a row that is gone,
 * belongs to another thread or another owner (fail closed), or already carries the value.
 */
export const alignVectorArchived = async (db: VectorDb, thread: ThreadRow, vectorId: string): Promise<boolean> => {
    const row = await db.get("embeddings_1024", vectorId as Id<"embeddings_1024">);

    if (row === null || row.threadId !== thread._id || thread.userId === undefined || row.userId !== thread.userId) {
        return false;
    }

    const archived = isThreadArchived(thread);

    if (row.archived === archived) {
        return false;
    }

    await db.patch("embeddings_1024", row._id, { archived });

    return true;
};

/** A thread that is gone or being hard-deleted keeps its vectors as they are: its cleanup removes them. */
const liveThread = async (db: VectorDb, threadId: string): Promise<Doc<"threads"> | null> => {
    const thread = (await db.get("threads", threadId as Id<"threads">)) as Doc<"threads"> | null;

    return thread === null || thread.deletingAt !== undefined ? null : thread;
};

/** Scheduled by the threads trigger when `status` moves into or out of `archived`. */
export const syncThreadVectorArchived = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const thread = await liveThread(ctx.db, args.threadId);

        if (thread === null) {
            return null;
        }

        for (const kind of SEARCH_KINDS) {
            const vectorId = thread[SEARCH_VECTOR_FIELD[kind]];

            if (vectorId !== undefined) {
                await alignVectorArchived(ctx.db, thread, vectorId);
            }
        }

        return null;
    });

/** Where a backfill stands: the kind it walks and the cursor within it. Stored as the claim's `result`. */
interface BackfillPlace {
    cursor?: string;
    kind: SearchKind;
}

const FIRST_PLACE: BackfillPlace = { kind: SEARCH_KINDS[0]! };

/** Pure: the saved place, or the start for a missing or unreadable one. */
export const parseBackfillPlace = (result: string | undefined): BackfillPlace => {
    if (result === undefined) {
        return FIRST_PLACE;
    }

    try {
        const parsed = JSON.parse(result) as Partial<BackfillPlace>;

        if (parsed.kind !== undefined && SEARCH_KINDS.includes(parsed.kind)) {
            return { kind: parsed.kind, ...(typeof parsed.cursor === "string" && { cursor: parsed.cursor }) };
        }
    } catch {
        // An unreadable place restarts the walk: every step is idempotent.
    }

    return FIRST_PLACE;
};

/** Pure: where the walk goes after a page of `kind`: further in it, the next kind, or `undefined` when all are done. */
const nextPlace = (kind: SearchKind, page: { continueCursor: string | null; isDone: boolean }): BackfillPlace | undefined => {
    // A page with no cursor to go on ends its kind: starting the kind again would loop.
    if (!page.isDone && page.continueCursor !== null) {
        return { cursor: page.continueCursor, kind };
    }

    const nextKind = SEARCH_KINDS[SEARCH_KINDS.indexOf(kind) + 1];

    return nextKind === undefined ? undefined : { kind: nextKind };
};

/** The claim row as stored, expired or not: an expired running claim still holds the place to resume from. */
const backfillClaim = async (ctx: Pick<MutationCtx, "db">, userId: string) =>
    await ctx.db
        .query("idempotencyClaims")
        .withIndex("by_scope_key", (q) => q.eq("scope", BACKFILL_SCOPE).eq("key", userId))
        .first();

/**
 * Shard housekeeping: starts this shard's backfill, or resumes one whose step chain died (its lease
 * lapsed) from the place it saved. A finished or running backfill is left alone.
 */
export const sweepThreadVectorArchived = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const userId = currentUserShard();

        if (userId === undefined) {
            return null;
        }

        const existing = await backfillClaim(ctx, userId);

        if (existing !== null && (existing.result === DONE || existing.expiresAt > Date.now())) {
            return null;
        }

        const place = parseBackfillPlace(existing?.result);
        const claimedAt = await claimFence(ctx, BACKFILL_SCOPE, userId, { ttlMs: BACKFILL_LEASE_MS, userId });

        if (claimedAt === null) {
            return null;
        }

        await recordClaimResult(ctx, BACKFILL_SCOPE, userId, claimedAt, JSON.stringify(place));
        await runAfterOnShard(
            ctx.scheduler,
            0,
            internal.agent.thread_vector_archived.backfillThreadVectorArchived,
            { claimedAt, ...place },
            userId,
            SYNC_RETRY,
        );

        return null;
    });

/**
 * One backfill step on the current shard: up to {@link BACKFILL_PAGE} thread vectors of one kind, each
 * set to its thread's current flag, then the next step. A step whose claim was taken over (`claimedAt`
 * no longer matches) stops: another chain owns the walk.
 */
export const backfillThreadVectorArchived = internalMutation
    .input({
        claimedAt: v.number(),
        cursor: v.optional(v.string().max(MAX_LENGTH.cursor)),
        kind: v.union(v.literal("title"), v.literal("summary")),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const userId = currentUserShard();

        if (userId === undefined) {
            return null;
        }

        const claim = await backfillClaim(ctx, userId);

        if (claim?.claimedAt !== args.claimedAt || claim.result === DONE) {
            return null;
        }

        const page = await ctx.db
            .query("embeddings_1024")
            .withIndex("model_table_threadId", (q) => q.eq("model", SEARCH_MODEL).eq("table", SEARCH_TABLE[args.kind]))
            .paginate({ cursor: args.cursor ?? null, numItems: BACKFILL_PAGE });

        for (const row of page.page) {
            const thread = row.threadId === undefined ? null : await liveThread(ctx.db, row.threadId);

            if (thread !== null) {
                await alignVectorArchived(ctx.db, thread, row._id);
            }
        }

        const next = nextPlace(args.kind, page);

        if (next === undefined) {
            await holdClaim(ctx, BACKFILL_SCOPE, userId, args.claimedAt, BACKFILL_DONE_TTL_MS, userId);
            await recordClaimResult(ctx, BACKFILL_SCOPE, userId, args.claimedAt, DONE);

            return null;
        }

        // Stretched first: recording refuses a lapsed claim. The place is saved with the step's own writes, so a chain that
        // dies resumes here, not at the start.
        await holdClaim(ctx, BACKFILL_SCOPE, userId, args.claimedAt, Date.now() - args.claimedAt + BACKFILL_LEASE_MS, userId);
        await recordClaimResult(ctx, BACKFILL_SCOPE, userId, args.claimedAt, JSON.stringify(next));
        await runAfterOnShard(
            ctx.scheduler,
            0,
            internal.agent.thread_vector_archived.backfillThreadVectorArchived,
            { claimedAt: args.claimedAt, ...next },
            userId,
            SYNC_RETRY,
        );

        return null;
    });
