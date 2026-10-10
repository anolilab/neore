/**
 * Telemetry wrapper for Cloudflare Queue consumer invocations.
 *
 * The HTTP `telemetryMiddleware` flushes inside the request lifecycle, so it
 * cannot be reused for the queue handler — a queue invocation has no Hono
 * context and runs after the producing request has returned. This helper
 * mirrors that middleware's shape: build a `RequestTelemetry`, start a
 * CONSUMER-kind root span, adopt the producer's `traceparent` so the span
 * links into the same trace, and flush via `ctx.waitUntil()`.
 *
 * Callers wrap their per-message work in {@link createQueueMessageTelemetry}.
 */
import type { AppEnv } from "../../env.js";
import { parseOtelConfig } from "./exporter.js";
import { parseTraceparent } from "./traceparent.js";
import { RequestTelemetry } from "./tracer.js";
import type { Attributes } from "./types.js";
import { SpanKind } from "./types.js";

/** Result of {@link createQueueMessageTelemetry}: a per-message collector + its root span. */
export interface QueueMessageTelemetry {
    rootSpan: ReturnType<RequestTelemetry["startSpan"]>;
    telemetry: RequestTelemetry;
}

/**
 * Build a fresh telemetry collector + root span for a single queue message.
 * @param env Worker bindings (carries OTEL_* config).
 * @param messageMeta Message identity + queue name for span attributes.
 * @param messageMeta.attempts Delivery attempt number for this message.
 * @param messageMeta.messageId Queue-assigned message id.
 * @param messageMeta.queueName Name of the queue the message came from.
 * @param spanName Operation name (e.g. `"video.render"`).
 * @param attributes Extra span attributes layered on top of the queue defaults.
 * @param parentTraceparent W3C traceparent forwarded by the producer.
 */
export const createQueueMessageTelemetry = (
    env: AppEnv,
    messageMeta: { attempts: number; messageId: string; queueName: string },
    spanName: string,
    attributes: Attributes,
    parentTraceparent: string | undefined,
): QueueMessageTelemetry => {
    const config = parseOtelConfig(env);
    const incoming = parseTraceparent(parentTraceparent);
    const telemetry = new RequestTelemetry(config, incoming?.traceId);

    const rootSpan = telemetry.startSpan(spanName, {
        attributes: {
            "messaging.destination.name": messageMeta.queueName,
            "messaging.message.delivery.attempts": messageMeta.attempts,
            "messaging.message.id": messageMeta.messageId,
            "messaging.operation": "process",
            "messaging.system": "cloudflare-queues",
            ...attributes,
        },
        kind: SpanKind.CONSUMER,
    });

    if (incoming) {
        rootSpan.parentSpanId = incoming.parentSpanId;
    }

    return { rootSpan, telemetry };
};
