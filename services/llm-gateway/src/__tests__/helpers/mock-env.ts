/**
 * Mock Cloudflare Workers bindings for integration tests.
 *
 * Provides in-memory D1 and KV implementations that match the shape
 * required by the LLM Gateway, without any real Cloudflare infrastructure.
 */

import { MockKVNamespace } from "./mock-kv.js";

export { MockKVNamespace } from "./mock-kv.js";

const ACTIVE_LITERAL_RE = /\bis_active\s*=\s*1\b/;
const NOT_EXPIRED_LITERAL_RE = /\bexpires_at\s*>\s*datetime\('now'\)/;
const TABLE_NAME_RE = /\bFROM\s+(\w+)|\bINTO\s+(\w+)|\bUPDATE\s+(\w+)/i;

// ── Mock D1 ──────────────────────────────────────────────────────────────────

/** A D1 column value, as the mock stores and returns it. */
type MockD1Value = ArrayBuffer | boolean | null | number | string;

type MockD1Row = Record<string, MockD1Value>;

export interface MockD1PreparedStatement {
    all: <T = MockD1Row>() => Promise<{ results: T[]; success: boolean }>;
    bind: (...values: unknown[]) => MockD1PreparedStatement;
    first: <T = MockD1Row>() => Promise<T | null>;
    raw: <T = unknown[]>() => Promise<T[]>;
    run: () => Promise<{ meta: Record<string, number | string>; success: boolean }>;
}

function createStatement(sql: string, tables: Map<string, MockD1Row[]>): MockD1PreparedStatement {
    let parameters: unknown[] = [];

    const extractTable = (): string | null => {
        const match = TABLE_NAME_RE.exec(sql);

        return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
    };

    const statement: MockD1PreparedStatement = {
        all: async <T = MockD1Row>() => {
            const table = extractTable();

            if (!table) return { results: [] as T[], success: true };

            return { results: (tables.get(table) ?? []) as T[], success: true };
        },
        bind: (...values: unknown[]) => {
            parameters = values;

            return statement;
        },
        first: async <T = MockD1Row>() => {
            const table = extractTable();

            if (!table) return null;

            const rows = tables.get(table) ?? [];

            if (rows.length === 0) return null;

            if (parameters.length === 0) return ((rows[0] as T) ?? null) as T | null;

            // Filter by bound params — covers key_hash = ? lookups.
            let candidates = rows.filter((row) => parameters.some((parameter) => (Object.values(row) as unknown[]).includes(parameter)));

            // Apply literal WHERE conditions present in the SQL.
            // This handles the api_key_cache query:
            //   WHERE key_hash = ? AND is_active = 1 AND expires_at > datetime('now')
            if (ACTIVE_LITERAL_RE.test(sql)) {
                candidates = candidates.filter((row) => row["is_active"] === 1);
            }

            if (NOT_EXPIRED_LITERAL_RE.test(sql)) {
                candidates = candidates.filter((row) => {
                    const exp = row["expires_at"];

                    if (exp === null || exp === undefined) return false;

                    return new Date(exp as string) > new Date();
                });
            }

            return (candidates[0] ?? null) as T | null;
        },
        raw: async <T = unknown[]>() => [] as T[],
        run: async () => {
            return { meta: {}, success: true };
        },
    };

    return statement;
}

export class MockD1Database {
    private tables = new Map<string, MockD1Row[]>();

    /** Seed a table with rows for use in first() / all() lookups. */
    seed(table: string, rows: MockD1Row[]): this {
        this.tables.set(table, rows);

        return this;
    }

    prepare(sql: string): MockD1PreparedStatement {
        return createStatement(sql, this.tables);
    }

    async batch(statements: MockD1PreparedStatement[]): Promise<unknown[]> {
        return Promise.all(statements.map((s) => s.run()));
    }

    async exec(_query: string): Promise<{ count: number; duration: number }> {
        return { count: 0, duration: 0 };
    }

    async dump(): Promise<ArrayBuffer> {
        return new ArrayBuffer(0);
    }
}

// ── Mock execution context ────────────────────────────────────────────────────

/**
 * Structurally what `app.fetch()` needs, plus `flush()`.
 *
 * Deliberately NOT `extends ExecutionContext`. This repo's
 * `@cloudflare/workers-types` declares `exports`, `tracing` and `abort` on that
 * interface too, and a test double is not obliged to implement the whole
 * runtime surface to be handed to `app.fetch()` — extending it only moves the
 * failure from "missing mock" to "missing field nobody calls".
 */
export interface MockExecutionContext {
    /** Settle everything handed to `waitUntil`, for tests that assert on background work. */
    flush: () => Promise<void>;
    passThroughOnException: () => void;
    props: unknown;
    waitUntil: (promise: Promise<unknown>) => void;
}

export function createMockCtx(): MockExecutionContext {
    const pending: Promise<unknown>[] = [];

    return {
        async flush() {
            await Promise.allSettled(pending);
            pending.length = 0;
        },
        passThroughOnException() {},
        props: {},
        waitUntil(promise: Promise<unknown>) {
            pending.push(promise);
        },
    };
}

// ── Mock env factory ──────────────────────────────────────────────────────────

export interface MockEnvOptions {
    /**
     * Pre-seed api_key_cache rows — the primary table checked by bearerAuth.
     * Each row must have fields matching ApiKeyCacheRow: key_hash, user_id,
     * org_id, tier, rate_limit_rpm, is_active, uses_own_keys, expires_at.
     * Use makeVirtualKeyRow() to build correctly-shaped rows.
     */
    apiKeyCacheRows?: MockD1Row[];
    /** Custom CACHE_KV state */
    cacheKv?: MockKVNamespace;
    /** Node env (default: "test") */
    nodeEnv?: string;
    /** Custom PRICING_KV state */
    pricingKv?: MockKVNamespace;
    /** Custom RATE_LIMIT_KV state */
    rateLimitKv?: MockKVNamespace;
}

export function createMockEnv(options: MockEnvOptions = {}) {
    const database = new MockD1Database();

    if (options.apiKeyCacheRows) {
        database.seed("api_key_cache", options.apiKeyCacheRows);
    }

    const rateLimitKv = options.rateLimitKv ?? new MockKVNamespace();
    const pricingKv = options.pricingKv ?? new MockKVNamespace();
    const cacheKv = options.cacheKv ?? new MockKVNamespace();

    return {
        ALLOWED_ORIGINS: undefined,
        APP_NAME: "llm-gateway-test",
        APP_VERSION: "0.0.0-test",
        CACHE_KV: cacheKv as unknown as KVNamespace,
        GOOGLE_API_KEY: "test-google-key",
        GROQ_API_KEY: "test-groq-key",
        LUNORA_URL: "https://lunora-test.invalid",
        NODE_ENV: options.nodeEnv ?? "test",
        OPENAI_API_KEY: "test-openai-key",
        OPENROUTER_API_KEY: "test-openrouter-key",
        PRICING_KV: pricingKv as unknown as KVNamespace,
        RATE_LIMIT_KV: rateLimitKv as unknown as KVNamespace,
        SIGNING_SECRET: "test-signing-secret",
        USAGE_DB: database as unknown as D1Database,
        XAI_API_KEY: "test-xai-key",
    };
}

/**
 * Compute SHA-256 hex of a string — used to pre-seed the api_key_cache table.
 *
 * Uses ArrayBuffer (via slice) to exactly match the hash computation in
 * bearerAuth: sha256Hex(new TextEncoder().encode(token).buffer as ArrayBuffer).
 */
export async function computeKeyHash(rawToken: string): Promise<string> {
    const encoded = new TextEncoder().encode(rawToken);
    // Digest the view directly — `digest` accepts a BufferSource, and `.buffer`
    // is typed `ArrayBuffer | SharedArrayBuffer`, which it does not.
    const hash = await crypto.subtle.digest("SHA-256", encoded);

    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build a virtual api_key_cache row for a test bearer token.
 *
 * The schema matches ApiKeyCacheRow in middleware/auth.ts.
 * expires_at defaults to 10 minutes from now (non-null, like a real cached entry).
 */
export async function makeVirtualKeyRow(rawToken: string, overrides: Partial<MockD1Row> = {}): Promise<MockD1Row> {
    const hash = await computeKeyHash(rawToken);

    return {
        expires_at: new Date(Date.now() + 600_000).toISOString(), // 10 min from now
        is_active: 1,
        key_hash: hash,
        org_id: null,
        rate_limit_rpm: 120,
        tier: "pro",
        user_id: "user-test-001",
        uses_own_keys: 0,
        ...overrides,
    };
}
