/**
 * The internal surface (`/internal/*` and the backend-only `/v1/*` routes) is
 * reachable ONLY through the `InternalApi` entrypoint — the backend's service
 * binding. The public `fetch` handler serves the same app without the
 * binding marker, so every internal route answers it 404, signature or not.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { AppEnv, HonoEnv } from "../env.js";
import { app, InternalApi } from "../index.js";
import { asBindingCallerEnv, isBindingCall } from "../lib/binding-caller.js";
import { internalAuth } from "../middleware/auth.js";
import { createMockCtx, createMockEnv } from "./helpers/mock-env.js";

const createTestApp = () => {
    const testApp = new Hono<HonoEnv>();

    testApp.use("/internal/*", internalAuth);
    testApp.post("/internal/test", (c) => c.json({ ok: true }));

    return testApp;
};

const post = (path: string, headers: Record<string, string> = {}) =>
    new Request(`http://localhost${path}`, { body: '{"hello":"world"}', headers: { "Content-Type": "application/json", ...headers }, method: "POST" });

describe("internalAuth middleware", () => {
    it("passes a request that came through the binding entrypoint", async () => {
        const res = await createTestApp().fetch(post("/internal/test"), asBindingCallerEnv({ NODE_ENV: "production" }) as never);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });

    it("answers 404 to a public request, however it is signed", async () => {
        // A request with the old HMAC headers is no different: the internet cannot
        // reach the internal routes at all, so there is nothing to authenticate.
        const res = await createTestApp().fetch(post("/internal/test", { "X-Signature": "deadbeef", "X-Timestamp": Date.now().toString() }), {
            NODE_ENV: "production",
            SIGNING_SECRET: "any",
        } as never);

        expect(res.status).toBe(404);
    });

    it("cannot be opened by an env var: the marker is a Symbol, not a string key", async () => {
        const env = { "llm-gateway.via-binding": true, NODE_ENV: "development", VIA_BINDING: "true" } as never;

        expect(isBindingCall(env)).toBe(false);
        const response = await createTestApp().fetch(post("/internal/test"), env);

        expect(response.status).toBe(404);
    });

    it("keeps every binding in the marked env", () => {
        const env = createMockEnv();
        const marked = asBindingCallerEnv(env);

        expect(isBindingCall(marked)).toBe(true);
        expect(isBindingCall(env)).toBe(false);
        expect(marked.USAGE_DB).toBe(env.USAGE_DB);
        expect(marked.RATE_LIMIT_KV).toBe(env.RATE_LIMIT_KV);
    });
});

describe("the gateway app", () => {
    it("answers 404 on /internal/* through the public fetch handler", async () => {
        for (const path of [
            "/internal/route",
            "/internal/model/proxy",
            "/internal/keys",
            "/internal/embeddings",
            "/internal/speech",
            "/internal/whatever-is-added-next",
        ]) {
            const res = await app.fetch(post(path), createMockEnv() as unknown as AppEnv, createMockCtx() as unknown as ExecutionContext);

            expect(res.status, path).toBe(404);
        }
    });

    it("answers 404 on the backend-only /v1 routes through the public fetch handler", async () => {
        const res = await app.fetch(
            new Request("http://localhost/v1/cache/stats"),
            createMockEnv() as unknown as AppEnv,
            createMockCtx() as unknown as ExecutionContext,
        );

        expect(res.status).toBe(404);
    });

    it("serves /internal/* through the InternalApi entrypoint", async () => {
        const entrypoint = new InternalApi(createMockCtx() as unknown as ExecutionContext, createMockEnv() as unknown as AppEnv);
        const res = await entrypoint.fetch(
            new Request("https://llm-gateway.internal/internal/route", {
                body: JSON.stringify({ messages: [{ content: "What is 2+2?", role: "user" }], userTier: "pro" }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            }),
        );

        expect(res.status).toBe(200);
        expect(await res.json()).toHaveProperty("modelId");
    });
});
