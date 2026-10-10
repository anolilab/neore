/**
 * Telemetry middleware — wraps every request in a root server span and
 * exposes the per-request `RequestTelemetry` collector via Hono context
 * (`c.var.telemetry`).
 *
 * Spans/metrics accumulated during the request are flushed in the response
 * tail via `executionCtx.waitUntil()` so the client never blocks on the
 * exporter. The exporter itself swallows errors — telemetry must never
 * affect production traffic.
 *
 * W3C trace context: if the incoming request carries a `traceparent` header
 * we adopt the trace ID so spans from upstream callers (backend, web app) get
 * linked into the same trace.
 */
import { createMiddleware } from "hono/factory";

import type { HonoEnv } from "../env.js";
import { parseOtelConfig, parseTraceparent, RequestTelemetry, SpanKind } from "../lib/otel/index.js";

export const telemetryMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
    const config = parseOtelConfig(c.env);
    const incoming = parseTraceparent(c.req.header("traceparent"));
    const telemetry = new RequestTelemetry(config, incoming?.traceId);

    const url = new URL(c.req.url);

    const rootSpan = telemetry.startSpan(`${c.req.method} ${url.pathname}`, {
        attributes: {
            "http.host": url.host,
            "http.method": c.req.method,
            "http.scheme": url.protocol.replace(":", ""),
            "http.target": url.pathname,
            "http.url": url.href,
            "http.user_agent": c.req.header("user-agent"),
        },
        kind: SpanKind.SERVER,
    });

    if (incoming) {
        rootSpan.parentSpanId = incoming.parentSpanId;
    }

    c.set("telemetry", telemetry);
    c.set("rootSpan", rootSpan);

    let error: unknown;

    try {
        await next();
    } catch (error_) {
        error = error_;

        throw error_;
    } finally {
        const status = c.res?.status ?? 500;
        // Hono's matched route pattern (e.g. `/v1/chat/:id`), NOT the raw
        // pathname. Using the raw URL would let any unmatched 404 add a new
        // label combination to `gateway.requests_total`, blowing up metric
        // cardinality on the backend. `routePath` defaults to `/` when no
        // route matched, which is harmless.
        const route = c.req.routePath || "/";

        telemetry.endSpan(rootSpan, {
            attributes: { "http.route": route, "http.status_code": status },
            error: error ?? (status >= 500 ? new Error(`HTTP ${status}`) : undefined),
        });

        telemetry.recordCounter("gateway.requests_total", 1, { "http.method": c.req.method, "http.route": route, "http.status_code": status }, "1");

        if (rootSpan.endTimeNs && rootSpan.startTimeNs) {
            const latencyMs = Number((rootSpan.endTimeNs - rootSpan.startTimeNs) / 1_000_000n);

            telemetry.recordHistogram(
                "gateway.request_latency",
                latencyMs,
                { "http.method": c.req.method, "http.route": route, "http.status_code": status },
                "ms",
            );
        }

        // Flush in the response tail — does not block the client.
        c.executionCtx.waitUntil(telemetry.flush());
    }
});
