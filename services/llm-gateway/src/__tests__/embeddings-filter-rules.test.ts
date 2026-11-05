/**
 * The internal embeddings route refuses a model the user's filter rules exclude, as the chat routes do. Workers AI's
 * `bge-m3` is served from any region, so any region rule refuses it before the binding is called.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { HonoEnv } from "../env.js";
import { asBindingCallerEnv } from "../lib/binding-caller.js";
import { embeddingsRouter } from "../routes/v1/embeddings.js";

const app = new Hono<HonoEnv>().route("/", embeddingsRouter);

const call = async (body: Record<string, unknown>, ai: { run: ReturnType<typeof vi.fn> }) =>
    await app.fetch(
        new Request("http://localhost/internal/embeddings", {
            body: JSON.stringify({ input: ["hello"], model: "bge-m3", requestId: "r1", userId: "u1", ...body }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        }),
        asBindingCallerEnv({ AI: ai }) as never,
        {
            passThroughOnException: () => undefined,
            waitUntil: (promise: Promise<unknown>) => {
                promise.catch(() => undefined);
            },
        } as never,
    );

describe("/internal/embeddings with model filter rules", () => {
    it("refuses a region rule for the Workers AI model without calling the binding", async () => {
        const ai = { run: vi.fn() };
        const response = await call({ modelFilterRules: { blockedRegions: ["CN"] } }, ai);

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "MODEL_BLOCKED" } });
        expect(ai.run).not.toHaveBeenCalled();
    });

    it("refuses a blocked provider", async () => {
        const ai = { run: vi.fn() };
        const response = await call({ modelFilterRules: { blockedProviders: ["cloudflare"] } }, ai);

        expect(response.status).toBe(403);
        expect(ai.run).not.toHaveBeenCalled();
    });

    it("embeds when the rules allow the model, and when there are none", async () => {
        const ai = {
            run: vi.fn(async () => {
                return { data: [[0.1, 0.2]] };
            }),
        };

        const allowed = await call({ modelFilterRules: { blockedProviders: ["openai"] } }, ai);
        const chatAllowList = await call({ modelFilterRules: { allowedModels: ["openai/gpt-5"], allowedProviders: ["openrouter"] } }, ai);
        const unruled = await call({}, ai);

        expect(allowed.status).toBe(200);
        expect(chatAllowList.status).toBe(200);
        expect(unruled.status).toBe(200);
        await expect(unruled.json()).resolves.toMatchObject({ embeddings: [[0.1, 0.2]] });
        expect(ai.run).toHaveBeenCalledTimes(3);
    });
});
