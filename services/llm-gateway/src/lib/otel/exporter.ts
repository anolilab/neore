/**
 * OTLP/HTTP JSON exporter — marshals spans and metrics into the wire format
 * and POSTs them to an OTLP collector endpoint (Honeycomb, OTel collector,
 * SigNoz, Grafana Tempo, etc).
 *
 * Design: stateless per-request flush. Each Worker invocation builds a fresh
 * payload from its accumulated spans/metrics and sends it via fetch wrapped
 * in `executionCtx.waitUntil()` so the response is never blocked.
 *
 * Endpoints (per OTLP spec):
 *   POST {OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces
 *   POST {OTEL_EXPORTER_OTLP_ENDPOINT}/v1/metrics
 */
import type { Attributes, CounterPoint, HistogramObservation, Span, TelemetryFlushPayload } from "./types.js";

export interface OtelConfig {
    /** Deployment environment — production / preview / development. */
    deploymentEnvironment: string;
    /** Base URL of the OTLP/HTTP collector (without `/v1/traces` suffix). */
    endpoint: string;
    /** Comma-separated `key=value` header pairs (e.g. auth tokens). */
    headers: Record<string, string>;
    /** Logical service identifier used in resource attributes. */
    serviceName: string;
    /** Service version — surfaces as resource attribute. */
    serviceVersion: string;
}

/**
 * Parse OTel config from env vars. Returns null when no endpoint configured —
 * caller treats that as "telemetry disabled".
 */
export const parseOtelConfig = (env: {
    APP_NAME: string;
    APP_VERSION: string;
    NODE_ENV: string;
    OTEL_EXPORTER_OTLP_ENDPOINT?: string;
    OTEL_EXPORTER_OTLP_HEADERS?: string;
    OTEL_SERVICE_NAME?: string;
}): OtelConfig | null => {
    const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();

    if (!endpoint) return null;

    let normalisedEndpoint: string;

    try {
        const parsed = new URL(endpoint);

        // Restrict to HTTP(S) — `file:`, `data:`, `ws:` are not valid OTLP/HTTP
        // collector endpoints and could exfiltrate data to unexpected sinks.
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

        // Index-based trailing-slash strip: a regex here is quadratic on
        // pathological all-slash inputs.
        const { href } = parsed;
        let end = href.length;

        while (end > 0 && href.charAt(end - 1) === "/") {
            end -= 1;
        }

        normalisedEndpoint = href.slice(0, end);
    } catch {
        return null;
    }

    return {
        deploymentEnvironment: env.NODE_ENV || "development",
        endpoint: normalisedEndpoint,
        headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
        serviceName: env.OTEL_SERVICE_NAME?.trim() || env.APP_NAME || "llm-gateway",
        serviceVersion: env.APP_VERSION || "0.0.0",
    };
};

/** CR/LF guard for OTLP header values — no `g` flag, so `.test()` is stateless. */
const CRLF_RE = /[\r\n]/;

const parseHeaders = (raw: string | undefined): Record<string, string> => {
    if (!raw) return {};

    const headers: Record<string, string> = {};

    for (const pair of raw.split(",")) {
        const eq = pair.indexOf("=");

        if (eq < 1) continue;

        const key = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();

        // Reject CR/LF in header values to prevent header-splitting attacks
        // (defence-in-depth: the source is env-only, but a hostile env still
        // shouldn't be able to splice arbitrary headers into our OTLP request).
        if (!key || CRLF_RE.test(value)) continue;

        headers[key] = value;
    }

    return headers;
};

/** Per-export timeout. Caps how long a slow collector can hold the worker's `waitUntil` budget. */
const EXPORT_TIMEOUT_MS = 5000;

// ── Wire-format marshalling ─────────────────────────────────────────────────

/**
 * OTLP attribute values are tagged unions — we restrict to the common types
 * we actually emit so the wire-format builder stays small.
 */
type OtlpAnyValue = { boolValue: boolean } | { doubleValue: number } | { intValue: string } | { stringValue: string };

const toAnyValue = (value: unknown): OtlpAnyValue | null => {
    if (value === null || value === undefined) return null;

    if (typeof value === "string") return { stringValue: value };

    if (typeof value === "boolean") return { boolValue: value };

    if (typeof value === "number") {
        if (Number.isSafeInteger(value)) {
            return { intValue: String(value) };
        }

        return { doubleValue: value };
    }

    return { stringValue: String(value) };
};

const toAttributes = (attributes: Attributes | undefined): { key: string; value: OtlpAnyValue }[] => {
    if (!attributes) return [];

    const out: { key: string; value: OtlpAnyValue }[] = [];

    for (const [key, value] of Object.entries(attributes)) {
        const av = toAnyValue(value);

        if (av) out.push({ key, value: av });
    }

    return out;
};

const buildResource = (config: OtelConfig) => {
    return {
        attributes: toAttributes({
            "deployment.environment": config.deploymentEnvironment,
            "service.name": config.serviceName,
            "service.version": config.serviceVersion,
            "telemetry.sdk.language": "javascript",
            "telemetry.sdk.name": "llm-gateway-custom",
        }),
    };
};

const buildScope = (config: OtelConfig) => {
    return {
        name: "llm-gateway",
        version: config.serviceVersion,
    };
};

const buildTracePayload = (spans: Span[], config: OtelConfig) => {
    return {
        resourceSpans: [
            {
                resource: buildResource(config),
                scopeSpans: [
                    {
                        scope: buildScope(config),
                        spans: spans.map((span) => {
                            return {
                                spanId: span.spanId,
                                traceId: span.traceId,
                                ...(span.parentSpanId && { parentSpanId: span.parentSpanId }),
                                attributes: toAttributes(span.attributes),
                                endTimeUnixNano: (span.endTimeNs ?? span.startTimeNs).toString(),
                                events: span.events.map((event) => {
                                    return {
                                        attributes: toAttributes(event.attributes),
                                        name: event.name,
                                        timeUnixNano: event.timeNs.toString(),
                                    };
                                }),
                                kind: span.kind,
                                name: span.name,
                                startTimeUnixNano: span.startTimeNs.toString(),
                                status: {
                                    code: span.status.code,
                                    ...(span.status.message && { message: span.status.message }),
                                },
                            };
                        }),
                    },
                ],
            },
        ],
    };
};

/**
 * Build a stable hash of attribute key/value pairs for client-side
 * aggregation. Sorting keys keeps `{a:1, b:2}` and `{b:2, a:1}` in the same
 * bucket. `JSON.stringify` is sufficient because attribute values are
 * limited to JSON-serialisable primitives.
 */
const compareStrings = (a: string, b: string): number => {
    if (a === b) return 0;

    return a < b ? -1 : 1;
};

const attributeKey = (attributes: Attributes): string => {
    const keys = Object.keys(attributes).toSorted(compareStrings);

    return JSON.stringify(keys.map((k) => [k, attributes[k]]));
};

interface AggregatedCounter {
    attributes: Attributes;
    unit?: string;
    value: number;
}

interface AggregatedHistogram {
    attributes: Attributes;
    count: number;
    max: number;
    min: number;
    sum: number;
    unit?: string;
}

const buildMetricsPayload = (counters: CounterPoint[], histograms: HistogramObservation[], config: OtelConfig, nowNs: bigint) => {
    const startTimeNs = nowNs.toString();
    const timeUnixNano = nowNs.toString();

    // Pre-aggregate counters by (name, label-set). Multiple `recordCounter`
    // calls with identical labels collapse into a single datapoint, halving
    // wire bytes for hot paths that increment the same counter repeatedly.
    const counterGroups = new Map<string, Map<string, AggregatedCounter>>();

    for (const c of counters) {
        let nameGroup = counterGroups.get(c.name);

        if (!nameGroup) {
            nameGroup = new Map();
            counterGroups.set(c.name, nameGroup);
        }

        const key = attributeKey(c.attributes);
        const existing = nameGroup.get(key);

        if (existing) {
            existing.value += c.value;
        } else {
            nameGroup.set(key, { attributes: c.attributes, unit: c.unit, value: c.value });
        }
    }

    // Same aggregation for histograms — fold observations sharing a label set
    // into a single datapoint with min/max/sum/count.
    const histGroups = new Map<string, Map<string, AggregatedHistogram>>();

    for (const h of histograms) {
        let nameGroup = histGroups.get(h.name);

        if (!nameGroup) {
            nameGroup = new Map();
            histGroups.set(h.name, nameGroup);
        }

        const key = attributeKey(h.attributes);
        const existing = nameGroup.get(key);

        if (existing) {
            existing.count += 1;
            existing.sum += h.value;

            if (h.value < existing.min) existing.min = h.value;

            if (h.value > existing.max) existing.max = h.value;
        } else {
            nameGroup.set(key, { attributes: h.attributes, count: 1, max: h.value, min: h.value, sum: h.value, unit: h.unit });
        }
    }

    const counterMetrics = [...counterGroups].map(([name, group]) => {
        const points = group.values().toArray();

        return {
            name,
            sum: {
                // Delta temporality — each export sends just the increments
                // since the last (per-request) flush, no client-side state.
                aggregationTemporality: 1,
                dataPoints: points.map((p) => {
                    return {
                        attributes: toAttributes(p.attributes),
                        startTimeUnixNano: startTimeNs,
                        timeUnixNano,
                        ...(Number.isSafeInteger(p.value) ? { asInt: String(p.value) } : { asDouble: p.value }),
                    };
                }),
                isMonotonic: true,
            },
            unit: points[0]!.unit ?? "1",
        };
    });

    const histogramMetrics = [...histGroups].map(([name, group]) => {
        const observations = group.values().toArray();

        return {
            histogram: {
                aggregationTemporality: 1,
                dataPoints: observations.map((obs) => {
                    return {
                        attributes: toAttributes(obs.attributes),
                        // OTLP requires bucketCounts.length === explicitBounds.length + 1.
                        // Empty bounds + single bucket = "all observations in one bucket"
                        // — the canonical no-client-bucketing representation. Backends
                        // (Honeycomb, SigNoz, Tempo) infer quantiles from min/max/sum/count.
                        bucketCounts: [String(obs.count)],
                        count: String(obs.count),
                        explicitBounds: [],
                        max: obs.max,
                        min: obs.min,
                        startTimeUnixNano: startTimeNs,
                        sum: obs.sum,
                        timeUnixNano,
                    };
                }),
            },
            name,
            unit: observations[0]!.unit ?? "ms",
        };
    });

    return {
        resourceMetrics: [
            {
                resource: buildResource(config),
                scopeMetrics: [
                    {
                        metrics: [...counterMetrics, ...histogramMetrics],
                        scope: buildScope(config),
                    },
                ],
            },
        ],
    };
};

/**
 * POST traces + metrics to the OTLP collector. Returns immediately on failure
 * (telemetry must never break production). All errors are logged to the
 * console for debugging.
 */
export const exportTelemetry = async (payload: TelemetryFlushPayload, config: OtelConfig, nowNs: bigint): Promise<void> => {
    const requests: Promise<unknown>[] = [];

    if (payload.spans.length > 0) {
        const body = JSON.stringify(buildTracePayload(payload.spans, config));

        requests.push(
            fetch(`${config.endpoint}/v1/traces`, {
                body,
                headers: { "Content-Type": "application/json", ...config.headers },
                method: "POST",
                signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
            })
                .then(async (response) => {
                    await response.body?.cancel();

                    if (!response.ok) {
                        console.warn(`[OTel] Trace export failed: ${response.status} ${response.statusText}`);
                    }

                    return undefined;
                })
                .catch((error: unknown) => {
                    console.warn(`[OTel] Trace export error: ${error instanceof Error ? error.message : String(error)}`);
                }),
        );
    }

    if (payload.counters.length > 0 || payload.histograms.length > 0) {
        const body = JSON.stringify(buildMetricsPayload(payload.counters, payload.histograms, config, nowNs));

        requests.push(
            fetch(`${config.endpoint}/v1/metrics`, {
                body,
                headers: { "Content-Type": "application/json", ...config.headers },
                method: "POST",
                signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
            })
                .then(async (response) => {
                    await response.body?.cancel();

                    if (!response.ok) {
                        console.warn(`[OTel] Metrics export failed: ${response.status} ${response.statusText}`);
                    }

                    return undefined;
                })
                .catch((error: unknown) => {
                    console.warn(`[OTel] Metrics export error: ${error instanceof Error ? error.message : String(error)}`);
                }),
        );
    }

    await Promise.allSettled(requests);
};
