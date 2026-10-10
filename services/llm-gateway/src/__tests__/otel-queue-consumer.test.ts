/**
 * Direct unit tests for the queue-consumer telemetry helper and the
 * traceparent parser. These two helpers are exercised indirectly by the
 * video-render-consumer test, but their edge cases (malformed headers, fresh
 * trace IDs, attribute layering) deserve focused coverage.
 */
import { describe, expect, it } from "vitest";

import type { AppEnv } from "../env.js";
import { createQueueMessageTelemetry } from "../lib/otel/queue-consumer.js";
import { parseTraceparent } from "../lib/otel/traceparent.js";
import { SpanKind } from "../lib/otel/types.js";

const TRACE_ID_RE = /^[a-f0-9]{32}$/;

// ─── parseTraceparent ────────────────────────────────────────────────────────

describe("parseTraceparent", () => {
    it("parses a valid W3C traceparent header", () => {
        const result = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");

        expect(result).toEqual({
            parentSpanId: "00f067aa0ba902b7",
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        });
    });

    it("normalises uppercase hex to lowercase", () => {
        const result = parseTraceparent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01");

        expect(result).toEqual({
            parentSpanId: "00f067aa0ba902b7",
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        });
    });

    it("returns null for undefined input", () => {
        expect(parseTraceparent(undefined)).toBeNull();
    });

    it("returns null for null input", () => {
        expect(parseTraceparent(null)).toBeNull();
    });

    it("returns null for empty string", () => {
        expect(parseTraceparent("")).toBeNull();
    });

    it("returns null for a wholly malformed value", () => {
        expect(parseTraceparent("not-a-traceparent")).toBeNull();
    });

    it("returns null when the version segment is not '00'", () => {
        // Future versions are not yet supported — be conservative and reject.
        expect(parseTraceparent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull();
    });

    it("returns null when the trace ID is the wrong length", () => {
        expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e47-00f067aa0ba902b7-01")).toBeNull();
    });

    it("returns null when the parent span ID is the wrong length", () => {
        expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902-01")).toBeNull();
    });

    it("returns null when the trace ID contains non-hex chars", () => {
        expect(parseTraceparent("00-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-00f067aa0ba902b7-01")).toBeNull();
    });

    it("returns null when the parent span ID contains non-hex chars", () => {
        expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-zzzzzzzzzzzzzzzz-01")).toBeNull();
    });

    it("returns null when there are not exactly 4 segments", () => {
        expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736")).toBeNull();
        expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra")).toBeNull();
    });
});

// ─── createQueueMessageTelemetry ─────────────────────────────────────────────

const baseEnv = {
    APP_NAME: "llm-gateway",
    APP_VERSION: "1.0.0",
    NODE_ENV: "test",
} as unknown as AppEnv;

const SAMPLE_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("createQueueMessageTelemetry", () => {
    it("adopts the trace ID + parentSpanId from a valid traceparent", () => {
        const { rootSpan, telemetry } = createQueueMessageTelemetry(
            baseEnv,
            { attempts: 1, messageId: "msg_1", queueName: "test-queue" },
            "video.render",
            {},
            SAMPLE_TRACEPARENT,
        );

        expect(telemetry.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
        expect(rootSpan.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
        expect(rootSpan.parentSpanId).toBe("00f067aa0ba902b7");
    });

    it("generates a fresh trace ID when traceparent is undefined", () => {
        const { rootSpan, telemetry } = createQueueMessageTelemetry(baseEnv, { attempts: 1, messageId: "m", queueName: "q" }, "video.render", {}, undefined);

        expect(telemetry.traceId).toMatch(TRACE_ID_RE);
        expect(rootSpan.parentSpanId).toBeUndefined();
    });

    it("generates a fresh trace ID when traceparent is malformed", () => {
        const { rootSpan, telemetry } = createQueueMessageTelemetry(baseEnv, { attempts: 1, messageId: "m", queueName: "q" }, "video.render", {}, "garbage");

        expect(telemetry.traceId).toMatch(TRACE_ID_RE);
        expect(rootSpan.parentSpanId).toBeUndefined();
    });

    it("sets the messaging.* queue attributes", () => {
        const { rootSpan } = createQueueMessageTelemetry(
            baseEnv,
            { attempts: 2, messageId: "msg_42", queueName: "llm-gateway-video-renders" },
            "video.render",
            {},
            undefined,
        );

        expect(rootSpan.attributes).toMatchObject({
            "messaging.destination.name": "llm-gateway-video-renders",
            "messaging.message.delivery.attempts": 2,
            "messaging.message.id": "msg_42",
            "messaging.operation": "process",
            "messaging.system": "cloudflare-queues",
        });
    });

    it("layers caller attributes on top of the messaging.* defaults", () => {
        const { rootSpan } = createQueueMessageTelemetry(
            baseEnv,
            { attempts: 1, messageId: "m", queueName: "q" },
            "video.render",
            { "video.job_id": "job_xyz", "video.provider": "fal" },
            undefined,
        );

        expect(rootSpan.attributes).toMatchObject({
            "messaging.system": "cloudflare-queues",
            "video.job_id": "job_xyz",
            "video.provider": "fal",
        });
    });

    it("uses SpanKind.CONSUMER for the root span", () => {
        const { rootSpan } = createQueueMessageTelemetry(baseEnv, { attempts: 1, messageId: "m", queueName: "q" }, "video.render", {}, undefined);

        expect(rootSpan.kind).toBe(SpanKind.CONSUMER);
    });

    it("uses the span name passed by the caller", () => {
        const { rootSpan } = createQueueMessageTelemetry(baseEnv, { attempts: 1, messageId: "m", queueName: "q" }, "video.render.dlq", {}, undefined);

        expect(rootSpan.name).toBe("video.render.dlq");
    });
});
