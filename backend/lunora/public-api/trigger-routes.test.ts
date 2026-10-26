/**
 * The trigger routes through the real router: scope check, rate limit, body parse
 * and handler, with a fake ctx standing in for the runtime.
 */
import { Hono } from "hono";
import type { LunoraHttpEnv } from "lunorash/server";
import { describe, expect, it, vi } from "vitest";

import type { ApiScopes } from "./scopes";
import { createPublicApiRouter } from "./router";

vi.mock("../chat/http", () => {
    return { runChatStart: vi.fn() };
});

// The shard hop is the runtime's; the handler only needs the ctx it was given.
vi.mock("../lib/http-shard", () => {
    return {
        inShard: async (ctx: unknown, _shardKey: string, handler: (ctx: unknown) => Promise<unknown>) => await handler(ctx),
        shardContext: (ctx: unknown) => ctx,
    };
});

const stored = {
    _creationTime: 1,
    _id: "trg1",
    botComputer: false,
    botId: null,
    createdAt: 10,
    cronExpression: "0 9 * * 1",
    description: null,
    enabled: false,
    filters: [{ op: "equals", path: "event", value: "push" }],
    inputTemplate: null,
    lastError: null,
    lastTriggeredAt: null,
    model: "m",
    name: "Weekly digest",
    nextTriggerAt: null,
    searchMode: null,
    systemPrompt: null,
    timezone: null,
    triggerCount: 0,
    type: "schedule",
    updatedAt: 11,
    webhookSignatureScheme: null,
};

const call = (scopes: ApiScopes) => {
    const calls: { args: unknown; name: string }[] = [];
    const run = async (ref: { __lunoraRef: string }, args: unknown) => {
        const name = ref.__lunoraRef;

        calls.push({ args, name });

        switch (name) {
            case "lib_rate_limiter_mutations:applyRateLimit": {
                return { ok: true };
            }
            case "triggers_functions:createTrigger": {
                return { triggerId: "trg2", webhookSecret: "s3cret" };
            }
            case "triggers_functions:getTriggerExecutions": {
                return [{ _id: "ex1", completedAt: 2, error: null, startedAt: 1, status: "success", threadId: null }];
            }
            case "triggers_functions:getTriggers": {
                return [stored];
            }
            default: {
                return null;
            }
        }
    };
    const ctx = {
        auth: {
            getIdentity: async () => {
                return { apiKeyId: "key1", apiKeyScopes: scopes, authMethod: "api_key" };
            },
            userId: "user1",
        },
        runMutation: run,
        runQuery: run,
    };
    const app = new Hono<LunoraHttpEnv>();

    app.use("*", async (c, next) => {
        (c as unknown as { set: (key: string, value: unknown) => void }).set("lunora", ctx);
        await next();
    });
    app.route("/api/v1", createPublicApiRouter());

    return { calls, request: async (path: string, init?: RequestInit) => await app.request(`https://api.example/api/v1${path}`, init) };
};

const json = (method: string, body: unknown, headers: Record<string, string> = {}) => {
    return { body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers }, method };
};

const bodyOf = async (response: Response): Promise<unknown> => await response.json();

describe("trigger routes", () => {
    it("answers 403 insufficient_scope to a key without triggers:read, and never reaches a procedure", async () => {
        const { calls, request } = call({ tasks: ["read"], triggers: ["write"] });
        const response = await request("/triggers");

        expect(response.status).toBe(403);
        expect(await bodyOf(response)).toMatchObject({ error: { code: "insufficient_scope" } });
        expect(calls).toEqual([]);
    });

    it("answers 403 to a read-only key on every write route", async () => {
        const { calls, request } = call({ triggers: ["read"] });
        const attempts = [
            await request("/triggers", json("POST", { model: "m", name: "n", type: "webhook" })),
            await request("/triggers/trg1", json("PATCH", { name: "n" })),
            await request("/triggers/trg1", { method: "DELETE" }),
        ];

        expect(attempts.map((response) => response.status)).toEqual([403, 403, 403]);
        expect(calls).toEqual([]);
    });

    it("lists triggers for a key with triggers:read, under `id` and without a secret", async () => {
        const { request } = call({ triggers: ["read"] });
        const response = await request("/triggers");
        const body = (await bodyOf(response)) as { data: object[] };

        expect(response.status).toBe(200);
        expect(body.data).toHaveLength(1);
        expect(body.data[0]).toMatchObject({ enabled: false, filters: [{ op: "equals", path: "event", value: "push" }], id: "trg1", name: "Weekly digest" });
        expect(body.data[0]).not.toHaveProperty("_id");
        expect(JSON.stringify(body)).not.toContain("ecret");
    });

    it("gets one trigger with its recent executions, and 404s an unknown id", async () => {
        const { request } = call({ triggers: ["read"] });
        const found = await request("/triggers/trg1");

        expect(found.status).toBe(200);
        expect(await bodyOf(found)).toMatchObject({ executions: [{ id: "ex1", status: "success" }], id: "trg1" });

        const missing = await request("/triggers/missing");

        expect(missing.status).toBe(404);
    });

    it("creates through createTrigger and returns the webhook secret once", async () => {
        const { calls, request } = call({ triggers: ["write"] });
        const response = await request("/triggers", json("POST", { model: "m", name: "Hook", type: "webhook" }));

        expect(response.status).toBe(201);
        expect(await bodyOf(response)).toEqual({ id: "trg2", webhookSecret: "s3cret" });
        expect(calls.some((entry) => entry.name === "triggers_functions:createTrigger")).toBe(true);
    });

    it("refuses an Idempotency-Key on create, so the secret is never stored for replay", async () => {
        const { calls, request } = call({ triggers: ["write"] });
        const response = await request("/triggers", json("POST", { model: "m", name: "Hook", type: "webhook" }, { "Idempotency-Key": "abc" }));

        expect(response.status).toBe(400);
        expect(calls.some((entry) => entry.name === "triggers_functions:createTrigger")).toBe(false);
        expect(calls.some((entry) => entry.name.includes("action_cache"))).toBe(false);
    });

    it("refuses an event trigger and an unknown field type at the boundary", async () => {
        const { request } = call({ triggers: ["write"] });

        const response = await request("/triggers", json("POST", { model: "m", name: "n", type: "event" }));

        expect(response.status).toBe(400);
    });

    it("updates and deletes through the existing procedures", async () => {
        const { calls, request } = call({ triggers: ["write"] });

        const updated = await request("/triggers/trg1", json("PATCH", { name: "Renamed" }));
        const deleted = await request("/triggers/trg1", { method: "DELETE" });

        expect([updated.status, deleted.status]).toEqual([200, 200]);
        expect(calls.find((entry) => entry.name === "triggers_functions:updateTrigger")?.args).toEqual({ name: "Renamed", triggerId: "trg1" });
        expect(calls.find((entry) => entry.name === "triggers_functions:deleteTrigger")?.args).toEqual({ triggerId: "trg1" });
    });
});
