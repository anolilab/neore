/**
 * Behaviour tests for the video-render queue consumer.
 *
 * The render core (`runVideoRender`) and the terminal-state helper
 * (`markRenderFailed`) are mocked out so we can exercise ack/retry/DLQ
 * decisions against each `RenderOutcome` shape without hitting providers,
 * R2, or D1. Telemetry uses the real `RequestTelemetry` — it no-ops when
 * no OTLP endpoint is configured, which is what we want for unit tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../env.js";
import type { VideoRenderMessage } from "../routes/v1/video-types.js";
import { VIDEO_RENDER_MESSAGE_VERSION } from "../routes/v1/video-types.js";

const runVideoRenderMock = vi.fn();
const markRenderFailedMock = vi.fn();

vi.mock("../routes/v1/video-render.js", () => {
    return {
        markRenderFailed: markRenderFailedMock,
        runVideoRender: runVideoRenderMock,
    };
});

// Import after mock so the consumer picks up the mocked render core.
const { handleVideoRenderBatch } = await import("../queue/video-render-consumer.js");

const baseEnv = {
    APP_NAME: "llm-gateway",
    APP_VERSION: "1.0.0",
    NODE_ENV: "test",
} as unknown as AppEnv;

const makeContext = (): ExecutionContext =>
    ({
        passThroughOnException: vi.fn(),
        props: {},
        waitUntil: vi.fn(),
    }) as unknown as ExecutionContext;

const makeMessage = (overrides: Partial<VideoRenderMessage> = {}, messageOverrides: Partial<Message<VideoRenderMessage>> = {}) => {
    const body: VideoRenderMessage = {
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

    const message: Message<VideoRenderMessage> = {
        ack: vi.fn(),
        attempts: 1,
        body,
        id: "msg_1",
        retry: vi.fn(),
        timestamp: new Date(),
        ...messageOverrides,
    } as unknown as Message<VideoRenderMessage>;

    return message;
};

const makeBatch = (messages: Message<VideoRenderMessage>[], queueName = "llm-gateway-video-renders"): MessageBatch<VideoRenderMessage> =>
    ({
        ackAll: vi.fn(),
        messages,
        queue: queueName,
        retryAll: vi.fn(),
    }) as unknown as MessageBatch<VideoRenderMessage>;

beforeEach(() => {
    runVideoRenderMock.mockReset();
    markRenderFailedMock.mockReset();
    markRenderFailedMock.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("handleVideoRenderBatch", () => {
    it("acks a completed render", async () => {
        runVideoRenderMock.mockResolvedValue({
            costMicrodollars: 60_000,
            kind: "completed",
            latencyMs: 1234,
        });

        const message = makeMessage();

        await handleVideoRenderBatch(makeBatch([message]), baseEnv, makeContext());

        expect(runVideoRenderMock).toHaveBeenCalledTimes(1);
        expect(message.ack).toHaveBeenCalledTimes(1);
        expect(message.retry).not.toHaveBeenCalled();
        expect(markRenderFailedMock).not.toHaveBeenCalled();
    });

    it("acks a skipped (already-completed) render without re-running", async () => {
        runVideoRenderMock.mockResolvedValue({
            kind: "skipped",
            reason: "already-completed",
        });

        const message = makeMessage();

        await handleVideoRenderBatch(makeBatch([message]), baseEnv, makeContext());

        expect(message.ack).toHaveBeenCalledTimes(1);
        expect(message.retry).not.toHaveBeenCalled();
        expect(markRenderFailedMock).not.toHaveBeenCalled();
    });

    it("retries a transient failure when attempts < max", async () => {
        runVideoRenderMock.mockResolvedValue({
            errorMessage: "provider 503",
            kind: "failed",
            retryable: true,
        });

        const message = makeMessage({}, { attempts: 1 });

        await handleVideoRenderBatch(makeBatch([message]), baseEnv, makeContext());

        expect(message.retry).toHaveBeenCalledTimes(1);
        expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
        expect(message.ack).not.toHaveBeenCalled();
        expect(markRenderFailedMock).not.toHaveBeenCalled();
    });

    it("finalises a transient failure when retries are exhausted", async () => {
        runVideoRenderMock.mockResolvedValue({
            errorMessage: "provider 503",
            kind: "failed",
            retryable: true,
        });

        const message = makeMessage({}, { attempts: 3 });

        await handleVideoRenderBatch(makeBatch([message]), baseEnv, makeContext());

        expect(message.ack).toHaveBeenCalledTimes(1);
        expect(message.retry).not.toHaveBeenCalled();
        // Render core leaves transient failures as in_progress in case of
        // retry — consumer is responsible for marking failed when retries run
        // out, otherwise pollers wait on the 10-min stall reaper.
        expect(markRenderFailedMock).toHaveBeenCalledTimes(1);
        expect(markRenderFailedMock).toHaveBeenCalledWith(baseEnv, message.body, expect.stringContaining("retries exhausted"));
    });

    it("acks a terminal (non-retryable) failure without calling markRenderFailed (render core already did)", async () => {
        runVideoRenderMock.mockResolvedValue({
            errorMessage: "validation error",
            kind: "failed",
            retryable: false,
        });

        const message = makeMessage({}, { attempts: 1 });

        await handleVideoRenderBatch(makeBatch([message]), baseEnv, makeContext());

        expect(message.ack).toHaveBeenCalledTimes(1);
        expect(message.retry).not.toHaveBeenCalled();
        // The render core already wrote `failed` state before returning a
        // non-retryable outcome; calling markRenderFailed here would be
        // redundant (idempotent, but wasted RTT).
        expect(markRenderFailedMock).not.toHaveBeenCalled();
    });

    it("retries when runVideoRender itself throws (defensive)", async () => {
        runVideoRenderMock.mockRejectedValue(new Error("KV write rejected"));

        const message = makeMessage({}, { attempts: 1 });

        await handleVideoRenderBatch(makeBatch([message]), baseEnv, makeContext());

        expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
        expect(message.ack).not.toHaveBeenCalled();
    });

    it("persists failure when runVideoRender throws on the final attempt", async () => {
        runVideoRenderMock.mockRejectedValue(new Error("KV write rejected"));

        const message = makeMessage({}, { attempts: 3 });

        await handleVideoRenderBatch(makeBatch([message]), baseEnv, makeContext());

        expect(message.ack).toHaveBeenCalledTimes(1);
        // Wrapper-level failure on final attempt: render core never ran,
        // so we must persist failed state here.
        expect(markRenderFailedMock).toHaveBeenCalledTimes(1);
        expect(markRenderFailedMock).toHaveBeenCalledWith(baseEnv, message.body, expect.stringContaining("Consumer error"));
    });

    it("drops version-mismatch poison messages without running the render", async () => {
        const message = makeMessage();

        // Force an unsupported envelope version on the body.
        (message.body as unknown as { _version: number })._version = 99;

        await handleVideoRenderBatch(makeBatch([message]), baseEnv, makeContext());

        expect(runVideoRenderMock).not.toHaveBeenCalled();
        expect(markRenderFailedMock).not.toHaveBeenCalled();
        expect(message.ack).toHaveBeenCalledTimes(1);
        expect(message.retry).not.toHaveBeenCalled();
    });

    it("drops messages with a missing body (e.g. corrupted enqueue) without retrying", async () => {
        const message = makeMessage();

        (message as unknown as { body: undefined }).body = undefined;

        await handleVideoRenderBatch(makeBatch([message]), baseEnv, makeContext());

        expect(runVideoRenderMock).not.toHaveBeenCalled();
        expect(message.ack).toHaveBeenCalledTimes(1);
        expect(message.retry).not.toHaveBeenCalled();
    });

    it("acks DLQ messages without re-running the render core", async () => {
        const message = makeMessage({}, { attempts: 3 });

        await handleVideoRenderBatch(makeBatch([message], "llm-gateway-video-renders-dlq"), baseEnv, makeContext());

        expect(runVideoRenderMock).not.toHaveBeenCalled();
        expect(message.ack).toHaveBeenCalledTimes(1);
    });

    it("flushes telemetry for DLQ messages", async () => {
        const context = makeContext();
        const message = makeMessage({}, { attempts: 3 });

        await handleVideoRenderBatch(makeBatch([message], "llm-gateway-video-renders-dlq"), baseEnv, context);

        // One waitUntil call carries the DLQ telemetry flush.
        expect((context.waitUntil as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it("flushes telemetry per message via ctx.waitUntil", async () => {
        runVideoRenderMock.mockResolvedValue({
            costMicrodollars: 1,
            kind: "completed",
            latencyMs: 100,
        });

        const context = makeContext();
        const message1 = makeMessage({ jobId: "j1" });
        const message2 = makeMessage({ jobId: "j2" }, { id: "msg_2" });

        await handleVideoRenderBatch(makeBatch([message1, message2]), baseEnv, context);

        // One flush per message (telemetry is per-message).
        expect((context.waitUntil as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    });

    it("processes each message in a batch independently", async () => {
        runVideoRenderMock
            .mockResolvedValueOnce({ costMicrodollars: 1, kind: "completed", latencyMs: 10 })
            .mockResolvedValueOnce({ errorMessage: "provider 500", kind: "failed", retryable: true });

        const message1 = makeMessage({ jobId: "j1" });
        const message2 = makeMessage({ jobId: "j2" }, { attempts: 1, id: "msg_2" });

        await handleVideoRenderBatch(makeBatch([message1, message2]), baseEnv, makeContext());

        expect(message1.ack).toHaveBeenCalledTimes(1);
        expect(message2.retry).toHaveBeenCalledTimes(1);
        expect(message2.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    });
});
