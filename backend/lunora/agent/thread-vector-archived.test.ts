/**
 * The `archived` flag on thread vectors: the sync an archive or restore schedules, the commit's
 * correction, and the per-shard backfill that pages through older vectors and resumes from its place.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runInShard } from "../lib/shard-context";
import schema from "../schema";
import { commitThreadSearch } from "./thread-search";
import {
    BACKFILL_PAGE,
    BACKFILL_SCOPE,
    backfillThreadVectorArchived,
    parseBackfillPlace,
    sweepThreadVectorArchived,
    syncThreadVectorArchived,
} from "./thread-vector-archived";

const OWNER = "owner-archived";
const OTHER = "someone-else";
const VECTOR = Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0));

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const run = async <T>(callback: (ctx: any) => Promise<T>): Promise<T> => await runInShard(OWNER, async () => await harness.run(callback));

const insertThread = async (ctx: any, status: string, userId = OWNER) => await ctx.db.insert("threads", { status, title: "Invoice bug", userId });

const insertVector = async (ctx: any, threadId: string, fields: Record<string, unknown> = {}) =>
    await ctx.db.insert("embeddings_1024", { model: "bge-m3", table: "threadTitle", threadId, userId: OWNER, vector: VECTOR, ...fields });

/** The vector row's `archived`, or `undefined` for a row without it. */
const flagOf = async (ctx: any, id: string): Promise<boolean | undefined> => {
    const row = await ctx.db.get("embeddings_1024", id);

    return row?.archived;
};

describe("syncThreadVectorArchived", () => {
    it("sets the flag on archive and clears it on restore", async () => {
        const flags = await run(async (ctx) => {
            const threadId = await insertThread(ctx, "active");
            const title = await insertVector(ctx, threadId, { archived: false });
            const summary = await insertVector(ctx, threadId, { archived: false, table: "threadSummary" });

            await ctx.db.patch("threads", threadId, { status: "archived", summaryVectorId: summary, titleVectorId: title });
            await ctx.runMutation(syncThreadVectorArchived, { threadId });
            const archived = [await flagOf(ctx, title), await flagOf(ctx, summary)];

            await ctx.db.patch("threads", threadId, { status: "active" });
            await ctx.runMutation(syncThreadVectorArchived, { threadId });
            // A retry after it ran is a no-op.
            await ctx.runMutation(syncThreadVectorArchived, { threadId });

            return { archived, restored: await flagOf(ctx, title) };
        });

        expect(flags).toStrictEqual({ archived: [true, true], restored: false });
    });

    it("never writes a vector that belongs to another owner or another thread", async () => {
        const flags = await run(async (ctx) => {
            const threadId = await insertThread(ctx, "archived");
            const otherThread = await insertThread(ctx, "active");
            const foreign = await insertVector(ctx, threadId, { archived: false, userId: OTHER });
            const elsewhere = await insertVector(ctx, otherThread, { archived: false });

            await ctx.db.patch("threads", threadId, { summaryVectorId: elsewhere, titleVectorId: foreign });
            await ctx.runMutation(syncThreadVectorArchived, { threadId });

            return [await flagOf(ctx, foreign), await flagOf(ctx, elsewhere)];
        });

        expect(flags).toStrictEqual([false, false]);
    });
});

describe("commitThreadSearch", () => {
    it("corrects the flag the insert wrote when the thread was archived during the embed", async () => {
        const archived = await run(async (ctx) => {
            const threadId = await insertThread(ctx, "archived");

            await ctx.db.patch("threads", threadId, { userTurnCount: 5 });
            const vectorId = await insertVector(ctx, threadId, { archived: false });

            await ctx.runMutation(commitThreadSearch, { clear: [], embedded: [{ kind: "title", text: "Invoice bug", vectorId }], threadId });

            return await flagOf(ctx, vectorId);
        });

        expect(archived).toBe(true);
    });
});

describe("the backfill", () => {
    const claim = async () =>
        await run(
            async (ctx) =>
                await ctx.db
                    .query("idempotencyClaims")
                    .withIndex("by_scope_key", (q: any) => q.eq("scope", BACKFILL_SCOPE).eq("key", OWNER))
                    .first(),
        );

    /** Runs the steps the sweep and each step would schedule, until the walk records `done`; returns how many ran. */
    const drive = async (): Promise<number> => {
        let steps = 0;

        for (let row = await claim(); row?.result !== "done"; row = await claim()) {
            const place = parseBackfillPlace(row.result);

            await run(async (ctx) => await ctx.runMutation(backfillThreadVectorArchived, { claimedAt: row.claimedAt, ...place }));
            steps += 1;
            expect(steps).toBeLessThan(20);
        }

        return steps;
    };

    it("pages through every older thread vector, sets each thread's flag, and leaves a deleted thread's vector alone", async () => {
        const ids = await run(async (ctx) => {
            const archivedThread = await insertThread(ctx, "archived");
            const activeThread = await insertThread(ctx, "active");
            const archivedVectors: string[] = [];

            // More than one page of one kind.
            for (let index = 0; index < BACKFILL_PAGE + 5; index += 1) {
                archivedVectors.push(await insertVector(ctx, archivedThread));
            }

            const regular = await insertVector(ctx, activeThread, { table: "threadSummary" });
            const deletedThread = await insertThread(ctx, "archived");
            const orphan = await insertVector(ctx, deletedThread);

            await ctx.db.delete("threads", deletedThread);

            return { archivedVectors, orphan, regular };
        });

        await run(async (ctx) => await ctx.runMutation(sweepThreadVectorArchived, {}));
        const steps = await drive();

        const rows = await run(async (ctx) => {
            return {
                archived: await Promise.all(ids.archivedVectors.map(async (id) => await flagOf(ctx, id))),
                orphan: await flagOf(ctx, ids.orphan),
                regular: await flagOf(ctx, ids.regular),
            };
        });

        // Two title pages (the second ends the kind), one summary page.
        expect(steps).toBe(3);
        expect(rows.archived.every((flag) => flag === true)).toBe(true);
        expect(rows.regular).toBe(false);
        // Not resurrected or rewritten: the delete's cleanup removes it.
        expect(rows.orphan).toBeUndefined();

        // A finished walk is not started again.
        await run(async (ctx) => await ctx.runMutation(sweepThreadVectorArchived, {}));
        const finished = await claim();

        expect(finished?.result).toBe("done");
    });

    it("resumes from its saved place when its step chain died, and a stale chain stops", async () => {
        await run(async (ctx) => {
            const threadId = await insertThread(ctx, "archived");

            for (let index = 0; index < BACKFILL_PAGE + 1; index += 1) {
                await insertVector(ctx, threadId);
            }
        });

        await run(async (ctx) => await ctx.runMutation(sweepThreadVectorArchived, {}));
        const first = await claim();

        await run(async (ctx) => await ctx.runMutation(backfillThreadVectorArchived, { claimedAt: first.claimedAt, ...parseBackfillPlace(first.result) }));
        const afterFirstStep = await claim();
        const saved = parseBackfillPlace(afterFirstStep.result);

        expect(saved.kind).toBe("title");
        expect(saved.cursor).toBeDefined();

        // The chain died: its lease lapses, and the next sweep takes the walk over from the saved place.
        await run(async (ctx) => await ctx.db.patch("idempotencyClaims", first._id, { expiresAt: Date.now() - 1 }));
        await run(async (ctx) => await ctx.runMutation(sweepThreadVectorArchived, {}));
        const resumed = await claim();

        expect(resumed.claimedAt).not.toBe(first.claimedAt);
        expect(parseBackfillPlace(resumed.result)).toStrictEqual(saved);

        // The dead chain's next step, delivered late, does nothing.
        await run(async (ctx) => await ctx.runMutation(backfillThreadVectorArchived, { claimedAt: first.claimedAt, ...saved }));
        const afterLateStep = await claim();

        expect(afterLateStep.claimedAt).toBe(resumed.claimedAt);
        expect(parseBackfillPlace(afterLateStep.result)).toStrictEqual(saved);

        expect(await drive()).toBe(2);
    });
});
