/**
 * A retired memory (superseded, merged, decayed, expired) keeps its row as history but loses its vector, and deleting a
 * memory takes its older versions and its digest entries with it.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteVectorRow } from "../agent/table-writes";
import type { Id } from "../_generated/dataModel";
import { memoryLogger } from "../lib/logger";
import schema from "../schema";
import { continueMemoryChainDelete, deleteMemory, linkMemoryEmbeddings, saveMemory, saveMemoryBatch } from "./functions";
import { applyReflectionOps } from "./reflection";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
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
const continuationJobs = () => harness.scheduler.list().filter((job) => job.functionPath?.includes("continueMemoryChainDelete") === true);

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

beforeEach(() => {
    harness = lunoraTest(schema as never);
    vi.spyOn(memoryLogger, "warn").mockImplementation(() => undefined);
    vi.spyOn(memoryLogger, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    harness.close();
    vi.restoreAllMocks();
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

    it("continues a long chain in a follow-up write until every older version is gone", async () => {
        const origin = await seed("version 0");
        let newest = origin.memoryId;
        const first = newest;

        for (let index = 1; index <= 105; index += 1) {
            newest = await supersede(newest, `version ${index}`);
        }

        await asOwner().mutation(deleteMemory as never, { memoryId: newest } as never);

        expect(continuationJobs()).toHaveLength(1);
        // The oldest rows are still there until the follow-up runs.
        expect(await rowOf(first)).not.toBeNull();

        await run(async (ctx) => await ctx.runMutation(continueMemoryChainDelete, continuationJobs()[0]?.args as never));

        expect(await rowOf(first)).toBeNull();
        expect(await run(async (ctx) => await ctx.db.query("memories").collect())).toHaveLength(0);
    });
});
