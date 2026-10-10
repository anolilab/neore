/**
 * `search` embeds the query once, as the REQUESTER, and hands that vector to
 * every scope it searches — its own shard's files and each shared collection
 * on its owner's shard. It used to embed per owner, billed to the owner.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import { searchKnowledgeBase } from "./retrieve";

const mocks = vi.hoisted(() => {
    return {
        callOnShard: vi.fn(async () => []),
        createGatewayEmbeddingModel: vi.fn((_gateway: unknown, { userId }: { userId: string }) => {
            return { billedTo: userId };
        }),
        embedMany: vi.fn(async () => {
            return { embeddings: [Array.from({ length: 768 }, (_unused, index) => index / 768)] };
        }),
        searchVectors: vi.fn(async () => []),
    };
});

vi.mock("../chat/lib/gateway-embedding-model", () => {
    return { createGatewayEmbeddingModel: mocks.createGatewayEmbeddingModel };
});
vi.mock("../agent/client/search", () => {
    return { embedMany: mocks.embedMany };
});
vi.mock("../agent/vector/index", () => {
    return { searchVectors: mocks.searchVectors };
});
vi.mock("../lib/cross-shard", () => {
    return { callOnShard: mocks.callOnShard };
});

const REQUESTER = "user-member";

const makeCtx = (scope: { fileIds: string[]; foreign: { collectionIds: string[]; ownerId: string }[]; hasExplicitScope: boolean }) => {
    const runQuery = vi.fn(async (reference: unknown) => {
        if (reference === internal.knowledge.collections.resolveRetrievalScope) {
            return scope;
        }

        if (reference === internal.knowledge.functions.getIndexedFileIds) {
            return ["own-1", "own-2"];
        }

        return [];
    });

    return { runQuery } as never;
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe(searchKnowledgeBase, () => {
    it("embeds once under the requester and reuses the vector for every owner's shared collections", async () => {
        const ctx = makeCtx({
            fileIds: ["own-1"],
            foreign: [
                { collectionIds: ["c-a"], ownerId: "owner-a" },
                { collectionIds: ["c-b"], ownerId: "owner-b" },
            ],
            hasExplicitScope: true,
        });

        await searchKnowledgeBase(ctx, { query: "refund policy", threadId: "t1", userId: REQUESTER });

        expect(mocks.embedMany).toHaveBeenCalledOnce();
        // Over the action's gateway binding (`gatewayFetch(ctx)`), billed to the requester.
        expect(mocks.createGatewayEmbeddingModel).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { userId: REQUESTER });
        expect(mocks.callOnShard).toHaveBeenCalledTimes(2);

        for (const [, callArgs] of mocks.callOnShard.mock.calls as unknown as [unknown, { queryVector: number[]; requesterId: string }][]) {
            expect(callArgs.requesterId).toBe(REQUESTER);
            expect(callArgs.queryVector).toHaveLength(768);
        }
    });

    it("asks Vectorize for a wide top-K when the scope is a subset of the owner's index, a narrow one otherwise", async () => {
        await searchKnowledgeBase(makeCtx({ fileIds: ["own-1"], foreign: [], hasExplicitScope: true }), { query: "q", threadId: "t1", userId: REQUESTER });
        await searchKnowledgeBase(makeCtx({ fileIds: [], foreign: [], hasExplicitScope: false }), { query: "q", threadId: "t1", userId: REQUESTER });

        const limits = (mocks.searchVectors.mock.calls as unknown as [unknown, unknown, { limit: number; searchAllMessagesForUserId: string }][]).map(
            (call) => [call[2].limit, call[2].searchAllMessagesForUserId],
        );

        expect(limits).toStrictEqual([
            [100, REQUESTER],
            [15, REQUESTER],
        ]);
    });

    it("still runs the keyword leg when the query cannot be embedded", async () => {
        mocks.createGatewayEmbeddingModel.mockImplementationOnce(() => {
            throw new Error("the gateway's service binding is not bound");
        });

        const ctx = makeCtx({ fileIds: ["own-1"], foreign: [{ collectionIds: ["c-a"], ownerId: "owner-a" }], hasExplicitScope: true });

        await expect(searchKnowledgeBase(ctx, { query: "q", threadId: "t1", userId: REQUESTER })).resolves.toStrictEqual([]);
        expect(mocks.searchVectors).not.toHaveBeenCalled();
        expect((mocks.callOnShard.mock.calls[0] as unknown as [unknown, { queryVector: unknown }])[1].queryVector).toBeNull();
        expect((ctx as unknown as { runQuery: ReturnType<typeof vi.fn> }).runQuery).toHaveBeenCalledWith(
            internal.knowledge.functions.keywordSearchChunks,
            expect.objectContaining({ knowledgeFileIds: ["own-1"] }),
        );
    });
});
