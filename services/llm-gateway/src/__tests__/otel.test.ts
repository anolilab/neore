import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HonoEnv } from "../env.js";
import { parseOtelConfig } from "../lib/otel/exporter.js";
import { RequestTelemetry, withSpan } from "../lib/otel/tracer.js";
import { SpanKind, StatusCode } from "../lib/otel/types.js";
import { telemetryMiddleware } from "../middleware/telemetry.js";

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;

const baseEnv = {
    APP_NAME: "llm-gateway",
    APP_VERSION: "1.0.0",
    NODE_ENV: "test",
};

describe("otel/exporter", () => {
    describe("parseOtelConfig", () => {
        it("returns null when endpoint is unset", () => {
            expect(parseOtelConfig(baseEnv)).toBeNull();
        });

        it("returns null for malformed endpoints", () => {
            expect(parseOtelConfig({ ...baseEnv, OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" })).toBeNull();
        });

        it("strips trailing slashes from endpoint", () => {
            const config = parseOtelConfig({ ...baseEnv, OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com//" });

            expect(config?.endpoint).toBe("https://otel.example.com");
        });

        it("parses comma-separated headers", () => {
            const config = parseOtelConfig({
                ...baseEnv,
                OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com",
                OTEL_EXPORTER_OTLP_HEADERS: "x-honeycomb-team=secret,x-dataset=prod",
            });

            expect(config?.headers).toEqual({ "x-dataset": "prod", "x-honeycomb-team": "secret" });
        });

        it("ignores headers without '='", () => {
            const config = parseOtelConfig({
                ...baseEnv,
                OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com",
                OTEL_EXPORTER_OTLP_HEADERS: "no-equals-sign,x-good=value",
            });

            expect(config?.headers).toEqual({ "x-good": "value" });
        });

        it("falls back service.name to APP_NAME when OTEL_SERVICE_NAME unset", () => {
            const config = parseOtelConfig({ ...baseEnv, OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com" });

            expect(config?.serviceName).toBe("llm-gateway");
        });
    });
});

describe("otel/tracer", () => {
    describe("RequestTelemetry disabled", () => {
        it("no-ops when config is null", () => {
            const telemetry = new RequestTelemetry(null);

            expect(telemetry.enabled).toBe(false);

            const span = telemetry.startSpan("test");

            telemetry.endSpan(span);
            telemetry.recordCounter("requests", 1);
            telemetry.recordHistogram("latency", 50);

            // Flush should be a no-op and resolve immediately
            return telemetry.flush();
        });
    });

    describe("RequestTelemetry enabled", () => {
        const config = {
            deploymentEnvironment: "test",
            endpoint: "https://otel.example.com",
            headers: {},
            serviceName: "test-service",
            serviceVersion: "0.0.1",
        };

        let fetchSpy: ReturnType<typeof vi.spyOn>;

        beforeEach(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 })) as any;
        });

        afterEach(() => {
            fetchSpy.mockRestore();
        });

        it("generates a 32-hex-char trace ID and 16-hex-char span IDs", () => {
            const telemetry = new RequestTelemetry(config);

            expect(telemetry.traceId).toMatch(TRACE_ID_RE);

            const span = telemetry.startSpan("test");

            expect(span.spanId).toMatch(SPAN_ID_RE);
            expect(span.traceId).toBe(telemetry.traceId);
        });

        it("adopts an externally-provided trace ID for W3C propagation", () => {
            const traceId = "abcdef0123456789abcdef0123456789";
            const telemetry = new RequestTelemetry(config, traceId);

            expect(telemetry.traceId).toBe(traceId);
        });

        it("links child spans to parents via parentSpanId", () => {
            const telemetry = new RequestTelemetry(config);
            const parent = telemetry.startSpan("parent");
            const child = telemetry.startSpan("child", { parent });

            expect(child.parentSpanId).toBe(parent.spanId);
        });

        it("marks spans with OK status by default", () => {
            const telemetry = new RequestTelemetry(config);
            const span = telemetry.startSpan("test");

            telemetry.endSpan(span);

            expect(span.status.code).toBe(StatusCode.OK);
        });

        it("marks spans with ERROR status when error is provided", () => {
            const telemetry = new RequestTelemetry(config);
            const span = telemetry.startSpan("test");

            telemetry.endSpan(span, { error: new Error("boom") });

            expect(span.status.code).toBe(StatusCode.ERROR);
            expect(span.status.message).toBe("boom");
            expect(span.attributes["error"]).toBe(true);
            expect(span.attributes["error.type"]).toBe("Error");
        });

        it("merges additional attributes on endSpan", () => {
            const telemetry = new RequestTelemetry(config);
            const span = telemetry.startSpan("test", { attributes: { a: 1 } });

            telemetry.endSpan(span, { attributes: { b: 2 } });

            expect(span.attributes).toMatchObject({ a: 1, b: 2 });
        });

        it("posts to /v1/traces and /v1/metrics on flush", async () => {
            const telemetry = new RequestTelemetry(config);
            const span = telemetry.startSpan("test", { kind: SpanKind.SERVER });

            telemetry.endSpan(span);
            telemetry.recordCounter("requests", 1, { tier: "simple" });
            telemetry.recordHistogram("latency", 42, { tier: "simple" });

            await telemetry.flush();

            const calls = fetchSpy.mock.calls as [unknown, ...unknown[]][];
            const urls = calls.map((c) => String(c[0]));

            expect(urls).toContain("https://otel.example.com/v1/traces");
            expect(urls).toContain("https://otel.example.com/v1/metrics");
        });

        it("skips export when nothing has been recorded", async () => {
            const telemetry = new RequestTelemetry(config);

            await telemetry.flush();

            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it("withSpan finalizes span on success and returns the result", async () => {
            const telemetry = new RequestTelemetry(config);

            const result = await withSpan(telemetry, "test", {}, () => "value");

            expect(result).toBe("value");
        });

        it("withSpan marks span as error and re-throws on failure", async () => {
            const telemetry = new RequestTelemetry(config);
            let capturedSpan: { status: { code: number } } | null = null;

            await expect(
                withSpan(telemetry, "test", {}, (span) => {
                    capturedSpan = span as unknown as { status: { code: number } };

                    throw new Error("kaboom");
                }),
            ).rejects.toThrow("kaboom");

            expect(capturedSpan).not.toBeNull();
            expect(capturedSpan!.status.code).toBe(StatusCode.ERROR);
        });

        it("includes service.name in resource attributes", async () => {
            const telemetry = new RequestTelemetry(config);
            const span = telemetry.startSpan("test");

            telemetry.endSpan(span);

            await telemetry.flush();

            const tracesCall = (fetchSpy.mock.calls as [unknown, RequestInit][]).find((c) => String(c[0]).endsWith("/v1/traces"));
            const body = JSON.parse(tracesCall![1]!.body as string) as {
                resourceSpans: { resource: { attributes: { key: string; value: { stringValue?: string } }[] } }[];
            };

            const serviceName = body.resourceSpans[0]!.resource.attributes.find((a) => a.key === "service.name");

            expect(serviceName?.value.stringValue).toBe("test-service");
        });

        it("aggregates histograms by label-set into canonical OTLP form", async () => {
            const telemetry = new RequestTelemetry(config);

            telemetry.recordHistogram("latency", 10, { tier: "simple" });
            telemetry.recordHistogram("latency", 30, { tier: "simple" });
            telemetry.recordHistogram("latency", 100, { tier: "complex" });

            await telemetry.flush();

            const metricsCall = (fetchSpy.mock.calls as [unknown, RequestInit][]).find((c) => String(c[0]).endsWith("/v1/metrics"));
            const body = JSON.parse(metricsCall![1]!.body as string) as {
                resourceMetrics: {
                    scopeMetrics: {
                        metrics: {
                            histogram?: {
                                dataPoints: { bucketCounts: string[]; count: string; explicitBounds: number[]; max: number; min: number; sum: number }[];
                            };
                            name: string;
                        }[];
                    }[];
                }[];
            };

            const latency = body.resourceMetrics[0]!.scopeMetrics[0]!.metrics.find((m) => m.name === "latency");

            expect(latency?.histogram?.dataPoints).toHaveLength(2);

            // Each datapoint must use the canonical no-bucketing shape.
            for (const dp of latency!.histogram!.dataPoints) {
                expect(dp.explicitBounds).toEqual([]);
                expect(dp.bucketCounts).toHaveLength(1);
                expect(dp.bucketCounts[0]).toBe(dp.count);
            }

            const simple = latency!.histogram!.dataPoints.find((dp) => dp.bucketCounts[0] === "2");

            expect(simple).toBeDefined();
            expect(simple?.sum).toBe(40);
            expect(simple?.min).toBe(10);
            expect(simple?.max).toBe(30);
        });

        it("aggregates counters by label-set", async () => {
            const telemetry = new RequestTelemetry(config);

            telemetry.recordCounter("hits", 1, { route: "/a" });
            telemetry.recordCounter("hits", 4, { route: "/a" });
            telemetry.recordCounter("hits", 2, { route: "/b" });

            await telemetry.flush();

            const metricsCall = (fetchSpy.mock.calls as [unknown, RequestInit][]).find((c) => String(c[0]).endsWith("/v1/metrics"));
            const body = JSON.parse(metricsCall![1]!.body as string) as {
                resourceMetrics: {
                    scopeMetrics: {
                        metrics: {
                            name: string;
                            sum?: { dataPoints: { asInt?: string; attributes: { key: string; value: { stringValue?: string } }[] }[] };
                        }[];
                    }[];
                }[];
            };

            const hits = body.resourceMetrics[0]!.scopeMetrics[0]!.metrics.find((m) => m.name === "hits");

            expect(hits?.sum?.dataPoints).toHaveLength(2);

            const aPoint = hits!.sum!.dataPoints.find((p) => p.attributes.find((a) => a.key === "route")?.value.stringValue === "/a");

            expect(aPoint?.asInt).toBe("5");
        });
    });
});

describe("middleware/telemetry", () => {
    const baseEnvVariables = {
        APP_NAME: "test",
        APP_VERSION: "1.0.0",
        NODE_ENV: "test",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com",
    };

    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 })) as any;
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    const buildApp = (handler: (c: unknown) => unknown) => {
        const app = new Hono<HonoEnv>();

        app.use("*", telemetryMiddleware);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        app.get("/test", (c: any) => handler(c) as any);

        return app;
    };

    const dispatch = async (app: Hono<HonoEnv>, init: RequestInit & { traceparent?: string } = {}): Promise<Response> => {
        const headers = new Headers(init.headers);

        if (init.traceparent) headers.set("traceparent", init.traceparent);

        return await app.fetch(
            new Request("https://gateway.test/test", { ...init, headers }),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            baseEnvVariables as any,
            {
                passThroughOnException: () => {},
                waitUntil: (_p: Promise<unknown>) => {},
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
        );
    };

    const findSpan = (body: string): { parentSpanId?: string; traceId: string } => {
        const parsed = JSON.parse(body) as {
            resourceSpans: { scopeSpans: { spans: { parentSpanId?: string; traceId: string }[] }[] }[];
        };

        return parsed.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    };

    it("adopts trace ID from a valid W3C traceparent header", async () => {
        const app = buildApp((c) => (c as { text: (s: string) => Response }).text("ok"));

        await dispatch(app, { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" });

        const traceCall = (fetchSpy.mock.calls as [unknown, RequestInit][]).find((c) => String(c[0]).endsWith("/v1/traces"));
        const span = findSpan(traceCall![1]!.body as string);

        expect(span.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
        expect(span.parentSpanId).toBe("00f067aa0ba902b7");
    });

    it("ignores malformed traceparent and generates a fresh trace ID", async () => {
        const app = buildApp((c) => (c as { text: (s: string) => Response }).text("ok"));

        await dispatch(app, { traceparent: "this-is-garbage" });

        const traceCall = (fetchSpy.mock.calls as [unknown, RequestInit][]).find((c) => String(c[0]).endsWith("/v1/traces"));
        const span = findSpan(traceCall![1]!.body as string);

        expect(span.traceId).toMatch(TRACE_ID_RE);
        expect(span.parentSpanId).toBeUndefined();
    });

    it("ignores traceparent with wrong segment lengths", async () => {
        const app = buildApp((c) => (c as { text: (s: string) => Response }).text("ok"));

        // traceId only 30 hex chars
        await dispatch(app, { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e47-00f067aa0ba902b7-01" });

        const traceCall = (fetchSpy.mock.calls as [unknown, RequestInit][]).find((c) => String(c[0]).endsWith("/v1/traces"));
        const span = findSpan(traceCall![1]!.body as string);

        expect(span.traceId).not.toBe("4bf92f3577b34da6a3ce929d0e0e47");
        expect(span.traceId).toMatch(TRACE_ID_RE);
        expect(span.parentSpanId).toBeUndefined();
    });

    it("records request metrics + 500 status when the handler throws", async () => {
        const app = buildApp(() => {
            throw new Error("boom");
        });

        // Hono surfaces unhandled errors as 500 by default; the middleware's
        // finally block must still record metrics and flush.
        await dispatch(app);

        const metricsCall = (fetchSpy.mock.calls as [unknown, RequestInit][]).find((c) => String(c[0]).endsWith("/v1/metrics"));

        expect(metricsCall).toBeDefined();

        const body = JSON.parse(metricsCall![1]!.body as string) as {
            resourceMetrics: {
                scopeMetrics: {
                    metrics: {
                        name: string;
                        sum?: { dataPoints: { attributes: { key: string; value: { intValue?: string; stringValue?: string } }[] }[] };
                    }[];
                }[];
            }[];
        };

        const requests = body.resourceMetrics[0]!.scopeMetrics[0]!.metrics.find((m) => m.name === "gateway.requests_total");

        expect(requests?.sum?.dataPoints).toHaveLength(1);

        const statusAttribute = requests!.sum!.dataPoints[0]!.attributes.find((a) => a.key === "http.status_code");

        // Status comes through as intValue (500 is integer-clean).
        expect(statusAttribute?.value.intValue).toBe("500");

        const traceCall = (fetchSpy.mock.calls as [unknown, RequestInit][]).find((c) => String(c[0]).endsWith("/v1/traces"));

        expect(traceCall).toBeDefined();

        const traceBody = JSON.parse(traceCall![1]!.body as string) as {
            resourceSpans: { scopeSpans: { spans: { status: { code: number } }[] }[] }[];
        };

        expect(traceBody.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.status.code).toBe(StatusCode.ERROR);
    });

    it("uses Hono routePath (not raw URL) for cardinality control", async () => {
        const app = new Hono<HonoEnv>();

        app.use("*", telemetryMiddleware);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        app.get("/users/:id", (c: any) => c.text("ok"));

        await app.fetch(
            new Request("https://gateway.test/users/123"),
            baseEnvVariables as never,
            {
                passThroughOnException: () => {},
                waitUntil: (_p: Promise<unknown>) => {},
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
        );

        const metricsCall = (fetchSpy.mock.calls as [unknown, RequestInit][]).find((c) => String(c[0]).endsWith("/v1/metrics"));
        const body = JSON.parse(metricsCall![1]!.body as string) as {
            resourceMetrics: {
                scopeMetrics: {
                    metrics: { name: string; sum?: { dataPoints: { attributes: { key: string; value: { stringValue?: string } }[] }[] } }[];
                }[];
            }[];
        };

        const requests = body.resourceMetrics[0]!.scopeMetrics[0]!.metrics.find((m) => m.name === "gateway.requests_total");
        const route = requests!.sum!.dataPoints[0]!.attributes.find((a) => a.key === "http.route")?.value.stringValue;

        expect(route).toBe("/users/:id");
    });
});
