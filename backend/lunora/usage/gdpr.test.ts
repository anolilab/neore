/**
 * The usage tables' erasure, cleanup and sweep against the in-memory harness. Rows are inserted directly: the export's writers are
 * not part of this change, so each test states the rows an export would have left behind.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import {
    clearUsageExportPieces,
    deletionUnderwayOnPrimary,
    EXPORT_PIECE_TTL_MS,
    eraseUsageForUser,
    keyedUsageRuns,
    releaseUsageKey,
    sweepUsageExportPieces,
} from "./gdpr";

/** Object keys the purges were scheduled for, captured in place of the scheduler. */
const scheduled = vi.hoisted(() => {
    return { keys: [] as string[] };
});

vi.mock("../lib/shard-scheduler", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/shard-scheduler")>()),
        runAfterOnShard: async (_scheduler: unknown, _delay: number, _target: unknown, args: Record<string, unknown>) => {
            if (typeof args["key"] === "string") {
                scheduled.keys.push(args["key"]);
            }

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
        const { page } = await ctx.db[table].findMany({ limit: 100, where: { userId } });

        return page.length;
    });

/** Every keyed run of the user, read page by page as the erasure's purge reads them. */
const keyedRunsOf = async (userId: string): Promise<{ key: string; live: boolean; runId: string }[]> => {
    const keyed: { key: string; live: boolean; runId: string }[] = [];
    let cursor: string | null = null;

    do {
        const page: { cursor: string | null; keyed: { key: string; live: boolean; runId: string }[] } = await harness.run(
            async (ctx: any) => await ctx.runQuery(keyedUsageRuns, { cursor, userId }),
        );

        keyed.push(...page.keyed);
        cursor = page.cursor;
    } while (cursor !== null);

    return keyed;
};

beforeEach(() => {
    harness = lunoraTest(schema as never);
    scheduled.keys = [];
});

afterEach(() => {
    harness.close();
});

describe("eraseUsageForUser", () => {
    it("erases the user's rollup and export rows across batches, and leaves another user's", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 25; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, "2026-02-01", index));
                await ctx.db.insert("usageExportProjects", { pass: 1, projectId: `p${String(index)}`, requestId: "gone:1", userId: A });
            }

            await ctx.db.insert("usageExportPieces", piece("gone:1", A));
            await ctx.db.insert("usageExportRuns", { createdAt: 1, requestId: "gone:1", userId: A });
            await ctx.db.insert("usageDaily", usageRow(B, "2026-02-01"));
            await ctx.db.insert("usageExportPieces", piece("kept:1", B));
        });

        let more = true;

        while (more) {
            more = await harness.run(async (ctx: any) => {
                const erased = await eraseUsageForUser(ctx, A);

                return erased.hasMore;
            });
        }

        expect(await countOf("usageDaily", A)).toBe(0);
        expect(await countOf("usageExportProjects", A)).toBe(0);
        expect(await countOf("usageExportPieces", A)).toBe(0);
        expect(await countOf("usageExportRuns", A)).toBe(0);
        expect(await countOf("usageDaily", B)).toBe(1);
        expect(await countOf("usageExportPieces", B)).toBe(1);
    });

    it("fails when a delete fails, so the erasure step fails and its retry finishes what is left", async () => {
        const failing = {
            db: {
                delete: async () => {
                    throw new Error("delete failed");
                },
                query: () => {
                    return {
                        withIndex: () => {
                            return { take: async () => [{ _id: "row-1" }] };
                        },
                    };
                },
                usageExportPieces: {
                    findMany: async () => {
                        return { page: [] };
                    },
                },
                usageExportProjects: {
                    findMany: async () => {
                        return { page: [] };
                    },
                },
                usageExportRuns: {
                    findMany: async () => {
                        return { page: [] };
                    },
                },
            },
        };

        await expect(eraseUsageForUser(failing as never, A)).rejects.toThrow("delete failed");
    });
});

describe("the purge's record", () => {
    it("keeps a keyed run's row while it holds a piece or an index row, and removes it once neither is left", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageExportRuns", { createdAt: 1, requestId: "rel:1", usageKey: "gdpr-exports/rel-1.json", userId: A });
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

    it("finds keyed runs past a page of unkeyed ones, so erasure reaches every stored object", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 25; index += 1) {
                await ctx.db.insert("usageExportRuns", { createdAt: 1, requestId: `plain:${String(index)}`, userId: A });
            }

            await ctx.db.insert("usageExportRuns", { createdAt: 2, requestId: "keyed:1", usageKey: "gdpr-exports/keyed-1.json", userId: A });
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
            await ctx.db.insert("usageExportRuns", { createdAt: 1, requestId: `${request}:1`, usageKey: "gdpr-exports/live-1.json", userId: A });
        });

        expect(await keyedRunsOf(A)).toEqual([{ key: "gdpr-exports/live-1.json", live: true, runId: expect.any(String) }]);
    });
});

describe("the deletion check", () => {
    it("counts a pending, processing or completed deletion as underway, and a failed or cancelled one as not", async () => {
        const underway = async (status: string) =>
            await harness.run(async (ctx: any) => {
                await ctx.db.insert("gdprRequests", { requestedAt: 1, requestType: "deletion", status, userEmail: "a@example.com", userId: status });

                return await deletionUnderwayOnPrimary(ctx, status);
            });

        expect(await underway("pending")).toBe(true);
        expect(await underway("processing")).toBe(true);
        expect(await underway("completed")).toBe(true);
        expect(await underway("failed")).toBe(false);
        expect(await underway("cancelled")).toBe(false);
    });
});

describe("the sweep and the clear", () => {
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

            await ctx.db.insert("usageExportRuns", { createdAt: old, requestId: `${deadRequest}:1`, usageKey: "gdpr-exports/dead-1.json", userId: A });
            await ctx.db.insert("usageExportRuns", { createdAt: old, requestId: `${liveRequest}:1`, userId: A });
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

                await ctx.db.insert("usageExportRuns", { createdAt: old, requestId: `${request}:1`, userId: A });
            }

            const dead = await ctx.db.insert("gdprRequests", {
                requestedAt: 1,
                requestType: "export",
                status: "failed",
                userEmail: "a@example.com",
                userId: A,
            });

            await ctx.db.insert("usageExportRuns", { createdAt: old + 1, requestId: `${dead}:1`, userId: A });
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

            await ctx.db.insert("usageExportRuns", { createdAt: 1, requestId: "clr:1", userId: A });
        });

        const first = await harness.run(async (ctx: any) => await ctx.runMutation(clearUsageExportPieces, { requestId: "clr:1", userId: A }));
        const second = await harness.run(async (ctx: any) => await ctx.runMutation(clearUsageExportPieces, { requestId: "clr:1", userId: A }));

        expect(first).toEqual({ hasMore: true });
        expect(second).toEqual({ hasMore: false });
        expect(await countOf("usageExportPieces", A)).toBe(0);
        expect(await countOf("usageExportProjects", A)).toBe(0);
        expect(await countOf("usageExportRuns", A)).toBe(0);
    });
});
