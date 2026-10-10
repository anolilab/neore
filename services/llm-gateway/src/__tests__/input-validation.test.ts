import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { HonoEnv } from "../env.js";
import { chatInputValidationMiddleware, inputValidationMiddleware } from "../middleware/input-validation.js";

/**
 * Build a tiny app that mounts the middleware on the supplied path and
 * answers 200 + `{ ok: true }` for requests that pass validation.
 */
const buildApp = (path: string) => {
    const app = new Hono<HonoEnv>();

    app.post(path, chatInputValidationMiddleware, (c) => c.json({ ok: true }));

    return app;
};

const post = async (app: ReturnType<typeof buildApp>, path: string, body: unknown) =>
    app.fetch(
        new Request(`http://localhost${path}`, {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        }),
    );

describe("chatInputValidationMiddleware — /v1/chat (top-level shape)", () => {
    const app = buildApp("/v1/chat");

    it("passes a valid request through", async () => {
        const res = await post(app, "/v1/chat", { model: "gpt-4o-mini", prompt: "hi" });

        expect(res.status).toBe(200);
    });

    it("rejects missing model at the top level", async () => {
        const res = await post(app, "/v1/chat", { prompt: "hi" });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid model ID" });
    });

    it("rejects malformed thread IDs", async () => {
        const res = await post(app, "/v1/chat", { model: "gpt-4o-mini", threadId: "bad id!" });

        expect(res.status).toBe(400);
    });
});

describe("chatInputValidationMiddleware — /v1/chat/media (nested envelope)", () => {
    const app = buildApp("/v1/chat/media");

    const validMessageId = "k57abcd1234efgh5678ijklmn90";

    it("passes when model lives inside streamingConfig", async () => {
        // Regression: middleware used to read `body.model` and hard-400 every
        // media request because the model is nested under streamingConfig.
        const res = await post(app, "/v1/chat/media", {
            messageId: validMessageId,
            streamingConfig: {
                contentType: "image",
                imageSize: "1:1",
                model: "fal-ai/nano-banana/edit",
            },
        });

        expect(res.status).toBe(200);
    });

    it("rejects a missing messageId", async () => {
        const res = await post(app, "/v1/chat/media", {
            streamingConfig: { model: "fal-ai/nano-banana/edit" },
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid message ID format" });
    });

    it("rejects a malformed messageId", async () => {
        const res = await post(app, "/v1/chat/media", {
            messageId: "not a lunora id!",
            streamingConfig: { model: "fal-ai/nano-banana/edit" },
        });

        expect(res.status).toBe(400);
    });

    it("rejects a missing streamingConfig envelope", async () => {
        const res = await post(app, "/v1/chat/media", { messageId: validMessageId });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid streamingConfig payload" });
    });

    it("rejects when the nested model is missing", async () => {
        const res = await post(app, "/v1/chat/media", {
            messageId: validMessageId,
            streamingConfig: { imageSize: "1:1" },
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid model ID" });
    });

    it("accepts a valid referenceImages array in streamingConfig", async () => {
        const res = await post(app, "/v1/chat/media", {
            messageId: validMessageId,
            streamingConfig: {
                model: "fal-ai/nano-banana/edit",
                referenceImages: ["https://files.example.com/a.png", "https://files.example.com/b.png"],
            },
        });

        expect(res.status).toBe(200);
    });

    it("rejects more than 4 referenceImages", async () => {
        const res = await post(app, "/v1/chat/media", {
            messageId: validMessageId,
            streamingConfig: {
                model: "fal-ai/nano-banana/edit",
                referenceImages: Array.from({ length: 5 }, (_, i) => `https://files.example.com/${i}.png`),
            },
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid referenceImages payload" });
    });

    it("rejects malformed referenceImages URLs", async () => {
        const res = await post(app, "/v1/chat/media", {
            messageId: validMessageId,
            streamingConfig: {
                model: "fal-ai/nano-banana/edit",
                referenceImages: ["not-a-url"],
            },
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "referenceImages contains a malformed URL" });
    });

    it("rejects non-array referenceImages", async () => {
        const res = await post(app, "/v1/chat/media", {
            messageId: validMessageId,
            streamingConfig: {
                model: "fal-ai/nano-banana/edit",
                referenceImages: "https://files.example.com/a.png",
            },
        });

        expect(res.status).toBe(400);
    });
});

// ── Added coverage ───────────────────────────────────────────────────────────
//
// Everything above covers `chatInputValidationMiddleware`. `inputValidationMiddleware`
// — the `/internal/*` one — had none, despite being the same kind of
// trust-boundary check on a live route.

const buildInternalApp = () => {
    const app = new Hono<HonoEnv>();

    app.use("*", inputValidationMiddleware);
    app.all("*", (c) => c.json({ ok: true }));

    return app;
};

const postInternal = async (path: string, body: unknown) =>
    buildInternalApp().fetch(
        new Request(`http://localhost${path}`, {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        }),
    );

describe("inputValidationMiddleware — /internal/*", () => {
    it("rejects a model ID containing characters outside the allowed set", async () => {
        const res = await postInternal("/internal/generate", { modelId: "gpt-4o; drop table" });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid model ID" });
    });

    it("accepts the punctuation real model IDs use", async () => {
        const res = await postInternal("/internal/generate", { modelId: "openai/gpt-4o-mini:free@v1.2" });

        expect(res.status).toBe(200);
    });

    it("rejects an over-long model ID", async () => {
        const res = await postInternal("/internal/generate", { modelId: "a".repeat(201) });

        expect(res.status).toBe(400);
    });

    it("rejects a system prompt over 4000 characters", async () => {
        const res = await postInternal("/internal/generate", { system: "a".repeat(4001) });

        expect(res.status).toBe(400);
    });

    it("sums message content toward the prompt limit rather than checking each in isolation", async () => {
        // Each message is well under the cap; together they exceed it. Checking
        // per-message instead of cumulatively would let this straight through.
        const res = await postInternal("/internal/generate", {
            messages: Array.from({ length: 3 }, () => {
                return { content: "a".repeat(40_000), role: "user" };
            }),
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Prompt exceeds maximum allowed length" });
    });

    it("counts text parts inside array content toward the same limit", async () => {
        const res = await postInternal("/internal/generate", {
            messages: [{ content: [{ text: "a".repeat(100_001), type: "text" }], role: "user" }],
        });

        expect(res.status).toBe(400);
    });

    it("ignores paths outside /internal/", async () => {
        const res = await postInternal("/v1/chat", { modelId: "not a valid id!!" });

        expect(res.status).toBe(200);
    });

    it("passes an unparseable body downstream instead of rejecting it here", async () => {
        const res = await buildInternalApp().fetch(
            new Request("http://localhost/internal/generate", {
                body: "not json",
                headers: { "Content-Type": "application/json" },
                method: "POST",
            }),
        );

        expect(res.status).toBe(200);
    });
});

describe("chatInputValidationMiddleware — shapes the cases above do not reach", () => {
    const app = buildApp("/v1/chat");

    it('allows the literal "default" thread id', async () => {
        const res = await post(app, "/v1/chat", { model: "gpt-4o-mini", threadId: "default" });

        expect(res.status).toBe(200);
    });

    it("names the offending file id", async () => {
        const res = await post(app, "/v1/chat", { fileIds: ["ok_1", "bad id!"], model: "gpt-4o-mini" });

        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain("bad id!");
    });

    it("rejects an array as cinemaSettings", async () => {
        const res = await post(app, "/v1/chat", { cinemaSettings: [], model: "gpt-4o-mini" });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid cinemaSettings format" });
    });

    it("rejects a non-string referenceImages entry", async () => {
        const res = await post(app, "/v1/chat", { model: "gpt-4o-mini", referenceImages: [42] });

        expect(res.status).toBe(400);
    });
});
