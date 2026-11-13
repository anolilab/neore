/**
 * The usage tables' erasure, cleanup and sweep against the in-memory harness. Rows are inserted directly: the export's writers are
 * not part of this change, so each test states the rows an export would have left behind.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchDueShards } from "../lib/shard-housekeeping";
import { backfillUsageExportRunDeleteAt } from "../migrations";
import schema from "../schema";
import {
    clearUsageExportPieces,
    EXPORT_PIECE_BATCH,
    EXPORT_PIECE_TTL_MS,
    LIVE_RECHECK_MS,
    rearmLiveUsageRun,
    eraseUsageForUser,
    keyedUsageRuns,
    purgeObject,
    releaseUsageKey,
    sweepUsageExportPieces,
} from "./gdpr";

/** Object keys the purges were scheduled for, and the shards the scheduler was asked to run a tick on, captured in place of the scheduler. */
const scheduled = vi.hoisted(() => {
    return { keys: [] as string[], shards: [] as string[] };
});

vi.mock("../lib/shard-scheduler", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/shard-scheduler")>()),
        runAfterOnShard: async (_scheduler: unknown, _delay: number, _target: unknown, args: Record<string, unknown>, shardKey: string) => {
            if (typeof args["key"] === "string") {
                scheduled.keys.push(args["key"]);
            }

            scheduled.shards.push(shardKey);

            return null;
        },
    };
});

type Harness = ReturnType<typeof lunoraTest>;

const A = "user-a";
const B = "user-b";

let harness: Harness;

const usageRow = (userId: string, date: string, index = 0) => {
    return { costMicrodollars: 10, date, replies: 1, skillKey: `s${String(index)}`, tokens: 5, updatedAt: 0, userId };
};

const piece = (requestId: string, userId: string, seq = 0) => {
    return { bytes: 1, closedRows: 0, createdAt: 1, kind: "rows", pass: 1, payload: "[]", projectIds: [], requestId, rowCount: 0, seq, userId };
};

/** How many rows of a table the user has, read the way the sweep reads them: one page, enough for these tests. */
const countOf = async (table: string, userId: string): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db[table].findMany({ limit: 1000, where: { userId } });

        return page.length;
    });

/** The due time the user's shard is armed for in the census, read as the root tick reads it. */
const dueAtOf = async (userId: string): Promise<number | undefined> =>
    await harness.run(async (ctx: any) => {
        const row = await ctx.db.shardActivity.findFirst({ where: { shardKey: userId } });

        return row?.nextDueAt;
    });

/** Every keyed run of the user, read page by page as the erasure's purge reads them. */
const keyedRunsOf = async (userId: string): Promise<{ key?: string; live: boolean; runId: string }[]> => {
    const keyed: { key?: string; live: boolean; runId: string }[] = [];
    let cursor: string | null = null;

    do {
        const page: { cursor: string | null; keyed: { key?: string; live: boolean; runId: string }[] } = await harness.run(
            async (ctx: any) => await ctx.runQuery(keyedUsageRuns, { cursor, userId }),
        );

        keyed.push(...page.keyed);
        cursor = page.cursor;
    } while (cursor !== null);

    return keyed;
};

/** Erases the user the way the workflow drains the erasure: each batch's run cursor is where the next batch's scan starts. */
const eraseAll = async (userId: string): Promise<void> => {
    let runCursor: string | null = null;
    let more = true;

    while (more) {
        const erased: { hasMore: boolean; runCursor: string | null } = await harness.run(async (ctx: any) => await eraseUsageForUser(ctx, userId, runCursor));

        more = erased.hasMore;
        runCursor = erased.runCursor;
    }
};

beforeEach(() => {
    // The sweep's 24-hour boundary is measured from the clock: it is pinned for each test, so the fixtures cannot drift between calls.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T12:00:00.000Z"));
    harness = lunoraTest(schema as never);
    scheduled.keys = [];
    scheduled.shards = [];
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

describe("eraseUsageForUser", () => {
    it("erases the user's rollup and export rows across batches, and leaves another user's", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 25; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, "2026-02-01", index));
                await ctx.db.insert("usageExportProjects", { pass: 1, projectId: `p${String(index)}`, requestId: "gone:1", userId: A });
            }

            await ctx.db.insert("usageExportPieces", piece("gone:1", A));
            await ctx.db.insert("usageExportRuns", { createdAt: 1, deleteAt: 0, requestId: "gone:1", userId: A });
            await ctx.db.insert("usageDaily", usageRow(B, "2026-02-01"));
            await ctx.db.insert("usageExportPieces", piece("kept:1", B));
        });

        await eraseAll(A);

        expect(await countOf("usageDaily", A)).toBe(0);
        expect(await countOf("usageExportProjects", A)).toBe(0);
        expect(await countOf("usageExportPieces", A)).toBe(0);
        expect(await countOf("usageExportRuns", A)).toBe(0);
        expect(await countOf("usageDaily", B)).toBe(1);
        expect(await countOf("usageExportPieces", B)).toBe(1);
    });

    it("fails when a delete fails, so the erasure step fails, and its retry finishes what the failed attempt left", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageExportPieces", piece("retry:1", A));
            await ctx.db.insert("usageDaily", usageRow(A, "2026-11-01"));
        });

        // The first delete the erasure makes throws; every later one goes through.
        let failures = 1;

        await harness.run(async (ctx: any) => {
            const flakyDb = new Proxy(ctx.db, {
                get: (target, prop) => {
                    const value = Reflect.get(target, prop, target);

                    if (prop !== "delete") {
                        return typeof value === "function" ? value.bind(target) : value;
                    }

                    return async (...args: unknown[]) => {
                        if (failures > 0) {
                            failures -= 1;

                            throw new Error("delete failed");
                        }

                        return await value.apply(target, args);
                    };
                },
            });
            const flaky = Object.create(ctx, { db: { value: flakyDb } });

            await expect(eraseUsageForUser(flaky, A)).rejects.toThrow("delete failed");
        });

        expect(failures).toBe(0);

        await eraseAll(A);

        expect(await countOf("usageExportPieces", A)).toBe(0);
        expect(await countOf("usageDaily", A)).toBe(0);
    });
});

describe("the purge's object steps", () => {
    it("keeps the run's record when the object's delete fails, and releases it only once a retry has deleted the object", async () => {
        const release = vi.fn(async () => null);
        let deleteFails = true;
        const storage = {
            delete: async () => {
                if (deleteFails) {
                    throw new Error("storage down");
                }

                return null;
            },
            getMetadata: async () => {
                return { size: 1 };
            },
        };

        await expect(purgeObject(storage, "gdpr-exports/failing.json", release)).rejects.toThrow("storage down");
        expect(release).not.toHaveBeenCalled();

        deleteFails = false;

        await purgeObject(storage, "gdpr-exports/failing.json", release);
        expect(release).toHaveBeenCalledTimes(1);
    });
});

describe("erasure of the run scan", () => {
    it("reaches an unkeyed run behind more than 500 keyed runs, scanning in batches", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 510; index += 1) {
                await ctx.db.insert("usageExportRuns", {
                    createdAt: 1,
                    deleteAt: 0,
                    requestId: `many:${String(index)}`,
                    usageKey: `gdpr-exports/many-${String(index)}.json`,
                    userId: A,
                });
            }

            await ctx.db.insert("usageExportRuns", { createdAt: 2, deleteAt: 0, requestId: "last:1", userId: A });
        });

        await eraseAll(A);

        expect(await countOf("usageExportRuns", A)).toBe(510);
        expect(await keyedRunsOf(A)).toHaveLength(510);
    });
});

describe("the purge's record", () => {
    it("keeps a keyed run's row while it holds a piece or an index row, and removes it once neither is left", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageExportRuns", { createdAt: 1, deleteAt: 0, requestId: "rel:1", usageKey: "gdpr-exports/rel-1.json", userId: A });
            await ctx.db.insert("usageExportPieces", piece("rel:1", A));
            await ctx.db.insert("usageExportProjects", { pass: 1, projectId: "p1", requestId: "rel:1", userId: A });
        });

        const [keyed] = await keyedRunsOf(A);

        expect(keyed).toMatchObject({ key: "gdpr-exports/rel-1.json", live: false });

        // The object is gone (the purge deleted it); the record stays while a piece or an index row names the run.
        await harness.run(async (ctx: any) => await ctx.runMutation(releaseUsageKey, { runId: keyed!.runId }));

        expect(await countOf("usageExportRuns", A)).toBe(1);
        expect(await keyedRunsOf(A)).toEqual([]);

        await harness.run(async (ctx: any) => {
            const pieceRow = await ctx.db.usageExportPieces.findFirst({ where: { requestId: "rel:1" } });
            const projectRow = await ctx.db.usageExportProjects.findFirst({ where: { requestId: "rel:1" } });

            await ctx.db.delete("usageExportPieces", pieceRow._id);
            await ctx.db.delete("usageExportProjects", projectRow._id);
        });

        // Nothing is left for the run: releasing again removes its row.
        const runId = await harness.run(async (ctx: any) => {
            const runRow = await ctx.db.usageExportRuns.findFirst({ where: { requestId: "rel:1" } });

            return runRow._id;
        });

        await harness.run(async (ctx: any) => await ctx.runMutation(releaseUsageKey, { runId }));

        expect(await countOf("usageExportRuns", A)).toBe(0);
    });

    it("lists a live run that has no object yet, so the purge waits for its export to end", async () => {
        const request = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("gdprRequests", { requestedAt: 1, requestType: "export", status: "processing", userEmail: "a@example.com", userId: A }),
        );

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageExportRuns", { createdAt: 1, deleteAt: 0, requestId: `${request}:1`, userId: A });
            await ctx.db.insert("usageExportRuns", { createdAt: 2, deleteAt: 0, requestId: "plain:dead", userId: A });
        });

        // The dead unkeyed run is not listed: erasure removes it. The live one is, with no key.
        const listed = await keyedRunsOf(A);

        expect(listed).toEqual([{ key: undefined, live: true, runId: expect.any(String) }]);
    });

    it("finds keyed runs past a page of unkeyed ones, so erasure reaches every stored object", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 25; index += 1) {
                await ctx.db.insert("usageExportRuns", { createdAt: 1, deleteAt: 0, requestId: `plain:${String(index)}`, userId: A });
            }

            await ctx.db.insert("usageExportRuns", { createdAt: 2, deleteAt: 0, requestId: "keyed:1", usageKey: "gdpr-exports/keyed-1.json", userId: A });
        });

        expect(await keyedRunsOf(A)).toEqual([{ key: "gdpr-exports/keyed-1.json", live: false, runId: expect.any(String) }]);
    });

    it("reports a run whose export is still processing as live, so its record stays until the export ends", async () => {
        const request = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("gdprRequests", {
                    requestedAt: 1,
                    requestType: "export",
                    status: "processing",
                    userEmail: "a@example.com",
                    userId: A,
                }),
        );

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageExportRuns", { createdAt: 1, deleteAt: 0, requestId: `${request}:1`, usageKey: "gdpr-exports/live-1.json", userId: A });
        });

        expect(await keyedRunsOf(A)).toEqual([{ key: "gdpr-exports/live-1.json", live: true, runId: expect.any(String) }]);
    });
});

describe("a retried erasure", () => {
    it("does not repeat the deletes of an erasure that finished", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 3; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, "2026-02-01", index));
            }

            await ctx.db.insert("usageExportPieces", piece("done:1", A));
            await ctx.db.insert("usageExportRuns", { createdAt: 1, deleteAt: 0, requestId: "done:1", userId: A });
        });

        await eraseAll(A);

        const retry = await harness.run(async (ctx: any) => {
            let deletes = 0;
            const remove = ctx.db.delete.bind(ctx.db);

            ctx.db.delete = async (...args: unknown[]) => {
                deletes += 1;

                return await remove(...args);
            };

            const result = await eraseUsageForUser(ctx, A);

            return { deletes, hasMore: result.hasMore };
        });

        expect(retry).toEqual({ deletes: 0, hasMore: false });
    });
});

describe("the sweep and the clear", () => {
    it("sweeps a run stored without a due time once the backfill has given it one, at a time a time to live after its creation", async () => {
        const t0 = Date.now();
        const up = backfillUsageExportRunDeleteAt.up as (document: Record<string, unknown>) => Record<string, unknown> | undefined;

        await harness.run(async (ctx: any) => {
            const dead = await ctx.db.insert("gdprRequests", {
                requestedAt: 1,
                requestType: "export",
                status: "failed",
                userEmail: "a@example.com",
                userId: A,
            });
            const legacy = up({ _id: "legacy", createdAt: t0, requestId: `${dead}:1`, userId: A });

            await ctx.db.insert("usageExportRuns", legacy);
            await ctx.db.insert("usageExportPieces", { ...piece(`${dead}:1`, A), createdAt: t0 });
        });

        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));
        expect(await countOf("usageExportPieces", A)).toBe(1);

        vi.setSystemTime(new Date(t0 + EXPORT_PIECE_TTL_MS));
        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));
        expect(await countOf("usageExportPieces", A)).toBe(0);
    });

    it("removes a dead run's pieces at the time its last live sweep set, and not before", async () => {
        const t0 = Date.now();
        const setAt = t0 + EXPORT_PIECE_TTL_MS;

        await harness.run(async (ctx: any) => {
            const dead = await ctx.db.insert("gdprRequests", {
                requestedAt: 1,
                requestType: "export",
                status: "failed",
                userEmail: "a@example.com",
                userId: A,
            });

            await ctx.db.insert("usageExportRuns", { createdAt: t0, deleteAt: setAt, requestId: `${dead}:1`, userId: A });
            await ctx.db.insert("usageExportPieces", { ...piece(`${dead}:1`, A), createdAt: t0 });
        });

        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));
        expect(await countOf("usageExportPieces", A)).toBe(1);

        vi.setSystemTime(new Date(setAt));
        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));
        expect(await countOf("usageExportPieces", A)).toBe(0);
    });

    it("keeps a live run's pieces, and sets its time one time to live ahead", async () => {
        const t0 = Date.now();

        await harness.run(async (ctx: any) => {
            const live = await ctx.db.insert("gdprRequests", {
                requestedAt: 1,
                requestType: "export",
                status: "processing",
                userEmail: "a@example.com",
                userId: A,
            });

            await ctx.db.insert("usageExportRuns", { createdAt: t0, deleteAt: t0, requestId: `${live}:1`, userId: A });
            await ctx.db.insert("usageExportPieces", { ...piece(`${live}:1`, A), createdAt: t0 });
        });

        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));

        expect(await countOf("usageExportPieces", A)).toBe(1);

        const run = await harness.run(async (ctx: any) => await ctx.db.usageExportRuns.findFirst({ where: { userId: A } }));

        expect(run?.deleteAt).toBe(t0 + EXPORT_PIECE_TTL_MS);
    });

    it("re-arms a live run for a check a minute on and keeps its record, so a late object is purged soon after its export ends", async () => {
        const t0 = Date.now();
        const request = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("gdprRequests", { requestedAt: 1, requestType: "export", status: "processing", userEmail: "a@example.com", userId: A }),
        );

        const runId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("usageExportRuns", { createdAt: t0, deleteAt: t0 + EXPORT_PIECE_TTL_MS, requestId: `${request}:1`, userId: A }),
        );

        await harness.run(async (ctx: any) => await ctx.runMutation(rearmLiveUsageRun, { runId, userId: A }));

        expect(await dueAtOf(A)).toBe(Date.now() + LIVE_RECHECK_MS);
        const run = await harness.run(async (ctx: any) => await ctx.db.usageExportRuns.findFirst({ where: { _id: runId } }));

        expect(run).toMatchObject({ erasing: true });

        // The sweep finds the still-live run marked `erasing` and keeps checking it a minute apart, not a time to live apart.
        vi.setSystemTime(Date.now() + LIVE_RECHECK_MS);
        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));
        const after = await harness.run(async (ctx: any) => await ctx.db.usageExportRuns.findFirst({ where: { _id: runId } }));

        expect(after?.deleteAt).toBe(Date.now() + LIVE_RECHECK_MS);
    });

    it("reads at most one batch of pieces per sweep, however many dead runs are due, and finishes them over later sweeps", async () => {
        const old = Date.now() - EXPORT_PIECE_TTL_MS - 60_000;

        await harness.run(async (ctx: any) => {
            for (let run = 0; run < 3; run += 1) {
                await ctx.db.insert("usageExportRuns", { createdAt: old, deleteAt: old, requestId: `budget:${String(run)}`, userId: A });

                for (let seq = 0; seq < EXPORT_PIECE_BATCH; seq += 1) {
                    await ctx.db.insert("usageExportPieces", { ...piece(`budget:${String(run)}`, A, seq), createdAt: old });
                }
            }
        });

        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));
        expect(await countOf("usageExportPieces", A)).toBe(2 * EXPORT_PIECE_BATCH);

        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));
        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));
        expect(await countOf("usageExportPieces", A)).toBe(0);
    });

    it("keeps a live run without a key when erasure reaches it, so the sweep removes it once its export has ended", async () => {
        const request = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("gdprRequests", { requestedAt: 1, requestType: "export", status: "processing", userEmail: "a@example.com", userId: A }),
        );

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageExportRuns", { createdAt: 1, deleteAt: 0, requestId: `${request}:1`, userId: A });
        });

        await eraseAll(A);
        expect(await countOf("usageExportRuns", A)).toBe(1);

        await harness.run(async (ctx: any) => await ctx.db.patch("gdprRequests", request, { status: "failed" }));
        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));
        expect(await countOf("usageExportRuns", A)).toBe(0);
    });

    it("removes a live export's pieces in erasure, and keeps its keyed record for the purge to wait on", async () => {
        const request = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("gdprRequests", { requestedAt: 1, requestType: "export", status: "processing", userEmail: "a@example.com", userId: A }),
        );

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageExportRuns", {
                createdAt: 1,
                deleteAt: 0,
                requestId: `${request}:1`,
                usageKey: "gdpr-exports/live-keyed.json",
                userId: A,
            });
            await ctx.db.insert("usageExportPieces", piece(`${request}:1`, A));
        });

        await eraseAll(A);

        expect(await countOf("usageExportPieces", A)).toBe(0);
        expect(await keyedRunsOf(A)).toEqual([{ key: "gdpr-exports/live-keyed.json", live: true, runId: expect.any(String) }]);
    });

    it("arms an idle shard for the time its live run is due again, so the root tick dispatches it then without any traffic", async () => {
        const t0 = Date.now();

        await harness.run(async (ctx: any) => {
            const live = await ctx.db.insert("gdprRequests", {
                requestedAt: 1,
                requestType: "export",
                status: "processing",
                userEmail: "a@example.com",
                userId: A,
            });

            await ctx.db.insert("usageExportRuns", { createdAt: t0, deleteAt: t0, requestId: `${live}:1`, userId: A });
        });

        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));

        // The real census write: the user's shard is armed for the run's next due time.
        expect(await dueAtOf(A)).toBe(t0 + EXPORT_PIECE_TTL_MS);

        // Before that time the root tick dispatches nothing; at that time it dispatches the user's shard.
        await harness.run(async (ctx: any) => await ctx.runMutation(dispatchDueShards, {}));
        expect(scheduled.shards).toEqual([]);

        vi.setSystemTime(t0 + EXPORT_PIECE_TTL_MS);
        await harness.run(async (ctx: any) => await ctx.runMutation(dispatchDueShards, {}));
        expect(scheduled.shards).toEqual([A]);
    });

    it("schedules a keyed run's purge once, when its pieces are drained, not on each pass that clears some of them", async () => {
        const old = Date.now() - EXPORT_PIECE_TTL_MS - 60_000;

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageExportRuns", {
                createdAt: old,
                deleteAt: old,
                requestId: "many:1",
                usageKey: "gdpr-exports/many-pieces.json",
                userId: A,
            });

            for (let index = 0; index < 25; index += 1) {
                await ctx.db.insert("usageExportPieces", piece("many:1", A, index));
            }
        });

        // Two full passes of ten pieces each leave the run due again at once, and no purge is queued while pieces remain.
        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));
        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));
        expect(scheduled.keys).toEqual([]);

        // The last five drain the run: its purge is queued exactly once.
        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));

        expect(await countOf("usageExportPieces", A)).toBe(0);
        expect(scheduled.keys).toEqual(["gdpr-exports/many-pieces.json"]);
    });

    it("does not let a keyed run whose purge keeps failing block the expired runs behind it", async () => {
        const old = Date.now() - EXPORT_PIECE_TTL_MS - 60_000;

        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 10; index += 1) {
                await ctx.db.insert("usageExportRuns", {
                    createdAt: old,
                    deleteAt: old,
                    requestId: `stuck:${String(index)}`,
                    usageKey: `gdpr-exports/stuck-${String(index)}.json`,
                    userId: A,
                });
            }

            await ctx.db.insert("usageExportRuns", { createdAt: old + 1, deleteAt: old + 1, requestId: "expired:1", userId: A });
            await ctx.db.insert("usageExportPieces", { ...piece("expired:1", A), createdAt: old });
        });

        // The first sweep handles the ten keyed runs, and moves them out of the window.
        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));
        expect(scheduled.keys).toHaveLength(10);
        expect(await countOf("usageExportPieces", A)).toBe(1);

        // The second sweep reaches the expired run behind them.
        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));
        expect(await countOf("usageExportPieces", A)).toBe(0);
        expect(scheduled.keys).toHaveLength(10);
    });

    it("accepts a composite run id longer than a single id, as an export run's id is", async () => {
        const longRequestId = `${"r".repeat(120)}:${"i".repeat(60)}`;

        const result = await harness.run(async (ctx: any) => await ctx.runMutation(clearUsageExportPieces, { requestId: longRequestId, userId: A }));

        expect(result).toEqual({ hasMore: false });
    });
    it("removes a dead run's pieces and index rows, schedules its purge, and leaves a live run alone", async () => {
        const old = Date.now() - EXPORT_PIECE_TTL_MS - 60_000;
        const { dead, live } = await harness.run(async (ctx: any) => {
            const deadRequest = await ctx.db.insert("gdprRequests", {
                requestedAt: 1,
                requestType: "export",
                status: "failed",
                userEmail: "a@example.com",
                userId: A,
            });
            const liveRequest = await ctx.db.insert("gdprRequests", {
                requestedAt: 1,
                requestType: "export",
                status: "processing",
                userEmail: "a@example.com",
                userId: A,
            });

            await ctx.db.insert("usageExportRuns", {
                createdAt: old,
                deleteAt: old,
                requestId: `${deadRequest}:1`,
                usageKey: "gdpr-exports/dead-1.json",
                userId: A,
            });
            await ctx.db.insert("usageExportRuns", { createdAt: old, deleteAt: old, requestId: `${liveRequest}:1`, userId: A });
            await ctx.db.insert("usageExportPieces", { ...piece(`${deadRequest}:1`, A), createdAt: old });
            await ctx.db.insert("usageExportPieces", { ...piece(`${liveRequest}:1`, A), createdAt: old });
            await ctx.db.insert("usageExportProjects", { pass: 1, projectId: "p1", requestId: `${deadRequest}:1`, userId: A });

            return { dead: deadRequest, live: liveRequest };
        });

        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));

        expect(scheduled.keys).toEqual(["gdpr-exports/dead-1.json"]);

        const pieces = await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.usageExportPieces.findMany({ limit: 100, where: { userId: A } });

            return page.map((row: { requestId: string }) => row.requestId);
        });

        expect(pieces).toEqual([`${live}:1`]);
        expect(await countOf("usageExportProjects", A)).toBe(0);
        expect(dead).toBeDefined();
        expect(await countOf("usageExportRuns", A)).toBe(2);
    });

    it("reaches an expired run behind a full scan of live ones on a later sweep, instead of starving it", async () => {
        const old = Date.now() - EXPORT_PIECE_TTL_MS - 60_000;

        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 510; index += 1) {
                const request = await ctx.db.insert("gdprRequests", {
                    requestedAt: 1,
                    requestType: "export",
                    status: "processing",
                    userEmail: "a@example.com",
                    userId: A,
                });

                await ctx.db.insert("usageExportRuns", { createdAt: old, deleteAt: old, requestId: `${request}:1`, userId: A });
            }

            const dead = await ctx.db.insert("gdprRequests", {
                requestedAt: 1,
                requestType: "export",
                status: "failed",
                userEmail: "a@example.com",
                userId: A,
            });

            await ctx.db.insert("usageExportRuns", { createdAt: old + 1, deleteAt: old + 1, requestId: `${dead}:1`, userId: A });
            await ctx.db.insert("usageExportPieces", { ...piece(`${dead}:1`, A), createdAt: old });
        });

        // The first sweep reads the 500 live runs and moves them out of its window, so the expired run is not reached yet.
        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));
        expect(await countOf("usageExportPieces", A)).toBe(1);

        // The second sweep reads the 10 live runs left in the window, then the expired run, whose piece it removes.
        await harness.run(async (ctx: any) => await ctx.runMutation(sweepUsageExportPieces, {}));
        expect(await countOf("usageExportPieces", A)).toBe(0);
    });

    it("clears a run's pieces and index rows a batch at a time, and removes its row once none is left", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 12; index += 1) {
                await ctx.db.insert("usageExportPieces", piece("clr:1", A, index));
            }

            for (let index = 0; index < 3; index += 1) {
                await ctx.db.insert("usageExportProjects", { pass: 1, projectId: `p${String(index)}`, requestId: "clr:1", userId: A });
            }

            await ctx.db.insert("usageExportRuns", { createdAt: 1, deleteAt: 0, requestId: "clr:1", userId: A });
        });

        const first = await harness.run(async (ctx: any) => await ctx.runMutation(clearUsageExportPieces, { requestId: "clr:1", userId: A }));
        const second = await harness.run(async (ctx: any) => await ctx.runMutation(clearUsageExportPieces, { requestId: "clr:1", userId: A }));

        expect(first).toEqual({ hasMore: true });
        expect(second).toEqual({ hasMore: false });
        expect(await countOf("usageExportPieces", A)).toBe(0);
        expect(await countOf("usageExportProjects", A)).toBe(0);
        expect(await countOf("usageExportRuns", A)).toBe(0);
    });

    it("keeps a run's record when it holds a stored object, since that record is the object's only one", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageExportRuns", { createdAt: 1, deleteAt: 0, requestId: "clr:keyed", usageKey: "gdpr-exports/clr.json", userId: A });
        });

        await harness.run(async (ctx: any) => await ctx.runMutation(clearUsageExportPieces, { requestId: "clr:keyed", userId: A }));

        expect(await keyedRunsOf(A)).toEqual([{ key: "gdpr-exports/clr.json", live: false, runId: expect.any(String) }]);
    });
});
