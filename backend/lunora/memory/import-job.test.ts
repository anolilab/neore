/**
 * The background import of a large memory file: the action refuses or queues at the boundary, each batch is claimed
 * once and tolerates redelivery, the counts add up to what the parse read, the stored entries are gone when the job
 * ends or the account is erased, and the progress read is the owner's. Queue messages are only recorded (the stub of
 * `cloudflare:workers`); the test runs each batch by hand.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { deleteUserMemoryReflectionData } from "./gdpr";
import { importMemoryFile } from "./import";
import { MEMORY_FILE_BATCH_SIZE, MEMORY_FILE_INLINE_MAX_ENTRIES } from "./import-file-logic";
import {
    cancelMemoryImport,
    claimImportBatch,
    completeImportBatch,
    getMemoryImportProgress,
    reapMemoryImportJob,
    runMemoryImportBatch,
    STALE_IMPORT_BATCH_MS,
} from "./import-job";

const { generateText, reapers, registry, sent, sessionFrom } = vi.hoisted(() => {
    return {
        generateText: vi.fn(),
        // What `enqueueJob` was asked to send: every job here is a batch of the import.
        // What was scheduled through `runAfterOnShard`: the reapers.
        reapers: [] as { args: Record<string, unknown>; delayMs: number; shardKey: string }[],
        registry: new Map<string, unknown>(),
        sent: [] as { args: Record<string, unknown>; shardKey?: string }[],
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, plan: null, role: null, userId: context.auth.userId }
                : null,
    };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../lib/shard-scheduler", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/shard-scheduler")>()),
        runAfterOnShard: async (_scheduler: unknown, delayMs: number, _target: unknown, args: Record<string, unknown>, shardKey: string) => {
            reapers.push({ args, delayMs, shardKey });

            return "job";
        },
    };
});
vi.mock("../lib/job-queue", () => {
    return {
        enqueueJob: async (_ref: unknown, args: Record<string, unknown>, options: { shardKey?: string } = {}) => {
            sent.push({ args, ...(options.shardKey !== undefined && { shardKey: options.shardKey }) });
        },
    };
});
vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), generateText };
});
vi.mock("../chat/lib/model-filter-rules", () => {
    return {
        getUtilityModelForUser: async () => {
            return {};
        },
        loadModelFilterRules: async () => {
            return {};
        },
    };
});
vi.mock("../lib/services", () => {
    return { gatewayFetch: () => async () => new Response("{}") };
});
vi.mock("../agent/client/search", () => {
    return {
        embedMany: async () => {
            throw new Error("no embeddings in this test");
        },
    };
});
vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

const LABEL_LINE_RE = /^(\d+)\. (.*)$/gmu;
const SENSITIVE_RE = /HIV/u;
const USER = "user-a";
const OTHER = "user-b";

let harness: ReturnType<typeof lunoraTest>;

const as = (userId: string) => harness.withIdentity({ userId } as never);
const callAction = async (procedure: unknown, args: object): Promise<any> => await as(USER).action(procedure as never, args as never);
const run = async <T>(callback: (ctx: any) => Promise<T>): Promise<T> => await harness.run(callback);

const fileOf = (count: number, extra: ReadonlyArray<string> = []): string =>
    [...Array.from({ length: count }, (_, index) => `The user has hobby number ${String(index)}`), ...extra].join("\n");

const jobRows = async (): Promise<any[]> => await run(async (ctx) => await ctx.db.query("memoryImportJobs").collect());
const batchRows = async (): Promise<any[]> => await run(async (ctx) => await ctx.db.query("memoryImportBatches").collect());
const memoryRows = async (): Promise<any[]> => await run(async (ctx) => await ctx.db.query("memories").collect());

/** The batch jobs on the jobs queue, in send order. */
const queued = (): { args: Record<string, unknown>; shardKey?: string }[] => sent;

const runBatch = async (args: Record<string, unknown>): Promise<unknown> =>
    await harness.action(async (ctx: any) => await (runMemoryImportBatch as any).handler(ctx, args));

/** Runs the batch the queue holds last, as the consumer would. */
const runNewest = async (): Promise<void> => {
    await runBatch(queued().at(-1)!.args);
};

/** Imports a large file and returns its job. */
const start = async (count: number, extra: ReadonlyArray<string> = []): Promise<{ jobId: string; total: number }> => {
    const result = await callAction(importMemoryFile, { content: fileOf(count, extra), format: "text" });

    return result as { jobId: string; total: number };
};

beforeAll(async () => {
    registerModule(registry, "memory_functions", await import("./functions"));
    registerModule(registry, "memory_import_job", await import("./import-job"));
    registerModule(registry, "lib_rate_limiter_mutations", await import("../lib/rate-limiter-mutations"));
});

beforeEach(async () => {
    sent.length = 0;
    reapers.length = 0;
    harness = lunoraTest(schema as never);
    await run(async (ctx) => {
        await ctx.db.insert("userSettings", { memoryEnabled: true, timezone: "UTC", userId: USER });
    });
    // The embedding service is unavailable in these tests: every fact is deduped by its words.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    generateText.mockImplementation(async ({ prompt }: { prompt: string }) => {
        return {
            output: {
                keep: [...prompt.matchAll(LABEL_LINE_RE)]
                    .filter((match) => !SENSITIVE_RE.test(match[2] ?? ""))
                    .map((match) => {
                        return { line: Number(match[1]), type: "context" };
                    }),
            },
        };
    });
});

afterEach(() => {
    harness.close();
    generateText.mockReset();
    vi.restoreAllMocks();
});

describe("starting a large file import", () => {
    it("queues a file over the inline limit instead of importing it, storing only the parsed batches", async () => {
        expect.assertions(8);

        const count = MEMORY_FILE_BATCH_SIZE * 2 + 10;
        const result = await start(count);

        expect(result).toMatchObject({ queued: true, total: count });
        await expect(memoryRows()).resolves.toStrictEqual([]);
        expect(generateText).not.toHaveBeenCalled();

        const batches = await batchRows();

        expect(batches.map((row) => row.entries.length).toSorted((a, b) => a - b)).toStrictEqual([10, 25, 25]);
        // Nothing but the parsed, redacted entries: no raw file text is stored.
        expect(JSON.stringify(batches)).not.toContain("\n");
        expect(queued()).toStrictEqual([{ args: { index: 0, jobId: result.jobId }, shardKey: USER }]);
        await expect(jobRows()).resolves.toMatchObject([{ batchCount: 3, done: 0, nextBatch: 0, status: "queued", total: count }]);
        // A reaper for the job still preparing, and one for its first batch, both past the queue's dispatch timeout.
        expect(reapers.map(({ args: { batch }, delayMs, shardKey }) => [batch, delayMs, shardKey])).toStrictEqual([
            [-1, STALE_IMPORT_BATCH_MS, USER],
            [0, STALE_IMPORT_BATCH_MS, USER],
        ]);
    });

    it("still imports a file of exactly the inline limit in the same call", async () => {
        expect.assertions(3);

        const result = await callAction(importMemoryFile, { content: fileOf(MEMORY_FILE_INLINE_MAX_ENTRIES), format: "text" });

        expect(result).toStrictEqual({ duplicates: 0, imported: MEMORY_FILE_INLINE_MAX_ENTRIES, invalid: 0, tooLong: 0, updated: 0 });
        expect(queued()).toStrictEqual([]);
        await expect(jobRows()).resolves.toStrictEqual([]);
    });

    it("returns a refusal at once and queues nothing", async () => {
        expect.assertions(4);

        const secret = `${fileOf(40)}\nDB_PASSWORD=`;

        await expect(callAction(importMemoryFile, { content: secret, format: "text" })).rejects.toMatchObject({
            code: "BAD_REQUEST",
            message: expect.stringContaining("Line 41"),
        });
        await expect(callAction(importMemoryFile, { content: "{ nope", format: "json" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(queued()).toStrictEqual([]);
        await expect(Promise.all([jobRows(), batchRows()])).resolves.toStrictEqual([[], []]);
    });

    it("refuses a second large import while one is active", async () => {
        expect.assertions(2);

        await start(40);

        await expect(start(40)).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("already running") });
        await expect(batchRows()).resolves.toHaveLength(2);
    });
});

describe("running the batches", () => {
    it("imports every batch once and the counts add up to what the file held", async () => {
        expect.assertions(9);

        // 70 entries: 3 batches. One sensitive (labelling drops it), one duplicate of an earlier line, one too short.
        const { jobId, total } = await start(MEMORY_FILE_BATCH_SIZE * 2 + 10, ["The user has HIV", "the user HAS hobby number 3", "No"]);

        await runNewest();
        await runNewest();
        await runNewest();

        const [job] = await jobRows();
        const { done, duplicates, imported, invalid, tooLong, updated } = job;

        expect(job).toMatchObject({ nextBatch: 2, status: "done" });
        expect(done).toBe(total);
        expect(imported + duplicates + tooLong + invalid + updated).toBe(total);
        expect(imported).toBe(MEMORY_FILE_BATCH_SIZE * 2 + 10);
        expect(invalid).toBe(2);
        expect(duplicates).toBe(1);
        await expect(memoryRows()).resolves.toHaveLength(MEMORY_FILE_BATCH_SIZE * 2 + 10);
        // The payload is gone once the job is done.
        await expect(batchRows()).resolves.toStrictEqual([]);

        expect(jobId).toBe(job._id);
    });

    it("claims a batch once: a redelivery while it runs, and one after it completed, do nothing", async () => {
        expect.assertions(6);

        const { jobId } = await start(40);
        const args = { index: 0, jobId };

        const first = await run(async (ctx) => await ctx.runMutation(claimImportBatch, args));
        const second = await run(async (ctx) => await ctx.runMutation(claimImportBatch, args));

        expect(first).toMatchObject({ userId: USER });
        expect(second).toBeNull();

        // A redelivered action finds the claim taken and does not label or write anything.
        await runBatch(args);
        expect(generateText).not.toHaveBeenCalled();

        const counts = { duplicates: 0, imported: 25, index: 0, invalid: 0, jobId, updated: 0 };

        await run(async (ctx) => await ctx.runMutation(completeImportBatch, counts));
        // The same completion twice counts once.
        await run(async (ctx) => await ctx.runMutation(completeImportBatch, counts));

        await expect(jobRows()).resolves.toMatchObject([{ done: 25, imported: 25, nextBatch: 1 }]);
        expect(queued().filter((message) => message.args.index === 1)).toHaveLength(1);

        // A delivery of the finished batch again does nothing.
        await runBatch(args);
        expect(generateText).not.toHaveBeenCalled();
    });

    it("removes the payload when a batch fails, and keeps what was imported", async () => {
        expect.assertions(4);

        await start(40);
        await runNewest();

        generateText.mockRejectedValue(new Error("no model"));
        await runNewest();

        await expect(jobRows()).resolves.toMatchObject([{ imported: 25, status: "failed" }]);
        await expect(batchRows()).resolves.toStrictEqual([]);
        await expect(memoryRows()).resolves.toHaveLength(25);
        expect(queued()).toHaveLength(2);
    });

    it("ends a job whose owner turned memory off, writing nothing for it", async () => {
        expect.assertions(3);

        const { jobId } = await start(40);

        await run(async (ctx) => {
            const settings = await ctx.db.query("userSettings").first();

            await ctx.db.patch("userSettings", settings._id, { memoryEnabled: false });
        });
        await runBatch({ index: 0, jobId });

        await expect(jobRows()).resolves.toMatchObject([{ status: "failed" }]);
        await expect(batchRows()).resolves.toStrictEqual([]);
        await expect(memoryRows()).resolves.toStrictEqual([]);
    });
});

describe("ending a job", () => {
    it("cancels a job, drops its payload, and ignores a batch still in flight", async () => {
        expect.assertions(5);

        const { jobId } = await start(40);
        const claimed = await run(async (ctx) => await ctx.runMutation(claimImportBatch, { index: 0, jobId }));

        expect(claimed).not.toBeNull();
        await as(USER).mutation(cancelMemoryImport as never, { jobId } as never);
        // The batch that was running reports after the cancel: it neither revives the job nor counts.
        await run(async (ctx) => await ctx.runMutation(completeImportBatch, { duplicates: 0, imported: 25, index: 0, invalid: 0, jobId, updated: 0 }));

        await expect(jobRows()).resolves.toMatchObject([{ done: 0, imported: 0, status: "failed" }]);
        await expect(batchRows()).resolves.toStrictEqual([]);
        expect(queued()).toHaveLength(1);
        await expect(as(OTHER).mutation(cancelMemoryImport as never, { jobId } as never)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("fails a job stuck on a batch whose delivery died, and one stuck preparing, but not one that moved on", async () => {
        expect.assertions(4);

        const { jobId } = await start(40);

        await run(async (ctx) => await ctx.runMutation(claimImportBatch, { index: 0, jobId }));
        // A reaper for a batch the job has left does nothing.
        await run(async (ctx) => await ctx.runMutation(reapMemoryImportJob, { batch: 5, jobId }));
        await expect(jobRows()).resolves.toMatchObject([{ status: "running" }]);

        await run(async (ctx) => await ctx.runMutation(reapMemoryImportJob, { batch: 0, jobId }));
        await expect(jobRows()).resolves.toMatchObject([{ error: expect.stringContaining("stopped before"), status: "failed" }]);
        await expect(batchRows()).resolves.toStrictEqual([]);

        // The reaper outlasts the queue's dispatch timeout.
        expect(STALE_IMPORT_BATCH_MS).toBeGreaterThan(14 * 60_000);
    });

    it("erases the job and its payload with the account", async () => {
        expect.assertions(2);

        await start(40);
        await run(async (ctx) => await ctx.runMutation(deleteUserMemoryReflectionData, { userId: USER }));

        await expect(jobRows()).resolves.toStrictEqual([]);
        await expect(batchRows()).resolves.toStrictEqual([]);
    });
});

describe("reading the progress", () => {
    it("reports the caller's newest job, counts only, and nothing for another user", async () => {
        expect.assertions(4);

        await expect(as(USER).query(getMemoryImportProgress as never, {} as never)).resolves.toBeNull();

        const { jobId } = await start(40);

        await runNewest();

        const mine: any = await as(USER).query(getMemoryImportProgress as never, {} as never);

        expect(mine).toMatchObject({ done: 25, imported: 25, jobId, status: "running", total: 40 });
        expect(JSON.stringify(mine)).not.toContain("hobby");
        await expect(as(OTHER).query(getMemoryImportProgress as never, {} as never)).resolves.toBeNull();
    });
});
