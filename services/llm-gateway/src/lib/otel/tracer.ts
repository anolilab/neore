/**
 * Per-request telemetry collector.
 *
 * Each Hono request gets one `RequestTelemetry` instance attached via the
 * telemetry middleware. It accumulates spans, counter increments, and
 * histogram observations, then flushes them all to the OTLP collector at the
 * end of the request (via `executionCtx.waitUntil()` so the response is
 * never blocked).
 *
 * The flush is fire-and-forget — telemetry failures must never affect
 * production traffic.
 */
import type { OtelConfig } from "./exporter.js";
import { exportTelemetry } from "./exporter.js";
import type { Attributes, CounterPoint, HistogramObservation, Span, SpanKindValue } from "./types.js";
import { SpanKind, StatusCode } from "./types.js";

const HEX_CHARS = "0123456789abcdef";

const randomHex = (bytes: number): string => {
    const buffer = new Uint8Array(bytes);

    crypto.getRandomValues(buffer);

    let out = "";

    for (const byte of buffer) {
        out += HEX_CHARS[byte >>> 4]! + HEX_CHARS[byte & 0xf]!;
    }

    return out;
};

/**
 * Unix-epoch nanosecond timestamp for OTLP span/metric times.
 *
 * `Date.now()` provides millisecond resolution; sub-ms span ordering within
 * the same millisecond is determined by insertion order in the `spans` array,
 * not by timestamp. That's acceptable for our use case — request-scoped
 * spans rarely overlap at sub-ms resolution, and OTel backends order tied
 * timestamps via parent/child relationships.
 */
const nowNs = (): bigint => BigInt(Date.now()) * 1_000_000n;

export class RequestTelemetry {
    private readonly config: OtelConfig | null;

    private readonly spans: Span[] = [];

    private readonly counters: CounterPoint[] = [];

    private readonly histograms: HistogramObservation[] = [];

    private readonly rootTraceId: string;

    /**
     * The first span this request started: the root of the trace. Kept apart from
     * `spans`, because a flush drains that buffer and the root must stay the default
     * parent for spans recorded after it.
     */
    private rootSpan: Span | undefined;

    constructor(config: OtelConfig | null, traceId?: string) {
        this.config = config;
        this.rootTraceId = traceId ?? randomHex(16);
    }

    /** 32-hex-char trace ID shared by every span in this request. */
    get traceId(): string {
        return this.rootTraceId;
    }

    /** True when telemetry is enabled (collector endpoint configured). */
    get enabled(): boolean {
        return this.config !== null;
    }

    /**
     * Start a new span. Returns a handle the caller passes to `endSpan`.
     * When the collector is unconfigured this is a no-op that still returns
     * a span handle so callers don't need to check `enabled` everywhere.
     */
    startSpan(name: string, options: { attributes?: Attributes; kind?: SpanKindValue; parent?: Span } = {}): Span {
        const span: Span = {
            attributes: { ...options.attributes },
            events: [],
            kind: options.kind ?? SpanKind.INTERNAL,
            name,
            parentSpanId: options.parent?.spanId,
            spanId: randomHex(8),
            startTimeNs: nowNs(),
            status: { code: StatusCode.UNSET },
            traceId: this.rootTraceId,
        };

        if (this.enabled) {
            this.spans.push(span);
            this.rootSpan ??= span;
        }

        return span;
    }

    /**
     * Finalize a span with optional attributes/status. Safe to call even when
     * telemetry is disabled — it just no-ops.
     */
    endSpan(span: Span, options: { attributes?: Attributes; error?: unknown } = {}): void {
        if (!this.enabled) return;

        // A span is a caller-held mutable handle: `this.spans` holds the same
        // object reference, so finalising it in place is the intended design.
        const record = span;

        record.endTimeNs = nowNs();

        if (options.attributes) {
            for (const [key, value] of Object.entries(options.attributes)) {
                record.attributes[key] = value;
            }
        }

        if (options.error !== undefined) {
            const message = options.error instanceof Error ? options.error.message : String(options.error);

            record.status = { code: StatusCode.ERROR, message: message.slice(0, 500) };
            record.attributes["error"] = true;

            if (options.error instanceof Error) {
                record.attributes["error.type"] = options.error.name;
            }
        } else if (record.status.code === StatusCode.UNSET) {
            record.status = { code: StatusCode.OK };
        }
    }

    /**
     * Records a span for work that has already finished: it ended now and took
     * `durationMs`. For call sites that only learn the outcome at the end (a
     * model call's tokens and latency), where {@link startSpan} would have to be
     * held open across the whole call. The parent defaults to the request's root
     * span (the `SERVER` span of an HTTP request, or the CONSUMER span of a queue message).
     */
    recordSpan(name: string, options: { attributes?: Attributes; durationMs: number; error?: unknown; kind?: SpanKindValue; parent?: Span }): Span {
        const span = this.startSpan(name, { attributes: options.attributes, kind: options.kind, parent: options.parent ?? this.rootSpan });

        this.endSpan(span, { error: options.error });

        if (span.endTimeNs !== undefined) {
            span.startTimeNs = span.endTimeNs - BigInt(Math.max(0, Math.round(options.durationMs))) * 1_000_000n;
        }

        return span;
    }

    /** Add an event to a span (e.g., retry attempts, fallback transitions). */
    addEvent(span: Span, name: string, attributes?: Attributes): void {
        if (!this.enabled) return;

        span.events.push({ attributes, name, timeNs: nowNs() });
    }

    /** Increment a counter metric by `value` (defaults to 1). */
    recordCounter(name: string, value = 1, attributes: Attributes = {}, unit?: string): void {
        if (!this.enabled) return;

        this.counters.push({ attributes, name, unit, value });
    }

    /** Record a histogram observation (e.g. latency in ms). */
    recordHistogram(name: string, value: number, attributes: Attributes = {}, unit = "ms"): void {
        if (!this.enabled) return;

        this.histograms.push({ attributes, name, unit, value });
    }

    /**
     * Export what has accumulated since the last flush, then forget it. Returns a
     * promise; callers pass it to `executionCtx.waitUntil()` so the worker stays
     * alive long enough to complete the export.
     *
     * The buffers are taken synchronously, before the first await, so a second flush
     * sends only what was recorded after the first. That matters because a request
     * can flush twice: the middleware flushes when the handler returns, and a streamed
     * reply records its usage only once the body ends. Spans still open stay buffered
     * until they end, so no export carries a span without its end time.
     */
    async flush(): Promise<void> {
        if (!this.enabled || !this.config) return;

        const drained = [...this.spans];

        this.spans.length = 0;

        const ended = drained.filter((span) => span.endTimeNs !== undefined);

        // Open spans go back in: they belong to a later flush, once they end.
        this.spans.push(...drained.filter((span) => span.endTimeNs === undefined));

        const counters = [...this.counters];
        const histograms = [...this.histograms];

        this.counters.length = 0;
        this.histograms.length = 0;

        if (ended.length === 0 && counters.length === 0 && histograms.length === 0) {
            return;
        }

        await exportTelemetry({ counters, histograms, spans: ended }, this.config, nowNs());
    }
}

/**
 * Convenience helper — start a span, run `fn`, end the span with success/error,
 * and return `fn`'s value. Errors propagate so callers can handle them normally.
 */
export const withSpan = async <T>(
    telemetry: RequestTelemetry,
    name: string,
    options: { attributes?: Attributes; kind?: SpanKindValue; parent?: Span },
    function_: (span: Span) => Promise<T> | T,
): Promise<T> => {
    const span = telemetry.startSpan(name, options);

    try {
        const result = await function_(span);

        telemetry.endSpan(span);

        return result;
    } catch (error) {
        telemetry.endSpan(span, { error });

        throw error;
    }
};
