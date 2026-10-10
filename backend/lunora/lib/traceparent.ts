/**
 * W3C Trace Context (`traceparent`) generator + parser.
 *
 * Format (version `00`):  `00-{32-hex traceId}-{16-hex parentSpanId}-{2-hex flags}`
 *
 * Used by backend actions to forward trace IDs to the LLM Gateway so spans
 * from both sides land in the same distributed trace. The gateway's
 * telemetry middleware adopts the incoming `traceparent.traceId` when valid.
 *
 * Spec: https://www.w3.org/TR/trace-context/
 */

const HEX_RE = /^[0-9a-f]+$/i;
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

/** 16 random bytes → 32 hex chars. */
export const generateTraceId = (): string => randomHex(16);

/** 8 random bytes → 16 hex chars. */
export const generateSpanId = (): string => randomHex(8);

export interface TraceContext {
    /** `01` = sampled, `00` = not sampled. We default to sampled. */
    flags: "00" | "01";
    spanId: string;
    traceId: string;
}

/**
 * Build a new W3C `traceparent` header value. When `parent` is provided the
 * trace ID is inherited (so multiple gateway calls in the same action
 * land in one trace); otherwise a fresh trace is started.
 */
export const generateTraceparent = (parent?: { flags?: "00" | "01"; traceId?: string }): string => {
    const traceId = parent?.traceId ?? generateTraceId();
    const spanId = generateSpanId();
    const flags = parent?.flags ?? "01";

    return `00-${traceId}-${spanId}-${flags}`;
};

/**
 * Parse a `traceparent` header. Returns `null` for malformed inputs.
 */
export const parseTraceparent = (header: string | undefined | null): TraceContext | null => {
    if (!header) return null;

    const parts = header.trim().split("-");

    if (parts.length !== 4) return null;

    const [version, traceId, spanId, flags] = parts;

    if (version !== "00") return null;

    if (!traceId || traceId.length !== 32) return null;

    if (!spanId || spanId.length !== 16) return null;

    if (!flags || flags.length !== 2) return null;

    if (!HEX_RE.test(traceId)) return null;

    if (!HEX_RE.test(spanId)) return null;

    if (!HEX_RE.test(flags)) return null;

    return {
        flags: (flags === "01" ? "01" : "00") as "00" | "01",
        spanId: spanId.toLowerCase(),
        traceId: traceId.toLowerCase(),
    };
};
