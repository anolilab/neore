/**
 * The sync and the meaning search, with the model replaced by a fake embedder.
 * The fake gives every text the same vector, so a match is decided by the mocked
 * index, not by a real model: these tests check the wiring, not the ranking.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import { MEANING_MIN_CHARS } from "./thread-search-plan";
import { runThreadSearchSync, searchThreadsByMeaningFor } from "./thread-search";

const mocks = vi.hoisted(() => {
    return {
        embeddingModelAllowed: vi.fn(() => true),
        embedMany: vi.fn(async (_ctx: unknown, { values }: { values: string[] }) => {
            return { embeddings: values.map(() => Array.from({ length: 1024 }, (_unused, index) => (index === 0 ? 1 : 0))) };
        }),
        searchVectors: vi.fn(async (_ctx: unknown, _vector: number[], _args: { table: string }) => [] as { _id: string; _score: number }[]),
    };
});

vi.mock("../chat/lib/gateway-embedding-model", () => {
    return {
        createGatewayEmbeddingModel: () => {
            return {};
        },
        embeddingModelAllowed: mocks.embeddingModelAllowed,
    };
});
vi.mock("../chat/lib/model-filter-rules", () => {
    return {
        loadModelFilterRules: async () => {
            return {};
        },
    };
});
vi.mock("../lib/services", () => {
    return { gatewayFetch: () => async () => new Response(null) };
});
vi.mock("./client/search", () => {
    return { embedMany: mocks.embedMany };
});
vi.mock("./vector", () => {
    return { searchVectors: mocks.searchVectors };
});

const THREAD = "thread-pdf" as never;

interface Fixture {
    readThreadSearchState?: unknown;
    threadIdsForVectors?: { threadId: string | null; vectorId: string }[];
    visibleThreads?: { archived: boolean; threadId: string; title: string | null }[];
}

const makeCtx = (fixture: Fixture) => {
    const runQuery = vi.fn(async (reference: unknown) => {
        if (reference === internal.agent.thread_search.readThreadSearchState) {
            return fixture.readThreadSearchState ?? null;
        }

        if (reference === internal.agent.thread_search.threadIdsForVectors) {
            return fixture.threadIdsForVectors ?? [];
        }

        if (reference === internal.agent.thread_search.visibleThreadsForSearch) {
            return fixture.visibleThreads ?? [];
        }

        return null;
    });
    const runMutation = vi.fn(async (reference: unknown, args: { ids?: string[]; vectors?: unknown[] }) => {
        if (reference === internal.agent.vector.insertBatch) {
            return (args.vectors ?? []).map((_vector, index) => `vec-${String(index)}`);
        }

        return null;
    });

    return { runMutation, runQuery } as never;
};

const readyThread = (overrides: Record<string, unknown> = {}) => {
    return {
        eligible: true,
        enoughTurns: true,
        summary: { text: null, vectorId: null },
        title: { text: "PDF totals off by one", vectorId: null },
        userId: "user-1",
        ...overrides,
    };
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.embeddingModelAllowed.mockReturnValue(true);
});

describe(runThreadSearchSync, () => {
    it("embeds the title of an eligible thread past the turn gate and commits it", async () => {
        const ctx = makeCtx({ readThreadSearchState: readyThread() });

        await runThreadSearchSync(ctx as never, { changed: ["title"], threadId: THREAD });

        expect(mocks.embedMany).toHaveBeenCalledOnce();
        expect(mocks.embedMany.mock.calls[0]?.[1]).toMatchObject({ userId: "user-1", values: ["PDF totals off by one"] });
    });

    it("embeds nothing for a locked thread, and clears the vectors it still holds", async () => {
        const ctx = makeCtx({
            readThreadSearchState: readyThread({ eligible: false, title: { text: "Secret", vectorId: "stored-title" } }),
        });

        await runThreadSearchSync(ctx as never, { changed: ["title", "summary"], threadId: THREAD });

        expect(mocks.embedMany).not.toHaveBeenCalled();
        expect((ctx as unknown as { runMutation: ReturnType<typeof vi.fn> }).runMutation).toHaveBeenCalledWith(
            internal.agent.thread_search.commitThreadSearch,
            { clear: [{ kind: "title", vectorId: "stored-title" }], embedded: [], threadId: THREAD },
        );
    });

    it("embeds nothing for a thread with three user turns or fewer", async () => {
        const ctx = makeCtx({ readThreadSearchState: readyThread({ enoughTurns: false }) });

        await runThreadSearchSync(ctx as never, { changed: ["title"], threadId: THREAD });

        expect(mocks.embedMany).not.toHaveBeenCalled();
    });

    it("does not embed when the owner's model rules refuse the embedding model, and writes nothing", async () => {
        mocks.embeddingModelAllowed.mockReturnValue(false);
        const ctx = makeCtx({ readThreadSearchState: readyThread() });

        await runThreadSearchSync(ctx as never, { changed: ["title"], threadId: THREAD });

        expect(mocks.embedMany).not.toHaveBeenCalled();
        expect((ctx as unknown as { runMutation: ReturnType<typeof vi.fn> }).runMutation).not.toHaveBeenCalled();
    });

    it("embeds the trimmed title and commits the vector under that same text", async () => {
        const ctx = makeCtx({ readThreadSearchState: readyThread({ title: { text: "  PDF totals off by one  ", vectorId: null } }) });

        await runThreadSearchSync(ctx as never, { changed: ["title"], threadId: THREAD });

        expect(mocks.embedMany.mock.calls[0]?.[1]).toMatchObject({ values: ["PDF totals off by one"] });

        const { runMutation } = ctx as unknown as { runMutation: ReturnType<typeof vi.fn> };
        const commit = runMutation.mock.calls.find(([reference]) => reference === internal.agent.thread_search.commitThreadSearch);

        expect(commit?.[1]).toMatchObject({ embedded: [{ kind: "title", text: "PDF totals off by one" }] });
    });

    it("deletes the vectors it already wrote when a later insert fails, and throws so the scheduler retries", async () => {
        let inserts = 0;
        const runMutation = vi.fn(async (reference: unknown) => {
            if (reference === internal.agent.vector.insertBatch) {
                inserts += 1;

                if (inserts === 2) {
                    throw new Error("insert down");
                }

                return ["vec-title"];
            }

            return null;
        });
        const runQuery = vi.fn(async () => readyThread({ summary: { text: "A summary", vectorId: null } }));

        await expect(runThreadSearchSync({ runMutation, runQuery } as never, { changed: ["title", "summary"], threadId: THREAD })).rejects.toThrow(
            "insert down",
        );

        expect(runMutation).toHaveBeenCalledWith(internal.agent.vector.deleteBatch, { ids: ["vec-title"] });
        expect(runMutation).not.toHaveBeenCalledWith(internal.agent.thread_search.commitThreadSearch, expect.anything());
    });

    it("keeps the stored vectors, writes nothing, and throws so the scheduler retries when the embedder fails", async () => {
        mocks.embedMany.mockRejectedValueOnce(new Error("gateway down"));
        const ctx = makeCtx({ readThreadSearchState: readyThread({ title: { text: "Moved", vectorId: "old" } }) });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await expect(runThreadSearchSync(ctx as never, { changed: ["title"], threadId: THREAD })).rejects.toThrow("gateway down");

        expect((ctx as unknown as { runMutation: ReturnType<typeof vi.fn> }).runMutation).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it("sends no text to the gateway, and commits nothing, when a lock lands after the plan read the thread", async () => {
        const reads = [readyThread(), readyThread({ eligible: false })];
        const runQuery = vi.fn(async () => reads.shift() ?? null);
        const runMutation = vi.fn(async () => []);

        await runThreadSearchSync({ runMutation, runQuery } as never, { changed: ["title"], threadId: THREAD });

        expect(mocks.embedMany).not.toHaveBeenCalled();
        expect(runMutation).not.toHaveBeenCalled();
    });

    it("sends no text to the gateway when the title changed after the plan read the thread", async () => {
        const reads = [readyThread(), readyThread({ title: { text: "Edited title", vectorId: null } })];
        const runQuery = vi.fn(async () => reads.shift() ?? null);
        const runMutation = vi.fn(async () => []);

        await runThreadSearchSync({ runMutation, runQuery } as never, { changed: ["title"], threadId: THREAD });

        expect(mocks.embedMany).not.toHaveBeenCalled();
    });
});

describe(searchThreadsByMeaningFor, () => {
    it("finds 'PDF totals off by one' for 'the invoice bug' through its title vector", async () => {
        mocks.searchVectors.mockImplementation(async (_ctx, _vector, args) => (args.table === "threadTitle" ? [{ _id: "vec-title", _score: 0.82 }] : []));
        const ctx = makeCtx({
            threadIdsForVectors: [{ threadId: "thread-pdf", vectorId: "vec-title" }],
            visibleThreads: [{ archived: false, threadId: "thread-pdf", title: "PDF totals off by one" }],
        });

        const results = await searchThreadsByMeaningFor(ctx as never, { query: "the invoice bug", userId: "user-1" });

        expect(results).toEqual([{ archived: false, score: 0.82, threadId: "thread-pdf", title: "PDF totals off by one" }]);
        expect(mocks.searchVectors).toHaveBeenCalledWith(
            expect.anything(),
            expect.any(Array),
            expect.objectContaining({ searchAllMessagesForUserId: "user-1" }),
        );
    });

    it("drops a match whose thread the owner may no longer see (locked, deleted, or someone else's)", async () => {
        mocks.searchVectors.mockImplementation(async (_ctx, _vector, args) => (args.table === "threadTitle" ? [{ _id: "vec-title", _score: 0.9 }] : []));
        const ctx = makeCtx({
            threadIdsForVectors: [{ threadId: "thread-locked", vectorId: "vec-title" }],
            visibleThreads: [],
        });

        expect(await searchThreadsByMeaningFor(ctx as never, { query: "the invoice bug", userId: "user-1" })).toEqual([]);
    });

    it("answers nothing for a query too short to embed", async () => {
        const ctx = makeCtx({});

        expect(await searchThreadsByMeaningFor(ctx as never, { query: "a".repeat(MEANING_MIN_CHARS - 1), userId: "user-1" })).toEqual([]);
        expect(mocks.embedMany).not.toHaveBeenCalled();
    });

    it("answers nothing below the minimum score", async () => {
        mocks.searchVectors.mockImplementation(async (_ctx, _vector, args) => (args.table === "threadTitle" ? [{ _id: "vec-title", _score: 0.1 }] : []));
        const ctx = makeCtx({ threadIdsForVectors: [{ threadId: "thread-pdf", vectorId: "vec-title" }] });

        expect(await searchThreadsByMeaningFor(ctx as never, { query: "the invoice bug", userId: "user-1" })).toEqual([]);
    });
});
