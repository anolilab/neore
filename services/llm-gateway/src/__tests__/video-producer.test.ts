/**
 * Integration tests for the video producer (POST /v1/videos) and a unit
 * test for the `resolveCanonicalOrigin` helper.
 *
 * Producer error paths added during the queue migration:
 *   - CACHE_KV.put failure   → 503 + KV job marked failed
 *   - VIDEO_RENDER_QUEUE.send failure → 503 + KV job marked failed + CACHE_KV secret cleaned
 *
 * Auth/rate-limit middleware run for real against the mock env (RATE_LIMIT_KV
 * starts empty so the rate-limit bucket has full budget). The AI SDK and
 * provider factory are stubbed so we never actually try to hit fal.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { app } from "../index.js";
import { resolveCanonicalOrigin } from "../routes/v1/video.js";
import type { VideoJobState } from "../routes/v1/video-render.js";
import { videoRenderSecretKvKey } from "../routes/v1/video-types.js";
import { computeKeyHash, createMockCtx as createMockContext, createMockEnv, makeVirtualKeyRow, MockKVNamespace } from "./helpers/mock-env.js";

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

vi.mock("ai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();

    return {
        ...actual,
        experimental_generateVideo: vi.fn(),
    };
});

vi.mock("../providers/factory.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../providers/factory.js")>();

    return {
        ...actual,
        resolveApiKey: vi.fn().mockReturnValue("sk-test-fal"),
    };
});

const TEST_TOKEN = "gk_video_producer_test_abc";

// ─── Cloudflare-binding stubs ────────────────────────────────────────────────

const createR2Bucket = () => {
    return {
        get: async (): Promise<null> => null,
        put: async (): Promise<void> => {},
    };
};

interface MockQueue<T> {
    send: (message: T) => Promise<void>;
    sendImpl: (m: T) => Promise<void>;
    sent: T[];
}

const createQueue = <T>(): MockQueue<T> => {
    const queue: MockQueue<T> = {
        send: async (message) => queue.sendImpl(message),
        sendImpl: async (m) => {
            queue.sent.push(m);
        },
        sent: [],
    };

    return queue;
};

/** A KV that throws on put — for the CACHE_KV-write-failure branch. */
class ThrowingPutKV extends MockKVNamespace {
    async put(): Promise<void> {
        throw new Error("KV put quota exceeded");
    }
}

interface BuildEnvOptions {
    cacheKv?: MockKVNamespace;
    publicGatewayUrl?: string;
    queue?: MockQueue<unknown>;
}

const buildEnv = async (options: BuildEnvOptions = {}) => {
    const validRow = await makeVirtualKeyRow(TEST_TOKEN, { tier: "pro", user_id: "user-test-001" });
    const base = createMockEnv({
        apiKeyCacheRows: [validRow],
        cacheKv: options.cacheKv,
    });

    const queue = options.queue ?? createQueue<unknown>();
    const bucket = createR2Bucket();

    return {
        bucket,
        cacheKv: (options.cacheKv ?? base.CACHE_KV) as unknown as MockKVNamespace,
        env: {
            ...base,
            PUBLIC_GATEWAY_URL: options.publicGatewayUrl,
            VIDEO_BUCKET: bucket as unknown as R2Bucket,
            VIDEO_RENDER_QUEUE: queue as unknown as Queue<unknown>,
        } as unknown as Parameters<typeof app.fetch>[1],
        queue,
        rateLimitKv: base.RATE_LIMIT_KV as unknown as MockKVNamespace,
    };
};

const buildRequest = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://gw.example.test/v1/videos", {
        body: JSON.stringify(body),
        headers: {
            Authorization: `Bearer ${TEST_TOKEN}`,
            "Content-Type": "application/json",
            ...headers,
        },
        method: "POST",
    });

const VALID_BODY = { model: "fal/luma-ray-2", prompt: "a tabby cat surfing" };

beforeEach(() => {
    vi.clearAllMocks();
});

// ─── resolveCanonicalOrigin ──────────────────────────────────────────────────

describe("resolveCanonicalOrigin", () => {
    it("prefers PUBLIC_GATEWAY_URL when set", () => {
        const env = { PUBLIC_GATEWAY_URL: "https://gw.prod.example.com" } as never;

        expect(resolveCanonicalOrigin(env, "https://host-header-spoof/v1/videos")).toBe("https://gw.prod.example.com");
        // The scheme is attacker-controlled too, so a plain-http request URL must
        // not downgrade the origin either. `no-clear-text-protocols` does not get
        // to decide what a spoofed URL looks like.
        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- the http here IS the attack under test
        expect(resolveCanonicalOrigin(env, "http://host-header-spoof/v1/videos")).toBe("https://gw.prod.example.com");
    });

    it("strips a trailing slash from PUBLIC_GATEWAY_URL", () => {
        const env = { PUBLIC_GATEWAY_URL: "https://gw.prod.example.com/" } as never;

        expect(resolveCanonicalOrigin(env, "https://anything/v1/videos")).toBe("https://gw.prod.example.com");
    });

    it("falls back to the request origin when PUBLIC_GATEWAY_URL is undefined", () => {
        const env = {} as never;

        expect(resolveCanonicalOrigin(env, "https://localhost:8787/v1/videos")).toBe("https://localhost:8787");
    });

    it("falls back to the request origin when PUBLIC_GATEWAY_URL is empty string", () => {
        const env = { PUBLIC_GATEWAY_URL: "" } as never;

        expect(resolveCanonicalOrigin(env, "https://localhost:8787/v1/videos")).toBe("https://localhost:8787");
    });
});

// ─── POST /v1/videos ─────────────────────────────────────────────────────────

describe("POST /v1/videos — happy path", () => {
    it("returns 202 with polling_url derived from PUBLIC_GATEWAY_URL and enqueues a message", async () => {
        const { cacheKv, env, queue, rateLimitKv } = await buildEnv({ publicGatewayUrl: "https://canonical.gw" });
        const request = buildRequest(VALID_BODY);

        const res = await app.fetch(request, env, createMockContext() as unknown as ExecutionContext);

        expect(res.status).toBe(202);
        const body = (await res.json()) as { id: string; polling_url: string; status: string };

        expect(body.status).toBe("pending");
        expect(body.polling_url).toBe(`https://canonical.gw/v1/videos/${body.id}`);

        // Message enqueued with the same jobId.
        expect(queue.sent).toHaveLength(1);
        const message = queue.sent[0] as { jobId: string; origin: string };

        expect(message.jobId).toBe(body.id);
        expect(message.origin).toBe("https://canonical.gw");

        // Secret stashed in CACHE_KV.
        expect(cacheKv.getRaw(videoRenderSecretKvKey(body.id))).toBe("sk-test-fal");

        // Pending job written to RATE_LIMIT_KV.
        const stored = (await rateLimitKv.get(`video_job:${body.id}`, "json")) as VideoJobState;

        expect(stored.status).toBe("pending");
    });
});

// ─── POST /v1/videos — failure paths ─────────────────────────────────────────

describe("POST /v1/videos — failure paths", () => {
    it("returns 400 for an unknown model", async () => {
        const { env } = await buildEnv();
        const request = buildRequest({ ...VALID_BODY, model: "fal/does-not-exist" });

        const res = await app.fetch(request, env, createMockContext() as unknown as ExecutionContext);

        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };

        expect(body.error).toContain("not found");
    });

    it("returns 503 when CACHE_KV.put fails, marks job failed, and does NOT enqueue", async () => {
        const { env, queue, rateLimitKv } = await buildEnv({ cacheKv: new ThrowingPutKV() });
        const request = buildRequest(VALID_BODY);

        const res = await app.fetch(request, env, createMockContext() as unknown as ExecutionContext);

        expect(res.status).toBe(503);
        const body = (await res.json()) as { error: { code: string } };

        expect(body.error.code).toBe("QUEUE_ENQUEUE_FAILED");

        expect(queue.sent).toHaveLength(0);

        // Pending → failed transition in RATE_LIMIT_KV. We don't know the
        // randomly-generated jobId here, so walk the internal store.
        const internalStore = (rateLimitKv as unknown as { store: Map<string, string> }).store;
        const jobEntries = internalStore
            .entries()
            .filter(([k]) => k.startsWith("video_job:"))
            .toArray();

        expect(jobEntries).toHaveLength(1);
        const job = JSON.parse(jobEntries[0]![1]) as VideoJobState;

        expect(job.status).toBe("failed");
        expect(job.errorMessage).toBe("Failed to persist render credentials");
    });

    it("returns 503 when VIDEO_RENDER_QUEUE.send fails, cleans up CACHE_KV secret, and marks job failed", async () => {
        const failingQueue = createQueue<unknown>();

        failingQueue.sendImpl = async () => {
            throw new Error("queue unreachable");
        };
        const { cacheKv, env, rateLimitKv } = await buildEnv({ queue: failingQueue });

        const request = buildRequest(VALID_BODY);
        const res = await app.fetch(request, env, createMockContext() as unknown as ExecutionContext);

        expect(res.status).toBe(503);
        const body = (await res.json()) as { error: { code: string } };

        expect(body.error.code).toBe("QUEUE_ENQUEUE_FAILED");

        // CACHE_KV secret was deleted on cleanup.
        expect(cacheKv.size()).toBe(0);

        // Pending → failed transition in RATE_LIMIT_KV.
        const internalStore = (rateLimitKv as unknown as { store: Map<string, string> }).store;
        const jobEntries = internalStore
            .entries()
            .filter(([k]) => k.startsWith("video_job:"))
            .toArray();

        expect(jobEntries).toHaveLength(1);
        const job = JSON.parse(jobEntries[0]![1]) as VideoJobState;

        expect(job.status).toBe("failed");
        expect(job.errorMessage).toBe("Failed to enqueue render job");
    });
});

// ─── Auth + validation guards (regression coverage for middleware order) ────

describe("POST /v1/videos — auth & validation", () => {
    it("returns 401 without a bearer token", async () => {
        const { env } = await buildEnv();
        const request = new Request("https://gw.example.test/v1/videos", {
            body: JSON.stringify(VALID_BODY),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        const res = await app.fetch(request, env, createMockContext() as unknown as ExecutionContext);

        expect(res.status).toBe(401);
    });

    it("returns 400 for an empty prompt", async () => {
        const { env } = await buildEnv();
        const request = buildRequest({ ...VALID_BODY, prompt: "" });
        const res = await app.fetch(request, env, createMockContext() as unknown as ExecutionContext);

        expect(res.status).toBe(400);
    });
});

beforeAll(async () => {
    // Sanity check that the test token hashes to something — guards against
    // crypto.subtle being unavailable in the test runtime.
    const hash = await computeKeyHash(TEST_TOKEN);

    expect(hash).toMatch(SHA256_HEX_RE);
});
