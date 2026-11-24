/**
 * The `archived` flag on thread vectors: the sync an archive or restore schedules, the commit's
 * correction, and the per-shard backfill that pages through older vectors and resumes from its place.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import { purgeExpiredClaims } from "../lib/claim-once";
import { currentShard, runInShard } from "../lib/shard-context";
import schema from "../schema";
import { BACKFILL_ASK_INTERVAL_MS, BACKFILL_ASKED_MAX, backfillAsksRemembered, commitThreadSearch, searchThreadsByMeaningFor } from "./thread-search";
import {
    BACKFILL_LEASE_MS,
    BACKFILL_PAGE,
    BACKFILL_SCOPE,
    backfillThreadVectorArchived,
    parseBackfillPlace,
    sweepThreadVectorArchived,
    syncThreadVectorArchived,
} from "./thread-vector-archived";

// `callOnShard` is a Durable Object request: here it runs the call on the test database as code serving the named shard.
const routed = vi.hoisted(() => {
    return { calls: [] as string[], run: async (_shardKey: string, _ref: unknown): Promise<unknown> => null };
});

vi.mock("../lib/cross-shard", () => {
    return {
        callOnShard: async (ref: unknown, _args: unknown, options?: { shardKey?: string }) => {
            routed.calls.push(options?.shardKey ?? "");

            return await routed.run(options?.shardKey ?? "", ref);
        },
    };
});

const OWNER = "owner-archived";
const OTHER = "someone-else";
const VECTOR = Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0));

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
    routed.calls = [];
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
    // Each thread starts in its final state: the harness gives triggers no scheduler, and the archive trigger's schedule
    // now fails the write it rides on (`thread-search-triggers.test.ts` covers that schedule).
    it.each([
        ["archive", "archived", false, true],
        ["restore", "active", true, false],
    ])("sets each vector's flag to the thread's state on %s, and a retry is a no-op", async (_name, status, before, after) => {
        const flags = await run(async (ctx) => {
            const threadId = await insertThread(ctx, status);
            const title = await insertVector(ctx, threadId, { archived: before });
            const summary = await insertVector(ctx, threadId, { archived: before, table: "threadSummary" });

            await ctx.db.patch("threads", threadId, { summaryVectorId: summary, titleVectorId: title });
            await ctx.runMutation(syncThreadVectorArchived, { threadId });
            await ctx.runMutation(syncThreadVectorArchived, { threadId });

            return [await flagOf(ctx, title), await flagOf(ctx, summary)];
        });

        expect(flags).toStrictEqual([after, after]);
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

    /** The saved place on the backfill's claim row. */
    const savedPlace = async () => {
        const row = await claim();

        return parseBackfillPlace(row?.result);
    };

    /** The step the saved place schedules next. */
    const stepArgs = (result: string | undefined) => {
        const { chain, cursor, kind } = parseBackfillPlace(result);

        return { chain: chain!, kind, ...(cursor !== undefined && { cursor }) };
    };

    /** Runs the steps the sweep and each step would schedule, until the walk records `done`; returns how many ran. */
    const drive = async (): Promise<number> => {
        let steps = 0;

        for (let row = await claim(); row?.result !== "done"; row = await claim()) {
            await run(async (ctx) => await ctx.runMutation(backfillThreadVectorArchived, stepArgs(row.result)));
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

    it("resumes from its saved place after the lease lapsed and the claim purge ran, and a stale chain stops", async () => {
        await run(async (ctx) => {
            const threadId = await insertThread(ctx, "archived");

            for (let index = 0; index < BACKFILL_PAGE + 1; index += 1) {
                await insertVector(ctx, threadId);
            }
        });

        vi.useFakeTimers({ now: new Date("2026-11-23T10:00:00Z"), toFake: ["Date"] });

        try {
            await run(async (ctx) => await ctx.runMutation(sweepThreadVectorArchived, {}));
            const first = await claim();
            const firstArgs = stepArgs(first.result);

            await run(async (ctx) => await ctx.runMutation(backfillThreadVectorArchived, firstArgs));
            const saved = await savedPlace();

            expect(saved.kind).toBe("title");
            expect(saved.cursor).toBeDefined();

            // The chain died before its next step; within its lease a sweep leaves it alone.
            await run(async (ctx) => await ctx.runMutation(sweepThreadVectorArchived, {}));
            const held = await savedPlace();

            expect(held.chain).toBe(firstArgs.chain);

            // Past the lease, housekeeping purges expired claims first: the place survives it, and the sweep resumes there.
            vi.setSystemTime(Date.now() + BACKFILL_LEASE_MS + 1);
            await run(async (ctx) => await ctx.runMutation(purgeExpiredClaims, {}));
            await run(async (ctx) => await ctx.runMutation(sweepThreadVectorArchived, {}));
            const resumed = await savedPlace();

            expect(resumed.chain).not.toBe(firstArgs.chain);
            expect({ cursor: resumed.cursor, kind: resumed.kind }).toStrictEqual({ cursor: saved.cursor, kind: saved.kind });

            // The dead chain's next step, delivered late, does nothing.
            await run(async (ctx) => await ctx.runMutation(backfillThreadVectorArchived, { chain: firstArgs.chain, cursor: saved.cursor, kind: saved.kind }));
            expect(await savedPlace()).toStrictEqual(resumed);
        } finally {
            vi.useRealTimers();
        }

        expect(await drive()).toBe(2);
    });

    it("ignores a redelivered earlier step of the live chain: no page replayed, place kept, no second successor", async () => {
        await run(async (ctx) => {
            const threadId = await insertThread(ctx, "archived");

            for (let index = 0; index < BACKFILL_PAGE * 2 + 1; index += 1) {
                await insertVector(ctx, threadId);
            }
        });

        vi.useFakeTimers({ now: new Date("2026-11-23T10:00:00Z"), toFake: ["Date"] });

        try {
            await run(async (ctx) => await ctx.runMutation(sweepThreadVectorArchived, {}));
            const started = await claim();
            const firstArgs = stepArgs(started.result);

            await run(async (ctx) => await ctx.runMutation(backfillThreadVectorArchived, firstArgs));
            const advanced = await claim();

            // A later delivery would save a fresh lease if it ran: the clock moves so a rewrite shows.
            vi.setSystemTime(Date.now() + 1000);
            await run(async (ctx) => await ctx.runMutation(backfillThreadVectorArchived, firstArgs));

            const afterRedelivery = await claim();

            expect(afterRedelivery.result).toBe(advanced.result);
        } finally {
            vi.useRealTimers();
        }

        // The walk still finishes from where it was: two more title pages, then summary.
        expect(await drive()).toBe(3);
    });
});

describe("the backfill and account deletion", () => {
    const claimRows = async () =>
        await run(
            async (ctx) =>
                await ctx.db
                    .query("idempotencyClaims")
                    .withIndex("by_scope_key", (q: any) => q.eq("scope", BACKFILL_SCOPE).eq("key", OWNER))
                    .collect(),
        );

    const requestDeletion = async (status: "completed" | "processing") =>
        await run(
            async (ctx) => await ctx.db.insert("gdprRequests", { requestedAt: 1, requestType: "deletion", status, userEmail: "a@example.com", userId: OWNER }),
        );

    const archivedThreadWithVector = async () =>
        await run(async (ctx) => {
            const threadId = await insertThread(ctx, "archived");

            return await insertVector(ctx, threadId, { archived: false });
        });

    it("a sweep queued before the deletion completed creates no claim row and writes no vector", async () => {
        const vectorId = await archivedThreadWithVector();

        await requestDeletion("completed");
        await run(async (ctx) => await ctx.runMutation(sweepThreadVectorArchived, {}));

        expect(await claimRows()).toStrictEqual([]);
        expect(await run(async (ctx) => await flagOf(ctx, vectorId))).toBe(false);
    });

    it("a step queued before the claim rows were drained recreates nothing", async () => {
        const vectorId = await archivedThreadWithVector();

        await run(async (ctx) => await ctx.runMutation(sweepThreadVectorArchived, {}));
        const [row] = await claimRows();
        const queued = parseBackfillPlace(row.result);

        // The deletion workflow drains the user's claim rows, then completes.
        await run(async (ctx) => await ctx.db.delete("idempotencyClaims", row._id));
        await requestDeletion("completed");
        await run(async (ctx) => await ctx.runMutation(backfillThreadVectorArchived, { chain: queued.chain!, kind: queued.kind }));

        expect(await claimRows()).toStrictEqual([]);
        expect(await run(async (ctx) => await flagOf(ctx, vectorId))).toBe(false);
    });

    it("a step running while the deletion is underway writes no vector and saves no place", async () => {
        const vectorId = await archivedThreadWithVector();

        await run(async (ctx) => await ctx.runMutation(sweepThreadVectorArchived, {}));
        const [before] = await claimRows();
        const queued = parseBackfillPlace(before.result);

        await requestDeletion("processing");
        await run(async (ctx) => await ctx.runMutation(backfillThreadVectorArchived, { chain: queued.chain!, kind: queued.kind }));

        const after = await claimRows();

        expect(after.map((row: { result?: string }) => row.result)).toStrictEqual([before.result]);
        expect(await run(async (ctx) => await flagOf(ctx, vectorId))).toBe(false);
    });
});

describe("the backfill a meaning search starts", () => {
    /** The sweep a reference names, run on the test database on whatever shard the caller serves. */
    const runSweep = async (ref: unknown): Promise<unknown> => {
        expect(ref).toBe(internal.agent.thread_vector_archived.sweepThreadVectorArchived);

        return await harness.run(async (ctx: any) => await ctx.runMutation(sweepThreadVectorArchived, {}));
    };

    beforeEach(() => {
        routed.run = async (shardKey, ref) => await runInShard(shardKey, async () => await runSweep(ref));
    });

    /** An action ctx whose own `runMutation` runs on the shard the action serves, as an RPC action's does. */
    const actionCtx = () => {
        return { runMutation: vi.fn(async (ref: unknown) => await runSweep(ref)) };
    };

    const claimKeys = async (): Promise<string[]> =>
        await harness.run(async (ctx: any) => {
            const rows = await ctx.db
                .query("idempotencyClaims")
                .withIndex("by_scope_key", (q: any) => q.eq("scope", BACKFILL_SCOPE))
                .collect();

            return rows.map((row: { key: string }) => row.key);
        });

    // A short query returns before the embed: the backfill start is all the search does.
    const search = async (ctx: ReturnType<typeof actionCtx>, userId: string) => await searchThreadsByMeaningFor(ctx as never, { query: "a", userId });

    it("starts the walk on the searching user's shard when the action runs outside any shard", async () => {
        const ctx = actionCtx();

        expect(currentShard()).toBeUndefined();
        expect(await search(ctx, "returning-outside")).toStrictEqual([]);

        expect(routed.calls).toStrictEqual(["returning-outside"]);
        expect(ctx.runMutation).not.toHaveBeenCalled();
        expect(await claimKeys()).toStrictEqual(["returning-outside"]);
    });

    it("starts the walk on the searching user's shard, not the shard the call landed on", async () => {
        const ctx = actionCtx();

        await runInShard(OTHER, async () => await search(ctx, "returning-elsewhere"));

        expect(routed.calls).toStrictEqual(["returning-elsewhere"]);
        expect(ctx.runMutation).not.toHaveBeenCalled();
        expect(await claimKeys()).toStrictEqual(["returning-elsewhere"]);
    });

    it("starts the walk in place when the action already runs on the user's shard", async () => {
        const ctx = actionCtx();

        await runInShard("returning-home", async () => await search(ctx, "returning-home"));

        expect(routed.calls).toStrictEqual([]);
        expect(ctx.runMutation).toHaveBeenCalledOnce();
        expect(await claimKeys()).toStrictEqual(["returning-home"]);
    });

    it("keeps its per-isolate throttle bounded: stale asks and, past the cap, the oldest are forgotten", async () => {
        routed.run = async () => null;
        vi.useFakeTimers({ now: new Date("2026-11-23T10:00:00Z"), toFake: ["Date"] });

        try {
            for (let index = 0; index < BACKFILL_ASKED_MAX + 50; index += 1) {
                await search(actionCtx(), `throttle-${String(index)}`);
            }

            expect(backfillAsksRemembered()).toBe(BACKFILL_ASKED_MAX);

            // The oldest was dropped for the cap, so it may ask again; the newest is still throttled.
            routed.calls = [];
            await search(actionCtx(), "throttle-0");
            await search(actionCtx(), `throttle-${String(BACKFILL_ASKED_MAX + 49)}`);
            expect(routed.calls).toStrictEqual(["throttle-0"]);

            // Past the interval, the next ask clears every stale one.
            vi.setSystemTime(Date.now() + BACKFILL_ASK_INTERVAL_MS);
            await search(actionCtx(), "throttle-late");
            expect(backfillAsksRemembered()).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
