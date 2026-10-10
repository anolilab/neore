import { beforeEach, describe, expect, it, vi } from "vitest";

import { is429Error, KeyPoolManager, parseKeyList } from "../providers/key-pool.js";

// ---------------------------------------------------------------------------
// Minimal KV mock
// ---------------------------------------------------------------------------

type KvEntry = { expireAt?: number; value: string };

const makeMockKv = (): KVNamespace => {
    const store = new Map<string, KvEntry>();

    const kv = {
        delete: vi.fn(async (key: string) => {
            store.delete(key);
        }),
        get: vi.fn(async (key: string) => {
            const entry = store.get(key);

            if (!entry) return null;

            if (entry.expireAt && Date.now() > entry.expireAt) {
                store.delete(key);

                return null;
            }

            return entry.value;
        }),
        getWithMetadata: vi.fn(),
        // stub unused KV methods
        list: vi.fn(),
        put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
            store.set(key, {
                expireAt: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : undefined,
                value,
            });
        }),
    } as unknown as KVNamespace;

    return kv;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseKeyList", () => {
    it("splits a comma-separated string", () => {
        expect(parseKeyList("key1,key2,key3")).toEqual(["key1", "key2", "key3"]);
    });

    it("trims whitespace", () => {
        expect(parseKeyList("  key1 , key2  , key3  ")).toEqual(["key1", "key2", "key3"]);
    });

    it("filters empty entries", () => {
        expect(parseKeyList("key1,,key2")).toEqual(["key1", "key2"]);
    });

    it("handles single key", () => {
        expect(parseKeyList("sk-abc123")).toEqual(["sk-abc123"]);
    });
});

describe("is429Error", () => {
    it("detects statusCode 429", () => {
        expect(is429Error({ statusCode: 429 })).toBe(true);
    });

    it("detects status 429", () => {
        expect(is429Error({ status: 429 })).toBe(true);
    });

    it("detects 429 in message string", () => {
        expect(is429Error({ message: "Provider returned 429 Too Many Requests" })).toBe(true);
    });

    it("returns false for non-429 errors", () => {
        expect(is429Error({ statusCode: 500 })).toBe(false);
        expect(is429Error({ statusCode: 400 })).toBe(false);
        expect(is429Error({ message: "content policy violation" })).toBe(false);
    });

    it("returns false for non-objects", () => {
        expect(is429Error(null)).toBe(false);
        expect(is429Error("error")).toBe(false);
        expect(is429Error(undefined)).toBe(false);
    });
});

describe("KeyPoolManager", () => {
    let kv: KVNamespace;

    beforeEach(() => {
        kv = makeMockKv();
    });

    describe("selectKey — single key pool", () => {
        it("always returns the only key", async () => {
            const pool = new KeyPoolManager(kv, "openai", "gpt-4o", ["key1"]);
            const selected = await pool.selectKey();

            expect(selected).toEqual({ index: 0, key: "key1" });
        });
    });

    describe("selectKey — 3-key pool, one in cooldown", () => {
        it("skips the cooling-down key and picks among healthy ones", async () => {
            const pool = new KeyPoolManager(kv, "openai", "gpt-4o", ["key0", "key1", "key2"]);

            // Put key1 (index=1) in cooldown
            await pool.recordRateLimit(1);

            const selected = await pool.selectKey();

            expect(selected.index).not.toBe(1);
            expect(["key0", "key2"]).toContain(selected.key);
        });

        it("returns least-busy key when two keys are healthy", async () => {
            const pool = new KeyPoolManager(kv, "openai", "gpt-4o", ["key0", "key1", "key2"]);

            // key0 is in cooldown
            await pool.recordRateLimit(0);
            // key2 has higher RPM than key1
            await pool.recordUsage(2);
            await pool.recordUsage(2);
            await pool.recordUsage(1);

            const selected = await pool.selectKey();

            // key1 has rpm=1, key2 has rpm=2 — key1 wins
            expect(selected).toEqual({ index: 1, key: "key1" });
        });
    });

    describe("selectKey — all keys in cooldown", () => {
        it("returns first key as fallback when all are cooling down", async () => {
            const pool = new KeyPoolManager(kv, "openai", "gpt-4o", ["key0", "key1", "key2"]);

            await pool.recordRateLimit(0);
            await pool.recordRateLimit(1);
            await pool.recordRateLimit(2);

            const selected = await pool.selectKey();

            // Falls back to index 0 (first in list)
            expect(selected.index).toBe(0);
        });
    });

    describe("recordUsage", () => {
        it("increments the RPM counter", async () => {
            const pool = new KeyPoolManager(kv, "openai", "gpt-4o", ["key0"]);

            await pool.recordUsage(0);
            await pool.recordUsage(0);
            expect(kv.put).toHaveBeenCalledTimes(2);
        });

        it("does not throw if KV throws", async () => {
            vi.mocked(kv.put).mockRejectedValueOnce(new Error("KV unavailable"));
            const pool = new KeyPoolManager(kv, "openai", "gpt-4o", ["key0"]);

            await expect(pool.recordUsage(0)).resolves.toBeUndefined();
        });
    });

    describe("recordRateLimit", () => {
        it("stores a cooldown marker with 30s TTL", async () => {
            const pool = new KeyPoolManager(kv, "openai", "gpt-4o", ["key0"]);

            await pool.recordRateLimit(0);
            expect(kv.put).toHaveBeenCalledWith("pool:openai:gpt-4o:0:cooldown", "1", { expirationTtl: 30 });
        });
    });

    describe("withModel — retry on 429", () => {
        it("retries with a different key after 429 and succeeds", async () => {
            const pool = new KeyPoolManager(kv, "openai", "gpt-4o", ["key0", "key1", "key2"]);

            let callCount = 0;
            const callback = vi.fn().mockImplementation(async () => {
                callCount++;

                if (callCount === 1) {
                    // First call simulates 429
                    const error = Object.assign(new Error("Rate limit"), { statusCode: 429 });

                    throw error;
                }

                return "success";
            });

            // Patch createProviderModel to just pass the key through as the "model"
            // We test withModel's retry logic using a wrapper around the fn argument
            // that receives a fake model.
            const result = await pool["withModel"]!(callback as unknown as (m: unknown) => Promise<string>);

            expect(result).toBe("success");
            expect(callback).toHaveBeenCalledTimes(2);
        });

        it("throws after exhausting all keys", async () => {
            const pool = new KeyPoolManager(kv, "openai", "gpt-4o", ["key0", "key1"]);

            const callback = vi.fn().mockImplementation(async () => {
                const error = Object.assign(new Error("Rate limit"), { statusCode: 429 });

                throw error;
            });

            await expect(pool["withModel"]!(callback as unknown as (m: unknown) => Promise<string>)).rejects.toMatchObject({
                message: "Rate limit",
            });
            expect(callback).toHaveBeenCalledTimes(2); // one per key in pool
        });

        it("does not retry on non-429 errors", async () => {
            const pool = new KeyPoolManager(kv, "openai", "gpt-4o", ["key0", "key1", "key2"]);

            const callback = vi.fn().mockRejectedValue(new Error("Provider internal error"));

            await expect(pool["withModel"]!(callback as unknown as (m: unknown) => Promise<string>)).rejects.toThrow("Provider internal error");
            expect(callback).toHaveBeenCalledTimes(1); // no retry
        });
    });
});
