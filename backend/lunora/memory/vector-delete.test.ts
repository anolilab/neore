/**
 * A memory's embedding is deleted AFTER its row, and a failed vector delete is
 * logged and retried from the scheduler instead of being swallowed — the
 * embedding would otherwise be orphaned for good.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Id } from "../_generated/dataModel";
import { memoryLogger } from "../lib/logger";
import schema from "../schema";
import { deleteVectorRow } from "../agent/table-writes";
import { getVectorIdInfo } from "../agent/vector/tables";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { clearAllUserMemories, deleteMemory, linkMemoryEmbeddings, retryMemoryVectorDelete, updateMemoryInternal } from "./functions";

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

vi.mock("../lib/shard-scheduler", async (importOriginal) => {
    const original = await importOriginal<typeof import("../lib/shard-scheduler")>();

    return { ...original, runAfterOnShard: vi.fn(original.runAfterOnShard) };
});

vi.mock("../agent/vector/tables", async (importOriginal) => {
    const original = await importOriginal<typeof import("../agent/vector/tables")>();

    return { ...original, getVectorIdInfo: vi.fn(original.getVectorIdInfo) };
});

const OWNER = "owner-user";

let harness: ReturnType<typeof lunoraTest>;
let memoryId: Id<"memories">;
let embeddingId: Id<"embeddings_768">;

type Ctx = Parameters<Parameters<ReturnType<typeof lunoraTest>["run"]>[0]>[0];

const run = <T>(body: (ctx: Ctx) => Promise<T>): Promise<T> => harness.run(body);
const asOwner = () => harness.withIdentity({ userId: OWNER } as never);
const jobs = () => harness.scheduler.list().filter((job) => job.functionPath?.includes("retryMemoryVectorDelete") === true);

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    vi.spyOn(memoryLogger, "warn").mockImplementation(() => undefined);
    vi.spyOn(memoryLogger, "error").mockImplementation(() => undefined);

    ({ embeddingId, memoryId } = await run(async (ctx) => {
        const embedding = await ctx.db.insert("embeddings_768", {
            model: "m",
            table: "memories",
            userId: OWNER,
            vector: Array.from({ length: 768 }, (_, index) => index / 768),
        });
        const memory = await ctx.db.insert("memories", { embeddingId: embedding, memory: "likes tea", type: "preference", userId: OWNER });

        return { embeddingId: embedding, memoryId: memory };
    }));
});

afterEach(() => {
    harness.close();
    vi.restoreAllMocks();
});

describe("memory vector deletion", () => {
    it("deletes the row and the vector when nothing fails", async () => {
        await asOwner().mutation(deleteMemory as never, { memoryId } as never);

        expect(await run(async (ctx) => await ctx.db.get("memories", memoryId))).toBeNull();
        expect(await run(async (ctx) => await ctx.db.get("embeddings_768", embeddingId))).toBeNull();
        expect(jobs()).toHaveLength(0);
        // The table `getVectorIdInfo` found is handed down, so the delete does not probe for it again.
        expect(deleteVectorRow).toHaveBeenCalledWith(expect.anything(), embeddingId, "embeddings_768");
    });

    it("keeps the row delete, logs and schedules a retry when the vector delete fails", async () => {
        vi.mocked(deleteVectorRow).mockRejectedValueOnce(new Error("vector index unavailable"));

        await asOwner().mutation(deleteMemory as never, { memoryId } as never);

        expect(await run(async (ctx) => await ctx.db.get("memories", memoryId))).toBeNull();
        // The orphan is still there, but it is no longer silent: logged with its ids, retry queued.
        expect(await run(async (ctx) => await ctx.db.get("embeddings_768", embeddingId))).not.toBeNull();
        expect(memoryLogger.warn).toHaveBeenCalledWith(expect.stringContaining(embeddingId), expect.any(Error));
        expect(jobs()).toHaveLength(1);
        expect(jobs()[0]?.args).toMatchObject({ attempt: 2, embeddingId, memoryId, userId: OWNER });
    });

    it("records the retry for a failed vector delete during clear-all as well", async () => {
        vi.mocked(deleteVectorRow).mockRejectedValueOnce(new Error("vector index unavailable"));

        await asOwner().mutation(clearAllUserMemories as never, {} as never);

        expect(await run(async (ctx) => await ctx.db.get("memories", memoryId))).toBeNull();
        expect(jobs()).toHaveLength(1);
    });

    it("the retry removes the vector, and gives up loudly after the last attempt", async () => {
        await run(async (ctx) => await ctx.runMutation(retryMemoryVectorDelete, { attempt: 2, embeddingId, memoryId, userId: OWNER }));

        expect(await run(async (ctx) => await ctx.db.get("embeddings_768", embeddingId))).toBeNull();

        const other = await run(
            async (ctx) =>
                await ctx.db.insert("embeddings_768", {
                    model: "m",
                    table: "memories",
                    userId: OWNER,
                    vector: Array.from({ length: 768 }, (_, index) => index / 768),
                }),
        );

        vi.mocked(deleteVectorRow).mockRejectedValue(new Error("still down"));
        await run(async (ctx) => await ctx.runMutation(retryMemoryVectorDelete, { attempt: 5, embeddingId: other, memoryId, userId: OWNER }));

        expect(memoryLogger.error).toHaveBeenCalledWith(expect.stringContaining(other as string), expect.any(Error));
        expect(jobs()).toHaveLength(0);
    });

    it("deletes the memory and records the vector when its table cannot be found, never reading that as gone", async () => {
        vi.mocked(getVectorIdInfo).mockImplementationOnce(() => {
            throw new Error("read failed");
        });

        await asOwner().mutation(deleteMemory as never, { memoryId } as never);

        expect(await run(async (ctx) => await ctx.db.get("memories", memoryId))).toBeNull();
        expect(memoryLogger.error).toHaveBeenCalledWith(expect.stringContaining(embeddingId), expect.any(Error));
        expect(deleteVectorRow).not.toHaveBeenCalled();
        expect(jobs()).toHaveLength(0);
        // The record is what finds the vector again: a failed read is not proof that it is gone.
        const records = await run(async (ctx) => await ctx.db.query("memoryCleanups").collect());

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ embeddingId, kind: "vector" });
    });

    it("returns quietly, without an error log, when the vector is already gone", async () => {
        await run(async (ctx) => await ctx.db.delete("embeddings_768", embeddingId));

        await asOwner().mutation(deleteMemory as never, { memoryId } as never);

        expect(await run(async (ctx) => await ctx.db.get("memories", memoryId))).toBeNull();
        expect(memoryLogger.error).not.toHaveBeenCalled();
        expect(deleteVectorRow).not.toHaveBeenCalled();
        expect(jobs()).toHaveLength(0);
    });
});

describe("re-embedding a reworded memory", () => {
    // `restoreAllMocks` leaves a `vi.fn`'s own implementation: drop what earlier tests stubbed.
    beforeEach(() => {
        vi.mocked(getVectorIdInfo).mockReset();
        vi.mocked(deleteVectorRow).mockReset();
    });

    const insertVector = async (): Promise<Id<"embeddings_768">> =>
        await run(
            async (ctx) =>
                await ctx.db.insert("embeddings_768", {
                    model: "m",
                    table: "memories",
                    userId: OWNER,
                    vector: Array.from({ length: 768 }, (_, index) => index / 768),
                }),
        );
    const rowEmbedding = async (): Promise<string | undefined> =>
        await run(async (ctx) => {
            const row = await ctx.db.get("memories", memoryId);

            return row?.embeddingId as string | undefined;
        });
    const vectorExists = async (id: Id<"embeddings_768">): Promise<boolean> => (await run(async (ctx) => await ctx.db.get("embeddings_768", id))) !== null;

    it("schedules the re-embed on the owner's shard", async () => {
        await run(async (ctx) => await ctx.runMutation(updateMemoryInternal as never, { memory: "likes green tea", memoryId } as never));

        expect(runAfterOnShard).toHaveBeenCalledWith(expect.anything(), 0, expect.anything(), { memoryId, userId: OWNER }, OWNER);
    });

    it("keeps the newer wording's vector when two re-embeds finish in reverse order", async () => {
        // The job for "likes tea" embedded before the row was reworded; the job for the new wording finishes first.
        const forOldWording = await insertVector();
        const forNewWording = await insertVector();

        await run(async (ctx) => await ctx.db.patch("memories", memoryId, { memory: "likes green tea" }));

        const link = async (vector: Id<"embeddings_768">, text: string): Promise<void> => {
            await run(
                async (ctx) =>
                    await ctx.runMutation(linkMemoryEmbeddings as never, { links: [{ embeddingId: vector, memoryId, text }], userId: OWNER } as never),
            );
        };

        await link(forNewWording, "likes green tea");
        await link(forOldWording, "likes tea");

        expect(await rowEmbedding()).toBe(forNewWording);
        // The original vector and the late job's vector are both gone; only the one for the row's text is left.
        expect(await vectorExists(embeddingId)).toBe(false);
        expect(await vectorExists(forOldWording)).toBe(false);
        expect(await vectorExists(forNewWording)).toBe(true);
    });

    it("deletes the new vector when its row is gone", async () => {
        const late = await insertVector();

        await run(async (ctx) => await ctx.db.delete("memories", memoryId));

        await run(
            async (ctx) =>
                await ctx.runMutation(linkMemoryEmbeddings as never, { links: [{ embeddingId: late, memoryId, text: "likes tea" }], userId: OWNER } as never),
        );

        expect(await vectorExists(late)).toBe(false);
    });

    it("drops the old vector with the rewording, before the re-embed runs", async () => {
        await run(async (ctx) => await ctx.runMutation(updateMemoryInternal as never, { memory: "likes green tea", memoryId } as never));

        expect(await rowEmbedding()).toBeUndefined();
        expect(await vectorExists(embeddingId)).toBe(false);

        // A metadata update keeps the vector, which still matches the wording.
        const fresh = await insertVector();

        await run(
            async (ctx) =>
                await ctx.runMutation(
                    linkMemoryEmbeddings as never,
                    { links: [{ embeddingId: fresh, memoryId, text: "likes green tea" }], userId: OWNER } as never,
                ),
        );
        await run(async (ctx) => await ctx.runMutation(updateMemoryInternal as never, { confidence: 90, memoryId } as never));

        expect(await rowEmbedding()).toBe(fresh);
    });
});
