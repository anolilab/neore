/**
 * POST /internal/rerank — cross-encoder relevance scores for the backend's
 * knowledge retrieval.
 *
 * Backed by Workers AI `@cf/baai/bge-reranker-base`. `AI` is bound in preview
 * and production only (a top-level `ai` binding in a service's wrangler.jsonc
 * kills `lunora dev` without an API token), so locally — and on any provider
 * error — the answer is 503 and the caller keeps its own order. A reranker is
 * an upgrade, never a dependency.
 *
 * Reachable only through the backend's service binding, like the rest of
 * `/internal/*` (`internalAuth`). Not metered: the model is
 * priced per million input tokens at a fraction of a cent.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { logger } from "../../lib/logger.js";
import { internalAuth } from "../../middleware/auth.js";

export const RERANK_MODEL = "@cf/baai/bge-reranker-base";

/** How long the route waits for the model before answering 503. Retrieval gives up after 2 s, so a stalled invocation should not outlive it by much. */
export const RERANK_DEADLINE_MS = 4000;

/** Candidates per request. Retrieval sends 15; the bound is the gateway's own. */
export const MAX_RERANK_DOCUMENTS = 50;

/** The model reads ~512 tokens of query + passage together, so more than this is never seen. */
const MAX_DOCUMENT_CHARS = 2000;

const rerankRequestSchema = z.object({
    documents: z.array(z.string().max(100_000)).min(1).max(MAX_RERANK_DOCUMENTS),
    query: z.string().trim().min(1).max(2000),
    topN: z.int().min(1).max(MAX_RERANK_DOCUMENTS).optional(),
});

export interface RerankResult {
    /** Position of the document in the request. */
    index: number;
    score: number;
}

/**
 * Reads the model's `{ response: [{ id, score }] }`, best first. Anything out of
 * range or not a number is dropped, so a malformed answer yields fewer results
 * rather than an exception the caller would have to understand.
 */
export const parseRerankResponse = (raw: unknown, documentCount: number): RerankResult[] => {
    const rows = (raw as { response?: unknown } | null)?.response;

    if (!Array.isArray(rows)) {
        return [];
    }

    const results: RerankResult[] = [];
    const seen = new Set<number>();

    for (const row of rows as { id?: unknown; score?: unknown }[]) {
        const index = row?.id;
        const score = row?.score;

        // NaN and Infinity pass `typeof`, and a NaN score makes the sort order arbitrary.
        if (
            typeof index !== "number" ||
            typeof score !== "number" ||
            !Number.isFinite(score) ||
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= documentCount ||
            seen.has(index)
        ) {
            continue;
        }

        seen.add(index);
        results.push({ index, score });
    }

    return results.toSorted((a, b) => b.score - a.score || a.index - b.index);
};

const rerankRouter = new OpenAPIHono<HonoEnv>();

rerankRouter.use("/internal/rerank", internalAuth);

rerankRouter.post("/internal/rerank", async (c) => {
    const parsed = rerankRequestSchema.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) {
        return c.json({ error: { code: "INVALID_REQUEST", message: "Invalid rerank request" } }, 400);
    }

    const ai = c.env.AI;

    if (!ai) {
        return c.json({ error: { code: "RERANK_UNAVAILABLE", message: "No reranker is bound in this environment" } }, 503);
    }

    const { documents, query, topN } = parsed.data;

    try {
        // The model REQUIRES `query` (Cloudflare's model page); `workers-types` lost it from the
        // generated input type (its doc comment is orphaned), hence the assertion.
        const input = {
            contexts: documents.map((text) => {
                return { text: text.slice(0, MAX_DOCUMENT_CHARS) };
            }),
            query,
            top_k: topN ?? documents.length,
        };
        const raw = await Promise.race([
            ai.run(RERANK_MODEL, input as never),
            new Promise<never>((_resolve, reject) => {
                setTimeout(() => {
                    reject(new Error(`rerank timed out after ${String(RERANK_DEADLINE_MS)} ms`));
                }, RERANK_DEADLINE_MS);
            }),
        ]);
        const results = parseRerankResponse(raw, documents.length);

        if (results.length === 0) {
            return c.json({ error: { code: "RERANK_EMPTY", message: "The reranker returned no scores" } }, 503);
        }

        return c.json({ model: RERANK_MODEL, results });
    } catch (error) {
        logger.warn("rerank failed", { error: error instanceof Error ? error.message : String(error) });

        return c.json({ error: { code: "RERANK_FAILED", message: "The reranker failed" } }, 503);
    }
});

export { rerankRouter };
