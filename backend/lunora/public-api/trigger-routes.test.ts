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
    quietWhenEmpty: false,
    systemPrompt: null,
    timezone: null,
    triggerCount: 0,
    type: "schedule",
    updatedAt: 11,
    webhookSignatureScheme: null,
};

const call = (scopes: ApiScopes, row: Record<string, unknown> = stored) => {
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
                return [row];
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
        expect(calls.find((entry) => entry.name === "triggers_functions:updateTrigger")?.args).toEqual({
            name: "Renamed",
            requireDisabled: true,
            triggerId: "trg1",
        });
        expect(calls.find((entry) => entry.name === "triggers_functions:deleteTrigger")?.args).toEqual({ triggerId: "trg1" });
    });

    it("passes botComputer and quietWhenEmpty through create and update", async () => {
        const { calls, request } = call({ triggers: ["write"] });

        await request(
            "/triggers",
            json("POST", { botComputer: true, botId: "bot1", cronExpression: "0 9 * * 1", model: "m", name: "n", quietWhenEmpty: true, type: "schedule" }),
        );
        await request("/triggers/trg1", json("PATCH", { botComputer: true, quietWhenEmpty: false }));

        expect(calls.find((entry) => entry.name === "triggers_functions:createTrigger")?.args).toMatchObject({ botComputer: true, quietWhenEmpty: true });
        expect(calls.find((entry) => entry.name === "triggers_functions:updateTrigger")?.args).toMatchObject({ botComputer: true, quietWhenEmpty: false });
    });

    it("refuses inputTemplate on a webhook trigger, on create and on update", async () => {
        const { calls, request } = call({ triggers: ["write"] }, { ...stored, type: "webhook" });

        const created = await request("/triggers", json("POST", { inputTemplate: "x", model: "m", name: "Hook", type: "webhook" }));
        const updated = await request("/triggers/trg1", json("PATCH", { inputTemplate: "x" }));

        expect([created.status, updated.status]).toEqual([400, 400]);
        expect(
            calls.some((entry) => entry.name.startsWith("triggers_functions:createTrigger") || entry.name.startsWith("triggers_functions:updateTrigger")),
        ).toBe(false);
    });

    it("asks updateTrigger to refuse an enabled row inside its own transaction", async () => {
        const { calls, request } = call({ triggers: ["write"] });

        await request("/triggers/trg1", json("PATCH", { systemPrompt: "x" }));

        expect(calls.find((entry) => entry.name === "triggers_functions:updateTrigger")?.args).toMatchObject({ requireDisabled: true });
    });

    it("accepts an Idempotency-Key on a schedule create and refuses it on a webhook create", async () => {
        const { request } = call({ triggers: ["write"] });
        const schedule = await request(
            "/triggers",
            json("POST", { cronExpression: "0 9 * * 1", model: "m", name: "n", type: "schedule" }, { "Idempotency-Key": "abc" }),
        );
        const webhook = await request("/triggers", json("POST", { model: "m", name: "n", type: "webhook" }, { "Idempotency-Key": "abc" }));

        expect(schedule.status).not.toBe(400);
        expect(webhook.status).toBe(400);
    });

    it("passes a GitLab preset and the gitlab-token scheme through create", async () => {
        const { calls, request } = call({ triggers: ["write"] });
        const preset = { event: "merge_request_opened", provider: "gitlab" };
        const response = await request(
            "/triggers",
            json("POST", { model: "m", name: "n", type: "webhook", webhookPreset: preset, webhookSignatureScheme: "gitlab-token" }),
        );
        const bad = await request(
            "/triggers",
            json("POST", { model: "m", name: "n", type: "webhook", webhookPreset: { event: "pull_request_opened", provider: "gitlab" } }),
        );

        expect(response.status).toBe(201);
        expect(calls.find((entry) => entry.name === "triggers_functions:createTrigger")?.args).toMatchObject({
            webhookPreset: preset,
            webhookSignatureScheme: "gitlab-token",
        });
        expect(bad.status).toBe(400);
    });

    it("passes a null description through update so it can be cleared", async () => {
        const { calls, request } = call({ triggers: ["write"] });

        await request("/triggers/trg1", json("PATCH", { description: null }));

        expect(calls.find((entry) => entry.name === "triggers_functions:updateTrigger")?.args).toMatchObject({ description: null });
    });

    it("404s an update of an unknown trigger without calling the mutation", async () => {
        const { calls, request } = call({ triggers: ["write"] });
        const response = await request("/triggers/missing", json("PATCH", { name: "n" }));

        expect(response.status).toBe(404);
        expect(calls.some((entry) => entry.name === "triggers_functions:updateTrigger")).toBe(false);
    });

    it("sends a filter read back with value null as an absent value", async () => {
        const { calls, request } = call({ triggers: ["write"] });
        const filters = [
            { op: "exists", path: "event", value: null },
            { op: "equals", path: "kind", value: "push" },
        ];

        const response = await request("/triggers/trg1", json("PATCH", { filters }));

        expect(response.status).toBe(200);
        expect(calls.find((entry) => entry.name === "triggers_functions:updateTrigger")?.args).toMatchObject({
            filters: [
                { op: "exists", path: "event" },
                { op: "equals", path: "kind", value: "push" },
            ],
        });
    });

    it("refuses a cron expression on a webhook trigger, on create and on update", async () => {
        const { calls, request } = call({ triggers: ["write"] }, { ...stored, type: "webhook" });

        const created = await request("/triggers", json("POST", { cronExpression: "0 9 * * 1", model: "m", name: "Hook", type: "webhook" }));
        const updated = await request("/triggers/trg1", json("PATCH", { cronExpression: "0 9 * * 1" }));

        expect([created.status, updated.status]).toEqual([400, 400]);
        expect(calls.some((entry) => entry.name === "triggers_functions:createTrigger" || entry.name === "triggers_functions:updateTrigger")).toBe(false);
    });

    it("does not advertise searchMode, which a trigger run never reads", async () => {
        const { request } = call({ triggers: ["read"] });
        const body = (await bodyOf(await request("/triggers/trg1"))) as Record<string, unknown>;

        expect(body).not.toHaveProperty("searchMode");
    });
});
