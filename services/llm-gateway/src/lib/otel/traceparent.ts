/**
 * Parse a W3C `traceparent` header. Format:
 *   version-traceId-parentId-flags
 *   e.g. 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 *
 * Returns null for malformed values. Always lowercases hex on success.
 */
/** Lowercase/uppercase hex, anchored. No `g` flag, so `.test()` is stateless. */
const HEX_RE = /^[0-9a-f]+$/i;

export const parseTraceparent = (header: string | undefined | null): { parentSpanId: string; traceId: string } | null => {
    if (!header) return null;

    const parts = header.trim().split("-");

    if (parts.length !== 4) return null;

    const [version, traceId, parentSpanId] = parts;

    if (version !== "00") return null;

    if (!traceId || traceId.length !== 32) return null;

    if (!parentSpanId || parentSpanId.length !== 16) return null;

    if (!HEX_RE.test(traceId)) return null;

    if (!HEX_RE.test(parentSpanId)) return null;

    return { parentSpanId: parentSpanId.toLowerCase(), traceId: traceId.toLowerCase() };
};
