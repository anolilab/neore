/**
 * The sync and the meaning search, with the model replaced by a fake embedder.
 * The fake gives every text the same vector, so a match is decided by the mocked
 * index, not by a real model: these tests check the wiring, not the ranking.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import schema from "../schema";
import { addMessagesHandler, updateMessage } from "./messages";
import { MEANING_MIN_CHARS, MEANING_SEARCH_REFUSED } from "./thread-search-plan";
import { SYNC_RETRY } from "./thread-search-triggers";
import { runThreadSearchSync, searchThreadsByMeaningFor, visibleThreadsForSearch } from "./thread-search";

const mocks = vi.hoisted(() => {
    return {
        embeddingModelAllowed: vi.fn(() => true),
        embedMany: vi.fn(async (_ctx: unknown, { values }: { values: string[] }) => {
            return { embeddings: values.map(() => Array.from({ length: 1024 }, (_unused, index) => (index === 0 ? 1 : 0))) };
        }),
        loadModelFilterRules: vi.fn(async () => {
            return {};
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
        loadModelFilterRules: mocks.loadModelFilterRules,
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

        if (reference === internal.agent.thread_search.claimThreadSearch) {
            return { claimed: true, heldUntil: null };
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

    it("does not embed when the owner's model rules refuse the embedding model, and only records the refusal", async () => {
        mocks.embeddingModelAllowed.mockReturnValue(false);
        const ctx = makeCtx({ readThreadSearchState: readyThread() });

        await runThreadSearchSync(ctx as never, { changed: ["title"], threadId: THREAD });

        const { runMutation } = ctx as unknown as { runMutation: ReturnType<typeof vi.fn> };

        expect(mocks.embedMany).not.toHaveBeenCalled();
        expect(runMutation).toHaveBeenCalledTimes(1);
        expect(runMutation).toHaveBeenCalledWith(internal.agent.thread_search.markThreadSearchRefused, { threadId: THREAD });
    });

    it("embeds the trimmed title and commits the vector under that same text", async () => {
        const ctx = makeCtx({ readThreadSearchState: readyThread({ title: { text: "  PDF totals off by one  ", vectorId: null } }) });

        await runThreadSearchSync(ctx as never, { changed: ["title"], threadId: THREAD });

        expect(mocks.embedMany.mock.calls[0]?.[1]).toMatchObject({ values: ["PDF totals off by one"] });

        const { runMutation } = ctx as unknown as { runMutation: ReturnType<typeof vi.fn> };
        const commit = runMutation.mock.calls.find(([reference]) => reference === internal.agent.thread_search.commitThreadSearch);

        expect(commit?.[1]).toMatchObject({ embedded: [{ kind: "title", text: "PDF totals off by one" }] });
    });

    /** A claim mutation that finds these texts held by another job until `heldUntil`. */
    const heldClaim = (heldUntil: number) =>
        vi.fn(async (reference: unknown) => (reference === internal.agent.thread_search.claimThreadSearch ? { claimed: false, heldUntil } : null));

    it("sends nothing when another job's live claim already covers these texts, and syncs again once that claim lapses", async () => {
        vi.useFakeTimers({ now: 1_000_000 });

        try {
            const runQuery = vi.fn(async () => readyThread());
            const runMutation = heldClaim(1_000_000 + 240_000);
            const scheduler = { runAfter: vi.fn(async () => "job") };

            await runThreadSearchSync({ runMutation, runQuery, scheduler } as never, { changed: ["title"], threadId: THREAD });

            expect(mocks.embedMany).not.toHaveBeenCalled();
            expect(runMutation).toHaveBeenCalledTimes(1);
            // The holder may have died before committing: one sync after its claim lapses embeds what is still missing.
            expect(scheduler.runAfter).toHaveBeenCalledExactlyOnceWith(
                240_000 + 5000,
                internal.agent.thread_search.syncThreadSearch,
                { changed: [], threadId: THREAD },
                { retry: SYNC_RETRY, shardKey: "user-1" },
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("still clears a stale vector when another job's live claim covers the texts", async () => {
        const runQuery = vi.fn(async () => readyThread({ summary: { text: null, vectorId: "old-summary" } }));
        const runMutation = heldClaim(Date.now() + 60_000);
        const scheduler = { runAfter: vi.fn(async () => "job") };

        await runThreadSearchSync({ runMutation, runQuery, scheduler } as never, { changed: ["title", "summary"], threadId: THREAD });

        expect(runMutation).toHaveBeenCalledWith(internal.agent.thread_search.commitThreadSearch, {
            clear: [{ kind: "summary", vectorId: "old-summary" }],
            embedded: [],
            threadId: THREAD,
        });
    });

    it("releases its claim after the commit, whatever the outcome", async () => {
        const ctx = makeCtx({ readThreadSearchState: readyThread() });

        await runThreadSearchSync(ctx as never, { changed: ["title"], threadId: THREAD });

        const { runMutation } = ctx as unknown as { runMutation: ReturnType<typeof vi.fn> };
        const claim = runMutation.mock.calls.find(([reference]) => reference === internal.agent.thread_search.claimThreadSearch);
        const release = runMutation.mock.calls.find(([reference]) => reference === internal.agent.thread_search.releaseThreadSearch);

        expect(release?.[1]).toMatchObject({ claimId: claim?.[1]?.claimId, threadId: THREAD });
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

            if (reference === internal.agent.thread_search.claimThreadSearch) {
                return { claimed: true, heldUntil: null };
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

        const { runMutation } = ctx as unknown as { runMutation: ReturnType<typeof vi.fn> };

        expect(runMutation).not.toHaveBeenCalledWith(internal.agent.vector.insertBatch, expect.anything());
        expect(runMutation).not.toHaveBeenCalledWith(internal.agent.thread_search.commitThreadSearch, expect.anything());
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

    it("finds the visible match past stale hits that would fill the first result slots", async () => {
        const stale = Array.from({ length: 12 }, (_, index) => {
            return { _id: `vec-stale-${String(index)}`, _score: 0.95 - index * 0.001 };
        });

        mocks.searchVectors.mockImplementation(async (_ctx, _vector, args) =>
            args.table === "threadTitle" ? [...stale, { _id: "vec-pdf", _score: 0.6 }] : [],
        );
        const ctx = makeCtx({
            threadIdsForVectors: [
                ...stale.map((hit, index) => {
                    return { threadId: `thread-locked-${String(index)}`, vectorId: hit._id };
                }),
                { threadId: "thread-pdf", vectorId: "vec-pdf" },
            ],
            visibleThreads: [{ archived: false, threadId: "thread-pdf", title: "PDF totals off by one" }],
        });

        expect(await searchThreadsByMeaningFor(ctx as never, { query: "the invoice bug", userId: "user-1" })).toEqual([
            { archived: false, score: 0.6, threadId: "thread-pdf", title: "PDF totals off by one" },
        ]);
    });

    it("with archivedOnly, fills the results with archived matches ranked below more active ones than the limit", async () => {
        const active = Array.from({ length: 12 }, (_, index) => {
            return { archived: false, threadId: `thread-active-${String(index)}`, title: `Active ${String(index)}` };
        });
        const hits = [
            ...active.map((_row, index) => {
                return { _id: `vec-active-${String(index)}`, _score: 0.95 - index * 0.001 };
            }),
            { _id: "vec-archived", _score: 0.6 },
        ];

        mocks.searchVectors.mockImplementation(async (_ctx, _vector, args) => (args.table === "threadTitle" ? hits : []));
        const ctx = makeCtx({
            threadIdsForVectors: [
                ...active.map((row, index) => {
                    return { threadId: row.threadId, vectorId: `vec-active-${String(index)}` };
                }),
                { threadId: "thread-old", vectorId: "vec-archived" },
            ],
            visibleThreads: [...active, { archived: true, threadId: "thread-old", title: "Old invoice run" }],
        });

        expect(await searchThreadsByMeaningFor(ctx as never, { query: "the invoice bug", userId: "user-1" })).not.toContainEqual(
            expect.objectContaining({ threadId: "thread-old" }),
        );
        expect(await searchThreadsByMeaningFor(ctx as never, { archivedOnly: true, query: "the invoice bug", userId: "user-1" })).toEqual([
            { archived: true, score: 0.6, threadId: "thread-old", title: "Old invoice run" },
        ]);
    });

    it("rejects when the query embedding fails, so the palette can say so", async () => {
        mocks.embedMany.mockRejectedValueOnce(new Error("gateway unavailable"));

        await expect(searchThreadsByMeaningFor(makeCtx({}) as never, { query: "the invoice bug", userId: "user-1" })).rejects.toThrow("gateway unavailable");
        expect(mocks.searchVectors).not.toHaveBeenCalled();
    });

    it("throws FORBIDDEN with its own code when the model rules refuse the embedding model, not an empty list", async () => {
        mocks.embeddingModelAllowed.mockReturnValue(false);

        await expect(searchThreadsByMeaningFor(makeCtx({}) as never, { query: "the invoice bug", userId: "user-1" })).rejects.toMatchObject({
            code: "FORBIDDEN",
            data: { code: MEANING_SEARCH_REFUSED },
        });
        expect(mocks.embedMany).not.toHaveBeenCalled();
        expect(mocks.searchVectors).not.toHaveBeenCalled();
    });

    it("reads the person's model rules once per search", async () => {
        await searchThreadsByMeaningFor(makeCtx({}) as never, { query: "the invoice bug", userId: "user-1" });

        expect(mocks.loadModelFilterRules).toHaveBeenCalledTimes(1);
        expect(mocks.embedMany).toHaveBeenCalledTimes(1);
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

describe("visibleThreadsForSearch, with the messages triggers keeping the turn count", () => {
    const OWNER = "owner-visible";

    /** A thread with four user turns, written by the real message writer so the triggers count them. */
    const threadWithFourTurns = async () => {
        const harness = lunoraTest(schema as never);
        const run = <T>(body: (ctx: any) => Promise<T>): Promise<T> => harness.run(body as never);
        const threadId = await run(async (ctx) => await ctx.db.insert("threads", { status: "active", title: "PDF totals off by one", userId: OWNER }));
        const messageIds: string[] = [];

        for (const text of ["one", "two", "three", "four"]) {
            const { messages } = await run(
                async (ctx) =>
                    await addMessagesHandler(ctx, {
                        messages: [{ message: { content: [{ text, type: "text" }], role: "user" }, status: "success" } as never],
                        threadId,
                        userId: OWNER,
                    }),
            );

            messageIds.push(String(messages[0]?._id));
        }

        const visible = async () => await run(async (ctx) => await ctx.runQuery(visibleThreadsForSearch, { threadIds: [threadId], userId: OWNER }));
        const turns = async () =>
            await run(async (ctx) => {
                const thread = await ctx.db.get("threads", threadId);

                return thread?.userTurnCount;
            });

        return { messageIds, run, turns, visible };
    };

    it("drops a thread a delete took back below the gate, while its vector cleanup is still queued", async () => {
        const { messageIds, run, turns, visible } = await threadWithFourTurns();

        expect(await visible()).toHaveLength(1);

        await run(async (ctx) => await ctx.db.delete("messages", messageIds[3]));

        expect(await turns()).toBe(3);
        expect(await visible()).toStrictEqual([]);
    });

    it("counts a user turn overwritten as the assistant's out of the gate", async () => {
        const { messageIds, run, turns } = await threadWithFourTurns();

        // A pending row overwritten as the assistant's (an abandoned reply, `updateMessage`) is no longer a user turn.
        await run(
            async (ctx) =>
                await ctx.runMutation(updateMessage, {
                    messageId: messageIds[3],
                    patch: { message: { content: [{ text: "stopped", type: "text" }], role: "assistant" } },
                }),
        );

        expect(await turns()).toBe(3);
    });
});
