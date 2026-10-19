import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { HonoEnv } from "../env.js";
import { asBindingCallerEnv } from "../lib/binding-caller.js";
import { parseRerankResponse, RERANK_MODEL, rerankRouter } from "../routes/internal/rerank.js";

const app = new Hono<HonoEnv>().route("/", rerankRouter);

const post = (body: unknown) =>
    new Request("http://localhost/internal/rerank", { body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, method: "POST" });

const call = (body: unknown, env: { AI?: { run: ReturnType<typeof vi.fn> } }) => app.fetch(post(body), asBindingCallerEnv(env) as never);

describe("parseRerankResponse", () => {
    it("sorts best first and keeps the document index", () => {
        expect(
            parseRerankResponse(
                {
                    response: [
                        { id: 0, score: 0.1 },
                        { id: 2, score: 0.9 },
                        { id: 1, score: 0.5 },
                    ],
                },
                3,
            ),
        ).toEqual([
            { index: 2, score: 0.9 },
            { index: 1, score: 0.5 },
            { index: 0, score: 0.1 },
        ]);
    });

    it("drops out-of-range, non-numeric and duplicate rows", () => {
        expect(
            parseRerankResponse(
                {
                    response: [
                        { id: 5, score: 1 },
                        { id: -1, score: 1 },
                        { id: "1", score: 1 },
                        { id: 1, score: "x" },
                        { id: 0, score: 0.4 },
                        { id: 0, score: 0.9 },
                        null,
                    ],
                },
                2,
            ),
        ).toEqual([{ index: 0, score: 0.4 }]);
    });

    it("drops non-finite scores, which would otherwise make the order arbitrary", () => {
        expect(
            parseRerankResponse(
                {
                    response: [
                        { id: 0, score: NaN },
                        { id: 1, score: Infinity },
                        { id: 2, score: -Infinity },
                        { id: 3, score: 0.2 },
                    ],
                },
                4,
            ),
        ).toEqual([{ index: 3, score: 0.2 }]);
    });

    it("returns nothing for a malformed answer", () => {
        expect(parseRerankResponse(null, 3)).toEqual([]);
        expect(parseRerankResponse({ response: "no" }, 3)).toEqual([]);
    });
});

describe("POST /internal/rerank", () => {
    it("answers 404 to a request that did not come through the binding", async () => {
        const res = await app.fetch(post({ documents: ["a"], query: "q" }), { AI: { run: vi.fn() }, NODE_ENV: "production" } as never);

        expect(res.status).toBe(404);
    });

    it("rejects a malformed body", async () => {
        const noDocuments = await call({ documents: [], query: "q" }, { AI: { run: vi.fn() } });
        const blankQuery = await call({ documents: ["a"], query: "  " }, { AI: { run: vi.fn() } });

        expect(noDocuments.status).toBe(400);
        expect(blankQuery.status).toBe(400);
    });

    it("is 503 without an AI binding", async () => {
        const res = await call({ documents: ["a"], query: "q" }, {});

        expect(res.status).toBe(503);
    });

    it("sends query and clipped contexts to the model and returns ranked results", async () => {
        const run = vi.fn().mockResolvedValue({
            response: [
                { id: 1, score: 0.8 },
                { id: 0, score: 0.2 },
            ],
        });
        const res = await call({ documents: ["x".repeat(5000), "second"], query: "what", topN: 2 }, { AI: { run } });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            model: RERANK_MODEL,
            results: [
                { index: 1, score: 0.8 },
                { index: 0, score: 0.2 },
            ],
        });

        const [model, input] = run.mock.calls[0] as [string, { contexts: { text: string }[]; query: string; top_k: number }];

        expect(model).toBe(RERANK_MODEL);
        expect(input.query).toBe("what");
        expect(input.top_k).toBe(2);
        expect(input.contexts[0]?.text).toHaveLength(2000);
        expect(input.contexts[1]?.text).toBe("second");
    });

    it("is 503 when the model throws or answers with nothing usable", async () => {
        const thrown = await call({ documents: ["a"], query: "q" }, { AI: { run: vi.fn().mockRejectedValue(new Error("boom")) } });
        const empty = await call({ documents: ["a"], query: "q" }, { AI: { run: vi.fn().mockResolvedValue({ response: [] }) } });

        expect(thrown.status).toBe(503);
        expect(empty.status).toBe(503);
    });
});
