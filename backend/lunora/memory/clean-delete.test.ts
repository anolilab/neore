/**
 * A retired memory (superseded, merged, decayed, expired) keeps its row as history but loses its vector, and deleting a
 * memory takes its older versions and its digest entries with it.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi } from "../../test/registered-api";
import { deleteVectorRow } from "../agent/table-writes";
import type { Id } from "../_generated/dataModel";
import { memoryLogger } from "../lib/logger";
import schema from "../schema";
import { deleteUserMemoryReflectionData } from "./gdpr";
import {
    deleteMemory,
    linkMemoryEmbeddings,
    noteMemoryCleanupFailure,
    retryMemoryVectorDelete,
    runMemoryCleanup,
    saveMemory,
    saveMemoryBatch,
    stepMemoryCleanup,
    supersedeMemory,
    sweepMemoryCleanups,
} from "./functions";
import { applyReflectionOps, saveMemoryDigest } from "./reflection";

const { registry, sessionFrom } = vi.hoisted(() => {
    return {
        registry: new Map<string, unknown>(),
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

// Only the two procedures the cleanup job calls are registered; the jobs it schedules keep their plain references.
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

vi.mock("../agent/table-writes", async (importOriginal) => {
    const original = await importOriginal<typeof import("../agent/table-writes")>();

    return { ...original, deleteVectorRow: vi.fn(original.deleteVectorRow) };
});

const OWNER = "owner-user";
const OTHER = "other-user";

let harness: ReturnType<typeof lunoraTest>;

type Ctx = Parameters<Parameters<ReturnType<typeof lunoraTest>["run"]>[0]>[0];

const run = <T>(body: (ctx: Ctx) => Promise<T>): Promise<T> => harness.run(body);
const asOwner = () => harness.withIdentity({ userId: OWNER } as never);
const retryJobs = () => harness.scheduler.list().filter((job) => job.functionPath?.includes("retryMemoryVectorDelete") === true);
const continuationJobs = () => harness.scheduler.list().filter((job) => job.functionPath?.includes("runMemoryCleanup") === true);

/** A memory with a vector of its own. */
const seed = async (memory: string, userId = OWNER): Promise<{ embeddingId: Id<"embeddings_768">; memoryId: Id<"memories"> }> =>
    await run(async (ctx) => {
        const embeddingId = await ctx.db.insert("embeddings_768", {
            model: "m",
            table: "memories",
            userId,
            vector: Array.from({ length: 768 }, (_, index) => index / 768),
        });
        const memoryId = await ctx.db.insert("memories", { embeddingId, memory, type: "preference", userId });

        return { embeddingId, memoryId };
    });

const supersededByOf = async (id: Id<"memories">) => {
    const row = await run(async (ctx) => await ctx.db.get("memories", id));

    return row?.supersededBy;
};
const embeddingOf = async (id: Id<"memories">) => {
    const row = await run(async (ctx) => await ctx.db.get("memories", id));

    return row?.embeddingId;
};
const rowOf = async (id: Id<"memories">) => await run(async (ctx) => await ctx.db.get("memories", id));
const vectorExists = async (id: Id<"embeddings_768">): Promise<boolean> => (await run(async (ctx) => await ctx.db.get("embeddings_768", id))) !== null;

/** Saves `memory` as the new version of `older` (the belief-revision path). */
const supersede = async (older: Id<"memories">, memory: string): Promise<Id<"memories">> =>
    (await run(
        async (ctx) => await ctx.runMutation(saveMemory as never, { memory, supersedes: older, type: "preference", userId: OWNER } as never),
    )) as Id<"memories">;

beforeAll(async () => {
    const functions = await import("./functions");

    registry.set("memory_functions:stepMemoryCleanup", functions.stepMemoryCleanup);
    registry.set("memory_functions:noteMemoryCleanupFailure", functions.noteMemoryCleanupFailure);
});

beforeEach(() => {
    harness = lunoraTest(schema as never);
    vi.spyOn(memoryLogger, "warn").mockImplementation(() => undefined);
    vi.spyOn(memoryLogger, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    harness.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("a retired row loses its vector", () => {
    it("drops the old row's vector when a newer statement supersedes it, and keeps the row", async () => {
        const old = await seed("likes tea");
        const next = await supersede(old.memoryId, "likes green tea");

        const row = await rowOf(old.memoryId);

        expect(row).not.toBeNull();
        expect(row?.supersededBy).toBe(next);
        expect(row?.embeddingId).toBeUndefined();
        expect(await vectorExists(old.embeddingId)).toBe(false);
    });

    it("drops the vectors of the originals a compression retires", async () => {
        const a = await seed("likes tea");
        const b = await seed("likes coffee");

        const [saved] = (await run(
            async (ctx) =>
                await ctx.runMutation(
                    saveMemoryBatch as never,
                    { compressedFrom: [a.memoryId, b.memoryId], memories: [{ memory: "likes hot drinks", type: "preference", userId: OWNER }] } as never,
                ),
        )) as Id<"memories">[];

        expect(saved).toBeDefined();
        expect(await supersededByOf(a.memoryId)).toBe(a.memoryId);
        expect(await vectorExists(a.embeddingId)).toBe(false);
        expect(await vectorExists(b.embeddingId)).toBe(false);
    });

    it("drops the vector of a row reflection expires, and of one it merges away or promotes", async () => {
        const expired = await seed("in Lisbon until 2026-09-20");
        const kept = await seed("lives in Porto");
        const absorbed = await seed("lives in porto city");
        const sourceA = await seed("runs on Mondays");
        const sourceB = await seed("runs on Fridays");

        await run(
            async (ctx) =>
                await ctx.runMutation(
                    applyReflectionOps as never,
                    {
                        ops: [
                            { byMemoryId: expired.memoryId, kind: "supersede", memoryId: expired.memoryId },
                            { byMemoryId: kept.memoryId, kind: "supersede", memoryId: absorbed.memoryId },
                            {
                                confidence: 80,
                                importance: 50,
                                kind: "promote",
                                memory: "runs regularly",
                                sourceIds: [sourceA.memoryId, sourceB.memoryId],
                                type: "activity",
                            },
                        ],
                        userId: OWNER,
                    } as never,
                ),
        );

        for (const retired of [expired, absorbed, sourceA, sourceB]) {
            expect(await supersededByOf(retired.memoryId)).toBeDefined();
            expect(await vectorExists(retired.embeddingId)).toBe(false);
        }

        expect(await vectorExists(kept.embeddingId)).toBe(true);
    });

    it("keeps the row retired when the vector delete fails, and retries the delete", async () => {
        const old = await seed("likes tea");

        vi.mocked(deleteVectorRow).mockRejectedValueOnce(new Error("vector index unavailable"));

        const next = await supersede(old.memoryId, "likes green tea");

        expect(await supersededByOf(old.memoryId)).toBe(next);
        expect(await vectorExists(old.embeddingId)).toBe(true);
        expect(retryJobs()).toHaveLength(1);
        expect(retryJobs()[0]?.args).toMatchObject({ embeddingId: old.embeddingId, memoryId: old.memoryId, userId: OWNER });
    });

    it("gives no vector to a row that was retired while its re-embed ran", async () => {
        const old = await seed("likes tea");

        await supersede(old.memoryId, "likes green tea");

        const late = await run(
            async (ctx) =>
                await ctx.db.insert("embeddings_768", {
                    model: "m",
                    table: "memories",
                    userId: OWNER,
                    vector: Array.from({ length: 768 }, (_, index) => index / 768),
                }),
        );

        await run(
            async (ctx) =>
                await ctx.runMutation(
                    linkMemoryEmbeddings as never,
                    { links: [{ embeddingId: late, memoryId: old.memoryId, text: "likes tea" }], userId: OWNER } as never,
                ),
        );

        expect(await embeddingOf(old.memoryId)).toBeUndefined();
        expect(await vectorExists(late)).toBe(false);
    });
});

describe("deleting a memory", () => {
    it("removes the older versions it superseded, with their vectors", async () => {
        const first = await seed("likes tea");
        const second = await supersede(first.memoryId, "likes green tea");
        const third = await supersede(second, "likes jasmine tea");
        const unrelated = await seed("owns a bike");
        const otherUser = await seed("likes tea", OTHER);

        await asOwner().mutation(deleteMemory as never, { memoryId: third } as never);

        expect(await rowOf(first.memoryId)).toBeNull();
        expect(await rowOf(second)).toBeNull();
        expect(await rowOf(third)).toBeNull();
        expect(await vectorExists(first.embeddingId)).toBe(false);
        expect(await rowOf(unrelated.memoryId)).not.toBeNull();
        expect(await vectorExists(unrelated.embeddingId)).toBe(true);
        expect(await rowOf(otherUser.memoryId)).not.toBeNull();
    });

    it("follows a merge by reflection, where the older rows were never linked forward", async () => {
        const survivor = await seed("lives in Porto");
        const absorbed = await seed("lives in porto city");

        await run(
            async (ctx) =>
                await ctx.runMutation(
                    applyReflectionOps as never,
                    { ops: [{ byMemoryId: survivor.memoryId, kind: "supersede", memoryId: absorbed.memoryId, merge: true }], userId: OWNER } as never,
                ),
        );
        await asOwner().mutation(deleteMemory as never, { memoryId: survivor.memoryId } as never);

        expect(await rowOf(absorbed.memoryId)).toBeNull();
    });

    it("leaves a row that retired itself alone and still deletes the one asked for", async () => {
        const row = await seed("in Lisbon until 2026-09-20");

        await run(
            async (ctx) =>
                await ctx.runMutation(
                    applyReflectionOps as never,
                    { ops: [{ byMemoryId: row.memoryId, kind: "supersede", memoryId: row.memoryId }], userId: OWNER } as never,
                ),
        );
        await asOwner().mutation(deleteMemory as never, { memoryId: row.memoryId } as never);

        expect(await rowOf(row.memoryId)).toBeNull();
    });

    it("removes the memory and its older versions from the digests, keeping a digest that has other entries", async () => {
        const first = await seed("likes tea");
        const second = await supersede(first.memoryId, "likes green tea");
        const other = await seed("owns a bike");
        const digest = (learned: { memory: string; memoryId: string; type: string }[], localDay: string) =>
            run(
                async (ctx) =>
                    await ctx.db.insert("memoryDigests", {
                        createdAt: Date.now(),
                        learned,
                        localDay,
                        stats: { contradictionsResolved: 0, decayed: 0, merged: 0, newMemories: 0, promoted: 0, retired: 0 },
                        summary: "s",
                        userId: OWNER,
                    }),
            );
        const mixed = await digest(
            [
                { memory: "likes green tea", memoryId: second, type: "preference" },
                { memory: "likes tea", memoryId: first.memoryId, type: "preference" },
                { memory: "owns a bike", memoryId: other.memoryId, type: "preference" },
            ],
            "2026-09-24",
        );
        const onlyDeleted = await digest([{ memory: "likes green tea", memoryId: second, type: "preference" }], "2026-09-25");
        const statsOnly = await digest([], "2026-09-26");

        await asOwner().mutation(deleteMemory as never, { memoryId: second } as never);

        const left = await run(async (ctx) => await ctx.db.get("memoryDigests", mixed));

        expect((left?.learned as { memoryId: string }[] | undefined)?.map((entry) => entry.memoryId)).toEqual([other.memoryId]);
        expect(await run(async (ctx) => await ctx.db.get("memoryDigests", onlyDeleted))).toBeNull();
        expect(await run(async (ctx) => await ctx.db.get("memoryDigests", statsOnly))).not.toBeNull();
    });

    it("continues a long chain through its record and job, and the sweep arms another if that job is lost, until every older version is gone", async () => {
        const origin = await seed("version 0");
        let newest = origin.memoryId;
        const first = newest;

        for (let index = 1; index <= 105; index += 1) {
            newest = await supersede(newest, `version ${index}`);
        }

        await asOwner().mutation(deleteMemory as never, { memoryId: newest } as never);

        // A job is armed for the rest of the walk, and the record is all that is left of it: the root is already deleted, so
        // a second delete cannot restart the walk.
        expect(continuationJobs()).toHaveLength(1);
        expect(await cleanups()).toHaveLength(1);
        // The oldest rows are still there until the follow-up runs.
        expect(await rowOf(first)).not.toBeNull();

        // That job is lost: once the record is due, the sweep arms another, and that one completes the cleanup.
        await ageCleanups();
        await sweep();
        expect(continuationJobs()).toHaveLength(2);

        await runCleanup(continuationJobs()[1]?.args);

        expect(await rowOf(first)).toBeNull();
        expect(await memoryCount()).toBe(0);
        expect(await cleanups()).toHaveLength(0);

        // The original job turns up late, finds the record gone and does nothing.
        await runCleanup(continuationJobs()[0]?.args);
        expect(await memoryCount()).toBe(0);
        expect(await cleanups()).toHaveLength(0);
    });

    it("keeps the summary of a digest saved after the delete while a long chain goes on", async () => {
        const START = 1_800_000_000_000;

        vi.useFakeTimers({ now: START, toFake: ["Date"] });

        const origin = await seed("version 0");
        let newest = origin.memoryId;

        for (let index = 1; index <= 105; index += 1) {
            newest = await supersede(newest, `version ${index}`);
        }

        await asOwner().mutation(deleteMemory as never, { memoryId: newest } as never);

        // A digest the reflection saves after the delete, before the rest of the chain is erased.
        const fresh = await insertDigest([], "Learned that you like jasmine tea.", START + 1000);

        vi.setSystemTime(START + 60_000);
        await runCleanup(continuationJobs()[0]?.args);

        // The chain is done, and the digest, written after the delete began, kept its summary.
        expect(await memoryCount()).toBe(0);
        expect(await cleanups()).toHaveLength(0);

        const digest = await run(async (ctx) => await ctx.db.get("memoryDigests", fresh));

        expect(digest?.summary).toBe("Learned that you like jasmine tea.");
    });
});

const STATS = { contradictionsResolved: 0, decayed: 0, merged: 0, newMemories: 0, promoted: 0, retired: 0 };

const insertDigest = async (learned: { memory: string; memoryId: string; type: string }[], summary: string, createdAt: number) =>
    await run(async (ctx) => await ctx.db.insert("memoryDigests", { createdAt, learned, localDay: "2026-09-24", stats: STATS, summary, userId: OWNER }));

const cleanups = async () => await run(async (ctx) => await ctx.db.query("memoryCleanups").collect());
const cleanupCount = async () => {
    const rows = await cleanups();

    return rows.length;
};

/** Makes every pending cleanup due, as a lost job leaves it. */
const ageCleanups = async () =>
    await run(async (ctx) => {
        const rows = await ctx.db.query("memoryCleanups").collect();

        for (const row of rows) {
            await ctx.db.patch("memoryCleanups", row._id as Id<"memoryCleanups">, { dueAt: 0 });
        }
    });

/** The job's own run: an internal action is reached through `ctx.runAction`. */
const runCleanup = async (args: unknown) => await harness.action(async (ctx: any) => await ctx.runAction(runMemoryCleanup, args));
const cleanupJobs = () => harness.scheduler.list().filter((job) => job.functionPath?.includes("runMemoryCleanup") === true);
const memoryCount = async () => {
    const rows = await run(async (ctx) => await ctx.db.query("memories").collect());

    return rows.length;
};
const cleanupOf = async (id: Id<"memoryCleanups">) => await run(async (ctx) => await ctx.db.get("memoryCleanups", id));
const frontierOf = async (id: Id<"memoryCleanups">) => {
    const row = await cleanupOf(id);

    return row?.frontier;
};
const GAVE_UP = /Gave up .*attempts/;
const GIVE_UP_LOG = /Giving up|Gave up/;

/** A walk with `count` older versions behind a root that is already deleted, as a long delete leaves it. */
const seedChain = async (count: number): Promise<{ cleanupId: Id<"memoryCleanups">; older: Id<"memories">[] }> =>
    await run(async (ctx) => {
        const root = await ctx.db.insert("memories", { memory: "root", type: "preference", userId: OWNER });
        const older: Id<"memories">[] = [];

        for (let index = 0; index < count; index += 1) {
            older.push(await ctx.db.insert("memories", { memory: `older ${index}`, supersededBy: root, type: "preference", userId: OWNER }));
        }

        await ctx.db.delete("memories", root);

        return { cleanupId: await ctx.db.insert("memoryCleanups", { dueAt: 0, frontier: [root], kind: "chain", userId: OWNER }), older };
    });

const sweep = async () => await run(async (ctx) => await ctx.runMutation(sweepMemoryCleanups as never, {} as never));

describe("a digest summary after a delete", () => {
    it("drops the summary of every digest of the user, whatever it lists and whenever it was written", async () => {
        const unrelated = await insertDigest([], "Learned that you drink coffee.", 1);
        const first = await seed("likes tea");
        const second = await supersede(first.memoryId, "likes green tea");
        const other = await seed("owns a bike");
        // Lists the memory, though written before the row's creation time (a guest merge re-creates rows).
        const early = await insertDigest(
            [
                { memory: "likes green tea", memoryId: second, type: "preference" },
                { memory: "owns a bike", memoryId: other.memoryId, type: "preference" },
            ],
            "You now like green tea and own a bike.",
            1,
        );
        // Names no entry of the deleted memory: a merge or a promotion can still put its wording in the summary.
        const unlisted = await insertDigest(
            [{ memory: "owns a bike", memoryId: other.memoryId, type: "preference" }],
            "Merged your tea notes.",
            Date.now() - 1000,
        );

        await asOwner().mutation(deleteMemory as never, { memoryId: second } as never);

        const digestOf = async (id: Id<"memoryDigests">) => await run(async (ctx) => await ctx.db.get("memoryDigests", id));
        const [earlyRow, unlistedRow, unrelatedRow] = await Promise.all([digestOf(early), digestOf(unlisted), digestOf(unrelated)]);

        expect(earlyRow?.summary).toBe("");
        expect(unlistedRow?.summary).toBe("");
        expect(unrelatedRow?.summary).toBe("");
        // The entry that stayed is still listed.
        expect((earlyRow?.learned as { memoryId: string }[]).map((entry) => entry.memoryId)).toEqual([other.memoryId]);
    });
});

describe("a user with more digests than one write cleans", () => {
    it("takes the memory out of every digest, the rest through a cleanup record", async () => {
        const gone = await seed("likes tea");
        const other = await seed("owns a bike");

        // A guest merge can bring in a whole history: far past one page, with the memory in a late digest.
        const late = await run(async (ctx) => {
            let lateId: Id<"memoryDigests"> | undefined;

            for (let index = 0; index < 130; index += 1) {
                const learned = [{ memory: "owns a bike", memoryId: other.memoryId, type: "preference" }];

                if (index === 125) {
                    learned.push({ memory: "likes tea", memoryId: gone.memoryId, type: "preference" });
                }

                const id = await ctx.db.insert("memoryDigests", {
                    createdAt: 1000 + index,
                    learned,
                    localDay: "2026-09-24",
                    stats: STATS,
                    summary: "You like tea and own a bike.",
                    userId: OWNER,
                });

                if (index === 125) {
                    lateId = id;
                }
            }

            return lateId as Id<"memoryDigests">;
        });

        await asOwner().mutation(deleteMemory as never, { memoryId: gone.memoryId } as never);

        // The first write took one page; the rest waits in a record, with a job armed for it.
        expect(await cleanups()).toMatchObject([{ kind: "digests", userId: OWNER }]);
        expect(cleanupJobs()).toHaveLength(1);
        const lateDigest = await run(async (ctx) => await ctx.db.get("memoryDigests", late));

        expect(lateDigest?.learned).toHaveLength(2);

        await runCleanup(cleanupJobs()[0]?.args);

        const digests = await run(async (ctx) => await ctx.db.query("memoryDigests").collect());

        expect(digests).toHaveLength(130);
        expect(digests.every((digest) => digest.summary === "")).toBe(true);
        expect(digests.some((digest) => (digest.learned as { memoryId: string }[]).some((entry) => entry.memoryId === gone.memoryId))).toBe(false);
        expect(await cleanups()).toHaveLength(0);
    });
});

describe("digests that share a createdAt", () => {
    it("are all cleaned, however many, and the cleanup ends", async () => {
        const gone = await seed("likes tea");

        await run(async (ctx) => {
            for (let index = 0; index < 250; index += 1) {
                await ctx.db.insert("memoryDigests", {
                    createdAt: 7000,
                    learned: [
                        { memory: "likes tea", memoryId: gone.memoryId, type: "preference" },
                        { memory: `other ${index}`, memoryId: `other-${index}`, type: "preference" },
                    ],
                    localDay: "2026-09-24",
                    stats: STATS,
                    summary: "You like tea.",
                    userId: OWNER,
                });
            }
        });

        await asOwner().mutation(deleteMemory as never, { memoryId: gone.memoryId } as never);

        // 100 per write: the cleanup goes on until it has read them all, and then it is gone.
        for (let round = 0; round < 5 && (await cleanupCount()) > 0; round += 1) {
            await runCleanup(cleanupJobs().at(-1)?.args);
        }

        const digests = await run(async (ctx) => await ctx.db.query("memoryDigests").collect());

        expect(await cleanups()).toHaveLength(0);
        expect(digests).toHaveLength(250);
        expect(digests.every((digest) => digest.summary === "")).toBe(true);
        expect(digests.some((digest) => (digest.learned as { memoryId: string }[]).some((entry) => entry.memoryId === gone.memoryId))).toBe(false);
    });
});

describe("saving a digest while a memory is deleted", () => {
    it("keeps only entries whose memory still exists and is active, and drops the summary when it lost one", async () => {
        const kept = await seed("owns a bike");
        const gone = await seed("likes tea");
        const retired = await seed("likes coffee");
        const next = await seed("likes espresso");

        await run(async (ctx) => await supersedeMemory(ctx as never, retired.memoryId, next.memoryId, Date.now()));
        await asOwner().mutation(deleteMemory as never, { memoryId: gone.memoryId } as never);

        await run(
            async (ctx) =>
                await ctx.runMutation(
                    saveMemoryDigest as never,
                    {
                        learned: [
                            { memory: "owns a bike", memoryId: kept.memoryId, type: "preference" },
                            { memory: "likes tea", memoryId: gone.memoryId, type: "preference" },
                            { memory: "likes coffee", memoryId: retired.memoryId, type: "preference" },
                        ],
                        localDay: "2026-09-24",
                        stats: STATS,
                        summary: "You like tea and coffee and own a bike.",
                        userId: OWNER,
                    } as never,
                ),
        );

        const [digest] = await run(async (ctx) => await ctx.db.query("memoryDigests").collect());

        expect((digest?.learned as { memoryId: string }[]).map((entry) => entry.memoryId)).toEqual([kept.memoryId]);
        expect(digest?.summary).toBe("");
        expect(JSON.stringify(digest)).not.toContain("likes tea");
    });

    it("drops the summary when a source the prompt was built from is gone, though no listed entry is", async () => {
        const kept = await seed("owns a bike");
        const absorbed = await seed("lives in porto city");

        await asOwner().mutation(deleteMemory as never, { memoryId: absorbed.memoryId } as never);
        await run(
            async (ctx) =>
                await ctx.runMutation(
                    saveMemoryDigest as never,
                    {
                        learned: [{ memory: "owns a bike", memoryId: kept.memoryId, type: "preference" }],
                        localDay: "2026-09-24",
                        sourceIds: [kept.memoryId, absorbed.memoryId],
                        stats: STATS,
                        summary: "Merged your Porto notes.",
                        userId: OWNER,
                    } as never,
                ),
        );

        const [digest] = await run(async (ctx) => await ctx.db.query("memoryDigests").collect());

        expect(digest?.summary).toBe("");
        expect((digest?.learned as { memoryId: string }[]).map((entry) => entry.memoryId)).toEqual([kept.memoryId]);
    });

    it("keeps the summary when every entry is still active", async () => {
        const kept = await seed("owns a bike");

        await run(
            async (ctx) =>
                await ctx.runMutation(
                    saveMemoryDigest as never,
                    {
                        learned: [{ memory: "owns a bike", memoryId: kept.memoryId, type: "preference" }],
                        localDay: "2026-09-24",
                        sourceIds: [kept.memoryId],
                        stats: STATS,
                        summary: "You own a bike.",
                        userId: OWNER,
                    } as never,
                ),
        );

        const [digest] = await run(async (ctx) => await ctx.db.query("memoryDigests").collect());

        expect(digest?.summary).toBe("You own a bike.");
    });
});

describe("a vector delete that cannot be retried", () => {
    it("keeps a durable record and its own job when the retry cannot be scheduled, and the job deletes the vector", async () => {
        const old = await seed("likes tea");
        const next = await seed("likes green tea");

        vi.mocked(deleteVectorRow).mockRejectedValueOnce(new Error("vector index unavailable"));

        await run(async (ctx) => {
            const lost = Object.create(ctx, {
                scheduler: {
                    value: {
                        runAfter: async () => {
                            throw new Error("scheduler unavailable");
                        },
                    },
                },
            });

            await supersedeMemory(lost, old.memoryId, next.memoryId, Date.now());
        });

        expect(await supersededByOf(old.memoryId)).toBe(next.memoryId);
        expect(await vectorExists(old.embeddingId)).toBe(true);

        const pending = await cleanups();

        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ embeddingId: old.embeddingId, kind: "vector", userId: OWNER });

        // Not due yet: the sweep leaves it. Due and without a job (the scheduler was down): the sweep arms one.
        await sweep();
        expect(cleanupJobs()).toHaveLength(0);

        await ageCleanups();
        await sweep();
        expect(cleanupJobs()).toHaveLength(1);

        await runCleanup(cleanupJobs()[0]?.args);

        expect(await vectorExists(old.embeddingId)).toBe(false);
        expect(await cleanups()).toHaveLength(0);
    });

    it("keeps the record after the last scheduled attempt gives up", async () => {
        const old = await seed("likes tea");

        vi.mocked(deleteVectorRow).mockRejectedValueOnce(new Error("still down"));
        await run(
            async (ctx) => await ctx.runMutation(retryMemoryVectorDelete, { attempt: 5, embeddingId: old.embeddingId, memoryId: old.memoryId, userId: OWNER }),
        );

        expect(await vectorExists(old.embeddingId)).toBe(true);
        expect(await cleanups()).toHaveLength(1);
    });
});

describe("an older version walk past a row that points at itself", () => {
    it("erases every older version, not all but the one the self-pointing row's slot hid", async () => {
        const root = await run(async (ctx) => {
            const id = await ctx.db.insert("memories", { memory: "retired by itself", type: "preference", userId: OWNER });

            await ctx.db.patch("memories", id, { supersededBy: id });

            for (let index = 0; index < 101; index += 1) {
                await ctx.db.insert("memories", { memory: `older ${index}`, supersededBy: id, type: "preference", userId: OWNER });
            }

            return id;
        });
        const cleanupId = await run(async (ctx) => await ctx.db.insert("memoryCleanups", { dueAt: 0, frontier: [root], kind: "chain", userId: OWNER }));

        for (let round = 0; round < 3 && (await cleanupOf(cleanupId)) !== null; round += 1) {
            await run(async (ctx) => await ctx.runMutation(stepMemoryCleanup, { cleanupId }));
        }

        // Only the self-pointing row is left: it is no one's older version.
        expect(await memoryCount()).toBe(1);
        expect(await cleanupOf(cleanupId)).toBeNull();
    });
});

describe("a cleanup step that fails", () => {
    it("rolls back whole, so a retry still reaches every older version, and the failure moves the record back", async () => {
        const { cleanupId, older } = await seedChain(3);
        const chainOf = await frontierOf(cleanupId);

        // A vector delete fails and the log call after it throws: a write that deleted a row has to fail as a whole.
        const withVector = await seed("older with a vector");

        await run(async (ctx) => await ctx.db.patch("memories", withVector.memoryId, { supersededBy: (chainOf as Id<"memories">[])[0] }));
        vi.mocked(deleteVectorRow).mockRejectedValueOnce(new Error("vector index unavailable"));
        vi.mocked(memoryLogger.warn).mockImplementationOnce(() => {
            throw new Error("log sink down");
        });

        await runCleanup({ cleanupId });

        // Nothing the failed step did survived: every older row is there, the frontier is as it was.
        expect(await memoryCount()).toBe(older.length + 1);
        expect(await frontierOf(cleanupId)).toEqual(chainOf);
        // The failure is counted and the record is not due for a while.
        const failed = await run(async (ctx) => await ctx.db.get("memoryCleanups", cleanupId));

        expect(failed?.attempts).toBe(1);
        expect(failed?.dueAt).toBeGreaterThan(Date.now());
        expect(cleanupJobs()).toHaveLength(1);

        // The retry walks the same frontier to its end.
        await runCleanup({ cleanupId });

        expect(await memoryCount()).toBe(0);
        expect(await cleanups()).toHaveLength(0);
    });

    it("keeps the pass to one record and one 100-row budget per write", async () => {
        const first = await seedChain(130);
        const second = await seedChain(130);

        await sweep();

        // The sweep only arms: it deletes nothing, and each record has its own job.
        expect(await memoryCount()).toBe(260);
        expect(cleanupJobs()).toHaveLength(2);

        const step: any = await run(async (ctx) => await ctx.runMutation(stepMemoryCleanup, { cleanupId: first.cleanupId }));

        expect(step.again).toBe(true);
        expect(await memoryCount()).toBe(260 - 100);
        // The other record was not touched by that write.
        expect(await frontierOf(second.cleanupId)).toHaveLength(1);
    });

    it("moves a failing record behind the others, backs off from the first failure, and gives up at the last attempt, keeping the row", async () => {
        const NOW = 1_800_000_000_000;

        vi.useFakeTimers({ now: NOW, toFake: ["Date"] });

        const stuck = await seedChain(1);

        for (let index = 0; index < 25; index += 1) {
            await run(
                async (ctx) => await ctx.db.insert("memoryCleanups", { attempts: 1, dueAt: NOW + 3_600_000, frontier: [], kind: "chain", userId: OWNER }),
            );
        }

        const healthy = await seedChain(1);

        const fail = async () => await run(async (ctx) => await ctx.runMutation(noteMemoryCleanupFailure, { cleanupId: stuck.cleanupId }));
        const first: any = await fail();

        // The first failure backs off by 30 minutes, to the millisecond.
        expect(first.retryInMs).toBe(30 * 60 * 1000);
        const backedOff = await cleanupOf(stuck.cleanupId);

        expect(backedOff?.dueAt).toBe(NOW + 30 * 60 * 1000);

        await sweep();

        // 26 records are not due; the two that are, are armed, the failing one behind them.
        expect(cleanupJobs().map((job) => (job.args as { cleanupId: string }).cleanupId)).toEqual([healthy.cleanupId]);

        // Attempts 2 to 11 still retry, the delay doubling up to a day.
        for (let attempt = 2; attempt <= 11; attempt += 1) {
            const outcome: any = await fail();

            expect(outcome.retryInMs).toBe(Math.min(15 * 60 * 1000 * 2 ** attempt, 24 * 60 * 60 * 1000));
        }

        // The 12th is the last: it gives up, keeps the row, and puts it out of reach.
        const last: any = await fail();
        const given = await cleanupOf(stuck.cleanupId);

        expect(last.retryInMs).toBeNull();
        expect(given?.attempts).toBe(12);
        expect(given?.dueAt).toBeGreaterThan(NOW * 1000);
        expect(memoryLogger.error).toHaveBeenCalledWith(expect.stringMatching(GAVE_UP));
        // Count-only: no row text in the log.
        expect(JSON.stringify(vi.mocked(memoryLogger.error).mock.calls)).not.toContain("older 0");
    });

    it("logs no give-up error for a vector step that fails below the cap, and exactly one when the cap is reached", async () => {
        const old = await seed("likes tea");
        const next = await seed("likes green tea");

        vi.mocked(deleteVectorRow).mockRejectedValueOnce(new Error("vector index unavailable"));
        await run(async (ctx) => await supersedeMemory(ctx as never, old.memoryId, next.memoryId, Date.now()));

        const [record] = await cleanups();
        const cleanupId = record?._id as Id<"memoryCleanups">;
        const givenUp = () => vi.mocked(memoryLogger.error).mock.calls.filter(([message]) => GIVE_UP_LOG.test(String(message)));

        // A failed step well below the cap: counted, retried later, and no error logged.
        vi.mocked(deleteVectorRow).mockRejectedValueOnce(new Error("still down"));
        await runCleanup({ cleanupId });

        const afterOne = await cleanupOf(cleanupId);

        expect(afterOne?.attempts).toBe(1);
        expect(givenUp()).toHaveLength(0);

        // The step that uses the last attempt logs the one error, from the record's own failure path.
        await run(async (ctx) => await ctx.db.patch("memoryCleanups", cleanupId, { attempts: 11 }));
        vi.mocked(deleteVectorRow).mockRejectedValueOnce(new Error("still down"));
        await runCleanup({ cleanupId });

        expect(givenUp()).toHaveLength(1);
        expect(String(givenUp()[0]?.[0])).toMatch(GAVE_UP);
    });

    it("does nothing for a record that has used its attempts", async () => {
        const { cleanupId, older } = await seedChain(3);

        await run(async (ctx) => await ctx.db.patch("memoryCleanups", cleanupId, { attempts: 12 }));

        const step: any = await run(async (ctx) => await ctx.runMutation(stepMemoryCleanup, { cleanupId }));

        // Terminal: nothing walked, nothing failed, and the record is as it was, whatever its `dueAt`.
        expect(step).toMatchObject({ again: false, failed: false });
        expect(await memoryCount()).toBe(older.length);
        expect(await frontierOf(cleanupId)).toHaveLength(1);
    });

    it("counts the lookups of a walk apart from the rows it deletes, and keeps the ids it did not reach", async () => {
        // 250 ids with no older versions: each costs a read, and none a delete.
        const cleanupId = await run(async (ctx) => {
            const ids: Id<"memories">[] = [];

            for (let index = 0; index < 250; index += 1) {
                const id = await ctx.db.insert("memories", { memory: `gone ${index}`, type: "preference", userId: OWNER });

                await ctx.db.delete("memories", id);
                ids.push(id);
            }

            return await ctx.db.insert("memoryCleanups", { dueAt: 0, frontier: ids, kind: "chain", userId: OWNER });
        });

        const first: any = await run(async (ctx) => await ctx.runMutation(stepMemoryCleanup, { cleanupId }));

        expect(first.again).toBe(true);
        expect(await frontierOf(cleanupId)).toHaveLength(50);

        const second: any = await run(async (ctx) => await ctx.runMutation(stepMemoryCleanup, { cleanupId }));

        expect(second.again).toBe(false);
        expect(await cleanupOf(cleanupId)).toBeNull();
    });

    it("walks only the digests written before the delete began", async () => {
        const cleanupId = await run(async (ctx) => {
            const digest = (createdAt: number) =>
                ctx.db.insert("memoryDigests", { createdAt, learned: [], localDay: "2026-09-24", stats: STATS, summary: "kept or cleared", userId: OWNER });

            await digest(500);
            await digest(2000);

            return await ctx.db.insert("memoryCleanups", { dueAt: 0, ids: ["gone"], kind: "digests", startedAt: 1000, userId: OWNER });
        });

        await run(async (ctx) => await ctx.runMutation(stepMemoryCleanup, { cleanupId }));

        const digests = await run(async (ctx) => await ctx.db.query("memoryDigests").collect());

        // The one written after the delete began (saveMemoryDigest checked it) keeps its summary.
        expect(digests.map((digest) => [digest.createdAt, digest.summary])).toEqual(
            expect.arrayContaining([
                [500, ""],
                [2000, "kept or cleared"],
            ]),
        );
        expect(await cleanupOf(cleanupId)).toBeNull();
    });

    it("keeps a cleanup job armed for a record, so an account with no activity is still worked", async () => {
        const old = await seed("likes tea");
        const next = await seed("likes green tea");

        vi.mocked(deleteVectorRow).mockRejectedValueOnce(new Error("vector index unavailable"));
        await run(async (ctx) => await supersedeMemory(ctx as never, old.memoryId, next.memoryId, Date.now()));

        const [record] = await cleanups();

        expect(cleanupJobs()).toHaveLength(1);
        expect(cleanupJobs()[0]?.args).toMatchObject({ cleanupId: record?._id });
        // The shard is woken for it through the census as well, which reaches a shard past the housekeeping horizon.
        const census = await run(async (ctx: any) => await ctx.db.shardActivity.findFirst({ where: { shardKey: OWNER } }));

        expect(census?.nextDueAt).toBe(record?.dueAt);
    });
});

describe("a digest save reading a memory", () => {
    it("lets a database error abort the save instead of reading it as a deleted memory", async () => {
        const kept = await seed("owns a bike");

        await expect(
            run(async (ctx) => {
                const failing = new Proxy(ctx.db, {
                    get: (target, key) =>
                        key === "get"
                            ? async () => {
                                  throw new Error("transaction limit exceeded");
                              }
                            : Reflect.get(target, key),
                });

                await (saveMemoryDigest as any).handler(Object.create(ctx, { db: { value: failing } }), {
                    learned: [{ memory: "owns a bike", memoryId: kept.memoryId, type: "preference" }],
                    localDay: "2026-09-24",
                    stats: STATS,
                    summary: "You own a bike.",
                    userId: OWNER,
                });
            }),
        ).rejects.toThrow("transaction limit exceeded");
        expect(await run(async (ctx) => await ctx.db.query("memoryDigests").collect())).toHaveLength(0);
    });
});

describe("erasing an account", () => {
    it("removes the pending cleanups with the vector they still point at", async () => {
        const old = await seed("likes tea");
        const next = await seed("likes green tea");

        vi.mocked(deleteVectorRow).mockRejectedValueOnce(new Error("vector index unavailable"));
        await run(async (ctx) => await supersedeMemory(ctx as never, old.memoryId, next.memoryId, Date.now()));
        expect(await cleanups()).toHaveLength(1);

        const result: any = await run(async (ctx) => await ctx.runMutation(deleteUserMemoryReflectionData, { userId: OWNER }));

        expect(result.hasMore).toBe(false);
        expect(await cleanups()).toHaveLength(0);
        expect(await vectorExists(old.embeddingId)).toBe(false);
    });
});
