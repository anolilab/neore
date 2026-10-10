/**
 * Virtual API Key management tests.
 *
 * Covers: create, list, validate (auth middleware), revoke, budget-exceeded paths.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { HonoEnv } from "../env.js";
import { bearerAuth } from "../middleware/auth.js";
import { keysRouter } from "../routes/internal/keys.js";
import { bindingEnv, makeInternalRequest } from "./helpers/internal.js";
import { computeKeyHash, createMockCtx, createMockEnv, makeVirtualKeyRow } from "./helpers/mock-env.js";

// ── Minimal D1 mock ───────────────────────────────────────────────────────────

const NUMERIC_LITERAL_RE = /^\d+(?:\.\d+)?$/;
const SELECT_TABLE_RE = /FROM\s+(\w+)/i;
const WHERE_KEY_HASH_RE = /WHERE\s+key_hash\s*=\s*'([^']+)'/i;
const ACTIVE_GUARD_RE = /is_active\s*=\s*1/i;
const NOT_EXPIRED_GUARD_RE = /expires_at\s*>\s*datetime\('now'\)/i;
const WHERE_ID_RE = /WHERE\s+id\s*=\s*'([^']+)'/i;
const WHERE_USER_ID_RE = /WHERE\s+user_id\s*=\s*'([^']+)'/i;
const INSERT_STATEMENT_RE = /^\s*INSERT INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i;
const UPDATE_TABLE_RE = /UPDATE\s+(\w+)\s+SET/i;
const SET_IS_ACTIVE_RE = /is_active\s*=\s*(\d+)/i;
const SET_SPENT_USD_RE = /spent_usd\s*=\s*spent_usd\s*\+\s*([\d.]+)/i;
const SET_LAST_USED_AT_RE = /last_used_at/i;
const RAW_KEY_RE = /^gk_[0-9a-f]{64}$/;
const KEY_ID_RE = /^[0-9a-f-]{36}$/;

interface Row {
    [key: string]: unknown;
}

function makeD1Mock(tables: Record<string, Row[]>): D1Database {
    const database = tables;

    const fillBinds = (template: string, binds: unknown[]): string => {
        let index = 0;

        return template.replaceAll("?", () => {
            const v = binds[index++];

            if (v === null || v === undefined) return "NULL";

            if (typeof v === "number") return String(v);

            return `'${String(v).replaceAll("'", "''")}'`;
        });
    };

    const parseValues = (valueString: string): (string | null | number)[] =>
        valueString.split(",").map((v) => {
            const t = v.trim();

            if (t === "NULL") return null;

            if (NUMERIC_LITERAL_RE.test(t)) return Number(t);

            if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);

            return t;
        });

    const runQuery = (rawSql: string, binds: unknown[]): Row[] => {
        const sql = fillBinds(rawSql, binds);
        const tableMatch = SELECT_TABLE_RE.exec(sql);

        if (!tableMatch) return [];

        const table = tableMatch[1]!.toLowerCase();
        const rows = database[table] ?? [];

        const hashMatch = WHERE_KEY_HASH_RE.exec(sql);

        if (hashMatch) {
            let matched = rows.filter((r) => r["key_hash"] === hashMatch[1]);

            // Honour the guards the real query carries, otherwise a revoked or
            // expired key still resolves and the tests asserting 401 pass for
            // the wrong reason.
            if (ACTIVE_GUARD_RE.test(sql)) {
                matched = matched.filter((r) => r["is_active"] === 1);
            }

            if (NOT_EXPIRED_GUARD_RE.test(sql)) {
                matched = matched.filter((r) => {
                    const expiresAt = r["expires_at"];

                    return typeof expiresAt === "string" && Date.parse(expiresAt) > Date.now();
                });
            }

            return matched;
        }

        const idMatch = WHERE_ID_RE.exec(sql);

        if (idMatch) return rows.filter((r) => r["id"] === idMatch[1]);

        const userMatch = WHERE_USER_ID_RE.exec(sql);

        if (userMatch) return rows.filter((r) => r["user_id"] === userMatch[1]);

        return rows;
    };

    const applyMutation = (rawSql: string, binds: unknown[]): number => {
        const sql = fillBinds(rawSql, binds);
        const upper = sql.trim().toUpperCase();

        if (upper.startsWith("INSERT INTO")) {
            const insertMatch = INSERT_STATEMENT_RE.exec(sql);

            if (!insertMatch) return 0;

            const table = insertMatch[1]!.toLowerCase();
            const cols = insertMatch[2]!.split(",").map((c) => c.trim());
            const vals = parseValues(insertMatch[3]!);
            const row: Row = {};

            cols.forEach((col, i) => {
                row[col] = vals[i] ?? null;
            });

            database[table] ??= [];

            database[table]!.push(row);

            return 1;
        }

        if (upper.startsWith("UPDATE")) {
            const tableMatch = UPDATE_TABLE_RE.exec(sql);

            if (!tableMatch) return 0;

            const table = tableMatch[1]!.toLowerCase();
            const rows = database[table] ?? [];
            const idMatch = WHERE_ID_RE.exec(sql);

            if (!idMatch) return 0;

            let changes = 0;

            for (const row of rows) {
                if (row["id"] !== idMatch[1]) continue;

                const activeMatch = SET_IS_ACTIVE_RE.exec(sql);

                if (activeMatch) row["is_active"] = Number(activeMatch[1]);

                const spendMatch = SET_SPENT_USD_RE.exec(sql);

                if (spendMatch) row["spent_usd"] = ((row["spent_usd"] as number) ?? 0) + Number(spendMatch[1]);

                if (SET_LAST_USED_AT_RE.test(sql)) row["last_used_at"] = new Date().toISOString();

                changes++;
            }

            return changes;
        }

        return 0;
    };

    const statement = (sql: string, binds: unknown[] = []): D1PreparedStatement =>
        ({
            all: async <T = Row>() => {
                return { meta: {} as D1Meta, results: runQuery(sql, binds) as T[], success: true };
            },
            bind: (...args: unknown[]) => statement(sql, [...binds, ...args]),
            first: async <T = Row>(col?: string) => {
                const rows = runQuery(sql, binds);
                const row = rows[0] ?? null;

                if (col && row) return (row[col] as T) ?? null;

                return (row as T) ?? null;
            },
            raw: async <T = unknown[]>() => runQuery(sql, binds).map((r) => Object.values(r)) as T[],
            run: async () => {
                const changes = applyMutation(sql, binds);

                return {
                    meta: { changed_db: changes > 0, changes, duration: 0, last_row_id: 0, rows_read: 0, rows_written: changes, size_after: 0 } as D1Meta,
                    success: true,
                };
            },
        }) as unknown as D1PreparedStatement;

    return {
        batch: async () => [],
        dump: async () => new ArrayBuffer(0),
        exec: async () => {
            return { count: 0, duration: 0 };
        },
        prepare: (sql: string) => statement(sql),
    } as unknown as D1Database;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SIGNING_SECRET = "test-signing-secret";

const EC: ExecutionContext = { passThroughOnException: () => {}, waitUntil: (_p: Promise<unknown>) => {} } as ExecutionContext;

function makeKeysApp(databaseTables: Record<string, Row[]>) {
    const app = new Hono<HonoEnv>();

    app.route("/", keysRouter);
    const database = makeD1Mock(databaseTables);
    const env = { NODE_ENV: "production", SIGNING_SECRET, USAGE_DB: database } as unknown as HonoEnv["Bindings"];

    return {
        db: database,
        /** Through the backend's service binding (the `InternalApi` entrypoint). */
        fetch: (request: Request) => app.fetch(request, bindingEnv(env), EC),
        /** Through the public `fetch` handler — the internet. */
        publicFetch: (request: Request) => app.fetch(request, env, EC),
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /internal/keys — create key", () => {
    it("creates a key and returns rawKey with gk_ prefix", async () => {
        const { fetch } = makeKeysApp({ api_keys: [] });
        const body = JSON.stringify({ name: "My Key", rpmLimit: 120, tier: "pro", tpmLimit: 200_000, userId: "user-1" });
        const request = makeInternalRequest("POST", "/internal/keys", body);
        const res = await fetch(request);

        expect(res.status).toBe(201);
        const json = (await res.json()) as { keyId: string; prefix: string; rawKey: string };

        expect(json.rawKey).toMatch(RAW_KEY_RE);
        expect(json.keyId).toMatch(KEY_ID_RE);
        expect(json.prefix).toBe(json.rawKey.slice(0, 12));
    });

    it("is binding-only — a public request is a 404", async () => {
        const { publicFetch } = makeKeysApp({ api_keys: [] });
        const res = await publicFetch(
            new Request("http://localhost/internal/keys", {
                body: JSON.stringify({ userId: "user-1" }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            }),
        );

        expect(res.status).toBe(404);
    });
});

describe("GET /internal/keys — list keys", () => {
    it("returns keys for a user", async () => {
        const tables: Record<string, Row[]> = {
            api_keys: [
                {
                    created_at: "2026-01-01T00:00:00Z",
                    expires_at: null,
                    id: "key-uuid-1",
                    is_active: 1,
                    last_used_at: null,
                    max_budget_usd: null,
                    name: "Test",
                    org_id: null,
                    prefix: "gk_abc123ef",
                    rpm_limit: 60,
                    spent_usd: 0,
                    tier: "free",
                    tpm_limit: 100_000,
                    user_id: "user-1",
                },
            ],
        };
        const { fetch } = makeKeysApp(tables);
        const request = makeInternalRequest("GET", "/internal/keys?userId=user-1");
        const res = await fetch(request);

        expect(res.status).toBe(200);
        const json = (await res.json()) as { keys: { keyId: string }[] };

        expect(json.keys).toHaveLength(1);
        expect(json.keys[0]!.keyId).toBe("key-uuid-1");
    });
});

describe("DELETE /internal/keys/:keyId — revoke", () => {
    it("revokes an existing key", async () => {
        const tables: Record<string, Row[]> = {
            api_keys: [{ id: "key-uuid-1", is_active: 1, user_id: "user-1" }],
        };
        const { fetch } = makeKeysApp(tables);
        // The route scopes the revoke to (id, user_id) so one tenant cannot
        // revoke another's key, which makes userId a required query param.
        const request = makeInternalRequest("DELETE", "/internal/keys/key-uuid-1?userId=user-1");
        const res = await fetch(request);

        expect(res.status).toBe(200);
        const json = (await res.json()) as { revoked: boolean };

        expect(json.revoked).toBe(true);
    });

    it("returns 404 for unknown keyId", async () => {
        const { fetch } = makeKeysApp({ api_keys: [] });
        const request = makeInternalRequest("DELETE", "/internal/keys/no-such-key?userId=user-1");
        const res = await fetch(request);

        expect(res.status).toBe(404);
    });
});

describe("bearerAuth — virtual key validation", () => {
    const rawKey = `gk_${"a".repeat(64)}`;

    /** App wired to the shared mock env, so the D1 shape matches production. */
    const makeApp = async (options: { lunoraUrl?: string; rows?: Record<string, unknown>[] } = {}) => {
        const app = new Hono<HonoEnv>();

        app.use("/v1/*", bearerAuth);
        app.get("/v1/test", (c) => c.json({ apiKeyId: c.get("apiKeyId"), tier: c.get("userTier"), userId: c.get("userId") }));

        const env = {
            ...createMockEnv({ apiKeyCacheRows: (options.rows ?? []) as NonNullable<Parameters<typeof createMockEnv>[0]>["apiKeyCacheRows"] }),
            LUNORA_URL: options.lunoraUrl ?? "",
            SIGNING_SECRET,
        } as unknown as HonoEnv["Bindings"];

        return (headers: Record<string, string>) => app.fetch(new Request("http://localhost/v1/test", { headers }), env, createMockCtx());
    };

    const bearer = (token: string) => {
        return { Authorization: `Bearer ${token}` };
    };

    it("accepts a key cached in D1 and exposes its identity", async () => {
        const row = await makeVirtualKeyRow(rawKey, { tier: "pro", user_id: "user-1" });
        const fetchApp = await makeApp({ rows: [row] });

        const res = await fetchApp(bearer(rawKey));

        expect(res.status).toBe(200);

        const json = (await res.json()) as { apiKeyId: string; tier: string; userId: string };

        expect(json.userId).toBe("user-1");
        expect(json.tier).toBe("pro");
        // The key id exposed downstream is the hash, never the raw token.
        expect(json.apiKeyId).toBe(await computeKeyHash(rawKey));
        expect(json.apiKeyId).not.toContain(rawKey);
    });

    it("rejects a missing Authorization header", async () => {
        const fetchApp = await makeApp();

        const response = await fetchApp({});

        expect(response.status).toBe(401);
    });

    it("rejects a token that is not a gateway key", async () => {
        const fetchApp = await makeApp();

        const response = await fetchApp(bearer("sk-not-a-gateway-key"));

        expect(response.status).toBe(401);
    });

    it("rejects a key the source of truth does not recognise", async () => {
        const fetchApp = await makeApp({ lunoraUrl: "https://lunora.test" });

        vi.stubGlobal("fetch", async () => new Response("no", { status: 404 }));

        try {
            const response = await fetchApp(bearer(rawKey));

            expect(response.status).toBe(401);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("rejects a key the source of truth reports as deactivated", async () => {
        const fetchApp = await makeApp({ lunoraUrl: "https://lunora.test" });

        vi.stubGlobal("fetch", async () => Response.json({ isActive: false, rateLimitRpm: 60, tier: "pro", userId: "user-1", usesOwnKeys: false }));

        try {
            const response = await fetchApp(bearer(rawKey));

            expect(response.status).toBe(401);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("fails closed with 503 when the source of truth is unreachable", async () => {
        const fetchApp = await makeApp({ lunoraUrl: "https://lunora.test" });

        vi.stubGlobal("fetch", async () => {
            throw new Error("connection refused");
        });

        try {
            // Not 401. An unreachable validator means "unknown", and answering
            // an unknown key with 401 would be indistinguishable from a real
            // rejection while an outage silently locks every caller out.
            const response = await fetchApp(bearer(rawKey));

            expect(response.status).toBe(503);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("fails closed with 503 when no validator is configured", async () => {
        const fetchApp = await makeApp({ lunoraUrl: "" });

        const response = await fetchApp(bearer(rawKey));

        expect(response.status).toBe(503);
    });
});
