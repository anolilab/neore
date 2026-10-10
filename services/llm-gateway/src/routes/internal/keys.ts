/**
 * Virtual API Key management — HMAC-authenticated internal endpoints.
 *
 * POST   /internal/keys             — create key; raw key returned once
 * GET    /internal/keys?userId=X    — list keys (hash masked, prefix shown)
 * DELETE /internal/keys/:keyId      — revoke key
 * PATCH  /internal/keys/:keyId      — update name / budget / limits
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { HonoEnv } from "../../env.js";
import { internalAuth } from "../../middleware/auth.js";

const keysRouter = new OpenAPIHono<HonoEnv>();

// ── helpers ──────────────────────────────────────────────────────────────────

const sha256Hex = async (data: ArrayBuffer | Uint8Array): Promise<string> => {
    const hash = await crypto.subtle.digest("SHA-256", data);

    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** Generate a cryptographically random gk_* key. */
const generateRawKey = (): string => {
    const bytes = new Uint8Array(32);

    crypto.getRandomValues(bytes);
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

    return `gk_${hex}`;
};

// ── POST /internal/keys ───────────────────────────────────────────────────────

const createKeySchema = z.object({
    expiresAt: z.iso.datetime().optional(),
    maxBudgetUsd: z.number().positive().optional(),
    name: z.string().default("Default"),
    orgId: z.string().optional(),
    rpmLimit: z.int().positive().default(60),
    tier: z.enum(["free", "pro", "enterprise"]).default("free"),
    tpmLimit: z.int().positive().default(100_000),
    userId: z.string(),
});

keysRouter.openapi(
    {
        method: "post",
        middleware: [internalAuth] as const,
        path: "/internal/keys",
        request: {
            body: { content: { "application/json": { schema: createKeySchema } } },
        },
        responses: {
            201: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Key created — rawKey shown once",
            },
        },
        summary: "Create a virtual API key",
        tags: ["Internal"],
    },
    async (c) => {
        const body = c.req.valid("json");
        const database = c.env.USAGE_DB;

        const rawKey = generateRawKey();
        const keyHash = await sha256Hex(new TextEncoder().encode(rawKey));
        const prefix = rawKey.slice(0, 12); // "gk_" + 9 chars
        const keyId = crypto.randomUUID();

        await database
            .prepare(
                `INSERT INTO api_keys
                    (id, key_hash, prefix, user_id, org_id, name, tier,
                     max_budget_usd, rpm_limit, tpm_limit, expires_at, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            )
            .bind(
                keyId,
                keyHash,
                prefix,
                body.userId,
                body.orgId ?? null,
                body.name,
                body.tier,
                body.maxBudgetUsd ?? null,
                body.rpmLimit,
                body.tpmLimit,
                body.expiresAt ?? null,
            )
            .run();

        return c.json(
            {
                createdAt: new Date().toISOString(),
                expiresAt: body.expiresAt ?? null,
                keyId,
                maxBudgetUsd: body.maxBudgetUsd ?? null,
                name: body.name,
                prefix,
                rawKey, // shown exactly once — caller must store it
                rpmLimit: body.rpmLimit,
                tier: body.tier,
                tpmLimit: body.tpmLimit,
            },
            201,
        );
    },
);

// ── GET /internal/keys ───────────────────────────────────────────────────────

interface ApiKeyRow {
    created_at: string;
    expires_at: string | null;
    id: string;
    is_active: number;
    last_used_at: string | null;
    max_budget_usd: number | null;
    name: string;
    org_id: string | null;
    prefix: string;
    rpm_limit: number;
    spent_usd: number;
    tier: string;
    tpm_limit: number;
    user_id: string;
}

keysRouter.openapi(
    {
        method: "get",
        middleware: [internalAuth] as const,
        path: "/internal/keys",
        request: {
            query: z.object({ userId: z.string() }),
        },
        responses: {
            200: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Key list (hash masked)",
            },
        },
        summary: "List virtual API keys for a user",
        tags: ["Internal"],
    },
    async (c) => {
        const { userId } = c.req.valid("query");
        const database = c.env.USAGE_DB;

        const rows = await database
            .prepare(
                `SELECT id, prefix, user_id, org_id, name, tier,
                        max_budget_usd, spent_usd, rpm_limit, tpm_limit,
                        expires_at, is_active, created_at, last_used_at
                 FROM api_keys
                 WHERE user_id = ?
                 ORDER BY created_at DESC`,
            )
            .bind(userId)
            .all<ApiKeyRow>();

        const keys = (rows.results ?? []).map((row) => {
            return {
                createdAt: row.created_at,
                expiresAt: row.expires_at,
                isActive: row.is_active === 1,
                keyId: row.id,
                lastUsedAt: row.last_used_at,
                maxBudgetUsd: row.max_budget_usd,
                name: row.name,
                prefix: row.prefix,
                rpmLimit: row.rpm_limit,
                spentUsd: row.spent_usd,
                tier: row.tier,
                tpmLimit: row.tpm_limit,
            };
        });

        return c.json({ keys }, 200);
    },
);

// ── DELETE /internal/keys/:keyId ─────────────────────────────────────────────

keysRouter.openapi(
    {
        method: "delete",
        middleware: [internalAuth] as const,
        path: "/internal/keys/:keyId",
        request: {
            params: z.object({ keyId: z.string() }),
            query: z.object({ userId: z.string() }),
        },
        responses: {
            200: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Key revoked",
            },
            404: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Key not found",
            },
        },
        summary: "Revoke a virtual API key",
        tags: ["Internal"],
    },
    async (c) => {
        const { keyId } = c.req.valid("param");
        const { userId } = c.req.valid("query");
        const database = c.env.USAGE_DB;

        // Scope to (id, user_id) so a caller can't revoke another tenant's key
        // by guessing/leaking the key UUID.
        const result = await database.prepare("UPDATE api_keys SET is_active = 0 WHERE id = ? AND user_id = ?").bind(keyId, userId).run();

        if (result.meta.changes === 0) {
            return c.json({ error: "Key not found" }, 404);
        }

        return c.json({ keyId, revoked: true }, 200);
    },
);

// ── PATCH /internal/keys/:keyId ──────────────────────────────────────────────

const updateKeySchema = z.object({
    expiresAt: z.iso.datetime().nullish(),
    isActive: z.boolean().optional(),
    maxBudgetUsd: z.number().positive().nullish(),
    name: z.string().optional(),
    rpmLimit: z.int().positive().optional(),
    tpmLimit: z.int().positive().optional(),
});

keysRouter.openapi(
    {
        method: "patch",
        middleware: [internalAuth] as const,
        path: "/internal/keys/:keyId",
        request: {
            body: { content: { "application/json": { schema: updateKeySchema } } },
            params: z.object({ keyId: z.string() }),
            query: z.object({ userId: z.string() }),
        },
        responses: {
            200: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Key updated",
            },
            404: {
                content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
                description: "Key not found",
            },
        },
        summary: "Update a virtual API key",
        tags: ["Internal"],
    },
    async (c) => {
        const { keyId } = c.req.valid("param");
        const { userId } = c.req.valid("query");
        const body = c.req.valid("json");
        const database = c.env.USAGE_DB;

        // Build SET clause dynamically from provided fields
        const sets: string[] = [];
        const binds: unknown[] = [];

        if (body.name !== undefined) {
            sets.push("name = ?");
            binds.push(body.name);
        }

        if (body.maxBudgetUsd !== undefined) {
            sets.push("max_budget_usd = ?");
            binds.push(body.maxBudgetUsd);
        }

        if (body.rpmLimit !== undefined) {
            sets.push("rpm_limit = ?");
            binds.push(body.rpmLimit);
        }

        if (body.tpmLimit !== undefined) {
            sets.push("tpm_limit = ?");
            binds.push(body.tpmLimit);
        }

        if (body.expiresAt !== undefined) {
            sets.push("expires_at = ?");
            binds.push(body.expiresAt);
        }

        if (body.isActive !== undefined) {
            sets.push("is_active = ?");
            binds.push(body.isActive ? 1 : 0);
        }

        if (sets.length === 0) {
            return c.json({ error: "No fields to update" }, 400 as 200);
        }

        // Scope to (id, user_id) so a caller can't patch another tenant's key.
        binds.push(keyId, userId);
        const result = await database
            .prepare(`UPDATE api_keys SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
            .bind(...binds)
            .run();

        if (result.meta.changes === 0) {
            return c.json({ error: "Key not found" }, 404);
        }

        return c.json({ keyId, updated: true }, 200);
    },
);

export { keysRouter };
