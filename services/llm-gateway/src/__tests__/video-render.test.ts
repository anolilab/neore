/**
 * Behaviour tests for the video render core (`runVideoRender`,
 * `markRenderFailed`, and the `isTransient` heuristic exercised via
 * outcome shape).
 *
 * The AI SDK's `experimental_generateVideo` and the provider factory
 * are mocked so we can drive each branch without hitting fal/luma/etc.
 * R2 / D1 / KV use lightweight in-memory stubs that match the shape the
 * render core actually uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../env.js";
// Import after mocks so the SUT picks them up.
import type { VideoJobState } from "../routes/v1/video-render.js";
import type { VideoRenderMessage } from "../routes/v1/video-types.js";
import { MockD1Database, MockKVNamespace } from "./helpers/mock-env.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────
// Must hoist before importing the SUT.

vi.mock("ai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();

    return {
        ...actual,
        experimental_generateVideo: vi.fn(),
    };
});

vi.mock("../providers/video-factory.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../providers/video-factory.js")>();

    return {
        ...actual,
        createVideoModel: vi.fn(),
    };
});

// Usage tracker writes to D1 + may try to send notification webhooks; stub it
// out so tests stay focused on the render orchestration.
vi.mock("../usage/tracker.js", () => {
    return {
        // A plain function, not a class: `new UsageTracker()` yields the
        // returned object, and the file may only declare one class.
        UsageTracker: function UsageTracker() {
            return {
                record: async (): Promise<{ success: boolean }> => {
                    return { success: true };
                },
            };
        },
    };
});

const { experimental_generateVideo: generateVideo } = await import("ai");
const { createVideoModel } = await import("../providers/video-factory.js");
const { markRenderFailed, runVideoRender } = await import("../routes/v1/video-render.js");
const { VIDEO_RENDER_MESSAGE_VERSION, videoRenderSecretKvKey } = await import("../routes/v1/video-types.js");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal R2 bucket stub — only the methods the render core actually calls. */
class MockR2Bucket {
    public puts = new Map<string, { body: Uint8Array; contentType?: string; customMetadata?: Record<string, string> }>();

    async put(key: string, body: Uint8Array, options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } }): Promise<void> {
        this.puts.set(key, {
            body,
            contentType: options?.httpMetadata?.contentType,
            customMetadata: options?.customMetadata,
        });
    }

    async get(_key: string): Promise<null> {
        return null;
    }
}

interface TestEnvParts {
    bucket: MockR2Bucket;
    cacheKv: MockKVNamespace;
    db: MockD1Database;
    env: AppEnv;
    pricingKv: MockKVNamespace;
    rateLimitKv: MockKVNamespace;
}

const makeEnv = (): TestEnvParts => {
    const rateLimitKv = new MockKVNamespace();
    const cacheKv = new MockKVNamespace();
    const pricingKv = new MockKVNamespace();
    const database = new MockD1Database();
    const bucket = new MockR2Bucket();

    const env = {
        APP_NAME: "llm-gateway",
        APP_VERSION: "1.0.0",
        CACHE_KV: cacheKv as unknown as KVNamespace,
        NODE_ENV: "test",
        PRICING_KV: pricingKv as unknown as KVNamespace,
        RATE_LIMIT_KV: rateLimitKv as unknown as KVNamespace,
        SIGNING_SECRET: "test-signing-secret",
        USAGE_DB: database as unknown as D1Database,
        VIDEO_BUCKET: bucket as unknown as R2Bucket,
    } as unknown as AppEnv;

    return { bucket, cacheKv, db: database, env, pricingKv, rateLimitKv };
};

const makeMessage = (overrides: Partial<VideoRenderMessage> = {}): VideoRenderMessage => {
    return {
        _version: VIDEO_RENDER_MESSAGE_VERSION,
        apiKeyId: "key_xyz",
        body: { model: "fal/luma-ray-2", prompt: "hello" },
        enqueuedAt: Date.now(),
        isByok: false,
        jobId: "job_test_123",
        modelInfo: { costPerSecondMicrodollars: 50_000, modelApiId: "luma-ray-2", provider: "fal" },
        orgId: undefined,
        origin: "https://gw.example.com",
        parentTraceparent: undefined,
        requestId: "req_1",
        userId: "user_abc",
        ...overrides,
    };
};

const seedSecret = async (cacheKv: MockKVNamespace, jobId: string, value = "sk-test"): Promise<void> => {
    await cacheKv.put(videoRenderSecretKvKey(jobId), value);
};

const stubGenerateVideoSuccess = (): void => {
    vi.mocked(generateVideo).mockResolvedValue({
        video: {
            mediaType: "video/mp4",
            uint8Array: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), // tiny non-empty
        },
        // Other fields the SUT doesn't read — cast to any.
    } as unknown as Awaited<ReturnType<typeof generateVideo>>);
    vi.mocked(createVideoModel).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof createVideoModel>>);
};

beforeEach(() => {
    vi.mocked(generateVideo).mockReset();
    vi.mocked(createVideoModel).mockReset();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// ─── markRenderFailed ────────────────────────────────────────────────────────

describe("markRenderFailed", () => {
    it("writes a failed job to KV and deletes the API-key secret", async () => {
        const { cacheKv, env, rateLimitKv } = makeEnv();
        const message = makeMessage();

        await cacheKv.put(videoRenderSecretKvKey(message.jobId), "sk-test");

        await markRenderFailed(env, message, "provider blew up");

        const stored = (await rateLimitKv.get(`video_job:${message.jobId}`, "json")) as VideoJobState;

        expect(stored.status).toBe("failed");
        expect(stored.errorMessage).toBe("provider blew up");
        expect(stored.completedAt).toBeGreaterThan(0);
        // Secret cleanup is best-effort but expected on the happy path.
        expect(cacheKv.getRaw(videoRenderSecretKvKey(message.jobId))).toBeUndefined();
    });

    it("is idempotent — does not overwrite an already-completed job", async () => {
        const { env, rateLimitKv } = makeEnv();
        const message = makeMessage();

        const completed: VideoJobState = {
            completedAt: Date.now() - 5000,
            createdAt: Date.now() - 10_000,
            id: message.jobId,
            modelApiId: message.modelInfo.modelApiId,
            modelId: message.body.model,
            prompt: message.body.prompt,
            provider: message.modelInfo.provider,
            r2Key: "videos/x.mp4",
            status: "completed",
            userId: message.userId,
        };

        await rateLimitKv.put(`video_job:${message.jobId}`, JSON.stringify(completed));

        await markRenderFailed(env, message, "should be ignored");

        const stored = (await rateLimitKv.get(`video_job:${message.jobId}`, "json")) as VideoJobState;

        expect(stored.status).toBe("completed");
        expect(stored.errorMessage).toBeUndefined();
    });

    it("is idempotent — does not overwrite an already-failed job", async () => {
        const { env, rateLimitKv } = makeEnv();
        const message = makeMessage();

        const failed: VideoJobState = {
            completedAt: Date.now() - 5000,
            createdAt: Date.now() - 10_000,
            errorMessage: "original failure",
            id: message.jobId,
            modelApiId: message.modelInfo.modelApiId,
            modelId: message.body.model,
            prompt: message.body.prompt,
            provider: message.modelInfo.provider,
            status: "failed",
            userId: message.userId,
        };

        await rateLimitKv.put(`video_job:${message.jobId}`, JSON.stringify(failed));

        await markRenderFailed(env, message, "second failure should be ignored");

        const stored = (await rateLimitKv.get(`video_job:${message.jobId}`, "json")) as VideoJobState;

        expect(stored.errorMessage).toBe("original failure");
    });

    it("fires a webhook when callback_url is set", async () => {
        const { env } = makeEnv();
        const message = makeMessage({ body: { callback_url: "https://example.test/hook", model: "fal/luma-ray-2", prompt: "hi" } });
        const fetchMock = vi.mocked(fetch);

        await markRenderFailed(env, message, "boom");

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0]!;

        expect(url).toBe("https://example.test/hook");
        expect((init as RequestInit).method).toBe("POST");
        const payload = JSON.parse((init as RequestInit).body as string) as { data: { error: string; status: string }; type: string };

        expect(payload.type).toBe("video.generation.failed");
        expect(payload.data.status).toBe("failed");
        expect(payload.data.error).toBe("boom");
    });

    it("does not fire a webhook when callback_url is absent", async () => {
        const { env } = makeEnv();
        const message = makeMessage();
        const fetchMock = vi.mocked(fetch);

        await markRenderFailed(env, message, "boom");

        expect(fetchMock).not.toHaveBeenCalled();
    });
});

// ─── runVideoRender ──────────────────────────────────────────────────────────

describe("runVideoRender — idempotency", () => {
    it("skips when the job is already completed", async () => {
        const { cacheKv, env, rateLimitKv } = makeEnv();
        const message = makeMessage();

        await rateLimitKv.put(
            `video_job:${message.jobId}`,
            JSON.stringify({
                createdAt: Date.now(),
                id: message.jobId,
                modelApiId: "luma-ray-2",
                modelId: message.body.model,
                prompt: "x",
                provider: "fal",
                status: "completed",
                userId: message.userId,
            } satisfies VideoJobState),
        );
        await seedSecret(cacheKv, message.jobId);

        const outcome = await runVideoRender(message, env);

        expect(outcome).toEqual({ kind: "skipped", reason: "already-completed" });
        expect(vi.mocked(generateVideo)).not.toHaveBeenCalled();
    });

    it("skips when the job is already failed (does not resurrect)", async () => {
        const { cacheKv, env, rateLimitKv } = makeEnv();
        const message = makeMessage();

        await rateLimitKv.put(
            `video_job:${message.jobId}`,
            JSON.stringify({
                createdAt: Date.now(),
                id: message.jobId,
                modelApiId: "luma-ray-2",
                modelId: message.body.model,
                prompt: "x",
                provider: "fal",
                status: "failed",
                userId: message.userId,
            } satisfies VideoJobState),
        );
        await seedSecret(cacheKv, message.jobId);

        const outcome = await runVideoRender(message, env);

        expect(outcome).toEqual({ kind: "skipped", reason: "already-completed" });
        expect(vi.mocked(generateVideo)).not.toHaveBeenCalled();
    });
});

describe("runVideoRender — secret indirection", () => {
    it("marks the job failed (non-retryable) when the CACHE_KV secret is missing", async () => {
        const { env, rateLimitKv } = makeEnv();
        const message = makeMessage();

        // No seed — CACHE_KV.get returns null.
        const outcome = await runVideoRender(message, env);

        expect(outcome).toEqual({
            errorMessage: "Provider API key reference expired before render",
            kind: "failed",
            retryable: false,
        });
        const stored = (await rateLimitKv.get(`video_job:${message.jobId}`, "json")) as VideoJobState;

        expect(stored.status).toBe("failed");
        expect(vi.mocked(generateVideo)).not.toHaveBeenCalled();
    });
});

describe("runVideoRender — successful render", () => {
    it("uploads to R2, persists completed state, deletes the secret, and returns completed", async () => {
        const { bucket, cacheKv, env, rateLimitKv } = makeEnv();
        const message = makeMessage({ body: { duration: 4, model: "fal/luma-ray-2", prompt: "hi" } });

        await seedSecret(cacheKv, message.jobId);
        stubGenerateVideoSuccess();

        const outcome = await runVideoRender(message, env);

        if (outcome.kind !== "completed") {
            throw new Error(`expected completed, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
        }

        // 4s × 50_000 µ$/s = 200_000 µ$.
        expect(outcome.costMicrodollars).toBe(200_000);

        // R2 received the bytes.
        const expectedKey = `videos/${message.userId}/${message.jobId}.mp4`;
        const r2Entry = bucket.puts.get(expectedKey);

        expect(r2Entry).toBeDefined();
        expect(r2Entry?.contentType).toBe("video/mp4");
        expect(r2Entry?.customMetadata).toMatchObject({ jobId: message.jobId, modelId: message.body.model, userId: message.userId });

        // KV says completed.
        const stored = (await rateLimitKv.get(`video_job:${message.jobId}`, "json")) as VideoJobState;

        expect(stored.status).toBe("completed");
        expect(stored.r2Key).toBe(expectedKey);
        expect(stored.costMicrodollars).toBe(200_000);

        // Secret was released.
        expect(cacheKv.getRaw(videoRenderSecretKvKey(message.jobId))).toBeUndefined();
    });

    it("zeroes cost for BYOK renders", async () => {
        const { cacheKv, env } = makeEnv();
        const message = makeMessage({ body: { duration: 8, model: "fal/luma-ray-2", prompt: "hi" }, isByok: true });

        await seedSecret(cacheKv, message.jobId);
        stubGenerateVideoSuccess();

        const outcome = await runVideoRender(message, env);

        if (outcome.kind !== "completed") throw new Error("expected completed");

        expect(outcome.costMicrodollars).toBe(0);
    });

    it("fires a completed webhook when callback_url is set", async () => {
        const { cacheKv, env } = makeEnv();
        const message = makeMessage({
            body: { callback_url: "https://example.test/hook", duration: 5, model: "fal/luma-ray-2", prompt: "hi" },
        });

        await seedSecret(cacheKv, message.jobId);
        stubGenerateVideoSuccess();

        const fetchMock = vi.mocked(fetch);

        await runVideoRender(message, env);

        const webhookCalls = fetchMock.mock.calls.filter(([url]) => url === "https://example.test/hook");

        expect(webhookCalls).toHaveLength(1);
        const payload = JSON.parse((webhookCalls[0]![1] as RequestInit).body as string) as {
            data: { unsigned_urls: string[] };
            type: string;
        };

        expect(payload.type).toBe("video.generation.completed");
        expect(payload.data.unsigned_urls[0]).toBe(`${message.origin}/v1/videos/${message.jobId}/content?index=0`);
    });
});

describe("runVideoRender — error classification", () => {
    it("returns retryable=true and does NOT call markRenderFailed for transient errors (HTTP 503)", async () => {
        const { cacheKv, env, rateLimitKv } = makeEnv();
        const message = makeMessage();

        await seedSecret(cacheKv, message.jobId);
        vi.mocked(createVideoModel).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof createVideoModel>>);
        vi.mocked(generateVideo).mockRejectedValue(new Error("fal returned 503 Service Unavailable"));

        const outcome = await runVideoRender(message, env);

        expect(outcome.kind).toBe("failed");

        if (outcome.kind !== "failed") throw new Error("unreachable");

        expect(outcome.retryable).toBe(true);

        // Job remains in_progress because the consumer may retry; the consumer
        // is responsible for finalising failure when the retry budget runs out.
        const stored = (await rateLimitKv.get(`video_job:${message.jobId}`, "json")) as VideoJobState;

        expect(stored.status).toBe("in_progress");
    });

    it("returns retryable=true for AbortError", async () => {
        const { cacheKv, env } = makeEnv();
        const message = makeMessage();

        await seedSecret(cacheKv, message.jobId);
        vi.mocked(createVideoModel).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof createVideoModel>>);
        // The genuine article: `DOMException` already carries name "AbortError".
        const error = new DOMException("aborted", "AbortError");

        vi.mocked(generateVideo).mockRejectedValue(error);

        const outcome = await runVideoRender(message, env);

        if (outcome.kind !== "failed") throw new Error("unreachable");

        expect(outcome.retryable).toBe(true);
    });

    it("returns retryable=true for an error carrying a numeric statusCode 429", async () => {
        const { cacheKv, env } = makeEnv();
        const message = makeMessage();

        await seedSecret(cacheKv, message.jobId);
        vi.mocked(createVideoModel).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof createVideoModel>>);
        const error = Object.assign(new Error("rate limited"), { statusCode: 429 });

        vi.mocked(generateVideo).mockRejectedValue(error);

        const outcome = await runVideoRender(message, env);

        if (outcome.kind !== "failed") throw new Error("unreachable");

        expect(outcome.retryable).toBe(true);
    });

    it("returns retryable=false and persists failed state for terminal errors (validation)", async () => {
        const { cacheKv, env, rateLimitKv } = makeEnv();
        const message = makeMessage();

        await seedSecret(cacheKv, message.jobId);
        vi.mocked(createVideoModel).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof createVideoModel>>);
        vi.mocked(generateVideo).mockRejectedValue(new Error("prompt failed safety review"));

        const outcome = await runVideoRender(message, env);

        expect(outcome.kind).toBe("failed");

        if (outcome.kind !== "failed") throw new Error("unreachable");

        expect(outcome.retryable).toBe(false);

        const stored = (await rateLimitKv.get(`video_job:${message.jobId}`, "json")) as VideoJobState;

        expect(stored.status).toBe("failed");
        expect(stored.errorMessage).toBe("prompt failed safety review");
    });

    it("returns retryable=true when the error's statusCode is 500", async () => {
        const { cacheKv, env } = makeEnv();
        const message = makeMessage();

        await seedSecret(cacheKv, message.jobId);
        vi.mocked(createVideoModel).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof createVideoModel>>);
        // Plain object thrown — the SDK sometimes throws non-Error values.

        vi.mocked(generateVideo).mockRejectedValue({ message: "upstream", statusCode: 500 });

        const outcome = await runVideoRender(message, env);

        if (outcome.kind !== "failed") throw new Error("unreachable");

        expect(outcome.retryable).toBe(true);
    });
});
