/**
 * A memory's embedding is deleted AFTER its row, and a failed vector delete is
 * logged and retried from the scheduler instead of being swallowed — the
 * embedding would otherwise be orphaned for good.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { memoryLogger } from "../lib/logger";
import schema from "../schema";
import { deleteVectorRow } from "../agent/table-writes";
import { clearAllUserMemories, deleteMemory, retryMemoryVectorDelete } from "./functions";

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

let harness: ReturnType<typeof lunoraTest>;
let memoryId: string;
let embeddingId: string;

const run = <T>(body: (ctx: any) => Promise<T>): Promise<T> => harness.run(body as never);
const asOwner = () => harness.withIdentity({ userId: OWNER } as never);
const jobs = () => harness.scheduler.list().filter((job) => job.functionPath?.includes("retryMemoryVectorDelete") === true);

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    vi.spyOn(memoryLogger, "warn").mockImplementation(() => undefined);
    vi.spyOn(memoryLogger, "error").mockImplementation(() => undefined);

    ({ embeddingId, memoryId } = await run(async (ctx) => {
        const embedding = await ctx.db.insert("embeddings_768", { model: "m", table: "memories", userId: OWNER, vector: Array.from({ length: 768 }, () => 0.1) });
        const memory = await ctx.db.insert("memories", { embeddingId: embedding, memory: "likes tea", type: "preference", userId: OWNER });

        return { embeddingId: embedding as string, memoryId: memory as string };
    }));
});

afterEach(() => {
    harness.close();
    vi.restoreAllMocks();
});

describe("memory vector deletion", () => {
    it("deletes the row and the vector when nothing fails", async () => {
        await asOwner().mutation(deleteMemory as never, { memoryId } as never);

        expect(await run(async (ctx) => await ctx.db.get(memoryId))).toBeNull();
        expect(await run(async (ctx) => await ctx.db.get(embeddingId))).toBeNull();
        expect(jobs()).toHaveLength(0);
    });

    it("keeps the row delete, logs and schedules a retry when the vector delete fails", async () => {
        vi.mocked(deleteVectorRow).mockRejectedValueOnce(new Error("vector index unavailable"));

        await asOwner().mutation(deleteMemory as never, { memoryId } as never);

        expect(await run(async (ctx) => await ctx.db.get(memoryId))).toBeNull();
        // The orphan is still there, but it is no longer silent: logged with its ids, retry queued.
        expect(await run(async (ctx) => await ctx.db.get(embeddingId))).not.toBeNull();
        expect(memoryLogger.warn).toHaveBeenCalledWith(expect.stringContaining(embeddingId), expect.any(Error));
        expect(jobs()).toHaveLength(1);
        expect(jobs()[0]?.args).toMatchObject({ attempt: 2, embeddingId, memoryId, userId: OWNER });
    });

    it("records the retry for a failed vector delete during clear-all as well", async () => {
        vi.mocked(deleteVectorRow).mockRejectedValueOnce(new Error("vector index unavailable"));

        await asOwner().mutation(clearAllUserMemories as never, {} as never);

        expect(await run(async (ctx) => await ctx.db.get(memoryId))).toBeNull();
        expect(jobs()).toHaveLength(1);
    });

    it("the retry removes the vector, and gives up loudly after the last attempt", async () => {
        await run(async (ctx) => await ctx.runMutation(retryMemoryVectorDelete, { attempt: 2, embeddingId, memoryId, userId: OWNER }));

        expect(await run(async (ctx) => await ctx.db.get(embeddingId))).toBeNull();

        const other = await run(async (ctx) => await ctx.db.insert("embeddings_768", { model: "m", table: "memories", userId: OWNER, vector: Array.from({ length: 768 }, () => 0.1) }));

        vi.mocked(deleteVectorRow).mockRejectedValue(new Error("still down"));
        await run(async (ctx) => await ctx.runMutation(retryMemoryVectorDelete, { attempt: 5, embeddingId: other, memoryId, userId: OWNER }));

        expect(memoryLogger.error).toHaveBeenCalledWith(expect.stringContaining(other as string), expect.any(Error));
        expect(jobs()).toHaveLength(0);
    });
});
