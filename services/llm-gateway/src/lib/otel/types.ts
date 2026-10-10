/**
 * Internal OTel data types — kept minimal to avoid pulling in
 * `@opentelemetry/*` runtime dependencies (most assume Node.js APIs that
 * Cloudflare Workers don't ship).
 *
 * We serialize directly to the OTLP/HTTP JSON wire format spec:
 * https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto
 */

/** OTLP SpanKind values (matches proto enum). */
export const SpanKind = {
    CLIENT: 3,
    CONSUMER: 5,
    INTERNAL: 1,
    PRODUCER: 4,
    SERVER: 2,
} as const;

export type SpanKindValue = (typeof SpanKind)[keyof typeof SpanKind];

/** OTLP StatusCode values. */
export const StatusCode = {
    ERROR: 2,
    OK: 1,
    UNSET: 0,
} as const;

export type StatusCodeValue = (typeof StatusCode)[keyof typeof StatusCode];

/** Attribute value — only the subset we emit. */
export type AttributeValue = string | number | boolean | undefined | null;
export type Attributes = Record<string, AttributeValue>;

/** Per-request span. Held in memory until the request finishes and we flush. */
export interface Span {
    attributes: Attributes;
    endTimeNs?: bigint;
    events: SpanEvent[];
    kind: SpanKindValue;
    name: string;
    parentSpanId?: string;
    spanId: string;
    startTimeNs: bigint;
    status: { code: StatusCodeValue; message?: string };
    traceId: string;
}

export interface SpanEvent {
    attributes?: Attributes;
    name: string;
    timeNs: bigint;
}

/** Counter datapoint accumulated within the current request. */
export interface CounterPoint {
    attributes: Attributes;
    name: string;
    unit?: string;
    value: number;
}

/** Histogram datapoint — single observation per call (no client-side bucketing). */
export interface HistogramObservation {
    attributes: Attributes;
    name: string;
    unit?: string;
    value: number;
}

export interface TelemetryFlushPayload {
    counters: CounterPoint[];
    histograms: HistogramObservation[];
    spans: Span[];
}
