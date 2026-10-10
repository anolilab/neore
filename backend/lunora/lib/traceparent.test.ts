import { describe, expect, it } from "vitest";

import { generateSpanId, generateTraceId, generateTraceparent, parseTraceparent } from "./traceparent";

const TRACE_ID_RE = /^[\da-f]{32}$/;
const SPAN_ID_RE = /^[\da-f]{16}$/;
const TRACEPARENT_RE = /^00-[\da-f]{32}-[\da-f]{16}-(00|01)$/;

describe("generateTraceId", () => {
    it("returns 32 lowercase hex characters", () => {
        const traceId = generateTraceId();

        expect(traceId).toMatch(TRACE_ID_RE);
    });

    it("returns a different value on each call", () => {
        const a = generateTraceId();
        const b = generateTraceId();

        expect(a).not.toBe(b);
    });
});

describe("generateSpanId", () => {
    it("returns 16 lowercase hex characters", () => {
        const spanId = generateSpanId();

        expect(spanId).toMatch(SPAN_ID_RE);
    });
});

describe("generateTraceparent", () => {
    it("produces a W3C-formatted header value", () => {
        const traceparent = generateTraceparent();

        expect(traceparent).toMatch(TRACEPARENT_RE);
    });

    it("defaults to the sampled flag (01)", () => {
        const traceparent = generateTraceparent();

        expect(traceparent.endsWith("-01")).toBe(true);
    });

    it("inherits the trace ID when a parent is provided", () => {
        const parentTraceId = "0af7651916cd43dd8448eb211c80319c";
        const traceparent = generateTraceparent({ traceId: parentTraceId });

        const parsed = parseTraceparent(traceparent);

        expect(parsed?.traceId).toBe(parentTraceId);
    });

    it("generates a fresh span ID even when inheriting the trace ID", () => {
        const parentTraceId = "0af7651916cd43dd8448eb211c80319c";
        const a = parseTraceparent(generateTraceparent({ traceId: parentTraceId }));
        const b = parseTraceparent(generateTraceparent({ traceId: parentTraceId }));

        expect(a?.traceId).toBe(b?.traceId);
        expect(a?.spanId).not.toBe(b?.spanId);
    });

    it("respects an explicit not-sampled flag", () => {
        const traceparent = generateTraceparent({ flags: "00" });

        expect(traceparent.endsWith("-00")).toBe(true);
    });
});

describe("parseTraceparent", () => {
    it("returns null for null or undefined inputs", () => {
        expect(parseTraceparent(null)).toBeNull();
        expect(parseTraceparent(undefined)).toBeNull();
        expect(parseTraceparent("")).toBeNull();
    });

    it("parses a well-formed header", () => {
        const header = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
        const parsed = parseTraceparent(header);

        expect(parsed).toEqual({
            flags: "01",
            spanId: "b7ad6b7169203331",
            traceId: "0af7651916cd43dd8448eb211c80319c",
        });
    });

    it("rejects a non-v00 version", () => {
        const header = "01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

        expect(parseTraceparent(header)).toBeNull();
    });

    it("rejects a header with the wrong number of fields", () => {
        expect(parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331")).toBeNull();
        expect(parseTraceparent("00-0af7-7169-01-extra")).toBeNull();
    });

    it("rejects a header with a wrong-length trace ID", () => {
        // 31 hex chars instead of 32
        const header = "00-0af7651916cd43dd8448eb211c80319-b7ad6b7169203331-01";

        expect(parseTraceparent(header)).toBeNull();
    });

    it("rejects a header with a wrong-length span ID", () => {
        // 15 hex chars instead of 16
        const header = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b716920333-01";

        expect(parseTraceparent(header)).toBeNull();
    });

    it("rejects a header with non-hex characters", () => {
        const header = "00-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-b7ad6b7169203331-01";

        expect(parseTraceparent(header)).toBeNull();
    });

    it("normalises uppercase hex to lowercase", () => {
        const header = "00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01";
        const parsed = parseTraceparent(header);

        expect(parsed?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
        expect(parsed?.spanId).toBe("b7ad6b7169203331");
    });

    it("treats unknown flag bits as not-sampled (00)", () => {
        // Only "01" is currently defined as sampled. Anything else stays unsampled.
        const header = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-ff";
        const parsed = parseTraceparent(header);

        expect(parsed?.flags).toBe("00");
    });

    it("round-trips through generate", () => {
        const original = generateTraceparent();
        const parsed = parseTraceparent(original);

        expect(parsed).not.toBeNull();

        const rebuilt = `00-${parsed!.traceId}-${parsed!.spanId}-${parsed!.flags}`;

        expect(rebuilt).toBe(original);
    });
});
