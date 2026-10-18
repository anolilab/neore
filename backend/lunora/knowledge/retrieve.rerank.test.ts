/**
 * The reranker reorders the fused candidates; whatever goes wrong with it, the
 * caller still gets the fused order cut to five.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import { applyRerank, RERANK_CANDIDATES, searchKnowledgeBase } from "./retrieve";

const mocks = vi.hoisted(() => {
    return {
        callOnShard: vi.fn(async () => []),
        gateway: vi.fn(),
    };
});

vi.mock("../chat/lib/gateway-embedding-model", () => {
    return {
        createGatewayEmbeddingModel: () => {
            return {};
        },
    };
});
vi.mock("../agent/client/search", () => {
    return {
        embedMany: async () => {
            return { embeddings: [Array.from({ length: 768 }, (_unused, index) => index / 768)] };
        },
    };
});
vi.mock("../agent/vector/index", () => {
    return { searchVectors: async () => [] };
});
vi.mock("../lib/cross-shard", () => {
    return { callOnShard: mocks.callOnShard };
});
vi.mock("../lib/services", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/services")>()), gatewayFetch: () => mocks.gateway };
});

const hit = (n: number) => {
    return { chunkId: `c${String(n)}`, chunkIndex: n, content: `chunk ${String(n)}`, fileId: "f", fileName: "f.md", score: 1 / (60 + n) };
};
const candidates = (count: number) => Array.from({ length: count }, (_, i) => hit(i + 1));

describe(applyRerank, () => {
    it("is the fused order cut to five without scores", () => {
        expect(applyRerank(candidates(12), null).map((h) => h.chunkId)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
        expect(applyRerank(candidates(12), []).map((h) => h.chunkId)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    });

    it("leaves five or fewer candidates alone", () => {
        const few = candidates(4);

        expect(applyRerank(few, [{ index: 3, score: 1 }])).toEqual(few);
    });

    it("promotes a candidate the reranker rates far above the rest", () => {
        const scores = candidates(12).map((_, index) => {
            return { index, score: index === 9 ? 0.99 : 0.1 - index / 1000 };
        });
        const ids = applyRerank(candidates(12), scores).map((h) => h.chunkId);

        expect(ids).toContain("c10");
        expect(ids[0]).toBe("c1");
        expect(ids).toHaveLength(5);
    });

    it("cannot bury what the fusion ranked first by reversing the order", () => {
        const reversed = candidates(12).map((_, index) => {
            return { index, score: index };
        });

        expect(applyRerank(candidates(12), reversed).map((h) => h.chunkId)).toContain("c1");
    });

    it("ignores scores for candidates that do not exist", () => {
        const ids = applyRerank(candidates(8), [
            { index: 99, score: 1 },
            { index: 7, score: 0.5 },
        ]).map((h) => h.chunkId);

        expect(ids).toHaveLength(5);
    });
});

describe("searchKnowledgeBase reranking", () => {
    const ctx = {
        runQuery: vi.fn(async (reference: unknown) => {
            if (reference === internal.knowledge.functions.getIndexedFileIds) {
                return ["own-1"];
            }

            if (reference === internal.knowledge.functions.keywordSearchChunks) {
                return candidates(RERANK_CANDIDATES);
            }

            return [];
        }),
    } as never;

    beforeEach(() => {
        mocks.gateway.mockReset();
    });

    it("sends the candidates to the gateway and returns five", async () => {
        mocks.gateway.mockResolvedValue(Response.json({ results: [{ index: 12, score: 0.99 }] }));

        const hits = await searchKnowledgeBase(ctx, { query: "what is c13", userId: "u" });
        const [url, init] = mocks.gateway.mock.calls[0] as [string, { body: string }];
        const body = JSON.parse(init.body) as { documents: string[]; query: string };

        expect(url).toContain("/internal/rerank");
        expect(body.documents).toHaveLength(RERANK_CANDIDATES);
        expect(body.query).toBe("what is c13");
        expect(hits).toHaveLength(5);
        expect(hits.map((h) => h.chunkId)).toContain("c13");
    });

    it.each([
        ["503 (no reranker bound)", () => new Response("{}", { status: 503 })],
        ["a malformed body", () => Response.json({ nope: true })],
    ])("keeps the fused order on %s", async (_name, make) => {
        mocks.gateway.mockResolvedValue(make());

        const hits = await searchKnowledgeBase(ctx, { query: "q", userId: "u" });

        expect(hits.map((h) => h.chunkId)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    });

    it("keeps the fused order when the gateway call throws", async () => {
        mocks.gateway.mockRejectedValue(new Error("network"));
        vi.spyOn(console, "warn").mockImplementation(() => undefined);

        const hits = await searchKnowledgeBase(ctx, { query: "q", userId: "u" });

        expect(hits.map((h) => h.chunkId)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    });
});
