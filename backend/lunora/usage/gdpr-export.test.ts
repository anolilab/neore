/**
 * The usage export against the in-memory harness (erasure is in `gdpr.test.ts`). The export runs as the workflow runs it: pages and
 * title groups persisted as a run's pieces, a recount before the pass is kept, the pass read back by the usage action.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    assembleUsageExport,
    buildUsageJson,
    clearUsagePieces,
    collectUsageExport,
    spliceUsageJson,
    usageObjectKey,
    type UsageExportIo,
} from "../gdpr/usage-export-steps";
import schema from "../schema";
import { addDays } from "./activity-logic";
import { persistUsageTitles, stillMemberOf, verifyUsageTitles } from "./activity";
import { TITLE_PIECE_BYTES } from "./gdpr";
import {
    clearUsageExportPieces,
    confirmUsageFile,
    countUsageRowsPage,
    deletionUnderwayOnPrimary,
    keyedUsageRuns,
    persistUsageRowsPage,
    PROJECT_POSITION,
    recordUsageFile,
    readUsageExportPieces,
    releaseUsageKey,
    USAGE_EXPORT_BYTES,
    keepUsageFileRecord,
} from "./gdpr";

/** Object keys the export's purges were scheduled for, captured in place of the scheduler. */
const scheduled = vi.hoisted(() => {
    return { keys: [] as string[] };
});

vi.mock("../lib/shard-scheduler", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/shard-scheduler")>()),
        // A purge carries its object key: the test captures the key in place of the scheduler.
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

/** The pass a recount step belongs to, from its step name. */
const passOfCount = /usage-p(\d+)-count/;

const today = (): string => new Date().toISOString().slice(0, 10);

/** The day the boundary tests anchor their rows to, so a test's cutoff and late writes do not depend on the wall clock. */
const ANCHOR = "2026-02-01";

/** The workflow's steps for one export run, run directly: each call is one database call, as a durable step would make it. */
const exportIo = (requestId: string, userId: string, overrides: Partial<UsageExportIo> = {}): UsageExportIo => {
    const run = async (function_: unknown, args: unknown) => (await harness.run(async (ctx: any) => await ctx.runMutation(function_, args))) as never;

    return {
        clear: async () => await run(clearUsageExportPieces, { requestId, userId }),
        countRows: async (_name, page) =>
            (await harness.run(async (ctx: any) => await ctx.runQuery(countUsageRowsPage, { cursor: page.cursor, cutoff: page.cutoff, userId }))) as never,
        pause: async () => {},
        persistRows: async (_name, args) => await run(persistUsageRowsPage, { ...args, requestId, userId }),
        persistTitles: async (_name, args) => await run(persistUsageTitles, { ...args, requestId, userId }),
        step: async (_name, body) => await body(),
        verifyTitles: async (_name, args) => await run(verifyUsageTitles, { ...args, requestId, userId }),
        ...overrides,
    };
};

/** The usage JSON for one pass of a run, read back from its pieces with the memberships checked now, as the usage action does. */
const assemble = async (requestId: string, userId: string, pass: number) =>
    await assembleUsageExport(
        async (kind, cursor) =>
            (await harness.run(async (ctx: any) => await ctx.runQuery(readUsageExportPieces, { cursor, kind, pass, requestId, userId }))) as {
                cursor: string | null;
                payloads: string[];
            },
        async (organizationIds) => (await harness.run(async (ctx: any) => await ctx.runQuery(stillMemberOf, { organizationIds, userId }))) as string[],
    );

const pieceCount = async (userId: string): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.usageExportPieces.findMany({ where: { userId } });

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
    // The cutoff fixtures are dated from today, so the clock is pinned: a UTC midnight between two calls cannot move them.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T12:00:00.000Z"));
    harness = lunoraTest(schema as never);
    scheduled.keys = [];
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

describe("the usage export, as steps", () => {
    it("writes every page and title group, names the projects, and leaves out the other user's rows", async () => {
        const skillRows = 2101;
        const projects = 9;

        await harness.run(async (ctx: any) => {
            for (let index = 0; index < skillRows; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, "2026-02-01", index));
            }

            for (let index = 0; index < projects; index += 1) {
                const projectId = await ctx.db.insert("projects", { createdAt: 1, title: `Project ${String(index)}`, userId: A });

                await ctx.db.insert("usageDaily", { ...usageRow(A, "2026-02-02"), projectKey: projectId, skillKey: "__project__" });
            }

            // The other user's row has its own date, skill and cost, so it could not pass for one of the caller's.
            await ctx.db.insert("usageDaily", { ...usageRow(B, "2026-03-01"), costMicrodollars: 999, skillKey: "foreign-skill" });
        });

        const { pass } = await collectUsageExport(exportIo("r1", A));
        const { rows } = await assemble("r1", A, pass);
        const projectRows = rows.filter((row) => row.project !== undefined);

        expect(pass).toBe(1);
        expect(rows).toHaveLength(skillRows + projects);
        expect(projectRows).toHaveLength(projects);
        expect(new Set(projectRows.map((row) => row.projectTitle)).size).toBe(projects);
        expect(rows.some((row) => row.skill === "foreign-skill" || row.costMicrodollars === 999)).toBe(false);
    });

    it("finishes a page whose step failed after it was written, when the step is retried", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 1500; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, "2026-02-01", index));
            }
        });

        let failed = false;
        const io = exportIo("r1", A, {
            persistRows: async (name, args) => {
                const summary = await exportIo("r1", A).persistRows(name, args);

                // The step's result is lost after the write: the retry must find the page it wrote, not write it again.
                if (!failed && args.seq === 0) {
                    failed = true;
                    throw new Error("the result was lost");
                }

                return summary;
            },
            step: async (_name, body) => {
                try {
                    return await body();
                } catch {
                    return await body();
                }
            },
        });

        const { pass } = await collectUsageExport(io);
        const { rows } = await assemble("r1", A, pass);

        expect(failed).toBe(true);
        expect(rows).toHaveLength(1500);
    });

    it("redoes the pass when a historical row lands behind the cursor, and the file holds that row", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 1200; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, "2026-02-01", index));
            }
        });

        let inserted = false;
        const io = exportIo("r1", A, {
            persistRows: async (name, args) => {
                const summary = await exportIo("r1", A).persistRows(name, args);

                // A backfill writes an older day after the first page was read: behind the cursor, and before today.
                if (!inserted && args.pass === 1 && args.seq === 0) {
                    inserted = true;
                    await harness.run(async (ctx: any) => {
                        await ctx.db.insert("usageDaily", { ...usageRow(A, "2026-01-01", 99), skillKey: "backfilled" });
                    });
                }

                return summary;
            },
        });

        const { pass } = await collectUsageExport(io);
        const { rows } = await assemble("r1", A, pass);

        expect(inserted).toBe(true);
        expect(pass).toBe(2);
        expect(rows).toHaveLength(1201);
        expect(rows.some((row) => row.skill === "backfilled")).toBe(true);
    });

    it("keeps a busy user's export on its first pass: writes to yesterday's open rows do not change the recount", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 1200; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, today(), index));
            }
        });

        let written = false;
        const io = exportIo("r1", A, {
            persistRows: async (name, args) => {
                const summary = await exportIo("r1", A).persistRows(name, args);

                // The user keeps replying while the export runs: today's rows change or appear, after the first page.
                if (!written && args.seq === 0) {
                    written = true;
                    await harness.run(async (ctx: any) => {
                        await ctx.db.insert("usageDaily", { ...usageRow(A, addDays(today(), -1), 77), skillKey: "live-skill" });
                    });
                }

                return summary;
            },
        });

        const { pass } = await collectUsageExport(io);

        expect(written).toBe(true);
        expect(pass).toBe(1);
    });

    it("keeps two runs of one request apart: clearing one run leaves the other's pieces", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 5; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, "2026-02-01", index));
            }
        });

        const first = await collectUsageExport(exportIo("request-1:instance-1", A));
        const second = await collectUsageExport(exportIo("request-1:instance-2", A));

        await clearUsagePieces(exportIo("request-1:instance-1", A));

        const survivor = await assemble("request-1:instance-2", A, second.pass);

        expect(survivor.rows).toHaveLength(5);
        expect(first.pass).toBe(1);
    });

    it("drops a project's title once its member is revoked, in the next export", async () => {
        await harness.run(async (ctx: any) => {
            const project = await ctx.db.insert("projects", { createdAt: 1, organizationId: "org-1", title: "Shared", userId: B });

            await ctx.db.insert("member", { createdAt: 1, organizationId: "org-1", role: "member", userId: A });
            await ctx.db.insert("usageDaily", { ...usageRow(A, "2026-02-01"), projectKey: project, skillKey: "__project__" });
        });

        const first = await collectUsageExport(exportIo("r1", A));
        const firstRows = await assemble("r1", A, first.pass);
        const named = firstRows.rows.find((row) => row.project !== undefined);

        expect(named).toMatchObject({ projectTitle: "Shared" });

        await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.member.findMany({ where: { organizationId: "org-1", userId: A } });

            await ctx.db.delete("member", page[0]!._id);
        });

        const second = await collectUsageExport(exportIo("r2", A));
        const secondRows = await assemble("r2", A, second.pass);
        const unnamed = secondRows.rows.find((row) => row.project !== undefined);

        expect(unnamed).toBeDefined();
        expect(unnamed).not.toHaveProperty("projectTitle");
    });

    it("does not name a project whose membership was revoked after its title was read, before the file is built", async () => {
        await harness.run(async (ctx: any) => {
            const project = await ctx.db.insert("projects", { createdAt: 1, organizationId: "org-2", title: "Shared", userId: B });

            await ctx.db.insert("member", { createdAt: 1, organizationId: "org-2", role: "member", userId: A });
            await ctx.db.insert("usageDaily", { ...usageRow(A, "2026-02-01"), projectKey: project, skillKey: "__project__" });
        });

        let revoked = false;
        const base = exportIo("r3", A);
        const io: UsageExportIo = {
            ...base,
            verifyTitles: async (name, args) => {
                const step = await base.verifyTitles(name, args);

                // Revoked after the title was read, before the re-check and the file.
                if (!revoked) {
                    revoked = true;
                    await harness.run(async (ctx: any) => {
                        const { page } = await ctx.db.member.findMany({ where: { organizationId: "org-2", userId: A } });

                        await ctx.db.delete("member", page[0]!._id);
                    });
                }

                return step;
            },
        };

        const { pass } = await collectUsageExport(io);
        const afterRows = await assemble("r3", A, pass);
        const after = afterRows.rows.find((row) => row.project !== undefined);

        expect(after).toBeDefined();
        expect(after).not.toHaveProperty("projectTitle");
    });

    it("fails cleanly, as UsageExportError (changed), when the rollup changes under every pass", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 10; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, "2026-02-01", index));
            }
        });

        const base = exportIo("r4", A);
        const io: UsageExportIo = {
            ...base,
            // Every recount finds one more row than the pages held: a backfill writing as the export runs.
            countRows: async (name, page) => {
                const counted = await base.countRows(name, page);

                return page.cursor === null ? { ...counted, closed: { ...counted.closed, rows: counted.closed.rows + 1 } } : counted;
            },
        };

        await expect(collectUsageExport(io)).rejects.toMatchObject({ reason: "changed" });
    });

    it("fails with UsageExportError (too-large) when the usage is larger than its share of the file", async () => {
        const io = exportIo("r5", A, {
            persistRows: async (name, args) => {
                const summary = await exportIo("r5", A).persistRows(name, args);

                return { ...summary, bytes: USAGE_EXPORT_BYTES + 1 };
            },
        });

        await expect(collectUsageExport(io)).rejects.toMatchObject({ reason: "too-large" });
    });

    it("clears the pieces of the run", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 1100; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, "2026-02-01", index));
            }
        });

        await collectUsageExport(exportIo("r1", A));

        expect(await pieceCount(A)).toBeGreaterThan(0);

        await clearUsagePieces(exportIo("r1", A));

        expect(await pieceCount(A)).toBe(0);
    });

    it("redoes the pass when a backfill patches a closed day's row without adding one, so the file holds the new totals", async () => {
        await harness.run(async (ctx: any) => {
            // The oldest row is far enough back to be closed, so a change to it is what the totals must catch.
            await ctx.db.insert("usageDaily", usageRow(A, "2025-12-01"));

            for (let index = 0; index < 1200; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, "2026-02-01", index));
            }
        });

        let patched = false;
        const io = exportIo("r6", A, {
            persistRows: async (name, args) => {
                const summary = await exportIo("r6", A).persistRows(name, args);

                // A backfill raises the replies of a closed day's row that the first page already holds.
                if (!patched && args.pass === 1 && args.seq === 0) {
                    patched = true;
                    await harness.run(async (ctx: any) => {
                        const { page } = await ctx.db.usageDaily.findMany({ limit: 1, orderBy: [{ date: "asc" }], where: { userId: A } });

                        await ctx.db.patch("usageDaily", page[0]._id, { replies: 99 });
                    });
                }

                return summary;
            },
        });

        const { pass } = await collectUsageExport(io);
        const { rows } = await assemble("r6", A, pass);

        expect(patched).toBe(true);
        expect(pass).toBe(2);
        expect(rows.some((row) => row.replies === 99)).toBe(true);
    });

    it("redoes the pass when a backfill writes the last days during the export, and the file holds those rows", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 1200; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, "2026-02-01", index));
            }

            await ctx.db.insert("usageBackfill", { leaseUntil: 0, replies: 0, runId: "b1", startedAt: 1, status: "running", updatedAt: 1, userId: A });
        });

        let wrote = false;
        const io = exportIo("r13", A, {
            persistRows: async (name, args) => {
                const summary = await exportIo("r13", A).persistRows(name, args);

                // The backfill writes a row for yesterday, and advances its own row, after the first page was read.
                if (!wrote && args.pass === 1 && args.seq === 0) {
                    wrote = true;
                    await harness.run(async (ctx: any) => {
                        await ctx.db.insert("usageDaily", { ...usageRow(A, addDays(today(), -1), 44), skillKey: "recent-backfill" });

                        const { page } = await ctx.db.usageBackfill.findMany({ where: { userId: A } });

                        await ctx.db.patch("usageBackfill", page[0]._id, { replies: 5 });
                    });
                }

                return summary;
            },
        });

        const { pass } = await collectUsageExport(io);
        const { rows } = await assemble("r13", A, pass);

        expect(wrote).toBe(true);
        expect(pass).toBe(2);
        expect(rows.some((row) => row.skill === "recent-backfill")).toBe(true);
    });

    it("redoes the pass when the backfill row changes on a later recount page, not only the first", async () => {
        await harness.run(async (ctx: any) => {
            // Closed days, so the recount reads them: more than one recount page.
            for (let index = 0; index < 2100; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, "2025-06-01", index));
            }

            await ctx.db.insert("usageDaily", usageRow(A, "2026-02-01"));

            await ctx.db.insert("usageBackfill", { leaseUntil: 0, replies: 0, runId: "b2", startedAt: 1, status: "running", updatedAt: 1, userId: A });
        });

        let patched = false;
        const base = exportIo("r14", A);
        const io: UsageExportIo = {
            ...base,
            countRows: async (name, args) => {
                // Between the recount's first page and its second, the backfill advances its row.
                if (!patched && args.cursor !== null) {
                    patched = true;
                    await harness.run(async (ctx: any) => {
                        const { page } = await ctx.db.usageBackfill.findMany({ where: { userId: A } });

                        await ctx.db.patch("usageBackfill", page[0]._id, { replies: 7 });
                    });
                }

                return base.countRows(name, args);
            },
        };

        const { pass } = await collectUsageExport(io);

        expect(patched).toBe(true);
        expect(pass).toBe(2);
    });

    it("writes nothing once the account's deletion has begun", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageDaily", usageRow(A, "2026-02-01"));
            await ctx.db.insert("gdprRequests", { requestedAt: 1, requestType: "deletion", status: "processing", userEmail: "a@example.com", userId: A });
        });

        await expect(collectUsageExport(exportIo("r7", A))).rejects.toThrow("Account deletion is underway");
        expect(await pieceCount(A)).toBe(0);
    });

    it("splices the usage array in as the file's last key, into JSON that parses", () => {
        const head = JSON.stringify({ profile: { id: A }, watchedRepositories: { watched: [] } }, null, 2);
        const parsed = JSON.parse(spliceUsageJson(head, JSON.stringify([{ date: "2026-02-01", replies: 1 }]))) as Record<string, unknown>;

        expect(Object.keys(parsed)).toEqual(["profile", "watchedRepositories", "usageDaily"]);
        expect(parsed["usageDaily"]).toEqual([{ date: "2026-02-01", replies: 1 }]);
    });

    it("keeps a user west of UTC on its first pass when a live reply is dated their yesterday", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 1200; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, ANCHOR, index));
            }
        });

        // A user west of UTC replies late in their day: its row is dated the day before the UTC date.
        let written = false;
        const io = exportIo("r9", A, {
            persistRows: async (name, args) => {
                const summary = await exportIo("r9", A).persistRows(name, args);

                if (!written && args.seq === 0) {
                    written = true;
                    await harness.run(async (ctx: any) => {
                        await ctx.db.insert("usageDaily", usageRow(A, addDays(ANCHOR, -1), 66));
                    });
                }

                return summary;
            },
        });

        const { pass } = await collectUsageExport(io);

        expect(written).toBe(true);
        expect(pass).toBe(1);
    });

    it("does not name a project transferred away before its title is read", async () => {
        const project = await harness.run(async (ctx: any) => {
            const id = await ctx.db.insert("projects", { createdAt: 1, title: "Mine", userId: A });

            await ctx.db.insert("usageDaily", { ...usageRow(A, "2026-02-01"), projectKey: id, skillKey: "__project__" });

            return id;
        });

        let moved = false;
        const io = exportIo("r10", A, {
            persistRows: async (name, args) => {
                const summary = await exportIo("r10", A).persistRows(name, args);

                // Between the rows and the title read, the project is transferred to another user.
                if (!moved && args.seq === 0) {
                    moved = true;
                    await harness.run(async (ctx: any) => {
                        await ctx.db.patch("projects", project, { userId: B });
                    });
                }

                return summary;
            },
        });

        const { pass } = await collectUsageExport(io);
        const transferred = await assemble("r10", A, pass);
        const rows = transferred.rows.filter((row) => row.project !== undefined);

        expect(moved).toBe(true);
        expect(rows).toHaveLength(1);
        expect(rows[0]).not.toHaveProperty("projectTitle");
    });

    it("reports a usage too large for the file as null, not as an error that loses its class", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageExportPieces", {
                bytes: USAGE_EXPORT_BYTES + 1,
                closedRows: 0,
                createdAt: Date.now(),
                kind: "rows",
                pass: 1,
                payload: "x".repeat(USAGE_EXPORT_BYTES + 1),
                projectIds: [],
                requestId: "r11",
                rowCount: 0,
                seq: 0,
                userId: A,
            });
        });

        const text = await buildUsageJson(
            async (kind, cursor) =>
                (await harness.run(async (ctx: any) => await ctx.runQuery(readUsageExportPieces, { cursor, kind, pass: 1, requestId: "r11", userId: A }))) as {
                    cursor: string | null;
                    payloads: string[];
                },
            async () => [],
        );

        expect(text).toBeNull();
    });

    it("counts a pending, processing, failed or completed deletion as underway, and a cancelled one as not", async () => {
        const underway = async (status: string) =>
            await harness.run(async (ctx: any) => {
                await ctx.db.insert("gdprRequests", { requestedAt: 1, requestType: "deletion", status, userEmail: "a@example.com", userId: status });

                return await deletionUnderwayOnPrimary(ctx, status);
            });

        expect(await underway("pending")).toBe(true);
        expect(await underway("processing")).toBe(true);
        expect(await underway("completed")).toBe(true);
        expect(await underway("failed")).toBe(true);
        expect(await underway("cancelled")).toBe(false);
    });

    it("carries the names of a very large owned set forward from step to step, and names every project", async () => {
        const projects = await harness.run(async (ctx: any) => {
            const ids: string[] = [];

            for (let index = 0; index < 40; index += 1) {
                const id = await ctx.db.insert("projects", { createdAt: 1, title: `Owned ${String(index)}`, userId: A });

                await ctx.db.insert("usageDaily", { ...usageRow(A, "2026-02-01", index), projectKey: id, skillKey: "__project__" });
                ids.push(id);
            }

            return ids;
        });

        const steps: string[] = [];
        const base = exportIo("r20", A);
        const io: UsageExportIo = {
            ...base,
            verifyTitles: async (name, args) => {
                steps.push(name);

                // A budget of one byte: each step carries the names of four projects and stops, and the next step continues from there.
                return await base.verifyTitles(name, { ...args, budgetBytes: 1 });
            },
        };

        const { pass } = await collectUsageExport(io);
        const assembled = await assemble("r20", A, pass);
        const rows = assembled.rows.filter((row) => row.project !== undefined);

        expect(steps).toHaveLength(projects.length / 4);
        expect(new Set(rows.map((row) => row.projectTitle)).size).toBe(projects.length);
    });

    it("reads a large pass's rows once: later title steps name projects from the pages' own pieces, across the pages", async () => {
        await harness.run(async (ctx: any) => {
            const ids: string[] = [];

            for (let index = 0; index < 1010; index += 1) {
                ids.push(await ctx.db.insert("projects", { createdAt: 1, title: `Large ${String(index)}`, userId: A }));
            }

            // The pass's rows in pages of 41 projects, each page with its projects as a piece of their own, as the export writes them.
            for (let seq = 0; seq * 41 < ids.length; seq += 1) {
                const page = ids.slice(seq * 41, (seq + 1) * 41);

                await ctx.db.insert("usageExportPieces", {
                    bytes: 1,
                    closedRows: 0,
                    createdAt: 1,
                    kind: "rows",
                    pass: 1,
                    payload: "[]",
                    projectIds: page,
                    requestId: "large:1",
                    rowCount: 0,
                    seq,
                    userId: A,
                });
                await ctx.db.insert("usageExportPieces", {
                    bytes: 1,
                    createdAt: 1,
                    kind: "projects",
                    pass: 1,
                    payload: JSON.stringify(page),
                    projectIds: [],
                    requestId: "large:1",
                    rowCount: page.length,
                    seq,
                    userId: A,
                });
            }
        });

        const titleStep = async (from: number, seq: number) =>
            (await harness.run(
                async (ctx: any) => await ctx.runMutation(verifyUsageTitles, { budgetBytes: 1, from, pass: 1, requestId: "large:1", seq, userId: A }),
            )) as { done: boolean; next: number; titles: number };

        // The first step names four projects of the first page.
        expect(await titleStep(0, 0)).toMatchObject({ done: false, next: 4, titles: 4 });

        // The rows are gone: the steps after it name projects from the pages' pieces alone.
        await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.usageExportPieces.findMany({ limit: 100, where: { kind: "rows", requestId: "large:1" } });

            for (const piece of page) {
                await ctx.db.delete("usageExportPieces", piece._id);
            }
        });

        // Positions 38 to 40 end the first page, so the next step starts the second.
        expect(await titleStep(38, 1)).toMatchObject({ done: false, next: PROJECT_POSITION, titles: 3 });
        expect(await titleStep(PROJECT_POSITION, 2)).toMatchObject({ done: false, next: PROJECT_POSITION + 4, titles: 4 });

        // The last page holds 26 projects; reading its last one ends the pass.
        expect(await titleStep(24 * PROJECT_POSITION + 25, 3)).toMatchObject({ done: true, next: 25 * PROJECT_POSITION, titles: 1 });
    });

    it("finds an object written during the erasure: its record is released, so the usage action's confirmation fails and it deletes the object", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageExportRuns", {
                createdAt: Date.now(),
                requestId: "inflight:1",
                usageKey: usageObjectKey("inflight:1"),
                userId: A,
            });
        });

        // The erasure's purge step finds the key and releases the record, while the usage action's write is still in flight.
        const keyed = await keyedRunsOf(A);

        await harness.run(async (ctx: any) => await ctx.runMutation(releaseUsageKey, { runId: keyed[0]?.runId }));

        // The write lands and is confirmed against its record, which is gone: the action removes the object.
        const confirmed = await harness.run(
            async (ctx: any) => await ctx.runQuery(confirmUsageFile, { key: usageObjectKey("inflight:1"), requestId: "inflight:1", userId: A }),
        );

        expect(confirmed).toBe(false);
    });

    it("does not name a project transferred away before the verify step that reads it", async () => {
        const project = await harness.run(async (ctx: any) => {
            const id = await ctx.db.insert("projects", { createdAt: 1, title: "Mine", userId: A });

            await ctx.db.insert("usageDaily", { ...usageRow(A, "2026-02-01"), projectKey: id, skillKey: "__project__" });

            return id;
        });

        let moved = false;
        const base = exportIo("r31", A);
        const io: UsageExportIo = {
            ...base,
            verifyTitles: async (name, args) => {
                // The project is transferred before this step reads it: the step does not read it as the user's, so it is not named.
                if (!moved) {
                    moved = true;
                    await harness.run(async (ctx: any) => {
                        await ctx.db.patch("projects", project, { userId: B });
                    });
                }

                return await base.verifyTitles(name, args);
            },
        };

        const { pass } = await collectUsageExport(io);
        const assembled = await assemble("r31", A, pass);
        const rows = assembled.rows.filter((row) => row.project !== undefined);

        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.projectTitle === undefined)).toBe(true);
    });

    it("re-checks a large owned set across several steps, and names every project that is still owned", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 40; index += 1) {
                const id = await ctx.db.insert("projects", { createdAt: 1, title: `Checked ${String(index)}`, userId: A });

                await ctx.db.insert("usageDaily", { ...usageRow(A, "2026-02-01", index), projectKey: id, skillKey: "__project__" });
            }
        });

        let checks = 0;
        const base = exportIo("r32", A);
        const io: UsageExportIo = {
            ...base,
            persistTitles: async (name, args) => await base.persistTitles(name, { ...args, budgetBytes: 1 }),
            verifyTitles: async (name, args) => {
                checks += 1;

                return await base.verifyTitles(name, { ...args, budgetBytes: 1 });
            },
        };

        const { pass } = await collectUsageExport(io);
        const assembled = await assemble("r32", A, pass);
        const rows = assembled.rows.filter((row) => row.project !== undefined);

        // Four projects per step: forty projects are checked in ten steps.
        expect(checks).toBe(10);
        expect(new Set(rows.map((row) => row.projectTitle)).size).toBe(40);
    });

    it("reads a project once per pass when it is on several rows pages", async () => {
        const project = await harness.run(async (ctx: any) => {
            const id = await ctx.db.insert("projects", { createdAt: 1, title: "Busy", userId: A });

            // 1,200 rows: two rows pages, both on the same project.
            for (let index = 0; index < 1200; index += 1) {
                await ctx.db.insert("usageDaily", { ...usageRow(A, today(), index), projectKey: id, skillKey: `p${String(index)}` });
            }

            return id;
        });

        const { pass } = await collectUsageExport(exportIo("r43", A));
        const pieces: { payload: string }[] = await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.usageExportPieces.findMany({ limit: 100, where: { kind: "projects", pass, requestId: "r43", userId: A } });

            return page;
        });
        const named = pieces.flatMap((piece) => JSON.parse(piece.payload) as string[]).filter((id) => id === project);

        expect(named).toHaveLength(1);
    });

    it("names an owned set that fits in one step in one step", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 9; index += 1) {
                const id = await ctx.db.insert("projects", { createdAt: 1, title: `Fits ${String(index)}`, userId: A });

                await ctx.db.insert("usageDaily", { ...usageRow(A, "2026-02-01", index), projectKey: id, skillKey: "__project__" });
            }
        });

        const steps: string[] = [];
        const base = exportIo("r21", A);
        const io: UsageExportIo = {
            ...base,
            verifyTitles: async (name, args) => {
                steps.push(name);

                return await base.verifyTitles(name, args);
            },
        };

        const { pass } = await collectUsageExport(io);
        const assembled = await assemble("r21", A, pass);
        const rows = assembled.rows.filter((row) => row.project !== undefined);

        expect(steps).toHaveLength(1);
        expect(rows).toHaveLength(9);
    });

    it("keeps the first pass when a late write is dated two days back, as a retry of an older reply can be", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 1200; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, ANCHOR, index));
            }
        });

        let written = false;
        const io = exportIo("r12", A, {
            persistRows: async (name, args) => {
                const summary = await exportIo("r12", A).persistRows(name, args);

                if (!written && args.seq === 0) {
                    written = true;
                    await harness.run(async (ctx: any) => {
                        await ctx.db.insert("usageDaily", usageRow(A, addDays(ANCHOR, -2), 55));
                    });
                }

                return summary;
            },
        });

        const { pass } = await collectUsageExport(io);

        expect(written).toBe(true);
        expect(pass).toBe(1);
    });

    it("redoes the pass when a late write lands three days back, inside the closed days", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 1200; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, ANCHOR, index));
            }
        });

        let written = false;
        const io = exportIo("r13", A, {
            persistRows: async (name, args) => {
                const summary = await exportIo("r13", A).persistRows(name, args);

                if (!written && args.seq === 0) {
                    written = true;
                    await harness.run(async (ctx: any) => {
                        await ctx.db.insert("usageDaily", usageRow(A, addDays(ANCHOR, -3), 55));
                    });
                }

                return summary;
            },
        });

        const { pass } = await collectUsageExport(io);

        expect(written).toBe(true);
        expect(pass).toBe(2);
    });

    it("refuses to record a usage file once the account's deletion has begun, and confirms a record only while it stands", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("gdprRequests", { requestedAt: 1, requestType: "deletion", status: "processing", userEmail: "a@example.com", userId: A });
        });

        await expect(
            harness.run(async (ctx: any) => await ctx.runMutation(recordUsageFile, { key: usageObjectKey("late:1"), requestId: "late:1", userId: A })),
        ).rejects.toThrow("Account deletion is underway");
        expect(await pieceCount(A)).toBe(0);

        // A record written before the deletion began is confirmed while it stands, and not once it has been purged.
        await harness.run(async (ctx: any) => {
            const request = await ctx.db.gdprRequests.findFirst({ where: { userId: A } });

            await ctx.db.delete("gdprRequests", request._id);
        });
        await harness.run(async (ctx: any) => await ctx.runMutation(recordUsageFile, { key: usageObjectKey("ok:1"), requestId: "ok:1", userId: A }));

        expect(await harness.run(async (ctx: any) => await ctx.runQuery(confirmUsageFile, { key: usageObjectKey("ok:1"), requestId: "ok:1", userId: A }))).toBe(
            true,
        );
        expect(
            await harness.run(async (ctx: any) => await ctx.runQuery(confirmUsageFile, { key: usageObjectKey("gone:1"), requestId: "gone:1", userId: A })),
        ).toBe(false);
    });

    it("reads the titles of more projects than one step, step by step, and names every one", async () => {
        const projects = await harness.run(async (ctx: any) => {
            const ids: string[] = [];

            for (let index = 0; index < 9; index += 1) {
                const id = await ctx.db.insert("projects", { createdAt: 1, title: `Project ${String(index)}`, userId: A });

                await ctx.db.insert("usageDaily", { ...usageRow(A, "2026-02-01", index), projectKey: id, skillKey: "__project__" });
                ids.push(id);
            }

            return ids;
        });

        const steps: string[] = [];
        const base = exportIo("r15", A);
        const io: UsageExportIo = {
            ...base,
            verifyTitles: async (name, args) => {
                steps.push(name);

                // A budget of one byte: each step reads the one batch of four projects it can, and stops.
                return await base.verifyTitles(name, { ...args, budgetBytes: 1 });
            },
        };

        const { pass } = await collectUsageExport(io);
        const named = await assemble("r15", A, pass);
        const rows = named.rows.filter((row) => row.project !== undefined);

        expect(steps).toHaveLength(Math.ceil(projects.length / 4));
        expect(new Set(rows.map((row) => row.projectTitle)).size).toBe(projects.length);
    });

    it("gives a user over the pass budget a complete export in a later attempt, after a pause", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 10; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, "2026-02-01", index));
            }
        });

        const paused: string[] = [];
        const base = exportIo("r16", A);
        const io: UsageExportIo = {
            ...base,
            // The first six passes all change under the recount: a backfill keeps writing until the export has moved on.
            countRows: async (name, args) => {
                const counted = await base.countRows(name, args);
                const pass = Number(passOfCount.exec(name)?.[1]);

                return pass <= 6 && args.cursor === null ? { ...counted, closed: { ...counted.closed, rows: counted.closed.rows + 1 } } : counted;
            },
            pause: async (name) => {
                paused.push(name);
            },
        };

        const { pass } = await collectUsageExport(io);
        const { rows } = await assemble("r16", A, pass);

        expect(pass).toBe(7);
        expect(paused).toEqual(["usage-backoff-2"]);
        expect(rows).toHaveLength(10);
    });

    it("counts a deleted project's id against a title step, so one step never works through every missing project", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 9; index += 1) {
                // A project deleted since its usage was recorded: its id is in the rows, its document is gone.
                await ctx.db.insert("usageDaily", { ...usageRow(A, "2026-02-01", index), projectKey: `deleted-${String(index)}`, skillKey: "__project__" });
            }
        });

        const steps: string[] = [];
        const base = exportIo("r18", A);
        const io: UsageExportIo = {
            ...base,
            verifyTitles: async (name, args) => {
                steps.push(name);

                // A budget of one byte: a step that reads nothing but missing projects must still stop after its first batch.
                return await base.verifyTitles(name, { ...args, budgetBytes: 1 });
            },
        };

        await collectUsageExport(io);

        expect(steps).toHaveLength(Math.ceil(9 / 4));
    });
});

describe("keeping a record for a failed removal", () => {
    it("names a stored object again in a run row due now, so the sweep purges it when its removal does not finish", async () => {
        const runId = await harness.run(
            async (ctx: any) => await ctx.runMutation(keepUsageFileRecord, { key: "usage/r-kept.json", requestId: "r-kept", userId: A }),
        );
        const row = await harness.run(async (ctx: any) => await ctx.db.usageExportRuns.findFirst({ where: { _id: runId } }));

        expect(row).toMatchObject({ requestId: "r-kept", usageKey: "usage/r-kept.json", userId: A });
        expect(row.deleteAt).toBe(row.createdAt);
    });
});

describe("a title piece stays under its cap", () => {
    it("stops a title step before its piece would pass the cap, and the next step starts where it stopped", async () => {
        const title = "x".repeat(9000);
        const ids = await harness.run(async (ctx: any) => {
            const made: string[] = [];

            for (let index = 0; index < 200; index += 1) {
                made.push(await ctx.db.insert("projects", { createdAt: 1, title, userId: A }));
            }

            await ctx.db.insert("usageExportPieces", {
                bytes: 1,
                createdAt: 1,
                kind: "projects",
                pass: 1,
                payload: JSON.stringify(made),
                projectIds: [],
                requestId: "cap:1",
                rowCount: made.length,
                seq: 0,
                userId: A,
            });

            return made;
        });

        const step = async (from: number) =>
            (await harness.run(
                async (ctx: any) =>
                    await ctx.runMutation(verifyUsageTitles, { budgetBytes: 4 * 1024 * 1024, from, pass: 1, requestId: "cap:1", seq: 0, userId: A }),
            )) as { done: boolean; next: number; titles: number };

        const first = await step(0);

        expect(first.done).toBe(false);
        expect(first.next).toBeGreaterThan(0);
        expect(first.next).toBeLessThan(ids.length);

        const piece = await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.usageExportPieces.findMany({ where: { kind: "verified", requestId: "cap:1", seq: 0, userId: A } });

            return page[0];
        });

        expect(piece.bytes).toBeLessThanOrEqual(TITLE_PIECE_BYTES);
        expect(piece.bytes).toBeGreaterThan(TITLE_PIECE_BYTES / 2);
    });
});

describe("the export's pieces, as the export leaves them", () => {
    it("fails, rather than storing an empty history, when the kept pass's rows pieces were removed before the file was built", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageDaily", usageRow(A, "2026-02-01", 1));
        });

        const { pass } = await collectUsageExport(exportIo("rgone", A));

        await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.usageExportPieces.findMany({ limit: 100, where: { kind: "rows", requestId: "rgone", userId: A } });

            for (const piece of page) {
                await ctx.db.delete("usageExportPieces", piece._id);
            }
        });

        await expect(assemble("rgone", A, pass)).rejects.toThrow("removed before the file was built");
    });

    it("clears a pass the recount rejected, so no copy of its usage is kept while the export runs", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 1200; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, "2026-02-01", index));
            }
        });

        let inserted = false;
        const io = exportIo("rdiscard", A, {
            persistRows: async (name, args) => {
                const summary = await exportIo("rdiscard", A).persistRows(name, args);

                if (!inserted && args.pass === 1 && args.seq === 0) {
                    inserted = true;
                    await harness.run(async (ctx: any) => {
                        await ctx.db.insert("usageDaily", { ...usageRow(A, "2026-01-01", 99), skillKey: "backfilled" });
                    });
                }

                return summary;
            },
        });

        const { pass } = await collectUsageExport(io);

        expect(pass).toBeGreaterThan(1);

        const firstPassPieces = await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.usageExportPieces.findMany({ limit: 100, where: { pass: 1, requestId: "rdiscard", userId: A } });

            return page.length;
        });

        expect(firstPassPieces).toBe(0);
    });
});
