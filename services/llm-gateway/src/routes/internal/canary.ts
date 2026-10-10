/**
 * Canary management endpoints — HMAC authenticated.
 *
 * POST   /internal/canary         — create a canary config
 * GET    /internal/canary         — list active canary configs
 * DELETE /internal/canary/:id     — remove a canary config by id
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { internalAuth } from "../../middleware/auth.js";
import type { CanaryConfig } from "../../routing/canary.js";
import { loadCanaryConfigs, saveCanaryConfigs } from "../../routing/canary.js";

const canaryRouter = new OpenAPIHono<HonoEnv>();

// ── Schemas ────────────────────────────────────────────────────────────────

const canaryConfigSchema = z.object({
    canaryModelId: z.string(),
    endsAt: z.number().optional(),
    id: z.string(),
    isActive: z.boolean(),
    orgId: z.string().optional(),
    primaryModelId: z.string(),
    splitPercent: z.number().min(0).max(100),
    startedAt: z.number(),
    userId: z.string().optional(),
});

const createCanarySchema = z.object({
    canaryModelId: z.string().min(1),
    endsAt: z.number().optional(),
    orgId: z.string().optional(),
    primaryModelId: z.string().min(1),
    splitPercent: z.number().min(0).max(100),
    userId: z.string().optional(),
});

// ── POST /internal/canary ─────────────────────────────────────────────────

canaryRouter.openapi(
    {
        method: "post",
        middleware: [internalAuth] as const,
        path: "/internal/canary",
        request: {
            body: {
                content: { "application/json": { schema: createCanarySchema } },
            },
        },
        responses: {
            201: {
                content: { "application/json": { schema: canaryConfigSchema } },
                description: "Created canary config",
            },
        },
        summary: "Create a canary traffic split config",
        tags: ["Internal"],
    },
    async (c) => {
        const body = c.req.valid("json");
        const kv = c.env.PRICING_KV;

        // Load existing (including inactive) to merge
        const rawAll = await kv.get("canary:active", "json").catch(() => null);
        const existing: CanaryConfig[] = Array.isArray(rawAll) ? (rawAll as CanaryConfig[]) : [];

        const newConfig: CanaryConfig = {
            canaryModelId: body.canaryModelId,
            endsAt: body.endsAt,
            id: crypto.randomUUID(),
            isActive: true,
            orgId: body.orgId,
            primaryModelId: body.primaryModelId,
            splitPercent: body.splitPercent,
            startedAt: Date.now(),
            userId: body.userId,
        };

        await saveCanaryConfigs(kv, [...existing, newConfig]);

        return c.json(newConfig, 201);
    },
);

// ── GET /internal/canary ──────────────────────────────────────────────────

canaryRouter.openapi(
    {
        method: "get",
        middleware: [internalAuth] as const,
        path: "/internal/canary",
        request: {},
        responses: {
            200: {
                content: { "application/json": { schema: z.object({ configs: z.array(canaryConfigSchema) }) } },
                description: "Active canary configs",
            },
        },
        summary: "List active canary configs",
        tags: ["Internal"],
    },
    async (c) => {
        const configs = await loadCanaryConfigs(c.env.PRICING_KV);

        return c.json({ configs }, 200);
    },
);

// ── DELETE /internal/canary/:id ────────────────────────────────────────────

canaryRouter.openapi(
    {
        method: "delete",
        middleware: [internalAuth] as const,
        path: "/internal/canary/:id",
        request: {
            params: z.object({ id: z.string() }),
        },
        responses: {
            200: {
                content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } },
                description: "Deletion result",
            },
            404: {
                content: { "application/json": { schema: z.object({ error: z.string() }) } },
                description: "Config not found",
            },
        },
        summary: "Remove a canary config",
        tags: ["Internal"],
    },
    async (c) => {
        const { id } = c.req.valid("param");
        const kv = c.env.PRICING_KV;

        const rawAll = await kv.get("canary:active", "json").catch(() => null);
        const existing: CanaryConfig[] = Array.isArray(rawAll) ? (rawAll as CanaryConfig[]) : [];

        const index = existing.findIndex((config) => config.id === id);

        if (index === -1) {
            return c.json({ error: "Canary config not found" }, 404);
        }

        existing.splice(index, 1);
        await saveCanaryConfigs(kv, existing);

        return c.json({ deleted: true }, 200);
    },
);

export { canaryRouter };
